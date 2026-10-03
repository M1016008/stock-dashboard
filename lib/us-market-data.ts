import { execAll, execGet } from '@/lib/db/client'
import { normalizeTickerForMarket } from '@/lib/markets'
import { getUsDisplayName } from '@/lib/us-symbol-aliases'
import type { StockQuote } from '@/types/stock'
import { buildQuoteTechnicalSummary } from '@/lib/quote-technicals'
import { toAdjustedUsOhlcvRows, type UsRawOhlcvRow } from '@/lib/us-adjusted-ohlcv'

export async function getUsQuote(rawTicker: string): Promise<StockQuote | null> {
  const ticker = normalizeTickerForMarket(rawTicker, 'US')
  const rawRows = await execAll<UsRawOhlcvRow>(
    `SELECT
       date, open, high, low, close, volume,
       adj_open AS adjustedOpen,
       adj_high AS adjustedHigh,
       adj_low AS adjustedLow,
       adj_close AS adjustedClose,
       adj_volume AS adjustedVolume
     FROM market_ohlcv_daily
     WHERE market = 'US' AND ticker = ?
     ORDER BY date DESC
     LIMIT 260`,
    [ticker],
  )
  const rows = toAdjustedUsOhlcvRows(rawRows)
  if (rows.length === 0) return null

  const latest = rows[0]
  const immediatePrev = rows[1]
  const hasZeroVolumeBridge = Boolean(immediatePrev && latest.volume > 0 && Number(immediatePrev.volume) <= 0)
  const prev = hasZeroVolumeBridge || Number(latest.volume) <= 0
    ? undefined
    : immediatePrev
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
  const yearStart = new Date(`${latest.date}T00:00:00Z`)
  yearStart.setUTCDate(yearStart.getUTCDate() - 365)
  const yearStartDate = yearStart.toISOString().slice(0, 10)
  const trailingYear = rows.filter((row) => row.date >= yearStartDate)
  const fiftyTwoWeekHigh = trailingYear.length > 0
    ? Math.max(...trailingYear.map((row) => row.high))
    : undefined
  const fiftyTwoWeekLow = trailingYear.length > 0
    ? Math.min(...trailingYear.map((row) => row.low))
    : undefined
  const change = prev ? latest.close - prev.close : 0
  const changePercent = prev && prev.close !== 0 ? 100 * change / prev.close : 0
  const technicals = buildQuoteTechnicalSummary([...rows].reverse())
  const priceQualityWarning = Number(latest.volume) <= 0
    ? '最新価格日の出来高が0のため、価格鮮度と前日比の解釈に注意してください。'
    : hasZeroVolumeBridge
      ? '直前に出来高0の固定価格が続いていたため、前日比は非表示扱いにしています。'
      : undefined
  return {
    ticker,
    market: 'US',
    currency: 'USD',
    name: getUsDisplayName(ticker, meta?.name),
    price: latest.close,
    change,
    changePercent,
    volume: latest.volume,
    priceDate: latest.date,
    previousPriceDate: prev?.date,
    priceQualityWarning,
    isPriceDiscontinuous: Boolean(priceQualityWarning),
    marketCap: meta?.shares_outstanding ? latest.close * meta.shares_outstanding : undefined,
    fiftyTwoWeekHigh,
    fiftyTwoWeekLow,
    technicals: technicals ?? undefined,
    exchange: meta?.exchange ?? undefined,
  }
}
