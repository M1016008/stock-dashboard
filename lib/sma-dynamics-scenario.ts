// SMA Dynamics Lab Phase 2: forward close scenarios and the SMA inverse solver.
//
// Notation (one step = one bar of the selected timeframe, never a calendar day):
//   a       index of the last confirmed bar (the anchor); c_i are confirmed closes
//   x_k     assumed close of future bar T+k (k = 1..H), placed at index a + k
//   SMA_N(t) = mean(c_{t-N+1} .. c_t)
//   Δ_k = SMA_N(a+k) − SMA_N(a+k−1) = (x_k − out_k) / N
//   out_k = c_{a+k−N}  when k ≤ N (a confirmed close leaves the window)
//         = x_{k−N}    when k > N (an earlier assumed close leaves the window)
//
// The direction at T+k is the sign of Δ_k and is decided by comparing x_k with
// out_k directly, so "flat" is exact equality (no subtraction of rounded means).
// The display tolerance only annotates; it never changes the exact direction.
//
// Everything is pure and fetch-free. All SMA values shown for a path come from
// projectSmaPath, the same rolling-window engine as Price Freeze.
import {
  priceFreezePath,
  projectSmaPath,
  smaLabConfirmedCloses,
  SMA_LAB_PERIODS,
  type SmaLabAvailable,
  type SmaLabPeriod,
  type SmaLabSeries,
} from '@/lib/sma-dynamics-lab'
import type { SmaLabTimeframeId } from '@/lib/sma-dynamics-timeframes'

// ---------------------------------------------------------------------------
// Modes

export type SmaLabAnalysisMode = 'freeze' | 'scenario' | 'solver'
export const SMA_LAB_ANALYSIS_MODES: ReadonlyArray<{ id: SmaLabAnalysisMode; label: string; title: string }> = [
  { id: 'freeze', label: '価格固定', title: '将来の終値が基準日の終値のまま変わらない場合' },
  { id: 'scenario', label: '価格シナリオ', title: '将来足ごとの終値を自由に入力してSMAを再計算' },
  { id: 'solver', label: 'SMA逆算', title: '目標とするSMAの向きを成立させる終値の条件を逆算' },
]

// ---------------------------------------------------------------------------
// Base

export interface ForwardBase {
  /** One entry per confirmed bar of the selected timeframe (null = unusable close). */
  confirmedCloses: ReadonlyArray<number | null>
  /** Index of the last confirmed bar, −1 when none. */
  anchorIndex: number
  /** As-of close (現値). Price Freeze repeats it; percent inputs are relative to it. */
  anchorClose: number
  /** Number of future bars (selected horizon). */
  horizon: number
  /** Periods projected by projectAllSma; defaults to the presets. Custom periods come from the lab result. */
  periods?: ReadonlyArray<number>
}

export function forwardBase(result: SmaLabAvailable): ForwardBase {
  const confirmedCloses = smaLabConfirmedCloses(result)
  return {
    confirmedCloses,
    anchorIndex: confirmedCloses.length - 1,
    anchorClose: result.asOf.close,
    horizon: result.projection.bars.length,
    periods: result.periods.map((summary) => summary.period),
  }
}

/** Removes binary noise from derived prices (12 significant digits). Typed values are unaffected. */
export function cleanFloat(value: number): number {
  return Number.isFinite(value) ? Number(value.toPrecision(12)) : value
}

/** Every lab SMA over the confirmed closes followed by `closes` (null = missing input). */
export function projectAllSma(base: ForwardBase, closes: ReadonlyArray<number | null>): SmaLabSeries {
  const out = {} as SmaLabSeries
  for (const period of base.periods ?? SMA_LAB_PERIODS) out[period] = projectSmaPath(base.confirmedCloses, closes, period)
  return out
}

/** SMA at a confirmed index with the same summation order as smaAt. */
function confirmedSma(base: ForwardBase, period: number, index: number): number | null {
  if (index < period - 1 || index > base.anchorIndex) return null
  let sum = 0
  for (let i = index - period + 1; i <= index; i += 1) {
    const close = base.confirmedCloses[i]
    if (close == null || !Number.isFinite(close)) return null
    sum += close
  }
  return sum / period
}

export function anchorSmaValue(base: ForwardBase, period: number): number | null {
  return confirmedSma(base, period, base.anchorIndex)
}

// ---------------------------------------------------------------------------
// Numeric input

const FULL_WIDTH = /[０-９．－＋，％]/g

/** Accepts half/full-width digits, thousands separators and a trailing %. */
export function parseNumericText(raw: string): number | null | 'invalid' {
  const text = raw
    .replace(FULL_WIDTH, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/[−–]/g, '-')
    .replace(/[,\s]/g, '')
    .replace(/%$/, '')
  if (text === '') return null
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(text)) return 'invalid'
  const value = Number(text)
  return Number.isFinite(value) ? value : 'invalid'
}

/** Up to `maxDecimals` decimals, trailing zeros trimmed; never "-0". */
export function formatInputNumber(value: number, maxDecimals = 6): string {
  const text = cleanFloat(value).toFixed(maxDecimals).replace(/\.?0+$/, '')
  return text === '-0' ? '0' : text
}

// ---------------------------------------------------------------------------
// Mode B: forward close scenario

export type ScenarioUnit = 'price' | 'pct'
export const SCENARIO_UNITS: ReadonlyArray<{ id: ScenarioUnit; label: string; title: string }> = [
  { id: 'pct', label: '現値比 %', title: '基準日の終値に対する変化率で入力' },
  { id: 'price', label: '価格', title: '終値を絶対価格で入力' },
]

/** Raw text per future bar ('' = not entered). Kept beyond the horizon so shortening it loses nothing. */
export interface ScenarioDraft {
  unit: ScenarioUnit
  inputs: string[]
}

export function emptyScenario(horizon: number, unit: ScenarioUnit = 'pct'): ScenarioDraft {
  return { unit, inputs: Array<string>(horizon).fill('') }
}

export type ScenarioCellStatus = 'ok' | 'missing' | 'invalid' | 'non_positive'

export interface ScenarioCell {
  k: number
  raw: string
  status: ScenarioCellStatus
  /** Assumed close (null unless status is ok). */
  close: number | null
  pctFromAnchor: number | null
}

export interface ScenarioEvaluation {
  cells: ScenarioCell[]
  /** Usable closes; null = missing or rejected input. Never filled in. */
  closes: Array<number | null>
  sma: SmaLabSeries
  filled: number
  missingK: number[]
  invalidK: number[]
  state: 'empty' | 'partial' | 'complete'
}

export function scenarioCellClose(base: ForwardBase, unit: ScenarioUnit, raw: string): Pick<ScenarioCell, 'status' | 'close' | 'pctFromAnchor'> {
  const value = parseNumericText(raw)
  if (value === null) return { status: 'missing', close: null, pctFromAnchor: null }
  if (value === 'invalid') return { status: 'invalid', close: null, pctFromAnchor: null }
  const close = unit === 'price' ? value : cleanFloat(base.anchorClose * (1 + value / 100))
  if (!(close > 0)) return { status: 'non_positive', close: null, pctFromAnchor: null }
  const pctFromAnchor = unit === 'pct' ? value : cleanFloat((close / base.anchorClose - 1) * 100)
  return { status: 'ok', close, pctFromAnchor }
}

export function evaluateScenario(base: ForwardBase, draft: ScenarioDraft): ScenarioEvaluation {
  const cells: ScenarioCell[] = []
  for (let k = 1; k <= base.horizon; k += 1) {
    const raw = draft.inputs[k - 1] ?? ''
    cells.push({ k, raw, ...scenarioCellClose(base, draft.unit, raw) })
  }
  const closes = cells.map((cell) => cell.close)
  const filled = cells.filter((cell) => cell.status === 'ok').length
  return {
    cells,
    closes,
    sma: projectAllSma(base, closes),
    filled,
    missingK: cells.filter((cell) => cell.status === 'missing').map((cell) => cell.k),
    invalidK: cells.filter((cell) => cell.status === 'invalid' || cell.status === 'non_positive').map((cell) => cell.k),
    state: filled === 0 ? 'empty' : filled === base.horizon ? 'complete' : 'partial',
  }
}

export function scenarioFromCloses(base: ForwardBase, closes: ReadonlyArray<number | null>, unit: ScenarioUnit): ScenarioDraft {
  return {
    unit,
    inputs: closes.map((close) => {
      if (close == null) return ''
      return unit === 'price' ? formatInputNumber(close) : formatInputNumber((close / base.anchorClose - 1) * 100)
    }),
  }
}

/** Keeps every stored input; only pads so each future bar has a cell. */
export function resizeScenario(draft: ScenarioDraft, horizon: number): ScenarioDraft {
  if (draft.inputs.length >= horizon) return draft
  return { ...draft, inputs: [...draft.inputs, ...Array<string>(horizon - draft.inputs.length).fill('')] }
}

