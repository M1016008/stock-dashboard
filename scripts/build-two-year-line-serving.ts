import { execAll, execGet, localDbPath } from '@/lib/db/client'
import { buildTwoYearLineServingCache } from '@/lib/server/two-year-line-search'
import type { TwoYearMarket } from '@/lib/two-year-candles'

interface SnapshotDateRow {
  date: string | null
}

interface TickerRow {
  ticker: string
}

function explicitMarket(): TwoYearMarket {
  const value = process.env.TWO_YEAR_LINE_SERVING_MARKET?.trim().toUpperCase()
  if (value !== 'JP' && value !== 'US') {
    throw new Error('TWO_YEAR_LINE_SERVING_MARKET must explicitly be JP or US')
  }
  return value
}

async function resolveSnapshotDate(market: TwoYearMarket, requestedAsOfDate: string): Promise<string> {
  const row = market === 'JP'
    ? await execGet<SnapshotDateRow>(
        'SELECT MAX(date) AS date FROM daily_snapshots WHERE date <= ?',
        [requestedAsOfDate],
      )
    : await execGet<SnapshotDateRow>(
        "SELECT MAX(date) AS date FROM market_daily_snapshots WHERE market = 'US' AND date <= ?",
        [requestedAsOfDate],
      )
  if (!row?.date) throw new Error(`${market} snapshot date is unavailable at or before ${requestedAsOfDate}`)
  return row.date
}

async function loadSnapshotTickers(market: TwoYearMarket, date: string): Promise<string[]> {
  const rows = market === 'JP'
    ? await execAll<TickerRow>(
        'SELECT ticker FROM daily_snapshots WHERE date = ? ORDER BY ticker',
        [date],
      )
    : await execAll<TickerRow>(
        "SELECT ticker FROM market_daily_snapshots WHERE market = 'US' AND date = ? ORDER BY ticker",
        [date],
      )
  const tickers = [...new Set(rows.map((row) => row.ticker.trim().replace(/\.T$/i, '').toUpperCase()).filter(Boolean))]
  if (tickers.length === 0) throw new Error(`${market} serving universe is empty for ${date}`)
  return tickers
}

async function main(): Promise<void> {
  const market = explicitMarket()
  const requestedAsOfDate = process.env.TWO_YEAR_LINE_SERVING_AS_OF?.trim() || '9999-12-31'
  const snapshotDate = await resolveSnapshotDate(market, requestedAsOfDate)
  const tickers = await loadSnapshotTickers(market, snapshotDate)
  console.log(JSON.stringify({
    event: 'two_year_line_serving_start',
    market,
    requestedAsOfDate,
    snapshotDate,
    tickerCount: tickers.length,
    databasePath: localDbPath,
  }))
  const built = await buildTwoYearLineServingCache({ market, tickers, asOfDate: snapshotDate })
  console.log(JSON.stringify({
    event: 'two_year_line_serving_complete',
    market,
    snapshotDate,
    effectiveAsOfDate: built.result.metadata.asOfDate,
    tickerCount: built.result.entries.size,
    sourceGeneration: built.sourceGeneration,
    elapsedMs: built.elapsedMs,
    cacheKey: built.cacheKey,
  }))
}

void main().catch((error) => {
  console.error('two-year line serving build failed:', error)
  process.exitCode = 1
})
