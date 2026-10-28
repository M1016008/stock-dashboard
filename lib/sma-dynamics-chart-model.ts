// Pure mapping from a lab result to chart series. No chart library import, so the
// actual-vs-assumption contract (no future candles, dotted lines only from the last
// confirmed bar) is testable without a DOM.
import {
  futureSlot,
  slotLayout,
  type SmaLabAvailable,
  type SmaLabFutureBar,
  type SmaLabPeriod,
  type SmaLabSeries,
} from '@/lib/sma-dynamics-lab'
import type { SmaLabBar } from '@/lib/sma-dynamics-timeframes'

export const SMA_LAB_CANDLE_COLORS = {
  up: '#dc2626',
  down: '#2563eb',
  formingUpFill: 'rgba(220,38,38,0.22)',
  formingDownFill: 'rgba(37,99,235,0.22)',
  incompleteFill: '#cbd5e1',
  incompleteLine: '#94a3b8',
} as const

export const SMA_LAB_FROZEN_LINE_COLOR = '#6b7280'
/** Assumed close lines of the Phase 2 overlays (Price Freeze keeps the gray dashed line). */
export const SMA_LAB_OVERLAY_CLOSE_COLORS = { scenario: '#0f172a', solver: '#b45309' } as const
/** Ring around the representative path's marked bar (a point on one example path only). */
export const SMA_LAB_HIGHLIGHT_COLOR = '#7c2d12'
/** Opacity of overlays drawn for comparison only. */
export const SMA_LAB_MUTED_ALPHA = 0.35

export type ChartTime = number

export function dateToChartTime(date: string): ChartTime {
  return Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) / 1000
}

export type SmaLabSlot =
  | { slot: number; time: ChartTime; kind: 'bar'; bar: SmaLabBar; future: SmaLabFutureBar | null }
  | { slot: number; time: ChartTime; kind: 'future'; bar: null; future: SmaLabFutureBar }

export interface CandlePoint {
  time: ChartTime
  open?: number
  high?: number
  low?: number
  close?: number
  color?: string
  borderColor?: string
  wickColor?: string
}

export interface LinePoint {
  time: ChartTime
  value: number
}

/** Whitespace marks a missing value. Lightweight Charts bridges whitespace, so lines go through splitLineRuns. */
export type LineDatum = LinePoint | { time: ChartTime }

/** Contiguous runs of valued points; each run is drawn as its own series so a null never gets a joining segment. */
export function splitLineRuns(data: ReadonlyArray<LineDatum>): LinePoint[][] {
  const runs: LinePoint[][] = []
  let run: LinePoint[] = []
  for (const point of data) {
    if ('value' in point) run.push(point)
    else if (run.length > 0) { runs.push(run); run = [] }
  }
  if (run.length > 0) runs.push(run)
  return runs
}

export type SmaLabOverlayId = 'freeze' | 'scenario' | 'solver'
export type SmaLabOverlayEmphasis = 'primary' | 'muted'

export interface SmaLabOverlayInput {
  id: Exclude<SmaLabOverlayId, 'freeze'>
  /** One entry per future bar (null = missing input). */
  closes: ReadonlyArray<number | null>
  /** SMAs over that path, aligned with projection.bars (from projectSmaPath). */
  sma: SmaLabSeries
  emphasis: SmaLabOverlayEmphasis
}

export interface SmaLabOverlaySeries {
  id: Exclude<SmaLabOverlayId, 'freeze'>
  emphasis: SmaLabOverlayEmphasis
  close: LineDatum[]
  sma: Map<SmaLabPeriod, LineDatum[]>
}

export interface SmaLabBoundaryLine {
  price: number
  label: string
  /**
   * Future bar this level applies to. Without it the level is drawn across the whole chart;
   * with it only a short segment ending on that bar (a per-bar condition, never one line for all bars).
   */
  k?: number
}

/** A marked point on the example path (e.g. its first hit bar). Describes that path only. */
export interface SmaLabHighlightInput {
  k: number
  price: number
  label: string
  /** Tooltip / focus text (date, assumed close, SMA, directions, aftermath, scope note). Same strings as the result panel. */
  lines?: string[]
  /** Spoken label of the marker button. */
  ariaLabel?: string
  /** Held / lost / reversed / last bar: shown as a text tag next to the marker (never colour alone). */
  tag?: string
}

