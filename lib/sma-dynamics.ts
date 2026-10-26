// Deterministic SMA dynamics: actual rolling SMAs up to an anchor session and a
// "price freeze" path where every future close equals the anchor close.
// Independent from the retired ML trajectory code; no slope extrapolation.
import type { OHLCV } from '@/types/stock'
import { smaAt } from '@/lib/timeframes'
import { getNextJpTradingDate } from '@/lib/server/jp-market-calendar'
import { getNextUsTradingDate } from '@/lib/server/us-data-freshness'

export type SmaDynamicsMarket = 'JP' | 'US'

export const SMA_DYNAMICS_PERIODS = [5, 25, 75, 150, 200, 300] as const
export type SmaDynamicsPeriod = (typeof SMA_DYNAMICS_PERIODS)[number]

export const SMA_DYNAMICS_WINDOWS = [
  { id: '1m', label: '1ヶ月', sessions: 21 },
  { id: '3m', label: '3ヶ月', sessions: 63 },
  { id: '6m', label: '6ヶ月', sessions: 126 },
] as const
export type SmaDynamicsWindowId = (typeof SMA_DYNAMICS_WINDOWS)[number]['id']
export const SMA_DYNAMICS_DEFAULT_WINDOW: SmaDynamicsWindowId = '3m'

export const SMA_DYNAMICS_HORIZONS = [5, 10, 20, 60] as const
export type SmaDynamicsHorizon = (typeof SMA_DYNAMICS_HORIZONS)[number]
export const SMA_DYNAMICS_DEFAULT_HORIZON: SmaDynamicsHorizon = 20

const MAX_HORIZON = 260
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** Structural input so API rows (OHLCV) and fixtures can be passed without coercion. */
export interface SmaDynamicsRawRow {
  date?: unknown
  close?: unknown
}

export type SmaDataIssue =
  | { kind: 'invalid_date'; date: string }
  | { kind: 'duplicate_date'; date: string; count: number }
  | { kind: 'invalid_close'; date: string; value: string }
  | { kind: 'non_positive_close'; date: string; value: string }

/** One position per unique session date. close is null when the row cannot be trusted. */
export interface SmaSeriesPoint {
  date: string
  close: number | null
}

export interface NormalizedSmaHistory {
  series: SmaSeriesPoint[]
  issues: SmaDataIssue[]
  /** Rows dropped because their date is after the PIT boundary. Never displayed. */
  excludedAfterBoundary: number
}

export type SmaValues = Record<SmaDynamicsPeriod, number | null>

export interface SmaHistoricalPoint {
  date: string
  /** Session offset from the anchor (anchor = 0, earlier sessions negative). */
  offset: number
  close: number | null
  sma: SmaValues
}

export interface SmaProjectedPoint {
  date: string
  /** T+k session count after the anchor. */
  k: number
  close: number
  sma: SmaValues
}

export type SmaPeriodStatus = 'ok' | 'insufficient_history' | 'invalid_window'

export interface SmaPeriodSummary {
  period: SmaDynamicsPeriod
  status: SmaPeriodStatus
  /** Sessions required at the anchor. Equal to period. */
  required: number
  /** Sessions present up to and including the anchor (after the PIT cut). */
  available: number
  /** Exact number of missing sessions; 0 unless status is insufficient_history. */
  shortfall: number
  /** Dates inside the anchor window whose close is unusable. */
  invalidDatesInWindow: string[]
  anchorValue: number | null
  /** (anchor close - SMA) / SMA * 100 */
  closeGapPct: number | null
  endValue: number | null
  endChange: number | null
  endChangePct: number | null
}

export type SmaDynamicsUnavailableReason =
  | 'invalid_analysis_date'
  | 'no_rows'
  | 'no_rows_before_boundary'
  | 'anchor_invalid'
  | 'calendar_unresolved'

interface SmaDynamicsBase {
  market: SmaDynamicsMarket
  analysisBoundary: string | null
  windowSessions: number
  horizon: number
  issues: SmaDataIssue[]
  excludedAfterBoundary: number
}

export interface SmaDynamicsAvailable extends SmaDynamicsBase {
  status: 'available'
  anchor: { date: string; close: number; index: number }
  historical: SmaHistoricalPoint[]
  projected: SmaProjectedPoint[]
  periods: SmaPeriodSummary[]
}

export interface SmaDynamicsUnavailable extends SmaDynamicsBase {
  status: 'unavailable'
  reason: SmaDynamicsUnavailableReason
  /** Present when the latest PIT row exists but is unusable. */
  anchorDate: string | null
}