/** Replaces the first `horizon` cells; cells beyond it are kept. */
function withLeading(draft: ScenarioDraft, next: ScenarioDraft): ScenarioDraft {
  return { unit: next.unit, inputs: [...next.inputs, ...draft.inputs.slice(next.inputs.length)] }
}

export function presetFreeze(base: ForwardBase, draft: ScenarioDraft): ScenarioDraft {
  return withLeading(draft, scenarioFromCloses(base, priceFreezePath(base.anchorClose, base.horizon), draft.unit))
}

/** x_k = P0 × (1 + r)^k, r per bar of the selected timeframe. */
export function presetConstantRate(base: ForwardBase, draft: ScenarioDraft, ratePctPerBar: number): ScenarioDraft {
  const closes = Array.from({ length: base.horizon }, (_, i) => cleanFloat(base.anchorClose * (1 + ratePctPerBar / 100) ** (i + 1)))
  return withLeading(draft, scenarioFromCloses(base, closes, draft.unit))
}

/** Straight line from P0 to P0 × (1 + target%) at the last future bar. */
export function presetLinearTo(base: ForwardBase, draft: ScenarioDraft, targetPctAtEnd: number): ScenarioDraft {
  const closes = Array.from({ length: base.horizon }, (_, i) => cleanFloat(base.anchorClose * (1 + (targetPctAtEnd / 100) * ((i + 1) / base.horizon))))
  return withLeading(draft, scenarioFromCloses(base, closes, draft.unit))
}

export type ShockAftermath = 'hold' | 'revert'

/**
 * One-off shock: the close stays at the as-of close until bar `atBar`, jumps there by `shockPct` percent and then
 * either stays at the new level (hold) or walks back in a straight line to the as-of close at the last bar (revert).
 */
export function presetShock(base: ForwardBase, draft: ScenarioDraft, shockPct: number, atBar: number, aftermath: ShockAftermath): ScenarioDraft {
  const at = Math.min(Math.max(1, Math.round(atBar)), base.horizon)
  const peak = base.anchorClose * (1 + shockPct / 100)
  const closes = Array.from({ length: base.horizon }, (_, i) => {
    const k = i + 1
    if (k < at) return base.anchorClose
    if (aftermath === 'hold' || k === at || base.horizon === at) return cleanFloat(peak)
    return cleanFloat(peak + (base.anchorClose - peak) * ((k - at) / (base.horizon - at)))
  })
  return withLeading(draft, scenarioFromCloses(base, closes, draft.unit))
}

/** Explicit user action: each empty cell takes the previous usable close (T+1 takes the as-of close). */
export function fillMissingForward(base: ForwardBase, draft: ScenarioDraft): ScenarioDraft {
  const inputs = [...resizeScenario(draft, base.horizon).inputs]
  let previous = base.anchorClose
  for (let k = 1; k <= base.horizon; k += 1) {
    const cell = scenarioCellClose(base, draft.unit, inputs[k - 1])
    if (cell.status === 'missing') inputs[k - 1] = scenarioFromCloses(base, [previous], draft.unit).inputs[0]
    else if (cell.close != null) previous = cell.close
  }
  return { ...draft, inputs }
}

export function clearScenario(base: ForwardBase, draft: ScenarioDraft): ScenarioDraft {
  return withLeading(draft, emptyScenario(base.horizon, draft.unit))
}

/** Re-expresses usable cells in the other unit; rejected text is kept as typed. */
export function convertScenarioUnit(base: ForwardBase, draft: ScenarioDraft, unit: ScenarioUnit): ScenarioDraft {
  if (unit === draft.unit) return draft
  return {
    unit,
    inputs: draft.inputs.map((raw) => {
      const cell = scenarioCellClose(base, draft.unit, raw)
      return cell.close == null ? raw : scenarioFromCloses(base, [cell.close], unit).inputs[0]
    }),
  }
}

export function setScenarioInput(draft: ScenarioDraft, k: number, raw: string): ScenarioDraft {
  const inputs = [...draft.inputs]
  while (inputs.length < k) inputs.push('')
  inputs[k - 1] = raw
  return { ...draft, inputs }
}

// ---------------------------------------------------------------------------
// Direction (adjacent bars) and level (versus the anchor SMA)

export type SmaDirection = 'up' | 'flat' | 'down'
export type Comparator = '>' | '=' | '<'
export const DIRECTION_COMPARATOR: Record<SmaDirection, Comparator> = { up: '>', flat: '=', down: '<' }
export const DIRECTION_LABEL: Record<SmaDirection, string> = { up: '上向き', flat: '横ばい', down: '下向き' }
export const LEVEL_LABEL: Record<SmaDirection, string> = { up: '基準日SMAより上', flat: '基準日SMAと同値', down: '基準日SMAより下' }

/**
 * Display-only band. |ΔSMA| at or below this share of the previous SMA is
 * annotated as "表示上は横ばい"; the exact direction is unchanged.
 */
export const SMA_FLAT_DISPLAY_TOLERANCE_PCT = 0.01

export function directionOf(incoming: number, outgoing: number): SmaDirection {
  return incoming > outgoing ? 'up' : incoming < outgoing ? 'down' : 'flat'
}

export function compare(value: number, op: Comparator, bound: number): boolean {
  return op === '>' ? value > bound : op === '<' ? value < bound : value === bound
}

export function isDisplayFlat(delta: number, previous: number): boolean {
  return Math.abs(delta) <= (Math.abs(previous) * SMA_FLAT_DISPLAY_TOLERANCE_PCT) / 100
}

export type OutgoingClose =
  | { kind: 'confirmed'; index: number; close: number }
  | { kind: 'future'; k: number }

/** The close that leaves the SMA window when T+k enters. */
export function outgoingFor(base: ForwardBase, period: number, k: number): OutgoingClose | null {
  if (k > period) return { kind: 'future', k: k - period }
  const index = base.anchorIndex + k - period
  const close = index >= 0 ? base.confirmedCloses[index] : null
  return close == null ? null : { kind: 'confirmed', index, close }
}

export interface SmaStep {
  k: number
  sma: number | null
  previous: number | null
  incoming: number | null
  outgoing: number | null
  outgoingSource: OutgoingClose | null
  /** (incoming − outgoing) / N; null when either close or either SMA is unavailable. */
  delta: number | null
  /** Exact sign of delta. */
  direction: SmaDirection | null
  displayFlat: boolean
  /** SMA(T+k) − SMA(anchor): the level comparison, not the slope. */
  levelChange: number | null
}

export function smaSteps(base: ForwardBase, closes: ReadonlyArray<number | null>, period: number): SmaStep[] {
  const sma = projectSmaPath(base.confirmedCloses, closes, period)
  const anchorSma = anchorSmaValue(base, period)
  return sma.map((value, offset) => {
    const k = offset + 1
    const previous = k === 1 ? anchorSma : sma[offset - 1]
    const incoming = closes[offset] ?? null
    const outgoingSource = outgoingFor(base, period, k)
    const outgoing = outgoingSource == null ? null : outgoingSource.kind === 'confirmed' ? outgoingSource.close : closes[outgoingSource.k - 1] ?? null
    const known = value != null && previous != null && incoming != null && outgoing != null
    const delta = known ? (incoming - outgoing) / period : null
    return {
      k,
      sma: value,
      previous,
      incoming,
      outgoing,
      outgoingSource,
      delta,
      direction: known ? directionOf(incoming, outgoing) : null,
      displayFlat: known && delta != null && previous != null ? isDisplayFlat(delta, previous) : false,
      levelChange: value != null && anchorSma != null ? value - anchorSma : null,
    }
  })
}

export interface AnchorDirection {
  previous: number
  current: number
  delta: number
  direction: SmaDirection
  displayFlat: boolean
}

/** Direction of the confirmed SMA into the anchor bar (needs N + 1 usable closes). */
export function anchorDirection(base: ForwardBase, period: number): AnchorDirection | null {
  const current = confirmedSma(base, period, base.anchorIndex)
  const previous = confirmedSma(base, period, base.anchorIndex - 1)
  if (current == null || previous == null) return null
  const incoming = base.confirmedCloses[base.anchorIndex]!
  const outgoing = base.confirmedCloses[base.anchorIndex - period]!
  const delta = (incoming - outgoing) / period
  return { previous, current, delta, direction: directionOf(incoming, outgoing), displayFlat: isDisplayFlat(delta, previous) }
}

