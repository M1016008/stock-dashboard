// components/stock/StageTimeline.tsx
'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { STAGE_BORDER_COLORS, STAGE_LABELS } from '@/lib/hex-stage'
import type { MarketCode } from '@/lib/markets'
import {
  DEFAULT_STAGE_TIMELINE_DISPLAY_COUNTS,
  STAGE_TIMELINE_DISPLAY_PRESETS,
} from '@/lib/stage-history-window'

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

export interface StageTimelineSnapshot {
  status: 'loading' | 'available' | 'missing' | 'error'
  date: string | null
  stages: {
    dailyA: number | null
    dailyB: number | null
    weeklyA: number | null
    weeklyB: number | null
    monthlyA: number | null
    monthlyB: number | null
  } | null
  message: string | null
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

export function StageTimelineValue({
  stage,
  onSelect,
}: {
  stage: number
  onSelect?: () => void
}) {
  const title = `S${stage}: ${STAGE_LABELS[stage]}`
  if (onSelect) {
    return (
      <button
        type="button"
        onClick={onSelect}
        title={title}
        style={stageButtonStyle(stage, true)}
      >{stage}</button>
    )
  }
  return (
    <span title={title} style={stageButtonStyle(stage, false)}>{stage}</span>
  )
}

interface StageTimelineProps {
  ticker: string
  market?: MarketCode
  analysisDate?: string | null
  selectedRange?: DateRange | null
  onStageRangeSelect?: (selection: StageRangeSelection) => void
  onSnapshotChange?: (snapshot: StageTimelineSnapshot) => void
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
  { key: 'weekly', label: '週毎', subtitle: '各暦週の最終営業日時点の3本MA配列' },
  { key: 'monthly', label: '月毎', subtitle: '各月末営業日時点の3本MA配列' },
]

const DISPLAY_SUFFIX: Record<Granularity, string> = { daily: 'D', weekly: 'W', monthly: 'M' }
const RUN_UNITS: Record<Granularity, string> = { daily: '日', weekly: '週', monthly: 'か月' }

type HistoryView = 'timeline' | 'classic'
const HISTORY_VIEWS: { key: HistoryView; label: string }[] = [
  { key: 'timeline', label: 'Timeline' },
  { key: 'classic', label: 'Classic' },
]
// 表示形式はタブ内の閲覧状態だけなので sessionStorage に留める(DB/APIには保存しない)
const HISTORY_VIEW_STORAGE_KEY = 'stockboard:stage-history-view'

function readStoredHistoryView(): HistoryView {
  try {
    return window.sessionStorage.getItem(HISTORY_VIEW_STORAGE_KEY) === 'classic' ? 'classic' : 'timeline'
  } catch {
    return 'timeline'
  }
}

interface StageRun {
  stage: number | null
  startIndex: number
  endIndex: number
  length: number
}

function buildRuns(entries: StageEntry[], key: StageKey): StageRun[] {
  const runs: StageRun[] = []
  entries.forEach((entry, index) => {
    const stage = entry[key] || null
    const last = runs[runs.length - 1]
    if (last && last.stage === stage) {
      last.endIndex = index
      last.length += 1
    } else {
      runs.push({ stage, startIndex: index, endIndex: index, length: 1 })
    }
  })
  return runs
}

function buildTicks(entries: StageEntry[], granularity: Granularity): Array<{ index: number; label: string }> {
  if (entries.length === 0) return []
  const wanted = Math.min(entries.length, 5)
  const indexes = new Set<number>()
  for (let i = 0; i < wanted; i += 1) {
    indexes.add(wanted === 1 ? 0 : Math.round((i * (entries.length - 1)) / (wanted - 1)))
  }
  return [...indexes].map((index) => ({
    index,
    label: granularity === 'monthly' ? entries[index].date.slice(0, 7) : entries[index].date.slice(2),
  }))
}

/**
 * 選択粒度に応じたステージ変遷を表示。同じ取得結果を2形式で切り替える。
 * Timeline: 系統ごとの連続期間レーン(幅=同一ステージの継続期間数)
 * Classic: 行=系統、列=日付のグリッド(従来表示)
 */
export function StageTimeline({
  ticker,
  market = 'JP',
  analysisDate = null,
  selectedRange,
  onStageRangeSelect,
  onSnapshotChange,
}: StageTimelineProps) {
  const [entries, setEntries] = useState<StageEntry[]>([])
  const [activeStartDate, setActiveStartDate] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [granularity, setGranularity] = useState<Granularity>('weekly')
  const [count, setCount] = useState(DEFAULT_STAGE_TIMELINE_DISPLAY_COUNTS.weekly)
  const [view, setView] = useState<HistoryView>('timeline')
  const classicScrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setView(readStoredHistoryView())
  }, [])

  function selectView(next: HistoryView) {
    setView(next)
    try {
      window.sessionStorage.setItem(HISTORY_VIEW_STORAGE_KEY, next)
    } catch {
      // sessionStorage が使えない環境ではマウント中の状態だけ保持する
    }
  }

  const selectedGranularity = GRANULARITIES.find((item) => item.key === granularity) ?? GRANULARITIES[1]

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    setEntries([])
    onSnapshotChange?.({ status: 'loading', date: null, stages: null, message: null })
    const params = new URLSearchParams({
      market,
      granularity,
      count: String(count),
    })
    if (analysisDate) {
      params.set('endDate', analysisDate)
    }
    fetch(`/api/stage-history/${encodeURIComponent(ticker)}?${params.toString()}`, {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = await response.json()
        if (!response.ok) throw new Error(data.message ?? data.error ?? `HTTP ${response.status}`)
        return data
      })
      .then((d) => {
        if (d.error) throw new Error(d.error)
        const history = (d.history ?? []) as StageEntry[]
        const latest = history.at(-1) ?? null
        setEntries(history)
        setActiveStartDate(d.activeStartDate ?? null)
        onSnapshotChange?.(latest ? {
          status: 'available',
          date: latest.date,
          stages: {
            dailyA: latest.daily_a_stage,
            dailyB: latest.daily_b_stage,
            weeklyA: latest.weekly_a_stage,
            weeklyB: latest.weekly_b_stage,
            monthlyA: latest.monthly_a_stage,
            monthlyB: latest.monthly_b_stage,
          },
          message: null,
        } : {
          status: 'missing',
          date: null,
          stages: null,
          message: '基準日時点のStage履歴がありません',
        })
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        const message = error instanceof Error ? error.message : String(error)
        setError(message)
        onSnapshotChange?.({ status: 'error', date: null, stages: null, message })
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [analysisDate, ticker, market, granularity, count, onSnapshotChange])

  useEffect(() => {
    const container = classicScrollRef.current
    if (view !== 'classic' || !container || entries.length === 0) return
    container.scrollLeft = container.scrollWidth
  }, [entries, view])

  const lanes = useMemo(() => SYSTEMS.map((system) => ({ system, runs: buildRuns(entries, system.key) })), [entries])
  const ticks = useMemo(() => buildTicks(entries, granularity), [entries, granularity])
  const runUnit = RUN_UNITS[granularity]
  const selectionSpan = useMemo(() => {
    if (!selectedRange || entries.length === 0) return null
    const first = entries.findIndex((entry) => isDateWithinRange(entry.date, selectedRange))
    if (first < 0) return null
    let last = first
    while (last + 1 < entries.length && isDateWithinRange(entries[last + 1].date, selectedRange)) last += 1
    return { first, last }
  }, [entries, selectedRange])

  function selectGranularity(next: Granularity) {
    setGranularity(next)
    setCount(DEFAULT_STAGE_TIMELINE_DISPLAY_COUNTS[next])
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
    <section className="card" style={{ padding: '12px' }} aria-labelledby="stage-timeline-title">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px', marginBottom: '8px', flexWrap: 'wrap' }}>
        <div>
          <div className="text-[9px] font-black uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">Stage history</div>
          <h2 id="stage-timeline-title" className="mt-0.5 text-[13px] font-black text-[var(--color-text-primary)]">ステージ変遷（{selectedGranularity.label}）</h2>
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
          <div style={segmentedControl} role="group" aria-label="ステージ変遷の表示形式">
            {HISTORY_VIEWS.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => selectView(item.key)}
                style={segmentButton(view === item.key)}
                className="min-h-11 px-2.5 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--color-brand-900)] sm:min-h-8"
                aria-pressed={view === item.key}
                aria-controls="stage-history-body"
              >
                {item.label}
              </button>
            ))}
          </div>
          <div style={segmentedControl}>
            {GRANULARITIES.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => selectGranularity(item.key)}
                style={segmentButton(granularity === item.key)}
                className="min-h-11 px-2.5 sm:min-h-8"
                aria-pressed={granularity === item.key}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div style={segmentedControl} aria-label="表示期間">
            {STAGE_TIMELINE_DISPLAY_PRESETS[granularity].map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => setCount(preset)}
                style={segmentButton(count === preset)}
                className="min-h-11 px-2.5 sm:min-h-8"
                title={`直近${preset}${granularity === 'daily' ? '営業日' : granularity === 'weekly' ? '週' : 'か月'}を表示`}
                aria-pressed={count === preset}
              >
                {preset}{DISPLAY_SUFFIX[granularity]}
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
      ) : view === 'classic' ? (
        <div id="stage-history-body" ref={classicScrollRef} style={{ overflowX: 'auto' }}>
          <table style={{ width: 'max-content', minWidth: '100%', borderCollapse: 'collapse', fontSize: '10px' }}>
            <caption className="sr-only">系統別ステージの日付別一覧(右端が最新)</caption>
            <thead>
              <tr>
                <th scope="col" style={{ ...stickyTh, textAlign: 'left' }}>系統</th>
                {entries.map((e, index) => (
                  <th key={e.date} scope="col" style={dateHeaderStyle(selectedRange ? isDateWithinRange(e.date, selectedRange) : false, index === entries.length - 1)}>
                    {e.date.slice(5)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {SYSTEMS.map((sys, systemIndex) => (
                <tr key={sys.key}>
                  <th scope="row" style={{ ...stickyTd, fontWeight: 600, textAlign: 'left', ...(systemIndex === 2 || systemIndex === 4 ? timeframeDividerStyle : {}) }}>{sys.label}</th>
                  {entries.map((e, index) => {
                    const v = e[sys.key] as number | null
                    const inSelectedRange = selectedRange ? isDateWithinRange(e.date, selectedRange) : false
                    return (
                      <td key={e.date} style={{ ...cellStyle(inSelectedRange, index === entries.length - 1), ...(systemIndex === 2 || systemIndex === 4 ? timeframeDividerStyle : {}) }}>
                        {v ? (
                          <StageTimelineValue
                            stage={v}
                            onSelect={onStageRangeSelect ? () => selectStageSegment(sys, index) : undefined}
                          />
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
      ) : (
        <div id="stage-history-body" className="min-w-0">
          <div className="grid grid-cols-[40px_minmax(0,1fr)_64px] items-end gap-x-2 pb-1 text-[9px] font-bold text-[var(--color-text-tertiary)]">
            <span>系統</span>
            <span>連続期間(幅=継続長)</span>
            <span className="text-right">現在</span>
          </div>
          <div className="relative">
            {selectionSpan && (
              <div className="pointer-events-none absolute inset-y-0 left-[48px] right-[72px] z-[1]" aria-hidden="true">
                <span
                  className="absolute inset-y-0 border-x-2 border-amber-500 bg-amber-300/20"
                  style={{
                    left: `${(selectionSpan.first / entries.length) * 100}%`,
                    width: `${((selectionSpan.last - selectionSpan.first + 1) / entries.length) * 100}%`,
                  }}
                />
              </div>
            )}
            {lanes.map(({ system, runs }, laneIndex) => {
              const current = runs[runs.length - 1]
              const currentStage = current?.stage ?? null
              return (
                <div
                  key={system.key}
                  className={`grid grid-cols-[40px_minmax(0,1fr)_64px] items-center gap-x-2 ${laneIndex % 2 === 0 ? 'pt-0.5' : 'pb-1.5'}`}
                  role="group"
                  aria-label={currentStage ? `${system.label} 現在S${currentStage} 連続${current.length}${runUnit}` : `${system.label} 現在データなし`}
                >
                  <span className="text-[10px] font-black text-[var(--color-text-secondary)]">{system.label}</span>
                  <div className="flex h-6 min-w-0 overflow-hidden bg-[var(--color-surface-subtle)]">
                    {runs.map((run) => {
                      const range = `${entries[run.startIndex].date}〜${entries[run.endIndex].date}(${run.length}${runUnit})`
                      const title = run.stage ? `${system.label} S${run.stage}: ${STAGE_LABELS[run.stage]} ${range}` : `${system.label} データなし ${range}`
                      const style: React.CSSProperties = {
                        flex: `${run.length} 1 0`,
                        minWidth: 2,
                        background: run.stage ? STAGE_BORDER_COLORS[run.stage] : 'transparent',
                      }
                      const label = run.stage && run.length >= 3 ? `S${run.stage}` : ''
                      const className = 'flex items-center justify-center overflow-hidden border-r border-white font-mono text-[10px] font-bold text-white last:border-r-0'
                      return run.stage && onStageRangeSelect ? (
                        <button
                          key={run.startIndex}
                          type="button"
                          onClick={() => selectStageSegment(system, run.startIndex)}
                          title={title}
                          aria-label={title}
                          style={style}
                          className={`${className} cursor-pointer p-0 hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--color-brand-900)]`}
                        >{label}</button>
                      ) : (
                        <span key={run.startIndex} title={title} style={style} className={className}>{label}</span>
                      )
                    })}
                  </div>
                  <span className="truncate text-right font-mono text-[10px] font-black text-[var(--color-text-primary)]">
                    {currentStage ? <>S{currentStage}<span className="font-semibold text-[var(--color-text-tertiary)]"> ×{current.length}{runUnit}</span></> : '—'}
                  </span>
                </div>
              )
            })}
          </div>
          <div className="grid grid-cols-[40px_minmax(0,1fr)_64px] gap-x-2 pt-1">
            <span />
            <div className="relative h-3.5">
              {ticks.map((tick, tickIndex) => {
                const position = ((tick.index + 0.5) / entries.length) * 100
                const align = tickIndex === 0 ? '' : tickIndex === ticks.length - 1 ? '-translate-x-full' : '-translate-x-1/2'
                return (
                  <span
                    key={tick.index}
                    className={`absolute top-0 whitespace-nowrap font-mono text-[9px] font-semibold text-[var(--color-text-tertiary)] ${align}`}
                    style={{ left: tickIndex === 0 ? 0 : `${position}%` }}
                  >{tick.label}</span>
                )
              })}
            </div>
            <span />
          </div>
        </div>
      )}
    </section>
  )
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

const th: React.CSSProperties = {
  padding: '4px 6px',
  fontFamily: 'var(--font-mono)',
  color: 'var(--text-muted)',
  fontSize: '9px',
  textAlign: 'center',
  fontWeight: 500,
  whiteSpace: 'nowrap',
}

function dateHeaderStyle(active: boolean, current: boolean): React.CSSProperties {
  return {
    ...th,
    background: active ? 'rgba(250, 204, 21, 0.16)' : current ? 'var(--bg-elevated)' : undefined,
    color: active ? 'var(--accent-primary)' : current ? 'var(--text-primary)' : th.color,
    fontWeight: current ? 800 : th.fontWeight,
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

function cellStyle(active: boolean, current: boolean): React.CSSProperties {
  return {
    padding: '4px 6px',
    textAlign: 'center',
    borderBottom: '1px solid var(--border-subtle)',
    background: active ? 'rgba(250, 204, 21, 0.16)' : current ? 'var(--bg-elevated)' : undefined,
    boxShadow: active ? 'inset 0 2px 0 rgba(245, 158, 11, 0.28), inset 0 -2px 0 rgba(245, 158, 11, 0.18)' : undefined,
  }
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

const timeframeDividerStyle: React.CSSProperties = {
  borderTop: '3px solid var(--border-base)',
}

const segmentedControl: React.CSSProperties = {
  display: 'inline-flex',
  border: '1px solid var(--border-base)',
  borderRadius: 'var(--radius-sm)',
  overflow: 'hidden',
}

function segmentButton(active: boolean): React.CSSProperties {
  return {
    fontSize: '10px',
    fontFamily: 'var(--font-mono)',
    background: active ? 'var(--accent-primary)' : 'transparent',
    color: active ? '#fff' : 'var(--text-secondary)',
    border: 'none',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  }
}
