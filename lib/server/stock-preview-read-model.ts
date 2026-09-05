import { execAll, execGet } from '@/lib/db/client'
import type { StockPreviewData, StockPreviewMarket, StockPreviewStages } from '@/lib/stock-preview'
import type { OHLCV } from '@/types/stock'
import { adjustLikelySplitOhlcv } from '@/lib/physical-momentum'
import { getUsDisplayName } from '@/lib/us-symbol-aliases'
import { toAdjustedUsOhlcvRows, type UsRawOhlcvRow } from '@/lib/us-adjusted-ohlcv'

interface PriceRow {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
  adjustedOpen?: number | null
  adjustedHigh?: number | null
  adjustedLow?: number | null
  adjustedClose?: number | null
  adjustedVolume?: number | null
}

interface StageRow {
  date: string
  daily_a_stage: number | null
  daily_b_stage: number | null
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
}

interface JpProfileRow {
  name: string | null
  market_segment: string | null
  margin_type: string | null
  sector17_name: string | null
  sector33_name: string | null
  shares_outstanding: number | null
  company_feature: string | null
}

interface UsProfileRow {
  name: string | null
  exchange: string | null
  sector: string | null
  industry: string | null
  shares_outstanding: number | null
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const QUICK_VIEW_ROWS = 252
// 月足60MAに必要な約5年分を確保しつつ、popoverへ全履歴を送らない。
const QUICK_CHART_ROWS = 1400

export class StockPreviewInputError extends Error {}

function finiteNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function ratioPercent(value: number, base: number | null): number | null {
  return base != null && base > 0 ? (value / base - 1) * 100 : null
}

function normalizeStage(value: unknown): number | null {
  const number = finiteNumber(value)
  return number != null && number >= 1 && number <= 6 ? number : null
}

function mapStages(row: StageRow | undefined): StockPreviewStages {
  return {
    dailyA: normalizeStage(row?.daily_a_stage),
    dailyB: normalizeStage(row?.daily_b_stage),
    weeklyA: normalizeStage(row?.weekly_a_stage),
    weeklyB: normalizeStage(row?.weekly_b_stage),
    monthlyA: normalizeStage(row?.monthly_a_stage),
    monthlyB: normalizeStage(row?.monthly_b_stage),
  }
}

function toChartRows(rows: PriceRow[]): OHLCV[] {
  return [...rows].reverse().map((row) => ({
    date: row.date,
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume),
  }))
}

function toUsChartRows(rows: PriceRow[]): OHLCV[] {
  return toAdjustedUsOhlcvRows([...rows].reverse().map((row): UsRawOhlcvRow => ({
    date: row.date,
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume),
    adjustedOpen: finiteNumber(row.adjustedOpen),
    adjustedHigh: finiteNumber(row.adjustedHigh),
    adjustedLow: finiteNumber(row.adjustedLow),
    adjustedClose: finiteNumber(row.adjustedClose),
    adjustedVolume: finiteNumber(row.adjustedVolume),
  })))
}

async function loadPrices(ticker: string, market: StockPreviewMarket, asOf: string | null, includeChart: boolean): Promise<PriceRow[]> {
  const limit = includeChart ? QUICK_CHART_ROWS : QUICK_VIEW_ROWS
  if (market === 'US') {
    return execAll<PriceRow>(`
      SELECT date, open, high, low, close, volume,
             adj_open AS adjustedOpen,
             adj_high AS adjustedHigh,
             adj_low AS adjustedLow,
             adj_close AS adjustedClose,
             adj_volume AS adjustedVolume
      FROM market_ohlcv_daily
      WHERE market = 'US' AND ticker = ? AND (? IS NULL OR date <= ?)
      ORDER BY date DESC
      LIMIT ?
    `, [ticker, asOf, asOf, limit])
  }
  return execAll<PriceRow>(`
    SELECT date, open, high, low, close, volume
    FROM ohlcv_daily
    WHERE ticker = ? AND (? IS NULL OR date <= ?)
    ORDER BY date DESC
    LIMIT ?
  `, [ticker, asOf, asOf, limit])
}

async function loadStages(ticker: string, market: StockPreviewMarket, priceDate: string): Promise<StageRow | undefined> {
  if (market === 'US') {
    return execGet<StageRow>(`
      SELECT date, daily_a_stage, daily_b_stage, weekly_a_stage, weekly_b_stage, monthly_a_stage, monthly_b_stage
      FROM market_daily_snapshots
      WHERE market = 'US' AND ticker = ? AND date <= ?
      ORDER BY date DESC
      LIMIT 1
    `, [ticker, priceDate])
  }
  return execGet<StageRow>(`
    SELECT date, daily_a_stage, daily_b_stage, weekly_a_stage, weekly_b_stage, monthly_a_stage, monthly_b_stage
    FROM daily_snapshots
    WHERE ticker = ? AND date <= ?
    ORDER BY date DESC
    LIMIT 1
  `, [ticker, priceDate])
}

async function loadJpProfile(ticker: string): Promise<JpProfileRow | undefined> {
  return execGet<JpProfileRow>(`
    SELECT COALESCE(u.name, h.name, ?) AS name,
           COALESCE(u.market_segment, h.market_segment) AS market_segment,
           COALESCE(u.margin_type, h.margin_type) AS margin_type,
           COALESCE(u.sector17_name, h.sector17_name) AS sector17_name,
           COALESCE(u.sector33_name, h.sector33_name) AS sector33_name,
           u.shares_outstanding,
           s.company_feature
    FROM (SELECT ? AS ticker) x
    LEFT JOIN ticker_universe u ON u.ticker = x.ticker
    LEFT JOIN historical_universe h ON h.ticker = x.ticker
    LEFT JOIN stock_shikiho_profiles s ON s.ticker = x.ticker
  `, [ticker, ticker])
}

