// components/ui/WatchlistButton.tsx
'use client'

import { useEffect, useState } from 'react'
import { useWatchlistStore } from '@/lib/watchlist-store'

interface Props {
  ticker: string
  size?: 'sm' | 'md'
}

/**
 * ⭐ トグルボタン。ウォッチリストへの追加 / 削除を行う。
 * SSR との不整合を避けるため、マウント前は非選択状態で表示する。
 */
export function WatchlistButton({ ticker, size = 'sm' }: Props) {
  const [mounted, setMounted] = useState(false)
  const tickers = useWatchlistStore((s) => s.tickers)
  const toggle = useWatchlistStore((s) => s.toggle)

  useEffect(() => {
    setMounted(true)
  }, [])

  const active = mounted && tickers.includes(ticker)
  const dim = size === 'sm' ? '14px' : '18px'
  const padding = size === 'sm' ? '2px 6px' : '4px 10px'

  return (
    <button
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        toggle(ticker)
      }}
      title={active ? 'ウォッチリストから削除' : 'ウォッチリストに追加'}
      style={{
        padding,
        fontSize: dim,
        lineHeight: 1,
        background: 'transparent',
        color: active ? 'var(--color-brand-600)' : 'var(--text-muted)',
        border: 'none',
        borderRadius: 'var(--radius-sm)',
        cursor: 'pointer',
        userSelect: 'none',
      }}
    >
      {active ? '★' : '☆'}
    </button>
  )
}
