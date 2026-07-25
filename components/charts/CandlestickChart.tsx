// components/charts/CandlestickChart.tsx
// Phase 3.6: TradingView 外部ウィジェットを置換する自前ローソク足チャート。
// データは /api/history (= ローカル ohlcv_daily) を叩く。MA は JS 側で計算。
// lightweight-charts v5 (TradingView OSS) ベース。

'use client'

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import {
  createChart,
  createSeriesMarkers,
  CandlestickSeries,
  LineSeries,
  HistogramSeries,
  ColorType,
  type IChartApi,
  type UTCTimestamp,
} from 'lightweight-charts'
import type { OHLCV } from '@/types/stock'
import {
  CHART_INTERVAL_OPTIONS,
  angleDeg,
  defaultMaLinesForInterval,
  defaultPeriodForInterval,
  initialVisiblePeriodForInterval,
  intervalLabel,
  intervalToSpec,
  resampleOhlcv,
  smaSeries as calcSmaSeries,
  stageFromThreeMa,
  type ChartIntervalCode,
} from '@/lib/timeframes'
import { movingAverageColor } from '@/lib/chart-colors'

export type TvInterval = ChartIntervalCode

export interface ChartDateRange {
  startDate: string
  endDate: string
}

interface CandlestickChartProps {
  ticker: string
  height?: number
  maLines?: number[]
  maLinesByInterval?: Partial<Record<TvInterval, number[]>>
  interval?: TvInterval
  showTimeframeSelector?: boolean
  timeframeOptions?: TvInterval[]
  market?: 'JP' | 'US'
  historyPeriod?: string
  initialVisiblePeriod?: string
  selectedRange?: ChartDateRange | null
  syncSelectedRange?: boolean
  rangeLabel?: string
  enableRangeDragSelect?: boolean
  analysisDate?: string | null
  revealAfterAnalysis?: boolean
  onVisibleRangeChange?: (range: ChartDateRange, interval: TvInterval, source?: 'visible' | 'drag') => void
}

// 取得期間 (interval 別に必要 OHLCV 日数の目安)
const PERIOD_BY_INTERVAL: Record<TvInterval, string> = {
  D: '1y',   // 日足: 1 年
  '2D': '2y',
  '3D': '5y',
  W: '5y',   // 週足: 5 年
  '2W': '10y',
  '3W': 'all',
  M: '10y',  // 月足: 10 年
  '2M': '10y',
  '3M': 'all',
  '6M': 'all',
  Y: 'all',
  '2Y': 'all',
  '3Y': 'all',
}

const PERIOD_DAYS: Record<string, number> = {
  '1mo': 30,
  '3mo': 90,
  '6mo': 180,
  '1y': 365,
  '2y': 730,
  '5y': 1825,
  '10y': 3650,
}

function maColor(period: number, index = 0): string {
  return movingAverageColor(period, index)
}

