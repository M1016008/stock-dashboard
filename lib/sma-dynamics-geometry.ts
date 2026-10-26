// SMA Dynamics Lab: shape of the SMA family on one timeline (pure, no I/O).
//
// The timeline is the confirmed history followed by an assumed future close path (price freeze,
// scenario or solver path). Nothing here forecasts: every future value is whatever the assumed
// path implies for the rolling windows.
//
// Definitions (all per bar of the selected timeframe, in percent so securities compare):
// - slope      s[t] = (SMA[t] − SMA[t−1]) / SMA[t−1] × 100
// - curvature  c[t] = s[t] − s[t−1]   (change of slope; > 0 = bending upward)
// - gap        g[t] = (SMA_short − SMA_long) / SMA_long × 100 for a pair, or
//                     (close − SMA) / SMA × 100 for price against one SMA
// - convergence: |g| shrinks bar over bar, divergence: |g| grows, beyond a small tolerance
// - cross      the side of g changes sign (a touch, g = 0, is not a cross unless the other side follows)
import type { SmaLabAvailable, SmaLabPeriod } from '@/lib/sma-dynamics-lab'
import type { ForwardBase } from '@/lib/sma-dynamics-scenario'

/** Same threshold the lab uses to call a slope "flat" on screen (percent of the previous SMA). */
export const SHAPE_FLAT_SLOPE_PCT = 0.01
/** Curvature below this (percentage points per bar) is reported as steady. */
export const SHAPE_STEADY_CURVATURE_PCT = 0.005
/** A gap change smaller than this (percentage points per bar) is neither converging nor diverging. */
export const SHAPE_STEADY_GAP_CHANGE_PCT = 0.005
/** Relative tolerance for "exactly touching". */
const TOUCH_EPS = 1e-9

export interface ShapeTimeline {
  /** Confirmed closes then assumed closes; null = unusable or not entered. */
  closes: ReadonlyArray<number | null>
  /** One SMA series per period, aligned with `closes`. */
  sma: Readonly<Record<SmaLabPeriod, ReadonlyArray<number | null>>>
  /** Index of the last confirmed bar (as-of). Later indexes are assumptions. */
  anchorIndex: number
}

/** Confirmed bars from the lab result followed by the given future closes and their SMA series. */
export function buildShapeTimeline(
  result: Pick<SmaLabAvailable, 'sma'>,
  base: Pick<ForwardBase, 'confirmedCloses' | 'anchorIndex'>,
  futureCloses: ReadonlyArray<number | null>,
  futureSma: Readonly<Record<SmaLabPeriod, ReadonlyArray<number | null>>>,
  periods: ReadonlyArray<SmaLabPeriod>,
): ShapeTimeline {
  const confirmedCount = base.anchorIndex + 1
  const sma: Record<SmaLabPeriod, ReadonlyArray<number | null>> = {}
  for (const period of periods) {
    sma[period] = [...(result.sma[period] ?? []).slice(0, confirmedCount), ...(futureSma[period] ?? futureCloses.map(() => null))]
  }
  return { closes: [...base.confirmedCloses, ...futureCloses], sma, anchorIndex: base.anchorIndex }
}

export function isFuture(timeline: Pick<ShapeTimeline, 'anchorIndex'>, index: number): boolean {
  return index > timeline.anchorIndex
}

// ---------------------------------------------------------------------------
// Slope and curvature

export type SlopeClass = 'up' | 'flat' | 'down'
export type CurveClass = 'bending_up' | 'steady' | 'bending_down'
/** Slope direction combined with curvature, in the words the UI uses. */
export type ShapeClass = 'rising_faster' | 'rising_slower' | 'falling_faster' | 'falling_slower' | 'flat_turning_up' | 'flat_turning_down' | 'flat_steady'

export interface SlopePoint {
  index: number
  slopePct: number | null
  slope: SlopeClass | null
  curvaturePct: number | null
  curve: CurveClass | null
  shape: ShapeClass | null
}

export function classifySlope(slopePct: number): SlopeClass {
  return Math.abs(slopePct) <= SHAPE_FLAT_SLOPE_PCT ? 'flat' : slopePct > 0 ? 'up' : 'down'
}

export function classifyCurvature(curvaturePct: number): CurveClass {
  return Math.abs(curvaturePct) <= SHAPE_STEADY_CURVATURE_PCT ? 'steady' : curvaturePct > 0 ? 'bending_up' : 'bending_down'
}

