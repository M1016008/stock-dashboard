// components/dashboard/IndicesChart.tsx
'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  ComposedChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend, Customized,
} from 'recharts'
import type { OHLCV } from '@/types/stock'
import { calcSMA } from '@/lib/indicators'

const INDICES = [
  { code: '^N225',  label: '日経225' },
  { code: '^TPX',   label: 'TOPIX' },
  { code: '1591.T', label: 'JPX日経400' },
  { code: '1563.T', label: 'グロース250' },
] as const

type IndexCode = typeof INDICES[number]['code']

type Timeframe = 'D' | 'W' | 'M' | 'Y'
type ChartType = 'line' | 'candle'

const TIMEFRAMES: { key: Timeframe; label: string; period: '6mo' | '1y' | '2y'; group: number }[] = [
  { key: 'D', label: '日足', period: '6mo', group: 1 },
  { key: 'W', label: '週足', period: '1y', group: 5 },
  { key: 'M', label: '月足', period: '2y', group: 21 },
  { key: 'Y', label: '年足', period: '2y', group: 252 },
]

const MA_OPTIONS = [5, 25, 75]

const MA_COLORS: Record<number, string> = {
  5: '#22c55e',
  25: '#f59e0b',
  75: '#a855f7',
}

const CANDLE_UP = '#22c55e'
const CANDLE_DOWN = '#ef4444'

/** 集約: groupSize 本ずつまとめて新しい OHLCV を作る */
function aggregate(ohlcv: OHLCV[], groupSize: number): OHLCV[] {
  if (groupSize <= 1) return ohlcv
  const out: OHLCV[] = []
  for (let i = 0; i < ohlcv.length; i += groupSize) {
    const slice = ohlcv.slice(i, i + groupSize)
    if (slice.length === 0) continue
    out.push({
      date: slice[slice.length - 1].date,
      open: slice[0].open,
      high: Math.max(...slice.map((d) => d.high)),
      low: Math.min(...slice.map((d) => d.low)),
      close: slice[slice.length - 1].close,
      volume: slice.reduce((s, d) => s + d.volume, 0),
    })
  }
  return out
}

interface ChartPoint {
  date: string
  open: number
  high: number
  low: number
  close: number
  ma5?: number | null
  ma25?: number | null
  ma75?: number | null
}

/**
 * Recharts の Customized レイヤとして描く SVG ローソク足。
 * yAxis の scale を借りて high/low/open/close の y 座標を計算。
 */
function CandlestickLayer(props: any) {
  const { yAxisMap, xAxisMap, data } = props
  if (!yAxisMap || !xAxisMap || !data || data.length === 0) return null
  const yAxis: any = Object.values(yAxisMap)[0]
  const xAxis: any = Object.values(xAxisMap)[0]
  if (!yAxis?.scale || !xAxis?.scale) return null

  const yScale = yAxis.scale
  const xScale = xAxis.scale
  const xs: number[] = data.map((d: ChartPoint) => xScale(d.date))
  // データ間隔からローソクの幅を決める
  const diffs: number[] = []
  for (let i = 1; i < xs.length; i++) {
    if (Number.isFinite(xs[i]) && Number.isFinite(xs[i - 1])) {
      diffs.push(Math.abs(xs[i] - xs[i - 1]))
    }
  }
  const minDx = diffs.length > 0 ? Math.min(...diffs) : 8
  const candleWidth = Math.max(2, minDx * 0.7)

  return (
    <g>
      {data.map((d: ChartPoint, i: number) => {
        const cx = xs[i]
        if (!Number.isFinite(cx)) return null
        const { open, high, low, close } = d
        if ([open, high, low, close].some((v) => v == null || !Number.isFinite(v))) return null
        const isUp = close >= open
        const color = isUp ? CANDLE_UP : CANDLE_DOWN
        const yOpen = yScale(open)
        const yClose = yScale(close)
        const yHigh = yScale(high)
        const yLow = yScale(low)
        const bodyTop = Math.min(yOpen, yClose)
        const bodyHeight = Math.max(1, Math.abs(yOpen - yClose))
        return (
          <g key={i}>
            {/* ヒゲ */}
            <line
              x1={cx} y1={yHigh}
              x2={cx} y2={yLow}
              stroke={color} strokeWidth={1}
            />
            {/* 実体 */}
            <rect
              x={cx - candleWidth / 2}
              y={bodyTop}
              width={candleWidth}
              height={bodyHeight}
              fill={color}
              stroke={color}
            />
          </g>
        )
      })}
    </g>
  )
}