export function CandlestickChart({
  ticker,
  height = 500,
  maLines = [5, 25, 75, 200],
  maLinesByInterval,
  interval = 'D',
  showTimeframeSelector = false,
  timeframeOptions = ['D', '2D', '3D', 'W', '2W', '3W', 'M', '2M', '3M', '6M', 'Y', '2Y', '3Y'],
  market = 'JP',
  historyPeriod,
  initialVisiblePeriod,
  selectedRange,
  syncSelectedRange = false,
  rangeLabel,
  enableRangeDragSelect = false,
  analysisDate = null,
  revealAfterAnalysis = false,
  onVisibleRangeChange,
}: CandlestickChartProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const rangeHighlightRef = useRef<HTMLDivElement>(null)
  const dragSelectionRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const selectedRangeRef = useRef<ChartDateRange | null>(selectedRange ?? null)
  const onVisibleRangeChangeRef = useRef<typeof onVisibleRangeChange>(onVisibleRangeChange)
  const applyingRangeRef = useRef(false)
  const readyForVisibleEventsRef = useRef(false)
  const lastEmittedRangeKeyRef = useRef('')
  const dragStartXRef = useRef(0)
  const draggingRangeRef = useRef(false)
  const [data, setData] = useState<OHLCV[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeInterval, setActiveInterval] = useState<TvInterval>(interval)
  const effectiveInterval = showTimeframeSelector ? activeInterval : interval
  const effectiveMaLines = maLinesByInterval?.[effectiveInterval] ?? (showTimeframeSelector ? defaultMaLinesForInterval(effectiveInterval) : maLines)
  const [selectedMAs, setSelectedMAs] = useState<number[]>(maLines)
  const [rangeDragEnabled, setRangeDragEnabled] = useState(false)
  const maLinesKey = effectiveMaLines.join(',')
  const fetchPeriod = historyPeriod ?? PERIOD_BY_INTERVAL[effectiveInterval] ?? defaultPeriodForInterval(effectiveInterval)
  const visiblePeriod = initialVisiblePeriod ?? initialVisiblePeriodForInterval(effectiveInterval)
  const canRangeDragSelect = Boolean(enableRangeDragSelect && onVisibleRangeChange)

  useEffect(() => {
    selectedRangeRef.current = selectedRange ?? null
  }, [selectedRange])

  useEffect(() => {
    onVisibleRangeChangeRef.current = onVisibleRangeChange
  }, [onVisibleRangeChange])

  useEffect(() => {
    if (!enableRangeDragSelect) setRangeDragEnabled(false)
  }, [enableRangeDragSelect])

  useEffect(() => {
    setActiveInterval(interval)
  }, [interval])

  useEffect(() => {
    setSelectedMAs(effectiveMaLines)
  }, [maLinesKey, effectiveInterval])

  // データフェッチ
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    const basePath = market === 'US' ? '/api/us/history' : '/api/history'
    fetch(`${basePath}/${encodeURIComponent(ticker)}?period=${fetchPeriod}`, { cache: 'no-store' })
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((rows: OHLCV[]) => {
        if (cancelled) return
        setData(rows)
        setLoading(false)
      })
      .catch(e => {
        if (cancelled) return
        setError(e.message ?? 'fetch failed')
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [ticker, fetchPeriod, market])

  // 日足 → 指定時間軸に集約 + MA 計算用に整形
  const { grouped, candles, mas, resolvedAnalysisDate } = useMemo(() => {
    if (!data || data.length === 0) {
      return {
        grouped: [] as OHLCV[],
        candles: [],
        mas: {} as Record<number, { time: UTCTimestamp; value: number }[]>,
        resolvedAnalysisDate: null as string | null,
      }
    }

    const analysisRows = analysisDate && !revealAfterAnalysis
      ? data.filter((row) => row.date <= analysisDate)
      : data
    const grouped = resampleOhlcv(analysisRows, intervalToSpec(effectiveInterval))
    const resolvedAnalysisDate = analysisDate
      ? grouped.filter((row) => row.date <= analysisDate).at(-1)?.date ?? null
      : null

    const candles = grouped.map(d => ({
      time:  dateToTime(d.date),
      open:  d.open,
      high:  d.high,
      low:   d.low,
      close: d.close,
    }))

    // MA 計算 (SMA、各期間ぶん)
    const mas: Record<number, { time: UTCTimestamp; value: number }[]> = {}
    for (const period of selectedMAs) {
      const series: { time: UTCTimestamp; value: number }[] = []
      const values = calcSmaSeries(grouped, period)
      for (let i = 0; i < grouped.length; i++) {
        const value = values[i]
        if (value == null) continue
        series.push({ time: dateToTime(grouped[i].date), value })
      }
      mas[period] = series
    }

    return { grouped, candles, mas, resolvedAnalysisDate }
  }, [analysisDate, data, effectiveInterval, revealAfterAnalysis, selectedMAs])

  const candleDates = useMemo(() => grouped.map((row) => row.date), [grouped])
  const timeframeSummary = useMemo(
    () => buildTimeframeSummary(grouped, effectiveInterval, selectedMAs),
    [grouped, effectiveInterval, selectedMAs],
  )

  // チャート描画
  useEffect(() => {
    if (!containerRef.current || candles.length === 0) return

    // 既存チャート破棄
    if (chartRef.current) {
      chartRef.current.remove()
      chartRef.current = null
    }

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height,
      layout: {
        background: { type: ColorType.Solid, color: '#ffffff' },
        textColor: '#525252',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: 'rgba(0,0,0,0.04)' },
        horzLines: { color: 'rgba(0,0,0,0.04)' },
      },
      timeScale: {
        borderColor: 'rgba(0,0,0,0.10)',
        timeVisible: false,
      },
      rightPriceScale: {
        borderColor: 'rgba(0,0,0,0.10)',
      },
      crosshair: { mode: 1 },
    })

    // ローソク足 (日本式: 陽=赤、陰=青)
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor:        '#dc2626',  // 価格上昇 = 赤
      downColor:      '#2563eb',  // 価格下降 = 青
      borderUpColor:  '#dc2626',
      borderDownColor:'#2563eb',
      wickUpColor:    '#dc2626',
      wickDownColor:  '#2563eb',
    })
    candleSeries.setData(candles)
    if (resolvedAnalysisDate) {
      createSeriesMarkers(candleSeries, [{
        time: dateToTime(resolvedAnalysisDate),
        position: 'aboveBar',
        color: '#b45309',
        shape: 'square',
        text: revealAfterAnalysis ? '分析基準' : 'この日時点',
      }])
    }

    // MA 各種
    for (const [index, period] of selectedMAs.entries()) {
      const series = chart.addSeries(LineSeries, {
        color:     maColor(period, index),
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
      })
      series.setData(mas[period] ?? [])
    }

    const paintSelectedRange = () => {
      const target = rangeHighlightRef.current
      if (!target) return
      const range = selectedRangeRef.current
      if (!range) {
        target.dataset.visible = 'false'
        target.style.opacity = '0'
        return
      }
      const chartRange = chartRangeForDateRange(range, candleDates)
      if (!chartRange) {
        target.dataset.visible = 'false'
        target.style.opacity = '0'
        return
      }
      const startX = chart.timeScale().timeToCoordinate(dateToTime(chartRange.startDate))
      const endX = chart.timeScale().timeToCoordinate(dateToTime(chartRange.endDate))
      if (startX == null || endX == null) {
        target.dataset.visible = 'false'
        target.style.opacity = '0'
        return
      }
      const left = Math.min(startX, endX)
      const width = Math.max(6, Math.abs(endX - startX))
      target.style.left = `${left}px`
      target.style.width = `${width}px`
      target.dataset.visible = 'true'
      target.style.opacity = '1'
    }

    const emitVisibleRange = (rawRange: unknown) => {
      paintSelectedRange()
      if (!onVisibleRangeChangeRef.current || applyingRangeRef.current || !readyForVisibleEventsRef.current) return
      const visibleRange = visibleTimeRangeToDateRange(rawRange, candleDates)
      if (!visibleRange) return
      const key = `${visibleRange.startDate}:${visibleRange.endDate}`
      const selected = selectedRangeRef.current
      if (selected && key === `${selected.startDate}:${selected.endDate}`) return
      if (key === lastEmittedRangeKeyRef.current) return
      lastEmittedRangeKeyRef.current = key
      onVisibleRangeChangeRef.current(visibleRange, effectiveInterval)
    }

    applyingRangeRef.current = true
    readyForVisibleEventsRef.current = false
    chart.timeScale().fitContent()
    const initialRange =
      syncSelectedRange && selectedRangeRef.current
        ? selectedRangeRef.current
        : rangeFromPeriod(candleDates, visiblePeriod)
    if (initialRange) {
      setVisibleDateRange(chart, initialRange, candleDates)
    }
    paintSelectedRange()
    chart.timeScale().subscribeVisibleTimeRangeChange(emitVisibleRange)
    chartRef.current = chart
    const readyTimer = window.setTimeout(() => {
      applyingRangeRef.current = false
      readyForVisibleEventsRef.current = true
    }, 500)

    // リサイズ対応
    const resize = () => {
      if (containerRef.current && chartRef.current) {
        chartRef.current.applyOptions({ width: containerRef.current.clientWidth })
        paintSelectedRange()
      }
    }
    window.addEventListener('resize', resize)

    return () => {
      window.removeEventListener('resize', resize)
      window.clearTimeout(readyTimer)
      chart.timeScale().unsubscribeVisibleTimeRangeChange(emitVisibleRange)
      if (chartRef.current) {
        chartRef.current.remove()
        chartRef.current = null
      }
    }
  }, [
    candleDates,
    candles,
    effectiveInterval,
    height,
    mas,
    resolvedAnalysisDate,
    revealAfterAnalysis,
    selectedMAs,
    syncSelectedRange,
    visiblePeriod,
  ])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    const target = rangeHighlightRef.current
    const range = selectedRange ?? null
    if (!range) {
      if (target) target.dataset.visible = 'false'
      if (target) target.style.opacity = '0'
      return
    }
    if (syncSelectedRange) {
      applyingRangeRef.current = true
      setVisibleDateRange(chart, range, candleDates)
      window.setTimeout(() => { applyingRangeRef.current = false }, 300)
    }
    const chartRange = chartRangeForDateRange(range, candleDates)
    if (!chartRange) {
      if (target) target.dataset.visible = 'false'
      if (target) target.style.opacity = '0'
      return
    }
    const startX = chart.timeScale().timeToCoordinate(dateToTime(chartRange.startDate))
    const endX = chart.timeScale().timeToCoordinate(dateToTime(chartRange.endDate))
    if (!target || startX == null || endX == null) {
      if (target) target.dataset.visible = 'false'
      if (target) target.style.opacity = '0'
      return
    }
    const left = Math.min(startX, endX)
    const width = Math.max(6, Math.abs(endX - startX))
    target.style.left = `${left}px`
    target.style.width = `${width}px`
    target.dataset.visible = 'true'
    target.style.opacity = '1'
  }, [selectedRange, syncSelectedRange, candleDates])

  const toggleMA = (period: number) => {
    setSelectedMAs(prev =>
      prev.includes(period) ? prev.filter(p => p !== period) : [...prev, period].sort((a, b) => a - b)
    )
  }

  function paintDragSelection(startX: number, endX: number) {
    const target = dragSelectionRef.current
    if (!target) return
    const left = Math.min(startX, endX)
    const width = Math.abs(endX - startX)
    target.style.left = `${left}px`
    target.style.width = `${Math.max(2, width)}px`
    target.style.opacity = '1'
  }

  function clearDragSelection() {
    const target = dragSelectionRef.current
    if (!target) return
    target.style.opacity = '0'
    target.style.width = '0px'
  }

  function chartCoordinateFromPointer(event: ReactPointerEvent<HTMLElement>) {
    const rect = event.currentTarget.getBoundingClientRect()
    return clamp(event.clientX - rect.left, 0, rect.width)
  }

  function emitDragRange(startX: number, endX: number) {
    const chart = chartRef.current
    if (!chart || Math.abs(endX - startX) < 8) return
    const startTime = chart.timeScale().coordinateToTime(startX)
    const endTime = chart.timeScale().coordinateToTime(endX)
    const rawStartDate = chartTimeToIsoDate(startTime)
    const rawEndDate = chartTimeToIsoDate(endTime)
    if (!rawStartDate || !rawEndDate) return
    const orderedRange =
      rawStartDate <= rawEndDate
        ? { startDate: rawStartDate, endDate: rawEndDate }
        : { startDate: rawEndDate, endDate: rawStartDate }
    const snappedRange = chartRangeForDateRange(orderedRange, candleDates)
    if (!snappedRange) return
    const key = `${snappedRange.startDate}:${snappedRange.endDate}`
    lastEmittedRangeKeyRef.current = key
    onVisibleRangeChangeRef.current?.(snappedRange, effectiveInterval, 'drag')
  }

  function handleRangePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!canRangeDragSelect || !rangeDragEnabled || loading || error || candles.length === 0) return
    const startX = chartCoordinateFromPointer(event)
    dragStartXRef.current = startX
    draggingRangeRef.current = true
    paintDragSelection(startX, startX)
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
  }

  function handleRangePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!draggingRangeRef.current) return
    paintDragSelection(dragStartXRef.current, chartCoordinateFromPointer(event))
    event.preventDefault()
  }

  function handleRangePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (!draggingRangeRef.current) return
    draggingRangeRef.current = false
    const endX = chartCoordinateFromPointer(event)
    clearDragSelection()
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    emitDragRange(dragStartXRef.current, endX)
    setRangeDragEnabled(false)
    event.preventDefault()
  }

  function handleRangePointerCancel(event: ReactPointerEvent<HTMLDivElement>) {
    draggingRangeRef.current = false
    clearDragSelection()
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  return (
    <div>
      {/* MA トグル */}
      <div style={{
        display: 'flex',
        gap: '12px',
        alignItems: 'center',
        padding: '8px 0',
        marginBottom: '8px',
        flexWrap: 'wrap',
      }}>
        {showTimeframeSelector && (
          <div style={timeframeSelectorStyle} role="tablist" aria-label="チャート時間軸">
            {timeframeOptions.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setActiveInterval(option)}
                style={timeframeButtonStyle(option === effectiveInterval)}
                aria-selected={option === effectiveInterval}
              >
                {intervalLabel(option)}
              </button>
            ))}
          </div>
        )}
        <span style={{ fontSize: '10px', color: 'var(--text-muted)', letterSpacing: '0.08em' }}>MA:</span>
        {effectiveMaLines.map((period, index) => (
          <label key={period} style={{
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            cursor: 'pointer',
            fontSize: '11px',
            fontFamily: 'var(--font-mono)',
          }}>
            <input
              type="checkbox"
              checked={selectedMAs.includes(period)}
              onChange={() => toggleMA(period)}
              style={{ accentColor: maColor(period, index) }}
            />
            <span style={{ color: maColor(period, index) }}>{period}</span>
          </label>
        ))}
        {(canRangeDragSelect || selectedRange) && (
          <div style={toolbarRangeGroupStyle}>
            {canRangeDragSelect && (
              <button
                type="button"
                onClick={() => setRangeDragEnabled((value) => !value)}
                style={rangeDragButtonStyle(rangeDragEnabled)}
                aria-pressed={rangeDragEnabled}
              >
                {rangeDragEnabled ? '範囲選択中' : '範囲選択'}
              </button>
            )}
            {selectedRange && (
              <span style={rangePillStyle}>
                {rangeLabel ?? '選択期間'} {selectedRange.startDate} → {selectedRange.endDate}
              </span>
            )}
          </div>
        )}
      </div>
      <TimeframeSummaryBar summary={timeframeSummary} />

      {/* チャートコンテナ */}
      <div style={{ position: 'relative', height }}>
        {loading && (
          <div style={loadingOverlayStyle}>
            <span style={loadingTextStyle}>OHLCV 読込中... {ticker}</span>
          </div>
        )}
        {error && !loading && (
          <div style={loadingOverlayStyle}>
            <span style={{ ...loadingTextStyle, color: 'var(--price-down)' }}>
              データ取得失敗: {error}
            </span>
          </div>
        )}
        {!loading && !error && candles.length === 0 && (
          <div style={loadingOverlayStyle}>
            <span style={loadingTextStyle}>データなし</span>
          </div>
        )}
        <div ref={containerRef} style={{ height, width: '100%' }} />
        <div ref={rangeHighlightRef} style={rangeHighlightStyle} data-visible="false" />
        {canRangeDragSelect && (
          <>
            <div
              style={rangeDragCaptureStyle(rangeDragEnabled)}
              onPointerDown={handleRangePointerDown}
              onPointerMove={handleRangePointerMove}
              onPointerUp={handleRangePointerUp}
              onPointerCancel={handleRangePointerCancel}
              title={rangeDragEnabled ? 'ドラッグしてチャート期間を選択' : undefined}
            />
            <div ref={dragSelectionRef} style={dragSelectionStyle} aria-hidden="true" />
          </>
        )}
      </div>
    </div>
  )
}

