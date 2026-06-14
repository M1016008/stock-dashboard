// components/charts/CandlestickChart.tsx
// Phase 3.6: TradingView 外部ウィジェットを置換する自前ローソク足チャート。
// データは /api/history (= ローカル ohlcv_daily) を叩く。MA は JS 側で計算。
// lightweight-charts v5 (TradingView OSS) ベース。

'use client'

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  HistogramSeries,
  ColorType,
  type IChartApi,
  type UTCTimestamp,
} from 'lightweight-charts'
import type { OHLCV } from '@/types/stock'

export type TvInterval = 'D' | 'W' | 'M'

export interface ChartDateRange {
  startDate: string
  endDate: string
}

interface CandlestickChartProps {
  ticker: string
  height?: number
  maLines?: number[]
  interval?: TvInterval
  market?: 'JP' | 'US'
  historyPeriod?: string
  initialVisiblePeriod?: string
  selectedRange?: ChartDateRange | null
  syncSelectedRange?: boolean
  rangeLabel?: string
  enableRangeDragSelect?: boolean
  onVisibleRangeChange?: (range: ChartDateRange, interval: TvInterval, source?: 'visible' | 'drag') => void
}

// 取得期間 (interval 別に必要 OHLCV 日数の目安)
const PERIOD_BY_INTERVAL: Record<TvInterval, string> = {
  D: '1y',   // 日足: 1 年
  W: '5y',   // 週足: 5 年
  M: '10y',  // 月足: 10 年
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

// MA カラー (Yoshio の好みに合わせて TradingView 旧版と近い色味)
const MA_COLORS: Record<number, string> = {
  5:   '#e5e7eb',  // 薄いグレー (白基調)
  12:  '#e5e7eb',
  13:  '#e5e7eb',
  24:  '#f59e0b',
  25:  '#f59e0b',  // amber (HEX ステージ色と整合)
  26:  '#f59e0b',
  52:  '#3b82f6',
  60:  '#3b82f6',
  75:  '#3b82f6',  // blue
  200: '#a855f7',  // purple
}

const MA_COLOR_FALLBACKS = ['#e5e7eb', '#f59e0b', '#3b82f6', '#a855f7', '#10b981']

function maColor(period: number, index = 0): string {
  return MA_COLORS[period] ?? MA_COLOR_FALLBACKS[index % MA_COLOR_FALLBACKS.length]
}

export function CandlestickChart({
  ticker,
  height = 500,
  maLines = [5, 25, 75],
  interval = 'D',
  market = 'JP',
  historyPeriod,
  initialVisiblePeriod,
  selectedRange,
  syncSelectedRange = false,
  rangeLabel,
  enableRangeDragSelect = false,
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
  const [selectedMAs, setSelectedMAs] = useState<number[]>(maLines)
  const [rangeDragEnabled, setRangeDragEnabled] = useState(false)
  const maLinesKey = maLines.join(',')
  const fetchPeriod = historyPeriod ?? PERIOD_BY_INTERVAL[interval]
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
    setSelectedMAs(maLines)
  }, [maLinesKey])

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

  // 日足 → 週足/月足に集約 + MA 計算用に整形
  const { grouped, candles, mas } = useMemo(() => {
    if (!data || data.length === 0) {
      return {
        grouped: [] as OHLCV[],
        candles: [],
        mas: {} as Record<number, { time: UTCTimestamp; value: number }[]>,
      }
    }

    const grouped = aggregateOhlcv(data, interval)

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
      for (let i = period - 1; i < grouped.length; i++) {
        const slice = grouped.slice(i - period + 1, i + 1)
        const avg = slice.reduce((s, d) => s + d.close, 0) / period
        series.push({ time: dateToTime(grouped[i].date), value: avg })
      }
      mas[period] = series
    }

    return { grouped, candles, mas }
  }, [data, interval, selectedMAs])

  const candleDates = useMemo(() => grouped.map((row) => row.date), [grouped])

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
      onVisibleRangeChangeRef.current(visibleRange, interval)
    }

    applyingRangeRef.current = true
    readyForVisibleEventsRef.current = false
    chart.timeScale().fitContent()
    const initialRange =
      syncSelectedRange && selectedRangeRef.current
        ? selectedRangeRef.current
        : rangeFromPeriod(candleDates, initialVisiblePeriod)
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
  }, [candles, mas, height, selectedMAs, candleDates, initialVisiblePeriod, interval, syncSelectedRange])

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
    onVisibleRangeChangeRef.current?.(snappedRange, interval, 'drag')
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
      }}>
        <span style={{ fontSize: '10px', color: 'var(--text-muted)', letterSpacing: '0.08em' }}>MA:</span>
        {maLines.map((period, index) => (
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

function aggregateOhlcv(rows: OHLCV[], interval: TvInterval): OHLCV[] {
  if (interval === 'D') return rows

  const grouped: OHLCV[] = []
  let currentKey: string | null = null
  let current: OHLCV | null = null

  for (const row of rows) {
    const key = interval === 'W' ? weekKey(row.date) : row.date.slice(0, 7)
    if (key !== currentKey) {
      if (current) grouped.push(current)
      currentKey = key
      current = { ...row }
      continue
    }

    if (!current) {
      current = { ...row }
      continue
    }

    current = {
      date: row.date,
      open: current.open,
      high: Math.max(current.high, row.high),
      low: Math.min(current.low, row.low),
      close: row.close,
      volume: current.volume + row.volume,
      adjustedClose: row.adjustedClose ?? current.adjustedClose,
    }
  }

  if (current) grouped.push(current)
  return grouped
}

function weekKey(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00Z`)
  const day = date.getUTCDay()
  const daysFromMonday = day === 0 ? 6 : day - 1
  date.setUTCDate(date.getUTCDate() - daysFromMonday)
  return date.toISOString().slice(0, 10)
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
