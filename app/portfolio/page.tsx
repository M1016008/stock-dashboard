// app/portfolio/page.tsx
'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { usePortfolioStore } from '@/lib/portfolio-store'
import { HoldingRow } from '@/components/portfolio/HoldingRow'
import { AddHoldingModal } from '@/components/portfolio/AddHoldingModal'
import type { StockQuote } from '@/types/stock'

const USDJPY_FALLBACK = 150

export default function PortfolioPage() {
  const holdings = usePortfolioStore((s) => s.holdings)
  const [quotes, setQuotes] = useState<Record<string, StockQuote>>({})
  const [usdJpy, setUsdJpy] = useState(USDJPY_FALLBACK)
  const [showAddModal, setShowAddModal] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    if (holdings.length === 0) return
    let cancelled = false

    async function loadAll() {
      // ドル円
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

    loadAll()
    const interval = setInterval(loadAll, 60_000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [holdings, refreshKey])

  const summary = useMemo(() => {
    let totalValueJPY = 0
    let totalCostJPY = 0
    for (const h of holdings) {
      const q = quotes[h.ticker]
      const fx = h.currency === 'USD' ? usdJpy : 1
      const price = q?.price ?? 0
      totalValueJPY += price * h.shares * fx
      totalCostJPY += h.avgCost * h.shares * fx
    }
    const profit = totalValueJPY - totalCostJPY
    const profitPercent = totalCostJPY > 0 ? (profit / totalCostJPY) * 100 : 0
    return {
      totalValueJPY,
      totalCostJPY,
      profit,
      profitPercent,
    }
  }, [holdings, quotes, usdJpy])

  const isUp = summary.profit >= 0
  const profitColor = isUp ? 'var(--price-up)' : 'var(--price-down)'

  return (
    <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-end',
        borderBottom: '1px solid var(--border-subtle)',
        paddingBottom: '12px',
      }}>
        <div>
          <h1 style={{
            fontFamily: 'var(--font-display)',
            fontSize: '16px',
            fontWeight: 700,
            color: 'var(--text-primary)',
          }}>
            ポートフォリオ
          </h1>
          <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
            保有株式の管理・損益確認（ドル円: ¥{usdJpy.toFixed(2)}）
          </p>
        </div>
        <button onClick={() => setShowAddModal(true)} style={addBtn}>
          + 銘柄を追加
        </button>
      </div>

      {/* サマリー */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px' }}>
        <div className="card" style={{ padding: '12px' }}>
          <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '4px' }}>
            総資産（JPY換算）
          </div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: '20px', fontWeight: 600 }}>
            {holdings.length > 0
              ? `¥ ${Math.round(summary.totalValueJPY).toLocaleString('ja-JP')}`
              : '¥ ---'}
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
            {holdings.length} 銘柄
          </div>
        </div>

        <div className="card" style={{ padding: '12px' }}>
          <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '4px' }}>
            評価損益
          </div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: '20px', fontWeight: 600, color: holdings.length > 0 ? profitColor : 'var(--text-muted)' }}>
            {holdings.length > 0
              ? `${isUp ? '+' : ''}¥${Math.round(summary.profit).toLocaleString('ja-JP')}`
              : '---'}
          </div>
          <div style={{ fontSize: '11px', color: holdings.length > 0 ? profitColor : 'var(--text-muted)', marginTop: '2px' }}>
            {holdings.length > 0
              ? `${isUp ? '+' : ''}${summary.profitPercent.toFixed(2)}%`
              : '+-.-%'}
          </div>
        </div>

        <div className="card" style={{ padding: '12px' }}>
          <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '4px' }}>
            取得原価
          </div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: '20px', fontWeight: 600 }}>
            {holdings.length > 0
              ? `¥ ${Math.round(summary.totalCostJPY).toLocaleString('ja-JP')}`
              : '¥ ---'}
          </div>
        </div>
      </div>

      {/* 保有銘柄テーブル */}
      {holdings.length > 0 ? (
        <div className="card" style={{ overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
              <thead>
                <tr style={{ background: 'var(--bg-elevated)', borderBottom: '1px solid var(--border-dim)' }}>
                  <th style={headStyle}>銘柄</th>
                  <th style={headStyleR}>株数</th>
                  <th style={headStyleR}>取得単価</th>
                  <th style={headStyleR}>現在値</th>
                  <th style={headStyleR}>評価額</th>
                  <th style={headStyleR}>評価損益</th>
                  <th style={{ ...headStyleR, width: '160px' }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {holdings.map((h) => (
                  <HoldingRow key={h.id} holding={h} quote={quotes[h.ticker]} />
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ padding: '8px 12px', borderTop: '1px solid var(--border-subtle)', textAlign: 'right' }}>
            <button onClick={() => setRefreshKey((k) => k + 1)} style={refreshBtn}>
              ⟳ 価格を更新
            </button>
          </div>
        </div>
      ) : (
        <div className="card" style={{ padding: '48px', textAlign: 'center' }}>
          <div style={{ fontSize: '32px', marginBottom: '16px' }}>💼</div>
          <h2 style={{ fontSize: '14px', marginBottom: '8px', color: 'var(--text-primary)' }}>
            保有銘柄がありません
          </h2>
          <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '16px' }}>
            「+ 銘柄を追加」ボタンから登録してください
          </p>
          <Link href="/screener" style={{
            display: 'inline-block',
            padding: '8px 16px',
            background: 'var(--accent-dim)',
            color: 'var(--accent-primary)',
            border: '1px solid rgba(245,166,35,0.3)',
            borderRadius: 'var(--radius-sm)',
            fontSize: '12px',
            fontFamily: 'var(--font-mono)',
            textDecoration: 'none',
          }}>
            スクリーナーで銘柄を探す →
          </Link>
        </div>
      )}

      <AddHoldingModal open={showAddModal} onClose={() => setShowAddModal(false)} />
    </div>
  )
}

const addBtn: React.CSSProperties = {
  padding: '6px 14px',
  background: 'var(--accent-primary)',
  border: 'none',
  borderRadius: 'var(--radius-sm)',
  color: '#000',
  fontSize: '12px',
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: 'var(--font-mono)',
}

const refreshBtn: React.CSSProperties = {
  padding: '4px 10px',
  background: 'transparent',
  border: '1px solid var(--border-base)',
  borderRadius: 'var(--radius-sm)',
  fontSize: '11px',
  fontFamily: 'var(--font-mono)',
  cursor: 'pointer',
  color: 'var(--text-secondary)',
}

const headStyle: React.CSSProperties = {
  padding: '8px 12px',
  textAlign: 'left',
  fontFamily: 'var(--font-mono)',
  fontWeight: 500,
  color: 'var(--text-muted)',
  fontSize: '11px',
}

const headStyleR: React.CSSProperties = {
  ...headStyle,
  textAlign: 'right',
}
