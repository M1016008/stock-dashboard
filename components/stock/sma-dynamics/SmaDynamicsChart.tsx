'use client'

// TradingView Lightweight Charts (Apache-2.0; the default attribution logo stays on).
// The library is loaded with a dynamic import inside an effect: it only downloads when
// the lab is opened, and this module stays renderable on the server and in tests.
import { useEffect, useId, useImperativeHandle, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type Ref } from 'react'
import type {
  IChartApi,
  IPriceLine,
  ISeriesApi,
  Logical,
  MouseEventParams,
  SeriesType,
  Time,
} from 'lightweight-charts'
import {
  SMA_LAB_CANDLE_COLORS,
  SMA_LAB_FROZEN_LINE_COLOR,
  SMA_LAB_MUTED_ALPHA,
  SMA_LAB_HIGHLIGHT_COLOR,
  SMA_LAB_OVERLAY_CLOSE_COLORS,
  futureRegionPixelRange,
  splitLineRuns,
  withAlpha,
  type LineDatum,
  type SmaLabChartModel,
} from '@/lib/sma-dynamics-chart-model'
import { smaLabColor, zoomSlotRange, type SlotRange, type SmaLabPeriod } from '@/lib/sma-dynamics-lab'

type Lwc = typeof import('lightweight-charts')

export interface SmaDynamicsChartHandle {
  zoom: (factor: number) => void
  reset: () => void
}

export const ZOOM_IN_FACTOR = 0.6
export const ZOOM_OUT_FACTOR = 1 / ZOOM_IN_FACTOR
const FUTURE_TAG_INSET = 8
const ACTUAL_TAG_MIN_WIDTH = 36

interface ChartState {
  lwc: Lwc
  chart: IChartApi
  candles: ISeriesApi<'Candlestick'>
  lines: ISeriesApi<SeriesType>[]
  frozen: ISeriesApi<'Line'> | null
  /** Close line used for keyboard crosshair on future slots (primary scenario first). */
  primaryClose: { series: ISeriesApi<'Line'>; values: Array<number | null> } | null
  boundaryLines: IPriceLine[]
}