export function classifyShape(slope: SlopeClass, curve: CurveClass): ShapeClass {
  if (slope === 'up') return curve === 'bending_up' ? 'rising_faster' : curve === 'bending_down' ? 'rising_slower' : 'rising_faster'
  if (slope === 'down') return curve === 'bending_down' ? 'falling_faster' : curve === 'bending_up' ? 'falling_slower' : 'falling_faster'
  return curve === 'bending_up' ? 'flat_turning_up' : curve === 'bending_down' ? 'flat_turning_down' : 'flat_steady'
}

export const SHAPE_LABEL: Record<ShapeClass, string> = {
  rising_faster: '上向き・勢いが増す',
  rising_slower: '上向き・勢いが弱まる',
  falling_faster: '下向き・勢いが増す',
  falling_slower: '下向き・勢いが弱まる',
  flat_turning_up: '横ばい・上向きに傾く',
  flat_turning_down: '横ばい・下向きに傾く',
  flat_steady: '横ばい・変化なし',
}

/** "上向き・勢いが増す" is only accurate for a steady slope when it keeps its direction; steady rising/falling is named plainly. */
export function describeShape(point: Pick<SlopePoint, 'slope' | 'curve' | 'shape'>): string {
  if (!point.slope || !point.curve || !point.shape) return '判定できません'
  if (point.curve === 'steady') {
    return point.slope === 'up' ? '上向き・傾きは一定' : point.slope === 'down' ? '下向き・傾きは一定' : '横ばい・変化なし'
  }
  return SHAPE_LABEL[point.shape]
}

function slopeAt(series: ReadonlyArray<number | null>, index: number): number | null {
  const current = series[index]
  const previous = series[index - 1]
  if (current == null || previous == null || previous === 0 || !Number.isFinite(current) || !Number.isFinite(previous)) return null
  return ((current - previous) / previous) * 100
}

export function slopeSeries(series: ReadonlyArray<number | null>): SlopePoint[] {
  const slopes = series.map((_, index) => slopeAt(series, index))
  return series.map((_, index) => {
    const slopePct = slopes[index]
    const previous = index > 0 ? slopes[index - 1] : null
    const curvaturePct = slopePct != null && previous != null ? slopePct - previous : null
    const slope = slopePct == null ? null : classifySlope(slopePct)
    const curve = curvaturePct == null ? null : classifyCurvature(curvaturePct)
    return { index, slopePct, slope, curvaturePct, curve, shape: slope && curve ? classifyShape(slope, curve) : null }
  })
}

// ---------------------------------------------------------------------------
// Gap between two lines: SMA vs SMA, or close vs SMA

export type Side = -1 | 0 | 1
export type GapTrend = 'converging' | 'diverging' | 'steady'

export interface GapPoint {
  index: number
  gapPct: number | null
  side: Side | null
  /** Change of |gap| from the previous bar, percentage points. */
  absChangePct: number | null
  trend: GapTrend | null
}

function sideOf(a: number, b: number): Side {
  return Math.abs(a - b) <= TOUCH_EPS * Math.max(Math.abs(a), Math.abs(b), 1) ? 0 : a > b ? 1 : -1
}

/** Gap of `a` relative to `b` per bar: (a − b) / b × 100. */
export function gapSeries(a: ReadonlyArray<number | null>, b: ReadonlyArray<number | null>): GapPoint[] {
  const gaps = a.map((value, index) => {
    const other = b[index]
    if (value == null || other == null || other === 0 || !Number.isFinite(value) || !Number.isFinite(other)) return null
    return { gap: ((value - other) / other) * 100, side: sideOf(value, other) }
  })
  return a.map((_, index) => {
    const now = gaps[index]
    const before = index > 0 ? gaps[index - 1] : null
    const absChangePct = now && before ? Math.abs(now.gap) - Math.abs(before.gap) : null
    const trend: GapTrend | null = absChangePct == null
      ? null
      : Math.abs(absChangePct) <= SHAPE_STEADY_GAP_CHANGE_PCT ? 'steady' : absChangePct < 0 ? 'converging' : 'diverging'
    return { index, gapPct: now ? now.gap : null, side: now ? now.side : null, absChangePct, trend }
  })
}

export const GAP_TREND_LABEL: Record<GapTrend, string> = { converging: '収束', diverging: '拡散', steady: '横ばい' }

// ---------------------------------------------------------------------------
// Crossings