async function loadUsProfile(ticker: string): Promise<UsProfileRow | undefined> {
  return execGet<UsProfileRow>(`
    SELECT u.name, u.exchange, u.sector, u.industry, u.shares_outstanding
    FROM market_universe u
    WHERE u.market = 'US' AND u.ticker = ?
    LIMIT 1
  `, [ticker])
}

async function loadPitShares(ticker: string, asOf: string): Promise<number | null> {
  const row = await execGet<{ value: number | null }>(`
    SELECT value
    FROM normalized_financial_facts
    WHERE ticker = ? AND metric = 'shares_outstanding' AND published_at < date(?, '+1 day')
    ORDER BY published_at DESC, period_end DESC, imported_at DESC, fact_id DESC
    LIMIT 1
  `, [ticker, asOf])
  return finiteNumber(row?.value)
}

export async function getStockPreview(input: {
  ticker: string
  market?: StockPreviewMarket
  asOf?: string | null
  includeChart?: boolean
}): Promise<StockPreviewData | null> {
  const startedAt = Date.now()
  const market = input.market ?? 'JP'
  const ticker = market === 'US' ? input.ticker.trim().toUpperCase() : input.ticker.trim().replace(/\.T$/i, '')
  const asOf = input.asOf?.trim() || null
  if (!ticker) throw new StockPreviewInputError('ticker is required')
  if (asOf && !DATE_PATTERN.test(asOf)) throw new StockPreviewInputError('as_of must use YYYY-MM-DD')

  const rawPrices = await loadPrices(ticker, market, asOf, Boolean(input.includeChart))
  if (rawPrices.length === 0) return null
  const chartRows = market === 'JP'
    ? adjustLikelySplitOhlcv(toChartRows(rawPrices))
    : toUsChartRows(rawPrices)
  const prices = [...chartRows].reverse()
  const latest = prices[0]
  const previous = prices[1]
  const comparisonRows = prices.slice(0, Math.min(QUICK_VIEW_ROWS, prices.length))
  const liquidRows = comparisonRows.slice(0, Math.min(20, comparisonRows.length))
  const high52 = comparisonRows.length ? Math.max(...comparisonRows.map((row) => Number(row.high))) : null
  const low52 = comparisonRows.length ? Math.min(...comparisonRows.map((row) => Number(row.low))) : null
  const avgVolume20 = liquidRows.length
    ? liquidRows.reduce((sum, row) => sum + Number(row.volume), 0) / liquidRows.length
    : null
  const avgTradingValue20 = liquidRows.length
    ? liquidRows.reduce((sum, row) => sum + Number(row.close) * Number(row.volume), 0) / liquidRows.length
    : null

  const [stageRow, jpProfile, usProfile] = await Promise.all([
    loadStages(ticker, market, latest.date),
    market === 'JP' ? loadJpProfile(ticker) : Promise.resolve(undefined),
    market === 'US' ? loadUsProfile(ticker) : Promise.resolve(undefined),
  ])

  let shares = market === 'JP' ? await loadPitShares(ticker, latest.date) : null
  let marketCapBasis: StockPreviewData['marketCapBasis'] = shares != null ? 'pit' : 'missing'
  const currentShares = market === 'JP' ? finiteNumber(jpProfile?.shares_outstanding) : finiteNumber(usProfile?.shares_outstanding)
  if (shares == null && currentShares != null) {
    shares = currentShares
    marketCapBasis = 'current'
  }

  const price = Number(latest.close)
  const previousPrice = previous ? Number(previous.close) : null
  const change = previousPrice == null ? null : price - previousPrice
  const changePercent = previousPrice != null && previousPrice > 0 ? change! / previousPrice * 100 : null
  return {
    success: true,
    ticker,
    market,
    name: market === 'JP' ? jpProfile?.name ?? ticker : getUsDisplayName(ticker, usProfile?.name),
    requestedAsOf: asOf,
    asOf: latest.date,
    priceDate: latest.date,
    stageDate: stageRow?.date ?? null,
    price,
    change,
    changePercent,
    sector: (market === 'JP' ? jpProfile?.sector33_name : usProfile?.industry ?? usProfile?.sector) ?? null,
    sector17: (market === 'JP' ? jpProfile?.sector17_name : usProfile?.sector) ?? null,
    marketSegment: (market === 'JP' ? jpProfile?.market_segment : usProfile?.exchange) ?? null,
    marginType: market === 'JP' ? jpProfile?.margin_type ?? null : null,
    description: market === 'JP' ? jpProfile?.company_feature?.trim() || null : null,
    stages: mapStages(stageRow),
    marketCap: shares != null ? price * shares : null,
    marketCapBasis,
    avgTradingValue20,
    avgVolume20,
    high52,
    low52,
    high52DistancePercent: ratioPercent(price, high52),
    low52DistancePercent: ratioPercent(price, low52),
    attributeBasis: 'current',
    chart: input.includeChart ? chartRows : undefined,
    elapsedMs: Date.now() - startedAt,
  }
}