// ─── ヘルパー ───

type TimeframeSummary = {
  intervalLabel: string
  stage: number | null
  stageText: string
  headline: string
  tone: 'up' | 'down' | 'neutral' | 'warning'
  maStructure: string
  maTone: SummaryTone
  maOrderDetail: string
  angleSummary: string
  angleTone: SummaryTone
  angleDetail: string
  momentumSummary: string
  momentumTone: SummaryTone
  volumeSummary: string
  volumeTone: SummaryTone
  rangeSummary: string
  rangeTone: SummaryTone
  observation: string
}

type SummaryTone = 'up' | 'down' | 'neutral' | 'warning'

function buildTimeframeSummary(rows: OHLCV[], interval: TvInterval, maLines: number[]): TimeframeSummary | null {
  if (rows.length < 2) return null
  const label = intervalLabel(interval)
  const periods = maLines.length >= 3 ? maLines.slice(0, 3) : defaultMaLinesForInterval(interval).slice(0, 3)
  const latestIndex = rows.length - 1
  const maValues = periods.map((period) => smaAtSafe(rows, period, latestIndex))
  const stage = stageFromThreeMa(maValues[0] ?? null, maValues[1] ?? null, maValues[2] ?? null)
  const maOrder = periods
    .map((period, index) => ({ period, value: maValues[index] }))
    .filter((item): item is { period: number; value: number } => item.value != null && Number.isFinite(item.value))
    .sort((a, b) => b.value - a.value)
    .map((item) => maPeriodLabel(item.period, interval))
    .join(' > ') || '-'

  const angleLookback = Math.min(5, Math.max(1, latestIndex))
  const angleValues = periods.map((period) => {
    const current = smaAtSafe(rows, period, latestIndex)
    const previous = smaAtSafe(rows, period, latestIndex - angleLookback)
    return angleDeg(current, previous, angleLookback)
  })
  const angleParts = periods.map((period, index) => {
    const angle = angleValues[index]
    return angle == null ? `${maPeriodLabel(period, interval)} -` : `${maPeriodLabel(period, interval)} ${angle >= 0 ? '+' : ''}${angle.toFixed(1)}°`
  })

  const latest = rows[latestIndex]
  const previous = rows[latestIndex - 1]
  const latestReturnPrice = priceForReturn(latest)
  const previousReturnPrice = priceForReturn(previous)
  const closeChange = previousReturnPrice > 0 ? ((latestReturnPrice - previousReturnPrice) / previousReturnPrice) * 100 : null
  const volumeWindow = rows.slice(Math.max(0, rows.length - 21), rows.length - 1).filter((row) => row.volume > 0)
  const avgVolume = volumeWindow.length > 0 ? volumeWindow.reduce((sum, row) => sum + row.volume, 0) / volumeWindow.length : null
  const volumeRatio = avgVolume && avgVolume > 0 ? latest.volume / avgVolume : null
  const rangeRows = rows.slice(Math.max(0, rows.length - 20))
  const high20 = Math.max(...rangeRows.map((row) => row.high))
  const low20 = Math.min(...rangeRows.map((row) => row.low))
  const return20Base = rows.length > 20 ? priceForReturn(rows[rows.length - 21]) : null
  const return20 = return20Base != null && return20Base > 0
    ? ((latestReturnPrice - return20Base) / return20Base) * 100
    : null
  const volatility = rangeRows.length > 1
    ? (Math.max(...rangeRows.map((row) => row.high)) - Math.min(...rangeRows.map((row) => row.low))) / latest.close * 100
    : null

  const hasReturnDiscontinuity = closeChange != null && Math.abs(closeChange) > 50
  const latestLowBreak = latest.low <= low20
  const latestHighBreak = latest.high >= high20
  const stageBias = stageBiasLabel(stage)
  const maStructure = maStructureLabel(stage)
  const angleSummary = angleSummaryLabel(angleValues)
  const momentumSummary = hasReturnDiscontinuity
    ? '足元: データ段差を確認'
    : closeChange == null
      ? '足元: 変化不明'
      : `足元: ${priceMoveLabel(closeChange)} ${formatSignedPct(closeChange)}`
  const volumeSummary = volumeRatio == null
    ? '出来高: 比較不可'
    : `出来高: ${volumeRatioLabel(volumeRatio)} ${volumeRatio.toFixed(1)}倍`
  const rangeSummary = volatility == null
    ? '20本: 値幅不明'
    : `20本: ${twentyBarRangeLabel(volatility)} / ${twentyBarDirection(latestHighBreak, latestLowBreak, return20)}`
  const tone = summaryTone(stage, angleValues, closeChange, return20, latestHighBreak, latestLowBreak)
  const headline = summaryHeadline(tone, stageBias)
  const maTone = stageToSummaryTone(stage)
  const angleTone = angleToneLabel(angleValues)
  const momentumTone = momentumToneLabel(closeChange, hasReturnDiscontinuity)
  const volumeTone = volumeToneLabel(volumeRatio)
  const rangeTone = rangeToneLabel(volatility, latestHighBreak, latestLowBreak, return20)

  return {
    intervalLabel: label,
    stage,
    stageText: stage == null ? 'ステージ判定不足' : `S${stage}`,
    headline,
    tone,
    maStructure,
    maTone,
    maOrderDetail: maOrder,
    angleSummary,
    angleTone,
    angleDetail: angleParts.join(' / '),
    momentumSummary,
    momentumTone,
    volumeSummary,
    volumeTone,
    rangeSummary,
    rangeTone,
    observation: observationText(tone, stage, volumeRatio, volatility),
  }
}

