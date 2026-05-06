// components/capital-flow/TimeSeries.tsx
// 業種別の時価総額推移を折れ線グラフで表示。
// 起点を 100 として正規化した「相対指数」を縦軸にすることで、サイズの違う業種同士を比較可能にする。

'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend,
} from 'recharts'

type GroupBy = 'large' | 'sector33' | 'small'

interface SeriesGroup {
  label: string
  series: (number | null)[]      // 生時価総額
  indexed: (number | null)[]     // 起点 = 100 の正規化系列
  latestMcap: number
  firstMcap: number
  totalDelta: number
  totalDeltaPct: number | null
}

interface ApiResp {
  dates: string[]
  groups: SeriesGroup[]
  groupBy: GroupBy
  notice?: string
}

interface Props {
  groupBy: GroupBy
}

const COLORS = [
  '#22c55e', '#ef4444', '#3b82f6', '#f59e0b', '#a855f7', '#ec4899',
  '#06b6d4', '#84cc16', '#f97316', '#6366f1', '#14b8a6', '#dc2626',
]

const DAY_OPTIONS: { v: number; label: string }[] = [
  { v: 7,   label: '1週' },
  { v: 14,  label: '2週' },
  { v: 30,  label: '1ヶ月' },
  { v: 60,  label: '2ヶ月' },
  { v: 90,  label: '3ヶ月' },
]

export function CapitalFlowTimeSeries({ groupBy }: Props) {
  const [days, setDays] = useState<number>(30)
  const [data, setData] = useState<ApiResp | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hidden, setHidden] = useState<Set<string>>(new Set())

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    fetch(`/api/capital-flow/timeseries?groupBy=${groupBy}&days=${days}`)
      .then(async (r) => {
        const j = await r.json()
        if (!r.ok) throw new Error(j.message ?? j.error ?? 'failed')
        if (!cancelled) setData(j)
      })
      .catch((e) => { if (!cancelled) setError((e as Error).message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [groupBy, days])

  const chartData = useMemo(() => {
    if (!data) return []
    return data.dates.map((date, i) => {
      const row: Record<string, string | number | null> = { date }
      for (const g of data.groups) {
        row[g.label] = g.indexed[i]
      }
      return row
    })
  }, [data])

  const visibleGroups = data?.groups.filter((g) => !hidden.has(g.label)) ?? []

  const toggle = (label: string) => {
    setHidden((cur) => {
      const next = new Set(cur)
      if (next.has(label)) next.delete(label)
      else next.add(label)
      return next
    })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>表示期間</span>
        <div style={{ display: 'inline-flex', border: '1px solid var(--border-base)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
          {DAY_OPTIONS.map((o) => (
            <button
              key={o.v}
              onClick={() => setDays(o.v)}
              style={{
                padding: '5px 10px',
                fontSize: '11px',
                fontFamily: 'var(--font-mono)',
                background: days === o.v ? 'var(--accent-primary)' : 'transparent',
                color: days === o.v ? '#fff' : 'var(--text-secondary)',
                border: 'none',
                cursor: 'pointer',
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
        <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
          縦軸 = 起点を 100 とした相対指数。
        </span>
      </div>

      {error && (
        <div className="card" style={{ padding: '12px', borderLeft: '3px solid var(--price-down)' }}>
          <p style={{ fontSize: '12px', color: 'var(--price-down)', margin: 0 }}>エラー: {error}</p>
        </div>
      )}
      {loading && <div className="card" style={{ padding: '24px', textAlign: 'center', fontSize: '12px', color: 'var(--text-muted)' }}>読込中…</div>}
      {!loading && !error && data && (
        <>
          {data.notice && (
            <div className="card" style={{ padding: '12px' }}>
              <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: 0 }}>⚠ {data.notice}</p>
            </div>
          )}

          {/* 凡例 + クリックで表示切替 */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
            {data.groups.map((g, i) => {
              const active = !hidden.has(g.label)
              const c = COLORS[i % COLORS.length]
              return (
                <button
                  key={g.label}
                  onClick={() => toggle(g.label)}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: '4px',
                    padding: '3px 8px',
                    fontSize: '10px',
                    fontFamily: 'var(--font-mono)',
                    background: active ? '#fff' : 'var(--bg-elevated)',
                    color: active ? c : 'var(--text-muted)',
                    border: `1px solid ${active ? c : 'var(--border-base)'}`,
                    borderRadius: '12px',
                    cursor: 'pointer',
                    opacity: active ? 1 : 0.5,
                  }}
                >
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: c }} />
                  {g.label}
                  <span style={{ color: g.totalDeltaPct != null && g.totalDeltaPct >= 0 ? '#16a34a' : '#dc2626', fontWeight: 700 }}>
                    {g.totalDeltaPct == null ? '—' : `${g.totalDeltaPct >= 0 ? '+' : ''}${g.totalDeltaPct.toFixed(1)}%`}
                  </span>
                </button>
              )
            })}
          </div>

          <div style={{ height: 400, background: '#fff', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', padding: '8px' }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
                <CartesianGrid stroke="#e5e7eb" strokeDasharray="2 2" />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 10, fill: '#6b7280' }}
                  tickFormatter={(v) => v.slice(5)}
                  axisLine={{ stroke: '#9ca3af' }}
                  tickLine={false}
                  minTickGap={32}
                />
                <YAxis
                  domain={['auto', 'auto']}
                  tick={{ fontSize: 10, fill: '#6b7280' }}
                  axisLine={{ stroke: '#9ca3af' }}
                  tickLine={false}
                  width={48}
                />
                <Tooltip
                  contentStyle={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 4, fontSize: 11 }}
                  formatter={(v: number | string, name) => [
                    typeof v === 'number' ? v.toFixed(2) : String(v),
                    name as string,
                  ]}
                />
                <Legend wrapperStyle={{ display: 'none' }} />
                {visibleGroups.map((g, i) => (
                  <Line
                    key={g.label}
                    type="monotone"
                    dataKey={g.label}
                    stroke={COLORS[(data.groups.indexOf(g)) % COLORS.length]}
                    strokeWidth={1.5}
                    dot={false}
                    isAnimationActive={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </div>
  )
}