function decimalsOf(value: number): number {
  const text = String(cleanFloat(Math.abs(value)))
  const exp = text.match(/e([+-]\d+)$/)
  if (exp) {
    const mantissa = text.slice(0, text.indexOf('e'))
    const fraction = mantissa.includes('.') ? mantissa.length - mantissa.indexOf('.') - 1 : 0
    return Math.max(0, fraction - Number(exp[1]))
  }
  return text.includes('.') ? text.length - text.indexOf('.') - 1 : 0
}

/** Sign of Σa − Σb on decimal-scaled integers, so typed decimals compare exactly. */
export function compareSums(a: ReadonlyArray<number>, b: ReadonlyArray<number>): -1 | 0 | 1 {
  const values = [...a, ...b]
  const decimals = values.reduce((max, value) => Math.max(max, decimalsOf(value)), 0)
  if (decimals <= 10) {
    const scale = 10 ** decimals
    const sa = a.reduce((sum, value) => sum + Math.round(value * scale), 0)
    const sb = b.reduce((sum, value) => sum + Math.round(value * scale), 0)
    if (Math.abs(sa) < Number.MAX_SAFE_INTEGER && Math.abs(sb) < Number.MAX_SAFE_INTEGER) return sa > sb ? 1 : sa < sb ? -1 : 0
  }
  const fa = a.reduce((sum, value) => sum + value, 0)
  const fb = b.reduce((sum, value) => sum + value, 0)
  if (Math.abs(fa - fb) <= 1e-12 * Math.max(1, Math.abs(fa), Math.abs(fb))) return 0
  return fa > fb ? 1 : -1
}

// ---------------------------------------------------------------------------
// Price grid and domain (constraints are explicit inputs; no exchange tick table is assumed)

export interface PriceConstraints {
  /** Inclusive lower bound; null = positivity only (x > 0). */
  min: number | null
  /** Inclusive upper bound; null = unbounded. */
  max: number | null
  /** Price increment; null = continuous prices. */
  tick: number | null
}

export const NO_CONSTRAINTS: PriceConstraints = { min: null, max: null, tick: null }

export interface PriceGrid {
  step: number
  decimals: number
  scale: number
  stepUnits: number
}

const MAX_GRID_DECIMALS = 12

export function priceGrid(step: number | null): PriceGrid | null {
  if (step == null || !Number.isFinite(step) || step <= 0) return null
  const decimals = decimalsOf(step)
  // Values finer than this cannot be represented reliably by the Number-based
  // solver. Treat them as invalid input instead of silently turning them into a
  // continuous domain or producing a zero integer step.
  if (decimals > MAX_GRID_DECIMALS) return null
  const scale = 10 ** decimals
  const stepUnits = Math.round(step * scale)
  if (!Number.isSafeInteger(stepUnits) || stepUnits <= 0) return null
  return { step, decimals, scale, stepUnits }
}

function gridQuotient(grid: PriceGrid, value: number): number {
  return value / grid.step
}

function safeGridQuotient(grid: PriceGrid, value: number): number | null {
  const q = gridQuotient(grid, value)
  return Number.isFinite(q) && Math.abs(q) <= Number.MAX_SAFE_INTEGER ? q : null
}

function snapped(grid: PriceGrid, value: number): number | null {
  const q = safeGridQuotient(grid, value)
  if (q == null) return null
  const r = Math.round(q)
  const reconstructed = r * grid.step
  // Error is measured in price units, not in quotient units. Scaling tolerance
  // by a very large quotient would incorrectly accept half-tick prices. The
  // quarter-tick ceiling keeps even the smallest supported grid unambiguous.
  const tolerance = Math.min(
    grid.step / 4,
    Math.max(
      Number.EPSILON * Math.max(1, Math.abs(value), Math.abs(reconstructed)) * 4,
      grid.step * 1e-12,
    ),
  )
  return Math.abs(value - reconstructed) <= tolerance ? r : null
}

export function gridFloor(grid: PriceGrid, value: number): number {
  const q = safeGridQuotient(grid, value)
  if (q == null) return Number.NaN
  return snapped(grid, value) ?? Math.floor(q)
}

export function gridCeil(grid: PriceGrid, value: number): number {
  const q = safeGridQuotient(grid, value)
  if (q == null) return Number.NaN
  return snapped(grid, value) ?? Math.ceil(q)
}

export function isOnGrid(grid: PriceGrid, value: number): boolean {
  return snapped(grid, value) != null
}

export function gridValue(grid: PriceGrid, units: number): number {
  if (!Number.isSafeInteger(units)) return Number.NaN
  return Number((units * grid.step).toFixed(grid.decimals))
}

export function roundToGrid(grid: PriceGrid | null, value: number): number {
  if (!grid) return cleanFloat(value)
  const q = safeGridQuotient(grid, value)
  return q == null ? Number.NaN : gridValue(grid, Math.round(q))
}

export interface PriceDomain {
  grid: PriceGrid | null
  lo: number
  /** True when the lower bound is only positivity (x > 0). */
  loOpen: boolean
  hi: number
  /** Grid index bounds (grid only). */
  mLo: number
  mHi: number
  empty: boolean
}

export function priceDomain(constraints: PriceConstraints): PriceDomain {
  const grid = priceGrid(constraints.tick)
  const hasMin = constraints.min != null && constraints.min > 0
  const lo = hasMin ? constraints.min! : 0
  const loOpen = !hasMin
  const hi = constraints.max ?? Infinity
  if (grid) {
    const rawLo = gridCeil(grid, lo)
    const rawHi = Number.isFinite(hi) ? gridFloor(grid, hi) : Infinity
    const mLo = Number.isFinite(rawLo) ? Math.max(1, rawLo) : Number.NaN
    const mHi = rawHi
    return { grid, lo, loOpen, hi, mLo, mHi, empty: Number.isNaN(mLo) || Number.isNaN(mHi) || mLo > mHi }
  }
  return { grid, lo, loOpen, hi, mLo: 0, mHi: 0, empty: hi <= 0 || hi < lo }
}

/** Domain of a sum of `count` independent values from `domain`. */
function sumDomain(domain: PriceDomain, count: number): PriceDomain {
  return { ...domain, lo: domain.lo * count, hi: domain.hi * count, mLo: domain.mLo * count, mHi: domain.mHi * count }
}

/** A boundary value; attained=false means it is the infimum/supremum (strict inequality, continuous prices). */
export interface BoundValue {
  value: number
  attained: boolean
}

export function domainContains(domain: PriceDomain, value: number): boolean {
  if (domain.empty) return false
  if (domain.grid) {
    if (!isOnGrid(domain.grid, value)) return false
    const m = Math.round(gridQuotient(domain.grid, value))
    return m >= domain.mLo && m <= domain.mHi
  }
  return (domain.loOpen ? value > domain.lo : value >= domain.lo) && value <= domain.hi
}

/** Smallest admissible value strictly above `bound`. */
export function domainMinAbove(domain: PriceDomain, bound: number): BoundValue | null {
  if (domain.empty) return null
  if (domain.grid) {
    const floor = gridFloor(domain.grid, bound)
    if (!Number.isFinite(floor)) return null
    const m = Math.max(floor + 1, domain.mLo)
    return m > domain.mHi ? null : { value: gridValue(domain.grid, m), attained: true }
  }
  if (!(domain.hi > bound)) return null
  if (bound < domain.lo) return { value: domain.lo, attained: !domain.loOpen }
  return { value: bound, attained: false }
}

/** Largest admissible value strictly below `bound`. */
export function domainMaxBelow(domain: PriceDomain, bound: number): BoundValue | null {
  if (domain.empty) return null
  if (domain.grid) {
    const ceil = gridCeil(domain.grid, bound)
    if (!Number.isFinite(ceil)) return null
    const m = Math.min(ceil - 1, domain.mHi)
    return m < domain.mLo ? null : { value: gridValue(domain.grid, m), attained: true }
  }
  if (!(bound > domain.lo)) return null
  if (domain.hi < bound) return { value: domain.hi, attained: true }
  return { value: bound, attained: false }
}

function domainCountAbove(domain: PriceDomain, bound: number): number {
  if (domain.empty) return 0
  if (domain.grid) {
    const floor = gridFloor(domain.grid, bound)
    return Number.isFinite(floor) ? Math.max(0, domain.mHi - Math.max(floor + 1, domain.mLo) + 1) : 0
  }
  return domainMinAbove(domain, bound) ? Infinity : 0
}

function domainCountBelow(domain: PriceDomain, bound: number): number {
  if (domain.empty) return 0
  if (domain.grid) {
    const ceil = gridCeil(domain.grid, bound)
    return Number.isFinite(ceil) ? Math.max(0, Math.min(ceil - 1, domain.mHi) - domain.mLo + 1) : 0
  }
  return domainMaxBelow(domain, bound) ? Infinity : 0
}

function domainHasTwo(domain: PriceDomain): boolean {
  if (domain.empty) return false
  return domain.grid ? domain.mHi - domain.mLo >= 1 : domain.hi > domain.lo
}