function smaAtSafe(rows: OHLCV[], period: number, index: number): number | null {
  if (index < 0) return null
  const values = calcSmaSeries(rows, period)
  return values[index] ?? null
}

function priceForReturn(row: OHLCV): number {
  return row.adjustedClose != null && Number.isFinite(row.adjustedClose) ? row.adjustedClose : row.close
}

function maPeriodLabel(period: number, interval: TvInterval): string {
  if (interval === 'D') return `${period}日線`
  if (interval === 'W') return `${period}週線`
  if (interval === 'M') return `${period}ヶ月線`
  return `${period}本線`
}

function stageBiasLabel(stage: number | null): string {
  if (stage === 1) return '上昇配列'
  if (stage === 2) return '短期調整'
  if (stage === 3) return '悪化進行'
  if (stage === 4) return '下降配列'
  if (stage === 5) return '反発試し'
  if (stage === 6) return '好転候補'
  return '判定不足'
}

function maStructureLabel(stage: number | null): string {
  if (stage === 1) return '短期線が上。上昇基調'
  if (stage === 2) return '短期線が中期線を下回る調整'
  if (stage === 3) return '短期線が下。悪化が進行'
  if (stage === 4) return '長期線が上。戻り売り優勢'
  if (stage === 5) return '短期線が反発。底打ち確認'
  if (stage === 6) return '短期線が上。好転候補'
  return 'MA不足'
}

