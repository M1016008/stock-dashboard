// scripts/batch-credit-short.ts
//
// Phase 4 B10: J-Quants /markets/weekly_margin_interest を全銘柄分取得 (週次)。
// 1 銘柄あたり 1 リクエスト程度なので 4,000 銘柄で ~7 min。
//
// 使い方:
//   USE_LOCAL_DB=1 npm run batch:credit-short
//
// 環境変数:
//   TICKERS=7203,9984    対象銘柄を限定
//   FROM_DATE=2026-01-01 from パラメータ

import { db, client } from '@/lib/db/client'
import { weeklyMarginInterest, tickerUniverse, batchRuns } from '@/lib/db/schema'
import { fetchJQuantsWeeklyMargin } from '@/lib/jquants'
import { eq } from 'drizzle-orm'

const RATE_LIMIT_MS = 100
const PROGRESS_EVERY = 100

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function main() {
  const [run] = await db
    .insert(batchRuns)
    .values({ jobType: 'credit_short', startedAt: new Date(), status: 'running' })
    .returning({ id: batchRuns.id })
  const runId = run.id

  const fromDate = process.env.FROM_DATE
  const filter = process.env.TICKERS?.split(',').map(s => s.trim()).filter(Boolean)

  let tickers: string[]
  if (filter && filter.length > 0) {
    tickers = filter
  } else {
    const rows = await db
      .select({ ticker: tickerUniverse.ticker })
      .from(tickerUniverse)
      .where(eq(tickerUniverse.active, true))
    tickers = rows.map(r => r.ticker)
  }

  let succeeded = 0
  let failed = 0
  let rowsInserted = 0
  const errors: string[] = []
  const startTime = Date.now()

  console.log(`Credit-short fetch 開始: ${tickers.length} 銘柄 (from=${fromDate ?? 'all'})`)

  for (const [i, ticker] of tickers.entries()) {
    try {
      const rows = await fetchJQuantsWeeklyMargin(ticker, fromDate)
      if (rows.length > 0) {
        // 前週分との差分は date 降順で 2 行があれば取れる
        const sorted = [...rows].sort((a, b) => b.Date.localeCompare(a.Date))
        const dedup = new Map<string, typeof sorted[number]>()
        for (const r of sorted) dedup.set(r.Date, r)
        const items = Array.from(dedup.values()).slice(0, 4)  // 直近 4 週分

        for (let j = 0; j < items.length; j++) {
          const cur = items[j]
          const prev = items[j + 1]
          const longCur = parseFloat(cur.LongMarginTradeVolume ?? '')
          const shortCur = parseFloat(cur.ShortMarginTradeVolume ?? '')
          const longPrev = prev ? parseFloat(prev.LongMarginTradeVolume ?? '') : NaN
          const shortPrev = prev ? parseFloat(prev.ShortMarginTradeVolume ?? '') : NaN
          await client.execute({
            sql: `INSERT INTO weekly_margin_interest (ticker, date, long_margin, short_margin, long_change, short_change, imported_at)
                  VALUES (?, ?, ?, ?, ?, ?, unixepoch())
                  ON CONFLICT(ticker, date) DO UPDATE SET
                    long_margin = excluded.long_margin,
                    short_margin = excluded.short_margin,
                    long_change = excluded.long_change,
                    short_change = excluded.short_change`,
            args: [
              ticker,
              cur.Date,
              Number.isFinite(longCur) ? longCur : null,
              Number.isFinite(shortCur) ? shortCur : null,
              Number.isFinite(longCur) && Number.isFinite(longPrev) ? longCur - longPrev : null,
              Number.isFinite(shortCur) && Number.isFinite(shortPrev) ? shortCur - shortPrev : null,
            ],
          })
          rowsInserted++
        }
      }
      succeeded++
      if ((i + 1) % PROGRESS_EVERY === 0 || i === tickers.length - 1) {
        const pct = (((i + 1) / tickers.length) * 100).toFixed(1)
        const elapsedMin = ((Date.now() - startTime) / 60000).toFixed(1)
        console.log(`[${i + 1}/${tickers.length} ${pct}%] ${ticker}: ${rows.length} rows (累計 ${rowsInserted}, 失敗 ${failed}, ${elapsedMin}min)`)
      }
    } catch (err) {
      failed++
      const msg = `${ticker}: ${err instanceof Error ? err.message : String(err)}`
      errors.push(msg)
      console.error(`✗ ${msg}`)
    }
    await sleep(RATE_LIMIT_MS)
  }

  const finalStatus = failed === 0 ? 'success' : succeeded === 0 ? 'failed' : 'partial'
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

  console.log(`完了: ${succeeded} 成功 / ${failed} 失敗 / ${rowsInserted} 行 / ${finalStatus}`)
}

main().catch(err => { console.error('Fatal:', err); process.exit(1) })
