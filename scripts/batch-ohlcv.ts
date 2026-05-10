// scripts/batch-ohlcv.ts
//
// Phase 2: Yahoo Finance から日足 OHLCV を取得して Turso (ohlcv_daily) に蓄積する夜間バッチ。
//
// 使い方:
//   npm run batch:ohlcv                       # active な ticker_universe を全件処理
//   TICKERS=7203,6758 npm run batch:ohlcv     # 環境変数で銘柄を絞ってテスト
//
// 動作:
//   - 各銘柄について ohlcv_daily の最新日付を確認、それ以降の差分のみ取得
//   - 初回 (履歴ゼロ) は HISTORY_YEARS_FALLBACK 年遡って取得
//   - 1リクエスト RATE_LIMIT_MS で間隔を空けて Yahoo Finance に礼儀
//   - エラー発生時は MAX_RETRIES 回まで指数バックオフでリトライ
//   - 銘柄単位で失敗してもバッチは継続、失敗銘柄は batch_runs.error_summary に記録

import { db } from '@/lib/db/client'
import { tickerUniverse, ohlcvDaily, batchRuns } from '@/lib/db/schema'
import { fetchHistoricalOhlcv } from '@/lib/yahoo-finance'
import { eq, max, sql } from 'drizzle-orm'
import { subYears } from 'date-fns'

const RATE_LIMIT_MS = 500
const MAX_RETRIES = 3
const HISTORY_YEARS_FALLBACK = 2
const PROGRESS_EVERY = 50

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function fetchAndStoreForTicker(ticker: string): Promise<number> {
  // 既存最新日付を確認 (差分取得のため)
  const existing = await db
    .select({ maxDate: max(ohlcvDaily.date) })
    .from(ohlcvDaily)
    .where(eq(ohlcvDaily.ticker, ticker))

  const lastDate = existing[0]?.maxDate
  const period1 = lastDate
    ? new Date(lastDate)
    : subYears(new Date(), HISTORY_YEARS_FALLBACK)

  // フェッチ (リトライ付き、指数バックオフ)
  let data: Awaited<ReturnType<typeof fetchHistoricalOhlcv>> = []
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      data = await fetchHistoricalOhlcv(ticker, period1)
      break
    } catch (err) {
      if (attempt === MAX_RETRIES) throw err
      await sleep(1000 * attempt)
    }
  }

  if (data.length === 0) return 0

  // チャンク分割で UPSERT (libSQL の SQL 長制限対策)
  const CHUNK = 200
  for (let i = 0; i < data.length; i += CHUNK) {
    const chunk = data.slice(i, i + CHUNK).map(d => ({ ticker, ...d }))
    await db
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
      })
  }

  return data.length
}

async function main() {
  // 開始記録
  const [run] = await db
    .insert(batchRuns)
    .values({
      jobType: 'ohlcv_fetch',
      startedAt: new Date(),
      status: 'running',
    })
    .returning({ id: batchRuns.id })

  const runId = run.id

  // 対象銘柄
  const tickerFilter = process.env.TICKERS?.split(',').map(s => s.trim()).filter(Boolean)
  let tickers: { ticker: string }[]
  if (tickerFilter && tickerFilter.length > 0) {
    tickers = tickerFilter.map(ticker => ({ ticker }))
    console.log(`TICKERS env で絞り込み: ${tickers.length} 銘柄`)
  } else {
    tickers = await db
      .select({ ticker: tickerUniverse.ticker })
      .from(tickerUniverse)
      .where(eq(tickerUniverse.active, true))
  }

  let succeeded = 0
  let failed = 0
  let rowsInserted = 0
  const errors: string[] = []

  console.log(`OHLCV fetch 開始: ${tickers.length} 銘柄`)
  const startTime = Date.now()

  for (const [i, { ticker }] of tickers.entries()) {
    try {
      const count = await fetchAndStoreForTicker(ticker)
      succeeded++
      rowsInserted += count
      if ((i + 1) % PROGRESS_EVERY === 0 || i === tickers.length - 1) {
        const pct = (((i + 1) / tickers.length) * 100).toFixed(1)
        const elapsedMin = ((Date.now() - startTime) / 60000).toFixed(1)
        console.log(`[${i + 1}/${tickers.length} ${pct}%] ${ticker}: +${count} rows (累計 ${rowsInserted}, 失敗 ${failed}, 経過 ${elapsedMin}min)`)
      }
    } catch (err) {
      failed++
      const msg = `${ticker}: ${err instanceof Error ? err.message : String(err)}`
      errors.push(msg)
      console.error(`✗ ${msg}`)
    }
    await sleep(RATE_LIMIT_MS)
  }

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
