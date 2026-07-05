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
  ma5?: number | null
  ma25?: number | null
  ma75?: number | null
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
  currency?: 'JPY' | 'USD'
}

type StagePosition = StageMarkerPoint & {
  x: number
}

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
  currency = 'JPY',
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

  const maLines = useMemo(() => ([
    { key: 'ma5', label: '5日', color: movingAverageColor(5) },
    { key: 'ma25', label: '25日', color: movingAverageColor(25) },
    { key: 'ma75', label: '75日', color: movingAverageColor(75) },
    { key: 'ma200', label: '200日', color: movingAverageColor(200) },
  ] as const).map((line) => ({
    ...line,
    data: series
      .filter((row) => row[line.key] != null)
      .map((row) => ({
        time: dateToTime(row.date),
        value: Number(row[line.key]),
      })),
  })), [series])

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
        lineWidth: line.key === 'ma200' ? 2 : 1,
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
      const left = Math.min(startX, endX)
      const width = Math.max(6, Math.abs(endX - startX))
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

    chart.timeScale().fitContent()
    chart.timeScale().subscribeVisibleTimeRangeChange(paintHighlight)
    requestAnimationFrame(paintHighlight)
    chartRef.current = chart

    const resize = () => {
      if (!containerRef.current || !chartRef.current) return
      chartRef.current.applyOptions({ width: containerRef.current.clientWidth })
      paintHighlight()
    }
    window.addEventListener('resize', resize)

    return () => {
      window.removeEventListener('resize', resize)
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
    <div className="bt-highlight-chart">
      <div className="bt-highlight-chart-meta">
        <span>{highlightStart} → {highlightEnd ?? '-'}</span>
        <strong>{fmtPrice(startPrice, currency)} → {fmtPrice(endPrice, currency)}</strong>
        <b data-direction={direction}>{fmtPct(returnPct)}</b>
        <i className="bt-ma-legend">
          <em data-ma="5">5日</em>
          <em data-ma="25">25日</em>
          <em data-ma="75">75日</em>
          <em data-ma="200">200日</em>
        </i>
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