export function SmaDynamicsChart({
  model,
  periods,
  viewRange,
  viewKey,
  priceDigits,
  height,
  label,
  describedBy,
  onHoverSlot,
  handleRef,
  futureLabel = '仮定 (価格固定)',
}: {
  model: SmaLabChartModel
  periods: readonly SmaLabPeriod[]
  /** Initial/reset visible slot range. Re-applied whenever viewKey changes. */
  viewRange: SlotRange
  viewKey: string
  priceDigits: number
  /** CSS height (px number or calc() string). */
  height: number | string
  label: string
  describedBy?: string
  onHoverSlot: (slot: number | null) => void
  handleRef?: Ref<SmaDynamicsChartHandle>
  /** Tag in the shaded future region; names the assumption currently emphasised. */
  futureLabel?: string
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const shadeRef = useRef<HTMLDivElement>(null)
  const boundaryRef = useRef<HTMLDivElement>(null)
  const shadeLabelRef = useRef<HTMLSpanElement>(null)
  const shadeLabelFullRef = useRef<HTMLSpanElement>(null)
  const shadeLabelShortRef = useRef<HTMLSpanElement>(null)
  const boundaryLabelRef = useRef<HTMLSpanElement>(null)
  const stateRef = useRef<ChartState | null>(null)
  const modelRef = useRef(model)
  const viewRangeRef = useRef(viewRange)
  const hoverRef = useRef(onHoverSlot)
  const lastHoverRef = useRef<number | null>(null)
  const keyboardSlotRef = useRef<number | null>(null)
  const [ready, setReady] = useState(false)
  const [loadError, setLoadError] = useState(false)
  // First-hit marker: screen position (from the time/price scales) and when its popover is open.
  const markerId = useId()
  const [markerPos, setMarkerPos] = useState<{ x: number; y: number; width: number; height: number } | null>(null)
  const [markerHover, setMarkerHover] = useState(false)
  const [markerFocus, setMarkerFocus] = useState(false)
  const [markerPinned, setMarkerPinned] = useState(false)
  const marker = model.highlights.find((item) => item.lines != null) ?? null
  const markerKey = marker ? `${marker.k}|${marker.price}|${marker.lines?.join('|')}` : ''

  modelRef.current = model
  viewRangeRef.current = viewRange
  hoverRef.current = onHoverSlot

  const emitHover = (slot: number | null) => {
    if (lastHoverRef.current === slot) return
    lastHoverRef.current = slot
    hoverRef.current(slot)
  }

  // The marker button sits on the assumed close of the hit bar, positioned from the same scales as the chart.
  const paintMarker = () => {
    const state = stateRef.current
    const item = modelRef.current.highlights.find((entry) => entry.lines != null)
    if (!state || !item) {
      setMarkerPos((prev) => (prev == null ? prev : null))
      return
    }
    const x = state.chart.timeScale().timeToCoordinate(item.time as Time)
    const y = state.candles.priceToCoordinate(item.price)
    const width = state.chart.timeScale().width()
    const height = state.chart.paneSize(0).height
    if (x == null || y == null || x < 0 || x > width || y < 0 || y > height) {
      setMarkerPos((prev) => (prev == null ? prev : null))
      return
    }
    setMarkerPos((prev) => (prev && Math.abs(prev.x - x) < 0.5 && Math.abs(prev.y - y) < 0.5 && prev.width === width && prev.height === height ? prev : { x, y, width, height }))
  }

  // Future-region tint and as-of boundary, positioned from the time scale.
  const paintOverlay = () => {
    const state = stateRef.current
    const shade = shadeRef.current
    const boundary = boundaryRef.current
    if (!state || !shade || !boundary) return
    const current = modelRef.current
    const timeScale = state.chart.timeScale()
    const paneWidth = timeScale.width()
    const paneHeight = state.chart.paneSize(0).height
    // logicalToCoordinate only resolves whole slots, so use half-slot boundaries.
    const anchorX = timeScale.logicalToCoordinate(current.anchorSlot as Logical)
    const nextAnchorX = timeScale.logicalToCoordinate((current.anchorSlot + 1) as Logical)
    const lastX = timeScale.logicalToCoordinate(current.lastSlot as Logical)
    const nextLastX = timeScale.logicalToCoordinate((current.lastSlot + 1) as Logical)
    const previousLastX = timeScale.logicalToCoordinate((current.lastSlot - 1) as Logical)
    const hasFuture = current.lastSlot > current.anchorSlot || current.frozenClose.length > 0
    const region = hasFuture ? futureRegionPixelRange({ anchorX, nextAnchorX, lastX, nextLastX, previousLastX, paneWidth }) : null
    if (!region) {
      shade.style.display = 'none'
      boundary.style.display = 'none'
      return
    }
    paintMarker()
    shade.style.display = 'block'
    shade.style.left = `${region.left}px`
    shade.style.width = `${region.right - region.left}px`
    shade.style.height = `${paneHeight}px`
    boundary.style.display = 'block'
    boundary.style.left = `${region.left}px`
    boundary.style.height = `${paneHeight}px`
    // Tags stay inside their own region: the future tag falls back from the full text to its first word
    // and then hides as the zoomed-out region narrows (never spilling over the price axis); the actual
    // tag needs room on the boundary's left.
    const label = shadeLabelRef.current
    const full = shadeLabelFullRef.current
    const short = shadeLabelShortRef.current
    if (label && full && short) {
      const room = region.right - region.left - FUTURE_TAG_INSET
      label.style.display = ''
      full.style.display = ''
      short.style.display = 'none'
      if (full.offsetWidth > room) {
        full.style.display = 'none'
        short.style.display = 'inline'
        if (short.offsetWidth > room) label.style.display = 'none'
      }
    }
    if (boundaryLabelRef.current) boundaryLabelRef.current.style.display = region.left >= ACTUAL_TAG_MIN_WIDTH ? '' : 'none'
  }

  // LWC applies range/size changes on its next frame, so coordinates are read one frame later.
  const paintFrameRef = useRef<number | null>(null)
  const schedulePaint = () => {
    if (typeof window === 'undefined') return
    if (paintFrameRef.current != null) window.cancelAnimationFrame(paintFrameRef.current)
    paintFrameRef.current = window.requestAnimationFrame(() => {
      paintFrameRef.current = null
      paintOverlay()
    })
  }

  const applyRange = (range: SlotRange) => {
    const state = stateRef.current
    if (!state) return
    state.chart.timeScale().setVisibleLogicalRange({ from: range.from, to: range.to })
    state.chart.priceScale('right').applyOptions({ autoScale: true })
  }

  const applyZoom = (factor: number) => {
    const current = stateRef.current?.chart.timeScale().getVisibleLogicalRange()
    if (!current) return
    applyRange(zoomSlotRange({ from: current.from, to: current.to }, factor, { from: -0.5, to: modelRef.current.lastSlot + 1 }))
  }

  useImperativeHandle(handleRef, () => ({
    zoom: applyZoom,
    reset: () => applyRange(viewRangeRef.current),
  }), [])

  // Create the chart once.
  useEffect(() => {
    let disposed = false
    let cleanup: (() => void) | null = null
    import('lightweight-charts')
      .then((lwc) => {
        const container = containerRef.current
        if (disposed || !container) return
        const chart = lwc.createChart(container, {
          autoSize: true,
          layout: {
            background: { type: lwc.ColorType.Solid, color: '#ffffff' },
            textColor: '#525252',
            fontSize: 11,
            attributionLogo: true,
          },
          grid: { vertLines: { color: 'rgba(0,0,0,0.04)' }, horzLines: { color: 'rgba(0,0,0,0.05)' } },
          rightPriceScale: { borderColor: 'rgba(0,0,0,0.10)', scaleMargins: { top: 0.08, bottom: 0.06 } },
          timeScale: { borderColor: 'rgba(0,0,0,0.10)', timeVisible: false, rightOffset: 0, minBarSpacing: 0.4, lockVisibleTimeRangeOnResize: true },
          crosshair: { mode: lwc.CrosshairMode.Normal },
          localization: { locale: 'ja-JP', dateFormat: 'yyyy-MM-dd' },
          handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
          handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: { time: true, price: true }, axisDoubleClickReset: { time: true, price: true } },
        })
        const candles = chart.addSeries(lwc.CandlestickSeries, {
          upColor: SMA_LAB_CANDLE_COLORS.up,
          downColor: SMA_LAB_CANDLE_COLORS.down,
          borderUpColor: SMA_LAB_CANDLE_COLORS.up,
          borderDownColor: SMA_LAB_CANDLE_COLORS.down,
          wickUpColor: SMA_LAB_CANDLE_COLORS.up,
          wickDownColor: SMA_LAB_CANDLE_COLORS.down,
          priceLineVisible: false,
          lastValueVisible: false,
        })
        stateRef.current = { lwc, chart, candles, lines: [], frozen: null, primaryClose: null, boundaryLines: [] }

        const onCrosshair = (param: MouseEventParams<Time>) => {
          if (param.logical == null || param.point == null) {
            emitHover(keyboardSlotRef.current)
            return
          }
          keyboardSlotRef.current = null
          if (modelRef.current.highlights.length > 0) schedulePaint()
          const slot = Math.round(param.logical)
          emitHover(slot >= 0 && slot <= modelRef.current.lastSlot ? slot : null)
        }
        chart.subscribeCrosshairMove(onCrosshair)
        chart.timeScale().subscribeVisibleLogicalRangeChange(schedulePaint)
        chart.timeScale().subscribeSizeChange(schedulePaint)
        cleanup = () => {
          chart.unsubscribeCrosshairMove(onCrosshair)
          chart.timeScale().unsubscribeVisibleLogicalRangeChange(schedulePaint)
          chart.timeScale().unsubscribeSizeChange(schedulePaint)
          if (paintFrameRef.current != null) window.cancelAnimationFrame(paintFrameRef.current)
          chart.remove()
          stateRef.current = null
        }
        setReady(true)
      })
      .catch(() => {
        if (!disposed) setLoadError(true)
      })
    return () => {
      disposed = true
      cleanup?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Series data. Lines are rebuilt; the visible range is left alone so toggling an SMA keeps the zoom.
  useEffect(() => {
    const state = stateRef.current
    if (!ready || !state) return
    const { lwc, chart } = state
    const priceFormat = { type: 'price' as const, precision: priceDigits, minMove: 1 / 10 ** priceDigits }
    // Rebuilding the series can shrink the time scale (the future whitespace disappears while lines are
    // removed), so the user's current view is restored afterwards. Range resets still go through viewKey.
    const keptRange = chart.timeScale().getVisibleLogicalRange()
    state.candles.applyOptions({ priceFormat })
    state.candles.setData(model.candles.map((point) => ({ ...point, time: point.time as Time })))
    for (const series of state.lines) chart.removeSeries(series)
    if (state.frozen) chart.removeSeries(state.frozen)
    for (const line of state.boundaryLines) state.candles.removePriceLine(line)
    state.lines = []
    state.frozen = null
    state.primaryClose = null
    state.boundaryLines = []

    const tint = (color: string, muted: boolean) => (muted ? withAlpha(color, SMA_LAB_MUTED_ALPHA) : color)
    // A missing value must break the line (the chart library would bridge it), so each run is its own series.
    // The axis value tag stays on the last run only; a single-point run needs a marker to be visible.
    const addLine = (data: ReadonlyArray<{ time: number; value?: number }>, options: Record<string, unknown>) => {
      const runs = splitLineRuns(data as ReadonlyArray<LineDatum>)
      if (runs.length === 0) runs.push([])
      let first: ISeriesApi<SeriesType> | null = null
      runs.forEach((run, index) => {
        const single = run.length === 1 && options.pointMarkersVisible !== true && options.lineVisible !== false
        const series = chart.addSeries(lwc.LineSeries, {
          priceLineVisible: false,
          priceFormat,
          ...options,
          ...(index < runs.length - 1 ? { lastValueVisible: false, title: '' } : {}),
          ...(single ? { pointMarkersVisible: true, pointMarkersRadius: 2 } : {}),
        })
        series.setData(run.map((point) => ({ ...point, time: point.time as Time })))
        state.lines.push(series)
        first ??= series
      })
      return first as unknown as ISeriesApi<SeriesType>
    }

    const freezeMuted = model.freezeEmphasis === 'muted'
    if (model.freezeEmphasis !== 'hidden' && model.frozenClose.length > 0) {
      const frozen = chart.addSeries(lwc.LineSeries, {
        color: tint(SMA_LAB_FROZEN_LINE_COLOR, freezeMuted),
        lineWidth: 1,
        lineStyle: lwc.LineStyle.LargeDashed,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        priceFormat,
      })
      frozen.setData(model.frozenClose.map((point) => ({ ...point, time: point.time as Time })))
      state.frozen = frozen
    }
    for (const period of periods) {
      const color = smaLabColor(period)
      const actual = model.actual.get(period) ?? []
      const future = model.future.get(period) ?? []
      if (actual.length > 0) {
        addLine(actual, { color, lineWidth: 2, lineStyle: lwc.LineStyle.Solid })
      }
      if (future.length > 0 && model.freezeEmphasis !== 'hidden') {
        addLine(future, { color: tint(color, freezeMuted), lineWidth: 2, lineStyle: lwc.LineStyle.Dotted, lastValueVisible: !freezeMuted })
      }
    }
    // Scenario / solver paths: assumed closes as a marked line (never candles), SMAs dashed.
    const ordered = [...model.overlays].sort((a, b) => (a.emphasis === b.emphasis ? 0 : a.emphasis === 'muted' ? -1 : 1))
    for (const overlay of ordered) {
      const muted = overlay.emphasis === 'muted'
      for (const period of periods) {
        const line = overlay.sma.get(period) ?? []
        if (line.length > 0) addLine(line, { color: tint(smaLabColor(period), muted), lineWidth: 2, lineStyle: lwc.LineStyle.Dashed, lastValueVisible: !muted })
      }
      if (overlay.close.length > 0) {
        const closeColor = tint(SMA_LAB_OVERLAY_CLOSE_COLORS[overlay.id], muted)
        const series = addLine(overlay.close, {
          color: closeColor,
          lineWidth: muted ? 1 : 2,
          lineStyle: lwc.LineStyle.Solid,
          pointMarkersVisible: true,
          pointMarkersRadius: muted ? 2 : 3,
          lastValueVisible: !muted,
        }) as ISeriesApi<'Line'>
        if (!muted || !state.primaryClose) {
          state.primaryClose = { series, values: overlay.close.map((point) => ('value' in point ? point.value : null)) }
        }
      }
    }
    // Exact solver boundaries. A level that applies to one bar is a short segment ending on that bar;
    // only a level valid for the whole projection becomes a full-width price line.
    const segments = model.boundaries.filter((boundary) => boundary.segment != null)
    for (const boundary of model.boundaries) {
      if (boundary.segment) {
        addLine(
          [{ time: boundary.segment.from, value: boundary.price }, { time: boundary.segment.to, value: boundary.price }],
          {
            color: SMA_LAB_OVERLAY_CLOSE_COLORS.solver,
            lineWidth: 3,
            lineStyle: lwc.LineStyle.Dashed,
            crosshairMarkerVisible: false,
            lastValueVisible: segments.length <= 3,
            // Many per-bar levels would stack unreadable axis labels; the caption explains them instead.
            title: segments.length <= 3 ? boundary.label : '',
          },
        )
        continue
      }
      state.boundaryLines.push(state.candles.createPriceLine({
        price: boundary.price,
        color: SMA_LAB_OVERLAY_CLOSE_COLORS.solver,
        lineWidth: 1,
        lineStyle: lwc.LineStyle.Dashed,
        axisLabelVisible: true,
        title: boundary.label,
      }))
    }
    // The example path's marked bar (e.g. first hit): one large ring on the assumed close, labelled on the axis.
    for (const highlight of model.highlights) {
      addLine([{ time: highlight.time, value: highlight.price }], {
        color: SMA_LAB_HIGHLIGHT_COLOR,
        lineVisible: false,
        pointMarkersVisible: true,
        pointMarkersRadius: highlight.lines ? 4 : 7,
        crosshairMarkerVisible: false,
        lastValueVisible: true,
        title: highlight.label,
      })
    }
    if (keptRange) chart.timeScale().setVisibleLogicalRange({ from: keptRange.from, to: keptRange.to })
    schedulePaint()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, model, periods, priceDigits])

  // The tag text decides how much of it fits, so a new label re-measures.
  useEffect(() => {
    schedulePaint()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [futureLabel])

  // A new path / input means a new marker: close the old popover and re-measure.
  useEffect(() => {
    setMarkerPinned(false)
    setMarkerPos(null)
    schedulePaint()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markerKey, ready])

  // Visible range: on mount and whenever timeframe / range / horizon / focus / reset changes.
  useEffect(() => {
    if (!ready) return
    applyRange(viewRangeRef.current)
    schedulePaint()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, viewKey])

  const moveKeyboardSlot = (next: number | null) => {
    const state = stateRef.current
    keyboardSlotRef.current = next
    emitHover(next)
    if (!state) return
    if (next == null) {
      state.chart.clearCrosshairPosition()
      return
    }
    const slot = modelRef.current.slots[next]
    const candle = modelRef.current.candles[next]
    if (slot.kind === 'bar' && candle.close != null) state.chart.setCrosshairPosition(candle.close, slot.time as Time, state.candles)
    else if (state.frozen) state.chart.setCrosshairPosition(modelRef.current.frozenClose[0]?.value ?? 0, slot.time as Time, state.frozen)
    else if (state.primaryClose) {
      const value = state.primaryClose.values.find((item) => item != null) ?? 0
      state.chart.setCrosshairPosition(value, slot.time as Time, state.primaryClose.series)
    }
    const range = state.chart.timeScale().getVisibleLogicalRange()
    if (range && (next < range.from || next > range.to)) {
      const width = range.to - range.from
      applyRange({ from: next - width / 2, to: next + width / 2 })
    }
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const current = keyboardSlotRef.current ?? lastHoverRef.current ?? model.anchorSlot
    let next: number | null
    switch (event.key) {
      case 'ArrowLeft': next = Math.max(0, current - 1); break
      case 'ArrowRight': next = Math.min(model.lastSlot, current + 1); break
      case 'Home': next = 0; break
      case 'End': next = model.lastSlot; break
      case 'Escape': setMarkerPinned(false); next = null; break
      case '+': case '=': event.preventDefault(); applyZoom(ZOOM_IN_FACTOR); return
      case '-': event.preventDefault(); applyZoom(ZOOM_OUT_FACTOR); return
      default: return
    }
    event.preventDefault()
    moveKeyboardSlot(next)
  }

  return (
    <div
      role="group"
      tabIndex={0}
      aria-label={label}
      aria-describedby={describedBy}
      onKeyDown={handleKeyDown}
      onBlur={() => { if (keyboardSlotRef.current != null) moveKeyboardSlot(null) }}
      onPointerLeave={() => emitHover(null)}
      className="relative w-full min-w-0 select-none rounded-[var(--radius-sm)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-brand-700)]"
      style={{ height }}
      data-sma-dynamics-chart
    >
      <div ref={containerRef} className="absolute inset-0" />
      <div
        ref={shadeRef}
        aria-hidden="true"
        className="pointer-events-none absolute top-0 z-[2] hidden overflow-hidden bg-[repeating-linear-gradient(135deg,rgba(100,116,139,0.07)_0_6px,rgba(100,116,139,0.02)_6px_12px)]"
        data-sma-dynamics-future-region
      >
        <span ref={shadeLabelRef} className="absolute left-1.5 top-1 whitespace-nowrap rounded-[3px] bg-white/85 px-1 text-[10px] font-bold text-[var(--color-text-tertiary)]">
          <span ref={shadeLabelFullRef}>{futureLabel}</span>
          <span ref={shadeLabelShortRef} className="hidden">{futureLabel.split(' ')[0]}</span>
        </span>
      </div>
      <div
        ref={boundaryRef}
        aria-hidden="true"
        className="pointer-events-none absolute top-0 z-[2] hidden w-0 border-l border-dashed border-[var(--color-text-secondary)]"
        data-sma-dynamics-boundary
      >
        <span ref={boundaryLabelRef} className="absolute right-1.5 top-1 whitespace-nowrap rounded-[3px] bg-white/85 px-1 text-[10px] font-bold text-[var(--color-text-tertiary)]">実績</span>
      </div>
      {marker && markerPos && (
        <FirstHitMarkerView
          id={markerId}
          marker={marker}
          pos={markerPos}
          open={markerHover || markerFocus || markerPinned}
          onHover={setMarkerHover}
          onFocus={setMarkerFocus}
          onToggle={() => setMarkerPinned((value) => !value)}
          onClose={() => setMarkerPinned(false)}
        />
      )}
      {!ready && (
        <div role="status" className="absolute inset-0 flex items-center justify-center text-[12px] font-medium text-[var(--color-text-tertiary)]">
          {loadError ? 'チャートを読み込めませんでした。再読み込みしてください。' : 'チャートを準備中…'}
        </div>
      )}
    </div>
  )
}

/**
 * First hit of the selected representative path. A real button (hover, keyboard focus, tap to pin) whose
 * popover repeats the result-panel facts. The text tag keeps the meaning without relying on colour.
 */
export function FirstHitMarkerView({
  id,
  marker,
  pos,
  open,
  onHover,
  onFocus,
  onToggle,
  onClose,
}: {
  id: string
  marker: SmaLabChartModel['highlights'][number]
  pos: { x: number; y: number; width: number; height: number }
  open: boolean
  onHover: (hover: boolean) => void
  onFocus: (focus: boolean) => void
  onToggle: () => void
  onClose: () => void
}) {
  const popoverId = `${id}-hit`
  const popoverWidth = Math.max(160, Math.min(280, pos.width - 8))
  const left = Math.min(Math.max(pos.x - popoverWidth / 2, 4), Math.max(4, pos.width - popoverWidth - 4))
  const below = pos.y < pos.height / 2
  const tagLeft = pos.x > pos.width * 0.6
  const lastIndex = (marker.lines?.length ?? 0) - 1
  return (
    <div className="pointer-events-none absolute left-0 top-0 z-[4]" style={{ width: pos.width, height: pos.height }} data-sma-hit-marker>
      <button
        type="button"
        aria-label={marker.ariaLabel ?? marker.label}
        aria-expanded={open}
        aria-describedby={open ? popoverId : undefined}
        onMouseEnter={() => onHover(true)}
        onMouseLeave={() => onHover(false)}
        onFocus={() => onFocus(true)}
        onBlur={() => onFocus(false)}
        onClick={onToggle}
        onKeyDown={(event) => { if (event.key === 'Escape') { onClose(); event.stopPropagation() } }}
        className="pointer-events-auto absolute grid size-10 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-transparent p-0 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-brand-700)] sm:size-8"
        style={{ left: pos.x, top: pos.y }}
        data-sma-hit-button
      >
        <span aria-hidden="true" className="grid size-[22px] place-items-center rounded-full border-[3px] bg-white/70 shadow-[0_0_0_1.5px_#fff]" style={{ borderColor: SMA_LAB_HIGHLIGHT_COLOR }}>
          <span className="size-1.5 rounded-full" style={{ background: SMA_LAB_HIGHLIGHT_COLOR }} />
        </span>
      </button>
      {marker.tag && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute max-w-[46%] -translate-y-1/2 truncate rounded-[3px] border bg-white/95 px-1 text-[10px] font-bold leading-4"
          style={{ top: pos.y, borderColor: SMA_LAB_HIGHLIGHT_COLOR, color: SMA_LAB_HIGHLIGHT_COLOR, ...(tagLeft ? { right: pos.width - pos.x + 18 } : { left: pos.x + 18 }) }}
          data-sma-hit-tag
        >
          {marker.tag}
        </span>
      )}
      {open && (
        <div
          id={popoverId}
          role="tooltip"
          className="pointer-events-none absolute rounded-[var(--radius-sm)] border border-[var(--color-border-default)] bg-white px-2 py-1.5 text-[11px] leading-[1.45] text-[var(--color-text-primary)] shadow-md"
          style={{ left, width: popoverWidth, ...(below ? { top: pos.y + 20 } : { bottom: pos.height - pos.y + 20 }) }}
          data-sma-hit-popover
        >
          <b className="block">{marker.label}</b>
          {marker.lines?.map((line, index) => <span key={index} className={`block ${index === lastIndex ? 'mt-0.5 text-[10px] text-[var(--color-text-tertiary)]' : ''}`}>{line}</span>)}
        </div>
      )}
    </div>
  )
}
