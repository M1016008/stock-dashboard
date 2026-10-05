// components/stock/StageTimeline.tsx
'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { STAGE_BORDER_COLORS, STAGE_LABELS } from '@/lib/hex-stage'
import type { MarketCode } from '@/lib/markets'
import {
  DEFAULT_STAGE_TIMELINE_DISPLAY_COUNTS,
  STAGE_TIMELINE_DISPLAY_PRESETS,
} from '@/lib/stage-history-window'

export interface StageEntry {
  date: string
  daily_a_stage: number | null
  daily_b_stage: number | null
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
  close: number | null
}

export interface StageStabilitySummary {
  availableAxes: number
  alignedAxes: number
  dominantStage: number | null
  transitionCount: number
  observationCount: number
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
export type StageKey =
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

// ラベルはチャートの時間軸(日足/週足/月足)と同じ語に揃える。何時点を抜き出すかは subtitle で明示する
const GRANULARITIES: { key: Granularity; label: string; subtitle: string }[] = [
  { key: 'daily', label: '日足', subtitle: '各営業日時点の3本MA配列' },
  { key: 'weekly', label: '週足', subtitle: '各暦週の最終営業日時点の3本MA配列' },
  { key: 'monthly', label: '月足', subtitle: '各月末営業日時点の3本MA配列' },
]

const RUN_UNITS: Record<Granularity, string> = { daily: '日', weekly: '週', monthly: 'か月' }

const VIEW_CAPTIONS: Record<HistoryView, string> = {
  timeline: '遷移を継続幅で表示',
  classic: '日付 × 系統の正確なStage',
}

const STAGE_NUMBERS = [1, 2, 3, 4, 5, 6] as const

// 系統名 / 連続期間の帯 / 現在(Stage・直前からの遷移・継続長)。ヘッダ・各レーン・目盛りで列幅を共有する
const LANE_GRID = 'sm:grid-cols-[48px_minmax(0,1fr)_120px]'

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

export interface StageRun {
  stage: number | null
  startIndex: number
  endIndex: number
  length: number
}

export function buildRuns(entries: StageEntry[], key: StageKey): StageRun[] {
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

export type RunLabelTier = 'none' | 'digit' | 'stage' | 'full'

// 帯の実幅(px)から、はみ出さずに描けるラベルの段階を決める。'none' の期間は Stage列 で識別する
export function classifyRunLabel(runPx: number): RunLabelTier {
  if (!Number.isFinite(runPx) || runPx < 9) return 'none'
  if (runPx < 20) return 'digit'
  if (runPx < 80) return 'stage'
  return 'full'
}

export function pickTickCount(trackWidth: number): number {
  if (!Number.isFinite(trackWidth) || trackWidth <= 0) return 3
  return Math.min(5, Math.max(2, Math.floor(trackWidth / 72)))
}

export interface StageTransition {
  date: string
  system: StageKey
  from: number
  to: number
  fromLength: number
  fromTruncated: boolean
  toStartIndex: number
}

// summarizeStageStability と同じ規則(前後ともnullでなく、値が異なる)で変更点を列挙する。古い順、同日は SYSTEMS 順
export function buildStageTransitions(entries: StageEntry[]): StageTransition[] {
  const transitions: StageTransition[] = []
  for (const { key } of SYSTEMS) {
    const runs = buildRuns(entries, key)
    for (let index = 1; index < entries.length; index += 1) {
      const previous = entries[index - 1][key]
      const current = entries[index][key]
      if (previous == null || current == null || previous === current) continue
      const fromRun = runs.find((run) => run.startIndex <= index - 1 && index - 1 <= run.endIndex)
      if (!fromRun) continue
      transitions.push({
        date: entries[index].date,
        system: key,
        from: previous,
        to: current,
        fromLength: fromRun.length,
        fromTruncated: fromRun.startIndex === 0,
        toStartIndex: index,
      })
    }
  }
  return transitions.sort((left, right) => left.toStartIndex - right.toStartIndex)
}

function buildTicks(
  entries: StageEntry[],
  granularity: Granularity,
  tickCount: number,
): Array<{ index: number; label: string }> {
  if (entries.length === 0) return []
  const wanted = Math.min(entries.length, tickCount)
  const indexes = new Set<number>()
  for (let i = 0; i < wanted; i += 1) {
    indexes.add(wanted === 1 ? 0 : Math.round((i * (entries.length - 1)) / (wanted - 1)))
  }
  return [...indexes].map((index) => ({
    index,
    label: granularity === 'monthly' ? entries[index].date.slice(0, 7) : entries[index].date.slice(2),
  }))
}

export function summarizeStageStability(entries: StageEntry[]): StageStabilitySummary {
  const latest = entries.at(-1)
  const latestValues = latest ? SYSTEMS.flatMap(({ key }) => {
    const value = latest[key]
    return value == null ? [] : [value]
  }) : []
  const counts = new Map<number, number>()
  for (const stage of latestValues) counts.set(stage, (counts.get(stage) ?? 0) + 1)
  const dominant = [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0] - right[0])[0] ?? null
  let transitionCount = 0
  for (const { key } of SYSTEMS) {
    for (let index = 1; index < entries.length; index += 1) {
      const previous = entries[index - 1][key]
      const current = entries[index][key]
      if (previous != null && current != null && previous !== current) transitionCount += 1
    }
  }
  return {
    availableAxes: latestValues.length,
    alignedAxes: dominant?.[1] ?? 0,
    dominantStage: dominant?.[0] ?? null,
    transitionCount,
    observationCount: entries.length,
  }
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
  const [weekly13Summary, setWeekly13Summary] = useState<StageStabilitySummary | null>(null)
  const classicScrollRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement | null>(null)
  const [trackWidth, setTrackWidth] = useState(0)
  const [logExpanded, setLogExpanded] = useState(false)

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
        if (granularity === 'weekly' && count === 13) setWeekly13Summary(summarizeStageStability(history))
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

  // 帯の実幅を測り、ラベル段階と目盛り数に使う(未測定の間は 0 = 不明として Stage列 を出す)
  useEffect(() => {
    const track = trackRef.current
    if (view !== 'timeline' || loading || !track) return
    const measure = () => setTrackWidth(track.clientWidth)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(track)
    return () => observer.disconnect()
  }, [view, loading, entries.length])

  const lanes = useMemo(() => SYSTEMS.map((system) => ({ system, runs: buildRuns(entries, system.key) })), [entries])
  const transitions = useMemo(() => buildStageTransitions(entries), [entries])
  const ticks = useMemo(
    () => buildTicks(entries, granularity, pickTickCount(trackWidth)),
    [entries, granularity, trackWidth],
  )
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
    <section className="card p-3" aria-labelledby="stage-timeline-title">
      <header className="mb-2 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h2 id="stage-timeline-title" className="m-0 text-[14px] font-bold text-[var(--color-text-primary)]">ステージ変遷（{selectedGranularity.label}）</h2>
          <p className="m-0 mt-0.5 text-[11px] font-medium leading-4 text-[var(--color-text-tertiary)]">
            {VIEW_CAPTIONS[view]} ・ {selectedGranularity.subtitle}
            {activeStartDate ? ` / 連続データ開始 ${activeStartDate}` : ''}
            {weekly13Summary && (
              <span aria-label="13週のStage構造要約">
                {' ・ '}13週で<b className="mx-0.5 font-mono font-bold text-[var(--color-text-primary)]">{weekly13Summary.transitionCount}回</b>切替(6軸合計・方向性ではなく切替数)
              </span>
            )}
          </p>
          {selectedRange && !loading && entries.length > 0 && !hasVisibleSelection && (
            <div style={rangeOutsideStyle}>
              選択期間 {selectedRange.startDate} → {selectedRange.endDate} は現在の表示範囲外です
            </div>
          )}
        </div>
        <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-wrap sm:justify-end">
          <div className={`${SEGMENT_GROUP} col-span-2 sm:col-span-1`} role="group" aria-label="ステージ変遷の表示形式">
            {HISTORY_VIEWS.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => selectView(item.key)}
                className={`${segmentClass(view === item.key)} min-h-11 px-2.5 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--color-brand-900)] sm:min-h-8`}
                aria-pressed={view === item.key}
                aria-controls="stage-history-body"
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className={SEGMENT_GROUP} role="group" aria-label="ステージの時間軸">
            {GRANULARITIES.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => selectGranularity(item.key)}
                className={`${segmentClass(granularity === item.key)} min-h-11 px-2.5 sm:min-h-8`}
                aria-pressed={granularity === item.key}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className={SEGMENT_GROUP} role="group" aria-label="表示期間">
            {STAGE_TIMELINE_DISPLAY_PRESETS[granularity].map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => setCount(preset)}
                className={`${segmentClass(count === preset)} min-h-11 px-2.5 sm:min-h-8`}
                title={`直近${preset}${granularity === 'daily' ? '営業日' : granularity === 'weekly' ? '週' : 'か月'}を表示`}
                aria-pressed={count === preset}
              >
                {preset}{RUN_UNITS[granularity]}
              </button>
            ))}
          </div>
        </div>
      </header>

      {error && <p className="m-0 mb-2 text-[12px] font-medium text-[var(--price-down)]">エラー: {error}</p>}

      {loading ? (
        <div role="status" aria-label="ステージ変遷を計算中" className="space-y-2">
          {SYSTEMS.map(({ key }) => (
            <div key={key} className="h-6 animate-pulse bg-[var(--color-surface-subtle)]" />
          ))}
          <p className="m-0 text-center text-[11px] font-medium text-[var(--color-text-tertiary)]">計算中...</p>
        </div>
      ) : entries.length === 0 ? (
        <p className="m-0 py-3 text-center text-[12px] font-medium text-[var(--color-text-tertiary)]">データなし</p>
      ) : view === 'classic' ? (
        <div id="stage-history-body" ref={classicScrollRef} style={{ overflowX: 'auto' }}>
          <table style={{ width: 'max-content', minWidth: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
            <caption className="sr-only">系統別ステージの日付別一覧(右端が最新)</caption>
            <thead>
              <tr>
                <th scope="col" style={{ ...stickyTh, textAlign: 'left' }}>系統</th>
                {entries.map((e, index) => (
                  <th key={e.date} scope="col" aria-label={e.date} title={e.date} style={dateHeaderStyle(selectedRange ? isDateWithinRange(e.date, selectedRange) : false, index === entries.length - 1)}>
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
                    const previousStage = index > 0 ? (entries[index - 1][sys.key] as number | null) : null
                    // Stageが切り替わった列の左に細線(summarizeStageStability と同じ規則: 前後ともnullでなく値が異なる)
                    const changed = v != null && previousStage != null && previousStage !== v
                    return (
                      <td key={e.date} style={{ ...cellStyle(inSelectedRange, index === entries.length - 1), ...(changed ? stageChangeCellStyle : {}), ...(systemIndex === 2 || systemIndex === 4 ? timeframeDividerStyle : {}) }}>
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
          <ul className="m-0 mb-2 grid list-none grid-cols-3 gap-x-2 gap-y-1 p-0 sm:gap-x-3 lg:grid-cols-6" aria-label="Stage凡例">
            {STAGE_NUMBERS.map((stage) => (
              <li key={stage} className="flex min-w-0 items-center gap-1.5 text-[11px] font-semibold text-[var(--color-text-secondary)]">
                <StageMark stage={stage} />
                <span className="min-w-0">{STAGE_LABELS[stage]}</span>
              </li>
            ))}
          </ul>
          <div className={`grid grid-cols-1 items-end gap-x-2 pb-1 text-[11px] font-bold text-[var(--color-text-tertiary)] ${LANE_GRID}`}>
            <span className="max-sm:hidden">系統</span>
            <span className="flex flex-wrap items-baseline justify-between gap-x-3">
              <span>連続期間(幅=継続長)</span>
              <span className="font-medium">白線=Stage変更 ・ 右端=現在</span>
            </span>
            <span className="text-right text-[var(--color-brand-900)] max-sm:hidden">現在</span>
          </div>
          <div>
            {lanes.map(({ system, runs }, laneIndex) => {
              const current = runs[runs.length - 1]
              const currentStage = current?.stage ?? null
              const currentTruncated = current?.startIndex === 0
              const currentDuration = current ? `${current.length}${runUnit}${currentTruncated ? '以上' : ''}` : ''
              // 現在のStageがこの表示期間内の切替で始まっている場合だけ、直前のStageを添える(buildStageTransitions の結果をそのまま使う)
              const enteredFrom = current && currentStage
                ? transitions.find((item) => item.system === system.key && item.toStartIndex === current.startIndex)?.from ?? null
                : null
              const runPx = (run: StageRun) => (trackWidth > 0 ? (trackWidth * run.length) / entries.length : 0)
              const needsStrip = runs.some((run) => run.stage != null && classifyRunLabel(runPx(run)) === 'none')
              return (
                <div
                  key={system.key}
                  className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 ${LANE_GRID} ${laneIndex === 0 ? '' : laneIndex % 2 === 0 ? 'mt-3' : 'mt-1'}`}
                  role="group"
                  aria-label={currentStage ? `${system.label} 現在S${currentStage} 連続${currentDuration}${enteredFrom ? ` 直前S${enteredFrom}` : ''}` : `${system.label} 現在データなし`}
                >
                  <span className="col-start-1 row-start-1 text-[11px] font-bold text-[var(--color-text-secondary)]">{system.label}</span>
                  <span className="col-start-2 row-start-1 inline-flex items-center justify-self-end whitespace-nowrap font-mono text-[11px] font-bold text-[var(--color-text-primary)] sm:col-start-3">
                    {currentStage ? (
                      <>
                        <span className="mr-1 font-sans text-[11px] font-bold text-[var(--color-brand-900)] sm:hidden">現在</span>
                        {enteredFrom != null && (
                          <>
                            <StageMark stage={enteredFrom} />
                            <span aria-hidden="true" className="mx-0.5 text-[var(--color-text-tertiary)]">→</span>
                          </>
                        )}
                        <StageMark stage={currentStage} />
                        <span className="ml-1 font-semibold text-[var(--color-text-secondary)]">{currentDuration}</span>
                      </>
                    ) : '—'}
                  </span>
                  <div
                    ref={laneIndex === 0 ? trackRef : undefined}
                    className="relative col-span-2 row-start-2 flex h-6 min-w-0 overflow-hidden bg-[var(--color-surface-subtle)] sm:col-span-1 sm:col-start-2 sm:row-start-1"
                  >
                    {runs.map((run) => {
                      const truncated = run.startIndex === 0
                      const range = `${entries[run.startIndex].date}〜${entries[run.endIndex].date}(${run.length}${runUnit})`
                      const title = run.stage ? `${system.label} S${run.stage}: ${STAGE_LABELS[run.stage]} ${range}` : `${system.label} データなし ${range}`
                      const style: React.CSSProperties = {
                        flex: `${run.length} 1 0`,
                        minWidth: 3,
                        background: run.stage ? STAGE_BORDER_COLORS[run.stage] : 'transparent',
                        boxShadow: truncated ? undefined : 'inset 2px 0 0 #fff',
                      }
                      const tier = run.stage ? classifyRunLabel(runPx(run)) : 'none'
                      const label = !run.stage ? ''
                        : tier === 'full' ? `S${run.stage} · ${run.length}${runUnit}${truncated ? '+' : ''}`
                        : tier === 'stage' ? `S${run.stage}`
                        : tier === 'digit' ? `${run.stage}`
                        : ''
                      const className = 'flex items-center justify-center overflow-hidden whitespace-nowrap p-0 font-mono text-[11px] font-bold text-white'
                      return run.stage && onStageRangeSelect ? (
                        <button
                          key={run.startIndex}
                          type="button"
                          onClick={() => selectStageSegment(system, run.startIndex)}
                          title={title}
                          aria-label={title}
                          style={style}
                          className={`${className} cursor-pointer hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--color-brand-900)]`}
                        >{label}</button>
                      ) : (
                        <span key={run.startIndex} title={title} style={style} className={className}>{label}</span>
                      )
                    })}
                    {selectionSpan && (
                      <span
                        className="pointer-events-none absolute inset-y-0 z-[1] border-x-2 border-[var(--color-brand-900)] bg-[var(--color-brand-900)]/15"
                        aria-hidden="true"
                        style={{
                          left: `${(selectionSpan.first / entries.length) * 100}%`,
                          width: `${((selectionSpan.last - selectionSpan.first + 1) / entries.length) * 100}%`,
                        }}
                      />
                    )}
                    <span className="pointer-events-none absolute inset-y-0 right-0 z-[2] w-0.5 bg-[var(--color-brand-900)]" aria-hidden="true" />
                  </div>
                  {needsStrip && (
                    <div
                      className="col-span-2 row-start-3 flex flex-wrap gap-x-0.5 gap-y-1 sm:col-span-1 sm:col-start-2 sm:row-start-2"
                      role="list"
                      aria-label={`${system.label} Stage列`}
                    >
                      {runs.map((run) => {
                        const truncated = run.startIndex === 0
                        const range = `${entries[run.startIndex].date}〜${entries[run.endIndex].date}(${run.length}${runUnit})`
                        const title = run.stage ? `${system.label} S${run.stage}: ${STAGE_LABELS[run.stage]} ${range}` : `${system.label} データなし ${range}`
                        return (
                          <span key={run.startIndex} role="listitem" className="flex min-w-5 flex-col items-center leading-none">
                            {run.stage ? (
                              <StageMark
                                stage={run.stage}
                                title={title}
                                onSelect={onStageRangeSelect ? () => selectStageSegment(system, run.startIndex) : undefined}
                              />
                            ) : (
                              <span className="flex h-[18px] w-[18px] items-center justify-center font-mono text-[11px] text-[var(--text-muted)]" title={title}>-</span>
                            )}
                            <span className="mt-0.5 font-mono text-[11px] font-semibold text-[var(--color-text-tertiary)]">{run.length}{truncated ? '+' : ''}</span>
                          </span>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
          <div className={`grid grid-cols-1 pt-2 sm:gap-x-2 ${LANE_GRID}`}>
            <span className="max-sm:hidden" />
            <div className="relative h-4">
              {ticks.map((tick, tickIndex) => {
                const position = ((tick.index + 0.5) / entries.length) * 100
                const align = tickIndex === 0 ? '' : tickIndex === ticks.length - 1 ? '-translate-x-full' : '-translate-x-1/2'
                return (
                  <span
                    key={tick.index}
                    className={`absolute top-0 whitespace-nowrap font-mono text-[11px] font-semibold text-[var(--color-text-tertiary)] ${align}`}
                    style={{ left: tickIndex === 0 ? 0 : `${position}%` }}
                  >{tick.label}</span>
                )
              })}
            </div>
            <span className="max-sm:hidden" />
          </div>

          <div className="mt-3 border-t border-[var(--color-border-soft)] pt-2" role="group" aria-labelledby="stage-change-log-title">
            <div className="flex items-center justify-between gap-2">
              <h3 id="stage-change-log-title" className="m-0 text-[12px] font-bold text-[var(--color-text-secondary)]">
                Stage変更ログ
                <span className="ml-1.5 font-mono text-[11px] font-medium text-[var(--color-text-tertiary)]">表示期間内 {transitions.length}件・古い順</span>
              </h3>
              {transitions.length > 5 && (
                <button
                  type="button"
                  onClick={() => setLogExpanded((open) => !open)}
                  aria-expanded={logExpanded}
                  aria-controls="stage-change-log"
                  className={`min-h-11 px-2 text-[11px] font-bold text-[var(--color-brand-700)] focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--color-brand-900)] sm:min-h-7 ${transitions.length > 8 ? '' : 'sm:hidden'}`}
                >
                  {logExpanded ? '最新のみ表示' : `すべて表示 (${transitions.length}件)`}
                </button>
              )}
            </div>
            {transitions.length === 0 ? (
              <p className="m-0 py-1 text-[12px] text-[var(--text-muted)]">表示期間内にStage変更はありません</p>
            ) : (
              <ol id="stage-change-log" className="m-0 grid list-none gap-x-6 p-0 sm:grid-cols-2 xl:grid-cols-3">
                {transitions.map((transition, transitionIndex) => {
                  const system = SYSTEMS.find((item) => item.key === transition.system) ?? SYSTEMS[0]
                  const fromDuration = `${transition.fromLength}${runUnit}${transition.fromTruncated ? '以上' : ''}`
                  const hiddenClass = logExpanded ? '' : transitionIndex < transitions.length - 8 ? 'hidden' : transitionIndex < transitions.length - 5 ? 'max-sm:hidden' : ''
                  const label = `${transition.date} ${system.label} S${transition.from}からS${transition.to} 前の期間${fromDuration}`
                  const content = (
                    <>
                      <span className="w-[64px] shrink-0 whitespace-nowrap font-mono text-[11px] font-semibold text-[var(--color-text-secondary)]">{transition.date.slice(2)}</span>
                      <span className="w-12 shrink-0 whitespace-nowrap text-[11px] font-bold text-[var(--color-text-secondary)]">{system.label}</span>
                      <span className="inline-flex shrink-0 items-center gap-1" aria-hidden="true">
                        <StageMark stage={transition.from} />
                        <span className="text-[11px] text-[var(--color-text-tertiary)]">→</span>
                        <StageMark stage={transition.to} />
                      </span>
                      <span className="font-mono text-[11px] font-semibold text-[var(--color-text-tertiary)]">前 {fromDuration}</span>
                    </>
                  )
                  // 押せる行だけ44pxのタップ領域を確保する。押せない行は内容なりの高さ
                  const rowClass = `flex w-full items-center gap-x-2 border-b border-[var(--color-border-soft)] bg-transparent px-0 text-left ${onStageRangeSelect ? 'min-h-11 sm:min-h-7' : 'min-h-8 sm:min-h-7'}`
                  return (
                    <li key={`${transition.system}-${transition.toStartIndex}`} className={hiddenClass}>
                      {onStageRangeSelect ? (
                        <button
                          type="button"
                          onClick={() => selectStageSegment(system, transition.toStartIndex)}
                          aria-label={label}
                          title={label}
                          className={`${rowClass} cursor-pointer hover:bg-[var(--color-surface-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--color-brand-900)]`}
                        >{content}</button>
                      ) : (
                        <div className={rowClass} title={label}>{content}</div>
                      )}
                    </li>
                  )
                })}
              </ol>
            )}
          </div>
        </div>
      )}
    </section>
  )
}

// Timeline用の小さなStage識別チップ(色+数字)。18pxで凡例・列・ログ・現在表示に共通
function StageMark({ stage, title, onSelect }: { stage: number; title?: string; onSelect?: () => void }) {
  const style: React.CSSProperties = { ...stageButtonStyle(stage, Boolean(onSelect)), width: '18px', height: '18px', flexShrink: 0 }
  if (onSelect) {
    return (
      <button
        type="button"
        onClick={onSelect}
        title={title}
        aria-label={title}
        style={style}
        className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-brand-900)]"
      >{stage}</button>
    )
  }
  return <span title={title} style={style}>{stage}</span>
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
    fontSize: '11px',
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
  color: 'var(--color-brand-900)',
  fontSize: '11px',
  fontFamily: 'var(--font-mono)',
}

// 選択・現在はネイビー(アンバーはS2のStage色と衝突するため使わない)
const SELECTED_TINT = 'color-mix(in srgb, var(--color-brand-900) 12%, transparent)'

const th: React.CSSProperties = {
  padding: '4px 6px',
  fontFamily: 'var(--font-mono)',
  color: 'var(--text-muted)',
  fontSize: '11px',
  textAlign: 'center',
  fontWeight: 500,
  whiteSpace: 'nowrap',
}

function dateHeaderStyle(active: boolean, current: boolean): React.CSSProperties {
  return {
    ...th,
    background: active ? SELECTED_TINT : current ? 'var(--bg-elevated)' : undefined,
    color: active || current ? 'var(--color-brand-900)' : th.color,
    fontWeight: current ? 800 : th.fontWeight,
    borderBottom: current ? '2px solid var(--color-brand-900)' : undefined,
  }
}

const stickyTh: React.CSSProperties = {
  padding: '4px 8px',
  fontSize: '11px',
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
    background: active ? SELECTED_TINT : current ? 'var(--bg-elevated)' : undefined,
    boxShadow: active ? 'inset 0 2px 0 var(--color-brand-900), inset 0 -2px 0 var(--color-brand-900)' : undefined,
  }
}

const stageChangeCellStyle: React.CSSProperties = {
  borderLeft: '2px solid var(--color-border-strong)',
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

// 3つのセグメント(表示形式・時間軸・期間)は同じ書体・サイズ。選択中はネイビー
const SEGMENT_GROUP = 'flex overflow-hidden border border-[var(--color-border-default)] bg-white sm:inline-flex'

function segmentClass(active: boolean): string {
  return `flex-1 cursor-pointer whitespace-nowrap border-0 text-[12px] font-bold sm:flex-none ${
    active
      ? 'bg-[var(--color-brand-900)] text-white'
      : 'bg-white text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-subtle)]'
  }`
}