export type SmaDynamicsResult = SmaDynamicsAvailable | SmaDynamicsUnavailable

export interface ComputeSmaDynamicsInput {
  rows: ReadonlyArray<SmaDynamicsRawRow>
  market: SmaDynamicsMarket
  analysisDate?: string | null
  windowSessions?: number
  horizon?: number
}

export function isIsoCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

function describeRaw(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value.length > 32 ? `${value.slice(0, 32)}...` : value)
  if (typeof value === 'number') return String(value)
  if (value === null) return 'null'
  return typeof value
}

function compareAscii(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Sorts ascending and applies the PIT cut before anything else. Duplicate dates
 * and unusable closes keep their session slot with close = null, so any SMA
 * window touching them is null instead of silently bridging the gap.
 */
export function normalizeSmaHistory(
  rows: ReadonlyArray<SmaDynamicsRawRow>,
  boundary: string | null,
): NormalizedSmaHistory {
  const issues: SmaDataIssue[] = []
  const byDate = new Map<string, unknown[]>()
  let excludedAfterBoundary = 0

  for (const row of rows) {
    const date = row?.date
    if (!isIsoCalendarDate(date)) {
      issues.push({ kind: 'invalid_date', date: describeRaw(date) })
      continue
    }
    if (boundary != null && date > boundary) {
      excludedAfterBoundary += 1
      continue
    }
    const closes = byDate.get(date)
    if (closes) closes.push(row.close)
    else byDate.set(date, [row.close])
  }

  const series: SmaSeriesPoint[] = []
  for (const date of [...byDate.keys()].sort(compareAscii)) {
    const closes = byDate.get(date) ?? []
    if (closes.length > 1) {
      issues.push({ kind: 'duplicate_date', date, count: closes.length })
      series.push({ date, close: null })
      continue
    }
    const close = closes[0]
    if (typeof close !== 'number' || !Number.isFinite(close)) {
      issues.push({ kind: 'invalid_close', date, value: describeRaw(close) })
      series.push({ date, close: null })
    } else if (close <= 0) {
      issues.push({ kind: 'non_positive_close', date, value: String(close) })
      series.push({ date, close: null })
    } else {
      series.push({ date, close })
    }
  }

  issues.sort((a, b) => compareAscii(a.date, b.date) || compareAscii(a.kind, b.kind))
  return { series, issues, excludedAfterBoundary }
}

/** Next `count` sessions after `anchorDate` using the existing market calendars. */
export function futureSessionDates(market: SmaDynamicsMarket, anchorDate: string, count: number): string[] | null {
  const next = market === 'US' ? getNextUsTradingDate : getNextJpTradingDate
  const dates: string[] = []
  let cursor = anchorDate
  for (let k = 0; k < count; k += 1) {
    const candidate = next(cursor)
    if (!candidate) return null
    dates.push(candidate)
    cursor = candidate
  }
  return dates
}

function toCloseRows(closes: ReadonlyArray<number | null>): OHLCV[] {
  // smaAt only reads close; NaN marks an unusable slot so the window returns null.
  return closes.map((close, index) => {
    const value = close ?? Number.NaN
    return { date: String(index), open: value, high: value, low: value, close: value, volume: 0 }
  })
}

function emptySmaValues(): SmaValues {
  return { 5: null, 25: null, 75: null, 150: null, 200: null, 300: null }
}

function assertPositiveInteger(name: string, value: number, max: number) {
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new RangeError(`${name} must be an integer in 1..${max}: ${value}`)
  }
}

