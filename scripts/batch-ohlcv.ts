// scripts/batch-ohlcv.ts
//
// 日足 OHLCV を J-Quants API から取得して ohlcv_daily に蓄積するバッチ。
// (Phase 3.5 で Yahoo 分岐を削除、J-Quants 一本化)
//
// 使い方:
//   USE_LOCAL_DB=1 npm run batch:ohlcv                                  # 全銘柄、差分取得
//   TICKERS=7203,6758 USE_LOCAL_DB=1 npm run batch:ohlcv                # 銘柄絞り込み
//   HISTORY_FROM=2016-05-13 USE_LOCAL_DB=1 npm run batch:ohlcv          # 初回フルフェッチ用
//
// 環境変数:
//   USE_LOCAL_DB        '1' でローカル SQLite を強制 (Turso クォータ回避)
//   TICKERS             カンマ区切りで銘柄を絞り込み (テスト用)
//   HISTORY_FROM        ISO 日付 (YYYY-MM-DD) で取得開始日を上書き (初回フェッチ時のみ意味あり)
//
// 動作:
//   - 各銘柄について ohlcv_daily の最新日付を確認、それ以降の差分のみ取得 (冪等)
//   - エラー発生時は MAX_RETRIES 回まで指数バックオフ
//   - 失敗銘柄は batch_runs.error_summary に記録、バッチは続行

import { db, execAll } from '@/lib/db/client'
import { ohlcvDaily, batchRuns, jquantsDailyCoverage } from '@/lib/db/schema'
import { fetchJQuantsDaily, fetchJQuantsDailyByDate, type JQuantsDailyByDateRow } from '@/lib/jquants'
import { expectedLatestTradingDate } from '@/lib/server/data-freshness'
import type { OHLCV } from '@/types/stock'
import { eq, sql } from 'drizzle-orm'

const RATE_LIMIT_MS = Number(process.env.OHLCV_RATE_LIMIT_MS ?? 0)
const CONCURRENCY = Math.max(1, Number(process.env.OHLCV_CONCURRENCY ?? 8))
const MAX_RETRIES = Number(process.env.OHLCV_MAX_RETRIES ?? 4)
const PROGRESS_EVERY = Number(process.env.OHLCV_PROGRESS_EVERY ?? 100)

// 取得開始日: HISTORY_FROM があればそれ、なければ Standard プラン上限 (今日から 10 年前) を試行
const DEFAULT_FROM_DATE: string =
  process.env.HISTORY_FROM
  ?? new Date(Date.now() - 10 * 365 * 86_400_000).toISOString().slice(0, 10)
const TARGET_DATE = process.env.OHLCV_TARGET_DATE ?? expectedLatestTradingDate()
const USE_DATE_BULK = process.env.OHLCV_USE_DATE_BULK !== '0'

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

async function fetchAndStoreForTicker(ticker: string, lastDate: string | null): Promise<number> {
  const fromDate = lastDate ?? DEFAULT_FROM_DATE

  // フェッチ (リトライ付き、指数バックオフ)
  let data: OHLCV[] = []
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      data = await fetchJQuantsDaily(ticker, fromDate)
      break
    } catch (err) {
      if (attempt === MAX_RETRIES) throw err
      const msg = err instanceof Error ? err.message : String(err)
      const penalty = msg.includes('429') ? 5000 : 1000
      await sleep(penalty * attempt)
    }
  }

  if (data.length === 0) return 0

  // チャンク分割で UPSERT (libSQL の SQL 長制限対策)
  const CHUNK = 200
  for (let i = 0; i < data.length; i += CHUNK) {
    const chunk = data.slice(i, i + CHUNK).map(d => ({ ticker, ...d }))
    await withDbRetry(() =>
      db
        .insert(ohlcvDaily)
        .values(chunk)
        .onConflictDoUpdate({
          target: [ohlcvDaily.ticker, ohlcvDaily.date],
          set: {
            open:   sql`excluded.open`,
            high:   sql`excluded.high`,
            low:    sql`excluded.low`,
            close:  sql`excluded.close`,
            volume: sql`excluded.volume`,
          },
        }),
    )
  }

  return data.length
}

