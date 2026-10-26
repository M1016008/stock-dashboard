// SMA Dynamics Lab: timeframe-linked SMAs and the Price Freeze projection.
//
// "SMA N" always means the mean of the last N confirmed closes of the selected bar
// (1D … 3M). Display range and zoom never enter the computation: everything here is
// derived from the full PIT history, and the view only chooses which slots to show.
//
// The projection takes an explicit future close path (Price Freeze = the as-of
// close repeated), so Phase 2 scenarios / inverse solving can reuse the same math.
import type { OHLCV } from '@/types/stock'
import { smaAt } from '@/lib/timeframes'
import { isIsoCalendarDate, SMA_DYNAMICS_PERIODS, type SmaDynamicsMarket } from '@/lib/sma-dynamics'
import {
  addCalendarDays,
  addCalendarMonths,
  aggregateSmaLabBars,
  futureBuckets,
  missingSessionIssues,
  normalizeSmaLabHistory,
  sessionsBetween,
  smaLabCalendar,
  smaLabTimeframe,
  type SmaLabBar,
  type SmaLabCalendar,
  type SmaLabDataIssue,
  type SmaLabRawRow,
  type SmaLabTimeframeId,
} from '@/lib/sma-dynamics-timeframes'

/** Preset SMA periods, always computed. Any integer in SMA_LAB_MIN_PERIOD..SMA_LAB_MAX_PERIOD can be added. */
export const SMA_LAB_PERIODS = [3, 5, 10, 13, 25, 50, 75, 100, 150, 200, 300] as const
export type SmaLabPeriod = number
export const SMA_LAB_MIN_PERIOD = 3
export const SMA_LAB_MAX_PERIOD = 300
/** Lines drawn at once (presets and custom periods together); keeps the chart and tables legible. */
export const SMA_LAB_MAX_SELECTED_PERIODS = 12
/** Shown on first open; everything else is one click away. */
export const SMA_LAB_DEFAULT_PERIODS: readonly SmaLabPeriod[] = [5, 25, 75]
/** Phase 1 set; must stay selectable. */
export const SMA_LAB_PHASE1_PERIODS: readonly SmaLabPeriod[] = SMA_DYNAMICS_PERIODS

export function isSmaLabPeriod(value: unknown): value is SmaLabPeriod {
  return typeof value === 'number' && Number.isInteger(value) && value >= SMA_LAB_MIN_PERIOD && value <= SMA_LAB_MAX_PERIOD
}

/** Valid integer periods, unique and ascending. Anything else is dropped (never rounded). */
export function normalizeSmaLabPeriods(values: Iterable<unknown>): SmaLabPeriod[] {
  const out = new Set<number>()
  for (const value of values) if (isSmaLabPeriod(value)) out.add(value)
  return [...out].sort((a, b) => a - b)
}

export interface ParsedPeriodText {
  periods: SmaLabPeriod[]
  /** Tokens that were not an integer in range, as typed. */
  rejected: string[]
}

/** "7, 20 21、120" -> [7, 20, 21, 120]. Half/full-width digits; commas, spaces and 、 separate. */
export function parseSmaLabPeriodText(text: string): ParsedPeriodText {
  const normalized = text.replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
  const tokens = normalized.split(/[\s,、，]+/).filter((token) => token !== '')
  const periods: number[] = []
  const rejected: string[] = []
  for (const token of tokens) {
    const value = /^\d+$/.test(token) ? Number(token) : Number.NaN
    if (isSmaLabPeriod(value)) periods.push(value)
    else rejected.push(token)
  }
  return { periods: normalizeSmaLabPeriods(periods), rejected }
}

export interface AddedPeriods {
  /** Selection after the add (ascending, at most SMA_LAB_MAX_SELECTED_PERIODS). */
  periods: SmaLabPeriod[]
  /** Newly selected periods. */
  added: SmaLabPeriod[]
  /** Typed tokens that are not an integer in 3..300. */
  rejected: string[]
  /** Valid periods left out because the selection is full. */
  overflow: SmaLabPeriod[]
}

