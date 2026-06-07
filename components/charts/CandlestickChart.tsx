// components/charts/CandlestickChart.tsx
// Phase 3.6: TradingView 外部ウィジェットを置換する自前ローソク足チャート。
// データは /api/history (= ローカル ohlcv_daily) を叩く。MA は JS 側で計算。
// lightweight-charts v5 (TradingView OSS) ベース。

'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  HistogramSeries,
  ColorType,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts'
import type { OHLCV } from '@/types/stock'

export type TvInterval = 'D' | 'W' | 'M'

interface CandlestickChartProps {
  ticker: string
  height?: number
  maLines?: number[]
  interval?: TvInterval
  market?: 'JP' | 'US'
}

// 取得期間 (interval 別に必要 OHLCV 日数の目安)
const PERIOD_BY_INTERVAL: Record<TvInterval, string> = {
  D: '1y',   // 日足: 1 年
  W: '5y',   // 週足: 5 年
  M: '10y',  // 月足: 10 年
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
}: CandlestickChartProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const [data, setData] = useState<OHLCV[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedMAs, setSelectedMAs] = useState<number[]>(maLines)
  const maLinesKey = maLines.join(',')

  useEffect(() => {
    setSelectedMAs(maLines)
  }, [maLinesKey])

  // データフェッチ
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    const basePath = market === 'US' ? '/api/us/history' : '/api/history'
    fetch(`${basePath}/${encodeURIComponent(ticker)}?period=${PERIOD_BY_INTERVAL[interval]}`, { cache: 'no-store' })
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
  }, [ticker, interval, market])

  // 日足 → 週足/月足に集約 + MA 計算用に整形
  const { candles, mas } = useMemo(() => {
    if (!data || data.length === 0) return { candles: [], mas: {} as Record<number, { time: UTCTimestamp; value: number }[]> }

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

    return { candles, mas }
  }, [data, interval, selectedMAs])

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
    const maSeriesRefs: ISeriesApi<'Line'>[] = []
    for (const [index, period] of selectedMAs.entries()) {
      const series = chart.addSeries(LineSeries, {
        color:     maColor(period, index),
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
      })
      series.setData(mas[period] ?? [])
      maSeriesRefs.push(series)
    }

    chart.timeScale().fitContent()
    chartRef.current = chart

    // リサイズ対応
    const resize = () => {
      if (containerRef.current && chartRef.current) {
        chartRef.current.applyOptions({ width: containerRef.current.clientWidth })
      }
    }
    window.addEventListener('resize', resize)

    return () => {
      window.removeEventListener('resize', resize)
      if (chartRef.current) {
        chartRef.current.remove()
        chartRef.current = null
      }
    }
  }, [candles, mas, height, selectedMAs])

  const toggleMA = (period: number) => {
    setSelectedMAs(prev =>
      prev.includes(period) ? prev.filter(p => p !== period) : [...prev, period].sort((a, b) => a - b)
    )
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
