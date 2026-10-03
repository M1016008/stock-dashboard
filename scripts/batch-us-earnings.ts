// FinnhubのUS決算カレンダーを取得し、US専用テーブルへ安全に同期する。

import { db, client, ensureReady, execAll } from '@/lib/db/client'
import { marketDataRuns } from '@/lib/db/schema'
import {
  fetchFinnhubEarningsCalendar,
  finnhubEarningsTimeBucket,
  FINNHUB_EARNINGS_SOURCE_URL,
  type FinnhubEarningsEvent,
} from '@/lib/finnhub'
import { eq } from 'drizzle-orm'

const MARKET = 'US'
const JOB_TYPE = 'finnhub_earnings'
const HISTORY_DAYS = Math.max(0, Number(process.env.FINNHUB_EARNINGS_HISTORY_DAYS ?? 45))
const FUTURE_DAYS = Math.max(30, Number(process.env.FINNHUB_EARNINGS_FUTURE_DAYS ?? 370))
const MIN_PROVIDER_ROWS = Math.max(1, Number(process.env.FINNHUB_EARNINGS_MIN_PROVIDER_ROWS ?? 50))
const WRITE_CHUNK = Math.max(50, Number(process.env.FINNHUB_EARNINGS_WRITE_CHUNK ?? 250))

type UniverseRow = {
  ticker: string
}

function dateInNewYork(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? ''
  return `${value('year')}-${value('month')}-${value('day')}`
}

function offsetDate(dateString: string, days: number): string {
  const date = new Date(`${dateString}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function conciseError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/token=[^&\s]+/gi, 'token=<redacted>')
    .slice(0, 500)
}

function providerSymbolCandidates(symbol: string): string[] {
  const normalized = symbol.trim().toUpperCase()
  return Array.from(new Set([
    normalized,
    normalized.replace(/[.-]/g, '_'),
  ]))
}

function resolveTicker(event: FinnhubEarningsEvent, universe: Set<string>): string | null {
  return providerSymbolCandidates(event.symbol).find((candidate) => universe.has(candidate)) ?? null
}

async function main() {
  await ensureReady()
  const today = dateInNewYork()
  const from = process.env.FINNHUB_EARNINGS_FROM?.trim() || offsetDate(today, -HISTORY_DAYS)
  const to = process.env.FINNHUB_EARNINGS_TO?.trim() || offsetDate(today, FUTURE_DAYS)

  const [run] = await db.insert(marketDataRuns).values({
    market: MARKET,
    jobType: JOB_TYPE,
    status: 'running',
    payloadJson: JSON.stringify({ from, to, source: 'finnhub' }),
  }).returning({ id: marketDataRuns.id })

  try {
    const universeRows = await execAll<UniverseRow>(
      `
        SELECT ticker
        FROM market_universe
        WHERE market = 'US'
          AND active = 1
          AND COALESCE(asset_type, 'Stock') NOT IN ('ETF', 'Mutual Fund')
      `,
    )
    const universe = new Set(universeRows.map((row) => row.ticker.trim().toUpperCase()))
    if (universe.size === 0) throw new Error('US active stock universe is empty')

    console.log(`Finnhub earnings fetch: ${from}..${to}`)
    const providerRows = await fetchFinnhubEarningsCalendar(from, to)
    if (
      providerRows.length < MIN_PROVIDER_ROWS
      && process.env.FINNHUB_EARNINGS_ALLOW_SMALL_REFRESH !== '1'
    ) {
      throw new Error(
        `Finnhub earnings response is unexpectedly small: ${providerRows.length} rows `
        + `(minimum ${MIN_PROVIDER_ROWS}). Existing future rows were preserved.`,
      )
    }

    const matched = providerRows.flatMap((event) => {
      const ticker = resolveTicker(event, universe)
      return ticker ? [{ ticker, event }] : []
    })
    if (matched.length === 0) {
      throw new Error('Finnhub earnings response did not match any active US stock')
    }

    const importedAt = Math.floor(Date.now() / 1000)
    const transaction = await client.transaction('write')
    try {
      await transaction.execute({
        sql: `
          DELETE FROM market_earnings_calendar
          WHERE market = 'US'
            AND source = 'finnhub'
            AND report_date >= ?
        `,
        args: [today],
      })
      for (let offset = 0; offset < matched.length; offset += WRITE_CHUNK) {
        const chunk = matched.slice(offset, offset + WRITE_CHUNK)
        await transaction.batch(chunk.map(({ ticker, event }) => ({
          sql: `
            INSERT INTO market_earnings_calendar (
              market, ticker, report_date, hour, time_bucket,
              fiscal_year, fiscal_quarter,
              eps_estimate, eps_actual, revenue_estimate, revenue_actual,
              source, source_url, raw_json, imported_at
            )
            VALUES ('US', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'finnhub', ?, ?, ?)
            ON CONFLICT(market, ticker, report_date) DO UPDATE SET
              hour = excluded.hour,
              time_bucket = excluded.time_bucket,
              fiscal_year = excluded.fiscal_year,
              fiscal_quarter = excluded.fiscal_quarter,
              eps_estimate = excluded.eps_estimate,
              eps_actual = excluded.eps_actual,
              revenue_estimate = excluded.revenue_estimate,
              revenue_actual = excluded.revenue_actual,
              source = excluded.source,
              source_url = excluded.source_url,
              raw_json = excluded.raw_json,
              imported_at = excluded.imported_at
          `,
          args: [
            ticker,
            event.date,
            event.hour,
            finnhubEarningsTimeBucket(event.hour),
            event.year,
            event.quarter,
            event.epsEstimate,
            event.epsActual,
            event.revenueEstimate,
            event.revenueActual,
            FINNHUB_EARNINGS_SOURCE_URL,
            JSON.stringify(event.raw),
            importedAt,
          ],
        })))
      }
      await transaction.commit()
    } catch (error) {
      await transaction.rollback().catch(() => undefined)
      throw error
    } finally {
      transaction.close()
    }

    const unmatched = providerRows.length - matched.length
    await db.update(marketDataRuns).set({
      status: 'success',
      finishedAt: new Date(),
      totalTickers: providerRows.length,
      succeeded: matched.length,
      failed: 0,
      rowsInserted: matched.length,
      payloadJson: JSON.stringify({
        from,
        to,
        source: 'finnhub',
        providerRows: providerRows.length,
        activeStockUniverse: universe.size,
        matched: matched.length,
        unmatched,
        refreshedFutureFrom: today,
      }),
    }).where(eq(marketDataRuns.id, run.id))

    console.log(
      `US earnings complete: provider=${providerRows.length}, matched=${matched.length}, `
      + `unmatched=${unmatched}, range=${from}..${to}`,
    )
  } catch (error) {
    await db.update(marketDataRuns).set({
      status: 'failed',
      finishedAt: new Date(),
      errorSummary: conciseError(error),
    }).where(eq(marketDataRuns.id, run.id))
    throw error
  }
}

main().catch((error) => {
  console.error(`US earnings fatal: ${conciseError(error)}`)
  process.exit(1)
})