/** Adds typed periods to the current selection without ever exceeding the line limit. */
export function addSmaLabPeriodsFromText(selected: ReadonlyArray<SmaLabPeriod>, text: string): AddedPeriods {
  const parsed = parseSmaLabPeriodText(text)
  const current = normalizeSmaLabPeriods(selected)
  const next = new Set(current)
  const added: number[] = []
  const overflow: number[] = []
  for (const period of parsed.periods) {
    if (next.has(period)) continue
    if (next.size >= SMA_LAB_MAX_SELECTED_PERIODS) overflow.push(period)
    else { next.add(period); added.push(period) }
  }
  return { periods: [...next].sort((a, b) => a - b), added, rejected: parsed.rejected, overflow }
}

/**
 * Lab-owned palette. Existing shared-chart colors stay unchanged; the Lab gives
 * long periods such as 150/300 stable colors without changing legacy charts.
 */
export const SMA_LAB_COLORS: Record<number, string> = {
  3: '#ec4899',
  5: '#dc2626',
  10: '#ca8a04',
  13: '#a21caf',
  25: '#2563eb',
  50: '#57534e',
  75: '#16a34a',
  100: '#92400e',
  150: '#7c3aed',
  200: '#f97316',
  300: '#0e7490',
}

/** Preset color, or a stable hue derived from the period for custom ones (same period, same color). */
export function smaLabColor(period: number): string {
  return SMA_LAB_COLORS[period] ?? `hsl(${Math.round((period * 137.508) % 360)} 62% 38%)`
}

/** Quick (always visible) horizons on every timeframe; any integer in 1..SMA_LAB_SOLVER_MAX_BARS is also selectable. */
export const SMA_LAB_HORIZON_BARS = [1, 3, 5, 10, 20] as const
export const SMA_LAB_SOLVER_MAX_BARS = 20
/** Phase 1 daily horizons (sessions) kept for 1D. */
export const SMA_LAB_DAILY_HORIZONS = [5, 10, 20, 60] as const
export const SMA_LAB_MAX_HORIZON = 60

/**
 * Longest span the calendar supports with margin: long bars (5Y, 3Y) cannot project 20 bars
 * ahead without leaving the supported date range.
 */
export const SMA_LAB_MAX_FUTURE_YEARS = 40

/** Largest horizon (in bars) a timeframe can project; at most SMA_LAB_SOLVER_MAX_BARS. */
export function smaLabMaxHorizonBars(timeframe: SmaLabTimeframeId): number {
  const spec = smaLabTimeframe(timeframe).spec
  if (spec.unit !== 'month') return SMA_LAB_SOLVER_MAX_BARS
  return Math.max(1, Math.min(SMA_LAB_SOLVER_MAX_BARS, Math.floor((SMA_LAB_MAX_FUTURE_YEARS * 12) / spec.count)))
}

export function smaLabHorizonOptions(timeframe: SmaLabTimeframeId): number[] {
  const arbitrary = Array.from({ length: smaLabMaxHorizonBars(timeframe) }, (_, i) => i + 1)
  return timeframe === '1D'
    ? [...new Set<number>([...arbitrary, ...SMA_LAB_DAILY_HORIZONS])].sort((a, b) => a - b)
    : arbitrary
}

export function smaLabDefaultHorizon(timeframe: SmaLabTimeframeId): number {
  return timeframe === '1D' ? 20 : Math.min(5, smaLabMaxHorizonBars(timeframe))
}

export const SMA_LAB_RANGES = [
  { id: '1w', label: '1週間', amount: 7, unit: 'day' },
  { id: '2w', label: '2週間', amount: 14, unit: 'day' },
  { id: '1m', label: '1か月', amount: 1, unit: 'month' },
  { id: '3m', label: '3か月', amount: 3, unit: 'month' },
  { id: '6m', label: '6か月', amount: 6, unit: 'month' },
  { id: '1y', label: '1年', amount: 12, unit: 'month' },
  { id: '3y', label: '3年', amount: 36, unit: 'month' },
  { id: 'all', label: '全期間', amount: 0, unit: 'all' },
] as const
export type SmaLabRangeId = (typeof SMA_LAB_RANGES)[number]['id']
export const SMA_LAB_DEFAULT_RANGE: SmaLabRangeId = '6m'
/** Below this many bars in the display range the UI says so (it never changes the timeframe). */
export const SMA_LAB_FEW_BARS = 5

