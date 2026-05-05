// components/portfolio/AddHoldingModal.tsx
'use client'

import { useEffect, useState } from 'react'
import { usePortfolioStore } from '@/lib/portfolio-store'
import type { PortfolioHolding } from '@/types/stock'

interface SearchResult {
  ticker: string
  name: string
  market: 'JP' | 'US'
}

interface AddHoldingModalProps {
  open: boolean
  onClose: () => void
  /** 既知の ticker を渡すと検索 UI をスキップ */
  fixedTicker?: string
  fixedName?: string
  fixedMarket?: 'JP' | 'US'
}

export function AddHoldingModal({
  open,
  onClose,
  fixedTicker,
  fixedName,
  fixedMarket,
}: AddHoldingModalProps) {
  const addHolding = usePortfolioStore((s) => s.addHolding)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [selected, setSelected] = useState<SearchResult | null>(
    fixedTicker
      ? { ticker: fixedTicker, name: fixedName ?? fixedTicker, market: fixedMarket ?? 'JP' }
      : null,
  )
  const [shares, setShares] = useState('')
  const [avgCost, setAvgCost] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) {
      // モーダルを閉じる時にリセット（fixedTicker は維持）
      if (!fixedTicker) {
        setSelected(null)
        setQuery('')
        setResults([])
      }
      setShares('')
      setAvgCost('')
      setError('')
    } else if (fixedTicker) {
      setSelected({
        ticker: fixedTicker,
        name: fixedName ?? fixedTicker,
        market: fixedMarket ?? 'JP',
      })
    }
  }, [open, fixedTicker, fixedName, fixedMarket])

  // ティッカー検索（debounce）
  useEffect(() => {
    if (!query || query.length < 1 || selected) {
      setResults([])
      return
    }
    setSearching(true)
    const handler = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`)
        if (res.ok) {
          const data = await res.json()
          setResults(data.results ?? data ?? [])
        }
      } catch {
        // ignore
      } finally {
        setSearching(false)
      }
    }, 300)
    return () => clearTimeout(handler)
  }, [query, selected])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!selected) {
      setError('銘柄を選択してください')
      return
    }
    const sharesNum = Number(shares)
    const costNum = Number(avgCost)
    if (!Number.isFinite(sharesNum) || sharesNum <= 0) {
      setError('株数を正しく入力してください')
      return
    }
    if (!Number.isFinite(costNum) || costNum <= 0) {
      setError('取得単価を正しく入力してください')
      return
    }

    const holding: Omit<PortfolioHolding, 'id'> = {
      ticker: selected.ticker,
      market: selected.market,
      shares: sharesNum,
      avgCost: costNum,
      currency: selected.market === 'JP' ? 'JPY' : 'USD',
    }
    addHolding(holding)
    onClose()
  }

  if (!open) return null

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="card"
        style={{
          width: '420px',
          padding: '20px',
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-base)',
        }}
      >
        <h2 style={{ fontSize: '14px', marginBottom: '16px', fontWeight: 600 }}>
          {fixedTicker ? `${fixedTicker} をポートフォリオに追加` : 'ポートフォリオに銘柄を追加'}
        </h2>

        {/* 銘柄選択（固定 ticker でない場合） */}
        {!fixedTicker && (
          <div style={{ marginBottom: '12px' }}>
            <label style={labelStyle}>銘柄</label>
            {selected ? (
              <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '8px',
                background: 'var(--bg-surface)',
                border: '1px solid var(--border-base)',
                borderRadius: 'var(--radius-sm)',
                fontSize: '12px',
              }}>
                <span style={{ fontFamily: 'var(--font-mono)' }}>
                  <span style={{ color: 'var(--accent-primary)' }}>{selected.ticker}</span> — {selected.name}
                </span>
                <button
                  type="button"
                  onClick={() => setSelected(null)}
                  style={chipBtn}
                >
                  変更
                </button>
              </div>
            ) : (
              <>
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="例: トヨタ / 7203 / AAPL"
                  style={inputStyle}
                  autoFocus
                />
                {searching && <p style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '4px' }}>検索中...</p>}
                {results.length > 0 && (
                  <div style={{
                    marginTop: '4px',
                    maxHeight: '160px',
                    overflowY: 'auto',
                    border: '1px solid var(--border-base)',
                    borderRadius: 'var(--radius-sm)',
                  }}>
                    {results.map((r) => (
                      <button
                        type="button"
                        key={r.ticker}
                        onClick={() => { setSelected(r); setQuery(''); setResults([]) }}
                        style={resultBtn}
                      >
                        <span style={{ color: 'var(--accent-primary)', fontFamily: 'var(--font-mono)', marginRight: '8px' }}>
                          {r.ticker}
                        </span>
                        <span style={{ color: 'var(--text-secondary)', fontSize: '11px' }}>{r.name}</span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '12px' }}>
            <div>
              <label style={labelStyle}>株数</label>
              <input
                type="number"
                value={shares}
                onChange={(e) => setShares(e.target.value)}
                placeholder="100"
                step="1"
                min="0"
                style={inputStyle}
              />
            </div>
            <div>
              <label style={labelStyle}>
                取得単価 ({selected?.market === 'US' ? 'USD' : 'JPY'})
              </label>
              <input
                type="number"
                value={avgCost}
                onChange={(e) => setAvgCost(e.target.value)}
                placeholder={selected?.market === 'US' ? '150.00' : '2500'}
                step="0.01"
                min="0"
                style={inputStyle}
              />
            </div>
          </div>

          {error && (
            <p style={{ color: 'var(--price-down)', fontSize: '11px', marginBottom: '12px' }}>
              {error}
            </p>
          )}

          <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
            <button type="button" onClick={onClose} style={cancelBtn}>キャンセル</button>
            <button type="submit" style={submitBtn}>追加</button>
          </div>
        </form>
      </div>
    </div>
  )
}

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: '10px',
  color: 'var(--text-muted)',
  marginBottom: '4px',
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '6px 8px',
  background: 'var(--bg-void)',
  border: '1px solid var(--border-base)',
  borderRadius: 'var(--radius-sm)',
  color: 'var(--text-primary)',
  fontFamily: 'var(--font-mono)',
  fontSize: '12px',
  boxSizing: 'border-box',
}

const chipBtn: React.CSSProperties = {
  fontSize: '10px',
  padding: '2px 8px',
  background: 'var(--accent-dim)',
  color: 'var(--accent-primary)',
  border: '1px solid rgba(245,166,35,0.3)',
  borderRadius: 'var(--radius-sm)',
  cursor: 'pointer',
  fontFamily: 'var(--font-mono)',
}

const resultBtn: React.CSSProperties = {
  display: 'block',
  width: '100%',
  textAlign: 'left',
  padding: '6px 8px',
  background: 'transparent',
  border: 'none',
  borderBottom: '1px solid var(--border-subtle)',
  cursor: 'pointer',
  color: 'var(--text-primary)',
}

const cancelBtn: React.CSSProperties = {
  padding: '6px 14px',
  background: 'transparent',
  border: '1px solid var(--border-base)',
  borderRadius: 'var(--radius-sm)',
  color: 'var(--text-secondary)',
  fontSize: '12px',
  cursor: 'pointer',
  fontFamily: 'var(--font-mono)',
}

const submitBtn: React.CSSProperties = {
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
