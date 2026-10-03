// components/ui/WatchlistButton.tsx
'use client'

import { useEffect, useState } from 'react'
import { Star } from 'lucide-react'
import { useWatchlistStore } from '@/lib/watchlist-store'

interface Props {
  ticker: string
  market?: 'JP' | 'US'
  size?: 'sm' | 'md'
}

/**
 * ウォッチリストへの追加 / 削除を行う共通トグル。
 * SSR との不整合を避けるため、マウント前は非選択状態で表示する。
 */
export function WatchlistButton({ ticker, market = 'JP', size = 'sm' }: Props) {
  const [mounted, setMounted] = useState(false)
  const tickers = useWatchlistStore((s) => s.tickers)
  const usTickers = useWatchlistStore((s) => s.usTickers)
  const toggleJp = useWatchlistStore((s) => s.toggle)
  const toggleUs = useWatchlistStore((s) => s.toggleUs)

  useEffect(() => {
    setMounted(true)
  }, [])

  const normalizedTicker = ticker.trim().toUpperCase().replace(/\.T$/i, '')
  const active = mounted && (market === 'US'
    ? usTickers.includes(normalizedTicker)
    : tickers.includes(normalizedTicker))
  const iconSize = size === 'sm' ? 15 : 18
  const buttonSize = size === 'sm' ? 28 : 32

  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        if (market === 'US') toggleUs(normalizedTicker)
        else toggleJp(normalizedTicker)
      }}
      title={active ? 'ウォッチリストから削除' : 'ウォッチリストに追加'}
      aria-label={`${market} ${normalizedTicker}を${active ? 'ウォッチリストから削除' : 'ウォッチリストに追加'}`}
      aria-pressed={active}
      style={{
        width: buttonSize,
        height: buttonSize,
        padding: 0,
        lineHeight: 1,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: active ? 'var(--color-warning-50, #fff7ed)' : 'transparent',
        color: active ? 'var(--color-brand-600)' : 'var(--text-muted)',
        border: active ? '1px solid var(--color-warning-200, #fed7aa)' : '1px solid transparent',
        borderRadius: 'var(--radius-sm)',
        cursor: 'pointer',
        userSelect: 'none',
      }}
    >
      <Star size={iconSize} fill={active ? 'currentColor' : 'none'} strokeWidth={active ? 2.3 : 2} />
    </button>
  )
}
