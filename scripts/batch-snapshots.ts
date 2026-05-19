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
//   - 各日について OHLCV を slice (その日まで) → buildMaValuesFromOhlcv → calculateAllStages
//   - チャンク単位で UPSERT (onConflictDoNothing で冪等)
//   - 銘柄単位で失敗してもバッチは継続、失敗銘柄は batch_runs.error_summary に記録
//
// パフォーマンス注:
//   各日で OHLCV を slice して再計算するため銘柄あたり O(n²)。
//   2年分 = 約 500 日 × 4000 銘柄 = 200万計算。約 5〜10 分目安。
//   将来データ量が増えたら累積計算に最適化する余地あり。

import { db, execAll } from '@/lib/db/client'
import { ohlcvDaily, dailySnapshots, batchRuns } from '@/lib/db/schema'
import { calculateAllStages, type MaValues } from '@/lib/hex-stage'
import type { OHLCV } from '@/types/stock'
import { eq, asc, max } from 'drizzle-orm'

const MIN_DATA_POINTS = 5  // これ以下では何も計算できない (ma_5 すら出ない)
const CONCURRENCY = Math.max(1, Number(process.env.SNAPSHOT_CONCURRENCY ?? 4))
const PROGRESS_EVERY = Number(process.env.SNAPSHOT_PROGRESS_EVERY ?? 200)
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

function buildClosePrefix(rows: OHLCV[]): number[] {
  const prefix = [0]
  for (const row of rows) {
    prefix.push(prefix[prefix.length - 1] + row.close)
  }
  return prefix
}

function dailySmaAt(prefix: number[], index: number, period: number): number | null {
  const end = index + 1
  if (end < period) return null
  return (prefix[end] - prefix[end - period]) / period
}

function groupedSmaAt(rows: OHLCV[], index: number, groupSize: number, period: number): number | null {
  const groupCount = Math.floor(index / groupSize) + 1
  if (groupCount < period) return null

  let sum = 0
  const firstGroup = groupCount - period
  for (let g = firstGroup; g < groupCount; g++) {
    const groupEnd = Math.min((g + 1) * groupSize - 1, index)
    sum += rows[groupEnd].close
  }
  return sum / period
}

function buildMaValuesAtIndex(rows: OHLCV[], prefix: number[], index: number): MaValues {
  return {
    ma_5: dailySmaAt(prefix, index, 5),
    ma_25: dailySmaAt(prefix, index, 25),
    ma_75: dailySmaAt(prefix, index, 75),
    ma_150: dailySmaAt(prefix, index, 150),
    ma_300: dailySmaAt(prefix, index, 300),
    weekly_ma_5: groupedSmaAt(rows, index, 5, 5),
    weekly_ma_13: groupedSmaAt(rows, index, 5, 13),
    weekly_ma_25: groupedSmaAt(rows, index, 5, 25),
    weekly_ma_50: groupedSmaAt(rows, index, 5, 50),
    weekly_ma_100: groupedSmaAt(rows, index, 5, 100),
    monthly_ma_3: groupedSmaAt(rows, index, 21, 3),
    monthly_ma_5: groupedSmaAt(rows, index, 21, 5),
    monthly_ma_10: groupedSmaAt(rows, index, 21, 10),
    monthly_ma_20: groupedSmaAt(rows, index, 21, 20),
    monthly_ma_25: groupedSmaAt(rows, index, 21, 25),
  }
}

async function computeSnapshotsForTicker(ticker: string): Promise<number> {
  // この銘柄の OHLCV を全件取得 (日付昇順)
  const rows = await db
    .select()
    .from(ohlcvDaily)
    .where(eq(ohlcvDaily.ticker, ticker))
    .orderBy(asc(ohlcvDaily.date))

  if (rows.length < MIN_DATA_POINTS) return 0

  const ohlcvData: OHLCV[] = rows.map(r => ({
    date:   r.date,
    open:   r.open,
    high:   r.high,
    low:    r.low,
    close:  r.close,
    volume: r.volume,
  }))

  // 既存スナップショット最新日付を確認 (差分計算)
  const existing = await db
    .select({ maxDate: max(dailySnapshots.date) })
    .from(dailySnapshots)
    .where(eq(dailySnapshots.ticker, ticker))

  const lastSnapshotDate = existing[0]?.maxDate ?? null
  const closePrefix = buildClosePrefix(ohlcvData)

  // 各日に対してスナップショットを計算
  type SnapshotRow = typeof dailySnapshots.$inferInsert
  const newSnapshots: SnapshotRow[] = []
  for (let i = 0; i < ohlcvData.length; i++) {
    const date = ohlcvData[i].date
    if (lastSnapshotDate && date <= lastSnapshotDate) continue
    if (i + 1 < MIN_DATA_POINTS) continue

    const ma = buildMaValuesAtIndex(ohlcvData, closePrefix, i)
    const stages = calculateAllStages(ma)

    newSnapshots.push({
      ticker,
      date,
      ...ma,
      ...stages,
    })
  }

  if (newSnapshots.length === 0) return 0

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

  return newSnapshots.length
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
        const count = await computeSnapshotsForTicker(ticker)
        succeeded++
        rowsInserted += count
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