function angleSummaryLabel(angles: Array<number | null>): string {
  const labels = ['短期', '中期', '長期']
  const parts = angles.map((angle, index) => `${labels[index] ?? `${index + 1}本目`}${angleStateLabel(angle)}`)
  return parts.join(' / ')
}

function angleStateLabel(angle: number | null): string {
  if (angle == null || !Number.isFinite(angle)) return '不明'
  const abs = Math.abs(angle)
  if (abs >= 45) return angle > 0 ? '急上昇' : '急降下'
  if (abs >= 15) return angle > 0 ? '上向き' : '下向き'
  if (abs >= 5) return angle > 0 ? 'やや上向き' : 'やや下向き'
  return '横ばい'
}

function priceMoveLabel(changePct: number): string {
  const abs = Math.abs(changePct)
  if (abs >= 3) return changePct > 0 ? '大幅高' : '大幅安'
  if (abs >= 1) return changePct > 0 ? '上昇' : '下落'
  if (abs >= 0.3) return changePct > 0 ? '小幅高' : '小幅安'
  return '横ばい'
}

function volumeRatioLabel(ratio: number): string {
  if (ratio >= 2) return '商い急増'
  if (ratio >= 1.2) return '通常より多い'
  if (ratio >= 0.8) return '通常並み'
  return '薄商い'
}

function twentyBarRangeLabel(volatility: number): string {
  if (volatility >= 25) return '値幅かなり大'
  if (volatility >= 15) return '値幅大きめ'
  if (volatility >= 8) return '値幅あり'
  return '値幅小さめ'
}