export type CrossDirection = 'up' | 'down'
export type CrossSubject = 'close' | number

export interface CrossEvent {
  /** What crossed (a close, or the SMA of this period) ... */
  subject: CrossSubject
  /** ... through the SMA of this period. */
  reference: SmaLabPeriod
  /** up: subject moved from below to above the reference. */
  direction: CrossDirection
  /** First bar on the new side. */
  index: number
  /** Bar before, on the old side (or touching it). */
  fromIndex: number
  /** A bar in between where the two were exactly equal, if any. */
  touchIndex: number | null
  phase: 'past' | 'future'
}

/**
 * Crossings of a gap series. A cross needs the last strict side to be the opposite of the new strict side,
 * so touching and bouncing back, or starting from an exact tie, is not a cross. A missing value ends the chain.
 */
export function findCrosses(
  gaps: ReadonlyArray<GapPoint>,
  anchorIndex: number,
  subject: CrossSubject,
  reference: SmaLabPeriod,
): CrossEvent[] {
  const events: CrossEvent[] = []
  let lastStrict: { side: -1 | 1; index: number } | null = null
  let touch: number | null = null
  for (const point of gaps) {
    if (point.side == null) {
      lastStrict = null
      touch = null
      continue
    }
    if (point.side === 0) {
      if (lastStrict && touch == null) touch = point.index
      continue
    }
    if (lastStrict && lastStrict.side !== point.side) {
      events.push({
        subject,
        reference,
        direction: point.side > 0 ? 'up' : 'down',
        index: point.index,
        fromIndex: point.index - 1,
        touchIndex: touch,
        phase: point.index > anchorIndex ? 'future' : 'past',
      })
    }
    lastStrict = { side: point.side, index: point.index }
    touch = null
  }
  return events
}

/** Last strict side at or before `index` (skipping exact ties), or null if unknown/missing. */
export function lastStrictSide(gaps: ReadonlyArray<GapPoint>, index: number): -1 | 1 | null {
  for (let i = index; i >= 0; i -= 1) {
    const side = gaps[i]?.side
    if (side == null) return null
    if (side !== 0) return side
  }
  return null
}

// ---------------------------------------------------------------------------
// Whole-family analysis

export interface PairShape {
  shorter: SmaLabPeriod
  longer: SmaLabPeriod
  points: GapPoint[]
  crosses: CrossEvent[]
}

export interface CloseShape {
  period: SmaLabPeriod
  points: GapPoint[]
  crosses: CrossEvent[]
}

export interface BandPoint {
  index: number
  /** (max SMA − min SMA) / min SMA × 100 across the selected SMAs. */
  widthPct: number | null
  trend: GapTrend | null
}

export type SmaOrderKind = 'bullish' | 'bearish' | 'mixed'
export interface OrderPoint {
  index: number
  /** Periods from the highest SMA value to the lowest. */
  ranking: SmaLabPeriod[] | null
  kind: SmaOrderKind | null
}

export interface ShapeAnalysis {
  periods: SmaLabPeriod[]
  slopes: Record<SmaLabPeriod, SlopePoint[]>
  /** Adjacent periods only (SMA a vs the next longer SMA). */
  pairs: PairShape[]
  /** Price against each selected SMA. */
  closes: CloseShape[]
  band: BandPoint[]
  order: OrderPoint[]
  /** Every cross, past and future, chronological. */
  crosses: CrossEvent[]
}

export function adjacentPairs(periods: ReadonlyArray<SmaLabPeriod>): Array<[SmaLabPeriod, SmaLabPeriod]> {
  const sorted = [...periods].sort((a, b) => a - b)
  return sorted.slice(1).map((longer, i) => [sorted[i], longer])
}

function orderOf(values: Array<{ period: SmaLabPeriod; value: number }>): OrderPoint['kind'] {
  if (values.length < 2) return null
  const sorted = [...values].sort((a, b) => a.period - b.period)
  let descending = true
  let ascending = true
  for (let i = 1; i < sorted.length; i += 1) {
    if (!(sorted[i - 1].value > sorted[i].value)) descending = false
    if (!(sorted[i - 1].value < sorted[i].value)) ascending = false
  }
  return descending ? 'bullish' : ascending ? 'bearish' : 'mixed'
}

