// app/screener/page.tsx
'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { toTvSymbol, buildTvWatchlistText } from '@/lib/tv-format'
import { WatchlistButton } from '@/components/ui/WatchlistButton'

type Market = 'JP' | 'US'
type AxisKey = 'daily_a' | 'daily_b' | 'weekly_a' | 'weekly_b' | 'monthly_a' | 'monthly_b'

const AXES: { key: AxisKey; label: string; color: string }[] = [
  { key: 'daily_a',   label: '日足 A', color: '#ef4444' },
  { key: 'weekly_a',  label: '週足 A', color: '#22c55e' },
  { key: 'monthly_a', label: '月足 A', color: '#a855f7' },
  { key: 'daily_b',   label: '日足 B', color: '#f59e0b' },
  { key: 'weekly_b',  label: '週足 B', color: '#3b82f6' },
  { key: 'monthly_b', label: '月足 B', color: '#ec4899' },
]

interface StockRow {
  ticker: string
  name: string
  market: Market
  marketSegment: string
  marginType?: string
  sectorLarge: string
  price: number
  currency?: string | null
  changePercent: number
  changePercentWeek?: number
  changePercentMonth?: number
  perfPct3m?: number | null
  perfPct6m?: number | null
  perfPctYtd?: number | null
  volume: number
  avgVolume10d?: number | null
  avgVolume30d?: number | null
  marketCap?: number
  marketCapCurrency?: string | null
  per?: number
  dividendYield?: number
  sma25Angle?: number | null
  sma75Angle?: number | null
  earningsLastDate?: string | null
  earningsNextDate?: string | null
  daily_a_stage: number | null
  daily_b_stage: number | null
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
}

type SortKey =
  | 'ticker'
  | 'name'
  | 'price'
  | 'currency'
  | 'changePercent'
  | 'changePercentWeek'
  | 'changePercentMonth'
  | 'perfPct3m'
  | 'perfPct6m'
  | 'perfPctYtd'
  | 'volume'
  | 'avgVolume10d'
  | 'avgVolume30d'
  | 'marketCap'
  | 'marketCapCurrency'
  | 'per'
  | 'dividendYield'
  | 'sma25Angle'
  | 'sma75Angle'
  | 'earningsLastDate'
  | 'earningsNextDate'

interface SortState {
  key: SortKey
  dir: 'asc' | 'desc'
}

