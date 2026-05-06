// app/hex-stage/page.tsx
// CSV取込データ (tv_daily_snapshots) を直読みする HEX ステージマップ。

'use client'

import { useEffect, useMemo, useState } from 'react'
import HexMap from '@/components/hex/HexMap'
import { STAGE_BG_COLORS, STAGE_BORDER_COLORS, STAGE_LABELS } from '@/lib/hex-stage'

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


// HEX マップ本体と凡例で同じ色・同じラベルを使う（lib/hex-stage の正規版）
const STAGE_DESCRIPTIONS: Record<number, string> = {
  1: '4本のSMAが上向きで並ぶ。最も強い上昇トレンド',
  2: 'トレンドはまだ生きているが踊り場で横ばい',
  3: '短期SMAが先に下向き始める。弱気入りの予兆',
  4: '4本とも下向き。最も弱い下落トレンド',
  5: '下落は続くが短期SMAに反発の兆し',
  6: '短期SMAが先に上向き始める。強気移行の予兆',
}

export default function HexStagePage() {
  const [data, setData] = useState<Stock[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [cached, setCached] = useState(false)
  const [date, setDate] = useState<string | null>(null)

  // 3 タイムフレームのマトリクスを縦に積んで全部表示するため、
  // ここは API を叩く際に必須の固定値だけ持つ。
  const timeframe: Timeframe = 'daily'
  const [selectedCategory, setSelectedCategory] = useState<string>('')
  const [selectedSubCategory, setSelectedSubCategory] = useState<string>('')
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

  // 大分類 → 件数, さらに 大分類 → { 小分類: 件数 } の辞書
  const categoryStats = useMemo(() => {
    const large: Record<string, number> = {}
    const small: Record<string, Record<string, number>> = {}
    for (const d of data) {
      const l = d.sector_large || '（未分類）'
      large[l] = (large[l] ?? 0) + 1
      if (d.sector_small) {
        small[l] = small[l] ?? {}
        small[l][d.sector_small] = (small[l][d.sector_small] ?? 0) + 1
      }
    }
    return { large, small }
  }, [data])

  const largeOptions = useMemo(
    () => Object.entries(categoryStats.large).sort((a, b) => b[1] - a[1]),
    [categoryStats],
  )

  const smallOptions = useMemo(() => {
    if (!selectedCategory) return []
    const m = categoryStats.small[selectedCategory]
    if (!m) return []
    return Object.entries(m).sort((a, b) => b[1] - a[1])
  }, [categoryStats, selectedCategory])

  const filteredData = useMemo(() => {
    return data.filter((d) => {
      if (selectedCategory && d.sector_large !== selectedCategory) return false
      if (selectedSubCategory && d.sector_small !== selectedSubCategory) return false
      return true
    })
  }, [data, selectedCategory, selectedSubCategory])

  const hasFilter = selectedCategory || selectedSubCategory

  return (
    <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {/* ── 1. タイトル + サマリ ─────────────────────────── */}
      <header style={{ borderBottom: '1px solid var(--border-subtle)', paddingBottom: '10px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '16px', fontWeight: 700, margin: 0 }}>
            🔷 トレンドステージマップ (HEX)
          </h1>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px', fontSize: '11px', color: 'var(--text-muted)', flexWrap: 'wrap' }}>
            <span style={{ color: 'var(--accent-primary)', fontWeight: 700, fontSize: '14px', fontFamily: 'var(--font-mono)' }}>
              {filteredData.length}
            </span>
            <span>銘柄</span>
            {hasFilter && <span style={{ color: 'var(--text-secondary)' }}>(全{data.length}中)</span>}
            <span style={{ color: 'var(--border-base)' }}>·</span>
            <span style={{ fontFamily: 'var(--font-mono)' }}>{date ?? '---'}</span>
            {cached && <span style={{ color: 'var(--text-muted)' }}>(DB)</span>}
          </div>
        </div>
      </header>

      {/* ── 2. フィルタバー（1行に統合、レスポンシブで折返し） ─── */}
      <div style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '8px',
        alignItems: 'center',
        padding: '10px 12px',
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-md)',
      }}>
        {/* 日付 */}
        {availableDates.length > 0 && (
          <FilterField label="📅 日付">
            <select
              value={selectedDate ?? ''}
              onChange={(e) => setSelectedDate(e.target.value || null)}
              style={selectInputStyle}
            >
              <option value="">最新（{availableDates[0]?.date ?? '---'}）</option>
              {availableDates.map((d) => (
                <option key={d.date} value={d.date}>{d.date}（{d.tickers}）</option>
              ))}
            </select>
          </FilterField>
        )}

        {/* 業種大分類 */}
        <FilterField label="業種大分類">
          <select
            value={selectedCategory}
            onChange={(e) => {
              setSelectedCategory(e.target.value)
              setSelectedSubCategory('')
            }}
            style={selectInputStyle}
          >
            <option value="">全て（{data.length}）</option>
            {largeOptions.map(([cat, n]) => (
              <option key={cat} value={cat}>{cat}（{n}）</option>
            ))}
          </select>
        </FilterField>

        {/* 業種細分類 */}
        <FilterField label="業種細分類">
          <select
            value={selectedSubCategory}
            onChange={(e) => setSelectedSubCategory(e.target.value)}
            disabled={!selectedCategory || smallOptions.length === 0}
            style={{ ...selectInputStyle, opacity: !selectedCategory ? 0.5 : 1 }}
          >
            <option value="">全て{selectedCategory ? `（${categoryStats.large[selectedCategory] ?? 0}）` : ''}</option>
            {smallOptions.map(([cat, n]) => (
              <option key={cat} value={cat}>{cat}（{n}）</option>
            ))}
          </select>
        </FilterField>

        {hasFilter && (
          <button
            onClick={() => { setSelectedCategory(''); setSelectedSubCategory('') }}
            style={clearBtnStyle}
            title="業種フィルタをクリア"
          >
            × クリア
          </button>
        )}
      </div>

      {/* ── 3. ステージ凡例（常時インライン+折りたたみで詳細） ─── */}
      <div style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-md)',
        overflow: 'hidden',
      }}>
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
            gap: '12px',
            color: 'var(--text-secondary)',
            fontSize: '11px',
            flexWrap: 'wrap',
            textAlign: 'left',
          }}
        >
          <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>ステージ凡例</span>
          <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
            {[1, 2, 3, 4, 5, 6].map((s) => (
              <span key={s} style={legendChipStyle(s)} title={STAGE_LABELS[s]}>
                <span style={{ fontWeight: 700 }}>{s}</span>
                <span>{STAGE_LABELS[s]}</span>
              </span>
            ))}
          </div>
          <span style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontSize: '10px' }}>
            {legendOpen ? '▲ 閉じる' : '▼ 詳細を見る'}
          </span>
        </button>
        {legendOpen && (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
            gap: '8px',
            padding: '0 12px 12px',
            fontSize: '11px',
            borderTop: '1px solid var(--border-subtle)',
            paddingTop: '10px',
          }}>
            {[1, 2, 3, 4, 5, 6].map((s) => (
              <div key={s} style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
                <span style={{
                  flexShrink: 0,
                  width: '24px',
                  height: '24px',
                  borderRadius: '6px',
                  background: STAGE_BG_COLORS[s],
                  color: STAGE_BORDER_COLORS[s],
                  border: `1.5px solid ${STAGE_BORDER_COLORS[s]}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontWeight: 700,
                  fontFamily: 'var(--font-mono)',
                  fontSize: '12px',
                }}>{s}</span>
                <div style={{ lineHeight: 1.4 }}>
                  <strong style={{ color: 'var(--text-primary)' }}>{STAGE_LABELS[s]}</strong>
                  <div style={{ color: 'var(--text-muted)', marginTop: '2px' }}>{STAGE_DESCRIPTIONS[s]}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── 4. 状態表示 ────────────────────────────────── */}
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

      {/* ── 5. HEX マップ本体 ─────────────────────────── */}
      {!loading && !error && filteredData.length > 0 && (
        <div style={{
          background: '#fff',
          borderRadius: 'var(--radius-md)',
          padding: '16px',
          boxShadow: '0 1px 3px rgba(0,0,0,0.1), 0 1px 2px rgba(0,0,0,0.06)',
          border: '1px solid var(--border-subtle)',
          overflowX: 'auto',
          minWidth: 0,
        }}>
          <HexMap data={filteredData} timeframe={timeframe} />
        </div>
      )}
    </div>
  )
}

// ── サブコンポーネント / スタイル ───────────────────────

function FilterField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: '6px',
      fontSize: '11px',
      color: 'var(--text-muted)',
      whiteSpace: 'nowrap',
    }}>
      <span>{label}</span>
      {children}
    </label>
  )
}

const selectInputStyle: React.CSSProperties = {
  padding: '5px 8px',
  fontSize: '12px',
  fontFamily: 'var(--font-mono)',
  background: 'var(--bg-surface)',
  color: 'var(--text-primary)',
  border: '1px solid var(--border-base)',
  borderRadius: 'var(--radius-sm)',
  cursor: 'pointer',
  minWidth: '140px',
  maxWidth: '240px',
}


const clearBtnStyle: React.CSSProperties = {
  padding: '5px 10px',
  fontSize: '11px',
  background: 'transparent',
  border: '1px solid var(--border-base)',
  borderRadius: 'var(--radius-sm)',
  cursor: 'pointer',
  color: 'var(--text-muted)',
  fontFamily: 'var(--font-mono)',
}

function legendChipStyle(stage: number): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '5px',
    padding: '2px 8px',
    fontSize: '10px',
    fontFamily: 'var(--font-mono)',
    background: STAGE_BG_COLORS[stage],
    color: STAGE_BORDER_COLORS[stage],
    border: `1px solid ${STAGE_BORDER_COLORS[stage]}`,
    borderRadius: '10px',
    whiteSpace: 'nowrap',
  }
}