function twentyBarDirection(isHighBreak: boolean, isLowBreak: boolean, returnPct: number | null): string {
  if (isHighBreak) return '高値更新'
  if (isLowBreak) return '安値更新'
  if (returnPct == null || !Number.isFinite(returnPct)) return '方向不明'
  if (returnPct >= 5) return `上向き ${formatSignedPct(returnPct)}`
  if (returnPct <= -5) return `下向き ${formatSignedPct(returnPct)}`
  return `横ばい圏 ${formatSignedPct(returnPct)}`
}

function formatSignedPct(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`
}

function summaryTone(
  stage: number | null,
  angles: Array<number | null>,
  closeChange: number | null,
  return20: number | null,
  isHighBreak: boolean,
  isLowBreak: boolean,
): 'up' | 'down' | 'neutral' | 'warning' {
  let up = 0
  let down = 0

  if (stage === 1 || stage === 6) up += 2
  if (stage === 3 || stage === 4) down += 2
  if (stage === 2) down += 1
  if (stage === 5) up += 1

  for (const angle of angles) {
    if (angle == null || !Number.isFinite(angle)) continue
    if (angle >= 10) up += 1
    if (angle <= -10) down += 1
  }

  if (closeChange != null && Number.isFinite(closeChange)) {
    if (closeChange >= 0.5) up += 1
    if (closeChange <= -0.5) down += 1
  }
  if (return20 != null && Number.isFinite(return20)) {
    if (return20 >= 3) up += 1
    if (return20 <= -3) down += 1
  }
  if (isHighBreak) up += 1
  if (isLowBreak) down += 1

  if (up >= down + 2) return 'up'
  if (down >= up + 2) return 'down'
  if (up >= 3 && down >= 3) return 'warning'
  return 'neutral'
}

function stageToSummaryTone(stage: number | null): SummaryTone {
  if (stage === 1 || stage === 6) return 'up'
  if (stage === 3 || stage === 4) return 'down'
  if (stage === 2 || stage === 5) return 'warning'
  return 'neutral'
}

function angleToneLabel(angles: Array<number | null>): SummaryTone {
  const valid = angles.filter((angle): angle is number => angle != null && Number.isFinite(angle))
  if (valid.length === 0) return 'neutral'
  const up = valid.filter((angle) => angle >= 10).length
  const down = valid.filter((angle) => angle <= -10).length
  if (up >= 2) return 'up'
  if (down >= 2) return 'down'
  if (up > 0 && down > 0) return 'warning'
  return 'neutral'
}

function momentumToneLabel(changePct: number | null, hasDiscontinuity: boolean): SummaryTone {
  if (hasDiscontinuity) return 'warning'
  if (changePct == null || !Number.isFinite(changePct)) return 'neutral'
  if (changePct >= 0.5) return 'up'
  if (changePct <= -0.5) return 'down'
  return 'neutral'
}

function volumeToneLabel(ratio: number | null): SummaryTone {
  if (ratio == null || !Number.isFinite(ratio)) return 'neutral'
  if (ratio >= 1.2) return 'up'
  if (ratio < 0.8) return 'warning'
  return 'neutral'
}

function rangeToneLabel(
  volatility: number | null,
  isHighBreak: boolean,
  isLowBreak: boolean,
  returnPct: number | null,
): SummaryTone {
  if (isHighBreak) return 'up'
  if (isLowBreak) return 'down'
  if (returnPct != null && Number.isFinite(returnPct)) {
    if (returnPct >= 5) return 'up'
    if (returnPct <= -5) return 'down'
  }
  if (volatility != null && Number.isFinite(volatility) && volatility >= 15) return 'warning'
  return 'neutral'
}

function summaryHeadline(tone: TimeframeSummary['tone'], stageBias: string): string {
  if (tone === 'up') return `${stageBias}: 上方向を確認`
  if (tone === 'down') return `${stageBias}: 下方向に注意`
  if (tone === 'warning') return `${stageBias}: 上下に振れやすい`
  return `${stageBias}: 方向確認中`
}

function observationText(tone: TimeframeSummary['tone'], stage: number | null, volumeRatio: number | null, volatility: number | null): string {
  const volumeWeak = volumeRatio != null && volumeRatio < 0.8
  const highVol = volatility != null && volatility >= 15
  if (tone === 'down') {
    return volumeWeak
      ? '下向きだが商いは薄め。戻り局面の出来高を確認。'
      : '戻り売りや安値更新の有無を優先確認。'
  }
  if (tone === 'up') {
    return volumeWeak
      ? '形は上向き。出来高が伴うかを確認。'
      : '高値更新後も短期線上を保てるか確認。'
  }
  if (tone === 'warning' || highVol) return '値幅が大きく、追いかけず支持線・抵抗線を確認。'
  if (stage === 5 || stage === 6) return '好転候補。短期線の上で定着できるか確認。'
  return '方向感は限定的。次の高値・安値抜けを待つ状態。'
}

function TimeframeSummaryBar({ summary }: { summary: TimeframeSummary | null }) {
  if (!summary) return null
  const stageTone = stageToneColor(summary.stage)
  const toneColor = summaryToneColor(summary.tone)
  return (
    <div style={summaryBarStyle}>
      <div style={summaryHeaderStyle}>
        <span style={summaryBadgeStyle(stageTone)}>{summary.intervalLabel} {summary.stageText}</span>
        <strong style={summaryHeadlineStyle(toneColor)}>{summary.headline}</strong>
        <span style={summaryObservationStyle}>{summary.observation}</span>
      </div>
      <div style={summaryChipGridStyle}>
        <SummaryChip label="MA配置" main={summary.maStructure} sub={summary.maOrderDetail} tone={summary.maTone} />
        <SummaryChip label="傾き" main={summary.angleSummary} sub={summary.angleDetail} tone={summary.angleTone} />
        <SummaryChip label="足元" main={summary.momentumSummary} tone={summary.momentumTone} />
        <SummaryChip label="商い" main={summary.volumeSummary} tone={summary.volumeTone} />
        <SummaryChip label="値幅" main={summary.rangeSummary} tone={summary.rangeTone} />
      </div>
    </div>
  )
}

function SummaryChip({ label, main, sub, tone }: { label: string; main: string; sub?: string; tone: SummaryTone }) {
  const palette = summaryTonePalette(tone)
  return (
    <span style={summaryChipStyle(palette)}>
      <small style={summaryChipLabelStyle(palette)}>{label}</small>
      <b style={summaryChipMainStyle(palette)}>{main}</b>
      {sub && <span style={summaryChipSubStyle} title={sub}>{sub}</span>}
    </span>
  )
}

function stageToneColor(stage: number | null): string {
  if (stage === 1 || stage === 6) return '#16a34a'
  if (stage === 2 || stage === 5) return '#d97706'
  if (stage === 3 || stage === 4) return '#2563eb'
  return 'var(--text-muted)'
}

function summaryToneColor(tone: TimeframeSummary['tone']): string {
  if (tone === 'up') return '#dc2626'
  if (tone === 'down') return '#2563eb'
  if (tone === 'warning') return '#d97706'
  return 'var(--text-primary)'
}

function dateToTime(isoDate: string): UTCTimestamp {
  // lightweight-charts は UNIX timestamp (秒) または "YYYY-MM-DD" 文字列を受ける。
  // 確実性のため秒に変換。
  return Math.floor(new Date(isoDate + 'T00:00:00Z').getTime() / 1000) as UTCTimestamp
}

function setVisibleDateRange(chart: IChartApi, range: ChartDateRange, dates: string[]) {
  const chartRange = chartRangeForDateRange(range, dates) ?? range
  chart.timeScale().setVisibleRange({
    from: dateToTime(chartRange.startDate),
    to: dateToTime(chartRange.endDate),
  })
}

function chartRangeForDateRange(range: ChartDateRange, dates: string[]): ChartDateRange | null {
  if (dates.length === 0) return null
  const startDate =
    lastDateOnOrBefore(dates, range.startDate) ??
    firstDateOnOrAfter(dates, range.startDate)
  const endDate =
    firstDateOnOrAfter(dates, range.endDate) ??
    lastDateOnOrBefore(dates, range.endDate)
  if (!startDate || !endDate) return null
  return startDate <= endDate
    ? { startDate, endDate }
    : { startDate: endDate, endDate: startDate }
}

function rangeFromPeriod(dates: string[], period: string | undefined): ChartDateRange | null {
  if (dates.length === 0 || !period) return null
  const days = PERIOD_DAYS[period]
  if (!days) return null
  const endDate = dates[dates.length - 1]
  const threshold = new Date(`${endDate}T00:00:00Z`)
  threshold.setUTCDate(threshold.getUTCDate() - days)
  const thresholdIso = threshold.toISOString().slice(0, 10)
  const startDate = dates.find((date) => date >= thresholdIso) ?? dates[0]
  return { startDate, endDate }
}

function visibleTimeRangeToDateRange(rawRange: unknown, dates: string[]): ChartDateRange | null {
  if (!rawRange || dates.length === 0 || typeof rawRange !== 'object') return null
  const range = rawRange as { from?: unknown; to?: unknown }
  const from = chartTimeToIsoDate(range.from)
  const to = chartTimeToIsoDate(range.to)
  if (!from || !to) return null
  const startDate = firstDateOnOrAfter(dates, from) ?? dates[0]
  const endDate = lastDateOnOrBefore(dates, to) ?? dates[dates.length - 1]
  if (startDate > endDate) return null
  return { startDate, endDate }
}

function chartTimeToIsoDate(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(Math.floor(value) * 1000).toISOString().slice(0, 10)
  }
  if (typeof value === 'string') {
    return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null
  }
  if (value && typeof value === 'object') {
    const businessDay = value as { year?: unknown; month?: unknown; day?: unknown }
    if (
      typeof businessDay.year === 'number' &&
      typeof businessDay.month === 'number' &&
      typeof businessDay.day === 'number'
    ) {
      return [
        String(businessDay.year).padStart(4, '0'),
        String(businessDay.month).padStart(2, '0'),
        String(businessDay.day).padStart(2, '0'),
      ].join('-')
    }
  }
  return null
}

function firstDateOnOrAfter(dates: string[], target: string): string | null {
  return dates.find((date) => date >= target) ?? null
}

function lastDateOnOrBefore(dates: string[], target: string): string | null {
  for (let i = dates.length - 1; i >= 0; i--) {
    if (dates[i] <= target) return dates[i]
  }
  return null
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

const loadingOverlayStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  background: 'var(--bg-surface)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1,
}

const loadingTextStyle: React.CSSProperties = {
  color: 'var(--text-muted)',
  fontSize: '12px',
  fontFamily: 'var(--font-mono)',
}

const timeframeSelectorStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '2px',
  maxWidth: '100%',
  overflowX: 'auto',
  padding: '3px',
  border: '1px solid var(--border-base)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--bg-muted)',
}

function timeframeButtonStyle(active: boolean): React.CSSProperties {
  return {
    border: active ? '1px solid rgba(217, 119, 6, 0.45)' : '1px solid transparent',
    borderRadius: '6px',
    background: active ? 'var(--bg-surface)' : 'transparent',
    color: active ? 'var(--accent-primary)' : 'var(--text-secondary)',
    boxShadow: active ? '0 1px 3px rgba(15, 23, 42, 0.10)' : 'none',
    fontSize: '11px',
    fontWeight: 800,
    lineHeight: 1,
    padding: '6px 9px',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  }
}

const summaryBarStyle: React.CSSProperties = {
  display: 'grid',
  gap: '8px',
  margin: '0 0 8px',
  padding: '10px',
  border: '1px solid var(--border-base)',
  borderRadius: 'var(--radius-sm)',
  background: 'linear-gradient(180deg, #fff 0%, var(--bg-surface) 100%)',
  color: 'var(--text-secondary)',
  fontSize: '12px',
  fontWeight: 700,
}

const summaryHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  flexWrap: 'wrap',
}

function summaryHeadlineStyle(color: string): React.CSSProperties {
  return {
    color,
    fontSize: '13px',
    lineHeight: 1.35,
  }
}

const summaryObservationStyle: React.CSSProperties = {
  color: 'var(--text-secondary)',
  fontSize: '11px',
  lineHeight: 1.5,
}

const summaryChipGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
  gap: '7px',
}

type SummaryTonePalette = {
  accent: string
  border: string
  bg: string
  text: string
  label: string
}

function summaryTonePalette(tone: SummaryTone): SummaryTonePalette {
  if (tone === 'up') {
    return {
      accent: '#dc2626',
      border: 'rgba(220, 38, 38, 0.24)',
      bg: 'linear-gradient(180deg, rgba(254, 242, 242, 0.98) 0%, rgba(255, 255, 255, 0.86) 100%)',
      text: '#991b1b',
      label: '#b91c1c',
    }
  }
  if (tone === 'down') {
    return {
      accent: '#2563eb',
      border: 'rgba(37, 99, 235, 0.24)',
      bg: 'linear-gradient(180deg, rgba(239, 246, 255, 0.98) 0%, rgba(255, 255, 255, 0.86) 100%)',
      text: '#1d4ed8',
      label: '#2563eb',
    }
  }
  if (tone === 'warning') {
    return {
      accent: '#d97706',
      border: 'rgba(217, 119, 6, 0.28)',
      bg: 'linear-gradient(180deg, rgba(255, 251, 235, 0.98) 0%, rgba(255, 255, 255, 0.86) 100%)',
      text: '#92400e',
      label: '#b45309',
    }
  }
  return {
    accent: '#64748b',
    border: 'var(--border-subtle)',
    bg: 'rgba(255,255,255,0.78)',
    text: 'var(--text-primary)',
    label: 'var(--text-muted)',
  }
}

function summaryChipStyle(palette: SummaryTonePalette): React.CSSProperties {
  return {
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '3px',
    border: `1px solid ${palette.border}`,
    borderLeft: `4px solid ${palette.accent}`,
    borderRadius: '6px',
    background: palette.bg,
    padding: '7px 8px',
    boxShadow: '0 1px 2px rgba(15, 23, 42, 0.04)',
  }
}

function summaryChipLabelStyle(palette: SummaryTonePalette): React.CSSProperties {
  return {
    color: palette.label,
    fontSize: '10px',
    fontWeight: 900,
    lineHeight: 1,
  }
}

function summaryChipMainStyle(palette: SummaryTonePalette): React.CSSProperties {
  return {
    color: palette.text,
    fontSize: '12px',
    lineHeight: 1.35,
  }
}

const summaryChipSubStyle: React.CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: 'var(--text-muted)',
  fontFamily: 'var(--font-mono)',
  fontSize: '10px',
  lineHeight: 1.3,
}

function summaryBadgeStyle(color: string): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    border: `1px solid ${color}`,
    borderRadius: '999px',
    color,
    background: 'rgba(255,255,255,0.72)',
    fontFamily: 'var(--font-mono)',
    fontSize: '11px',
    fontWeight: 900,
    lineHeight: 1,
    padding: '4px 8px',
  }
}

const toolbarRangeGroupStyle: React.CSSProperties = {
  marginLeft: 'auto',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  gap: '8px',
  flexWrap: 'wrap',
}

const rangePillStyle: React.CSSProperties = {
  border: '1px solid rgba(245, 158, 11, 0.35)',
  borderRadius: 'var(--radius-sm)',
  background: 'rgba(250, 204, 21, 0.12)',
  color: 'var(--text-secondary)',
  fontFamily: 'var(--font-mono)',
  fontSize: '10px',
  padding: '3px 8px',
  whiteSpace: 'nowrap',
}

function rangeDragButtonStyle(active: boolean): React.CSSProperties {
  return {
    border: `1px solid ${active ? 'rgba(245, 158, 11, 0.75)' : 'var(--border-base)'}`,
    borderRadius: 'var(--radius-sm)',
    background: active ? 'rgba(250, 204, 21, 0.18)' : 'var(--bg-surface)',
    color: active ? 'var(--accent-primary)' : 'var(--text-secondary)',
    fontSize: '10px',
    fontWeight: 700,
    fontFamily: 'var(--font-mono)',
    lineHeight: 1,
    padding: '6px 9px',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  }
}

const rangeHighlightStyle: React.CSSProperties = {
  position: 'absolute',
  top: 0,
  bottom: 0,
  zIndex: 2,
  pointerEvents: 'none',
  borderLeft: '2px solid rgba(245, 158, 11, 0.75)',
  borderRight: '2px solid rgba(245, 158, 11, 0.75)',
  background: 'rgba(250, 204, 21, 0.16)',
  opacity: 0,
}

function rangeDragCaptureStyle(active: boolean): React.CSSProperties {
  return {
    position: 'absolute',
    inset: 0,
    zIndex: 4,
    cursor: active ? 'crosshair' : 'default',
    pointerEvents: active ? 'auto' : 'none',
    touchAction: active ? 'none' : 'auto',
    background: 'transparent',
  }
}

const dragSelectionStyle: React.CSSProperties = {
  position: 'absolute',
  top: 0,
  bottom: 0,
  zIndex: 5,
  pointerEvents: 'none',
  borderLeft: '2px solid rgba(217, 119, 6, 0.95)',
  borderRight: '2px solid rgba(217, 119, 6, 0.95)',
  background: 'rgba(245, 158, 11, 0.24)',
  opacity: 0,
}
