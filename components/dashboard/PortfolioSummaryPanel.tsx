// components/dashboard/PortfolioSummaryPanel.tsx
'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { usePortfolioStore } from '@/lib/portfolio-store'
import type { StockQuote } from '@/types/stock'

const USDJPY_FALLBACK = 150 // ドル円フォールバック（通信不能時）

export function PortfolioSummaryPanel() {
  const holdings = usePortfolioStore((s) => s.holdings)
  const [quotes, setQuotes] = useState<Record<string, StockQuote>>({})
  const [usdJpy, setUsdJpy] = useState<number>(USDJPY_FALLBACK)

  useEffect(() => {
    let cancelled = false

    async function loadAll() {
      // ドル円（米国株がある時のみ）
      if (holdings.some((h) => h.currency === 'USD')) {
        try {
          const fxRes = await fetch('/api/quote/JPY%3DX')
          if (fxRes.ok) {
            const fx: StockQuote = await fxRes.json()
            if (!cancelled && fx.price > 0) setUsdJpy(fx.price)
          }
        } catch {
          // ignore
        }
      }

      // 各銘柄の現在価格
      for (const h of holdings) {
        if (cancelled) break
        try {
          const res = await fetch(`/api/quote/${encodeURIComponent(h.ticker)}`)
          if (!res.ok) continue
          const data: StockQuote = await res.json()
          if (!cancelled) setQuotes((q) => ({ ...q, [h.ticker]: data }))
        } catch {
          // ignore
        }
        await new Promise((r) => setTimeout(r, 120))
      }
    }

    if (holdings.length > 0) {
      loadAll()
    }

    return () => {
      cancelled = true
    }
  }, [holdings])

  const summary = useMemo(() => {
    if (holdings.length === 0) return null

    let totalValueJPY = 0
    let totalCostJPY = 0
    let count = 0

    for (const h of holdings) {
      const q = quotes[h.ticker]
      if (!q) continue
      const fx = h.currency === 'USD' ? usdJpy : 1
      totalValueJPY += q.price * h.shares * fx
      totalCostJPY += h.avgCost * h.shares * fx
      count += 1
    }

    const profit = totalValueJPY - totalCostJPY
    const profitPercent = totalCostJPY > 0 ? (profit / totalCostJPY) * 100 : 0

    return { totalValueJPY, totalCostJPY, profit, profitPercent, count, total: holdings.length }
  }, [holdings, quotes, usdJpy])

  if (holdings.length === 0) {
    return (
      <div className="card" style={{ padding: '12px' }}>
        <div style={{ marginBottom: '12px' }}>
          <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '4px' }}>総資産（概算）</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: '20px', fontWeight: 600 }}>¥ ---,---</div>
        </div>
        <div style={{ marginBottom: '12px' }}>
          <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '4px' }}>評価損益</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: '14px', color: 'var(--text-muted)' }}>
            ポートフォリオを設定してください
          </div>
        </div>
        <Link href="/portfolio" style={linkStyle}>
          ポートフォリオを管理 →
        </Link>
      </div>
    )
  }

  const isUp = (summary?.profit ?? 0) >= 0
  const color = isUp ? 'var(--price-up)' : 'var(--price-down)'

  return (
    <div className="card" style={{ padding: '12px' }}>
      <div style={{ marginBottom: '12px' }}>
        <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '4px' }}>
          総資産（概算 / {summary?.count}/{summary?.total}件取得）
        </div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: '20px', fontWeight: 600 }}>
          ¥ {summary ? Math.round(summary.totalValueJPY).toLocaleString('ja-JP') : '---'}
        </div>
      </div>
      <div style={{ marginBottom: '12px' }}>
        <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '4px' }}>評価損益</div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: '14px', color }}>
          {summary
            ? `${isUp ? '+' : ''}¥${Math.round(summary.profit).toLocaleString('ja-JP')} (${isUp ? '+' : ''}${summary.profitPercent.toFixed(2)}%)`
            : '計算中...'}
        </div>
      </div>
      <Link href="/portfolio" style={linkStyle}>
        ポートフォリオを管理 →
      </Link>
    </div>
  )
}

const linkStyle: React.CSSProperties = {
  display: 'inline-block',
  padding: '5px 10px',
  background: 'var(--accent-dim)',
  color: 'var(--accent-primary)',
  borderRadius: 'var(--radius-sm)',
  fontSize: '11px',
  fontFamily: 'var(--font-mono)',
  textDecoration: 'none',
  border: '1px solid rgba(245,166,35,0.3)',
}
