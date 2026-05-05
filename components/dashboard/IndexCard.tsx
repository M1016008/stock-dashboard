// components/dashboard/IndexCard.tsx
'use client'

import { useEffect, useState } from 'react'
import type { StockQuote } from '@/types/stock'

interface IndexCardProps {
  label: string
  ticker: string
  note: string
}

export function IndexCard({ label, ticker, note }: IndexCardProps) {
  const [quote, setQuote] = useState<StockQuote | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        const res = await fetch(`/api/quote/${encodeURIComponent(ticker)}`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data: StockQuote = await res.json()
        if (!cancelled) {
          setQuote(data)
          setError(false)
        }
      } catch (e) {
        if (!cancelled) setError(true)
      }
    }

    load()
    const interval = setInterval(load, 60_000)

    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [ticker])

  const isUp = (quote?.change ?? 0) >= 0
  const changeColor = quote
    ? isUp
      ? 'var(--price-up)'
      : 'var(--price-down)'
    : 'var(--text-muted)'

  return (
    <div className="card" style={{ padding: '12px', cursor: 'default' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '6px' }}>
        <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>{label}</span>
        <span style={{ fontSize: '9px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{note}</span>
      </div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: '18px', fontWeight: 600, color: 'var(--text-primary)' }}>
        {quote ? quote.price.toLocaleString('ja-JP', { maximumFractionDigits: 2 }) : '--,---'}
      </div>
      <div style={{ fontSize: '11px', color: changeColor, fontFamily: 'var(--font-mono)', marginTop: '2px' }}>
        {error
          ? 'エラー'
          : quote
            ? `${isUp ? '+' : ''}${quote.change.toFixed(2)} (${isUp ? '+' : ''}${quote.changePercent.toFixed(2)}%)`
            : '読込中...'}
      </div>
    </div>
  )
}