async function storeRows(rows: JQuantsDailyByDateRow[]): Promise<number> {
  const CHUNK = 200
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK)
    await withDbRetry(() =>
      db
        .insert(ohlcvDaily)
        .values(chunk)
        .onConflictDoUpdate({
          target: [ohlcvDaily.ticker, ohlcvDaily.date],
          set: {
            open:   sql`excluded.open`,
            high:   sql`excluded.high`,
            low:    sql`excluded.low`,
            close:  sql`excluded.close`,
            volume: sql`excluded.volume`,
          },
        }),
    )
  }
  return rows.length
}

async function main() {
  console.log(`SOURCE=jquants, HISTORY_FROM=${DEFAULT_FROM_DATE}, TARGET_DATE=${TARGET_DATE}, CONCURRENCY=${CONCURRENCY}, RATE_LIMIT=${RATE_LIMIT_MS}ms`)

  // 開始記録
  const [run] = await db
    .insert(batchRuns)
    .values({
      jobType: 'ohlcv_fetch:jquants',
      startedAt: new Date(),
      status: 'running',
    })
    .returning({ id: batchRuns.id })

  const runId = run.id

  // 対象銘柄
  const tickerFilter = process.env.TICKERS?.split(',').map(s => s.trim()).filter(Boolean)
  let tickers: { ticker: string; lastDate: string | null }[]
  if (tickerFilter && tickerFilter.length > 0) {
    const placeholders = tickerFilter.map(() => '?').join(',')
    const latestRows = await execAll<{ ticker: string; lastDate: string | null }>(
      `SELECT ticker, MAX(date) AS lastDate FROM ohlcv_daily WHERE ticker IN (${placeholders}) GROUP BY ticker`,
      tickerFilter,
    )
    const latestByTicker = new Map(latestRows.map(r => [r.ticker, r.lastDate]))
    tickers = tickerFilter.map(ticker => ({ ticker, lastDate: latestByTicker.get(ticker) ?? null }))
    console.log(`TICKERS env で絞り込み: ${tickers.length} 銘柄`)
  } else {
    tickers = await execAll<{ ticker: string; lastDate: string | null }>(`
      SELECT u.ticker, MAX(o.date) AS lastDate
      FROM ticker_universe u
      LEFT JOIN ohlcv_daily o ON o.ticker = u.ticker
      WHERE u.active = 1
      GROUP BY u.ticker
      HAVING COALESCE(MAX(o.date), '') < ?
      ORDER BY u.ticker
    `, [TARGET_DATE])
  }

  let succeeded = 0
  let failed = 0
  let rowsInserted = 0
  const errors: string[] = []

  console.log(`OHLCV fetch 開始: ${tickers.length} 銘柄`)
  const startTime = Date.now()

  if (USE_DATE_BULK && !tickerFilter && TARGET_DATE) {
    try {
      console.log(`J-Quants date bulk fetch: ${TARGET_DATE}`)
      const rows = await fetchJQuantsDailyByDate(TARGET_DATE)
      const inserted = await storeRows(rows)
      rowsInserted += inserted
      await db
        .insert(jquantsDailyCoverage)
        .values({ date: TARGET_DATE, expectedRows: rows.length })
        .onConflictDoUpdate({
          target: jquantsDailyCoverage.date,
          set: {
            expectedRows: sql`excluded.expected_rows`,
            importedAt: sql`unixepoch()`,
          },
        })
      console.log(`J-Quants date bulk 完了: expected=${rows.length}, stored=${inserted}`)
      tickers = tickers.filter(t => !rows.some(r => r.ticker === t.ticker))
    } catch (err) {
      console.warn(`J-Quants date bulk をスキップ: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  let nextIndex = 0
  let processed = 0

  async function worker(workerId: number) {
    while (true) {
      const i = nextIndex++
      const item = tickers[i]
      if (!item) return
      const { ticker, lastDate } = item
      try {
        const count = await fetchAndStoreForTicker(ticker, lastDate)
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
          console.log(`[${processed}/${tickers.length} ${pct}%] 累計 ${rowsInserted} rows / 成功 ${succeeded} / 失敗 ${failed} / 経過 ${elapsedMin}min`)
        }
        if (RATE_LIMIT_MS > 0) await sleep(RATE_LIMIT_MS)
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, tickers.length) }, (_, i) => worker(i + 1)),
  )

  // 終了記録
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

  console.log(`完了: ${succeeded} 成功 / ${failed} 失敗 / 計 ${rowsInserted} 行 / ステータス: ${finalStatus}`)
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
