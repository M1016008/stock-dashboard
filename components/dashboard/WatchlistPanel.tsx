// components/dashboard/WatchlistPanel.tsx
// Phase 4 B9: ウォッチリスト (localStorage 由来、/api/quote/[ticker] で都度取得)

'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { Card, CardHeader } from '@/components/ui/Card'
import { StageTag } from '@/components/ui/StageTag'
import { useWatchlistStore } from '@/lib/watchlist-store'

interface Quote {
  ticker: string
  name: string
  price: number
  change: number
  changePercent: number
  daily_a_stage?: number | null
}

export function WatchlistPanel() {
  const tickers = useWatchlistStore(s => s.tickers)
  const [rows, setRows] = useState<Quote[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const limited = tickers.slice(0, 8)
    Promise.all(
      limited.map(async (t) => {
        try {
          const res = await fetch(`/api/quote/${t}`)
          if (!res.ok) return null
          const q = (await res.json()) as Quote
          // 日足 A ステージは /api/snapshot/[ticker] で別途取得 (簡略化のため省略)
          return q
        } catch {
          return null
        }
      }),
    )
      .then(arr => { if (!cancelled) setRows(arr.filter((q): q is Quote => q !== null)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [tickers])

  return (
    <Card>
      <CardHeader
        title="ウォッチリスト"
        action={<Link href="/watchlist" className="hover:text-[var(--color-text-secondary)]">すべて見る ↗</Link>}
        hint={`${tickers.length} 銘柄`}
      />
      {tickers.length === 0 ? (
        <div className="py-6 text-center text-[11px] text-[var(--color-text-tertiary)]">
          ウォッチリスト未登録。銘柄詳細ページで ☆ を押して追加してください。
        </div>
      ) : loading ? (
        <div className="py-6 text-center text-[11px] text-[var(--color-text-tertiary)]">読み込み中...</div>
      ) : (
        <div className="divide-y divide-[var(--color-border-soft)]">
          <div className="grid grid-cols-[44px_1fr_64px_64px_28px] gap-2 px-1 pb-1.5 text-[10px] text-[var(--color-text-tertiary)]">
            <span>コード</span><span>銘柄</span><span className="text-right">株価</span><span className="text-right">前日比</span><span>St</span>
          </div>
          {rows.map(r => {
            const tone = r.changePercent > 0 ? 'text-[var(--color-price-up)]' : r.changePercent < 0 ? 'text-[var(--color-price-down)]' : ''
            return (
              <Link
                key={r.ticker}
                href={`/stock/${r.ticker}`}
                className="grid grid-cols-[44px_1fr_64px_64px_28px] items-center gap-2 px-1 py-1.5 text-[12px] hover:bg-[var(--color-surface-subtle)]"
              >
                <span className="tabular-nums text-[var(--color-text-secondary)]">{r.ticker}</span>
                <span className="truncate">{r.name}</span>
                <span className="tabular-nums text-right">{r.price.toLocaleString()}</span>
                <span className={`tabular-nums text-right ${tone}`}>
                  {(r.changePercent > 0 ? '+' : '') + r.changePercent.toFixed(2) + '%'}
                </span>
                <StageTag stage={r.daily_a_stage ?? null} size="xs" />
              </Link>
            )
          })}
        </div>
      )}
    </Card>
  )
}