export type SmaLabFocus = 'both' | 'past' | 'future'
export const SMA_LAB_FOCUS_OPTIONS: ReadonlyArray<{ id: SmaLabFocus; label: string }> = [
  { id: 'both', label: '過去＋将来' },
  { id: 'past', label: '過去を拡大' },
  { id: 'future', label: '将来を拡大' },
]

export type SmaLabValues = Record<SmaLabPeriod, number | null>
/** Keyed by every period the result computed (presets plus any custom periods). */
export type SmaLabSeries = Record<SmaLabPeriod, Array<number | null>>

export interface SmaLabFutureBar {
  /** 1-based bar count after the as-of date. */
  k: number
  key: string
  periodStart: string
  periodEnd: string
  firstSession: string
  lastSession: string
  /** Sessions after the as-of date up to and including lastSession. */
  sessionsAhead: number
  /** The bar already started (contains the as-of date); the projection completes it. */
  completesForming: boolean
  /** Assumed close (Price Freeze: the as-of close). */
  close: number
}

export type SmaLabPeriodStatus = 'ok' | 'insufficient_history' | 'invalid_window'

export interface SmaLabPeriodSummary {
  period: SmaLabPeriod
  status: SmaLabPeriodStatus
  /** Confirmed bars required. */
  required: number
  /** Confirmed bars available up to the as-of date. */
  available: number
  shortfall: number
  /** Last-session dates of bars in the latest window whose close is unusable. */
  invalidBarsInWindow: string[]
  /** SMA at the last confirmed bar. */
  anchorValue: number | null
  /** SMA including the forming bar's latest close (separate from the confirmed SMA). */
  provisionalValue: number | null
  /** (frozen close − anchorValue) / anchorValue × 100 */
  closeGapPct: number | null
  endValue: number | null
  endChange: number | null
  endChangePct: number | null
}

export type SmaLabUnavailableReason =
  | 'invalid_analysis_date'
  | 'no_rows'
  | 'no_rows_before_boundary'
  | 'anchor_invalid'

interface SmaLabBase {
  market: SmaDynamicsMarket
  timeframe: SmaLabTimeframeId
  calendar: { id: string; label: string }
  analysisBoundary: string | null
  horizon: number
  issues: SmaLabDataIssue[]
  excludedAfterBoundary: number
}

export interface SmaLabAvailable extends SmaLabBase {
  status: 'available'
  /** Last session with a valid close at or before the boundary; the frozen price comes from here. */
  asOf: { date: string; close: number }
  bars: SmaLabBar[]
  /** Index of the last confirmed bar, or null when only a forming bar exists. */
  lastConfirmedIndex: number | null
  formingIndex: number | null
  /** Confirmed SMA per bar (always null on the forming bar). */
  sma: SmaLabSeries
  projection: {
    bars: SmaLabFutureBar[]
    sma: SmaLabSeries
  }
  periods: SmaLabPeriodSummary[]
}

export interface SmaLabUnavailable extends SmaLabBase {
  status: 'unavailable'
  reason: SmaLabUnavailableReason
  anchorDate: string | null
}

export type SmaLabResult = SmaLabAvailable | SmaLabUnavailable

export interface ComputeSmaLabInput {
  rows: ReadonlyArray<SmaLabRawRow>
  market: SmaDynamicsMarket
  timeframe: SmaLabTimeframeId
  analysisDate?: string | null
  /** Future bars of the selected timeframe. */
  horizon?: number
  calendar?: SmaLabCalendar
  /** Custom SMA periods (3..300) computed in addition to the presets. */
  periods?: ReadonlyArray<SmaLabPeriod>
}

function emptySeries(length: number, periods: ReadonlyArray<SmaLabPeriod>): SmaLabSeries {
  const out = {} as SmaLabSeries
  for (const period of periods) out[period] = Array<number | null>(length).fill(null)
  return out
}

