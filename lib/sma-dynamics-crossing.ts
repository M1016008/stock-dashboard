// SMA Dynamics Lab: inverse solver for touch / cross goals (pure, no I/O).
//
// "Which close at bar T+k makes the close, or an SMA, touch or cross an SMA?"
//
// Exactness. With every earlier close fixed, the gap at bar k is affine in the one unknown close x:
//   close − SMA_q   = x·(1 − 1/q)  − S_q/q
//   SMA_p − SMA_q   = x·(1/p − 1/q) + S_p/p − S_q/q        (S_n = sum of the n−1 closes before x)
// so the boundary x* where the gap is zero is exact, and the side of x* that satisfies the goal follows
// from the sign of the slope. Tick and min/max constraints reuse the Phase 2 price domain.
//
// Auxiliary assumption. The closes between the as-of bar and bar k are NOT free in this module: they
// are the prior path the caller gives (price freeze by default, or the user's scenario). The answer is
// therefore "given that path up to T+k−1, the close at T+k must be …", never "the minimum over all paths".
//
// Cross semantics. subject crosses up through reference at bar k when the last strict side before k
// was below and diff(k) > 0 (down: above → diff(k) < 0). Touching and bouncing back is not a cross.
// Touch uses closes only: the intrabar high/low of a future bar is unknown.
import { smaAt } from '@/lib/timeframes'
import type { OHLCV } from '@/types/stock'
import type { SmaLabPeriod } from '@/lib/sma-dynamics-lab'
import {
  cleanFloat,
  domainContains,
  domainMaxBelow,
  domainMinAbove,
  priceDomain,
  gridCeil,
  gridFloor,
  gridValue,
  NO_CONSTRAINTS,
  type BoundValue,
  type ForwardBase,
  type PriceConstraints,
  type PriceDomain,
} from '@/lib/sma-dynamics-scenario'
import { findCrosses, gapSeries, lastStrictSide, type GapPoint } from '@/lib/sma-dynamics-geometry'

export type CrossingSubject = { kind: 'close' } | { kind: 'sma'; period: SmaLabPeriod }
export type CrossingRelation = 'above' | 'below'
export type CrossingDirection = 'up' | 'down'

export type CrossingGoal =
  /** At bar `bar`, subject equals reference (to the tick when a grid is given). */
  | { kind: 'touch'; subject: CrossingSubject; reference: SmaLabPeriod; bar: number }
  /** At bar `bar`, subject is above / below reference. */
  | { kind: 'relation'; subject: CrossingSubject; reference: SmaLabPeriod; bar: number; relation: CrossingRelation }
  /** A real crossing at one or more bars of T+1..T+within. */
  | { kind: 'cross'; subject: CrossingSubject; reference: SmaLabPeriod; within: number; direction: CrossingDirection }

export type CrossingGoalKind = CrossingGoal['kind']
export const CROSSING_GOAL_KINDS: ReadonlyArray<{ id: CrossingGoalKind; label: string; title: string }> = [
  { id: 'cross', label: 'N本以内に交差', title: 'T+1〜T+N のどこかで、下から上 (または上から下) へ実際に入れ替わる' },
  { id: 'touch', label: 'N本後に接触', title: 'T+N の時点でぴったり同値になる' },
  { id: 'relation', label: 'N本後の位置', title: 'T+N の時点で上 (または下) にいる' },
]

export function crossingGoalBars(goal: CrossingGoal): number {
  return goal.kind === 'cross' ? goal.within : goal.bar
}

export function subjectPeriod(subject: CrossingSubject): SmaLabPeriod | null {
  return subject.kind === 'sma' ? subject.period : null
}

/** Periods the goal needs computed (the subject's and the reference's SMA). */
export function crossingGoalPeriods(goal: CrossingGoal): SmaLabPeriod[] {
  const periods = [goal.reference]
  if (goal.subject.kind === 'sma') periods.push(goal.subject.period)
  return [...new Set(periods)].sort((a, b) => a - b)
}

export function isValidCrossingGoal(goal: CrossingGoal, horizon: number): boolean {
  if (goal.subject.kind === 'sma' && goal.subject.period === goal.reference) return false
  const bars = crossingGoalBars(goal)
  return Number.isInteger(bars) && bars >= 1 && bars <= horizon
}

// ---------------------------------------------------------------------------
// Series (same summation order as smaAt, so values match the lab's lines exactly)

function closeRows(closes: ReadonlyArray<number | null>): OHLCV[] {
  return closes.map((close, index) => {
    const value = close ?? Number.NaN
    return { date: String(index), open: value, high: value, low: value, close: value, volume: 0 }
  })
}

