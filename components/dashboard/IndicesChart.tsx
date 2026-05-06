// components/dashboard/IndicesChart.tsx
'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend,
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
  close: number
  ma5?: number | null
  ma25?: number | null
  ma75?: number | null
}

export function IndicesChart() {
  const [code, setCode] = useState<IndexCode>('^N225')
  const [tf, setTf] = useState<Timeframe>('D')
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
      close: d.close,
      ma5: ma5[i] ?? null,
      ma25: ma25[i] ?? null,
      ma75: ma75[i] ?? null,
    }))
  }, [history, tf])

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

      {/* タイムフレーム + MA 切替 */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '8px', flexWrap: 'wrap' }}>
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

      <div style={{ height: '260px' }}>
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
            <LineChart data={series} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
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
                domain={['auto', 'auto']}
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
                formatter={(v, name) => [
                  typeof v === 'number' ? v.toLocaleString('ja-JP', { maximumFractionDigits: 2 }) : String(v ?? ''),
                  name === 'close' ? '終値' : String(name ?? '').toUpperCase(),
                ]}
              />
              <Legend wrapperStyle={{ fontSize: '10px' }} />
              <Line type="monotone" dataKey="close" stroke="var(--text-primary)" strokeWidth={1.5} dot={false} name="終値" isAnimationActive={false} />
              {enabledMAs.includes(5) && (
                <Line type="monotone" dataKey="ma5" stroke={MA_COLORS[5]} strokeWidth={1} dot={false} name="MA5" isAnimationActive={false} />
              )}
              {enabledMAs.includes(25) && (
                <Line type="monotone" dataKey="ma25" stroke={MA_COLORS[25]} strokeWidth={1} dot={false} name="MA25" isAnimationActive={false} />
              )}
              {enabledMAs.includes(75) && (
                <Line type="monotone" dataKey="ma75" stroke={MA_COLORS[75]} strokeWidth={1} dot={false} name="MA75" isAnimationActive={false} />
              )}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  )
}