export interface SmaLabHighlight extends SmaLabHighlightInput {
  time: ChartTime
}

/** A boundary resolved onto the time axis. segment is set for per-bar levels. */
export interface SmaLabBoundary extends SmaLabBoundaryLine {
  segment: { from: ChartTime; to: ChartTime } | null
}

export interface SmaLabChartOptions {
  /** Price Freeze lines; Phase 1 default is primary. */
  freeze?: SmaLabOverlayEmphasis | 'hidden'
  overlays?: ReadonlyArray<SmaLabOverlayInput>
  /** Horizontal price levels from the inverse solver (exact boundary values). */
  boundaries?: ReadonlyArray<SmaLabBoundaryLine>
  /** Marked bars on the active example path. */
  highlights?: ReadonlyArray<SmaLabHighlightInput>
}

export interface SmaLabChartModel {
  slots: SmaLabSlot[]
  anchorSlot: number
  lastSlot: number
  lastConfirmedSlot: number | null
  /** One entry per slot; future and data-less slots are whitespace (time only). */
  candles: CandlePoint[]
  /** Whitespace entries preserve invalid windows so a solid SMA never bridges a gap. */
  actual: Map<SmaLabPeriod, LineDatum[]>
  future: Map<SmaLabPeriod, LinePoint[]>
  /** Assumed close from the as-of bar to the last future bar. */
  frozenClose: LinePoint[]
  freezeEmphasis: SmaLabOverlayEmphasis | 'hidden'
  overlays: SmaLabOverlaySeries[]
  boundaries: SmaLabBoundary[]
  highlights: SmaLabHighlight[]
}

export interface FutureRegionPixelInput {
  anchorX: number | null
  nextAnchorX: number | null
  lastX: number | null
  nextLastX: number | null
  previousLastX: number | null
  paneWidth: number
}

/** Pixel bounds of the assumed interval, clipped to the visible chart pane. */
export function futureRegionPixelRange(input: FutureRegionPixelInput): { left: number; right: number } | null {
  const { anchorX, nextAnchorX, lastX, nextLastX, previousLastX, paneWidth } = input
  if (anchorX == null || nextAnchorX == null || lastX == null || !Number.isFinite(paneWidth) || paneWidth <= 0) return null
  const rawLeft = (anchorX + nextAnchorX) / 2
  const rawRight = nextLastX != null
    ? (lastX + nextLastX) / 2
    : previousLastX != null
      ? lastX + (lastX - previousLastX) / 2
      : lastX
  const left = Math.min(Math.max(rawLeft, 0), paneWidth)
  const right = Math.min(Math.max(rawRight, 0), paneWidth)
  return right > left ? { left, right } : null
}

function candleFor(bar: SmaLabBar, time: ChartTime): CandlePoint {
  if (bar.open == null || bar.high == null || bar.low == null || bar.close == null) return { time }
  const up = bar.close >= bar.open
  const line = up ? SMA_LAB_CANDLE_COLORS.up : SMA_LAB_CANDLE_COLORS.down
  const base = { time, open: bar.open, high: bar.high, low: bar.low, close: bar.close }
  if (!bar.ohlcComplete) {
    return { ...base, color: SMA_LAB_CANDLE_COLORS.incompleteFill, borderColor: SMA_LAB_CANDLE_COLORS.incompleteLine, wickColor: SMA_LAB_CANDLE_COLORS.incompleteLine }
  }
  if (bar.phase === 'forming') {
    return { ...base, color: up ? SMA_LAB_CANDLE_COLORS.formingUpFill : SMA_LAB_CANDLE_COLORS.formingDownFill, borderColor: line, wickColor: line }
  }
  return { ...base, color: line, borderColor: line, wickColor: line }
}

