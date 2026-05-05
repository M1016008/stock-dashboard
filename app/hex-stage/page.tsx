// app/hex-stage/page.tsx
// 完全移植: 株式アプリ/HEX-app/frontend/app/hex/page.tsx
// stock-dashboard 用に SmartCalendar / AdvancedFilterDialog を簡略化

'use client'

import { useEffect, useMemo, useState } from 'react'
import HexMap from '@/components/hex/HexMap'

interface Stock {
  code: string
  name: string
  sector_large: string
  sector_small?: string | null
  market_cap: number
  price: number
  daily_change?: number
  weekly_change?: number
  monthly_change?: number
  months3_change?: number
  months6_change?: number
  ytd_change?: number
  stage: number
  daily_a_stage?: number | null
  daily_b_stage?: number | null
  weekly_a_stage?: number | null
  weekly_b_stage?: number | null
  monthly_a_stage?: number | null
  monthly_b_stage?: number | null
  sma_angles?: { sma5: number | null; sma25: number | null; sma75: number | null; sma300: number | null }
  prev_sma_angles?: { sma5: number | null; sma25: number | null; sma75: number | null; sma300: number | null }
  prev_prev_sma_angles?: { sma5: number | null; sma25: number | null; sma75: number | null; sma300: number | null }
}

type Timeframe = 'daily' | 'weekly' | 'monthly'
type Market = 'JP' | 'US' | 'ALL'

const timeframeLabels: Record<Timeframe, string> = { daily: '日足', weekly: '週足', monthly: '月足' }

export default function HexStagePage() {
  const [data, setData] = useState<Stock[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [cached, setCached] = useState(false)
  const [date, setDate] = useState<string | null>(null)

  const [timeframe, setTimeframe] = useState<Timeframe>('daily')
  const [market, setMarket] = useState<Market>('JP')
  const [selectedCategory, setSelectedCategory] = useState<string>('')

  const fetchData = async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ timeframe, market })
      const res = await fetch(`/api/hex?${params}`)
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? json.message ?? 'failed')
      setData(json.data ?? [])
      setCached(json.cached)
      setDate(json.date)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeframe, market])

  const categories = useMemo(() => {
    return Array.from(new Set(data.map((d) => d.sector_large).filter(Boolean))).sort()
  }, [data])

  const filteredData = useMemo(() => {
    if (!selectedCategory) return data
    return data.filter((d) => d.sector_large === selectedCategory)
  }, [data, selectedCategory])

  return (
    <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {/* ヘッダー */}
      <div style={{
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'space-between',
        borderBottom: '1px solid var(--border-subtle)',
        paddingBottom: '12px',
        flexWrap: 'wrap',
        gap: '12px',
      }}>
        <div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '16px', fontWeight: 700 }}>
            🔷 トレンドステージマップ (HEX)
          </h1>
          <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
            現在 <span style={{ color: 'var(--accent-primary)', fontWeight: 600 }}>{filteredData.length}</span> 銘柄を表示中 / 視点: <span style={{ color: 'var(--text-primary)' }}>{timeframeLabels[timeframe]}</span>
            {date && <span style={{ marginLeft: 8 }}>/ {date}</span>}
            {cached && <span style={{ marginLeft: 8, color: 'var(--accent-primary)' }}>（キャッシュ）</span>}
          </p>
        </div>

        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div>
            <label style={labelStyle}>市場</label>
            <div style={segmentBoxStyle}>
              {(['JP', 'US', 'ALL'] as Market[]).map((m) => (
                <button
                  key={m}
                  onClick={() => setMarket(m)}
                  style={segmentBtnStyle(market === m)}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label style={labelStyle}>大分類</label>
            <select
              value={selectedCategory}
              onChange={(e) => setSelectedCategory(e.target.value)}
              style={selectStyle}
            >
              <option value="">全て</option>
              {categories.map((cat) => (
                <option key={cat} value={cat}>{cat}</option>
              ))}
            </select>
          </div>

          <div>
            <label style={labelStyle}>時間軸</label>
            <div style={segmentBoxStyle}>
              {(['daily', 'weekly', 'monthly'] as Timeframe[]).map((tf) => (
                <button
                  key={tf}
                  onClick={() => setTimeframe(tf)}
                  style={segmentBtnStyle(timeframe === tf)}
                >
                  {timeframeLabels[tf]}
                </button>
              ))}
            </div>
          </div>

          <button onClick={fetchData} disabled={loading} style={refreshBtnStyle}>
            {loading ? '取得中...' : '⟳ 更新'}
          </button>
        </div>
      </div>

      {/* 状態表示 */}
      {error && (
        <div className="card" style={{ padding: '12px', borderLeft: '3px solid var(--price-down)' }}>
          <p style={{ fontSize: '12px', color: 'var(--price-down)', margin: 0 }}>エラー: {error}</p>
        </div>
      )}

      {loading && (
        <div className="card" style={{ padding: '48px', textAlign: 'center' }}>
          <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            銘柄データ取得中...（初回は数十秒かかる場合があります）
          </p>
        </div>
      )}

      {!loading && !error && filteredData.length === 0 && (
        <div className="card" style={{ padding: '48px', textAlign: 'center' }}>
          <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>該当する銘柄がありません</p>
        </div>
      )}

      {!loading && !error && filteredData.length > 0 && (
        <div className="card" style={{ padding: '12px', background: '#fff' }}>
          <HexMap data={filteredData} timeframe={timeframe} />
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

const selectStyle: React.CSSProperties = {
  minWidth: '140px',
  padding: '6px 8px',
  background: 'var(--bg-surface)',
  border: '1px solid var(--border-base)',
  borderRadius: 'var(--radius-sm)',
  color: 'var(--text-primary)',
  fontSize: '12px',
  fontFamily: 'var(--font-mono)',
}

const segmentBoxStyle: React.CSSProperties = {
  display: 'flex',
  border: '1px solid var(--border-base)',
  borderRadius: 'var(--radius-sm)',
  overflow: 'hidden',
}

const segmentBtnStyle = (active: boolean): React.CSSProperties => ({
  padding: '6px 12px',
  fontSize: '12px',
  fontFamily: 'var(--font-mono)',
  background: active ? 'var(--accent-primary)' : 'var(--bg-surface)',
  color: active ? '#000' : 'var(--text-secondary)',
  border: 'none',
  cursor: 'pointer',
})

const refreshBtnStyle: React.CSSProperties = {
  padding: '6px 14px',
  background: 'var(--bg-surface)',
  border: '1px solid var(--border-base)',
  borderRadius: 'var(--radius-sm)',
  fontSize: '12px',
  fontFamily: 'var(--font-mono)',
  cursor: 'pointer',
  color: 'var(--text-secondary)',
}
