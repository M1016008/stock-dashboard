import {
  PERIOD_EXPLORER_AXIS_KEYS,
  PERIOD_EXPLORER_RANKING_MAP,
  calculatePeriodPriceMetrics,
  isPeriodExplorerRankingKey,
  median,
  summarizeStagePeriod,
  type PeriodExplorerAxisKey,
  type PeriodExplorerRankingKey,
  type StagePeriodSummary,
} from '@/lib/period-explorer'
import { execAll, execGet } from '@/lib/db/client'
import { readServingCache, stableCacheKey, writeServingCache } from '@/lib/api/serving-cache'
import { NIKKEI225_TICKERS } from '@/lib/market-universe'

export type PeriodExplorerTaxonomy = 'sector17' | 'sector33' | 'major' | 'subIndustry'
export type PeriodExplorerSortKey = 'ranking' | 'periodReturn' | 'price' | 'marketCap' | 'avgTurnover' | 'avgVolume' | 'ticker'

export interface PeriodExplorerFilters {
  markets?: string[]
  sectors?: string[]
  marginTypes?: string[]
  marketCapMin?: number | null
  marketCapMax?: number | null
  avgVolumeMin?: number | null
  avgVolumeMax?: number | null
  avgTurnoverMin?: number | null
  avgTurnoverMax?: number | null
  priceMin?: number | null
  priceMax?: number | null
  stages?: Partial<Record<PeriodExplorerAxisKey, number[]>>
  ma25Position?: 'above' | 'below' | null
  ma75Position?: 'above' | 'below' | null
  high52WithinPct?: number | null
  low52WithinPct?: number | null
  universe?: 'nikkei225' | null
}

