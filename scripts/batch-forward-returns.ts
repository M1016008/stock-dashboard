// scripts/batch-forward-returns.ts
//
// Phase 3: 各 (ticker, date) について指定営業日後の % 変化を計算して forward_returns に保存。
//
// 使い方:
//   USE_LOCAL_DB=1 npx tsx --env-file=.env.local scripts/batch-forward-returns.ts
//   FORWARD_RETURN_HORIZONS=2,3,4,5,10,15 USE_LOCAL_DB=1 npx tsx --env-file=.env.local scripts/batch-forward-returns.ts
//   TICKERS=7203 USE_LOCAL_DB=1 npx tsx --env-file=.env.local scripts/batch-forward-returns.ts

import { db, client } from '@/lib/db/client'
import { tickerUniverse, batchRuns } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'

const DEFAULT_HORIZONS = [2, 3, 4, 5, 10, 15, 30, 60, 90, 180, 200]

function parseHorizons(value: string | undefined, fallback: number[]): number[] {
  const source = value?.trim() ? value : fallback.join(',')
  const horizons = [...new Set(
    source
      .split(',')
      .map((part) => Number(part.trim()))
      .filter((n) => Number.isInteger(n) && n > 0),
  )].sort((a, b) => a - b)
  if (horizons.length === 0) {
    throw new Error('FORWARD_RETURN_HORIZONS に有効な営業日数がありません')
  }
  return horizons
}

const HORIZONS = parseHorizons(process.env.FORWARD_RETURN_HORIZONS, DEFAULT_HORIZONS)

function parsePositiveInt(value: string | undefined): number | null {
  if (!value?.trim()) return null
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

const TICKER_CHUNK_SIZE = parsePositiveInt(process.env.FORWARD_RETURNS_TICKER_CHUNK_SIZE)

function chunkTickers(tickers: string[], chunkSize: number): string[][] {
  const chunks: string[][] = []
  for (let start = 0; start < tickers.length; start += chunkSize) {
    chunks.push(tickers.slice(start, start + chunkSize))
  }
  return chunks
}

async function computeForwardReturnsForHorizon(horizon: number, tickers: string[] | null): Promise<number> {
  const tickerWhere = tickers?.length
    ? `WHERE ticker IN (${tickers.map(() => '?').join(', ')})`
    : ''
  const args: Array<string | number> = [horizon, horizon, horizon, horizon, ...(tickers ?? [])]

  const result = await client.execute({
    sql: `
      INSERT OR IGNORE INTO forward_returns
        (ticker, date, horizon_days, return_pct, return_category, end_date)
      SELECT
        ticker,
        date,
        ? AS horizon_days,
        return_pct,
        CASE
          WHEN return_pct > 10 THEN 'very_up'
          WHEN return_pct > 5 THEN 'up'
          WHEN return_pct >= -5 THEN 'flat'
          WHEN return_pct >= -10 THEN 'down'
          ELSE 'very_down'
        END AS return_category,
        future_date AS end_date
      FROM (
        SELECT
          ticker,
          date,
          close,
          LEAD(date, ?) OVER (PARTITION BY ticker ORDER BY date) AS future_date,
          LEAD(close, ?) OVER (PARTITION BY ticker ORDER BY date) AS future_close,
          100.0 * (LEAD(close, ?) OVER (PARTITION BY ticker ORDER BY date) - close) / close AS return_pct
        FROM ohlcv_daily
        ${tickerWhere}
      )
      WHERE close > 0
        AND future_close > 0
        AND future_date IS NOT NULL
        AND return_pct IS NOT NULL
    `,
    args,
  })

  return Number(result.rowsAffected ?? 0)
}

async function main() {
  const [run] = await db
    .insert(batchRuns)
    .values({ jobType: 'forward_returns', startedAt: new Date(), status: 'running' })
    .returning({ id: batchRuns.id })
  const runId = run.id

  const filter = process.env.TICKERS?.split(',').map(s => s.trim()).filter(Boolean)
  const tickers: { ticker: string }[] = filter && filter.length > 0
    ? filter.map(ticker => ({ ticker }))
    : await db
        .select({ ticker: tickerUniverse.ticker })
        .from(tickerUniverse)
        .where(eq(tickerUniverse.active, true))
  const tickerFilter = filter && filter.length > 0 ? filter : null

  let succeeded = 0
  let failed = 0
  let rowsInserted = 0
  const errors: string[] = []

  const tickerUniverseList = tickers.map((row) => row.ticker)
  const chunkedTickerLists = TICKER_CHUNK_SIZE
    ? chunkTickers(tickerFilter ?? tickerUniverseList, TICKER_CHUNK_SIZE)
    : null

  console.log(
    `Forward returns 計算開始: ${tickers.length} 銘柄 / horizons=${HORIZONS.join(',')}` +
    (chunkedTickerLists ? ` / tickerChunk=${TICKER_CHUNK_SIZE}` : ''),
  )
  const startTime = Date.now()

  for (const [i, horizon] of HORIZONS.entries()) {
    try {
      let count = 0
      if (chunkedTickerLists) {
        for (const [chunkIndex, chunk] of chunkedTickerLists.entries()) {
          const chunkCount = await computeForwardReturnsForHorizon(horizon, chunk)
          count += chunkCount
          const elapsedMin = ((Date.now() - startTime) / 60000).toFixed(1)
          console.log(
            `  - ${horizon}営業日 chunk ${chunkIndex + 1}/${chunkedTickerLists.length}: ` +
            `+${chunkCount.toLocaleString()} (horizon累計 ${count.toLocaleString()}, 経過 ${elapsedMin}min)`,
          )
        }
      } else {
        count = await computeForwardReturnsForHorizon(horizon, tickerFilter)
      }
      succeeded++
      rowsInserted += count
      const pct = (((i + 1) / HORIZONS.length) * 100).toFixed(1)
      const elapsedMin = ((Date.now() - startTime) / 60000).toFixed(1)
      console.log(`[${i + 1}/${HORIZONS.length} ${pct}%] ${horizon}営業日: +${count.toLocaleString()} (累計 ${rowsInserted.toLocaleString()}, 失敗 ${failed}, 経過 ${elapsedMin}min)`)
    } catch (err) {
      failed++
      const msg = `${horizon}営業日: ${err instanceof Error ? err.message : String(err)}`
      errors.push(msg)
      console.error(`✗ ${msg}`)
    }
  }

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

  console.log(`完了: ${succeeded} 成功 / ${failed} 失敗 / 計 ${rowsInserted} 行 / ${finalStatus}`)
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