function satisfiable(domain: PriceDomain, op: Comparator, bound: number): boolean {
  return op === '>' ? domainMinAbove(domain, bound) != null : op === '<' ? domainMaxBelow(domain, bound) != null : domainContains(domain, bound)
}

function boundFor(domain: PriceDomain, op: Comparator, bound: number): BoundValue | null {
  if (op === '>') return domainMinAbove(domain, bound)
  if (op === '<') return domainMaxBelow(domain, bound)
  return domainContains(domain, bound) ? { value: bound, attained: true } : null
}

// ---------------------------------------------------------------------------
// Mode C: inverse solver

export type SolverGoalKind = 'direction' | 'within' | 'maintain' | 'reversal' | 'level'

/**
 * Direction goals come in three scopes over the same N future bars (T+0 is never counted):
 *   direction (A, exact N)    the slope at T+N only; T+1..T+N−1 may be anything
 *   within    (B, within N)   the slope matches at least once in T+1..T+N; losing it later does not undo the hit
 *   maintain  (C, throughout) the slope matches at every T+1..T+N
 * reversal and level are separate research goals:
 *   reversal  a real sign change inside T+1..T+N (see retainedDirection)
 *   level     SMA(T+K) versus SMA at the anchor (not a slope)
 */
export type SolverGoal =
  /** A: slope at one future bar, SMA(T+K) versus SMA(T+K−1). */
  | { kind: 'direction'; period: SmaLabPeriod; bar: number; direction: SmaDirection }
  /** B: the slope equals `direction` at one or more bars of T+1..T+within. */
  | { kind: 'within'; period: SmaLabPeriod; within: number; direction: SmaDirection }
  /** C: slope equals `direction` at every bar 1..through. */
  | { kind: 'maintain'; period: SmaLabPeriod; through: number; direction: SmaDirection }
  /** Event: a bar ≤ within points `to` while the most recent earlier non-flat slope (flats are a neutral bridge) was the opposite. */
  | { kind: 'reversal'; period: SmaLabPeriod; within: number; to: 'up' | 'down' }
  /** Level, not slope: SMA(T+K) versus SMA at the anchor (up = above). */
  | { kind: 'level'; period: SmaLabPeriod; bar: number; relation: SmaDirection }

export const SOLVER_GOAL_KINDS: ReadonlyArray<{ id: SolverGoalKind; label: string; title: string }> = [
  { id: 'direction', label: 'N本後の時点', title: 'T+N のSMAが直前の足 (T+N−1) より上・同値・下' },
  { id: 'within', label: 'N本以内に一度でも', title: 'T+1〜T+N のどこか1本以上で、SMAがその向きになる (T+0は数えない)' },
  { id: 'maintain', label: 'N本ずっと', title: 'T+1〜T+N のすべての足で同じ向き' },
  { id: 'reversal', label: '向きの転換 (符号反転)', title: '直近の非横ばいの向きから反対へ実際に切り替わる' },
  { id: 'level', label: '水準 (基準日比)', title: 'T+K のSMAが基準日のSMAより上・同値・下 (傾きではない)' },
]

export function goalBars(goal: SolverGoal): number {
  return goal.kind === 'direction' || goal.kind === 'level' ? goal.bar : goal.kind === 'maintain' ? goal.through : goal.within
}

/** Direction a goal aims at (reversal: the direction turned to; level: the relation to the anchor SMA). */
export function goalTarget(goal: SolverGoal): SmaDirection {
  return goal.kind === 'reversal' ? goal.to : goal.kind === 'level' ? goal.relation : goal.direction
}

export type BarRequirement =
  | { k: number; kind: 'free' }
  | { k: number; kind: 'threshold'; op: Comparator; value: number; outgoingIndex: number; bound: BoundValue | null; feasible: boolean }
  | { k: number; kind: 'relative'; op: Comparator; otherK: number; feasible: boolean }
  | { k: number; kind: 'sum_member' }

export interface SumRequirement {
  fromK: number
  toK: number
  count: number
  op: Comparator
  /** Σ x_k must compare to this (the sum of the confirmed closes that leave the window). */
  sum: number
  mean: number
  outgoingIndices: number[]
  /** Tick-aware boundary on the mean of the future closes. */
  meanBound: BoundValue | null
  feasible: boolean
}

export type SolverStatus = 'feasible' | 'infeasible' | 'precondition_failed' | 'unavailable'

export type SolverIssue =
  | 'sma_unavailable'
  | 'anchor_direction_unknown'
  | 'bar_out_of_range'
  | 'empty_domain'
  | 'already_in_target_direction'
  | 'anchor_flat'
  | 'bound_excludes_threshold'
  | 'tick_excludes_equality'
  | 'chain_needs_more_room'
  | 'needs_two_prices'
  | 'reversal_needs_two_bars'

/** The most recent non-flat slope at or before the anchor, found by walking back through confirmed history. */
export type RetainedDirection = { state: 'known'; direction: 'up' | 'down' | null } | { state: 'unknown' }

/**
 * Starting point of the flat bridge. Walks back from the anchor bar to the latest bar whose slope is not
 * exactly flat. direction=null: every observable slope up to the start of the history is flat.
 * 'unknown': the walk hit an unusable close before finding one.
 */
export function retainedDirection(base: ForwardBase, period: number): RetainedDirection {
  for (let index = base.anchorIndex; index - period >= 0; index -= 1) {
    const incoming = base.confirmedCloses[index]
    const outgoing = base.confirmedCloses[index - period]
    if (incoming == null || outgoing == null || !Number.isFinite(incoming) || !Number.isFinite(outgoing)) return { state: 'unknown' }
    const direction = directionOf(incoming, outgoing)
    if (direction !== 'flat') return { state: 'known', direction }
  }
  return base.anchorIndex - period < 0 ? { state: 'unknown' } : { state: 'known', direction: null }
}

/**
 * Real sign change over future slopes. Flat bars are a neutral bridge: they neither start nor end a
 * reversal, and the opposite direction is looked up past them. Returns the first bar that turns to `to`
 * while the retained earlier non-flat direction was the opposite.
 */
export function firstReversal(directions: ReadonlyArray<SmaDirection | null>, to: 'up' | 'down', retained: 'up' | 'down' | null): { hitK: number | null; complete: boolean } {
  let last = retained
  for (let i = 0; i < directions.length; i += 1) {
    const direction = directions[i]
    if (direction == null) return { hitK: null, complete: false }
    if (direction === 'flat') continue
    if (direction === to && last === OPPOSITE[to]) return { hitK: i + 1, complete: true }
    last = direction
  }
  return { hitK: null, complete: true }
}

export interface SolverAnalysis {
  goal: SolverGoal
  status: SolverStatus
  issue: SolverIssue | null
  /** all: every listed bar must hold. any: one bar is enough (within, reversal from the opposite direction). sequence: an opposite bar, then a later target bar (reversal). */
  combinator: 'all' | 'any' | 'sequence'
  /** Requirements for the goal's target direction (reversal: the turned-to direction). */
  requirements: BarRequirement[]
  /** reversal sequence only: requirements for the opposite direction that must occur first. */
  oppositeRequirements: BarRequirement[]
  sum: SumRequirement | null
  anchorSma: number | null
  anchorDirection: AnchorDirection | null
  /** reversal only: the retained non-flat direction at T0. */
  retained: RetainedDirection | null
  /** reversal only, sequence case: one admissible (opposite bar, target bar) pair. */
  sequencePlan: { firstK: number; secondK: number } | null
  /** Headline boundary (direction/within/reversal: the decisive threshold bar). */
  primary: { k: number; op: Comparator; value: number; bound: BoundValue | null } | null
  domain: PriceDomain
  /** maintain only: the current direction already differs (the run starts with a turn). */
  startsWithTurn: boolean
  /** direction/within/maintain: the slope into the anchor bar already equals the target (T+0 is not counted). */
  currentlyTarget: boolean
}

const OPPOSITE: Record<'up' | 'down', 'up' | 'down'> = { up: 'down', down: 'up' }
export function oppositeDirection(direction: 'up' | 'down'): 'up' | 'down' { return OPPOSITE[direction] }

function requirementFor(base: ForwardBase, domain: PriceDomain, period: number, k: number, op: Comparator): BarRequirement | null {
  const src = outgoingFor(base, period, k)
  if (!src) return null
  if (src.kind === 'future') {
    return { k, kind: 'relative', op, otherK: src.k, feasible: op === '=' ? !domain.empty : domainHasTwo(domain) }
  }
  const bound = boundFor(domain, op, src.close)
  return { k, kind: 'threshold', op, value: src.close, outgoingIndex: src.index, bound, feasible: bound != null }
}