function closeRows(closes: ReadonlyArray<number | null>): OHLCV[] {
  // smaAt reads close only; NaN marks an unusable bar so any window touching it is null.
  return closes.map((close, index) => {
    const value = close ?? Number.NaN
    return { date: String(index), open: value, high: value, low: value, close: value, volume: 0 }
  })
}

/**
 * SMA path over confirmed closes followed by an assumed future close path.
 * Returns one value per future close. A period whose last confirmed value is
 * unavailable stays null (history is never padded with assumed closes). A null
 * future close is a missing input: every window that contains it is null.
 */
export function projectSmaPath(
  confirmedCloses: ReadonlyArray<number | null>,
  futureCloses: ReadonlyArray<number | null>,
  period: number,
): Array<number | null> {
  const rows = closeRows([...confirmedCloses, ...futureCloses])
  const anchor = confirmedCloses.length - 1
  if (anchor < 0 || smaAt(rows, period, anchor) == null) return futureCloses.map(() => null)
  return futureCloses.map((_, offset) => smaAt(rows, period, anchor + offset + 1))
}

/**
 * Closes the SMA may use, one per confirmed bar (null = unusable). Same input
 * computeSmaLab feeds to projectSmaPath, so scenarios project on identical windows.
 */
export function smaLabConfirmedCloses(result: Pick<SmaLabAvailable, 'bars' | 'lastConfirmedIndex'>): Array<number | null> {
  const count = result.lastConfirmedIndex == null ? 0 : result.lastConfirmedIndex + 1
  return result.bars.slice(0, count).map((bar) => (bar.closeExact ? bar.close : null))
}

/** Price Freeze: every future close equals the as-of close. */
export function priceFreezePath(close: number, bars: number): number[] {
  return Array<number>(bars).fill(close)
}

function assertHorizon(value: number, timeframe: SmaLabTimeframeId) {
  // Month-based bars stop earlier: 5Y x 20 would leave the supported calendar.
  const max = smaLabTimeframe(timeframe).spec.unit === 'month' ? Math.min(SMA_LAB_MAX_HORIZON, smaLabMaxHorizonBars(timeframe)) : SMA_LAB_MAX_HORIZON
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new RangeError(`horizon must be an integer in 1..${max}: ${value}`)
  }
}

