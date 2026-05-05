// components/stock/PerformanceCard.tsx
'use client'

import { useEffect, useState } from 'react'
import type { OHLCV } from '@/types/stock'

interface PerformanceCardProps {
  ticker: string
}

interface PerfRow {
  label: string
  value: number | null
}

function pctFromHistory(ohlcv: OHLCV[], periodsBack: number): number | null {
  if (ohlcv.length <= periodsBack) return null
  const last = ohlcv[ohlcv.length - 1]?.close
  const prev = ohlcv[ohlcv.length - 1 - periodsBack]?.close
  if (last == null || prev == null || prev === 0) return null
  return ((last - prev) / prev) * 100
}

/**
 * 直近の変化率を一目で確認できるカード
 * 1日 / 1週 / 1ヶ月 / 3ヶ月 / 6ヶ月 / 年初来
 */
export function PerformanceCard({ ticker }: PerformanceCardProps) {
  const [perf, setPerf] = useState<PerfRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(`/api/history/${encodeURIComponent(ticker)}?period=1y`)
      .then((r) => r.json())
      .then((d: OHLCV[] | { error: string }) => {
        if (cancelled || !Array.isArray(d)) return
        setPerf([
          { label: '1日', value: pctFromHistory(d, 1) },
          { label: '1週', value: pctFromHistory(d, 5) },
          { label: '1ヶ月', value: pctFromHistory(d, 21) },
          { label: '3ヶ月', value: pctFromHistory(d, 63) },
          { label: '6ヶ月', value: pctFromHistory(d, 126) },
          { label: '年初来', value: pctFromHistory(d, 252) },
        ])
      })
      .catch(() => { /* ignore */ })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [ticker])

  return (
    <div className="card" style={{ padding: '12px' }}>
      <div style={{ fontSize: '11px', fontWeight: 600, marginBottom: '8px' }}>直近の変化率</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: '6px' }}>
        {perf.length === 0 && loading && (
          <div style={{ gridColumn: 'span 6', textAlign: 'center', fontSize: '11px', color: 'var(--text-muted)' }}>計算中...</div>
        )}
        {perf.map(({ label, value }) => {
          const isUp = (value ?? 0) >= 0
          const color = value == null ? 'var(--text-muted)' : isUp ? 'var(--price-up)' : 'var(--price-down)'
          return (
            <div key={label} style={{
              padding: '8px',
              background: 'var(--bg-elevated)',
              borderRadius: 'var(--radius-sm)',
              textAlign: 'center',
              border: '1px solid var(--border-subtle)',
            }}>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '2px' }}>{label}</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '13px', fontWeight: 600, color }}>
                {value == null ? '---' : `${isUp ? '+' : ''}${value.toFixed(2)}%`}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
