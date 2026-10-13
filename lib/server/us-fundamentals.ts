import { execAll, execGet } from '@/lib/db/client'
import { loadNormalizedFinancialFactsForTickers } from '@/lib/server/financial-foundation-store'
import { buildUsFundamentalsModel, type UsFundamentalsModel } from '@/lib/us-fundamentals'

type PriceRow = { date: string; close: number }
type DividendRow = { date: string; cash: number }
type CoverageRow = { first_date: string | null }

export async function getUsFundamentals(
  ticker: string,
  requestedAsOf?: string | null,
): Promise<UsFundamentalsModel> {
  const normalizedTicker = ticker.trim().toUpperCase()
  const latestPrice = await execGet<PriceRow>(`
    SELECT date, COALESCE(adj_close, close) AS close
    FROM market_ohlcv_daily
    WHERE market = 'US' AND ticker = ?
    ORDER BY date DESC LIMIT 1
  `, [normalizedTicker])
  const asOf = requestedAsOf ?? latestPrice?.date ?? new Date().toISOString().slice(0, 10)
  const [profile, price, facts, dividends, dividendCoverage] = await Promise.all([
    execGet<{ name: string | null }>(`
      SELECT name FROM market_universe WHERE market = 'US' AND ticker = ?
    `, [normalizedTicker]),
    execGet<PriceRow>(`
      SELECT date, COALESCE(adj_close, close) AS close
      FROM market_ohlcv_daily
      WHERE market = 'US' AND ticker = ? AND date <= ?
      ORDER BY date DESC LIMIT 1
    `, [normalizedTicker, asOf]),
    loadNormalizedFinancialFactsForTickers([normalizedTicker], { asOf }),
    execAll<DividendRow>(`
      SELECT date, div_cash AS cash
      FROM market_ohlcv_daily
      WHERE market = 'US' AND ticker = ? AND date <= ?
        AND div_cash IS NOT NULL AND div_cash > 0
      ORDER BY date
    `, [normalizedTicker, asOf]),
    execGet<CoverageRow>(`
      SELECT MIN(date) AS first_date
      FROM market_ohlcv_daily
      WHERE market = 'US' AND ticker = ? AND date <= ?
    `, [normalizedTicker, asOf]),
  ])
  return buildUsFundamentalsModel({
    ticker: normalizedTicker,
    name: profile?.name ?? null,
    asOf,
    price: price ?? null,
    facts,
    dividends,
    dividendCoverageStart: dividendCoverage?.first_date ?? null,
  })
}
