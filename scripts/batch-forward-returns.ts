// scripts/batch-forward-returns.ts
//
// Phase 3: 各 (ticker, date) について 30/60/90/180 営業日後の % 変化を計算して forward_returns に保存。
//
// 使い方:
//   USE_LOCAL_DB=1 npx tsx --env-file=.env.local scripts/batch-forward-returns.ts
//   TICKERS=7203 USE_LOCAL_DB=1 npx tsx --env-file=.env.local scripts/batch-forward-returns.ts

import { db } from '@/lib/db/client'
import { ohlcvDaily, forwardReturns, tickerUniverse, batchRuns } from '@/lib/db/schema'
import { categorizeReturn } from '@/lib/features'
import { eq, asc } from 'drizzle-orm'

const HORIZONS = [30, 60, 90, 180] as const
const PROGRESS_EVERY = 100

async function computeForwardReturnsForTicker(ticker: string): Promise<number> {
  const ohlcv = await db
    .select({ date: ohlcvDaily.date, close: ohlcvDaily.close })
    .from(ohlcvDaily)
    .where(eq(ohlcvDaily.ticker, ticker))
    .orderBy(asc(ohlcvDaily.date))

  if (ohlcv.length < Math.min(...HORIZONS) + 1) return 0

  const records: Array<{
    ticker: string
    date: string
    horizon_days: number
    return_pct: number
    return_category: string
    end_date: string
  }> = []

  for (let i = 0; i < ohlcv.length; i++) {
    const currentClose = ohlcv[i].close
    if (currentClose === 0 || currentClose == null) continue

    for (const h of HORIZONS) {
      const futureIdx = i + h
      if (futureIdx >= ohlcv.length) continue  // 未来データなし、スキップ

      const futureClose = ohlcv[futureIdx].close
      if (futureClose === 0 || futureClose == null) continue

      const returnPct = ((futureClose - currentClose) / currentClose) * 100
      const category = categorizeReturn(returnPct)

      records.push({
        ticker,
        date: ohlcv[i].date,
        horizon_days: h,
        return_pct: returnPct,
        return_category: category,
        end_date: ohlcv[futureIdx].date,
      })
    }
  }

  if (records.length === 0) return 0

  // チャンク INSERT (forward_returns は列数が少ないので chunk 大きめ)
  const CHUNK = 500
  for (let i = 0; i < records.length; i += CHUNK) {
    await db
      .insert(forwardReturns)
      .values(records.slice(i, i + CHUNK))
      .onConflictDoNothing()
  }

  return records.length
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

  let succeeded = 0
  let failed = 0
  let rowsInserted = 0
  const errors: string[] = []

  console.log(`Forward returns 計算開始: ${tickers.length} 銘柄`)
  const startTime = Date.now()

  for (const [i, { ticker }] of tickers.entries()) {
    try {
      const count = await computeForwardReturnsForTicker(ticker)
      succeeded++
      rowsInserted += count
      if ((i + 1) % PROGRESS_EVERY === 0 || i === tickers.length - 1) {
        const pct = (((i + 1) / tickers.length) * 100).toFixed(1)
        const elapsedMin = ((Date.now() - startTime) / 60000).toFixed(1)
        console.log(`[${i + 1}/${tickers.length} ${pct}%] ${ticker}: +${count} (累計 ${rowsInserted}, 失敗 ${failed}, 経過 ${elapsedMin}min)`)
      }
    } catch (err) {
      failed++
      const msg = `${ticker}: ${err instanceof Error ? err.message : String(err)}`
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