export function analyzeShape(timeline: ShapeTimeline, periods: ReadonlyArray<SmaLabPeriod>): ShapeAnalysis {
  const sorted = [...new Set(periods)].sort((a, b) => a - b)
  const length = timeline.closes.length
  const slopes: Record<SmaLabPeriod, SlopePoint[]> = {}
  for (const period of sorted) slopes[period] = slopeSeries(timeline.sma[period] ?? Array(length).fill(null))

  const pairs: PairShape[] = adjacentPairs(sorted).map(([shorter, longer]) => {
    const points = gapSeries(timeline.sma[shorter] ?? [], timeline.sma[longer] ?? [])
    return { shorter, longer, points, crosses: findCrosses(points, timeline.anchorIndex, shorter, longer) }
  })
  const closes: CloseShape[] = sorted.map((period) => {
    const points = gapSeries(timeline.closes, timeline.sma[period] ?? [])
    return { period, points, crosses: findCrosses(points, timeline.anchorIndex, 'close', period) }
  })

  const band: BandPoint[] = []
  const order: OrderPoint[] = []
  for (let index = 0; index < length; index += 1) {
    const values: Array<{ period: SmaLabPeriod; value: number }> = []
    for (const period of sorted) {
      const value = timeline.sma[period]?.[index]
      if (value != null && Number.isFinite(value)) values.push({ period, value })
    }
    const complete = sorted.length >= 2 && values.length === sorted.length
    const min = complete ? Math.min(...values.map((item) => item.value)) : null
    const max = complete ? Math.max(...values.map((item) => item.value)) : null
    const widthPct = min != null && max != null && min > 0 ? ((max - min) / min) * 100 : null
    const previous = index > 0 ? band[index - 1].widthPct : null
    const change = widthPct != null && previous != null ? widthPct - previous : null
    band.push({
      index,
      widthPct,
      trend: change == null ? null : Math.abs(change) <= SHAPE_STEADY_GAP_CHANGE_PCT ? 'steady' : change < 0 ? 'converging' : 'diverging',
    })
    order.push({
      index,
      ranking: complete ? [...values].sort((a, b) => b.value - a.value).map((item) => item.period) : null,
      kind: complete ? orderOf(values) : null,
    })
  }

  const crosses = [...pairs.flatMap((pair) => pair.crosses), ...closes.flatMap((item) => item.crosses)]
    .sort((a, b) => a.index - b.index || String(a.subject).localeCompare(String(b.subject)) || a.reference - b.reference)
  return { periods: sorted, slopes, pairs, closes, band, order, crosses }
}

export const ORDER_LABEL: Record<SmaOrderKind, string> = {
  bullish: '短期が上 (パーフェクトオーダー)',
  bearish: '短期が下 (逆パーフェクトオーダー)',
  mixed: '入り交じり',
}

/** "SMA5 が SMA25 を上に抜ける" / "終値が SMA25 を下に抜ける". */
export function describeCross(event: Pick<CrossEvent, 'subject' | 'reference' | 'direction'>): string {
  const who = event.subject === 'close' ? '終値' : `SMA${event.subject}`
  return `${who} が SMA${event.reference} を${event.direction === 'up' ? '上' : '下'}に抜ける`
}

/** Name for pair crosses in trading vocabulary, only when the pair is short (SMA) against long (SMA). */
export function crossName(event: Pick<CrossEvent, 'subject' | 'direction'>): string | null {
  if (event.subject === 'close') return null
  return event.direction === 'up' ? 'ゴールデンクロス' : 'デッドクロス'
}

export interface PeriodSnapshot {
  period: SmaLabPeriod
  sma: number | null
  slopePct: number | null
  curvaturePct: number | null
  shape: ShapeClass | null
  slope: SlopeClass | null
  curve: CurveClass | null
  closeGapPct: number | null
  closeSide: Side | null
}

/** One row per period at a timeline index (the as-of bar by default). */
export function snapshotAt(analysis: ShapeAnalysis, timeline: ShapeTimeline, index: number): PeriodSnapshot[] {
  return analysis.periods.map((period) => {
    const slope = analysis.slopes[period][index]
    const gap = analysis.closes.find((item) => item.period === period)?.points[index]
    return {
      period,
      sma: timeline.sma[period]?.[index] ?? null,
      slopePct: slope?.slopePct ?? null,
      curvaturePct: slope?.curvaturePct ?? null,
      shape: slope?.shape ?? null,
      slope: slope?.slope ?? null,
      curve: slope?.curve ?? null,
      closeGapPct: gap?.gapPct ?? null,
      closeSide: gap?.side ?? null,
    }
  })
}