export function buildSmaLabChartModel(result: SmaLabAvailable, periods: readonly SmaLabPeriod[], options: SmaLabChartOptions = {}): SmaLabChartModel {
  const { anchorSlot, lastSlot } = slotLayout(result)
  const slots: SmaLabSlot[] = result.bars.map((bar, slot) => ({ slot, time: dateToChartTime(bar.firstSession), kind: 'bar', bar, future: null }))
  for (const future of result.projection.bars) {
    const slot = futureSlot(result, future.k)
    if (future.completesForming) {
      const existing = slots[slot]
      if (existing?.kind === 'bar') slots[slot] = { ...existing, future }
      continue
    }
    slots.push({ slot, time: dateToChartTime(future.firstSession), kind: 'future', bar: null, future })
  }

  const candles = slots.map((slot) => (slot.kind === 'bar' ? candleFor(slot.bar, slot.time) : { time: slot.time }))
  const lastConfirmedSlot = result.lastConfirmedIndex

  const actual = new Map<SmaLabPeriod, LineDatum[]>()
  const future = new Map<SmaLabPeriod, LinePoint[]>()
  for (const period of periods) {
    const values = result.sma[period]
    const points: LineDatum[] = []
    const actualEnd = lastConfirmedSlot ?? -1
    for (let index = 0; index <= actualEnd; index += 1) {
      const value = values[index]
      points.push(value == null ? { time: slots[index].time } : { time: slots[index].time, value })
    }
    actual.set(period, points)

    const anchorValue = lastConfirmedSlot == null ? null : values[lastConfirmedSlot]
    const projected: LinePoint[] = []
    if (anchorValue != null && lastConfirmedSlot != null) {
      projected.push({ time: slots[lastConfirmedSlot].time, value: anchorValue })
      result.projection.bars.forEach((bar, offset) => {
        const value = result.projection.sma[period][offset]
        if (value != null) projected.push({ time: slots[futureSlot(result, bar.k)].time, value })
      })
    }
    future.set(period, projected.length > 1 ? projected : [])
  }

  const frozenClose: LinePoint[] = result.projection.bars.length === 0
    ? []
    : slots.slice(anchorSlot).map((slot) => ({ time: slot.time, value: result.asOf.close }))

  const overlays = (options.overlays ?? []).map((overlay): SmaLabOverlaySeries => {
    // The close line starts at the as-of bar unless T+1 completes that same (forming) bar.
    const close: LineDatum[] = []
    if (!result.projection.bars[0]?.completesForming) close.push({ time: slots[anchorSlot].time, value: result.asOf.close })
    result.projection.bars.forEach((bar, offset) => {
      const value = overlay.closes[offset]
      const time = slots[futureSlot(result, bar.k)].time
      close.push(value == null ? { time } : { time, value })
    })
    const sma = new Map<SmaLabPeriod, LineDatum[]>()
    for (const period of periods) {
      const anchorValue = lastConfirmedSlot == null ? null : result.sma[period][lastConfirmedSlot]
      const values = overlay.sma[period] ?? []
      if (anchorValue == null || lastConfirmedSlot == null || !values.some((value) => value != null)) {
        sma.set(period, [])
        continue
      }
      const line: LineDatum[] = [{ time: slots[lastConfirmedSlot].time, value: anchorValue }]
      result.projection.bars.forEach((bar, offset) => {
        const value = values[offset]
        const time = slots[futureSlot(result, bar.k)].time
        line.push(value == null ? { time } : { time, value })
      })
      sma.set(period, line)
    }
    return { id: overlay.id, emphasis: overlay.emphasis, close: close.some((point) => 'value' in point) ? close : [], sma }
  })

  return {
    slots, anchorSlot, lastSlot, lastConfirmedSlot, candles, actual, future, frozenClose,
    freezeEmphasis: options.freeze ?? 'primary',
    overlays,
    highlights: (options.highlights ?? []).flatMap((item): SmaLabHighlight[] => {
      const bar = result.projection.bars[item.k - 1]
      return bar ? [{ ...item, time: slots[futureSlot(result, item.k)].time }] : []
    }),
    boundaries: (options.boundaries ?? []).map((boundary): SmaLabBoundary => {
      const bar = boundary.k == null ? null : result.projection.bars[boundary.k - 1]
      if (boundary.k == null || !bar) return { ...boundary, segment: null }
      const toSlot = futureSlot(result, boundary.k)
      return { ...boundary, segment: { from: slots[Math.max(0, toSlot - 1)].time, to: slots[toSlot].time } }
    }),
  }
}

/** #rrggbb → rgba() for muted comparison lines. */
export function withAlpha(hex: string, alpha: number): string {
  const value = hex.replace('#', '')
  const r = parseInt(value.slice(0, 2), 16)
  const g = parseInt(value.slice(2, 4), 16)
  const b = parseInt(value.slice(4, 6), 16)
  return `rgba(${r},${g},${b},${alpha})`
}
