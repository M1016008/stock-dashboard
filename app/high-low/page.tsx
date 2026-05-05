// app/high-low/page.tsx
'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { MarketBadge } from '@/components/ui/MarketBadge'

interface HighLowRow {
  ticker: string
  name: string
  market: 'JP' | 'US'
  price: number
  changePercent: number
  volume: number
  fiftyTwoWeekHigh?: number
  fiftyTwoWeekLow?: number
  distanceFromHigh?: number
  distanceFromLow?: number
}

export default function HighLowPage() {
  const [type, setType] = useState<'high' | 'low'>('high')
  const [market, setMarket] = useState<'JP' | 'US' | 'ALL'>('ALL')
  const [minVolume, setMinVolume] = useState('0')
  const [tolerance, setTolerance] = useState('0.5') // %
  const [results, setResults] = useState<HighLowRow[]>([])
  const [universe, setUniverse] = useState(0)
  const [loading, setLoading] = useState(false)
  const [cached, setCached] = useState(false)
  const [error, setError] = useState('')

  const run = async () => {
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams({
        type,
        market,
        tolerance: String(Number(tolerance) / 100), // 0.5% → 0.005
        minVolume: String(Math.max(0, Number(minVolume) || 0)),
      })
      const res = await fetch(`/api/high-low?${params}`)
      if (!res.ok) {
        const e = await res.json()
        throw new Error(e.message ?? 'failed')
      }
      const data = await res.json()
      setResults(data.results)
      setUniverse(data.universe)
      setCached(data.cached)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, market])

  return (
    <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{ borderBottom: '1px solid var(--border-subtle)', paddingBottom: '12px' }}>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '16px', fontWeight: 700 }}>
          新高値・新安値スクリーナー
        </h1>
        <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
          52週新高値・新安値を更新中の銘柄をスキャン
        </p>
      </div>

      {/* タイプ切替 */}
      <div style={{ display: 'flex', gap: '8px' }}>
        <button onClick={() => setType('high')} style={{ ...tabBtn, ...(type === 'high' ? tabBtnActive : {}) }}>
          📈 新高値
        </button>
        <button onClick={() => setType('low')} style={{ ...tabBtn, ...(type === 'low' ? tabBtnActive : {}) }}>
          📉 新安値
        </button>
      </div>

      {/* フィルタ */}
      <div className="card" style={{ padding: '16px' }}>
        <div className="section-header">フィルタ条件</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr) auto', gap: '12px', alignItems: 'end' }}>
          <div>
            <label style={labelStyle}>市場</label>
            <div style={{ display: 'flex', gap: '4px' }}>
              {(['JP', 'US', 'ALL'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setMarket(m)}
                  style={{
                    flex: 1,
                    padding: '5px',
                    fontSize: '11px',
                    fontFamily: 'var(--font-mono)',
                    background: market === m ? 'var(--accent-dim)' : 'var(--bg-surface)',
                    border: `1px solid ${market === m ? 'rgba(245,166,35,0.5)' : 'var(--border-base)'}`,
                    borderRadius: 'var(--radius-sm)',
                    color: market === m ? 'var(--accent-primary)' : 'var(--text-muted)',
                    cursor: 'pointer',
                  }}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label style={labelStyle}>許容範囲（% 以内）</label>
            <input
              type="number"
              value={tolerance}
              onChange={(e) => setTolerance(e.target.value)}
              step="0.1"
              min="0"
              style={inputStyle}
            />
          </div>
          <div>
            <label style={labelStyle}>最低出来高</label>
            <input
              type="number"
              value={minVolume}
              onChange={(e) => setMinVolume(e.target.value)}
              step="100000"
              min="0"
              style={inputStyle}
            />
          </div>
          <button onClick={run} disabled={loading} style={runBtn}>
            {loading ? '集計中...' : '⟳ 更新'}
          </button>
        </div>
      </div>

      {/* 結果 */}
      {error ? (
        <div className="card" style={{ padding: '12px', borderLeft: '3px solid var(--price-down)' }}>
          <p style={{ fontSize: '12px', color: 'var(--price-down)', margin: 0 }}>エラー: {error}</p>
        </div>
      ) : results.length > 0 ? (
        <div className="card" style={{ overflow: 'hidden' }}>
          <div style={{ padding: '8px 12px', display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--border-subtle)' }}>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
              {results.length}件 / 母集団 {universe}銘柄
              {cached && <span style={{ marginLeft: '6px', color: 'var(--accent-primary)' }}>（キャッシュ）</span>}
            </span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
              <thead>
                <tr style={{ background: 'var(--bg-elevated)', borderBottom: '1px solid var(--border-dim)' }}>
                  <th style={headStyle}>銘柄</th>
                  <th style={headStyleR}>株価</th>
                  <th style={headStyleR}>前日比%</th>
                  <th style={headStyleR}>52週{type === 'high' ? '高値' : '安値'}</th>
                  <th style={headStyleR}>かい離%</th>
                  <th style={headStyleR}>出来高</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r) => {
                  const distance = type === 'high' ? r.distanceFromHigh : r.distanceFromLow
                  const ref = type === 'high' ? r.fiftyTwoWeekHigh : r.fiftyTwoWeekLow
                  const isUp = r.changePercent >= 0
                  return (
                    <tr key={r.ticker} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                      <td style={{ padding: '7px 12px' }}>
                        <Link
                          href={`/stock/${encodeURIComponent(r.ticker)}`}
                          style={{ color: 'var(--accent-primary)', fontFamily: 'var(--font-mono)', textDecoration: 'none' }}
                        >
                          {r.ticker.replace('.T', '')}
                        </Link>
                        <MarketBadge market={r.market} />
                        <span style={{ marginLeft: '6px', fontSize: '11px', color: 'var(--text-secondary)' }}>{r.name}</span>
                      </td>
                      <td style={cellR}>{r.price.toLocaleString()}</td>
                      <td style={{ ...cellR, color: isUp ? 'var(--price-up)' : 'var(--price-down)' }}>
                        {isUp ? '+' : ''}{r.changePercent.toFixed(2)}%
                      </td>
                      <td style={cellR}>{ref?.toLocaleString() ?? '---'}</td>
                      <td style={{ ...cellR, color: type === 'high' ? 'var(--price-up)' : 'var(--price-down)' }}>
                        {distance !== undefined ? `${distance >= 0 ? '+' : ''}${distance.toFixed(2)}%` : '---'}
                      </td>
                      <td style={{ ...cellR, color: 'var(--text-muted)' }}>
                        {r.volume.toLocaleString()}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="card" style={{ padding: '32px', textAlign: 'center' }}>
          <p style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
            {loading
              ? '銘柄データを集計中...'
              : `条件に合致する銘柄がありません（母集団: ${universe}銘柄）`}
          </p>
        </div>
      )}
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
  padding: '5px 8px',
  background: 'var(--bg-void)',
  border: '1px solid var(--border-base)',
  borderRadius: 'var(--radius-sm)',
  color: 'var(--text-primary)',
  fontFamily: 'var(--font-mono)',
  fontSize: '12px',
  boxSizing: 'border-box',
}

const tabBtn: React.CSSProperties = {
  padding: '8px 18px',
  fontSize: '12px',
  fontFamily: 'var(--font-mono)',
  background: 'var(--bg-surface)',
  border: '1px solid var(--border-base)',
  borderRadius: 'var(--radius-sm)',
  color: 'var(--text-muted)',
  cursor: 'pointer',
}

const tabBtnActive: React.CSSProperties = {
  background: 'var(--accent-dim)',
  borderColor: 'rgba(245,166,35,0.5)',
  color: 'var(--accent-primary)',
}

const runBtn: React.CSSProperties = {
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

const headStyle: React.CSSProperties = {
  padding: '8px 12px',
  textAlign: 'left',
  fontFamily: 'var(--font-mono)',
  fontWeight: 500,
  color: 'var(--text-muted)',
  fontSize: '11px',
}

const headStyleR: React.CSSProperties = { ...headStyle, textAlign: 'right' }

const cellR: React.CSSProperties = {
  padding: '7px 12px',
  fontFamily: 'var(--font-mono)',
  fontSize: '12px',
  textAlign: 'right',
  color: 'var(--text-primary)',
}
