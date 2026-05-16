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

import { db } from '@/lib/db/client'
import { tickerUniverse, ohlcvDaily, batchRuns } from '@/lib/db/schema'
import { fetchJQuantsDaily } from '@/lib/jquants'
import type { OHLCV } from '@/types/stock'
import { eq, max, sql } from 'drizzle-orm'

const RATE_LIMIT_MS = 100
const MAX_RETRIES = 3
const PROGRESS_EVERY = 25

// 取得開始日: HISTORY_FROM があればそれ、なければ Standard プラン上限 (今日から 10 年前) を試行
const DEFAULT_FROM_DATE: string =
  process.env.HISTORY_FROM
  ?? new Date(Date.now() - 10 * 365 * 86_400_000).toISOString().slice(0, 10)

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function fetchAndStoreForTicker(ticker: string): Promise<number> {
  // 既存最新日付を確認 (差分取得のため)
  const existing = await db
    .select({ maxDate: max(ohlcvDaily.date) })
    .from(ohlcvDaily)
    .where(eq(ohlcvDaily.ticker, ticker))

  const lastDate = existing[0]?.maxDate
  const fromDate = lastDate ?? DEFAULT_FROM_DATE

  // フェッチ (リトライ付き、指数バックオフ)
  let data: OHLCV[] = []
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      data = await fetchJQuantsDaily(ticker, fromDate)
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
  console.log(`SOURCE=jquants, HISTORY_FROM=${DEFAULT_FROM_DATE}, RATE_LIMIT=${RATE_LIMIT_MS}ms`)

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
