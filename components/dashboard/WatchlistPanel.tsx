// components/dashboard/WatchlistPanel.tsx
'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePortfolioStore } from '@/lib/portfolio-store'
import { findTicker } from '@/lib/master/tickers'
import type { StockQuote } from '@/types/stock'

export function WatchlistPanel() {
  const watchlist = usePortfolioStore((s) => s.watchlist)
  const [quotes, setQuotes] = useState<Record<string, StockQuote>>({})

  useEffect(() => {
    if (watchlist.length === 0) return

    let cancelled = false

    async function loadAll() {
      for (const ticker of watchlist) {
        if (cancelled) break
        try {
          const res = await fetch(`/api/quote/${encodeURIComponent(ticker)}`)
          if (!res.ok) continue
          const data: StockQuote = await res.json()
          if (!cancelled) setQuotes((q) => ({ ...q, [ticker]: data }))
        } catch {
          // ignore
        }
        await new Promise((r) => setTimeout(r, 120))
      }
    }

    loadAll()
    const interval = setInterval(loadAll, 60_000)

    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [watchlist])

  if (watchlist.length === 0) {
    return (
      <div className="card" style={{ padding: '24px', textAlign: 'center' }}>
        <p style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
          ウォッチリストが空です
        </p>
      </div>
    )
  }

  return (
    <div className="card" style={{ overflow: 'hidden' }}>
      {watchlist.map((ticker, i) => {
        const q = quotes[ticker]
        const master = findTicker(ticker)
        const isUp = (q?.change ?? 0) >= 0
        const color = q ? (isUp ? 'var(--price-up)' : 'var(--price-down)') : 'var(--text-muted)'
        const name = master?.name ?? q?.name ?? '---'
        const sector = master?.sectorLarge ?? ''
        return (
          <Link
            key={ticker}
            href={`/stock/${encodeURIComponent(ticker)}`}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '8px 12px',
              borderBottom: i < watchlist.length - 1 ? '1px solid var(--border-subtle)' : 'none',
              textDecoration: 'none',
              gap: '8px',
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px' }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--accent-primary)', fontWeight: 600 }}>
                  {ticker.replace('.T', '')}
                </span>
                <span style={{
                  fontSize: '11px',
                  color: 'var(--text-secondary)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}>
                  {name}
                </span>
              </div>
              {sector && (
                <div style={{ fontSize: '9px', color: 'var(--text-muted)', marginTop: '1px' }}>
                  {sector}
                </div>
              )}
            </div>
            <div style={{ textAlign: 'right', flexShrink: 0 }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--text-primary)' }}>
                {q ? q.price.toLocaleString('ja-JP', { maximumFractionDigits: 2 }) : '---'}
              </div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', color }}>
                {q ? `${isUp ? '+' : ''}${q.changePercent.toFixed(2)}%` : '--.--%'}
              </div>
            </div>
          </Link>
        )
      })}
    </div>
  )
}