type ThresholdRequirement = Extract<BarRequirement, { kind: 'threshold' }>

export function analyzeSolverGoal(base: ForwardBase, goal: SolverGoal, constraints: PriceConstraints = NO_CONSTRAINTS): SolverAnalysis {
  const domain = priceDomain(constraints)
  const period = goal.period
  const anchorSma = anchorSmaValue(base, period)
  const anchorDir = anchorDirection(base, period)
  const free = (k: number): BarRequirement => ({ k, kind: 'free' })
  const requirements: BarRequirement[] = Array.from({ length: base.horizon }, (_, i) => free(i + 1))
  const shell: SolverAnalysis = {
    goal, status: 'unavailable', issue: null, combinator: 'all', requirements, oppositeRequirements: [], sum: null,
    anchorSma, anchorDirection: anchorDir, retained: null, sequencePlan: null, primary: null, domain, startsWithTurn: false, currentlyTarget: false,
  }
  const bars = goalBars(goal)
  if (anchorSma == null) return { ...shell, issue: 'sma_unavailable' }
  if (!Number.isInteger(bars) || bars < 1 || bars > base.horizon) return { ...shell, issue: 'bar_out_of_range' }
  if (domain.empty) return { ...shell, status: 'infeasible', issue: 'empty_domain' }

  if (goal.kind === 'level') {
    const count = Math.min(goal.bar, period)
    const fromK = goal.bar - count + 1
    const outgoingIndices = Array.from({ length: count }, (_, i) => base.anchorIndex - period + 1 + i)
    const outgoing = outgoingIndices.map((index) => base.confirmedCloses[index]!)
    const sum = outgoing.reduce((total, value) => total + value, 0)
    const op = DIRECTION_COMPARATOR[goal.relation]
    for (let k = fromK; k <= goal.bar; k += 1) requirements[k - 1] = { k, kind: 'sum_member' }
    const sums = sumDomain(domain, count)
    const sumBound = boundFor(sums, op, sum)
    // Equality on the mean is attainable exactly when the sum is (any split of the sum works).
    const meanBound = sumBound ? { value: cleanFloat(sumBound.value / count), attained: sumBound.attained } : null
    const feasible = sumBound != null
    return {
      ...shell,
      status: feasible ? 'feasible' : 'infeasible',
      issue: feasible ? null : op === '=' && domain.grid ? 'tick_excludes_equality' : 'bound_excludes_threshold',
      sum: { fromK, toK: goal.bar, count, op, sum: cleanFloat(sum), mean: cleanFloat(sum / count), outgoingIndices, meanBound, feasible },
    }
  }

  const target: SmaDirection = goalTarget(goal)
  const op = DIRECTION_COMPARATOR[target]
  const range = goal.kind === 'direction' ? [goal.bar] : Array.from({ length: bars }, (_, i) => i + 1)
  for (const k of range) {
    const requirement = requirementFor(base, domain, period, k, op)
    if (!requirement) return { ...shell, issue: 'sma_unavailable' }
    requirements[k - 1] = requirement
  }
  const listed = range.map((k) => requirements[k - 1])
  const thresholds = listed.filter((item): item is ThresholdRequirement => item.kind === 'threshold')
  const primaryOf = (item: ThresholdRequirement | undefined) =>
    item ? { k: item.k, op: item.op, value: item.value, bound: item.bound } : null
  const currentlyTarget = goal.kind !== 'reversal' && anchorDir?.direction === target
  const noPriceIssue = (single: BarRequirement | undefined): SolverIssue =>
    single?.kind === 'relative' ? 'needs_two_prices' : op === '=' && domain.grid ? 'tick_excludes_equality' : 'bound_excludes_threshold'
  /** Easiest threshold: up needs the lowest outgoing close, down the highest. */
  const easiest = () =>
    [...thresholds.filter((item) => item.feasible)].sort((x, y) => (target === 'up' ? x.value - y.value : y.value - x.value) || x.k - y.k)[0]

  if (goal.kind === 'direction') {
    const item = listed[0]
    const feasible = item.kind !== 'free' && item.kind !== 'sum_member' && item.feasible
    return {
      ...shell,
      status: feasible ? 'feasible' : 'infeasible',
      issue: feasible ? null : noPriceIssue(item),
      primary: primaryOf(thresholds[0]),
      currentlyTarget,
    }
  }

  if (goal.kind === 'within') {
    const feasible = listed.some((item) => (item.kind === 'threshold' || item.kind === 'relative') && item.feasible)
    return {
      ...shell,
      combinator: 'any',
      status: feasible ? 'feasible' : 'infeasible',
      issue: feasible ? null : thresholds.length < listed.length ? 'needs_two_prices' : noPriceIssue(listed[0]),
      primary: primaryOf(easiest() ?? thresholds[0]),
      currentlyTarget,
    }
  }

  if (goal.kind === 'reversal') {
    const retained = retainedDirection(base, period)
    if (retained.state === 'unknown') return { ...shell, issue: 'anchor_direction_unknown', combinator: 'any', retained }
    const opposite = OPPOSITE[goal.to]
    const feasibleOf = (item: BarRequirement) => (item.kind === 'threshold' || item.kind === 'relative') && item.feasible
    if (retained.direction === opposite) {
      // The retained direction is already the opposite: the first bar pointing `to` is the sign change.
      const feasible = listed.some(feasibleOf)
      return {
        ...shell,
        combinator: 'any',
        retained,
        status: feasible ? 'feasible' : 'infeasible',
        issue: feasible ? null : thresholds.length < listed.length ? 'needs_two_prices' : noPriceIssue(listed[0]),
        primary: primaryOf(easiest() ?? thresholds[0]),
      }
    }
    // Staying in (or never having left) the target direction is not a reversal: an opposite bar must come first.
    const oppositeOp = DIRECTION_COMPARATOR[opposite]
    const oppositeRequirements: BarRequirement[] = Array.from({ length: base.horizon }, (_, i) => free(i + 1))
    for (let k = 1; k <= bars; k += 1) {
      const requirement = requirementFor(base, domain, period, k, oppositeOp)
      if (!requirement) return { ...shell, issue: 'sma_unavailable', combinator: 'sequence', retained }
      oppositeRequirements[k - 1] = requirement
    }
    // The opposite bar j and the target bar k can only interact when k's outgoing close is x_j (k = j + N);
    // with strict opposite comparisons that still needs only two distinct admissible prices, which the
    // per-bar feasibility of a relative requirement already guarantees.
    let plan: { firstK: number; secondK: number } | null = null
    for (let k = 2; k <= bars && !plan; k += 1) {
      if (!feasibleOf(requirements[k - 1])) continue
      for (let j = 1; j < k; j += 1) {
        if (feasibleOf(oppositeRequirements[j - 1])) { plan = { firstK: j, secondK: k }; break }
      }
    }
    const planTarget = plan ? requirements[plan.secondK - 1] : undefined
    return {
      ...shell,
      combinator: 'sequence',
      retained,
      oppositeRequirements,
      sequencePlan: plan,
      status: plan ? 'feasible' : 'infeasible',
      issue: plan ? null : bars < 2 ? 'reversal_needs_two_bars' : thresholds.length < listed.length ? 'needs_two_prices' : noPriceIssue(listed[0]),
      primary: primaryOf(plan && planTarget?.kind === 'threshold' ? planTarget : easiest() ?? thresholds[0]),
      startsWithTurn: false,
    }
  }

  // maintain: chains r, r+N, r+2N, … must move strictly (or stay equal) within the domain.
  let issue: SolverIssue | null = null
  for (const item of thresholds) {
    const length = Math.floor((bars - item.k) / period) + 1
    const room = op === '>' ? domainCountAbove(domain, item.value) : op === '<' ? domainCountBelow(domain, item.value) : domainContains(domain, item.value) ? Infinity : 0
    if (room < length) {
      issue = room === 0 ? (op === '=' && domain.grid ? 'tick_excludes_equality' : 'bound_excludes_threshold') : 'chain_needs_more_room'
      break
    }
  }
  return {
    ...shell,
    status: issue ? 'infeasible' : 'feasible',
    issue,
    primary: primaryOf(thresholds[0]),
    startsWithTurn: anchorDir != null && anchorDir.direction !== goal.direction,
    currentlyTarget,
  }
}

// ---------------------------------------------------------------------------
// Goal checks on a concrete path

/** What the slope did after a within/reversal goal was first met (T+0 excluded, only bars ≤ N). */
export interface GoalAftermath {
  /** The slope at T+N still equals the target. */
  holdsAtEnd: boolean
  /** Every bar from the first hit through T+N equals the target. */
  heldThrough: boolean
  /** First later bar whose slope is no longer the target, and what it became. */
  lostK: number | null
  lostTo: SmaDirection | null
  /** First later bar pointing the opposite way (up/down targets only). */
  oppositeK: number | null
}

