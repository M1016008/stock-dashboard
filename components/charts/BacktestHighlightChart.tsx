'use client'

import { useEffect, useMemo, useRef } from 'react'
import {
  CandlestickSeries,
  ColorType,
  HistogramSeries,
  createChart,
  type IChartApi,
  type UTCTimestamp,
} from 'lightweight-charts'

export type HighlightChartPoint = {
  date: string
  open: number | null
  high: number | null
  low: number | null
  close: number | null
  volume: number | null
}

type Props = {
  series: HighlightChartPoint[]
  highlightStart: string
  highlightEnd: string | null
  direction: 'up' | 'down'
  height?: number
  startPrice?: number | null
  endPrice?: number | null
  returnPct?: number | null
}

function dateToTime(date: string): UTCTimestamp {
  return Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000) as UTCTimestamp
}

function fmtPrice(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
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
  height = 260,
  startPrice,
  endPrice,
  returnPct,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const highlightRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)

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
    }
  }, [candles, volumes, height, highlightStart, highlightEnd, direction])

  if (series.length === 0) {
    return <div className="bt-chart-empty">チャート表示に必要な価格データが不足しています。</div>
  }

  return (
    <div className="bt-highlight-chart">
      <div className="bt-highlight-chart-meta">
        <span>{highlightStart} → {highlightEnd ?? '-'}</span>
        <strong>{fmtPrice(startPrice)} → {fmtPrice(endPrice)}</strong>
        <b data-direction={direction}>{fmtPct(returnPct)}</b>
      </div>
      <div className="bt-highlight-chart-canvas" style={{ height }}>
        <div ref={containerRef} style={{ height, width: '100%' }} />
        <div ref={highlightRef} className="bt-chart-highlight" data-visible="false" />
      </div>
    </div>
  )
}