/** SMA at every index of `closes` (null where the window is short or holds a missing close). */
export function smaOver(closes: ReadonlyArray<number | null>, period: number): Array<number | null> {
  const rows = closeRows(closes)
  return closes.map((_, index) => smaAt(rows, period, index))
}

function subjectSeries(subject: CrossingSubject, closes: ReadonlyArray<number | null>): ReadonlyArray<number | null> {
  return subject.kind === 'close' ? closes : smaOver(closes, subject.period)
}

/** Gap of the subject against the reference over `closes` (confirmed + prior path). */
export function crossingGaps(goal: Pick<CrossingGoal, 'subject' | 'reference'>, closes: ReadonlyArray<number | null>): GapPoint[] {
  return gapSeries(subjectSeries(goal.subject, closes), smaOver(closes, goal.reference))
}

// ---------------------------------------------------------------------------
// Affine gap at bar k

export interface AffineGap {
  /** gap(x) = c0 + c1·x for the unknown close x at the bar. */
  c0: number
  c1: number
}

function tailSum(closes: ReadonlyArray<number | null>, count: number): number | null {
  if (closes.length < count) return null
  let sum = 0
  for (let i = closes.length - count; i < closes.length; i += 1) {
    const value = closes[i]
    if (value == null || !Number.isFinite(value)) return null
    sum += value
  }
  return sum
}

/** gap(x) of the next close x given the closes before it; null when a window is short or incomplete. */
export function affineGap(goal: Pick<CrossingGoal, 'subject' | 'reference'>, before: ReadonlyArray<number | null>): AffineGap | null {
  const q = goal.reference
  const sq = tailSum(before, q - 1)
  if (sq == null) return null
  if (goal.subject.kind === 'close') {
    return { c0: -sq / q, c1: 1 - 1 / q }
  }
  const p = goal.subject.period
  const sp = tailSum(before, p - 1)
  if (sp == null) return null
  return { c0: sp / p - sq / q, c1: 1 / p - 1 / q }
}

// ---------------------------------------------------------------------------
// Solve

export type CrossingBarStatus =
  /** The required close exists (see op / bound). */
  | 'feasible'
  /** The condition cannot be met at this bar under the constraints. */
  | 'infeasible'
  /** The side before the bar rules the goal out (already above, for an up-cross). */
  | 'precondition_failed'
  /** A window is too short, holds an unusable close, or the prior path has a gap. */
  | 'unavailable'

export type CrossingIssue =
  | 'sma_unavailable'
  | 'prior_missing'
  | 'already_on_target_side'
  | 'side_unknown'
  | 'same_line'
  | 'bar_out_of_range'
  | 'bound_excludes_threshold'
  | 'tick_excludes_equality'
  | 'no_admissible_price'

export interface CrossingBar {
  k: number
  status: CrossingBarStatus
  issue: CrossingIssue | null
  /** Zero of the affine gap (the boundary close), unrounded. */
  threshold: number | null
  /** Required relation of x_k to the threshold: '>' | '<' | '='. */
  op: '>' | '<' | '=' | null
  /** Closest admissible close on the satisfying side (tick-aware). */
  bound: BoundValue | null
  /** For touch on a tick grid: the grid prices on either side of an off-grid threshold. */
  neighbours: { below: number | null; above: number | null } | null
  /** Boundary relative to the as-of close, percent. */
  pctFromAnchor: number | null
  /** Side of the gap just before the bar (last strict side), −1 below / 1 above. */
  sideBefore: -1 | 1 | null
}

export type CrossingStatus = 'feasible' | 'infeasible' | 'precondition_failed' | 'unavailable'

export interface CrossingAnalysis {
  goal: CrossingGoal
  status: CrossingStatus
  issue: CrossingIssue | null
  bars: CrossingBar[]
  /** The bar that needs the smallest move from the as-of close (earliest on ties). */
  recommended: CrossingBar | null
  /** First bar at which the goal already holds on the prior path itself (no change needed). */
  natural: { k: number } | null
  domain: PriceDomain
}

function bound(domain: PriceDomain, op: '>' | '<' | '=', threshold: number): BoundValue | null {
  if (op === '>') return domainMinAbove(domain, threshold)
  if (op === '<') return domainMaxBelow(domain, threshold)
  return domainContains(domain, threshold) ? { value: threshold, attained: true } : null
}

function unavailableBar(k: number, issue: CrossingIssue): CrossingBar {
  return { k, status: 'unavailable', issue, threshold: null, op: null, bound: null, neighbours: null, pctFromAnchor: null, sideBefore: null }
}