export default function ScreenerPage() {
  const [stages, setStages] = useState<Partial<Record<AxisKey, number[]>>>({})
  const [results, setResults] = useState<StockRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [universe, setUniverse] = useState(0)
  const [cached, setCached] = useState(false)
  const [snapshotDate, setSnapshotDate] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [sort, setSort] = useState<SortState | null>(null)
  const [copiedTicker, setCopiedTicker] = useState<string | null>(null)

  const hasAnyStage = Object.values(stages).some((v) => v && v.length > 0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    const params = new URLSearchParams({ market: 'JP' })
    for (const [k, v] of Object.entries(stages)) {
      if (v && v.length > 0) params.set(k, v.join(','))
    }

    fetch(`/api/screener?${params}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return
        if (d.error) throw new Error(d.error)
        setResults(d.results ?? [])
        setUniverse(d.universe ?? 0)
        setCached(d.cached)
        setSnapshotDate(d.date ?? null)
        setNotice(d.notice ?? null)
      })
      .catch((e) => { if (!cancelled) setError((e as Error).message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [stages])

  const filterText = useMemo(() => {
    const parts: string[] = []
    for (const ax of AXES) {
      const sel = stages[ax.key]
      if (sel && sel.length > 0) {
        parts.push(`${ax.label} ∈ {${[...sel].sort().join(',')}}`)
      }
    }
    return parts.join(' AND ')
  }, [stages])

  const sortedResults = useMemo(() => {
    if (!sort) return results
    const copy = [...results]
    const dir = sort.dir === 'asc' ? 1 : -1
    copy.sort((a, b) => {
      const av = (a as unknown as Record<string, unknown>)[sort.key]
      const bv = (b as unknown as Record<string, unknown>)[sort.key]
      // null / undefined は常に末尾
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      if (typeof av === 'number' && typeof bv === 'number') {
        return (av - bv) * dir
      }
      return String(av).localeCompare(String(bv), 'ja') * dir
    })
    return copy
  }, [results, sort])

  function toggleSort(key: SortKey) {
    setSort((prev) => {
      if (!prev || prev.key !== key) return { key, dir: 'desc' }
      if (prev.dir === 'desc') return { key, dir: 'asc' }
      return null
    })
  }

  async function copyTvSymbol(ticker: string, ms: string) {
    const sym = toTvSymbol(ticker, ms)
    try {
      await navigator.clipboard.writeText(sym)
      setCopiedTicker(ticker)
      setTimeout(() => setCopiedTicker((c) => (c === ticker ? null : c)), 1200)
    } catch (e) {
      console.error('clipboard write failed', e)
    }
  }

  function downloadTvWatchlist() {
    const symbols = sortedResults.map((r) => toTvSymbol(r.ticker, r.marketSegment))
    const today = new Date().toISOString().split('T')[0]
    const sectionName = `Screener_JP_${today}`
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
          スクリーナー（マルチ軸ステージフィルタ）
        </h1>
        <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
          取込済みの全銘柄を表示。HEXステージで絞り込み（複数系統は AND）
        </p>
      </div>

      {/* HEXステージ（任意の絞り込み） */}
      <Section step={1} label="HEXステージで絞り込み（任意 / 複数系統 AND）">
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '8px' }}>
          <button
            onClick={() => setStages({})}
            disabled={!hasAnyStage}
            style={{
              padding: '4px 10px',
              fontSize: '11px',
              background: 'var(--bg-surface)',
              border: '1px solid var(--border-base)',
              borderRadius: 'var(--radius-sm)',
              cursor: hasAnyStage ? 'pointer' : 'not-allowed',
              opacity: hasAnyStage ? 1 : 0.5,
              color: 'var(--text-secondary)',
            }}
          >
            × 全てクリア
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px' }}>
          {AXES.map((ax) => (
            <AxisCard
              key={ax.key}
              axis={ax}
              selected={stages[ax.key] ?? []}
              onToggle={(stage) => setStages((prev) => {
                const next = { ...prev }
                const cur = next[ax.key] ?? []
                const after = cur.includes(stage)
                  ? cur.filter((s) => s !== stage)
                  : [...cur, stage]
                if (after.length === 0) delete next[ax.key]
                else next[ax.key] = after
                return next
              })}
              onClear={() => setStages((prev) => {
                const next = { ...prev }
                delete next[ax.key]
                return next
              })}
            />
          ))}
        </div>

        {hasAnyStage && (
          <div style={{
            marginTop: '12px',
            padding: '8px 12px',
            background: 'rgba(217,119,6,0.06)',
            border: '1px solid var(--accent-dim)',
            borderRadius: 'var(--radius-sm)',
            fontSize: '11px',
            color: 'var(--text-secondary)',
          }}>
            🔍 フィルタ条件: <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>{filterText}</span>
          </div>
        )}
      </Section>

      {error && (
        <div className="card" style={{ padding: '12px', borderLeft: '3px solid var(--price-down)' }}>
          <p style={{ fontSize: '12px', color: 'var(--price-down)', margin: 0 }}>エラー: {error}</p>
        </div>
      )}

      {notice && (
        <div className="card" style={{ padding: '12px', borderLeft: '3px solid var(--accent-primary)' }}>
          <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: 0 }}>
            ℹ️ {notice}
            {' '}
            <Link href="/admin/import" style={{ color: 'var(--accent-primary)' }}>CSV取込ページへ →</Link>
          </p>
        </div>
      )}

      {loading ? (
        <div className="card" style={{ padding: '32px', textAlign: 'center' }}>
          <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>計算中…</p>
        </div>
      ) : (
        <div className="card" style={{ overflow: 'hidden' }}>
          <div style={{ padding: '8px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-subtle)', gap: '8px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
              <strong>{sortedResults.length}</strong>件 / 母集団 {universe}銘柄
              {snapshotDate && (
                <span style={{ marginLeft: '6px', fontFamily: 'var(--font-mono)', color: 'var(--accent-primary)' }}>
                  📅 {snapshotDate}
                </span>
              )}
              {cached && <span style={{ marginLeft: '6px', color: 'var(--text-muted)' }}>（DB）</span>}
            </span>
            <button
              onClick={downloadTvWatchlist}
              disabled={sortedResults.length === 0}
              style={{
                padding: '6px 12px',
                fontSize: '11px',
                background: sortedResults.length > 0 ? 'var(--accent-primary)' : 'var(--bg-surface)',
                color: sortedResults.length > 0 ? '#fff' : 'var(--text-muted)',
                border: `1px solid ${sortedResults.length > 0 ? 'var(--accent-primary)' : 'var(--border-base)'}`,
                borderRadius: 'var(--radius-sm)',
                cursor: sortedResults.length > 0 ? 'pointer' : 'not-allowed',
                fontWeight: 600,
                fontFamily: 'var(--font-mono)',
              }}
              title="TradingView の銘柄リストにインポートできる .txt をダウンロード"
            >
              📤 TVリストをダウンロード
            </button>
          </div>
          {sortedResults.length === 0 ? (
            <div style={{ padding: '32px', textAlign: 'center' }}>
              <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>該当する銘柄がありません</p>
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ minWidth: '2300px', borderCollapse: 'collapse', fontSize: '12px' }}>
                <thead>
                  <tr style={{ background: 'var(--bg-elevated)', borderBottom: '1px solid var(--border-dim)' }}>
                    <th style={th}></th>
                    <SortableTh label="コード"     sortKey="ticker"              current={sort} onClick={toggleSort} />
                    <th style={th}>TV形式</th>
                    <SortableTh label="銘柄名"     sortKey="name"                current={sort} onClick={toggleSort} />
                    <SortableTh label="株価"       sortKey="price"               current={sort} onClick={toggleSort} align="right" />
                    <SortableTh label="日%"        sortKey="changePercent"       current={sort} onClick={toggleSort} align="right" />
                    <SortableTh label="週%"        sortKey="changePercentWeek"   current={sort} onClick={toggleSort} align="right" />
                    <SortableTh label="月%"        sortKey="changePercentMonth"  current={sort} onClick={toggleSort} align="right" />
                    <SortableTh label="3ヶ月%"     sortKey="perfPct3m"           current={sort} onClick={toggleSort} align="right" />
                    <SortableTh label="6ヶ月%"     sortKey="perfPct6m"           current={sort} onClick={toggleSort} align="right" />
                    <SortableTh label="年初来%"    sortKey="perfPctYtd"          current={sort} onClick={toggleSort} align="right" />
                    <SortableTh label="出来高"     sortKey="volume"              current={sort} onClick={toggleSort} align="right" />
                    <SortableTh label="平均10日"   sortKey="avgVolume10d"        current={sort} onClick={toggleSort} align="right" />
                    <SortableTh label="平均30日"   sortKey="avgVolume30d"        current={sort} onClick={toggleSort} align="right" />
                    <SortableTh label="時価総額"   sortKey="marketCap"           current={sort} onClick={toggleSort} align="right" />
                    <SortableTh label="PER"        sortKey="per"                 current={sort} onClick={toggleSort} align="right" />
                    <SortableTh label="配当"       sortKey="dividendYield"       current={sort} onClick={toggleSort} align="right" />
                    <SortableTh label="SMA25角度"  sortKey="sma25Angle"          current={sort} onClick={toggleSort} align="right" />
                    <SortableTh label="SMA75角度"  sortKey="sma75Angle"          current={sort} onClick={toggleSort} align="right" />
                    <SortableTh label="前回決算"   sortKey="earningsLastDate"    current={sort} onClick={toggleSort} />
                    <SortableTh label="次回決算"   sortKey="earningsNextDate"    current={sort} onClick={toggleSort} />
                    <SortableTh label="残日数"     sortKey="earningsNextDate"    current={sort} onClick={toggleSort} align="right" />
                    <th style={th}>ステージ (日A/B 週A/B 月A/B)</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedResults.map((r) => {
                    const tv = toTvSymbol(r.ticker, r.marketSegment)
                    const copied = copiedTicker === r.ticker
                    return (
                      <tr key={r.ticker} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                        <td style={{ ...td, width: '32px' }}>
                          <WatchlistButton ticker={r.ticker} size="sm" />
                        </td>
                        <td style={td}>
                          <Link href={`/stock/${encodeURIComponent(r.ticker)}`} style={{ color: 'var(--accent-primary)', fontFamily: 'var(--font-mono)', textDecoration: 'none', fontWeight: 600 }}>
                            {r.ticker.replace('.T', '')}
                          </Link>
                        </td>
                        <td style={td}>
                          <button
                            onClick={() => copyTvSymbol(r.ticker, r.marketSegment)}
                            title={copied ? 'コピーしました' : `${tv} をクリップボードにコピー`}
                            style={{
                              padding: '2px 8px',
                              fontSize: '11px',
                              fontFamily: 'var(--font-mono)',
                              fontWeight: 600,
                              background: copied ? 'var(--price-up, #22c55e)' : 'var(--bg-elevated)',
                              color: copied ? '#fff' : 'var(--text-secondary)',
                              border: `1px solid ${copied ? 'var(--price-up, #22c55e)' : 'var(--border-base)'}`,
                              borderRadius: 'var(--radius-sm)',
                              cursor: 'pointer',
                              transition: 'all 0.15s',
                            }}
                          >
                            {copied ? '✓ コピー済み' : tv}
                          </button>
                        </td>
                        <td style={td}>{r.name}</td>
                        <td style={tdR}>{r.price?.toLocaleString('ja-JP', { maximumFractionDigits: 2 }) ?? '---'}</td>
                        <td style={{ ...tdR, color: pctColor(r.changePercent) }}>{fmtPct(r.changePercent)}</td>
                        <td style={{ ...tdR, color: pctColor(r.changePercentWeek) }}>{fmtPct(r.changePercentWeek)}</td>
                        <td style={{ ...tdR, color: pctColor(r.changePercentMonth) }}>{fmtPct(r.changePercentMonth)}</td>
                        <td style={{ ...tdR, color: pctColor(r.perfPct3m ?? undefined) }}>{fmtPct(r.perfPct3m ?? undefined)}</td>
                        <td style={{ ...tdR, color: pctColor(r.perfPct6m ?? undefined) }}>{fmtPct(r.perfPct6m ?? undefined)}</td>
                        <td style={{ ...tdR, color: pctColor(r.perfPctYtd ?? undefined) }}>{fmtPct(r.perfPctYtd ?? undefined)}</td>
                        <td style={tdR}>{r.volume?.toLocaleString('ja-JP') ?? '---'}</td>
                        <td style={tdR}>{r.avgVolume10d != null ? r.avgVolume10d.toLocaleString('ja-JP') : '---'}</td>
                        <td style={tdR}>{r.avgVolume30d != null ? r.avgVolume30d.toLocaleString('ja-JP') : '---'}</td>
                        <td style={tdR}>{r.marketCap ? `${(r.marketCap / 1e8).toLocaleString('ja-JP', { maximumFractionDigits: 0 })} 億` : '---'}</td>
                        <td style={tdR}>{r.per != null ? r.per.toFixed(1) : '---'}</td>
                        <td style={tdR}>{r.dividendYield != null ? `${r.dividendYield.toFixed(2)}%` : '---'}</td>
                        <td style={{ ...tdR, color: pctColor(r.sma25Angle ?? undefined) }}>{fmtAngle(r.sma25Angle ?? undefined)}</td>
                        <td style={{ ...tdR, color: pctColor(r.sma75Angle ?? undefined) }}>{fmtAngle(r.sma75Angle ?? undefined)}</td>
                        <td style={{ ...td, fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{r.earningsLastDate ?? '---'}</td>
                        <td style={{ ...td, fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{r.earningsNextDate ?? '---'}</td>
                        <td style={{ ...tdR, color: daysColor(daysUntil(r.earningsNextDate)) }}>{fmtDaysUntil(r.earningsNextDate)}</td>
                        <td style={{ ...td, fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                          {r.daily_a_stage ?? '-'}/{r.daily_b_stage ?? '-'} {r.weekly_a_stage ?? '-'}/{r.weekly_b_stage ?? '-'} {r.monthly_a_stage ?? '-'}/{r.monthly_b_stage ?? '-'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
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

function fmtAngle(v: number | undefined): string {
  if (v == null || !Number.isFinite(v)) return '---'
  const sign = v > 0 ? '+' : ''
  return `${sign}${v.toFixed(2)}°`
}

/** 次回決算日までの残日数（負なら過去）。日跨ぎは UTC 0時基準で安定化。 */
function daysUntil(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr)
  if (!m) return null
  const target = Date.UTC(+m[1], +m[2] - 1, +m[3])
  const now = new Date()
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
  return Math.round((target - today) / 86400000)
}

function fmtDaysUntil(dateStr: string | null | undefined): string {
  const d = daysUntil(dateStr)
  if (d == null) return '---'
  if (d === 0) return '本日'
  if (d > 0) return `${d}日`
  return `${d}日 (過去)`
}

function daysColor(d: number | null): string {
  if (d == null) return 'var(--text-muted)'
  if (d < 0) return 'var(--text-muted)'
  if (d <= 7) return 'var(--price-down, #ef4444)'    // 1週間以内: 強調赤
  if (d <= 30) return 'var(--accent-primary)'         // 1ヶ月以内: 強調
  return 'var(--text-secondary)'
}

function pctColor(v: number | undefined): string {
  if (v == null || !Number.isFinite(v)) return 'var(--text-muted)'
  if (v > 0) return 'var(--price-up, #22c55e)'
  if (v < 0) return 'var(--price-down, #ef4444)'
  return 'var(--text-secondary)'
}

function SortableTh({
  label, sortKey, current, onClick, align = 'left',
}: {
  label: string
  sortKey: SortKey
  current: SortState | null
  onClick: (k: SortKey) => void
  align?: 'left' | 'right'
}) {
  const isActive = current?.key === sortKey
  const arrow = isActive
    ? (current.dir === 'desc' ? ' ▼' : ' ▲')
    : ' ⇅'
  return (
    <th
      style={{
        ...(align === 'right' ? thR : th),
        cursor: 'pointer',
        userSelect: 'none',
        color: isActive ? 'var(--accent-primary)' : undefined,
      }}
      onClick={() => onClick(sortKey)}
      title="クリックでソート"
    >
      {label}<span style={{ opacity: isActive ? 1 : 0.4, fontSize: '10px' }}>{arrow}</span>
    </th>
  )
}

function AxisCard({
  axis,
  selected,
  disabled,
  onToggle,
  onClear,
}: {
  axis: { key: AxisKey; label: string; color: string }
  selected: number[]
  disabled?: boolean
  onToggle: (stage: number) => void
  onClear: () => void
}) {
  const sortedSelected = [...selected].sort()
  return (
    <div className="card" style={{ padding: '12px', opacity: disabled ? 0.5 : 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' }}>
        <span style={{
          width: '10px',
          height: '10px',
          borderRadius: '50%',
          background: axis.color,
          flexShrink: 0,
        }} />
        <span style={{ fontSize: '13px', fontWeight: 600 }}>{axis.label}</span>
        {selected.length > 0 && (
          <button
            onClick={onClear}
            disabled={disabled}
            style={{
              marginLeft: 'auto',
              padding: '2px 6px',
              fontSize: '10px',
              background: 'transparent',
              border: '1px solid var(--border-base)',
              borderRadius: 'var(--radius-sm)',
              cursor: disabled ? 'not-allowed' : 'pointer',
              color: 'var(--text-muted)',
            }}
            title="この系統の選択をクリア"
          >
            ×
          </button>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '6px' }}>
        {[1, 2, 3, 4, 5, 6].map((s) => {
          const active = selected.includes(s)
          return (
            <button
              key={s}
              disabled={disabled}
              onClick={() => onToggle(s)}
              style={{
                padding: '8px 0',
                fontSize: '14px',
                fontWeight: 700,
                fontFamily: 'var(--font-mono)',
                background: active ? axis.color : 'var(--bg-elevated)',
                color: active ? '#fff' : 'var(--text-secondary)',
                border: `1px solid ${active ? axis.color : 'var(--border-base)'}`,
                borderRadius: 'var(--radius-sm)',
                cursor: disabled ? 'not-allowed' : 'pointer',
                boxShadow: active ? `0 2px 8px ${axis.color}55` : 'none',
              }}
            >
              {s}
            </button>
          )
        })}
      </div>

      <div style={{ marginTop: '8px', fontSize: '10px', color: 'var(--text-muted)', display: 'flex', flexWrap: 'wrap', gap: '4px', alignItems: 'center' }}>
        <span>選択中:</span>
        {sortedSelected.length > 0 ? (
          sortedSelected.map((s) => (
            <span
              key={s}
              style={{
                display: 'inline-block',
                padding: '2px 8px',
                background: axis.color,
                color: '#fff',
                borderRadius: '10px',
                fontFamily: 'var(--font-mono)',
                fontWeight: 600,
                fontSize: '10px',
              }}
            >
              Stage {s}
            </span>
          ))
        ) : (
          <span style={{ color: 'var(--text-muted)' }}>なし</span>
        )}
      </div>
    </div>
  )
}

function Section({ step, label, disabled, children }: { step: number; label: string; disabled?: boolean; children: React.ReactNode }) {
  return (
    <div style={{ opacity: disabled ? 0.5 : 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
        <span style={{
          width: '20px',
          height: '20px',
          borderRadius: '50%',
          background: 'var(--accent-primary)',
          color: '#fff',
          fontSize: '11px',
          fontWeight: 700,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}>{step}</span>
        <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)' }}>{label}</span>
      </div>
      <div style={{ paddingLeft: '28px' }}>{children}</div>
    </div>
  )
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
const td: React.CSSProperties = { padding: '8px 12px', fontSize: '12px', color: 'var(--text-primary)', whiteSpace: 'nowrap' }
const tdR: React.CSSProperties = { ...td, textAlign: 'right', fontFamily: 'var(--font-mono)' }