export function computeSmaDynamics(input: ComputeSmaDynamicsInput): SmaDynamicsResult {
  const windowSessions = input.windowSessions ?? windowSessionsFor(SMA_DYNAMICS_DEFAULT_WINDOW)
  const horizon = input.horizon ?? SMA_DYNAMICS_DEFAULT_HORIZON
  assertPositiveInteger('windowSessions', windowSessions, 1000)
  assertPositiveInteger('horizon', horizon, MAX_HORIZON)

  const analysisBoundary = input.analysisDate ?? null
  const base = { market: input.market, analysisBoundary, windowSessions, horizon }

  if (analysisBoundary != null && !isIsoCalendarDate(analysisBoundary)) {
    return { ...base, status: 'unavailable', reason: 'invalid_analysis_date', anchorDate: null, issues: [], excludedAfterBoundary: 0 }
  }

  const { series, issues, excludedAfterBoundary } = normalizeSmaHistory(input.rows, analysisBoundary)
  const shared = { ...base, issues, excludedAfterBoundary }

  if (series.length === 0) {
    return { ...shared, status: 'unavailable', reason: input.rows.length === 0 ? 'no_rows' : 'no_rows_before_boundary', anchorDate: null }
  }

  const anchorIndex = series.length - 1
  const anchorPoint = series[anchorIndex]
  const fixedClose = anchorPoint.close
  if (fixedClose == null) {
    return { ...shared, status: 'unavailable', reason: 'anchor_invalid', anchorDate: anchorPoint.date }
  }

  const futureDates = futureSessionDates(input.market, anchorPoint.date, horizon)
  if (!futureDates) {
    return { ...shared, status: 'unavailable', reason: 'calendar_unresolved', anchorDate: anchorPoint.date }
  }

  // Full PIT history followed by the frozen closes; SMAs are recomputed on the real rolling window.
  const closeRows = toCloseRows([...series.map((point) => point.close), ...futureDates.map(() => fixedClose)])

  const anchorSma = emptySmaValues()
  for (const period of SMA_DYNAMICS_PERIODS) anchorSma[period] = smaAt(closeRows, period, anchorIndex)

  const historical: SmaHistoricalPoint[] = []
  for (let index = Math.max(0, anchorIndex - windowSessions + 1); index <= anchorIndex; index += 1) {
    const sma = emptySmaValues()
    for (const period of SMA_DYNAMICS_PERIODS) sma[period] = smaAt(closeRows, period, index)
    historical.push({ date: series[index].date, offset: index - anchorIndex, close: series[index].close, sma })
  }

  const projected = futureDates.map((date, offset): SmaProjectedPoint => {
    const k = offset + 1
    const sma = emptySmaValues()
    for (const period of SMA_DYNAMICS_PERIODS) {
      // Only continue lines that have a real anchor value; short history is never padded with frozen closes.
      sma[period] = anchorSma[period] == null ? null : smaAt(closeRows, period, anchorIndex + k)
    }
    return { date, k, close: fixedClose, sma }
  })

  const available = anchorIndex + 1
  const periods = SMA_DYNAMICS_PERIODS.map((period): SmaPeriodSummary => {
    const shortfall = Math.max(0, period - available)
    const anchorValue = anchorSma[period]
    const invalidDatesInWindow = shortfall > 0
      ? []
      : series.slice(anchorIndex - period + 1, anchorIndex + 1).filter((point) => point.close == null).map((point) => point.date)
    const endValue = projected.at(-1)?.sma[period] ?? null
    const endChange = anchorValue != null && endValue != null ? endValue - anchorValue : null
    return {
      period,
      status: shortfall > 0 ? 'insufficient_history' : anchorValue == null ? 'invalid_window' : 'ok',
      required: period,
      available,
      shortfall,
      invalidDatesInWindow,
      anchorValue,
      closeGapPct: anchorValue != null ? ((fixedClose - anchorValue) / anchorValue) * 100 : null,
      endValue,
      endChange,
      endChangePct: endChange != null && anchorValue != null ? (endChange / anchorValue) * 100 : null,
    }
  })

  return {
    ...shared,
    status: 'available',
    anchor: { date: anchorPoint.date, close: fixedClose, index: anchorIndex },
    historical,
    projected,
    periods,
  }
}

export function windowSessionsFor(id: SmaDynamicsWindowId): number {
  return SMA_DYNAMICS_WINDOWS.find((item) => item.id === id)?.sessions ?? 63
}

export function describeSmaDataIssue(issue: SmaDataIssue): string {
  switch (issue.kind) {
    case 'invalid_date':
      return `日付を解釈できない行 (${issue.date})`
    case 'duplicate_date':
      return `${issue.date} が ${issue.count} 行重複`
    case 'invalid_close':
      return `${issue.date} の終値が数値ではありません (${issue.value})`
    case 'non_positive_close':
      return `${issue.date} の終値が 0 以下です (${issue.value})`
  }
}

export function describeSmaUnavailable(reason: SmaDynamicsUnavailableReason, anchorDate: string | null): string {
  switch (reason) {
    case 'invalid_analysis_date':
      return '基準日の形式が正しくないため計算できません。'
    case 'no_rows':
      return '価格履歴がないため計算できません。'
    case 'no_rows_before_boundary':
      return '基準日以前の有効な価格履歴がないため計算できません。'
    case 'anchor_invalid':
      return `基準日の終値 (${anchorDate ?? '日付不明'}) が使用できないため計算できません。`
    case 'calendar_unresolved':
      return '基準日以降の営業日を市場カレンダーから決定できませんでした。'
  }
}
