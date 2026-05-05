// app/hex-stage/page.tsx
// CSV取込データ (tv_daily_snapshots) を直読みする HEX ステージマップ。

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

interface AvailableDate {
  date: string
  tickers: number
}

const TIMEFRAMES: { v: Timeframe; label: string }[] = [
  { v: 'daily', label: '日足' },
  { v: 'weekly', label: '週足' },
  { v: 'monthly', label: '月足' },
]

const STAGE_LEGEND: { stage: number; label: string; desc: string }[] = [
  { stage: 1, label: '上昇初動',  desc: '底打ち反転、これから上昇に入る' },
  { stage: 2, label: '上昇加速',  desc: '本格上昇トレンド、最も強い局面' },
  { stage: 3, label: '上昇減速',  desc: '上昇継続だが勢いは鈍化' },
  { stage: 4, label: '下落初動',  desc: '天井から反転、これから下落に入る' },
  { stage: 5, label: '下落加速',  desc: '本格下落トレンド、最も弱い局面' },
  { stage: 6, label: '下落減速',  desc: '下落継続だが勢いは鈍化' },
]

export default function HexStagePage() {
  const [data, setData] = useState<Stock[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [cached, setCached] = useState(false)
  const [date, setDate] = useState<string | null>(null)

  const [timeframe, setTimeframe] = useState<Timeframe>('daily')
  const [selectedCategory, setSelectedCategory] = useState<string>('')
  const [availableDates, setAvailableDates] = useState<AvailableDate[]>([])
  const [selectedDate, setSelectedDate] = useState<string | null>(null) // null = 最新
  const [legendOpen, setLegendOpen] = useState(false)

  // 取込済み日付一覧
  useEffect(() => {
    let cancelled = false
    fetch('/api/import/csv')
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return
        setAvailableDates(d.dates ?? [])
      })
      .catch(() => { /* 無視 */ })
    return () => { cancelled = true }
  }, [])

  // データ取得
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    const params = new URLSearchParams({ timeframe, market: 'JP' })
    if (selectedDate) params.set('date', selectedDate)

    fetch(`/api/hex?${params}`)
      .then(async (res) => {
        const json = await res.json()
        if (!res.ok) throw new Error(json.error ?? json.message ?? 'failed')
        if (cancelled) return
        setData(json.data ?? [])
        setCached(json.cached ?? false)
        setDate(json.date ?? null)
      })
      .catch((e) => { if (!cancelled) setError((e as Error).message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [timeframe, selectedDate])

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
        borderBottom: '1px solid var(--border-subtle)',
        paddingBottom: '12px',
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'space-between',
        gap: '16px',
        flexWrap: 'wrap',
      }}>
        <div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '16px', fontWeight: 700 }}>
            🔷 トレンドステージマップ (HEX)
          </h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginTop: '4px', fontSize: '11px', color: 'var(--text-muted)' }}>
            <span>
              <span style={{ color: 'var(--accent-primary)', fontWeight: 600 }}>{filteredData.length}</span>
              <span> 銘柄</span>
              {selectedCategory && <span> / {selectedCategory}</span>}
            </span>
            {availableDates.length > 0 && (
              <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontFamily: 'var(--font-mono)' }}>
                <span style={{ color: 'var(--accent-primary)' }}>📅</span>
                <select
                  value={selectedDate ?? ''}
                  onChange={(e) => setSelectedDate(e.target.value || null)}
                  style={dateSelectStyle}
                >
                  <option value="">最新（{availableDates[0]?.date ?? '---'}）</option>
                  {availableDates.map((d) => (
                    <option key={d.date} value={d.date}>{d.date}（{d.tickers}銘柄）</option>
                  ))}
                </select>
              </label>
            )}
            {date && !selectedDate && (
              <span style={{ fontFamily: 'var(--font-mono)' }}>表示中: {date}</span>
            )}
            {cached && <span style={{ color: 'var(--accent-primary)' }}>（DB）</span>}
          </div>
        </div>

        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          {/* 時間軸 */}
          <div style={segmentBoxStyle}>
            {TIMEFRAMES.map((tf) => (
              <button
                key={tf.v}
                onClick={() => setTimeframe(tf.v)}
                style={segmentBtnStyle(timeframe === tf.v)}
              >
                {tf.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* セクター・チップフィルタ */}
      {categories.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '10px', color: 'var(--text-muted)', marginRight: '4px' }}>セクター:</span>
          <button
            onClick={() => setSelectedCategory('')}
            style={chipStyle(selectedCategory === '')}
          >
            全て（{data.length}）
          </button>
          {categories.map((cat) => {
            const count = data.filter((d) => d.sector_large === cat).length
            const active = selectedCategory === cat
            return (
              <button
                key={cat}
                onClick={() => setSelectedCategory(active ? '' : cat)}
                style={chipStyle(active)}
              >
                {cat}（{count}）
              </button>
            )
          })}
        </div>
      )}

      {/* ステージ凡例（折りたたみ可） */}
      <div className="card" style={{ overflow: 'hidden' }}>
        <button
          onClick={() => setLegendOpen((o) => !o)}
          style={{
            width: '100%',
            padding: '8px 12px',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            color: 'var(--text-secondary)',
            fontSize: '11px',
          }}
        >
          <span>📖 ステージ凡例（1〜6）</span>
          <span style={{ color: 'var(--text-muted)' }}>{legendOpen ? '▲' : '▼'}</span>
        </button>
        {legendOpen && (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: '6px',
            padding: '0 12px 12px',
            fontSize: '11px',
          }}>
            {STAGE_LEGEND.map((s) => (
              <div key={s.stage} style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
                <span style={{
                  flexShrink: 0,
                  width: '22px',
                  height: '22px',
                  borderRadius: '50%',
                  background: stageColor(s.stage),
                  color: '#fff',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontWeight: 700,
                  fontFamily: 'var(--font-mono)',
                }}>{s.stage}</span>
                <span>
                  <strong style={{ color: 'var(--text-primary)' }}>{s.label}</strong>
                  <span style={{ color: 'var(--text-muted)', marginLeft: '6px' }}>{s.desc}</span>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 状態表示 */}
      {error && (
        <div className="card" style={{ padding: '12px', borderLeft: '3px solid var(--price-down)' }}>
          <p style={{ fontSize: '12px', color: 'var(--price-down)', margin: 0 }}>エラー: {error}</p>
        </div>
      )}

      {loading && (
        <div className="card" style={{ padding: '48px', textAlign: 'center' }}>
          <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>読み込み中…</p>
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

function stageColor(stage: number): string {
  switch (stage) {
    case 1: return '#10b981' // 緑（初動）
    case 2: return '#16a34a' // 濃緑（加速）
    case 3: return '#facc15' // 黄（減速）
    case 4: return '#f97316' // 橙（下落初動）
    case 5: return '#ef4444' // 赤（下落加速）
    case 6: return '#a855f7' // 紫（下落減速）
    default: return '#6b7280'
  }
}

const dateSelectStyle: React.CSSProperties = {
  padding: '3px 6px',
  fontSize: '11px',
  fontFamily: 'var(--font-mono)',
  background: 'var(--bg-elevated)',
  color: 'var(--accent-primary)',
  border: '1px solid var(--border-base)',
  borderRadius: 'var(--radius-sm)',
  cursor: 'pointer',
}

const segmentBoxStyle: React.CSSProperties = {
  display: 'flex',
  border: '1px solid var(--border-base)',
  borderRadius: 'var(--radius-sm)',
  overflow: 'hidden',
}

const segmentBtnStyle = (active: boolean): React.CSSProperties => ({
  padding: '6px 14px',
  fontSize: '12px',
  fontFamily: 'var(--font-mono)',
  background: active ? 'var(--accent-primary)' : 'var(--bg-surface)',
  color: active ? '#fff' : 'var(--text-secondary)',
  border: 'none',
  cursor: 'pointer',
})

const chipStyle = (active: boolean): React.CSSProperties => ({
  padding: '4px 10px',
  fontSize: '11px',
  fontFamily: 'var(--font-mono)',
  background: active ? 'var(--accent-primary)' : 'var(--bg-elevated)',
  color: active ? '#fff' : 'var(--text-secondary)',
  border: `1px solid ${active ? 'var(--accent-primary)' : 'var(--border-base)'}`,
  borderRadius: '14px',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
})
