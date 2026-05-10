// app/watchlist/page.tsx
'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useWatchlistStore } from '@/lib/watchlist-store'
import { WatchlistButton } from '@/components/ui/WatchlistButton'
import { findTicker } from '@/lib/master/tickers'
import { toTvSymbol, buildTvWatchlistText } from '@/lib/tv-format'

interface QuoteResponse {
  ticker: string
  name: string
  market: 'JP'
  price: number
  change: number
  changePercent: number
  volume: number
  marketCap?: number
  currency: 'JPY'
}

export default function WatchlistPage() {
  const [mounted, setMounted] = useState(false)
  const tickers = useWatchlistStore((s) => s.tickers)
  const clear = useWatchlistStore((s) => s.clear)
  const [quotes, setQuotes] = useState<Record<string, QuoteResponse | null>>({})
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  useEffect(() => {
    if (!mounted) return
    if (tickers.length === 0) {
      setQuotes({})
      return
    }
    let cancelled = false
    setLoading(true)
    const fetchAll = async () => {
      const entries = await Promise.all(
        tickers.map(async (t): Promise<[string, QuoteResponse | null]> => {
          try {
            const res = await fetch(`/api/quote/${encodeURIComponent(t)}`)
            if (!res.ok) return [t, null]
            const data = (await res.json()) as QuoteResponse
            return [t, data]
          } catch {
            return [t, null]
          }
        }),
      )
      if (cancelled) return
      const map: Record<string, QuoteResponse | null> = {}
      for (const [t, q] of entries) map[t] = q
      setQuotes(map)
      setLoading(false)
    }
    fetchAll()
    const id = setInterval(fetchAll, 60_000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [mounted, tickers])

  function downloadTvWatchlist() {
    const symbols = tickers.map((t) => {
      const m = findTicker(t)
      return toTvSymbol(t, m?.marketSegment)
    })
    const today = new Date().toISOString().split('T')[0]
    const sectionName = `Watchlist_${today}`
    const text = buildTvWatchlistText(symbols, sectionName)
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${sectionName}.txt`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  return (
    <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{ borderBottom: '1px solid var(--border-subtle)', paddingBottom: '12px' }}>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '16px', fontWeight: 700 }}>
          ⭐ ウォッチリスト
        </h1>
        <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
          お気に入り銘柄の株価と騰落率（60秒ごとに自動更新）
        </p>
      </div>

      {!mounted ? (
        <div className="card" style={{ padding: '24px', textAlign: 'center' }}>
          <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>読込中…</p>
        </div>
      ) : tickers.length === 0 ? (
        <div className="card" style={{ padding: '32px', textAlign: 'center' }}>
          <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '8px' }}>
            ウォッチリストは空です
          </p>
          <p style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            銘柄詳細ページやスクリーナー結果の <span style={{ color: 'var(--color-brand-600)' }}>☆</span> ボタンで追加できます。
          </p>
        </div>
      ) : (
        <div className="card" style={{ overflow: 'hidden' }}>
          <div style={{ padding: '8px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-subtle)', gap: '8px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
              <strong>{tickers.length}</strong>銘柄
              {loading && <span style={{ marginLeft: '6px', color: 'var(--text-muted)' }}>更新中…</span>}
            </span>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                onClick={downloadTvWatchlist}
                style={{
                  padding: '6px 12px',
                  fontSize: '11px',
                  background: 'var(--accent-primary)',
                  color: '#fff',
                  border: '1px solid var(--accent-primary)',
                  borderRadius: 'var(--radius-sm)',
                  cursor: 'pointer',
                  fontWeight: 600,
                  fontFamily: 'var(--font-mono)',
                }}
                title="TradingView の銘柄リストにインポートできる .txt をダウンロード"
              >
                📤 TVリストをダウンロード
              </button>
              <button
                onClick={() => {
                  if (confirm('ウォッチリストを全て削除しますか？')) clear()
                }}
                style={{
                  padding: '6px 12px',
                  fontSize: '11px',
                  background: 'var(--bg-surface)',
                  color: 'var(--text-secondary)',
                  border: '1px solid var(--border-base)',
                  borderRadius: 'var(--radius-sm)',
                  cursor: 'pointer',
                  fontWeight: 500,
                }}
              >
                全クリア
              </button>
            </div>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
              <thead>
                <tr style={{ background: 'var(--bg-elevated)', borderBottom: '1px solid var(--border-dim)' }}>
                  <th style={th}></th>
                  <th style={th}>コード</th>
                  <th style={th}>TV形式</th>
                  <th style={th}>銘柄名</th>
                  <th style={thR}>株価</th>
                  <th style={thR}>変化額</th>
                  <th style={thR}>変化率</th>
                  <th style={thR}>出来高</th>
                  <th style={thR}>時価総額</th>
                </tr>
              </thead>
              <tbody>
                {tickers.map((t) => {
                  const q = quotes[t]
                  const m = findTicker(t)
                  const tv = toTvSymbol(t, m?.marketSegment)
                  return (
                    <tr key={t} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                      <td style={{ ...td, width: '32px' }}>
                        <WatchlistButton ticker={t} size="sm" />
                      </td>
                      <td style={td}>
                        <Link href={`/stock/${encodeURIComponent(t)}`} style={{ color: 'var(--accent-primary)', fontFamily: 'var(--font-mono)', textDecoration: 'none', fontWeight: 600 }}>
                          {t.replace('.T', '')}
                        </Link>
                      </td>
                      <td style={{ ...td, fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--text-secondary)' }}>
                        {tv}
                      </td>
                      <td style={td}>{q?.name ?? m?.name ?? '---'}</td>
                      <td style={tdR}>{q?.price?.toLocaleString('ja-JP', { maximumFractionDigits: 2 }) ?? '---'}</td>
                      <td style={{ ...tdR, color: pctColor(q?.change) }}>
                        {q?.change != null ? `${q.change > 0 ? '+' : ''}${q.change.toFixed(2)}` : '---'}
                      </td>
                      <td style={{ ...tdR, color: pctColor(q?.changePercent) }}>
                        {fmtPct(q?.changePercent)}
                      </td>
                      <td style={tdR}>{q?.volume?.toLocaleString('ja-JP') ?? '---'}</td>
                      <td style={tdR}>{q?.marketCap ? `${(q.marketCap / 1e8).toLocaleString('ja-JP', { maximumFractionDigits: 0 })} 億` : '---'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

function fmtPct(v: number | undefined): string {
  if (v == null || !Number.isFinite(v)) return '---'
  const sign = v > 0 ? '+' : ''
  return `${sign}${v.toFixed(2)}%`
}

function pctColor(v: number | undefined): string {
  if (v == null || !Number.isFinite(v)) return 'var(--text-muted)'
  if (v > 0) return 'var(--price-up, #22c55e)'
  if (v < 0) return 'var(--price-down, #ef4444)'
  return 'var(--text-secondary)'
}

const th: React.CSSProperties = {
  padding: '8px 12px',
  textAlign: 'left',
  fontFamily: 'var(--font-mono)',
  fontWeight: 500,
  color: 'var(--text-muted)',
  fontSize: '11px',
  whiteSpace: 'nowrap',
}
const thR: React.CSSProperties = { ...th, textAlign: 'right' }
const td: React.CSSProperties = { padding: '8px 12px', fontSize: '12px', color: 'var(--text-primary)' }
const tdR: React.CSSProperties = { ...td, textAlign: 'right', fontFamily: 'var(--font-mono)' }
