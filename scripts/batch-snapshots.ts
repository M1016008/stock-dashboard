// scripts/batch-snapshots.ts
//
// Phase 2: ohlcv_daily から MA15本 + ステージ6種を計算して daily_snapshots に保存する夜間バッチ。
//
// 使い方:
//   npm run batch:snapshots                       # active な ticker_universe を全件処理
//   TICKERS=7203,6758 npm run batch:snapshots     # 環境変数で銘柄を絞ってテスト
//
// 動作:
//   - 各銘柄について daily_snapshots の最新日付を確認、それ以降の日付分のみ計算
//   - 日足の累積和と暦週・暦月の終値を使って各日の MA/ステージを線形時間で計算
//   - チャンク単位で UPSERT (onConflictDoNothing で冪等)
//   - 銘柄単位で失敗してもバッチは継続、失敗銘柄は batch_runs.error_summary に記録
//
// パフォーマンス注:
//   銘柄ごとに O(n) で計算し、書き込みはチャンク化する。

import { db, execAll, execGet, execRun } from '@/lib/db/client'
import { dailySnapshots, batchRuns, computeState } from '@/lib/db/schema'
import { buildSnapshotCalculations, MIN_SNAPSHOT_DATA_POINTS } from '@/lib/snapshots/continuous-ma'
import type { OHLCV } from '@/types/stock'
import { eq, sql } from 'drizzle-orm'

const CONCURRENCY = Math.max(1, Number(process.env.SNAPSHOT_CONCURRENCY ?? 4))
const PROGRESS_EVERY = Number(process.env.SNAPSHOT_PROGRESS_EVERY ?? 200)
const LOOKBACK_DAYS = Number(process.env.SNAPSHOT_LOOKBACK_DAYS ?? 900)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function withDbRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      return await fn()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (attempt === 5 || !/busy|locked|SQLITE_BUSY/i.test(msg)) throw err
      await sleep(250 * attempt)
    }
  }
  throw new Error('unreachable')
}

function dateDaysBefore(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - days)
  return d.toISOString().slice(0, 10)
}

type SnapshotComputeResult = {
  count: number
  dates: string[]
}

async function refreshSnapshotDateCache(dates: Iterable<string>): Promise<void> {
  const uniqueDates = Array.from(new Set(dates)).sort()
  if (uniqueDates.length === 0) return

  await execRun(`
    CREATE TABLE IF NOT EXISTS serving_daily_snapshot_dates (
      date TEXT PRIMARY KEY,
      tickers INTEGER NOT NULL,
      computed_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `)

  const CHUNK = 200
  for (let i = 0; i < uniqueDates.length; i += CHUNK) {
    const chunk = uniqueDates.slice(i, i + CHUNK)
    const placeholders = chunk.map(() => '?').join(', ')
    await execRun(
      `
        INSERT OR REPLACE INTO serving_daily_snapshot_dates (date, tickers, computed_at)
        SELECT date, COUNT(*) AS tickers, unixepoch()
        FROM daily_snapshots
        WHERE date IN (${placeholders})
        GROUP BY date
      `,
      chunk,
    )
  }
}

async function markSnapshotState(ticker: string, lastProcessedDate: string): Promise<void> {
  await db
    .insert(computeState)
    .values({ jobType: 'snapshot_compute', ticker, lastProcessedDate })
    .onConflictDoUpdate({
      target: [computeState.jobType, computeState.ticker],
      set: {
        lastProcessedDate: sql`excluded.last_processed_date`,
        updatedAt: sql`unixepoch()`,
      },
    })
}

