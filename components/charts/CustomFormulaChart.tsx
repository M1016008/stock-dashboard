'use client'

import { useEffect, useMemo, useRef } from 'react'
import {
  CandlestickSeries,
  ColorType,
  HistogramSeries,
  LineSeries,
  createChart,
  type IChartApi,
  type UTCTimestamp,
} from 'lightweight-charts'
import type { CustomChartEvaluation, CustomChartPoint } from '@/lib/custom-charts/types'

function dateToTime(date: string): UTCTimestamp {
  return Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000) as UTCTimestamp
}

function toLineData(points: CustomChartPoint[]) {
  return points.map((point) => ({ time: dateToTime(point.date), value: point.value }))
}

function valueLabel(value: number | null | undefined, currency: CustomChartEvaluation['effectiveCurrency']): string {
  if (value == null || !Number.isFinite(value)) return '-'
  const digits = Math.abs(value) >= 1000 ? 0 : 2
  const body = value.toLocaleString('ja-JP', { maximumFractionDigits: digits })
  if (currency === 'JPY') return `${body}円`
  if (currency === 'USD') return `$${body}`
  return body
}

const MA_COLORS = ['#ef2f86', '#dc2626', '#2563eb', '#16a34a', '#f97316', '#7c3aed']

type Props = {
  evaluation: CustomChartEvaluation | null
  loading?: boolean
  chartType?: 'line' | 'candlestick'
}

