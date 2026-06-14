// components/stock/StageTimeline.tsx
'use client'

import { useEffect, useState } from 'react'
import { STAGE_BORDER_COLORS, STAGE_LABELS } from '@/lib/hex-stage'

interface StageEntry {
  date: string
  daily_a_stage: number | null
  daily_b_stage: number | null
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
  close: number | null
}

interface DateRange {
  startDate: string
  endDate: string
}

export interface StageRangeSelection extends DateRange {
  sourceLabel: string
  stage: number
  systemKey: StageKey
}

interface StageTimelineProps {
  ticker: string
  selectedRange?: DateRange | null
  onStageRangeSelect?: (selection: StageRangeSelection) => void
}

type Granularity = 'daily' | 'weekly' | 'monthly'
type StageKey =
  | 'daily_a_stage'
  | 'daily_b_stage'
  | 'weekly_a_stage'
  | 'weekly_b_stage'
  | 'monthly_a_stage'
  | 'monthly_b_stage'

const SYSTEMS: { key: StageKey; label: string }[] = [
  { key: 'daily_a_stage', label: '日足A' },
  { key: 'daily_b_stage', label: '日足B' },
  { key: 'weekly_a_stage', label: '週足A' },
  { key: 'weekly_b_stage', label: '週足B' },
  { key: 'monthly_a_stage', label: '月足A' },
  { key: 'monthly_b_stage', label: '月足B' },
]

const GRANULARITIES: { key: Granularity; label: string; subtitle: string }[] = [
  { key: 'daily', label: '日毎', subtitle: '各営業日時点の3本MA配列' },
  { key: 'weekly', label: '週毎', subtitle: '各週末相当の3本MA配列' },
  { key: 'monthly', label: '月毎', subtitle: '各月末営業日時点の3本MA配列' },
]

const PRESETS: Record<Granularity, { label: string; count: number }[]> = {
  daily: [
    { label: '20D', count: 20 },
    { label: '60D', count: 60 },
    { label: '120D', count: 120 },
  ],
  weekly: [
    { label: '13W', count: 13 },
    { label: '26W', count: 26 },
    { label: '52W', count: 52 },
  ],
  monthly: [
    { label: '12M', count: 12 },
    { label: '24M', count: 24 },
    { label: '60M', count: 60 },
  ],
}

const DEFAULT_COUNTS: Record<Granularity, number> = {
  daily: 60,
  weekly: 13,
  monthly: 24,
}

/**
 * 選択粒度に応じたステージ変遷をグリッド表示。
 * 行: 日足A/B、週足A/B、月足A/B
 * 列: 日毎 / 週毎 / 月毎の日付
 */
