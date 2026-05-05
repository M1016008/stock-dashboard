// components/portfolio/HoldingRow.tsx
'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePortfolioStore } from '@/lib/portfolio-store'
import { MarketBadge } from '@/components/ui/MarketBadge'
import type { PortfolioHolding, StockQuote } from '@/types/stock'

interface HoldingRowProps {
  holding: PortfolioHolding
  quote?: StockQuote
}

export function HoldingRow({ holding, quote }: HoldingRowProps) {
  const removeHolding = usePortfolioStore((s) => s.removeHolding)
  const updateHolding = usePortfolioStore((s) => s.updateHolding)
  const [editing, setEditing] = useState(false)
  const [shares, setShares] = useState(String(holding.shares))
  const [avgCost, setAvgCost] = useState(String(holding.avgCost))

  const currentPrice = quote?.price ?? 0
  const currentValue = currentPrice * holding.shares
  const cost = holding.avgCost * holding.shares
  const profit = currentValue - cost
  const profitPercent = cost > 0 ? (profit / cost) * 100 : 0
  const isUp = profit >= 0
  const color = isUp ? 'var(--price-up)' : 'var(--price-down)'

  const ccyFmt = (v: number) =>
    holding.currency === 'JPY'
      ? `¥${Math.round(v).toLocaleString('ja-JP')}`
      : `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

  const handleSave = () => {
    const sharesNum = Number(shares)
    const costNum = Number(avgCost)
    if (Number.isFinite(sharesNum) && sharesNum > 0 && Number.isFinite(costNum) && costNum > 0) {
      updateHolding(holding.id, sharesNum, costNum)
      setEditing(false)
    }
  }

  const handleRemove = () => {
    if (confirm(`${holding.ticker} をポートフォリオから削除しますか?`)) {
      removeHolding(holding.id)
    }
  }

  return (
    <tr style={{ borderBottom: '1px solid var(--border-subtle)' }}>
      <td style={{ padding: '8px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Link
            href={`/stock/${encodeURIComponent(holding.ticker)}`}
            style={{ color: 'var(--accent-primary)', fontFamily: 'var(--font-mono)', textDecoration: 'none', fontSize: '12px' }}
          >
            {holding.ticker.replace('.T', '')}
          </Link>
          <MarketBadge market={holding.market} />
        </div>
        {quote && (
          <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>
            {quote.name}
          </div>
        )}
      </td>

      <td style={cellStyle}>
        {editing ? (
          <input
            type="number"
            value={shares}
            onChange={(e) => setShares(e.target.value)}
            style={inlineInput}
          />
        ) : (
          holding.shares.toLocaleString()
        )}
      </td>

      <td style={cellStyle}>
        {editing ? (
          <input
            type="number"
            value={avgCost}
            onChange={(e) => setAvgCost(e.target.value)}
            step="0.01"
            style={inlineInput}
          />
        ) : (
          ccyFmt(holding.avgCost)
        )}
      </td>

      <td style={cellStyle}>
        {currentPrice > 0 ? ccyFmt(currentPrice) : '---'}
      </td>

      <td style={cellStyle}>
        {currentPrice > 0 ? ccyFmt(currentValue) : '---'}
      </td>

      <td style={{ ...cellStyle, color }}>
        {currentPrice > 0
          ? `${isUp ? '+' : ''}${ccyFmt(profit)} (${isUp ? '+' : ''}${profitPercent.toFixed(2)}%)`
          : '---'}
      </td>

      <td style={{ padding: '8px 12px', textAlign: 'right' }}>
        {editing ? (
          <>
            <button onClick={handleSave} style={{ ...iconBtn, color: 'var(--price-up)' }}>保存</button>
            <button onClick={() => { setEditing(false); setShares(String(holding.shares)); setAvgCost(String(holding.avgCost)) }} style={iconBtn}>取消</button>
          </>
        ) : (
          <>
            <button onClick={() => setEditing(true)} style={iconBtn}>編集</button>
            <button onClick={handleRemove} style={{ ...iconBtn, color: 'var(--price-down)' }}>削除</button>
          </>
        )}
      </td>
    </tr>
  )
}

const cellStyle: React.CSSProperties = {
  padding: '8px 12px',
  fontFamily: 'var(--font-mono)',
  fontSize: '12px',
  color: 'var(--text-primary)',
  textAlign: 'right',
}

const inlineInput: React.CSSProperties = {
  width: '90px',
  padding: '3px 6px',
  background: 'var(--bg-void)',
  border: '1px solid var(--border-base)',
  borderRadius: 'var(--radius-sm)',
  color: 'var(--text-primary)',
  fontFamily: 'var(--font-mono)',
  fontSize: '12px',
  textAlign: 'right',
}

const iconBtn: React.CSSProperties = {
  padding: '3px 8px',
  marginLeft: '4px',
  background: 'transparent',
  border: '1px solid var(--border-base)',
  borderRadius: 'var(--radius-sm)',
  fontSize: '11px',
  fontFamily: 'var(--font-mono)',
  cursor: 'pointer',
  color: 'var(--text-secondary)',
}
