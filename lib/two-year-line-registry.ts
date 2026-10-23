import type { OHLCV } from '@/types/stock'
import {
  aggregateTwentyFourMonthCandles,
  detectRisingCloseLines,
  standardizedRisingCloseAngleDeg,
  type RisingCloseLine,
  type RisingClosePattern,
  type TwoYearCandle,
  type TwoYearMarket,
} from '@/lib/two-year-candles'

export const TWO_YEAR_LINE_FILTERS = ['none', 'confirmed', 'provisional', 'either'] as const
export const TWO_YEAR_LINE_PATTERNS = ['either', 'three', 'four'] as const

export type TwoYearLineFilter = (typeof TWO_YEAR_LINE_FILTERS)[number]
export type TwoYearLinePatternFilter = (typeof TWO_YEAR_LINE_PATTERNS)[number]
export type TwoYearRegistryAvailability = 'available' | 'calendar_unavailable' | 'history_unavailable'

export interface TwoYearLineQuery {
  status: TwoYearLineFilter
  pattern: TwoYearLinePatternFilter
  minAngleDeg: number | null
  maxAngleDeg: number | null
}

export interface TwoYearLineSummary {
  lineId: string
  pattern: RisingClosePattern
  status: RisingCloseLine['status']
  sourcePeriods: RisingCloseLine['sourcePeriods']
  lineStartClose: number
  lineEndClose: number
  lastCandleOpen: number
  lastCandleClose: number
  lastCandleRisePct: number
  angleDeg: number
  anchorDates: readonly [string, string]
  linePriceAsOf: number | null
  currentConfirmedClose: number | null
  distancePct: number | null
}

export interface TwoYearLineRegistry {
  market: TwoYearMarket
  securityKey: string
  asOfDate: string
  priceBasisVersion: string
  availability: TwoYearRegistryAvailability
  candles: readonly TwoYearCandle[]
  lines: readonly RisingCloseLine[]
  latest: TwoYearLineSummary | null
  latestConfirmed: TwoYearLineSummary | null
  latestProvisional: TwoYearLineSummary | null
}

export function buildTwoYearLineRegistry(options: Readonly<{
  market: TwoYearMarket
  securityKey: string
  asOfDate: string
  priceBasisVersion: string
  history: readonly OHLCV[]
  exchangeSessions: readonly string[]
}>): TwoYearLineRegistry {
  const availability: TwoYearRegistryAvailability = options.history.length === 0
    ? 'history_unavailable'
    : options.exchangeSessions.length === 0
      ? 'calendar_unavailable'
      : 'available'
  const candles = availability === 'history_unavailable'
    ? []
    : aggregateTwentyFourMonthCandles(options.history, {
        market: options.market,
        asOfDate: options.asOfDate,
        exchangeSessions: options.exchangeSessions,
      })
  const lines = availability === 'available' ? detectRisingCloseLines(candles) : []
  const summaries = lines
    .map((line) => summarizeTwoYearLine(line, candles, options.asOfDate))
    .filter((summary): summary is TwoYearLineSummary => summary !== null)
  const latestConfirmed = summaries.find((summary) => summary.status === 'confirmed') ?? null
  const latestProvisional = summaries.find((summary) => summary.status === 'provisional') ?? null
  return {
    market: options.market,
    securityKey: options.securityKey,
    asOfDate: options.asOfDate,
    priceBasisVersion: options.priceBasisVersion,
    availability,
    candles,
    lines,
    latest: latestProvisional ?? latestConfirmed,
    latestConfirmed,
    latestProvisional,
  }
}

