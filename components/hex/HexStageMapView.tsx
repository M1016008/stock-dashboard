// components/hex/HexStageMapView.tsx
//
// 旧 HEX マップ (B×A グリッド × 日足/週足/月足 + 業種フィルタ + 銘柄テーブル) の
// クライアント側コンポーネント。/api/hex から J-Quants 由来データを取得する。
// 親ページ (/hex-stage) は Server Component で Phase 4 セクションをまず描画し、
// その下にこのコンポーネントを埋め込む。

'use client'

import { useEffect, useMemo, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import HexMap from '@/components/hex/HexMap'
import { MarketDateCalendar } from '@/components/ui/MarketDateCalendar'
import { STAGE_BG_COLORS, STAGE_BORDER_COLORS, STAGE_LABELS } from '@/lib/hex-stage'
import { getUniverseFilterMeta, parseUniverseFilter, UNIVERSE_FILTER_PARAM } from '@/lib/market-universe'

interface Stock {
  code: string
  name: string
  sector_large: string
  sector_small?: string | null
  sector17_name?: string | null
  sector33_name?: string | null
  market_segment?: string | null
  margin_type?: string | null
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
  ml_candidate_direction?: 'up' | 'down' | null
  ml_candidate_rank?: number | null
  ml_candidate_summary?: string | null
  physical_momentum_score?: number | null
}

type Timeframe = 'daily' | 'weekly' | 'monthly'

interface AvailableDate {
  date: string
  tickers: number
}

const STAGE_DESCRIPTIONS: Record<number, string> = {
  1: '上昇トレンドが安定して継続している局面（トレンド本体）',
  2: '上昇相場の終盤を示唆。トレンドの勢いが鈍化し始める転換点',
  3: '下降相場への入り口。トレンド転換の初動となる転換点',
  4: '下降トレンドが安定して継続している局面（トレンド本体）',
  5: '下降相場の終盤。下げ止まりの兆しが見え始める転換点',
  6: '再び上昇相場へ移行する初動局面となる転換点',
}

export default function HexStageMapView() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const activeUniverse = parseUniverseFilter(searchParams.get(UNIVERSE_FILTER_PARAM))
  const activeUniverseMeta = getUniverseFilterMeta(activeUniverse)
  const selectedDate = searchParams.get('date')
  const [data, setData] = useState<Stock[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [date, setDate] = useState<string | null>(null)

  // 3 タイムフレームのマトリクスを縦に積んで全部表示するため固定
  const timeframe: Timeframe = 'daily'
  const [selectedCategory, setSelectedCategory] = useState<string>('')
  const [selectedSubCategory, setSelectedSubCategory] = useState<string>('')
  const [availableDates, setAvailableDates] = useState<AvailableDate[]>([])
  const [legendOpen, setLegendOpen] = useState(false)

  const updateDate = (nextDate: string | null) => {
    const params = new URLSearchParams(searchParams.toString())
    if (nextDate) params.set('date', nextDate)
    else params.delete('date')
    const query = params.toString()
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
  }

  useEffect(() => {
    let cancelled = false
    fetch('/api/hex/available-dates?limit=5000', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return
        setAvailableDates(d.dates ?? [])
      })
      .catch(() => { /* 無視 */ })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    const params = new URLSearchParams({ timeframe })
    if (activeUniverse) params.set(UNIVERSE_FILTER_PARAM, activeUniverse)
    if (selectedDate) params.set('date', selectedDate)

    fetch(`/api/hex?${params}`, { cache: 'no-store' })
      .then(async (res) => {
        const json = await res.json()
        if (!res.ok) throw new Error(json.error ?? json.message ?? 'failed')
        if (cancelled) return
        setData(json.data ?? [])
        setDate(json.date ?? null)
      })
      .catch((e) => { if (!cancelled) setError((e as Error).message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [timeframe, selectedDate, activeUniverse])

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
  const stageMomentumStats = useMemo(() => {
    return [1, 2, 3, 4, 5, 6].map((stage) => {
      const rows = filteredData.filter((row) => row.stage === stage && row.physical_momentum_score != null && Number.isFinite(row.physical_momentum_score))
      const avg = rows.length > 0
        ? rows.reduce((sum, row) => sum + (row.physical_momentum_score ?? 0), 0) / rows.length
        : null
      return { stage, avg, count: rows.length }
    })
  }, [filteredData])

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3 pt-2">
        <h2>トレンドステージマップ</h2>
        <span className="text-[11px] text-[var(--color-text-tertiary)] tabular-nums">
          {filteredData.length.toLocaleString()} 銘柄{hasFilter ? ` / 全 ${data.length.toLocaleString()}` : ''}{activeUniverseMeta ? ` · ${activeUniverseMeta.shortLabel}` : ''}{date ? ` · ${date}` : ''}
        </span>
      </div>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(118px,1fr))] gap-2">
        {stageMomentumStats.map(({ stage, avg, count }) => (
          <div
            key={stage}
            className="rounded-[8px] border bg-white px-3 py-2"
            style={{
              borderColor: STAGE_BORDER_COLORS[stage],
              background: STAGE_BG_COLORS[stage],
            }}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-semibold text-[var(--color-text-tertiary)]">Stage {stage}</span>
              <span className="text-[10px] tabular-nums text-[var(--color-text-tertiary)]">{count}</span>
            </div>
            <div className="mt-1 text-[14px] font-bold tabular-nums" style={{ color: avg == null ? 'var(--color-text-tertiary)' : avg >= 0 ? 'var(--color-market-red)' : 'var(--color-market-blue)' }}>
              平均PMS {avg == null ? '-' : avg.toFixed(2)}
            </div>
          </div>
        ))}
      </div>

      {/* ── フィルタバー ─────────────── */}
      <div className="flex flex-wrap items-center gap-2 rounded-[8px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-3 py-2">
        {availableDates.length > 0 && (
          <MarketDateCalendar
            dates={availableDates}
            value={selectedDate}
            onChange={updateDate}
            label="マップ日付"
            compact
          />
        )}

        <FilterField label="17業種">
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

        <FilterField label="33業種">
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

      {/* ── ステージ凡例 ────────────── */}
      <div className="overflow-hidden rounded-[8px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)]">
        <button
          onClick={() => setLegendOpen((o) => !o)}
          className="flex w-full items-center gap-3 px-3 py-2 text-left text-[11px]"
        >
          <span className="font-medium text-[var(--color-text-primary)]">ステージ凡例</span>
          <div className="flex flex-wrap gap-1">
            {[1, 2, 3, 4, 5, 6].map((s) => (
              <span key={s} style={legendChipStyle(s)} title={STAGE_LABELS[s]}>
                <span style={{ fontWeight: 600 }}>{s}</span>
                <span>{STAGE_LABELS[s]}</span>
              </span>
            ))}
          </div>
          <span className="ml-auto text-[10px] text-[var(--color-text-tertiary)]">
            {legendOpen ? '▲ 閉じる' : '▼ 詳細を見る'}
          </span>
        </button>
        {legendOpen && (
          <div className="border-t border-[var(--color-border-soft)] p-3 text-[11px]">
            <p className="mb-2 leading-relaxed text-[var(--color-text-secondary)]">
              市場は 6 段階のサイクルで循環します:{' '}
              <span className="tabular-nums text-[var(--color-text-primary)]">
                安定上昇(1) → 上昇終盤(2) → 下落入り(3) → 安定下降(4) → 下落終盤(5) → 上昇入り(6) → 1へ
              </span>
              。<strong>1 / 4</strong> がトレンド本体、<strong>2・3・5・6</strong> が転換点です。
            </p>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-2">
              {[1, 2, 3, 4, 5, 6].map((s) => (
                <div key={s} className="flex items-start gap-2">
                  <span
                    style={{
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
                      fontWeight: 600,
                      fontSize: '12px',
                    }}
                  >{s}</span>
                  <div className="leading-tight">
                    <strong className="text-[var(--color-text-primary)]">{STAGE_LABELS[s]}</strong>
                    <div className="mt-1 text-[var(--color-text-tertiary)]">{STAGE_DESCRIPTIONS[s]}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── 状態表示 ────────────── */}
      {error && (
        <div className="rounded-[8px] border-l-2 border-[var(--color-price-down)] bg-[var(--color-surface-subtle)] p-3 text-[12px] text-[var(--color-price-down)]">
          エラー: {error}
        </div>
      )}

      {loading && (
        <div className="rounded-[8px] border border-[var(--color-border-soft)] p-12 text-center text-[12px] text-[var(--color-text-tertiary)]">
          読み込み中…
        </div>
      )}

      {!loading && !error && filteredData.length === 0 && (
        <div className="rounded-[8px] border border-[var(--color-border-soft)] p-12 text-center text-[12px] text-[var(--color-text-tertiary)]">
          該当する銘柄がありません
        </div>
      )}

      {/* ── HEX マップ本体 ────────────── */}
      {!loading && !error && filteredData.length > 0 && (
        <div className="overflow-x-auto rounded-[8px] border border-[var(--color-border-soft)] bg-[var(--color-surface-base)] p-4">
          <HexMap data={filteredData} timeframe={timeframe} />
        </div>
      )}
    </div>
  )
}

function FilterField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="inline-flex items-center gap-1.5 whitespace-nowrap text-[11px] text-[var(--color-text-tertiary)]">
      <span>{label}</span>
      {children}
    </label>
  )
}

const selectInputStyle: React.CSSProperties = {
  padding: '4px 8px',
  fontSize: '12px',
  fontVariantNumeric: 'tabular-nums',
  background: 'var(--color-surface-base)',
  color: 'var(--color-text-primary)',
  border: '1px solid var(--color-border-default)',
  borderRadius: '4px',
  cursor: 'pointer',
  minWidth: '160px',
  maxWidth: '260px',
}

const clearBtnStyle: React.CSSProperties = {
  padding: '4px 10px',
  fontSize: '11px',
  background: 'transparent',
  border: '1px solid var(--color-border-default)',
  borderRadius: '4px',
  cursor: 'pointer',
  color: 'var(--color-text-tertiary)',
}

function legendChipStyle(stage: number): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '5px',
    padding: '2px 8px',
    fontSize: '10px',
    fontVariantNumeric: 'tabular-nums',
    background: STAGE_BG_COLORS[stage],
    color: STAGE_BORDER_COLORS[stage],
    border: `1px solid ${STAGE_BORDER_COLORS[stage]}`,
    borderRadius: '10px',
    whiteSpace: 'nowrap',
  }
}
