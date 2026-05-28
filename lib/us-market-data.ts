import { execAll, execGet } from '@/lib/db/client'
import { normalizeTickerForMarket } from '@/lib/markets'
import type { StockQuote } from '@/types/stock'

export async function getUsQuote(rawTicker: string): Promise<StockQuote | null> {
  const ticker = normalizeTickerForMarket(rawTicker, 'US')
  const rows = await execAll<{
    date: string
    close: number
    volume: number
  }>(
    `SELECT date, close, volume
     FROM market_ohlcv_daily
     WHERE market = 'US' AND ticker = ?
     ORDER BY date DESC
     LIMIT 2`,
    [ticker],
  )
  if (rows.length === 0) return null

  const latest = rows[0]
  const prev = rows[1]
  const meta = await execGet<{
    name: string | null
    exchange: string | null
    currency: string | null
    shares_outstanding: number | null
  }>(
    `SELECT name, exchange, currency, shares_outstanding
     FROM market_universe
     WHERE market = 'US' AND ticker = ?`,
    [ticker],
  )
  const hiLo = await execGet<{ hi: number | null; lo: number | null }>(
    `SELECT MAX(high) AS hi, MIN(low) AS lo
     FROM market_ohlcv_daily
     WHERE market = 'US' AND ticker = ? AND date >= date(?, '-365 days')`,
    [ticker, latest.date],
  )
  const change = prev ? latest.close - prev.close : 0
  const changePercent = prev && prev.close !== 0 ? 100 * change / prev.close : 0
  return {
    ticker,
    market: 'US',
    currency: 'USD',
    name: meta?.name ?? ticker,
    price: latest.close,
    change,
    changePercent,
    volume: latest.volume,
    marketCap: meta?.shares_outstanding ? latest.close * meta.shares_outstanding : undefined,
    fiftyTwoWeekHigh: hiLo?.hi ?? undefined,
    fiftyTwoWeekLow: hiLo?.lo ?? undefined,
    exchange: meta?.exchange ?? undefined,
  }
}