export function summarizeTwoYearLine(
  line: RisingCloseLine,
  candles: readonly TwoYearCandle[],
  asOfDate: string,
): TwoYearLineSummary | null {
  const endpoint = candles.find((candle) => candle.startYear === line.endpointStartYear)
  const angleDeg = standardizedRisingCloseAngleDeg(line)
  if (!endpoint || endpoint.open <= 0 || angleDeg === null) return null
  const current = candles.find((candle) => candle.status === 'forming') ?? null
  const currentConfirmedClose = current?.lastSourceDate === asOfDate && current.close > 0 ? current.close : null
  const linePriceAsOf = line.status === 'confirmed'
    ? evaluateRisingCloseLineAtDate(line, asOfDate)
    : null
  const distancePct = currentConfirmedClose !== null && linePriceAsOf !== null && linePriceAsOf > 0
    ? ((currentConfirmedClose - linePriceAsOf) / linePriceAsOf) * 100
    : null
  return {
    lineId: line.id,
    pattern: line.pattern,
    status: line.status,
    sourcePeriods: line.sourcePeriods,
    lineStartClose: line.points[0].value,
    lineEndClose: line.points[1].value,
    lastCandleOpen: endpoint.open,
    lastCandleClose: endpoint.close,
    lastCandleRisePct: ((endpoint.close / endpoint.open) - 1) * 100,
    angleDeg,
    anchorDates: [line.points[0].date, line.points[1].date],
    linePriceAsOf,
    currentConfirmedClose,
    distancePct,
  }
}

export function parseTwoYearLineFilter(value: string | null | undefined): TwoYearLineFilter {
  return TWO_YEAR_LINE_FILTERS.includes(value as TwoYearLineFilter)
    ? value as TwoYearLineFilter
    : 'none'
}

export function parseTwoYearLinePatternFilter(value: string | null | undefined): TwoYearLinePatternFilter {
  return TWO_YEAR_LINE_PATTERNS.includes(value as TwoYearLinePatternFilter)
    ? value as TwoYearLinePatternFilter
    : 'either'
}

export function matchesTwoYearLineQuery(
  summaries: readonly TwoYearLineSummary[],
  query: TwoYearLineQuery,
): boolean {
  if (query.status === 'none') return true
  return summaries.some((summary) => summaryMatchesQuery(summary, query))
}

export function selectTwoYearLineSummaryForQuery(
  summaries: readonly TwoYearLineSummary[],
  query: TwoYearLineQuery,
): TwoYearLineSummary | null {
  if (query.status === 'none') return null
  const matches = summaries.filter((summary) => summaryMatchesQuery(summary, query))
  return matches.find((summary) => summary.status === 'provisional')
    ?? matches.find((summary) => summary.status === 'confirmed')
    ?? null
}

export function twoYearConfirmedDistancePriority(distancePct: number | null): number | null {
  if (distancePct === null || !Number.isFinite(distancePct)) return null
  return distancePct <= 0
    ? 1_000_000 - Math.abs(distancePct)
    : -1_000_000 - distancePct
}

export function matchesTwoYearLineFilter(
  registry: Pick<TwoYearLineRegistry, 'availability' | 'lines'>,
  filter: TwoYearLineFilter,
): boolean {
  if (filter === 'none') return true
  if (registry.availability !== 'available') return false
  if (filter === 'either') return registry.lines.length > 0
  return registry.lines.some((line) => line.status === filter)
}

function summaryMatchesQuery(summary: TwoYearLineSummary, query: TwoYearLineQuery): boolean {
  if (query.status !== 'either' && summary.status !== query.status) return false
  if (query.pattern !== 'either' && summary.pattern !== query.pattern) return false
  if (query.minAngleDeg !== null && summary.angleDeg < query.minAngleDeg) return false
  if (query.maxAngleDeg !== null && summary.angleDeg > query.maxAngleDeg) return false
  return true
}

export function evaluateRisingCloseLineAtDate(line: RisingCloseLine, date: string): number | null {
  const [start, end] = line.points
  const startTime = parseDate(start.date)
  const endTime = parseDate(end.date)
  const targetTime = parseDate(date)
  if (targetTime < startTime || endTime <= startTime) return null
  const value = start.value + ((end.value - start.value) * (targetTime - startTime)) / (endTime - startTime)
  return Number.isFinite(value) && value > 0 ? value : null
}

export function projectRisingCloseLineToDates(
  line: RisingCloseLine,
  dates: readonly string[],
): Array<{ time: string; value: number }> {
  return [...new Set([...dates, line.points[0].date, line.points[1].date])]
    .sort()
    .map((time) => ({ time, value: evaluateRisingCloseLineAtDate(line, time) }))
    .filter((point): point is { time: string; value: number } => point.value !== null)
}

function parseDate(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('invalid_two_year_line_date')
  const parsed = Date.parse(`${value}T00:00:00Z`)
  if (!Number.isFinite(parsed)) throw new Error('invalid_two_year_line_date')
  return parsed
}