export function CustomFormulaChart({ evaluation, loading, chartType = 'line' }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)

  const latest = evaluation?.series.at(-1)
  const previous = evaluation && evaluation.series.length > 1 ? evaluation.series.at(-2) : null
  const diff = latest && previous ? latest.value - previous.value : null
  const diffPct = latest && previous && previous.value !== 0 ? (diff! / Math.abs(previous.value)) * 100 : null
  const latestRsi = evaluation?.indicators.rsi?.at(-1)?.value ?? null
  const latestMacd = evaluation?.indicators.macd?.macd.at(-1)?.value ?? null

  const summary = useMemo(() => {
    if (!evaluation || evaluation.series.length === 0) return []
    return [
      { label: '最新値', value: valueLabel(latest?.value, evaluation.effectiveCurrency) },
      {
        label: '前回差',
        value: diff == null ? '-' : `${diff >= 0 ? '+' : ''}${valueLabel(diff, evaluation.effectiveCurrency)}`,
        tone: diff == null ? 'neutral' : diff >= 0 ? 'up' : 'down',
      },
      {
        label: '前回比',
        value: diffPct == null ? '-' : `${diffPct >= 0 ? '+' : ''}${diffPct.toFixed(2)}%`,
        tone: diffPct == null ? 'neutral' : diffPct >= 0 ? 'up' : 'down',
      },
      { label: '件数', value: `${evaluation.series.length.toLocaleString('ja-JP')}本` },
    ]
  }, [diff, diffPct, evaluation, latest?.value])

  useEffect(() => {
    if (!containerRef.current || !evaluation || evaluation.series.length === 0) return
    if (chartRef.current) {
      chartRef.current.remove()
      chartRef.current = null
    }

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: 430,
      layout: {
        background: { type: ColorType.Solid, color: '#ffffff' },
        textColor: '#4b5563',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: 'rgba(17,24,39,0.05)' },
        horzLines: { color: 'rgba(17,24,39,0.05)' },
      },
      rightPriceScale: {
        borderColor: 'rgba(17,24,39,0.12)',
      },
      timeScale: {
        borderColor: 'rgba(17,24,39,0.12)',
        timeVisible: false,
      },
      crosshair: { mode: 1 },
    })

    if (chartType === 'candlestick' && evaluation.candles.length > 0) {
      const base = chart.addSeries(CandlestickSeries, {
        upColor: '#dc2626',
        downColor: '#2563eb',
        borderUpColor: '#dc2626',
        borderDownColor: '#2563eb',
        wickUpColor: '#dc2626',
        wickDownColor: '#2563eb',
        priceLineVisible: true,
        lastValueVisible: true,
      })
      base.setData(evaluation.candles.map((point) => ({
        time: dateToTime(point.date),
        open: point.open,
        high: point.high,
        low: point.low,
        close: point.close,
      })))
    } else {
      const base = chart.addSeries(LineSeries, {
        color: '#0f3f75',
        lineWidth: 2,
        priceLineVisible: true,
        lastValueVisible: true,
      })
      base.setData(toLineData(evaluation.series))
    }

    Object.entries(evaluation.indicators.ma).forEach(([period, points], index) => {
      if (points.length === 0) return
      const series = chart.addSeries(LineSeries, {
        color: MA_COLORS[index % MA_COLORS.length],
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
      })
      series.setData(toLineData(points))
    })

    if (evaluation.indicators.bollinger) {
      const bands = [
        { points: evaluation.indicators.bollinger.upper, color: '#94a3b8' },
        { points: evaluation.indicators.bollinger.middle, color: '#64748b' },
        { points: evaluation.indicators.bollinger.lower, color: '#94a3b8' },
      ]
      for (const band of bands) {
        if (band.points.length === 0) continue
        const series = chart.addSeries(LineSeries, {
          color: band.color,
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
        })
        series.setData(toLineData(band.points))
      }
    }

    if (evaluation.volume.length > 0) {
      const histogram = chart.addSeries(HistogramSeries, {
        color: 'rgba(37,99,235,0.22)',
        priceScaleId: 'volume',
        priceFormat: { type: 'volume' },
      })
      histogram.setData(evaluation.volume.map((point) => ({
        time: dateToTime(point.date),
        value: point.value,
        color: 'rgba(37,99,235,0.22)',
      })))
      chart.priceScale('volume').applyOptions({
        scaleMargins: { top: 0.82, bottom: 0 },
      })
    }

    chart.timeScale().fitContent()
    chartRef.current = chart

    const resize = () => {
      if (!containerRef.current || !chartRef.current) return
      chartRef.current.applyOptions({ width: containerRef.current.clientWidth })
    }
    window.addEventListener('resize', resize)
    return () => {
      window.removeEventListener('resize', resize)
      chart.remove()
      chartRef.current = null
    }
  }, [chartType, evaluation])

  if (!evaluation) {
    return (
      <div className="flex min-h-[430px] items-center justify-center rounded-[4px] border border-dashed border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] text-[13px] font-bold text-[var(--color-text-secondary)]">
        {loading ? '計算中...' : '数式を計算するとチャートを表示します'}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-4">
        {summary.map((item) => (
          <div key={item.label} className="rounded-[4px] border border-[var(--color-border-default)] bg-white px-3 py-2">
            <div className="text-[10px] font-black text-[var(--color-text-tertiary)]">{item.label}</div>
            <div
              className={`mt-1 text-[15px] font-black tabular-nums ${
                item.tone === 'up'
                  ? 'text-[var(--color-price-up)]'
                  : item.tone === 'down'
                    ? 'text-[var(--color-price-down)]'
                    : 'text-[var(--color-brand-900)]'
              }`}
            >
              {item.value}
            </div>
          </div>
        ))}
      </div>
      <div ref={containerRef} className="h-[430px] w-full rounded-[4px] border border-[var(--color-border-default)] bg-white" />
      <div className="grid gap-2 md:grid-cols-3">
        <div className="rounded-[4px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-3 py-2 text-[12px] font-semibold text-[var(--color-text-secondary)]">
          <span className="font-black text-[var(--color-brand-900)]">式</span> {evaluation.normalizedFormula}
        </div>
        <div className="rounded-[4px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-3 py-2 text-[12px] font-semibold text-[var(--color-text-secondary)]">
          <span className="font-black text-[var(--color-brand-900)]">RSI</span> {latestRsi == null ? '-' : latestRsi.toFixed(1)}
        </div>
        <div className="rounded-[4px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-3 py-2 text-[12px] font-semibold text-[var(--color-text-secondary)]">
          <span className="font-black text-[var(--color-brand-900)]">MACD</span> {latestMacd == null ? '-' : latestMacd.toFixed(2)}
        </div>
      </div>
    </div>
  )
}