async function computeSnapshotsForTicker(ticker: string): Promise<SnapshotComputeResult> {
  const [state, existing] = await Promise.all([
    execGet<{ lastProcessedDate: string | null }>(
      `SELECT last_processed_date AS lastProcessedDate FROM compute_state WHERE job_type = 'snapshot_compute' AND ticker = ?`,
      [ticker],
    ),
    execGet<{ maxDate: string | null }>(
      `SELECT MAX(date) AS maxDate FROM daily_snapshots WHERE ticker = ?`,
      [ticker],
    ),
  ])
  const lastSnapshotDate = [state?.lastProcessedDate, existing?.maxDate]
    .filter((date): date is string => Boolean(date))
    .sort()
    .at(-1) ?? null
  const startDate = lastSnapshotDate ? dateDaysBefore(lastSnapshotDate, LOOKBACK_DAYS) : null

  const rows = await execAll<OHLCV>(
    `
      SELECT date, open, high, low, close, volume
      FROM ohlcv_daily
      WHERE ticker = ?
        ${startDate ? 'AND date >= ?' : ''}
      ORDER BY date
    `,
    startDate ? [ticker, startDate] : [ticker],
  )

  if (rows.length < MIN_SNAPSHOT_DATA_POINTS) {
    const latestOhlcvDate = rows[rows.length - 1]?.date
    if (latestOhlcvDate) await markSnapshotState(ticker, latestOhlcvDate)
    return { count: 0, dates: [] }
  }

  // 各日に対してスナップショットを計算
  type SnapshotRow = typeof dailySnapshots.$inferInsert
  const newSnapshots: SnapshotRow[] = []
  for (const calculation of buildSnapshotCalculations(rows)) {
    const { date, activeDays: _activeDays, segmentStartDate: _segmentStartDate, ...snapshotValues } = calculation
    if (lastSnapshotDate && date <= lastSnapshotDate) continue

    newSnapshots.push({
      ticker,
      date,
      ...snapshotValues,
    })
  }

  if (newSnapshots.length === 0) {
    const latestOhlcvDate = rows[rows.length - 1]?.date
    if (latestOhlcvDate && (!lastSnapshotDate || latestOhlcvDate > lastSnapshotDate)) {
      await markSnapshotState(ticker, latestOhlcvDate)
    }
    return { count: 0, dates: [] }
  }

  // チャンク分割で INSERT (libSQL の SQL長制限対策)
  const CHUNK = 200
  for (let i = 0; i < newSnapshots.length; i += CHUNK) {
    await withDbRetry(() =>
      db
        .insert(dailySnapshots)
        .values(newSnapshots.slice(i, i + CHUNK))
        .onConflictDoNothing(),  // 既存日付は触らない (冪等)
    )
  }

  const latestDate = newSnapshots[newSnapshots.length - 1]?.date
  if (latestDate) {
    await markSnapshotState(ticker, latestDate)
  }

  return {
    count: newSnapshots.length,
    dates: newSnapshots.map((snapshot) => snapshot.date),
  }
}

async function main() {
  const [run] = await db
    .insert(batchRuns)
    .values({
      jobType: 'snapshot_compute',
      startedAt: new Date(),
      status: 'running',
    })
    .returning({ id: batchRuns.id })

  const runId = run.id

  // 対象銘柄。通常実行では OHLCV が snapshot より新しい銘柄だけに絞る。
  const tickerFilter = process.env.TICKERS?.split(',').map(s => s.trim()).filter(Boolean)
  let tickers: { ticker: string }[]
  if (tickerFilter && tickerFilter.length > 0) {
    tickers = tickerFilter.map(ticker => ({ ticker }))
    console.log(`TICKERS env で絞り込み: ${tickers.length} 銘柄`)
  } else {
    tickers = await execAll<{ ticker: string }>(`
      SELECT u.ticker
      FROM ticker_universe u
      WHERE u.active = 1
        AND (
          SELECT MAX(o.date)
          FROM ohlcv_daily o
          WHERE o.ticker = u.ticker
        ) > COALESCE((
          SELECT MAX(s.date)
          FROM daily_snapshots s
          WHERE s.ticker = u.ticker
        ), '')
      ORDER BY u.ticker
    `)
  }

  let succeeded = 0
  let failed = 0
  let rowsInserted = 0
  const errors: string[] = []
  const touchedSnapshotDates = new Set<string>()

  console.log(`Snapshot 計算開始: ${tickers.length} 銘柄 (CONCURRENCY=${CONCURRENCY})`)
  const startTime = Date.now()
  let nextIndex = 0
  let processed = 0

  async function worker(workerId: number) {
    while (true) {
      const i = nextIndex++
      const item = tickers[i]
      if (!item) return
      const { ticker } = item
      try {
        const result = await computeSnapshotsForTicker(ticker)
        succeeded++
        rowsInserted += result.count
        for (const date of result.dates) touchedSnapshotDates.add(date)
      } catch (err) {
        failed++
        const msg = `${ticker}: ${err instanceof Error ? err.message : String(err)}`
        errors.push(msg)
        console.error(`✗ worker=${workerId} ${msg}`)
      } finally {
        processed++
        if (processed % PROGRESS_EVERY === 0 || processed === tickers.length) {
          const pct = ((processed / tickers.length) * 100).toFixed(1)
          const elapsedMin = ((Date.now() - startTime) / 60000).toFixed(1)
          console.log(`[${processed}/${tickers.length} ${pct}%] 累計 ${rowsInserted} snapshots / 成功 ${succeeded} / 失敗 ${failed} / 経過 ${elapsedMin}min`)
        }
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, tickers.length) }, (_, i) => worker(i + 1)),
  )

  await refreshSnapshotDateCache(touchedSnapshotDates)

  const finalStatus =
    failed === 0 ? 'success' :
    succeeded === 0 ? 'failed' :
    'partial'

  await db
    .update(batchRuns)
    .set({
      finishedAt: new Date(),
      status: finalStatus,
      totalTickers: tickers.length,
      succeeded,
      failed,
      rowsInserted,
      errorSummary: JSON.stringify(errors.slice(0, 10)),
    })
    .where(eq(batchRuns.id, runId))

  console.log(`完了: ${succeeded} 成功 / ${failed} 失敗 / 計 ${rowsInserted} スナップショット / ステータス: ${finalStatus}`)
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