export interface GoalCheck {
  satisfied: boolean
  /** Every close the goal depends on is present. */
  complete: boolean
  /** Bars whose own requirement fails (all) or every listed bar (any, unsatisfied). */
  failedK: number[]
  /**
   * direction/level: the bar judged. within: the first bar of THIS path that matches.
   * reversal: the first sign-change bar of THIS path. maintain: null. Never a claim about other paths.
   */
  hitK: number | null
  inDomain: boolean
  outOfDomainK: number[]
  /** Level only: sign of Σ future window − Σ outgoing. */
  levelSign: -1 | 0 | 1 | null
  /** Slope at T+1..T+N on this path (null = an input is missing). Empty for level. */
  directions: Array<SmaDirection | null>
  /** within/reversal with a hit: how the target fared after it. */
  aftermath: GoalAftermath | null
}

function signToDirection(sign: -1 | 0 | 1): SmaDirection {
  return sign > 0 ? 'up' : sign < 0 ? 'down' : 'flat'
}

function directionAtBar(base: ForwardBase, period: number, closes: ReadonlyArray<number | null>, k: number): SmaDirection | null {
  const incoming = closes[k - 1]
  const src = outgoingFor(base, period, k)
  if (incoming == null || !src) return null
  const outgoing = src.kind === 'confirmed' ? src.close : closes[src.k - 1]
  return outgoing == null ? null : directionOf(incoming, outgoing)
}

function aftermathOf(directions: ReadonlyArray<SmaDirection | null>, target: SmaDirection, hitK: number): GoalAftermath {
  let lostK: number | null = null
  let lostTo: SmaDirection | null = null
  let oppositeK: number | null = null
  for (let k = hitK + 1; k <= directions.length; k += 1) {
    const direction = directions[k - 1]
    if (direction == null) continue
    if (direction !== target && lostK == null) { lostK = k; lostTo = direction }
    if (target !== 'flat' && direction === OPPOSITE[target as 'up' | 'down'] && oppositeK == null) oppositeK = k
  }
  return { holdsAtEnd: directions[directions.length - 1] === target, heldThrough: lostK == null && directions.slice(hitK - 1).every((direction) => direction === target), lostK, lostTo, oppositeK }
}

/** Exact goal test using x_k versus out_k (no SMA recomputation, cheap enough for search). */
export function checkGoal(base: ForwardBase, goal: SolverGoal, closes: ReadonlyArray<number | null>, domain?: PriceDomain): GoalCheck {
  const period = goal.period
  const bars = goalBars(goal)
  const outOfDomainK = domain
    ? closes.slice(0, base.horizon).flatMap((close, i) => (close != null && !domainContains(domain, close) ? [i + 1] : []))
    : []
  const result = (partial: Omit<GoalCheck, 'inDomain' | 'outOfDomainK' | 'directions' | 'aftermath'> & Partial<Pick<GoalCheck, 'directions' | 'aftermath'>>): GoalCheck =>
    ({ directions: [], aftermath: null, ...partial, inDomain: outOfDomainK.length === 0, outOfDomainK })
  const none = { satisfied: false, complete: false, failedK: [], hitK: null, levelSign: null }
  if (anchorSmaValue(base, period) == null || bars < 1 || bars > base.horizon) return result(none)

  if (goal.kind === 'level') {
    const count = Math.min(goal.bar, period)
    const window = closes.slice(goal.bar - count, goal.bar)
    if (window.some((close) => close == null)) return result(none)
    const outgoing = Array.from({ length: count }, (_, i) => base.confirmedCloses[base.anchorIndex - period + 1 + i]!)
    const levelSign = compareSums(window as number[], outgoing)
    const satisfied = signToDirection(levelSign) === goal.relation
    return result({ satisfied, complete: true, failedK: satisfied ? [] : [goal.bar], hitK: goal.bar, levelSign })
  }

  if (goal.kind === 'direction') {
    const direction = directionAtBar(base, period, closes, goal.bar)
    if (direction == null) return result(none)
    const satisfied = direction === goal.direction
    const directions = Array.from({ length: goal.bar }, (_, i) => directionAtBar(base, period, closes, i + 1))
    return result({ satisfied, complete: true, failedK: satisfied ? [] : [goal.bar], hitK: goal.bar, levelSign: null, directions })
  }

  const directions = Array.from({ length: bars }, (_, i) => directionAtBar(base, period, closes, i + 1))
  const complete = directions.every((value) => value != null)

  if (goal.kind === 'within') {
    const hit = directions.findIndex((value) => value === goal.direction)
    const hitK = hit >= 0 ? hit + 1 : null
    // A hit is decisive even when later inputs are missing; a miss needs every input.
    return result({
      satisfied: hitK != null,
      complete: complete || hitK != null,
      failedK: hitK != null ? [] : directions.flatMap((value, i) => (value != null ? [i + 1] : [])),
      hitK,
      levelSign: null,
      directions,
      aftermath: hitK != null ? aftermathOf(directions, goal.direction, hitK) : null,
    })
  }

  if (goal.kind === 'reversal') {
    const retained = retainedDirection(base, period)
    if (retained.state === 'unknown') return result({ ...none, directions })
    const { hitK, complete: scanned } = firstReversal(directions, goal.to, retained.direction)
    return result({
      satisfied: hitK != null,
      complete: scanned || hitK != null,
      failedK: hitK != null ? [] : directions.flatMap((value, i) => (value != null ? [i + 1] : [])),
      hitK,
      levelSign: null,
      directions,
      aftermath: hitK != null ? aftermathOf(directions, goal.to, hitK) : null,
    })
  }

  const failedK = directions.flatMap((value, i) => (value != null && value !== goal.direction ? [i + 1] : []))
  return result({ satisfied: complete && failedK.length === 0, complete, failedK, hitK: null, levelSign: null, directions })
}

// ---------------------------------------------------------------------------
// Representative paths (explicit auxiliary assumptions; never "the" answer)

export type PathAssumption = 'hold' | 'constant' | 'linear' | 'geometric'

export const PATH_ASSUMPTIONS: ReadonlyArray<{ id: PathAssumption; label: string; description: string }> = [
  { id: 'hold', label: '必要な足だけ変更', description: '価格固定 (基準日の終値) を出発点に、条件に必要な足だけを境界の直近の値へ動かす' },
  { id: 'constant', label: '全足同一価格', description: 'T+1以降の終値をすべて同じ価格 p とする' },
  { id: 'linear', label: '等差 (毎本 s)', description: '終値が毎本同じ額 s だけ変化する (T+k = 基準終値 + k·s)' },
  { id: 'geometric', label: '一定変化率 (毎本 r%)', description: '終値が毎本同じ率 r で変化する (T+k = 基準終値 × (1+r)^k)' },
]

export interface PathCandidate {
  parameter: number | null
  closes: number[]
  check: GoalCheck
}

export interface RepresentativePath {
  assumption: PathAssumption
  status: 'found' | 'not_found' | 'skipped'
  /** Price p (constant), step s (linear), rate r (geometric, fraction); null for hold. */
  parameter: number | null
  closes: number[] | null
  check: GoalCheck | null
  /** Nearest path under the same assumption that misses the goal. */
  failing: PathCandidate | null
  /** The as-of close repeated already meets the goal. */
  freezeSatisfies: boolean
  /** Parameter range scanned (constant/linear/geometric). */
  search: { from: number; to: number } | null
  /** Grid the path values were rounded to. */
  grid: PriceGrid | null
  /** Hold only: value every unchanged bar keeps (the as-of close unless constraints exclude it). */
  start: number | null
}

const SEARCH_SAMPLES = 320
const BISECT_STEPS = 60
export const LINEAR_SEARCH_PCT = 30
export const GEOMETRIC_SEARCH_PCT = 30

function familyCloses(assumption: Exclude<PathAssumption, 'hold'>, theta: number, base: ForwardBase, grid: PriceGrid | null): number[] {
  return Array.from({ length: base.horizon }, (_, i) => {
    const k = i + 1
    const raw = assumption === 'constant' ? theta : assumption === 'linear' ? base.anchorClose + k * theta : base.anchorClose * (1 + theta) ** k
    return roundToGrid(grid, raw)
  })
}

function searchRange(assumption: Exclude<PathAssumption, 'hold'>, base: ForwardBase, domain: PriceDomain): { from: number; to: number; origin: number } {
  const p0 = base.anchorClose
  if (assumption === 'constant') {
    const from = Math.max(domain.lo, p0 / 4)
    const to = Math.min(domain.hi, p0 * 4)
    return { from, to, origin: Math.min(Math.max(p0, from), to) }
  }
  if (assumption === 'linear') return { from: (-p0 * LINEAR_SEARCH_PCT) / 100, to: (p0 * LINEAR_SEARCH_PCT) / 100, origin: 0 }
  return { from: -GEOMETRIC_SEARCH_PCT / 100, to: GEOMETRIC_SEARCH_PCT / 100, origin: 0 }
}

