// components/dashboard/PortfolioChart.tsx
'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine,
} from 'recharts'
import { usePortfolioStore } from '@/lib/portfolio-store'
import type { OHLCV } from '@/types/stock'

type Period = '1mo' | '3mo' | '1y' | '2y'

const PERIOD_OPTIONS: { key: Period; label: string; days: number }[] = [
  { key: '1mo', label: '日次(1M)', days: 30 },
  { key: '3mo', label: '週次(3M)', days: 90 },
  { key: '1y', label: '月次(1Y)', days: 365 },
  { key: '2y', label: '年次(2Y)', days: 730 },
]

const USDJPY_FALLBACK = 150

interface ChartPoint {
  date: string
  value: number
  cost: number
}

/**
 * ポートフォリオ評価額の推移チャート
 * 各 holding の history を取得し、保有数 × 終値 × 為替（USD→JPY）で日次評価額を計算。
 * 取得原価は固定（avgCost × shares × 為替）として、損益の推移を可視化。
 */
export function PortfolioChart() {
  const holdings = usePortfolioStore((s) => s.holdings)
  const [period, setPeriod] = useState<Period>('1mo')
  const [series, setSeries] = useState<ChartPoint[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (holdings.length === 0) return
    let cancelled = false
    setLoading(true)
    setError('')

    async function load() {
      try {
        // ドル円
        let usdJpy = USDJPY_FALLBACK
        if (holdings.some((h) => h.currency === 'USD')) {
          try {
            const fxRes = await fetch(`/api/history/JPY%3DX?period=${period}`)
            if (fxRes.ok) {
              const fxArr: OHLCV[] = await fxRes.json()
              if (fxArr.length > 0) usdJpy = fxArr[fxArr.length - 1].close
            }
          } catch { /* ignore */ }
        }

        // 各 holding の history
        const histories: { ticker: string; history: OHLCV[] }[] = []
        for (const h of holdings) {
          if (cancelled) return
          try {
            const r = await fetch(`/api/history/${encodeURIComponent(h.ticker)}?period=${period}`)
            if (r.ok) {
              const data: OHLCV[] = await r.json()
              histories.push({ ticker: h.ticker, history: data })
            }
          } catch { /* ignore */ }
          await new Promise((r) => setTimeout(r, 100))
        }

        if (cancelled) return

        // 日付で揃える（各 history の和集合 = 全日付）
        const allDates = new Set<string>()
        histories.forEach((h) => h.history.forEach((d) => allDates.add(d.date)))
        const sortedDates = Array.from(allDates).sort()

        const indexMaps = new Map<string, Map<string, number>>()
        for (const { ticker, history } of histories) {
          const m = new Map<string, number>()
          for (const d of history) m.set(d.date, d.close)
          indexMaps.set(ticker, m)
        }

        // 各日の評価額を計算
        const lastClose: Record<string, number> = {}
        const points: ChartPoint[] = []
        let totalCost = 0
        for (const h of holdings) {
          const fx = h.currency === 'USD' ? usdJpy : 1
          totalCost += h.avgCost * h.shares * fx
        }

        for (const date of sortedDates) {
          let total = 0
          for (const h of holdings) {
            const fx = h.currency === 'USD' ? usdJpy : 1
            const close = indexMaps.get(h.ticker)?.get(date) ?? lastClose[h.ticker]
            if (close != null) {
              lastClose[h.ticker] = close
              total += close * h.shares * fx
            }
          }
          if (total > 0) points.push({ date, value: Math.round(total), cost: Math.round(totalCost) })
        }

        // 期間に応じて間引き
        const opt = PERIOD_OPTIONS.find((p) => p.key === period)!
        const step = period === '2y' ? 21 : period === '1y' ? 5 : 1 // 月次・週次に近い間隔
        const sampled = points.filter((_, i) => i % step === 0 || i === points.length - 1)

        if (!cancelled) setSeries(sampled)
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => { cancelled = true }
  }, [holdings, period])

  const stats = useMemo(() => {
    if (series.length === 0) return null
    const last = series[series.length - 1]
    const first = series[0]
    const pnl = last.value - last.cost
    const pnlPercent = last.cost > 0 ? (pnl / last.cost) * 100 : 0
    const periodChange = ((last.value - first.value) / first.value) * 100
    return { last, pnl, pnlPercent, periodChange }
  }, [series])

  if (holdings.length === 0) {
    return (
      <div className="card" style={{ padding: '24px', textAlign: 'center' }}>
        <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          ポートフォリオに銘柄を登録すると推移が表示されます
        </p>
      </div>
    )
  }

  return (
    <div className="card" style={{ padding: '12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px', flexWrap: 'wrap', gap: '8px' }}>
        <div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>評価額の推移</div>
          {stats && (
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '14px', fontWeight: 600 }}>
              ¥{stats.last.value.toLocaleString('ja-JP')}
              <span style={{
                marginLeft: '8px',
                fontSize: '11px',
                color: stats.pnl >= 0 ? 'var(--price-up)' : 'var(--price-down)',
              }}>
                {stats.pnl >= 0 ? '+' : ''}¥{stats.pnl.toLocaleString('ja-JP')} ({stats.pnl >= 0 ? '+' : ''}{stats.pnlPercent.toFixed(2)}%)
              </span>
            </div>
          )}
        </div>

        <div style={{ display: 'inline-flex', border: '1px solid var(--border-base)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
          {PERIOD_OPTIONS.map((p) => (
            <button
              key={p.key}
              onClick={() => setPeriod(p.key)}
              style={{
                padding: '4px 10px',
                fontSize: '10px',
                fontFamily: 'var(--font-mono)',
                background: period === p.key ? 'var(--accent-primary)' : 'transparent',
                color: period === p.key ? '#fff' : 'var(--text-secondary)',
                border: 'none',
                cursor: 'pointer',
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {error && <p style={{ fontSize: '11px', color: 'var(--price-down)', margin: '4px 0' }}>エラー: {error}</p>}

      <div style={{ height: '200px' }}>
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
              />
              <YAxis
                domain={['auto', 'auto']}
                tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
                tickFormatter={(v) => `${(v / 10000).toFixed(0)}万`}
                axisLine={{ stroke: 'var(--border-base)' }}
                tickLine={false}
                width={55}
              />
              <Tooltip
                contentStyle={{
                  background: 'var(--bg-surface)',
                  border: '1px solid var(--border-base)',
                  borderRadius: '4px',
                  fontSize: '11px',
                }}
                formatter={(v, name) => [
                  typeof v === 'number' ? `¥${v.toLocaleString('ja-JP')}` : String(v ?? ''),
                  name === 'value' ? '評価額' : '取得原価',
                ]}
              />
              <ReferenceLine y={stats?.last.cost} stroke="var(--text-muted)" strokeDasharray="3 3" />
              <Line
                type="monotone"
                dataKey="value"
                stroke="var(--accent-primary)"
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  )
}