export function StageTimeline({ ticker, selectedRange, onStageRangeSelect }: StageTimelineProps) {
  const [entries, setEntries] = useState<StageEntry[]>([])
  const [activeStartDate, setActiveStartDate] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [granularity, setGranularity] = useState<Granularity>('weekly')
  const [count, setCount] = useState(DEFAULT_COUNTS.weekly)

  const selectedGranularity = GRANULARITIES.find((item) => item.key === granularity) ?? GRANULARITIES[1]

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    const params = new URLSearchParams({
      granularity,
      count: String(count),
    })
    fetch(`/api/stage-history/${encodeURIComponent(ticker)}?${params.toString()}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return
        if (d.error) throw new Error(d.error)
        setEntries(d.history ?? [])
        setActiveStartDate(d.activeStartDate ?? null)
      })
      .catch((e) => { if (!cancelled) setError((e as Error).message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [ticker, granularity, count])

  function selectGranularity(next: Granularity) {
    setGranularity(next)
    setCount(DEFAULT_COUNTS[next])
  }

  const hasVisibleSelection = selectedRange
    ? entries.some((entry) => isDateWithinRange(entry.date, selectedRange))
    : false

  function selectStageSegment(system: { key: StageKey; label: string }, index: number) {
    if (!onStageRangeSelect) return
    const stage = entries[index]?.[system.key]
    if (!stage) return
    let startIndex = index
    let endIndex = index
    while (startIndex > 0 && entries[startIndex - 1][system.key] === stage) startIndex -= 1
    while (endIndex < entries.length - 1 && entries[endIndex + 1][system.key] === stage) endIndex += 1
    onStageRangeSelect({
      startDate: entries[startIndex].date,
      endDate: entries[endIndex].date,
      sourceLabel: `${system.label} S${stage}`,
      stage,
      systemKey: system.key,
    })
  }

  return (
    <div className="card" style={{ padding: '12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px', marginBottom: '8px', flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: '11px', fontWeight: 600 }}>ステージ変遷（{selectedGranularity.label}）</div>
          <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
            {selectedGranularity.subtitle}
            {activeStartDate ? ` / 連続データ開始 ${activeStartDate}` : ''}
          </div>
          {selectedRange && !loading && entries.length > 0 && !hasVisibleSelection && (
            <div style={rangeOutsideStyle}>
              選択期間 {selectedRange.startDate} → {selectedRange.endDate} は現在の表示範囲外です
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <div style={segmentedControl}>
            {GRANULARITIES.map((item) => (
              <button
                key={item.key}
                onClick={() => selectGranularity(item.key)}
                style={segmentButton(granularity === item.key)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div style={segmentedControl}>
            {PRESETS[granularity].map((preset) => (
              <button
                key={preset.label}
                onClick={() => setCount(preset.count)}
                style={segmentButton(count === preset.count)}
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {error && <p style={{ fontSize: '11px', color: 'var(--price-down)' }}>エラー: {error}</p>}

      {loading ? (
        <p style={{ fontSize: '11px', color: 'var(--text-muted)', textAlign: 'center', padding: '16px 0' }}>計算中...</p>
      ) : entries.length === 0 ? (
        <p style={{ fontSize: '11px', color: 'var(--text-muted)', textAlign: 'center', padding: '16px 0' }}>データなし</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '10px' }}>
            <thead>
              <tr>
                <th style={{ ...stickyTh, textAlign: 'left' }}>系統</th>
                {entries.map((e) => (
                  <th key={e.date} style={dateHeaderStyle(selectedRange ? isDateWithinRange(e.date, selectedRange) : false)}>
                    {e.date.slice(5)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {SYSTEMS.map((sys) => (
                <tr key={sys.key}>
                  <td style={{ ...stickyTd, fontWeight: 600 }}>{sys.label}</td>
                  {entries.map((e, index) => {
                    const v = e[sys.key] as number | null
                    const inSelectedRange = selectedRange ? isDateWithinRange(e.date, selectedRange) : false
                    return (
                      <td key={e.date} style={cellStyle(inSelectedRange)}>
                        {v ? (
                          <button
                            type="button"
                            onClick={() => selectStageSegment(sys, index)}
                            title={`S${v}: ${STAGE_LABELS[v]}`}
                            style={stageButtonStyle(v, Boolean(onStageRangeSelect))}
                          >{v}</button>
                        ) : (
                          <span style={{ color: 'var(--text-muted)' }}>-</span>
                        )}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

const th: React.CSSProperties = {
  padding: '4px 6px',
  fontFamily: 'var(--font-mono)',
  color: 'var(--text-muted)',
  fontSize: '9px',
  textAlign: 'center',
  fontWeight: 500,
  whiteSpace: 'nowrap',
}

function dateHeaderStyle(active: boolean): React.CSSProperties {
  return {
    ...th,
    background: active ? 'rgba(250, 204, 21, 0.16)' : undefined,
    color: active ? 'var(--accent-primary)' : th.color,
  }
}

const stickyTh: React.CSSProperties = {
  padding: '4px 8px',
  fontSize: '10px',
  color: 'var(--text-muted)',
  fontWeight: 500,
  position: 'sticky',
  left: 0,
  background: 'var(--bg-elevated)',
  whiteSpace: 'nowrap',
}

function cellStyle(active: boolean): React.CSSProperties {
  return {
    padding: '4px 6px',
    textAlign: 'center',
    borderBottom: '1px solid var(--border-subtle)',
    background: active ? 'rgba(250, 204, 21, 0.16)' : undefined,
    boxShadow: active ? 'inset 0 2px 0 rgba(245, 158, 11, 0.28), inset 0 -2px 0 rgba(245, 158, 11, 0.18)' : undefined,
  }
}

function stageButtonStyle(stage: number, clickable: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '20px',
    height: '20px',
    borderRadius: '3px',
    background: STAGE_BORDER_COLORS[stage],
    color: '#fff',
    fontWeight: 700,
    fontSize: '10px',
    fontFamily: 'var(--font-mono)',
    border: 'none',
    cursor: clickable ? 'pointer' : 'default',
    padding: 0,
  }
}

function isDateWithinRange(date: string, range: DateRange): boolean {
  return date >= range.startDate && date <= range.endDate
}

const rangeOutsideStyle: React.CSSProperties = {
  marginTop: '4px',
  color: 'var(--accent-primary)',
  fontSize: '10px',
  fontFamily: 'var(--font-mono)',
}

const stickyTd: React.CSSProperties = {
  padding: '4px 8px',
  fontSize: '11px',
  color: 'var(--text-primary)',
  position: 'sticky',
  left: 0,
  background: 'var(--bg-surface)',
  whiteSpace: 'nowrap',
  borderBottom: '1px solid var(--border-subtle)',
}

const segmentedControl: React.CSSProperties = {
  display: 'inline-flex',
  border: '1px solid var(--border-base)',
  borderRadius: 'var(--radius-sm)',
  overflow: 'hidden',
}

function segmentButton(active: boolean): React.CSSProperties {
  return {
    padding: '3px 10px',
    fontSize: '10px',
    fontFamily: 'var(--font-mono)',
    background: active ? 'var(--accent-primary)' : 'transparent',
    color: active ? '#fff' : 'var(--text-secondary)',
    border: 'none',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  }
}
