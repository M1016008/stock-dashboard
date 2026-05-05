// components/dashboard/HighLowPreview.tsx
'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

interface HighLowRow {
  ticker: string
  name: string
  market: 'JP' | 'US'
  price: number
  changePercent: number
  fiftyTwoWeekHigh?: number
  fiftyTwoWeekLow?: number
  distanceFromHigh?: number
  distanceFromLow?: number
}

interface HighLowPreviewProps {
  type: 'high' | 'low'
}

const PREVIEW_LIMIT = 5

export function HighLowPreview({ type }: HighLowPreviewProps) {
  const [rows, setRows] = useState<HighLowRow[] | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await fetch(`/api/high-low?type=${type}&market=ALL&tolerance=0.005`)
        if (!res.ok) throw new Error('failed')
        const data = await res.json()
        if (!cancelled) setRows(data.results.slice(0, PREVIEW_LIMIT))
      } catch {
        if (!cancelled) setRows([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [type])

  if (loading) {
    return (
      <div className="card" style={{ padding: '12px' }}>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', textAlign: 'center', padding: '16px 0' }}>
          集計中...
        </div>
      </div>
    )
  }

  if (!rows || rows.length === 0) {
    return (
      <div className="card" style={{ padding: '12px' }}>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', textAlign: 'center', padding: '16px 0' }}>
          {type === 'high' ? '本日の新高値はありません' : '本日の新安値はありません'}
        </div>
      </div>
    )
  }

  return (
    <div className="card" style={{ overflow: 'hidden' }}>
      {rows.map((r, i) => {
        const distance = type === 'high' ? r.distanceFromHigh : r.distanceFromLow
        const isUp = r.changePercent >= 0
        const color = isUp ? 'var(--price-up)' : 'var(--price-down)'
        return (
          <Link
            key={r.ticker}
            href={`/stock/${encodeURIComponent(r.ticker)}`}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '7px 12px',
              borderBottom: i < rows.length - 1 ? '1px solid var(--border-subtle)' : 'none',
              textDecoration: 'none',
              fontSize: '11px',
            }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--accent-primary)' }}>
                {r.ticker.replace('.T', '')}
              </span>
              <span style={{ color: 'var(--text-secondary)', maxWidth: '100px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {r.name}
              </span>
            </span>
            <span style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>
                {r.price.toLocaleString()}
              </span>
              <span style={{ fontFamily: 'var(--font-mono)', color, minWidth: '54px', textAlign: 'right' }}>
                {distance !== undefined ? `${distance >= 0 ? '+' : ''}${distance.toFixed(1)}%` : '---'}
              </span>
            </span>
          </Link>
        )
      })}
    </div>
  )
}