export function computeSmaLab(input: ComputeSmaLabInput): SmaLabResult {
  const timeframe = smaLabTimeframe(input.timeframe)
  const horizon = input.horizon ?? smaLabDefaultHorizon(timeframe.id)
  assertHorizon(horizon, timeframe.id)
  const calendar = input.calendar ?? smaLabCalendar(input.market)
  const analysisBoundary = input.analysisDate ?? null
  const periodList = normalizeSmaLabPeriods([...SMA_LAB_PERIODS, ...(input.periods ?? [])])
  const base = {
    market: input.market,
    timeframe: timeframe.id,
    calendar: { id: calendar.id, label: calendar.label },
    analysisBoundary,
    horizon,
  }

  if (analysisBoundary != null && !isIsoCalendarDate(analysisBoundary)) {
    return { ...base, status: 'unavailable', reason: 'invalid_analysis_date', anchorDate: null, issues: [], excludedAfterBoundary: 0 }
  }

  const history = normalizeSmaLabHistory(input.rows, calendar, analysisBoundary)
  const shared = { ...base, issues: history.issues, excludedAfterBoundary: history.excludedAfterBoundary }
  const last = history.rows.at(-1)
  if (!last) {
    return { ...shared, status: 'unavailable', reason: input.rows.length === 0 ? 'no_rows' : 'no_rows_before_boundary', anchorDate: null }
  }
  if (last.close == null) {
    // Never fall back to an earlier row: the as-of close is the frozen price.
    return { ...shared, status: 'unavailable', reason: 'anchor_invalid', anchorDate: last.date }
  }

  const asOf = { date: last.date, close: last.close }
  const issues = [...history.issues, ...missingSessionIssues(history, calendar, asOf.date)]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0))
  const bars = aggregateSmaLabBars({ history, calendar, spec: timeframe.spec, asOf: asOf.date })
  const formingIndex = bars.at(-1)?.phase === 'forming' ? bars.length - 1 : null
  const confirmedCount = formingIndex == null ? bars.length : bars.length - 1
  const lastConfirmedIndex = confirmedCount > 0 ? confirmedCount - 1 : null

  const confirmedCloses = bars.slice(0, confirmedCount).map((bar) => (bar.closeExact ? bar.close : null))
  const rows = closeRows(confirmedCloses)
  const sma = emptySeries(bars.length, periodList)
  for (const period of periodList) {
    for (let index = 0; index < confirmedCount; index += 1) sma[period][index] = smaAt(rows, period, index)
  }

  const future = futureBuckets(calendar, timeframe.spec, asOf.date, horizon)
  const path = priceFreezePath(asOf.close, future.length)
  const futureBars = future.map((bucket, offset): SmaLabFutureBar => ({
    k: offset + 1,
    key: bucket.key,
    periodStart: bucket.periodStart,
    periodEnd: bucket.periodEnd,
    firstSession: bucket.sessions[0],
    lastSession: bucket.sessions.at(-1)!,
    sessionsAhead: sessionsBetween(calendar, addCalendarDays(asOf.date, 1), bucket.sessions.at(-1)!).length,
    completesForming: formingIndex != null && bucket.key === bars[formingIndex].key,
    close: path[offset],
  }))
  const projectionSma = emptySeries(futureBars.length, periodList)
  for (const period of periodList) projectionSma[period] = projectSmaPath(confirmedCloses, path, period)

  const provisionalRows = formingIndex == null ? null : closeRows([...confirmedCloses, asOf.close])
  const periods = periodList.map((period): SmaLabPeriodSummary => {
    const shortfall = Math.max(0, period - confirmedCount)
    const anchorValue = lastConfirmedIndex == null ? null : sma[period][lastConfirmedIndex]
    const invalidBarsInWindow = shortfall > 0
      ? []
      : bars.slice(confirmedCount - period, confirmedCount).filter((bar) => !bar.closeExact).map((bar) => bar.lastSession)
    const provisionalValue = provisionalRows && anchorValue != null ? smaAt(provisionalRows, period, confirmedCount) : null
    const endValue = projectionSma[period].at(-1) ?? null
    const endChange = anchorValue != null && endValue != null ? endValue - anchorValue : null
    return {
      period,
      status: shortfall > 0 ? 'insufficient_history' : anchorValue == null ? 'invalid_window' : 'ok',
      required: period,
      available: confirmedCount,
      shortfall,
      invalidBarsInWindow,
      anchorValue,
      provisionalValue,
      closeGapPct: anchorValue != null ? ((asOf.close - anchorValue) / anchorValue) * 100 : null,
      endValue,
      endChange,
      endChangePct: endChange != null && anchorValue != null ? (endChange / anchorValue) * 100 : null,
    }
  })

  return {
    ...shared,
    issues,
    status: 'available',
    asOf,
    bars,
    lastConfirmedIndex,
    formingIndex,
    sma,
    projection: { bars: futureBars, sma: projectionSma },
    periods,
  }
}

// ---------------------------------------------------------------------------
// Display helpers (pure; they never feed back into the computation)

export function smaLabRangeStart(asOf: string, range: SmaLabRangeId): string | null {
  const spec = SMA_LAB_RANGES.find((item) => item.id === range)
  if (!spec || spec.unit === 'all') return null
  return spec.unit === 'day' ? addCalendarDays(asOf, -spec.amount) : addCalendarMonths(asOf, -spec.amount)
}

/** First bar that overlaps the display range (bars ending after the range start). */
export function firstBarIndexInRange(bars: ReadonlyArray<Pick<SmaLabBar, 'lastSession'>>, rangeStart: string | null): number {
  if (rangeStart == null || bars.length === 0) return 0
  const index = bars.findIndex((bar) => bar.lastSession > rangeStart)
  return index < 0 ? bars.length - 1 : index
}

export interface SmaLabSlotLayout {
  /** Slot of the last actual bar (confirmed or forming). */
  anchorSlot: number
  /** Last slot including future bars that start after the as-of bar. */
  lastSlot: number
}