function requirementFor(goal: CrossingGoal, side: -1 | 1 | null, c1: number): { op: '>' | '<' | '='; failure: CrossingIssue | null } {
  // gap(x) > 0 <=> x > x* when c1 > 0, x < x* when c1 < 0.
  const above: '>' | '<' = c1 > 0 ? '>' : '<'
  const below: '>' | '<' = c1 > 0 ? '<' : '>'
  if (goal.kind === 'touch') return { op: '=', failure: null }
  if (goal.kind === 'relation') return { op: goal.relation === 'above' ? above : below, failure: null }
  if (side == null) return { op: above, failure: 'side_unknown' }
  if (goal.direction === 'up') return { op: above, failure: side === -1 ? null : 'already_on_target_side' }
  return { op: below, failure: side === 1 ? null : 'already_on_target_side' }
}

interface SolveContext {
  domain: PriceDomain
  /** Gap series over the confirmed closes then the whole prior path (causal: value i never depends on later closes). */
  gaps: GapPoint[] | null
  /** Every involved SMA exists at the as-of bar. */
  anchorsReady: boolean
}

function solveBar(base: ForwardBase, goal: CrossingGoal, prior: ReadonlyArray<number | null>, k: number, context: SolveContext): CrossingBar {
  const { domain } = context
  if (prior.length < k - 1 || prior.slice(0, k - 1).some((value) => value == null || !Number.isFinite(value))) return unavailableBar(k, 'prior_missing')
  const before = [...base.confirmedCloses, ...prior.slice(0, k - 1)]
  const affine = affineGap(goal, before)
  if (!affine || affine.c1 === 0) return unavailableBar(k, affine ? 'same_line' : 'sma_unavailable')
  // Every SMA involved must already exist at the as-of bar (history is never padded).
  if (!context.anchorsReady) return unavailableBar(k, 'sma_unavailable')
  const side = goal.kind === 'cross' && context.gaps ? lastStrictSide(context.gaps, before.length - 1) : null
  const { op, failure } = requirementFor(goal, side, affine.c1)
  const threshold = cleanFloat(-affine.c0 / affine.c1)
  const pctFromAnchor = cleanFloat((threshold / base.anchorClose - 1) * 100)
  if (failure) {
    return { k, status: failure === 'side_unknown' ? 'unavailable' : 'precondition_failed', issue: failure, threshold, op, bound: null, neighbours: null, pctFromAnchor, sideBefore: side }
  }
  const limit = bound(domain, op, threshold)
  let neighbours: CrossingBar['neighbours'] = null
  if (op === '=' && domain.grid) {
    const lo = gridFloor(domain.grid, threshold)
    const hi = gridCeil(domain.grid, threshold)
    const admissible = (m: number) => m >= domain.mLo && m <= domain.mHi
    neighbours = { below: admissible(lo) ? gridValue(domain.grid, lo) : null, above: admissible(hi) ? gridValue(domain.grid, hi) : null }
  }
  if (!limit) {
    const issue: CrossingIssue = op === '=' ? (domain.grid ? 'tick_excludes_equality' : 'bound_excludes_threshold') : domain.empty ? 'no_admissible_price' : 'bound_excludes_threshold'
    return { k, status: 'infeasible', issue, threshold, op, bound: null, neighbours, pctFromAnchor, sideBefore: side }
  }
  return { k, status: 'feasible', issue: null, threshold, op, bound: limit, neighbours, pctFromAnchor, sideBefore: side }
}

/** True when the goal already holds on the prior path itself, returning the first such bar. */
function naturalHit(base: ForwardBase, goal: CrossingGoal, prior: ReadonlyArray<number | null>, bars: number, domain: PriceDomain): { k: number } | null {
  const outcome = evaluateCrossingGoal(base, goal, prior.slice(0, bars))
  if (outcome.hitK == null) return null
  const used = prior.slice(0, outcome.hitK)
  if (used.some((value) => value == null || !domainContains(domain, value))) return null
  return { k: outcome.hitK }
}

export function holdPrior(base: Pick<ForwardBase, 'anchorClose'>, bars: number): number[] {
  return Array<number>(bars).fill(base.anchorClose)
}