/** Parameter closest to `origin` where `accept` holds, plus the nearest rejected parameter on that side. */
function nearestParameter(accept: (theta: number) => boolean, origin: number, from: number, to: number): { theta: number; reject: number } | null {
  let best: { theta: number; reject: number } | null = null
  for (const end of [to, from]) {
    if (end === origin) continue
    let previous = origin
    for (let i = 1; i <= SEARCH_SAMPLES; i += 1) {
      const theta = origin + (end - origin) * (i / SEARCH_SAMPLES) ** 2
      if (accept(theta)) {
        let reject = previous
        let hit = theta
        for (let step = 0; step < BISECT_STEPS; step += 1) {
          const mid = (reject + hit) / 2
          if (mid === reject || mid === hit) break
          if (accept(mid)) hit = mid
          else reject = mid
        }
        if (!best || Math.abs(hit - origin) < Math.abs(best.theta - origin)) best = { theta: hit, reject }
        break
      }
      previous = theta
    }
  }
  return best
}

function pathDomain(analysis: SolverAnalysis, grid: PriceGrid | null): PriceDomain {
  if (analysis.domain.grid || !grid) return analysis.domain
  const rawLo = gridCeil(grid, analysis.domain.lo)
  const mLo = Number.isFinite(rawLo) ? Math.max(1, rawLo) : Number.NaN
  const mHi = Number.isFinite(analysis.domain.hi) ? gridFloor(grid, analysis.domain.hi) : Infinity
  return { ...analysis.domain, grid, mLo, mHi, empty: Number.isNaN(mLo) || Number.isNaN(mHi) || mLo > mHi }
}

/** Closest grid value meeting `op bound` in the path domain; equality uses the exact bound. */
function pick(domain: PriceDomain, op: Comparator, bound: number): number | null {
  if (op === '=') return bound
  return (op === '>' ? domainMinAbove(domain, bound) : domainMaxBelow(domain, bound))?.value ?? null
}

/** Closest value that breaks `op bound`: equality for strict goals, one grid step up for flat. */
function breakValue(domain: PriceDomain, op: Comparator, bound: number): number | null {
  if (op !== '=') return bound
  return domainMinAbove(domain, bound)?.value ?? domainMaxBelow(domain, bound)?.value ?? null
}

/**
 * Start value of the hold path: the as-of close, moved onto the user's tick grid
 * and inside the user's bounds only when it is not already admissible.
 */
export function holdStart(base: ForwardBase, domain: PriceDomain): number {
  const p0 = base.anchorClose
  if (domain.empty || domainContains(domain, p0)) return p0
  if (domain.grid) {
    const m = Math.min(Math.max(Math.round(gridQuotient(domain.grid, p0)), domain.mLo), domain.mHi)
    return gridValue(domain.grid, m)
  }
  return Math.min(Math.max(p0, domain.lo), domain.hi)
}

function holdPaths(base: ForwardBase, analysis: SolverAnalysis, domain: PriceDomain): { pass: number[] | null; fail: number[] | null } {
  const goal = analysis.goal
  const p0 = holdStart(base, analysis.domain)
  const pass = priceFreezePath(p0, base.horizon)
  const outgoing = (path: number[], k: number) => {
    const src = outgoingFor(base, goal.period, k)
    return src == null ? null : src.kind === 'confirmed' ? src.close : path[src.k - 1]
  }

  if (goal.kind === 'level') {
    const sum = analysis.sum!
    const others = (path: number[]) => path.slice(sum.fromK - 1, sum.toK - 1)
    const needed = cleanFloat(sum.sum - others(pass).reduce((total, value) => total + value, 0))
    const fail = [...pass]
    const passValue = checkGoal(base, goal, pass).satisfied ? pass[sum.toK - 1] : pick(domain, sum.op, needed)
    if (passValue == null) return { pass: null, fail: null }
    pass[sum.toK - 1] = passValue
    const failValue = breakValue(domain, sum.op, needed)
    if (failValue != null) fail[sum.toK - 1] = failValue
    return { pass, fail: failValue == null ? null : fail }
  }

  const target: SmaDirection = goalTarget(goal)
  const op = DIRECTION_COMPARATOR[target]
  const bars = goalBars(goal)
  const ks = goal.kind === 'direction' ? [goal.bar] : Array.from({ length: bars }, (_, i) => i + 1)

  if (goal.kind === 'within' || goal.kind === 'reversal') {
    if (!checkGoal(base, goal, pass).satisfied) {
      let found: number[] | null = null
      if (goal.kind === 'reversal' && analysis.combinator === 'sequence') {
        // Needs an opposite bar j and a later target bar k: try every pair, keep the one closest to the as-of close.
        const oppositeOp = DIRECTION_COMPARATOR[OPPOSITE[goal.to]]
        let bestCost = Infinity
        for (let k = 2; k <= bars; k += 1) {
          for (let j = 1; j < k; j += 1) {
            const trial = priceFreezePath(p0, base.horizon)
            const first = pick(domain, oppositeOp, outgoing(trial, j) ?? NaN)
            if (first == null) continue
            trial[j - 1] = first
            const second = pick(domain, op, outgoing(trial, k) ?? NaN)
            if (second == null) continue
            trial[k - 1] = second
            const cost = Math.abs(first - p0) + Math.abs(second - p0)
            if (cost < bestCost && checkGoal(base, goal, trial, analysis.domain).satisfied) { bestCost = cost; found = trial }
          }
        }
      } else {
        // One bar is enough: move the single bar whose boundary is closest to the as-of close.
        let bestK: number | null = null
        let bestValue: number | null = null
        for (const k of ks) {
          const out = outgoing(pass, k)
          if (out == null) continue
          const value = pick(domain, op, out)
          if (value == null) continue
          if (bestValue == null || Math.abs(value - p0) < Math.abs(bestValue - p0)) { bestK = k; bestValue = value }
        }
        if (bestK != null && bestValue != null) { found = [...pass]; found[bestK - 1] = bestValue }
      }
      if (!found) return { pass: null, fail: null }
      pass.splice(0, pass.length, ...found)
    }
    // Failing comparison: from the freeze path, push every bar that meets the target back to its boundary.
    const fail = priceFreezePath(p0, base.horizon)
    for (const k of ks) {
      const out = outgoing(fail, k)
      if (out != null && compare(fail[k - 1], op, out)) fail[k - 1] = breakValue(domain, op, out) ?? fail[k - 1]
    }
    return { pass, fail }
  }

  for (const k of ks) {
    const out = outgoing(pass, k)
    if (out == null) return { pass: null, fail: null }
    if (!compare(pass[k - 1], op, out)) {
      const value = pick(domain, op, out)
      if (value == null) return { pass: null, fail: null }
      pass[k - 1] = value
    }
  }
  // Failing comparison: the same path with the first listed bar put on its breaking value.
  const fail = [...pass]
  const firstOut = outgoing(fail, ks[0])
  const broken = firstOut == null ? null : breakValue(domain, op, firstOut)
  if (broken != null) fail[ks[0] - 1] = broken
  return { pass, fail: broken == null ? null : fail }
}

export function representativePath(base: ForwardBase, analysis: SolverAnalysis, assumption: PathAssumption, displayUnit: number): RepresentativePath {
  const grid = analysis.domain.grid ?? priceGrid(displayUnit)
  const empty: RepresentativePath = { assumption, status: 'skipped', parameter: null, closes: null, check: null, failing: null, freezeSatisfies: false, search: null, grid, start: null }
  if (analysis.status !== 'feasible') return empty
  const goal = analysis.goal
  const domain = pathDomain(analysis, grid)
  const freezeSatisfies = checkGoal(base, goal, priceFreezePath(base.anchorClose, base.horizon)).satisfied
  const accepted = (closes: number[]) => {
    const check = checkGoal(base, goal, closes, analysis.domain)
    return check.satisfied && check.inDomain ? check : null
  }

  if (assumption === 'hold') {
    const { pass, fail } = holdPaths(base, analysis, domain)
    const check = pass ? accepted(pass) : null
    const failing = fail ? { parameter: null, closes: fail, check: checkGoal(base, goal, fail, analysis.domain) } : null
    const start = holdStart(base, analysis.domain)
    if (!pass || !check) return { ...empty, status: 'not_found', freezeSatisfies, failing: null, start }
    return { ...empty, status: 'found', closes: pass, check, failing: failing && !failing.check.satisfied ? failing : null, freezeSatisfies, start }
  }

  const { from, to, origin } = searchRange(assumption, base, analysis.domain)
  const closesAt = (theta: number) => familyCloses(assumption, theta, base, grid)
  const ok = (theta: number) => accepted(closesAt(theta)) != null
  const search = { from, to }
  let theta: number
  let reject: number | null
  if (ok(origin)) {
    theta = origin
    reject = nearestParameter((value) => !ok(value), origin, from, to)?.theta ?? null
  } else {
    const found = nearestParameter(ok, origin, from, to)
    if (!found) return { ...empty, status: 'not_found', freezeSatisfies, search }
    theta = found.theta
    reject = found.reject
  }
  const closes = closesAt(theta)
  const failing = reject == null ? null : { parameter: reject, closes: closesAt(reject), check: checkGoal(base, goal, closesAt(reject), analysis.domain) }
  return {
    ...empty,
    status: 'found',
    parameter: assumption === 'constant' ? closes[0] : theta,
    closes,
    check: accepted(closes),
    failing,
    freezeSatisfies,
    search,
  }
}