/** Future bars that need their own slot (the forming-completion bar shares the forming bar's slot). */
export function slotLayout(result: Pick<SmaLabAvailable, 'bars' | 'projection'>): SmaLabSlotLayout {
  const anchorSlot = result.bars.length - 1
  const extra = result.projection.bars.filter((bar) => !bar.completesForming).length
  return { anchorSlot, lastSlot: anchorSlot + extra }
}

export function futureSlot(result: Pick<SmaLabAvailable, 'bars' | 'projection'>, k: number): number {
  const first = result.projection.bars[0]
  const anchorSlot = result.bars.length - 1
  return first?.completesForming ? anchorSlot + k - 1 : anchorSlot + k
}

export interface SlotRange {
  from: number
  to: number
}

export function visibleSlotRange(args: {
  firstPastSlot: number
  anchorSlot: number
  lastSlot: number
  focus: SmaLabFocus
}): SlotRange {
  const { firstPastSlot, anchorSlot, lastSlot, focus } = args
  const futureCount = lastSlot - anchorSlot
  if (focus === 'past') return { from: firstPastSlot - 0.5, to: anchorSlot + 1.5 }
  if (focus === 'future') {
    const context = Math.max(3, Math.min(10, futureCount))
    return { from: Math.max(-0.5, anchorSlot - context - 0.5), to: lastSlot + 1 }
  }
  return { from: firstPastSlot - 0.5, to: lastSlot + 1 }
}

/** Zoom around the range centre; factor < 1 zooms in. Never narrower than `minBars`. */
export function zoomSlotRange(range: SlotRange, factor: number, bounds: SlotRange, minBars = 3): SlotRange {
  const width = range.to - range.from
  const maxWidth = bounds.to - bounds.from
  const nextWidth = Math.min(maxWidth, Math.max(minBars, width * factor))
  const centre = (range.from + range.to) / 2
  let from = centre - nextWidth / 2
  let to = centre + nextWidth / 2
  if (from < bounds.from) { to += bounds.from - from; from = bounds.from }
  if (to > bounds.to) { from -= to - bounds.to; to = bounds.to }
  return { from: Math.max(bounds.from, from), to }
}

/** "5本 = 2営業日足×5（基準日の後 10営業日）" — keeps bars and sessions apart. */
export function describeHorizon(timeframe: SmaLabTimeframeId, bars: number, futureBars?: ReadonlyArray<SmaLabFutureBar>): string {
  const tf = smaLabTimeframe(timeframe)
  const sessions = futureBars?.at(-1)?.sessionsAhead
  const head = timeframe === '1D' ? `${bars}本 = ${bars}営業日` : `${bars}本 = ${tf.barNoun}×${bars}`
  if (sessions == null || timeframe === '1D') return head
  const forming = futureBars?.[0]?.completesForming ? '・現在の未確定足を含む' : ''
  return `${head}（基準日の後 ${sessions}営業日${forming}）`
}

export function describeSmaLabUnavailable(reason: SmaLabUnavailableReason, anchorDate: string | null): string {
  switch (reason) {
    case 'invalid_analysis_date':
      return '基準日の形式が正しくないため計算できません。'
    case 'no_rows':
      return '価格履歴がないため計算できません。'
    case 'no_rows_before_boundary':
      return '基準日以前の有効な価格履歴がないため計算できません。'
    case 'anchor_invalid':
      return `基準日の終値 (${anchorDate ?? '日付不明'}) が使用できないため計算できません。`
  }
}

export function describeSmaLabIssueKind(kind: SmaLabDataIssue['kind']): string {
  switch (kind) {
    case 'invalid_date': return '日付を解釈できない行'
    case 'duplicate_date': return '同じ日付の重複行'
    case 'invalid_close': return '終値が数値でない日'
    case 'non_positive_close': return '終値が0以下の日'
    case 'invalid_ohlc': return '始値・高値・安値が不正な日(ローソク足は不完全表示)'
    case 'ohlc_unavailable': return '始値・高値・安値がない日(終値のみ)'
    case 'off_calendar_date': return '市場カレンダー上の休場日にある行(除外)'
    case 'unsupported_date': return '対応範囲外の日付の行(除外)'
    case 'missing_session': return '営業日なのに行がない日'
  }
}