export function analyzeCrossingGoal(
  base: ForwardBase,
  goal: CrossingGoal,
  prior: ReadonlyArray<number | null>,
  constraints: PriceConstraints = NO_CONSTRAINTS,
): CrossingAnalysis {
  const domain = priceDomain(constraints)
  const n = crossingGoalBars(goal)
  const shell = { goal, bars: [] as CrossingBar[], recommended: null, natural: null, domain }
  if (!isValidCrossingGoal(goal, base.horizon)) {
    const issue: CrossingIssue = goal.subject.kind === 'sma' && goal.subject.period === goal.reference ? 'same_line' : 'bar_out_of_range'
    return { ...shell, status: 'unavailable', issue }
  }
  const ks = goal.kind === 'cross' ? Array.from({ length: n }, (_, i) => i + 1) : [n]
  const anchorsReady = crossingGoalPeriods(goal).every((period) => (smaOver(base.confirmedCloses, period).at(-1) ?? null) != null)
  const gaps = goal.kind === 'cross' && anchorsReady ? crossingGaps(goal, [...base.confirmedCloses, ...prior]) : null
  const bars = ks.map((k) => solveBar(base, goal, prior, k, { domain, gaps, anchorsReady }))
  const feasible = bars.filter((bar) => bar.status === 'feasible')
  const recommended = feasible.length === 0
    ? null
    : feasible.reduce((best, bar) => {
        const move = (item: CrossingBar) => Math.abs((item.bound?.value ?? Infinity) / base.anchorClose - 1)
        return move(bar) < move(best) - 1e-12 ? bar : best
      })
  const natural = naturalHit(base, goal, prior, n, domain)
  const status: CrossingStatus = natural || recommended
    ? 'feasible'
    : bars.every((bar) => bar.status === 'unavailable')
      ? 'unavailable'
      : bars.some((bar) => bar.status === 'infeasible') ? 'infeasible' : bars.every((bar) => bar.status === 'precondition_failed') ? 'precondition_failed' : 'infeasible'
  const issue = natural || recommended ? null : (bars.find((bar) => bar.issue)?.issue ?? null)
  return { goal, status, issue, bars, recommended, natural, domain }
}

// ---------------------------------------------------------------------------
// Forward check (the independent oracle the tests compare the solver with)

export interface CrossingOutcome {
  met: boolean
  /** First bar at which the goal holds (cross: the first matching crossing). */
  hitK: number | null
  /** Gap per future bar, percent (null where unavailable). */
  gapPct: Array<number | null>
}

/** Evaluates a goal on an explicit future path of closes (no solving, only recomputation). */
export function evaluateCrossingGoal(base: ForwardBase, goal: CrossingGoal, futureCloses: ReadonlyArray<number | null>): CrossingOutcome {
  const closes = [...base.confirmedCloses, ...futureCloses]
  const gaps = crossingGaps(goal, closes)
  const anchor = base.anchorIndex
  const future = gaps.slice(anchor + 1)
  const gapPct = future.map((point) => point.gapPct)
  const n = crossingGoalBars(goal)
  if (goal.kind === 'cross') {
    const events = findCrosses(gaps, anchor, goal.subject.kind === 'close' ? 'close' : goal.subject.period, goal.reference)
      .filter((event) => event.direction === goal.direction && event.index > anchor && event.index - anchor <= n)
    return { met: events.length > 0, hitK: events.length > 0 ? events[0].index - anchor : null, gapPct }
  }
  const point = gaps[anchor + n]
  if (!point || point.side == null) return { met: false, hitK: null, gapPct }
  const met = goal.kind === 'touch' ? point.side === 0 : goal.relation === 'above' ? point.side === 1 : point.side === -1
  return { met, hitK: met ? n : null, gapPct }
}

// ---------------------------------------------------------------------------
// Example path

/**
 * The prior path up to bar k−1, then a close at the boundary at bar k, then that close held. When the boundary is only
 * an infimum (continuous prices, strict inequality) the example steps `step` beyond it; it is one example, not the
 * unique answer.
 */
export function crossingExamplePath(
  base: ForwardBase,
  bar: CrossingBar,
  prior: ReadonlyArray<number | null>,
  step: number,
  domain: PriceDomain = priceDomain(NO_CONSTRAINTS),
): number[] | null {
  if (bar.status !== 'feasible' || !bar.bound || bar.op == null) return null
  const before = prior.slice(0, bar.k - 1)
  if (before.some((value) => value == null)) return null
  let close = bar.bound.value
  if (!bar.bound.attained) {
    const requestedStep = Number.isFinite(step) && step > 0 ? step : Math.max(1, Math.abs(close)) * Number.EPSILON * 8
    if (bar.op === '>') {
      const room = domain.hi - close
      if (!(room > 0)) return null
      close += Number.isFinite(room) ? Math.min(requestedStep, room / 2) : requestedStep
    } else if (bar.op === '<') {
      const room = close - domain.lo
      if (!(room > 0)) return null
      close -= Math.min(requestedStep, room / 2)
    }
  }
  if (!domainContains(domain, close)) return null
  if (bar.op === '>' && !(close > bar.threshold!)) return null
  if (bar.op === '<' && !(close < bar.threshold!)) return null
  const path = [...(before as number[]), close]
  while (path.length < base.horizon) path.push(close)
  return path
}