// ---------------------------------------------------------------------------
// Per-security simulation state (reset whenever market + ticker + analysis date changes)

export interface SolverDraft {
  kind: SolverGoalKind
  /** null: first selected SMA that can be computed. */
  period: SmaLabPeriod | null
  bar: number
  direction: SmaDirection
  /** N for within / throughout / reversal. */
  within: number
  to: 'up' | 'down'
  minText: string
  maxText: string
  tickText: string
  assumption: PathAssumption
}

export const DEFAULT_SOLVER_DRAFT: SolverDraft = {
  kind: 'direction',
  period: null,
  bar: 1,
  direction: 'up',
  within: 3,
  to: 'up',
  minText: '',
  maxText: '',
  tickText: '',
  assumption: 'hold',
}

/**
 * Applies a draft patch. Switching kind carries N across. Entering the reversal kind (and only then) points the target away from the
 * current SMA direction so the first view is a real condition; flat/unknown keeps the existing selection.
 */
export function applySolverDraftPatch(draft: SolverDraft, patch: Partial<SolverDraft>, current: SmaDirection | null): SolverDraft {
  const next = { ...draft, ...patch }
  // Switching scope keeps the chosen N (direction/level store it as `bar`, the others as `within`).
  if (patch.kind != null && patch.kind !== draft.kind && patch.bar === undefined && patch.within === undefined) {
    const n = draft.kind === 'direction' || draft.kind === 'level' ? draft.bar : draft.within
    next.bar = n
    next.within = n
  }
  if (patch.kind === 'reversal' && draft.kind !== 'reversal' && patch.to === undefined && (current === 'up' || current === 'down')) {
    next.to = current === 'up' ? 'down' : 'up'
  }
  return next
}

/** Default / longest number of future daily sessions the shared daily scenario covers. */
export const DAILY_SCENARIO_DEFAULT_SESSIONS = 3
export const DAILY_SCENARIO_MAX_SESSIONS = 60

/**
 * One shared scenario of future DAILY session closes (T+1 … T+sessions are market sessions, not bars of
 * the selected timeframe). It drives every timeframe at once (lib/sma-dynamics-daily-scenario) and is
 * independent of the selected timeframe, so switching timeframes never touches it.
 */
export interface DailyScenarioDraft extends ScenarioDraft {
  /** Sessions in scope; inputs beyond it are kept so shortening loses nothing. */
  sessions: number
}

export function emptyDailyScenario(sessions = DAILY_SCENARIO_DEFAULT_SESSIONS, unit: ScenarioUnit = 'pct'): DailyScenarioDraft {
  return { unit, sessions, inputs: Array<string>(sessions).fill('') }
}

export interface SmaSimulationState {
  identity: string
  /** Scenario drafts per timeframe and as-of date: T+k means a different bar on each timeframe. */
  scenarios: Record<string, ScenarioDraft>
  /** The shared daily scenario of this security + analysis date (same for every timeframe). */
  daily: DailyScenarioDraft
  solver: SolverDraft
}

export function simulationIdentity(market: string, ticker: string, analysisDate: string | null): string {
  return `${market}|${ticker}|${analysisDate ?? ''}`
}

export function freshSimulationState(identity: string): SmaSimulationState {
  return { identity, scenarios: {}, daily: emptyDailyScenario(), solver: DEFAULT_SOLVER_DRAFT }
}

/** State belonging to another security is never returned. */
export function scopeSimulationState(state: SmaSimulationState, identity: string): SmaSimulationState {
  return state.identity === identity ? state : freshSimulationState(identity)
}

export function scenarioKey(timeframe: SmaLabTimeframeId, asOfDate: string): string {
  return `${timeframe}|${asOfDate}`
}

export interface ParsedConstraints {
  constraints: PriceConstraints
  errors: Array<'min' | 'max' | 'tick'>
}

export function parseConstraints(draft: Pick<SolverDraft, 'minText' | 'maxText' | 'tickText'>): ParsedConstraints {
  const errors: ParsedConstraints['errors'] = []
  const read = (text: string, field: 'min' | 'max' | 'tick') => {
    const value = parseNumericText(text)
    if (value === 'invalid' || (value != null && (value <= 0 || (field === 'tick' && priceGrid(value) == null)))) {
      errors.push(field)
      return null
    }
    return value
  }
  return { constraints: { min: read(draft.minText, 'min'), max: read(draft.maxText, 'max'), tick: read(draft.tickText, 'tick') }, errors }
}

export function goalFromDraft(draft: SolverDraft, horizon: number, period: SmaLabPeriod): SolverGoal {
  const clamp = (value: number) => Math.min(Math.max(1, Math.round(value)), Math.max(1, horizon))
  switch (draft.kind) {
    case 'direction': return { kind: 'direction', period, bar: clamp(draft.bar), direction: draft.direction }
    case 'within': return { kind: 'within', period, within: clamp(draft.within), direction: draft.direction }
    case 'reversal': return { kind: 'reversal', period, within: clamp(draft.within), to: draft.to }
    case 'maintain': return { kind: 'maintain', period, through: clamp(draft.within), direction: draft.direction }
    case 'level': return { kind: 'level', period, bar: clamp(draft.bar), relation: draft.direction }
  }
}

// ---------------------------------------------------------------------------
// Copy (pure; shared by UI and tests)

export function describeGoal(goal: SolverGoal): string {
  const sma = `SMA${goal.period}`
  switch (goal.kind) {
    case 'direction': return `${sma} が T+${goal.bar} の時点で${DIRECTION_LABEL[goal.direction]} (${goal.bar === 1 ? '最終確定足' : `T+${goal.bar - 1}`} 比)`
    case 'within': return `${sma} が T+1〜T+${goal.within} のどこかで一度でも${DIRECTION_LABEL[goal.direction]}`
    case 'reversal': return `${sma} が T+1〜T+${goal.within} のどこかで${DIRECTION_LABEL[goal.to]}へ符号反転 (直近の非横ばいは${DIRECTION_LABEL[OPPOSITE[goal.to]]})`
    case 'maintain': return `${sma} が T+1〜T+${goal.through} のすべての足で${DIRECTION_LABEL[goal.direction]}`
    case 'level': return `${sma} の T+${goal.bar} の値が${LEVEL_LABEL[goal.relation]}`
  }
}

export function describeSolverIssue(issue: SolverIssue, barNoun: string): string {
  switch (issue) {
    case 'sma_unavailable': return `このSMAは基準日時点で計算できません (${barNoun}の確定終値が不足しているか、窓内に使用できない終値があります)。`
    case 'anchor_direction_unknown': return `現在の向きを判定するには ${barNoun} が SMA期間 + 1 本必要です。`
    case 'bar_out_of_range': return '指定した足が将来投影の本数を超えています。'
    case 'empty_domain': return '下限・上限・刻みを同時に満たす価格がありません。'
    case 'already_in_target_direction': return '現在すでに目標の向きです (転換の前提となる反対方向ではありません)。'
    case 'anchor_flat': return '現在のSMAは厳密に横ばいです (転換の前提となる反対方向ではありません)。'
    case 'bound_excludes_threshold': return '指定した下限・上限の範囲内に、条件を満たす終値がありません。'
    case 'tick_excludes_equality': return '必要な終値が指定した刻みに乗らないため、厳密な横ばい・同値は実現できません。'
    case 'chain_needs_more_room': return `計算窓から抜ける将来の終値も同じ条件を満たす必要があり、指定範囲・刻みでは必要な本数の価格を確保できません。`
    case 'reversal_needs_two_bars': return '転換 (符号反転) は「反対向き→目標の向き」の2段階が必要なため、現在の向きでは1本以内では成立しません。本数を2本以上にしてください。'
    case 'needs_two_prices': return '条件には異なる2つ以上の価格が必要ですが、指定範囲・刻みでは1つしか取れません。'
  }
}