export function IndicesChart() {
  const [code, setCode] = useState<IndexCode>('^N225')
  const [tf, setTf] = useState<Timeframe>('D')
  const [chartType, setChartType] = useState<ChartType>('line')
  const [enabledMAs, setEnabledMAs] = useState<number[]>([5, 25])
  const [history, setHistory] = useState<OHLCV[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    const period = TIMEFRAMES.find((t) => t.key === tf)!.period
    setLoading(true)
    setError('')
    fetch(`/api/history/${encodeURIComponent(code)}?period=${period}`)
      .then((r) => r.json())
      .then((d: OHLCV[] | { error: string }) => {
        if (cancelled) return
        if (!Array.isArray(d)) throw new Error((d as any).error ?? 'failed')
        setHistory(d)
      })
      .catch((e) => { if (!cancelled) setError((e as Error).message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [code, tf])

  const series = useMemo<ChartPoint[]>(() => {
    if (history.length === 0) return []
    const group = TIMEFRAMES.find((t) => t.key === tf)!.group
    const agg = aggregate(history, group)

    const ma5 = calcSMA(agg, 5)
    const ma25 = calcSMA(agg, 25)
    const ma75 = calcSMA(agg, 75)

    return agg.map((d, i) => ({
      date: d.date,
      open: d.open,
      high: d.high,
      low: d.low,
      close: d.close,
      ma5: ma5[i] ?? null,
      ma25: ma25[i] ?? null,
      ma75: ma75[i] ?? null,
    }))
  }, [history, tf])

  // ローソク表示時は high/low を含めた範囲で yAxis を確保する
  const yDomain = useMemo<[number | string, number | string]>(() => {
    if (series.length === 0 || chartType !== 'candle') return ['auto', 'auto']
    let min = Infinity
    let max = -Infinity
    for (const d of series) {
      if (d.low < min) min = d.low
      if (d.high > max) max = d.high
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return ['auto', 'auto']
    const pad = (max - min) * 0.05 || 1
    return [min - pad, max + pad]
  }, [series, chartType])

  const stats = useMemo(() => {
    if (series.length === 0) return null
    const last = series[series.length - 1]
    const first = series[0]
    const change = last.close - first.close
    const pct = (change / first.close) * 100
    return { last: last.close, change, pct }
  }, [series])

  const isUp = (stats?.change ?? 0) >= 0

  return (
    <div className="card" style={{ padding: '12px' }}>
      {/* ヘッダー: 銘柄選択 + ラスト価格 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '8px', flexWrap: 'wrap', gap: '8px' }}>
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
          {INDICES.map((idx) => (
            <button
              key={idx.code}
              onClick={() => setCode(idx.code)}
              style={{
                padding: '4px 10px',
                fontSize: '11px',
                fontFamily: 'var(--font-mono)',
                background: code === idx.code ? 'var(--accent-primary)' : 'transparent',
                color: code === idx.code ? '#fff' : 'var(--text-secondary)',
                border: `1px solid ${code === idx.code ? 'var(--accent-primary)' : 'var(--border-base)'}`,
                borderRadius: 'var(--radius-sm)',
                cursor: 'pointer',
              }}
            >
              {idx.label}
            </button>
          ))}
        </div>
        {stats && (
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '14px', fontWeight: 600 }}>
              {stats.last.toLocaleString('ja-JP', { maximumFractionDigits: 2 })}
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: isUp ? 'var(--price-up)' : 'var(--price-down)' }}>
              {isUp ? '+' : ''}{stats.change.toFixed(2)} ({isUp ? '+' : ''}{stats.pct.toFixed(2)}%)
            </div>
          </div>
        )}
      </div>

      {/* タイムフレーム + チャート種別 + MA 切替 */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
        {/* チャート種別 */}
        <div style={{ display: 'inline-flex', border: '1px solid var(--border-base)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
          {([
            { v: 'line', label: '線' },
            { v: 'candle', label: 'ローソク足' },
          ] as { v: ChartType; label: string }[]).map((t) => (
            <button
              key={t.v}
              onClick={() => setChartType(t.v)}
              style={{
                padding: '4px 10px',
                fontSize: '10px',
                fontFamily: 'var(--font-mono)',
                background: chartType === t.v ? 'var(--accent-primary)' : 'transparent',
                color: chartType === t.v ? '#fff' : 'var(--text-secondary)',
                border: 'none',
                cursor: 'pointer',
                fontWeight: chartType === t.v ? 600 : 400,
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* タイムフレーム */}
        <div style={{ display: 'inline-flex', border: '1px solid var(--border-base)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
          {TIMEFRAMES.map((t) => (
            <button
              key={t.key}
              onClick={() => setTf(t.key)}
              style={{
                padding: '4px 10px',
                fontSize: '10px',
                fontFamily: 'var(--font-mono)',
                background: tf === t.key ? 'var(--text-secondary)' : 'transparent',
                color: tf === t.key ? '#fff' : 'var(--text-secondary)',
                border: 'none',
                cursor: 'pointer',
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* MA */}
        <div style={{ display: 'inline-flex', gap: '4px', alignItems: 'center', fontSize: '10px', color: 'var(--text-muted)' }}>
          <span>MA:</span>
          {MA_OPTIONS.map((p) => {
            const enabled = enabledMAs.includes(p)
            return (
              <button
                key={p}
                onClick={() =>
                  setEnabledMAs((arr) =>
                    arr.includes(p) ? arr.filter((x) => x !== p) : [...arr, p],
                  )
                }
                style={{
                  padding: '3px 8px',
                  fontSize: '10px',
                  fontFamily: 'var(--font-mono)',
                  background: enabled ? MA_COLORS[p] : 'transparent',
                  color: enabled ? '#fff' : MA_COLORS[p],
                  border: `1px solid ${MA_COLORS[p]}`,
                  borderRadius: 'var(--radius-sm)',
                  cursor: 'pointer',
                }}
              >
                {p}
              </button>
            )
          })}
        </div>
      </div>

      {error && <p style={{ fontSize: '11px', color: 'var(--price-down)' }}>エラー: {error}</p>}

      <div style={{ height: '300px' }}>
        {loading ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>取得中...</span>
          </div>
        ) : series.length === 0 ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>データなし</span>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={series} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
              <CartesianGrid stroke="var(--border-subtle)" strokeDasharray="2 2" />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
                tickFormatter={(v) => v.slice(5)}
                axisLine={{ stroke: 'var(--border-base)' }}
                tickLine={false}
                minTickGap={28}
              />
              <YAxis
                domain={yDomain}
                tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
                tickFormatter={(v) => v.toLocaleString()}
                axisLine={{ stroke: 'var(--border-base)' }}
                tickLine={false}
                width={60}
              />
              <Tooltip
                contentStyle={{
                  background: 'var(--bg-surface)',
                  border: '1px solid var(--border-base)',
                  borderRadius: '4px',
                  fontSize: '11px',
                }}
                formatter={(v, name) => {
                  const num = typeof v === 'number'
                    ? v.toLocaleString('ja-JP', { maximumFractionDigits: 2 })
                    : String(v ?? '')
                  const labels: Record<string, string> = {
                    open: '始値', high: '高値', low: '安値', close: '終値',
                    ma5: 'MA5', ma25: 'MA25', ma75: 'MA75',
                  }
                  return [num, labels[name as string] ?? String(name ?? '').toUpperCase()]
                }}
              />
              <Legend wrapperStyle={{ fontSize: '10px' }} />

              {/* チャート本体: 線 or ローソク足 */}
              {chartType === 'line' && (
                <Line
                  type="monotone"
                  dataKey="close"
                  stroke="var(--text-primary)"
                  strokeWidth={1.5}
                  dot={false}
                  name="終値"
                  isAnimationActive={false}
                />
              )}
              {chartType === 'candle' && (
                <Customized component={CandlestickLayer} />
              )}

              {/* 移動平均（共通） */}
              {enabledMAs.includes(5) && (
                <Line type="monotone" dataKey="ma5" stroke={MA_COLORS[5]} strokeWidth={1} dot={false} name="MA5" isAnimationActive={false} />
              )}
              {enabledMAs.includes(25) && (
                <Line type="monotone" dataKey="ma25" stroke={MA_COLORS[25]} strokeWidth={1} dot={false} name="MA25" isAnimationActive={false} />
              )}
              {enabledMAs.includes(75) && (
                <Line type="monotone" dataKey="ma75" stroke={MA_COLORS[75]} strokeWidth={1} dot={false} name="MA75" isAnimationActive={false} />
              )}
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  )
}