export interface PeriodExplorerInput {
  from?: string | null
  to?: string | null
  ranking?: PeriodExplorerRankingKey | null
  taxonomy?: PeriodExplorerTaxonomy
  filters?: PeriodExplorerFilters
  sort?: PeriodExplorerSortKey
  direction?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

export interface PeriodExplorerDateRange {
  requestedFrom: string | null
  requestedTo: string | null
  adoptedFrom: string
  adoptedTo: string
  tradingDays: number
  previousFrom: string | null
  previousTo: string | null
}

export interface PeriodExplorerStageValues extends Record<PeriodExplorerAxisKey, number | null> {}

export interface PeriodExplorerStockRow {
  rowType: 'stock'
  rank: number
  ticker: string
  name: string
  rankingValue: number | null
  startClose: number
  endClose: number
  periodReturnPct: number | null
  periodHigh: number | null
  periodLow: number | null
  maxRisePct: number | null
  maxFallPct: number | null
  drawdownFromHighPct: number | null
  reboundFromLowPct: number | null
  periodRangePct: number | null
  avgVolume: number | null
  maxVolume: number | null
  volumeIncreasePct: number | null
  avgTurnover: number | null
  totalTurnover: number | null
  turnoverIncreasePct: number | null
  realizedVolatilityPct: number | null
  gapUpCount: number | null
  gapDownCount: number | null
  high52: number | null
  low52: number | null
  high52DistancePct: number | null
  low52DistancePct: number | null
  marketCap: number | null
  marketCapBasis: 'pit' | 'current' | 'missing'
  marketSegment: string | null
  marginType: string | null
  sector17: string | null
  sector33: string | null
  majorCategory: string | null
  subIndustry: string | null
  selectedSector: string | null
  startStages: PeriodExplorerStageValues
  endStages: PeriodExplorerStageValues
  stageCode: string | null
  stageSummary: StagePeriodSummary
  ma25DeviationPct: number | null
  ma75DeviationPct: number | null
  maSpreadStartPct: number | null
  maSpreadEndPct: number | null
  maConvergencePct: number | null
  maExpansionPct: number | null
  goldenCross: boolean
  deadCross: boolean
  historicalOnly: boolean
}

export interface PeriodExplorerSectorRow {
  rowType: 'sector'
  rank: number
  sector: string
  rankingValue: number | null
  stocks: number
  avgReturnPct: number | null
  medianReturnPct: number | null
  advancingRatePct: number | null
  stageImproveRatePct: number | null
  avgTurnover: number | null
  avgVolume: number | null
}

export interface PeriodExplorerResponse {
  success: true
  ranking: PeriodExplorerRankingKey
  rankingLabel: string
  rankingDescription: string
  rankingUnit: string
  resultKind: 'stocks' | 'sectors'
  taxonomy: PeriodExplorerTaxonomy
  range: PeriodExplorerDateRange
  rows: Array<PeriodExplorerStockRow | PeriodExplorerSectorRow>
  total: number
  universeTotal: number
  limit: number
  offset: number
  excluded: {
    missingEndpoints: number
    missingRankingValue: number
    filteredOut: number
  }
  options: {
    markets: Array<{ value: string; count: number }>
    sectors: Array<{ value: string; count: number }>
    marginTypes: Array<{ value: string; count: number }>
  }
  dataBasis: {
    prices: 'adjusted_ohlcv'
    stages: 'daily_snapshot_pit'
    shares: 'pit_with_current_fallback'
    classifications: 'current'
    market: 'current'
    marginType: 'current'
  }
  cacheHit: boolean
  elapsedMs: number
}

type CalendarCache = { dates: string[]; expiresAt: number }
const globalForPeriodExplorer = global as typeof globalThis & {
  periodExplorerCalendar?: CalendarCache
}

type BaseDbRow = Record<string, unknown> & {
  ticker: string
  name: string | null
  start_close: number
  end_close: number
  current_shares: number | null
  market_segment: string | null
  margin_type: string | null
  sector17: string | null
  sector33: string | null
  major_category: string | null
  sub_industry: string | null
  historical_status: string | null
  start_ma25: number | null
  start_ma75: number | null
  end_ma25: number | null
  end_ma75: number | null
  start_daily_a: number | null
  start_daily_b: number | null
  start_weekly_a: number | null
  start_weekly_b: number | null
  start_monthly_a: number | null
  start_monthly_b: number | null
  end_daily_a: number | null
  end_daily_b: number | null
  end_weekly_a: number | null
  end_weekly_b: number | null
  end_monthly_a: number | null
  end_monthly_b: number | null
}

type EndpointDbRow = Pick<BaseDbRow, 'ticker' | 'start_close' | 'end_close'>
type ProfileDbRow = Pick<BaseDbRow,
  | 'ticker'
  | 'name'
  | 'current_shares'
  | 'market_segment'
  | 'margin_type'
  | 'sector17'
  | 'sector33'
  | 'major_category'
  | 'sub_industry'
  | 'historical_status'
>
type TechnicalDbRow = Pick<BaseDbRow,
  | 'ticker'
  | 'start_ma25'
  | 'start_ma75'
  | 'end_ma25'
  | 'end_ma75'
  | 'start_daily_a'
  | 'start_daily_b'
  | 'start_weekly_a'
  | 'start_weekly_b'
  | 'start_monthly_a'
  | 'start_monthly_b'
  | 'end_daily_a'
  | 'end_daily_b'
  | 'end_weekly_a'
  | 'end_weekly_b'
  | 'end_monthly_a'
  | 'end_monthly_b'
>

type RangeDbRow = {
  ticker: string
  period_high: number | null
  period_low: number | null
  avg_volume: number | null
  max_volume: number | null
  avg_turnover: number | null
  total_turnover: number | null
}

type RangeStatsScope = 'full' | 'price' | 'volume' | 'turnover'

type VolatilityDbRow = {
  ticker: string
  observations: number
  return_sum: number | null
  return_sq_sum: number | null
  gap_up_count: number | null
  gap_down_count: number | null
}

const CALENDAR_TTL_MS = 5 * 60_000
const RESPONSE_TTL_MS = 5 * 60_000
const CACHE_VERSION = 6
const NIKKEI225_SET = new Set<string>(NIKKEI225_TICKERS)

export class PeriodExplorerInputError extends Error {}

function asNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function safeRatioPct(numerator: number | null, denominator: number | null): number | null {
  if (numerator == null || denominator == null || denominator <= 0) return null
  return (numerator / denominator - 1) * 100
}

function validIsoDate(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

function nextUtcDate(date: string): string {
  const value = new Date(`${date}T00:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() + 1)
  return value.toISOString().slice(0, 10)
}

function countOptions(values: Array<string | null>): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>()
  for (const value of values) {
    if (!value) continue
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, 'ja'))
}

function selectedSector(row: Pick<PeriodExplorerStockRow, 'sector17' | 'sector33' | 'majorCategory' | 'subIndustry'>, taxonomy: PeriodExplorerTaxonomy): string | null {
  if (taxonomy === 'sector17') return row.sector17
  if (taxonomy === 'major') return row.majorCategory
  if (taxonomy === 'subIndustry') return row.subIndustry
  return row.sector33
}

function stagesFromDb(row: BaseDbRow, side: 'start' | 'end'): PeriodExplorerStageValues {
  const prefix = side === 'start' ? 'start' : 'end'
  return {
    dailyA: asNumber(row[`${prefix}_daily_a`]),
    dailyB: asNumber(row[`${prefix}_daily_b`]),
    weeklyA: asNumber(row[`${prefix}_weekly_a`]),
    weeklyB: asNumber(row[`${prefix}_weekly_b`]),
    monthlyA: asNumber(row[`${prefix}_monthly_a`]),
    monthlyB: asNumber(row[`${prefix}_monthly_b`]),
  }
}

function stageCode(stages: PeriodExplorerStageValues): string | null {
  const values = PERIOD_EXPLORER_AXIS_KEYS.map((axis) => stages[axis])
  return values.every((value) => value != null && value >= 1 && value <= 6) ? values.join('') : null
}

function emptyStockRow(row: BaseDbRow, taxonomy: PeriodExplorerTaxonomy): PeriodExplorerStockRow {
  const startClose = Number(row.start_close)
  const endClose = Number(row.end_close)
  const startStages = stagesFromDb(row, 'start')
  const endStages = stagesFromDb(row, 'end')
  const stageSummary = summarizeStagePeriod(startStages, endStages)
  const shares = asNumber(row.current_shares)
  const marketCapBasis = shares != null ? 'current' : 'missing'
  const startMa25 = asNumber(row.start_ma25)
  const startMa75 = asNumber(row.start_ma75)
  const endMa25 = asNumber(row.end_ma25)
  const endMa75 = asNumber(row.end_ma75)
  const maSpreadStartPct = startMa25 != null && startMa75 != null && startClose > 0
    ? Math.abs(startMa25 - startMa75) / startClose * 100
    : null
  const maSpreadEndPct = endMa25 != null && endMa75 != null && endClose > 0
    ? Math.abs(endMa25 - endMa75) / endClose * 100
    : null
  const rowValue: PeriodExplorerStockRow = {
    rowType: 'stock', rank: 0, ticker: String(row.ticker), name: String(row.name ?? row.ticker), rankingValue: null,
    startClose, endClose, periodReturnPct: safeRatioPct(endClose, startClose),
    periodHigh: null, periodLow: null, maxRisePct: null, maxFallPct: null, drawdownFromHighPct: null,
    reboundFromLowPct: null, periodRangePct: null, avgVolume: null, maxVolume: null, volumeIncreasePct: null,
    avgTurnover: null, totalTurnover: null, turnoverIncreasePct: null, realizedVolatilityPct: null,
    gapUpCount: null, gapDownCount: null, high52: null, low52: null, high52DistancePct: null,
    low52DistancePct: null, marketCap: shares != null ? endClose * shares : null, marketCapBasis,
    marketSegment: row.market_segment ? String(row.market_segment) : null,
    marginType: row.margin_type ? String(row.margin_type) : null,
    sector17: row.sector17 ? String(row.sector17) : null,
    sector33: row.sector33 ? String(row.sector33) : null,
    majorCategory: row.major_category ? String(row.major_category) : null,
    subIndustry: row.sub_industry ? String(row.sub_industry) : null,
    selectedSector: null, startStages, endStages, stageCode: stageCode(endStages), stageSummary,
    ma25DeviationPct: safeRatioPct(endClose, endMa25), ma75DeviationPct: safeRatioPct(endClose, endMa75),
    maSpreadStartPct, maSpreadEndPct,
    maConvergencePct: maSpreadStartPct != null && maSpreadEndPct != null ? maSpreadStartPct - maSpreadEndPct : null,
    maExpansionPct: maSpreadStartPct != null && maSpreadEndPct != null ? maSpreadEndPct - maSpreadStartPct : null,
    goldenCross: startMa25 != null && startMa75 != null && endMa25 != null && endMa75 != null && startMa25 <= startMa75 && endMa25 > endMa75,
    deadCross: startMa25 != null && startMa75 != null && endMa25 != null && endMa75 != null && startMa25 >= startMa75 && endMa25 < endMa75,
    historicalOnly: row.historical_status === 'historical_only',
  }
  rowValue.selectedSector = selectedSector(rowValue, taxonomy)
  return rowValue
}

function applyTechnicalData(row: PeriodExplorerStockRow, value: TechnicalDbRow | undefined): void {
  if (!value) return
  row.startStages = stagesFromDb(value as BaseDbRow, 'start')
  row.endStages = stagesFromDb(value as BaseDbRow, 'end')
  row.stageCode = stageCode(row.endStages)
  row.stageSummary = summarizeStagePeriod(row.startStages, row.endStages)
  const startMa25 = asNumber(value.start_ma25)
  const startMa75 = asNumber(value.start_ma75)
  const endMa25 = asNumber(value.end_ma25)
  const endMa75 = asNumber(value.end_ma75)
  row.ma25DeviationPct = safeRatioPct(row.endClose, endMa25)
  row.ma75DeviationPct = safeRatioPct(row.endClose, endMa75)
  row.maSpreadStartPct = startMa25 != null && startMa75 != null && row.startClose > 0
    ? Math.abs(startMa25 - startMa75) / row.startClose * 100
    : null
  row.maSpreadEndPct = endMa25 != null && endMa75 != null && row.endClose > 0
    ? Math.abs(endMa25 - endMa75) / row.endClose * 100
    : null
  row.maConvergencePct = row.maSpreadStartPct != null && row.maSpreadEndPct != null
    ? row.maSpreadStartPct - row.maSpreadEndPct
    : null
  row.maExpansionPct = row.maSpreadStartPct != null && row.maSpreadEndPct != null
    ? row.maSpreadEndPct - row.maSpreadStartPct
    : null
  row.goldenCross = startMa25 != null && startMa75 != null && endMa25 != null && endMa75 != null
    && startMa25 <= startMa75 && endMa25 > endMa75
  row.deadCross = startMa25 != null && startMa75 != null && endMa25 != null && endMa75 != null
    && startMa25 >= startMa75 && endMa25 < endMa75
}

export async function getPeriodExplorerCalendar(): Promise<string[]> {
  const cached = globalForPeriodExplorer.periodExplorerCalendar
  if (cached && cached.expiresAt > Date.now()) return cached.dates
  let rows = await execAll<{ date: string }>('SELECT date FROM serving_daily_snapshot_dates ORDER BY date ASC').catch(() => [])
  if (rows.length === 0) {
    rows = await execAll<{ date: string }>('SELECT DISTINCT date FROM ohlcv_daily ORDER BY date ASC')
  }
  const dates = rows.map((row) => String(row.date)).filter(validIsoDate)
  globalForPeriodExplorer.periodExplorerCalendar = { dates, expiresAt: Date.now() + CALENDAR_TTL_MS }
  return dates
}

function lowerBound(values: string[], target: string): number {
  let low = 0
  let high = values.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (values[middle] < target) low = middle + 1
    else high = middle
  }
  return low
}

function upperBound(values: string[], target: string): number {
  let low = 0
  let high = values.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (values[middle] <= target) low = middle + 1
    else high = middle
  }
  return low
}

export async function resolvePeriodExplorerDateRange(from?: string | null, to?: string | null): Promise<PeriodExplorerDateRange> {
  const dates = await getPeriodExplorerCalendar()
  if (dates.length === 0) throw new PeriodExplorerInputError('取引日データがありません。')
  if (from && !validIsoDate(from)) throw new PeriodExplorerInputError('開始日はYYYY-MM-DD形式で指定してください。')
  if (to && !validIsoDate(to)) throw new PeriodExplorerInputError('終了日はYYYY-MM-DD形式で指定してください。')
  if (from && to && from > to) throw new PeriodExplorerInputError('開始日は終了日以前にしてください。')

  const requestedTo = to ?? dates[dates.length - 1]
  const endIndex = Math.min(dates.length - 1, upperBound(dates, requestedTo) - 1)
  if (endIndex < 0) throw new PeriodExplorerInputError('終了日以前の取引日がありません。')
  const defaultStartIndex = Math.max(0, endIndex - 19)
  const requestedFrom = from ?? dates[defaultStartIndex]
  const startIndex = lowerBound(dates, requestedFrom)
  if (startIndex >= dates.length || startIndex > endIndex) throw new PeriodExplorerInputError('指定期間内に取引日がありません。')

  const tradingDays = endIndex - startIndex + 1
  const previousEndIndex = startIndex - 1
  const previousStartIndex = Math.max(0, previousEndIndex - tradingDays + 1)
  return {
    requestedFrom: from ?? null,
    requestedTo: to ?? null,
    adoptedFrom: dates[startIndex],
    adoptedTo: dates[endIndex],
    tradingDays,
    previousFrom: previousEndIndex >= 0 ? dates[previousStartIndex] : null,
    previousTo: previousEndIndex >= 0 ? dates[previousEndIndex] : null,
  }
}

async function loadTechnicalRows(
  range: PeriodExplorerDateRange,
  tickers?: string[],
): Promise<Map<string, TechnicalDbRow>> {
  const result = new Map<string, TechnicalDbRow>()
  const chunks = tickers?.length
    ? Array.from({ length: Math.ceil(tickers.length / 400) }, (_, index) => tickers.slice(index * 400, index * 400 + 400))
    : [null]
  for (const chunk of chunks) {
    const tickerWhere = chunk ? `AND ss.ticker IN (${chunk.map(() => '?').join(',')})` : ''
    const rows = await execAll<TechnicalDbRow>(`
      SELECT ss.ticker,
             ss.ma_25 AS start_ma25, ss.ma_75 AS start_ma75,
             es.ma_25 AS end_ma25, es.ma_75 AS end_ma75,
             ss.daily_a_stage AS start_daily_a, ss.daily_b_stage AS start_daily_b,
             ss.weekly_a_stage AS start_weekly_a, ss.weekly_b_stage AS start_weekly_b,
             ss.monthly_a_stage AS start_monthly_a, ss.monthly_b_stage AS start_monthly_b,
             es.daily_a_stage AS end_daily_a, es.daily_b_stage AS end_daily_b,
             es.weekly_a_stage AS end_weekly_a, es.weekly_b_stage AS end_weekly_b,
             es.monthly_a_stage AS end_monthly_a, es.monthly_b_stage AS end_monthly_b
      FROM daily_snapshots ss
      INNER JOIN daily_snapshots es ON es.ticker = ss.ticker AND es.date = ?
      WHERE ss.date = ? ${tickerWhere}
    `, [range.adoptedTo, range.adoptedFrom, ...(chunk ?? [])])
    for (const row of rows) result.set(String(row.ticker), row)
  }
  return result
}

async function loadBaseRows(
  range: PeriodExplorerDateRange,
  taxonomy: PeriodExplorerTaxonomy,
  includeAllTechnical: boolean,
): Promise<PeriodExplorerStockRow[]> {
  const [endpoints, profiles, technical] = await Promise.all([
    execAll<EndpointDbRow>(`
      SELECT e.ticker, s.close AS start_close, e.close AS end_close
      FROM ohlcv_daily s
      INNER JOIN ohlcv_daily e ON e.ticker = s.ticker AND e.date = ?
      WHERE s.date = ? AND s.close > 0 AND e.close > 0
    `, [range.adoptedTo, range.adoptedFrom]),
    execAll<ProfileDbRow>(`
      SELECT source.ticker,
             COALESCE(u.name, h.name, source.ticker) AS name,
             u.shares_outstanding AS current_shares,
             COALESCE(u.market_segment, h.market_segment) AS market_segment,
             COALESCE(u.margin_type, h.margin_type) AS margin_type,
             COALESCE(u.sector17_name, h.sector17_name) AS sector17,
             COALESCE(u.sector33_name, h.sector33_name) AS sector33,
             sc.major_category, sc.sub_industry, h.status AS historical_status
      FROM (
        SELECT ticker FROM historical_universe
        UNION
        SELECT ticker FROM ticker_universe
      ) source
      LEFT JOIN historical_universe h ON h.ticker = source.ticker
      LEFT JOIN ticker_universe u ON u.ticker = source.ticker
      LEFT JOIN stock_classification sc ON sc.ticker = source.ticker
    `),
    includeAllTechnical ? loadTechnicalRows(range) : Promise.resolve(new Map<string, TechnicalDbRow>()),
  ])
  const profilesByTicker = new Map(profiles.map((row) => [String(row.ticker), row]))
  return endpoints.map((endpoint) => {
    const profile = profilesByTicker.get(String(endpoint.ticker))
    const technicalRow = technical.get(String(endpoint.ticker))
    const source = {
      ...endpoint,
      name: profile?.name ?? endpoint.ticker,
      current_shares: profile?.current_shares ?? null,
      market_segment: profile?.market_segment ?? null,
      margin_type: profile?.margin_type ?? null,
      sector17: profile?.sector17 ?? null,
      sector33: profile?.sector33 ?? null,
      major_category: profile?.major_category ?? null,
      sub_industry: profile?.sub_industry ?? null,
      historical_status: profile?.historical_status ?? null,
      start_ma25: technicalRow?.start_ma25 ?? null,
      start_ma75: technicalRow?.start_ma75 ?? null,
      end_ma25: technicalRow?.end_ma25 ?? null,
      end_ma75: technicalRow?.end_ma75 ?? null,
      start_daily_a: technicalRow?.start_daily_a ?? null,
      start_daily_b: technicalRow?.start_daily_b ?? null,
      start_weekly_a: technicalRow?.start_weekly_a ?? null,
      start_weekly_b: technicalRow?.start_weekly_b ?? null,
      start_monthly_a: technicalRow?.start_monthly_a ?? null,
      start_monthly_b: technicalRow?.start_monthly_b ?? null,
      end_daily_a: technicalRow?.end_daily_a ?? null,
      end_daily_b: technicalRow?.end_daily_b ?? null,
      end_weekly_a: technicalRow?.end_weekly_a ?? null,
      end_weekly_b: technicalRow?.end_weekly_b ?? null,
      end_monthly_a: technicalRow?.end_monthly_a ?? null,
      end_monthly_b: technicalRow?.end_monthly_b ?? null,
    } satisfies BaseDbRow
    return emptyStockRow(source, taxonomy)
  })
}

async function loadPitShares(asOf: string, tickers: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>()
  const chunks = Array.from({ length: Math.ceil(tickers.length / 400) }, (_, index) => tickers.slice(index * 400, index * 400 + 400))
  for (const chunk of chunks) {
    if (chunk.length === 0) continue
    const placeholders = chunk.map(() => '?').join(',')
    const rows = await execAll<{ ticker: string; value: number }>(`
      SELECT ticker, value
      FROM (
        SELECT ticker, value,
               ROW_NUMBER() OVER (
                 PARTITION BY ticker
                 ORDER BY published_at DESC, period_end DESC, imported_at DESC, fact_id DESC
               ) AS rn
        FROM normalized_financial_facts
        WHERE metric = 'shares_outstanding'
          AND published_at < ?
          AND ticker IN (${placeholders})
      )
      WHERE rn = 1
    `, [nextUtcDate(asOf), ...chunk])
    for (const row of rows) {
      const value = asNumber(row.value)
      if (value != null) result.set(String(row.ticker), value)
    }
  }
  return result
}

async function loadServingMarketCaps(asOf: string, tickers: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>()
  const chunks = Array.from({ length: Math.ceil(tickers.length / 500) }, (_, index) => tickers.slice(index * 500, index * 500 + 500))
  for (const chunk of chunks) {
    if (chunk.length === 0) continue
    const placeholders = chunk.map(() => '?').join(',')
    const rows = await execAll<{ ticker: string; market_cap: number }>(`
      SELECT ticker, market_cap
      FROM stock_screening_serving
      WHERE as_of = ? AND ticker IN (${placeholders}) AND market_cap IS NOT NULL
    `, [asOf, ...chunk]).catch(() => [])
    for (const row of rows) {
      const value = asNumber(row.market_cap)
      if (value != null) result.set(String(row.ticker), value)
    }
  }
  return result
}

async function applyPitMarketCaps(rows: PeriodExplorerStockRow[], asOf: string): Promise<void> {
  const tickers = rows.map((row) => row.ticker)
  const marketCaps = await loadServingMarketCaps(asOf, tickers)
  const unresolved = tickers.filter((ticker) => !marketCaps.has(ticker))
  const shares = unresolved.length > 0 ? await loadPitShares(asOf, unresolved) : new Map<string, number>()
  for (const row of rows) {
    const marketCap = marketCaps.get(row.ticker)
    const shareCount = shares.get(row.ticker)
    if (marketCap == null && shareCount == null) continue
    row.marketCap = marketCap ?? row.endClose * shareCount!
    row.marketCapBasis = 'pit'
  }
}

function shortCalendarRange(from: string, to: string): boolean {
  const fromMs = Date.parse(`${from}T00:00:00Z`)
  const toMs = Date.parse(`${to}T00:00:00Z`)
  return Number.isFinite(fromMs) && Number.isFinite(toMs) && toMs - fromMs <= 180 * 86_400_000
}

function rangeStatsSelect(scope: RangeStatsScope): string {
  if (scope === 'price') {
    return `MAX(high) AS period_high, MIN(low) AS period_low,
            NULL AS avg_volume, NULL AS max_volume, NULL AS avg_turnover, NULL AS total_turnover`
  }
  if (scope === 'volume') {
    return `NULL AS period_high, NULL AS period_low,
            AVG(volume) AS avg_volume, MAX(volume) AS max_volume,
            NULL AS avg_turnover, NULL AS total_turnover`
  }
  if (scope === 'turnover') {
    return `NULL AS period_high, NULL AS period_low, NULL AS avg_volume, NULL AS max_volume,
            AVG(close * volume) AS avg_turnover, SUM(close * volume) AS total_turnover`
  }
  return `MAX(high) AS period_high, MIN(low) AS period_low,
          AVG(volume) AS avg_volume, MAX(volume) AS max_volume,
          AVG(close * volume) AS avg_turnover, SUM(close * volume) AS total_turnover`
}

async function loadRangeStats(
  from: string,
  to: string,
  tickers?: string[],
  scope: RangeStatsScope = 'full',
): Promise<Map<string, RangeDbRow>> {
  const result = new Map<string, RangeDbRow>()
  const chunks = tickers && tickers.length > 0
    ? Array.from({ length: Math.ceil(tickers.length / 400) }, (_, index) => tickers.slice(index * 400, index * 400 + 400))
    : [null]
  for (const chunk of chunks) {
    const tickerWhere = chunk ? `AND ticker IN (${chunk.map(() => '?').join(',')})` : ''
    // SQLiteは短期全銘柄集計でも(ticker,date)主キーのskip-scanを選ぶことがある。
    // 短期だけ(date,ticker)を指定し、長期や銘柄限定ではGROUP BYに有利な既定計画へ任せる。
    const indexHint = !chunk && shortCalendarRange(from, to) ? 'INDEXED BY ohlcv_date_ticker_idx' : ''
    const rows = await execAll<RangeDbRow>(`
      SELECT ticker, ${rangeStatsSelect(scope)}
      FROM ohlcv_daily ${indexHint}
      WHERE date BETWEEN ? AND ? ${tickerWhere}
      GROUP BY ticker
    `, [from, to, ...(chunk ?? [])])
    for (const row of rows) result.set(String(row.ticker), row)
  }
  return result
}

async function load52WeekStats(from: string, to: string, tickers?: string[]): Promise<Map<string, { high: number | null; low: number | null }>> {
  const range = await resolvePeriodExplorerDateRange(from, to)
  const dates = await getPeriodExplorerCalendar()
  const endIndex = dates.indexOf(range.adoptedTo)
  const start = dates[Math.max(0, endIndex - 249)]
  const result = new Map<string, { high: number | null; low: number | null }>()
  const chunks = tickers && tickers.length > 0
    ? Array.from({ length: Math.ceil(tickers.length / 400) }, (_, index) => tickers.slice(index * 400, index * 400 + 400))
    : [null]
  for (const chunk of chunks) {
    const tickerWhere = chunk ? `AND ticker IN (${chunk.map(() => '?').join(',')})` : ''
    const rows = await execAll<{ ticker: string; high_52: number | null; low_52: number | null }>(`
      SELECT ticker, MAX(high) AS high_52, MIN(low) AS low_52
      FROM ohlcv_daily
      WHERE date BETWEEN ? AND ? ${tickerWhere}
      GROUP BY ticker
    `, [start, range.adoptedTo, ...(chunk ?? [])])
    for (const row of rows) result.set(String(row.ticker), { high: asNumber(row.high_52), low: asNumber(row.low_52) })
  }
  return result
}

async function loadVolatilityStats(
  from: string,
  to: string,
  previousTradingDate: string | null,
  tickers?: string[],
): Promise<Map<string, VolatilityDbRow>> {
  const result = new Map<string, VolatilityDbRow>()
  const chunks = tickers && tickers.length > 0
    ? Array.from({ length: Math.ceil(tickers.length / 300) }, (_, index) => tickers.slice(index * 300, index * 300 + 300))
    : [null]
  for (const chunk of chunks) {
    const tickerWhere = chunk ? `AND ticker IN (${chunk.map(() => '?').join(',')})` : ''
    const calculationFrom = previousTradingDate ?? from
    const indexHint = !chunk && shortCalendarRange(calculationFrom, to) ? 'INDEXED BY ohlcv_date_ticker_idx' : ''
    const rows = await execAll<VolatilityDbRow>(`
      WITH ordered AS (
        SELECT ticker, date, open, high, low, close,
               LAG(close) OVER (PARTITION BY ticker ORDER BY date) AS previous_close,
               LAG(high) OVER (PARTITION BY ticker ORDER BY date) AS previous_high,
               LAG(low) OVER (PARTITION BY ticker ORDER BY date) AS previous_low
        FROM ohlcv_daily ${indexHint}
        WHERE date BETWEEN ? AND ? ${tickerWhere}
      ), returns AS (
        SELECT ticker, date, open, previous_high, previous_low,
               CASE WHEN previous_close > 0 THEN (close / previous_close - 1.0) * 100.0 ELSE NULL END AS daily_return
        FROM ordered
      )
      SELECT ticker, COUNT(daily_return) AS observations,
             SUM(daily_return) AS return_sum,
             SUM(daily_return * daily_return) AS return_sq_sum,
             SUM(CASE WHEN previous_high IS NOT NULL AND open > previous_high THEN 1 ELSE 0 END) AS gap_up_count,
             SUM(CASE WHEN previous_low IS NOT NULL AND open < previous_low THEN 1 ELSE 0 END) AS gap_down_count
      FROM returns
      WHERE date BETWEEN ? AND ?
      GROUP BY ticker
    `, [calculationFrom, to, ...(chunk ?? []), from, to])
    for (const row of rows) result.set(String(row.ticker), row)
  }
  return result
}

function rangeStatsScopeForQuery(
  ranking: PeriodExplorerRankingKey,
  requiresRangeStats: boolean,
  forceFull: boolean,
): RangeStatsScope | null {
  if (forceFull) return 'full'
  if (!requiresRangeStats) return null
  if (['max_rise', 'max_fall', 'drawdown_from_high', 'rebound_from_low', 'period_range'].includes(ranking)) return 'price'
  if (['avg_volume', 'max_volume', 'volume_increase'].includes(ranking)) return 'volume'
  if (['avg_turnover', 'total_turnover', 'turnover_increase'].includes(ranking)) return 'turnover'
  return 'full'
}

function applyRangeStats(row: PeriodExplorerStockRow, current: RangeDbRow | undefined, previous?: RangeDbRow): void {
  if (!current) return
  row.periodHigh = asNumber(current.period_high)
  row.periodLow = asNumber(current.period_low)
  row.avgVolume = asNumber(current.avg_volume)
  row.maxVolume = asNumber(current.max_volume)
  row.avgTurnover = asNumber(current.avg_turnover)
  row.totalTurnover = asNumber(current.total_turnover)
  const prices = calculatePeriodPriceMetrics({
    startClose: row.startClose,
    endClose: row.endClose,
    periodHigh: row.periodHigh,
    periodLow: row.periodLow,
  })
  Object.assign(row, prices)
  row.volumeIncreasePct = safeRatioPct(row.avgVolume, asNumber(previous?.avg_volume))
  row.turnoverIncreasePct = safeRatioPct(row.avgTurnover, asNumber(previous?.avg_turnover))
}

function apply52Week(row: PeriodExplorerStockRow, value: { high: number | null; low: number | null } | undefined): void {
  if (!value) return
  row.high52 = value.high
  row.low52 = value.low
  row.high52DistancePct = safeRatioPct(row.endClose, row.high52)
  row.low52DistancePct = safeRatioPct(row.endClose, row.low52)
}

function applyVolatility(row: PeriodExplorerStockRow, value: VolatilityDbRow | undefined): void {
  if (!value) return
  const observations = Number(value.observations ?? 0)
  const sum = asNumber(value.return_sum)
  const sumSquares = asNumber(value.return_sq_sum)
  if (observations > 1 && sum != null && sumSquares != null) {
    const variance = Math.max(0, (sumSquares - (sum * sum) / observations) / (observations - 1))
    row.realizedVolatilityPct = Math.sqrt(variance)
  }
  row.gapUpCount = asNumber(value.gap_up_count)
  row.gapDownCount = asNumber(value.gap_down_count)
}

function rankingValue(row: PeriodExplorerStockRow, ranking: PeriodExplorerRankingKey): number | null {
  switch (ranking) {
    case 'return_up': case 'return_down': return row.periodReturnPct
    case 'max_rise': return row.maxRisePct
    case 'max_fall': return row.maxFallPct
    case 'drawdown_from_high': return row.drawdownFromHighPct
    case 'rebound_from_low': return row.reboundFromLowPct
    case 'stage_improve': return row.stageSummary.validAxes > 0 ? row.stageSummary.improvingAxes : null
    case 'stage_deteriorate': return row.stageSummary.validAxes > 0 ? row.stageSummary.deterioratingAxes : null
    case 'stage_alignment': return row.stageSummary.validAxes > 0 ? row.stageSummary.alignedTimeframes : null
    case 'stage_twist_resolution': return row.stageSummary.validAxes > 0 ? row.stageSummary.resolvedTwists : null
    case 'ma25_deviation_high': case 'ma25_deviation_low': return row.ma25DeviationPct
    case 'ma75_deviation_high': case 'ma75_deviation_low': return row.ma75DeviationPct
    case 'ma_convergence': return row.maConvergencePct
    case 'ma_expansion': return row.maExpansionPct
    case 'golden_cross': return row.goldenCross ? row.ma25DeviationPct : null
    case 'dead_cross': return row.deadCross ? row.ma25DeviationPct : null
    case 'avg_volume': return row.avgVolume
    case 'max_volume': return row.maxVolume
    case 'volume_increase': return row.volumeIncreasePct
    case 'avg_turnover': return row.avgTurnover
    case 'total_turnover': return row.totalTurnover
    case 'turnover_increase': return row.turnoverIncreasePct
    case 'high_52_proximity': return row.high52DistancePct
    case 'low_52_proximity': return row.low52DistancePct
    case 'period_range': return row.periodRangePct
    case 'realized_volatility': return row.realizedVolatilityPct
    case 'gap_up_count': return row.gapUpCount
    case 'gap_down_count': return row.gapDownCount
    default: return null
  }
}

function inRange(value: number | null, min?: number | null, max?: number | null): boolean {
  if (min == null && max == null) return true
  if (value == null) return false
  if (min != null && value < min) return false
  if (max != null && value > max) return false
  return true
}

function matchesFilters(row: PeriodExplorerStockRow, filters: PeriodExplorerFilters): boolean {
  if (filters.markets?.length && (!row.marketSegment || !filters.markets.includes(row.marketSegment))) return false
  if (filters.sectors?.length && (!row.selectedSector || !filters.sectors.includes(row.selectedSector))) return false
  if (filters.marginTypes?.length && (!row.marginType || !filters.marginTypes.includes(row.marginType))) return false
  if ((filters.marketCapMin != null || filters.marketCapMax != null) && row.marketCapBasis !== 'pit') return false
  if (!inRange(row.marketCap, filters.marketCapMin, filters.marketCapMax)) return false
  if (!inRange(row.avgVolume, filters.avgVolumeMin, filters.avgVolumeMax)) return false
  if (!inRange(row.avgTurnover, filters.avgTurnoverMin, filters.avgTurnoverMax)) return false
  if (!inRange(row.endClose, filters.priceMin, filters.priceMax)) return false
  if (filters.ma25Position === 'above' && !(row.ma25DeviationPct != null && row.ma25DeviationPct > 0)) return false
  if (filters.ma25Position === 'below' && !(row.ma25DeviationPct != null && row.ma25DeviationPct < 0)) return false
  if (filters.ma75Position === 'above' && !(row.ma75DeviationPct != null && row.ma75DeviationPct > 0)) return false
  if (filters.ma75Position === 'below' && !(row.ma75DeviationPct != null && row.ma75DeviationPct < 0)) return false
  if (filters.high52WithinPct != null && !(row.high52DistancePct != null && row.high52DistancePct >= -filters.high52WithinPct)) return false
  if (filters.low52WithinPct != null && !(row.low52DistancePct != null && row.low52DistancePct <= filters.low52WithinPct)) return false
  if (filters.universe === 'nikkei225' && !NIKKEI225_SET.has(row.ticker)) return false
  for (const axis of PERIOD_EXPLORER_AXIS_KEYS) {
    const accepted = filters.stages?.[axis]
    if (accepted?.length && (row.endStages[axis] == null || !accepted.includes(row.endStages[axis]!))) return false
  }
  return true
}

function sortNumber(value: number | null, direction: 'asc' | 'desc'): number {
  if (value == null || !Number.isFinite(value)) return direction === 'asc' ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY
  return value
}

function rowSortValue(row: PeriodExplorerStockRow, sort: PeriodExplorerSortKey): number | string | null {
  if (sort === 'periodReturn') return row.periodReturnPct
  if (sort === 'price') return row.endClose
  if (sort === 'marketCap') return row.marketCap
  if (sort === 'avgTurnover') return row.avgTurnover
  if (sort === 'avgVolume') return row.avgVolume
  if (sort === 'ticker') return row.ticker
  return row.rankingValue
}

function compareRows(a: PeriodExplorerStockRow, b: PeriodExplorerStockRow, sort: PeriodExplorerSortKey, direction: 'asc' | 'desc'): number {
  const av = rowSortValue(a, sort)
  const bv = rowSortValue(b, sort)
  if (typeof av === 'string' || typeof bv === 'string') {
    return direction === 'asc' ? String(av ?? '').localeCompare(String(bv ?? '')) : String(bv ?? '').localeCompare(String(av ?? ''))
  }
  const delta = sortNumber(av, direction) - sortNumber(bv, direction)
  return (direction === 'asc' ? delta : -delta) || a.ticker.localeCompare(b.ticker)
}

function buildSectorRows(rows: PeriodExplorerStockRow[], ranking: PeriodExplorerRankingKey): PeriodExplorerSectorRow[] {
  const groups = new Map<string, PeriodExplorerStockRow[]>()
  for (const row of rows) {
    if (!row.selectedSector) continue
    const group = groups.get(row.selectedSector) ?? []
    group.push(row)
    groups.set(row.selectedSector, group)
  }
  const result = [...groups.entries()].map(([sector, members]): PeriodExplorerSectorRow => {
    const returns = members.map((member) => member.periodReturnPct).filter((value): value is number => value != null)
    const avgReturnPct = returns.length ? returns.reduce((sum, value) => sum + value, 0) / returns.length : null
    const medianReturnPct = median(returns)
    const advancingRatePct = returns.length ? returns.filter((value) => value > 0).length / returns.length * 100 : null
    const stageValid = members.filter((member) => member.stageSummary.validAxes > 0)
    const stageImproveRatePct = stageValid.length ? stageValid.filter((member) => member.stageSummary.improvingAxes > 0).length / stageValid.length * 100 : null
    const turnoverValues = members.map((member) => member.avgTurnover).filter((value): value is number => value != null)
    const volumeValues = members.map((member) => member.avgVolume).filter((value): value is number => value != null)
    const value = ranking === 'sector_median_return' ? medianReturnPct
      : ranking === 'sector_breadth' ? advancingRatePct
        : ranking === 'sector_stage_improve' ? stageImproveRatePct
          : avgReturnPct
    return {
      rowType: 'sector', rank: 0, sector, rankingValue: value, stocks: members.length,
      avgReturnPct, medianReturnPct, advancingRatePct, stageImproveRatePct,
      avgTurnover: turnoverValues.length ? turnoverValues.reduce((sum, item) => sum + item, 0) / turnoverValues.length : null,
      avgVolume: volumeValues.length ? volumeValues.reduce((sum, item) => sum + item, 0) / volumeValues.length : null,
    }
  })
  return result
}

function normalizedInput(input: PeriodExplorerInput): Required<Pick<PeriodExplorerInput, 'taxonomy' | 'filters' | 'sort' | 'direction' | 'limit' | 'offset'>> & { ranking: PeriodExplorerRankingKey; from: string | null; to: string | null } {
  const ranking = input.ranking && isPeriodExplorerRankingKey(input.ranking) ? input.ranking : 'return_up'
  const definition = PERIOD_EXPLORER_RANKING_MAP.get(ranking)!
  return {
    from: input.from ?? null,
    to: input.to ?? null,
    ranking,
    taxonomy: input.taxonomy ?? 'sector33',
    filters: input.filters ?? {},
    sort: input.sort ?? 'ranking',
    direction: input.direction ?? definition.defaultDirection,
    limit: Math.min(500, Math.max(1, Math.floor(input.limit ?? 50))),
    offset: Math.max(0, Math.floor(input.offset ?? 0)),
  }
}

export async function queryPeriodExplorer(input: PeriodExplorerInput = {}): Promise<PeriodExplorerResponse> {
  const startedAt = Date.now()
  const normalized = normalizedInput(input)
  const range = await resolvePeriodExplorerDateRange(normalized.from, normalized.to)
  const cacheKey = stableCacheKey({ version: CACHE_VERSION, normalized, range })
  const cached = await readServingCache<PeriodExplorerResponse>('period-explorer', cacheKey, RESPONSE_TTL_MS)
  if (cached) return { ...cached.payload, cacheHit: true, elapsedMs: Date.now() - startedAt }

  const definition = PERIOD_EXPLORER_RANKING_MAP.get(normalized.ranking)!
  const technicalFiltersActive = PERIOD_EXPLORER_AXIS_KEYS.some((axis) => Boolean(normalized.filters.stages?.[axis]?.length))
    || normalized.filters.ma25Position != null
    || normalized.filters.ma75Position != null
  const needAllTechnical = definition.category === 'technical'
    || normalized.ranking === 'sector_stage_improve'
    || technicalFiltersActive
  let rows = await loadBaseRows(range, normalized.taxonomy, needAllTechnical)
  const optionRows = rows
  const rangeFiltersActive = normalized.filters.avgVolumeMin != null || normalized.filters.avgVolumeMax != null
    || normalized.filters.avgTurnoverMin != null || normalized.filters.avgTurnoverMax != null
  const rangeSortActive = normalized.sort === 'avgVolume' || normalized.sort === 'avgTurnover'
  const forceFullRangeStats = Boolean(rangeFiltersActive || rangeSortActive || definition.resultKind === 'sectors')
  const rangeStatsScope = rangeStatsScopeForQuery(
    normalized.ranking,
    Boolean(definition.requiresRangeStats || definition.requiresPreviousRange),
    forceFullRangeStats,
  )
  const needAll52Week = Boolean(definition.requires52Week || normalized.filters.high52WithinPct != null || normalized.filters.low52WithinPct != null)
  const needAllPitShares = normalized.filters.marketCapMin != null || normalized.filters.marketCapMax != null || normalized.sort === 'marketCap'

  let currentStats = new Map<string, RangeDbRow>()
  let previousStats = new Map<string, RangeDbRow>()
  if (rangeStatsScope) {
    currentStats = await loadRangeStats(range.adoptedFrom, range.adoptedTo, undefined, rangeStatsScope)
    if (definition.requiresPreviousRange && range.previousFrom && range.previousTo) {
      previousStats = await loadRangeStats(range.previousFrom, range.previousTo, undefined, rangeStatsScope)
    }
    for (const row of rows) applyRangeStats(row, currentStats.get(row.ticker), previousStats.get(row.ticker))
  }
  if (needAll52Week) {
    const stats = await load52WeekStats(range.adoptedFrom, range.adoptedTo)
    for (const row of rows) apply52Week(row, stats.get(row.ticker))
  }
  if (definition.requiresVolatility) {
    const stats = await loadVolatilityStats(range.adoptedFrom, range.adoptedTo, range.previousTo)
    for (const row of rows) applyVolatility(row, stats.get(row.ticker))
  }
  if (needAllPitShares) {
    await applyPitMarketCaps(rows, range.adoptedTo)
  }

  let universeTotal = 0
  if (definition.resultKind === 'sectors') {
    universeTotal = buildSectorRows(rows, normalized.ranking)
      .filter((row) => row.rankingValue != null && Number.isFinite(row.rankingValue)).length
  } else {
    for (const row of rows) row.rankingValue = rankingValue(row, normalized.ranking)
    universeTotal = rows.filter((row) => row.rankingValue != null && Number.isFinite(row.rankingValue)).length
  }

  rows = rows.filter((row) => matchesFilters(row, normalized.filters))
  const matchedFilterCount = rows.length
  let missingRankingValue = 0
  if (definition.resultKind !== 'sectors') {
    for (const row of rows) row.rankingValue = rankingValue(row, normalized.ranking)
    missingRankingValue = rows.filter((row) => row.rankingValue == null || !Number.isFinite(row.rankingValue)).length
    rows = rows.filter((row) => row.rankingValue != null && Number.isFinite(row.rankingValue))
  }

  const eligible = await execGet<{ count: number }>(`
    SELECT COUNT(*) AS count FROM historical_universe
    WHERE first_trade_date <= ? AND last_trade_date >= ?
  `, [range.adoptedTo, range.adoptedFrom])
  const missingEndpoints = Math.max(0, Number(eligible?.count ?? rows.length) - optionRows.length)

  let responseRows: Array<PeriodExplorerStockRow | PeriodExplorerSectorRow>
  let total: number
  if (definition.resultKind === 'sectors') {
    const allSectorRows = buildSectorRows(rows, normalized.ranking)
    missingRankingValue = allSectorRows.filter((row) => row.rankingValue == null || !Number.isFinite(row.rankingValue)).length
    const sectorRows = allSectorRows
      .filter((row) => row.rankingValue != null && Number.isFinite(row.rankingValue))
      .sort((a, b) => {
        const av = sortNumber(a.rankingValue, normalized.direction)
        const bv = sortNumber(b.rankingValue, normalized.direction)
        return (normalized.direction === 'asc' ? av - bv : bv - av) || a.sector.localeCompare(b.sector, 'ja')
      })
    total = sectorRows.length
    responseRows = sectorRows.slice(normalized.offset, normalized.offset + normalized.limit)
    responseRows.forEach((row, index) => { row.rank = normalized.offset + index + 1 })
  } else {
    rows.sort((a, b) => compareRows(a, b, normalized.sort, normalized.direction))
    total = rows.length
    const pageRows = rows.slice(normalized.offset, normalized.offset + normalized.limit)
    if (!needAllTechnical && pageRows.length > 0) {
      const technical = await loadTechnicalRows(range, pageRows.map((row) => row.ticker))
      for (const row of pageRows) applyTechnicalData(row, technical.get(row.ticker))
    }
    if (!needAllPitShares && pageRows.length > 0) {
      await applyPitMarketCaps(pageRows, range.adoptedTo)
    }
    if (rangeStatsScope !== 'full' && pageRows.length > 0) {
      currentStats = await loadRangeStats(range.adoptedFrom, range.adoptedTo, pageRows.map((row) => row.ticker))
      for (const row of pageRows) applyRangeStats(row, currentStats.get(row.ticker), previousStats.get(row.ticker))
    }
    responseRows = pageRows
    responseRows.forEach((row, index) => { row.rank = normalized.offset + index + 1 })
  }

  const response: PeriodExplorerResponse = {
    success: true,
    ranking: normalized.ranking,
    rankingLabel: definition.label,
    rankingDescription: definition.description,
    rankingUnit: definition.unit,
    resultKind: definition.resultKind ?? 'stocks',
    taxonomy: normalized.taxonomy,
    range,
    rows: responseRows,
    total,
    universeTotal,
    limit: normalized.limit,
    offset: normalized.offset,
    excluded: {
      missingEndpoints,
      missingRankingValue,
      filteredOut: Math.max(0, optionRows.length - matchedFilterCount),
    },
    options: {
      markets: countOptions(optionRows.map((row) => row.marketSegment)),
      sectors: countOptions(optionRows.map((row) => selectedSector(row, normalized.taxonomy))),
      marginTypes: countOptions(optionRows.map((row) => row.marginType)),
    },
    dataBasis: {
      prices: 'adjusted_ohlcv', stages: 'daily_snapshot_pit', shares: 'pit_with_current_fallback',
      classifications: 'current', market: 'current', marginType: 'current',
    },
    cacheHit: false,
    elapsedMs: Date.now() - startedAt,
  }
  await writeServingCache('period-explorer', cacheKey, response, RESPONSE_TTL_MS).catch(() => undefined)
  return response
}
