'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  CandlestickSeries,
  ColorType,
  HistogramSeries,
  LineSeries,
  createChart,
  type IChartApi,
  type UTCTimestamp,
} from 'lightweight-charts'
import { movingAverageColor } from '@/lib/chart-colors'

export type HighlightChartPoint = {
  date: string
  open: number | null
  high: number | null
  low: number | null
  close: number | null
  volume: number | null
  ma3?: number | null
  ma5?: number | null
  ma9?: number | null
  ma10?: number | null
  ma13?: number | null
  ma20?: number | null
  ma24?: number | null
  ma25?: number | null
  ma26?: number | null
  ma40?: number | null
  ma52?: number | null
  ma60?: number | null
  ma75?: number | null
  ma90?: number | null
  ma200?: number | null
}

export type StageMarkerPoint = {
  date: string
  code: string
}

type Props = {
  series: HighlightChartPoint[]
  highlightStart: string
  highlightEnd: string | null
  direction: 'up' | 'down'
  stagePath?: StageMarkerPoint[]
  height?: number
  startPrice?: number | null
  endPrice?: number | null
  returnPct?: number | null
  displayStartDate?: string
  displayEndDate?: string | null
  currency?: 'JPY' | 'USD'
  maPeriods?: readonly MovingAveragePeriod[]
  showMovingAverages?: boolean
  showMovingAverageLegend?: boolean
  maUnitLabel?: string
}

export type MovingAveragePeriod =
  | 3
  | 5
  | 9
  | 10
  | 13
  | 20
  | 24
  | 25
  | 26
  | 40
  | 52
  | 60
  | 75
  | 90
  | 200

type StagePosition = StageMarkerPoint & {
  x: number
}

const DEFAULT_MA_PERIODS: readonly MovingAveragePeriod[] = [5, 25, 75, 200]

const MA_LINE_CONFIG: ReadonlyArray<{
  period: MovingAveragePeriod
  key: `ma${MovingAveragePeriod}`
}> = [
  { period: 3, key: 'ma3' },
  { period: 5, key: 'ma5' },
  { period: 9, key: 'ma9' },
  { period: 10, key: 'ma10' },
  { period: 13, key: 'ma13' },
  { period: 20, key: 'ma20' },
  { period: 24, key: 'ma24' },
  { period: 25, key: 'ma25' },
  { period: 26, key: 'ma26' },
  { period: 40, key: 'ma40' },
  { period: 52, key: 'ma52' },
  { period: 60, key: 'ma60' },
  { period: 75, key: 'ma75' },
  { period: 90, key: 'ma90' },
  { period: 200, key: 'ma200' },
]

function dateToTime(date: string): UTCTimestamp {
  return Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000) as UTCTimestamp
}

function fmtPrice(value: number | null | undefined, currency: 'JPY' | 'USD' = 'JPY'): string {
  if (value == null || !Number.isFinite(value)) return '-'
  if (currency === 'USD') {
    return `$${value.toLocaleString('en-US', { maximumFractionDigits: value >= 100 ? 1 : 2 })}`
  }
  return `${Math.round(value).toLocaleString('ja-JP')}円`
}

function fmtPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`
}

export function BacktestHighlightChart({
  series,
  highlightStart,
  highlightEnd,
  direction,
  stagePath = [],
  height = 260,
  startPrice,
  endPrice,
  returnPct,
  displayStartDate,
  displayEndDate,
  currency = 'JPY',
  maPeriods = DEFAULT_MA_PERIODS,
  showMovingAverages = true,
  showMovingAverageLegend = true,
  maUnitLabel = '日',
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const highlightRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const stagePositionsKeyRef = useRef('')
  const [stagePositions, setStagePositions] = useState<StagePosition[]>([])

  const candles = useMemo(() => series
    .filter((row) => row.open != null && row.high != null && row.low != null && row.close != null)
    .map((row) => ({
      time: dateToTime(row.date),
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
    })), [series])

  const volumes = useMemo(() => series
    .filter((row) => row.volume != null)
    .map((row) => ({
      time: dateToTime(row.date),
      value: Number(row.volume),
      color: direction === 'up' ? 'rgba(220, 38, 38, 0.22)' : 'rgba(37, 99, 235, 0.22)',
    })), [direction, series])

  const maLines = useMemo(() => {
    if (!showMovingAverages) return []
    const enabled = new Set(maPeriods)
    return MA_LINE_CONFIG
      .filter((line) => enabled.has(line.period))
      .map((line) => ({
        ...line,
        label: `${line.period}${maUnitLabel}`,
        color: movingAverageColor(line.period),
        data: series
          .filter((row) => row[line.key] != null)
          .map((row) => ({
            time: dateToTime(row.date),
            value: Number(row[line.key]),
          })),
      }))
  }, [maPeriods, maUnitLabel, series, showMovingAverages])

  const visibleStagePath = useMemo(() => {
    if (stagePath.length <= 12) return stagePath
    return [...stagePath.slice(0, 5), ...stagePath.slice(-7)]
  }, [stagePath])

  useEffect(() => {
    if (!containerRef.current || candles.length === 0) return

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

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#dc2626',
      downColor: '#2563eb',
      borderUpColor: '#dc2626',
      borderDownColor: '#2563eb',
      wickUpColor: '#dc2626',
      wickDownColor: '#2563eb',
    })
    candleSeries.setData(candles)

    for (const line of maLines) {
      if (line.data.length === 0) continue
      const seriesLine = chart.addSeries(LineSeries, {
        color: line.color,
        lineWidth: line.period === 200 ? 2 : 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      })
      seriesLine.setData(line.data)
    }

    if (volumes.length > 0) {
      const volumeSeries = chart.addSeries(HistogramSeries, {
        priceFormat: { type: 'volume' },
        priceScaleId: '',
        lastValueVisible: false,
        priceLineVisible: false,
      })
      volumeSeries.priceScale().applyOptions({
        scaleMargins: { top: 0.78, bottom: 0 },
      })
      volumeSeries.setData(volumes)
    }

    const paintHighlight = () => {
      const startX = chart.timeScale().timeToCoordinate(dateToTime(highlightStart))
      const endX = highlightEnd ? chart.timeScale().timeToCoordinate(dateToTime(highlightEnd)) : startX
      const target = highlightRef.current
      if (!target || startX == null || endX == null) {
        if (target) target.dataset.visible = 'false'
        return
      }
      const highlightedIndex = candles.findIndex((point) =>
        point.time === dateToTime(highlightStart)
      )
      const neighbor = highlightedIndex > 0
        ? candles[highlightedIndex - 1]
        : candles[highlightedIndex + 1]
      const neighborX = neighbor
        ? chart.timeScale().timeToCoordinate(neighbor.time)
        : null
      const halfBarWidth = neighborX == null
        ? 3
        : Math.max(3, Math.min(24, Math.abs(startX - neighborX) / 2))
      const frameWidth = containerRef.current?.clientWidth ?? 0
      const left = Math.max(0, Math.min(startX, endX) - halfBarWidth)
      const right = Math.min(frameWidth, Math.max(startX, endX) + halfBarWidth)
      const width = Math.max(6, right - left)
      target.style.left = `${left}px`
      target.style.width = `${width}px`
      target.dataset.visible = 'true'

      const positions = visibleStagePath
        .map((point) => {
          const x = chart.timeScale().timeToCoordinate(dateToTime(point.date))
          return x == null ? null : { ...point, x: Number(x) }
        })
        .filter((point): point is StagePosition => point != null)
      const key = positions.map((point) => `${point.date}:${point.code}:${Math.round(point.x)}`).join('|')
      if (key !== stagePositionsKeyRef.current) {
        stagePositionsKeyRef.current = key
        setStagePositions(positions)
      }
    }

    let paintFrame = 0
    let settleFrame = 0
    let resizePaintTimer: ReturnType<typeof setTimeout> | null = null
    const scheduleHighlightPaint = () => {
      cancelAnimationFrame(paintFrame)
      cancelAnimationFrame(settleFrame)
      paintFrame = requestAnimationFrame(() => {
        settleFrame = requestAnimationFrame(paintHighlight)
      })
    }
    const resize = () => {
      if (!containerRef.current || !chartRef.current) return
      chartRef.current.applyOptions({ width: containerRef.current.clientWidth })
      chartRef.current.timeScale().fitContent()
      scheduleHighlightPaint()
      if (resizePaintTimer) clearTimeout(resizePaintTimer)
      resizePaintTimer = setTimeout(paintHighlight, 120)
    }

    chart.timeScale().fitContent()
    chart.timeScale().subscribeVisibleTimeRangeChange(paintHighlight)
    chartRef.current = chart
    scheduleHighlightPaint()

    const resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(containerRef.current)
    window.addEventListener('resize', resize)

    return () => {
      window.removeEventListener('resize', resize)
      resizeObserver.disconnect()
      cancelAnimationFrame(paintFrame)
      cancelAnimationFrame(settleFrame)
      if (resizePaintTimer) clearTimeout(resizePaintTimer)
      chart.timeScale().unsubscribeVisibleTimeRangeChange(paintHighlight)
      chart.remove()
      chartRef.current = null
      stagePositionsKeyRef.current = ''
    }
  }, [candles, volumes, maLines, visibleStagePath, height, highlightStart, highlightEnd, direction])

  if (series.length === 0) {
    return <div className="bt-chart-empty">チャート表示に必要な価格データが不足しています。</div>
  }

  return (
    <div
      className="bt-highlight-chart"
      data-ma-periods={maLines.map((line) => line.period).join(',')}
    >
      <div className="bt-highlight-chart-meta">
        <span>{displayStartDate ?? highlightStart} → {displayEndDate ?? highlightEnd ?? '-'}</span>
        <strong>{fmtPrice(startPrice, currency)} → {fmtPrice(endPrice, currency)}</strong>
        <b data-direction={direction}>{fmtPct(returnPct)}</b>
        {showMovingAverageLegend && maLines.length > 0 && (
          <i className="bt-ma-legend">
            {maLines.map((line) => (
              <em
                key={line.period}
                data-ma={line.period}
                style={{ color: line.color }}
              >
                {line.label}
              </em>
            ))}
          </i>
        )}
      </div>
      <div className="bt-highlight-chart-canvas" style={{ height }}>
        <div ref={containerRef} style={{ height, width: '100%' }} />
        <div ref={highlightRef} className="bt-chart-highlight" data-visible="false" />
        {stagePositions.length > 0 && (
          <div className="bt-chart-stage-layer" aria-hidden="true">
            {stagePositions.map((point) => (
              <span key={`${point.date}-${point.code}`} style={{ left: `${point.x}px` }}>
                <b>{point.code}</b>
                <small>{point.date.slice(5)}</small>
              </span>
            ))}
          </div>
        )}
      </div>
      {visibleStagePath.length > 0 && (
        <div className="bt-stage-ribbon">
          {visibleStagePath.map((point) => (
            <span key={`${point.date}-${point.code}`}>
              <small>{point.date}</small>
              <b>{point.code}</b>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
