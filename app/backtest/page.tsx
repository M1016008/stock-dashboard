'use client'

import { Fragment, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  Activity,
  BarChart3,
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  DatabaseZap,
  Filter,
  LineChart,
  Search,
  Sigma,
  Target,
} from 'lucide-react'
import { IndustryBadges } from '@/components/ui/IndustryBadges'
import { MarginBadges } from '@/components/ui/MarginBadges'
import { StageDots } from '@/components/ui/StageDots'
import { BacktestHighlightChart, type HighlightChartPoint } from '@/components/charts/BacktestHighlightChart'

type DateOption = {
  date: string
  total_tickers: number
  signal_tickers: number
}

type BacktestResult = {
  date: string
  ticker: string
  name: string | null
  sector_large: string | null
  sector_small: string | null
  sector17_name: string | null
  sector33_name: string | null
  market_segment: string | null
  margin_type: string | null
  pattern_code: string | null
  daily_a_stage: number | null
  daily_b_stage: number | null
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
  open: number | null
  high: number | null
  low: number | null
  close: number | null
  volume: number | null
  volume_ratio_20: number | null
  range_pct: number | null
  atr20_pct: number | null
  ma5_pos_pct: number | null
  ma25_pos_pct: number | null
  ma75_pos_pct: number | null
  signal_codes: string[]
  horizon_days: number | null
  return_pct: number | null
  max_return_pct: number | null
  max_return_date: string | null
  days_to_max: number | null
  min_return_pct: number | null
  min_return_date: string | null
  days_to_min: number | null
  hit_10: number | null
  hit_20: number | null
  hit_40: number | null
}

type QueryResponse = {
  date: string | null
  horizon: number
  results: BacktestResult[]
  summary: {
    count: number
    withOutcome: number
    hit10Rate: number | null
    hit20Rate: number | null
    hit40Rate: number | null
    avgMaxReturnPct: number | null
    avgMinReturnPct: number | null
    avgDaysToMax: number | null
  }
  notice?: string
}

type LatestSignal = {
  ticker: string
  rank: number
  score: number
  signalCodes: string[]
  summary: {
    name?: string
    sectorLarge?: string
    close?: number
    volumeRatio20?: number
    patternCode?: string
  }
}

type SignalStat = {
  signalCode: string
  patternCode: string
  horizonDays: number
  payload: {
    count?: number
    hit_10_rate?: number | null
    hit_20_rate?: number | null
    hit_40_rate?: number | null
    max_return_p50?: number | null
    days_to_max_p50?: number | null
  }
}

type MlCandidate = {
  asOfDate: string
  direction: 'up' | 'down'
  ticker: string
  name: string | null
  sectorLarge: string | null
  rank: number
  close: number | null
  confidenceLabel: string
  stageCode: string | null
  maOrder: string | null
  reason: {
    stage?: string
    maAngle?: string
    maDistance?: string
    pricePosition?: string
    mlEvidence?: string
  }
  explanation?: {
    summary?: string
    watchPoints?: string[]
    riskNotes?: string[]
  }
}

type CurrentSimilarInsight = {
  asOfDate: string
  baseTicker: string
  rank: number
  similarTicker: string
  similarityScore: number
  baseDirection: 'up' | 'down' | null
  similarDirection: 'up' | 'down' | null
  payload: {
    base?: {
      name?: string | null
      stageCode?: string | null
      maOrder?: string | null
    }
    similar?: {
      name?: string | null
      stageCode?: string | null
      maOrder?: string | null
    }
  }
  reason: Record<string, string>
}

type MlSectorRanking = {
  asOfDate: string
  sectorType: '17' | '33'
  sectorName: string
  direction: 'up' | 'down'
  candidateCount: number
  avgScore: number | null
  representativeTickers: Array<{ ticker: string; rank?: number; score?: number }>
}

type MlPerformance = {
  asOfDate: string
  direction: 'up' | 'down'
  horizonDays: number
  sectorType: string
  sectorName: string
  sampleCount: number
  upRate: number | null
  downRate: number | null
  medianReturnPct: number | null
  avgReturnPct: number | null
  payload?: {
    mode?: string
    modelName?: string | null
    precisionAt20?: number | null
    precisionAt50?: number | null
    precisionAt80?: number | null
    hitRate?: number | null
    maxDrawdownPct?: number | null
    metrics?: {
      accuracy?: number
      positiveRate?: number
    }
  }
}

type MlModelStatus = {
  latestFeatureDate: string | null
  latestPredictionDate: string | null
  latestEvaluationDate: string | null
  models: Array<{
    modelName: string
    modelType: string
    direction: 'up' | 'down'
    horizonDays: number
    trainedAt: number | string | null
    metrics: {
      trainStartDate?: string
      trainEndDate?: string
      samples?: number
      accuracy?: number
      positiveRate?: number
    }
  }>
}

type BacktestDetail = {
  source: string
  move: 'up' | 'down'
  basis: {
    date: string
    close: number | null
    volume: number | null
    volumeRatio20: number | null
    patternCode: string | null
    signalCodes: string[]
  } | null
  outcome: {
    horizonDays: number
    returnPct: number | null
    maxReturnPct: number | null
    maxReturnDate: string | null
    daysToMax: number | null
    minReturnPct: number | null
    minReturnDate: string | null
    daysToMin: number | null
    upStagePath: Array<{ date: string; code: string }>
    downStagePath: Array<{ date: string; code: string }>
  } | null
  evidence: Array<{
    signalCode: string
    label?: string | null
    reason?: string
    basis?: Record<string, unknown>
  }>
  movePeriod: {
    direction: 'up' | 'down'
    startDate: string
    endDate: string | null
    startPrice: number | null
    endPrice: number | null
    returnPct: number | null
    tradingDays: number | null
  } | null
  chartSeries: HighlightChartPoint[]
  selectedStagePath: Array<{ date: string; code: string }>
  volumeSummary: {
    preAverage: number | null
    startVolume: number | null
    endVolume: number | null
    periodAverage: number | null
    maxVolume: number | null
    maxVolumeDate: string | null
    firstPhaseRatio: number | null
    periodRatio: number | null
    comment: string
  } | null
  maAnalysis: {
    maOrder: string
    sma5CrossUpDate: string | null
    daysHeldAboveSma5: number | null
    recentHighDate: string | null
    recentHigh: number | null
    distanceToRecentHighPct: number | null
    facts: string[]
  } | null
  similarPatternStats: {
    sampleSize: number
    upRate: number | null
    downRate: number | null
    avgMaxReturnPct: number | null
    avgMinReturnPct: number | null
    cases: Array<{
      ticker: string
      date: string
      patternCode: string | null
      maxReturnPct: number | null
      minReturnPct: number | null
      daysToMax: number | null
    }>
  } | null
  maCandidateAnalysis: {
    asOfDate: string | null
    up: MlCandidate[]
    down: MlCandidate[]
    comment: string
  } | null
  analysisComment: {
    source: 'openai' | 'template'
    summary: string
    evidence: string[]
    watchPoints: string[]
    riskNotes: string[]
    candidateComment: string
    similarPatternComment: string
  } | null
}

type CoverageInfo = {
  horizon: number
  market: { startDate: string | null; endDate: string | null; days: number }
  indices: { startDate: string | null; endDate: string | null; days: number }
  feature: { startDate: string | null; endDate: string | null; days: number }
  backtest: { startDate: string | null; endDate: string | null; days: number; label: string }
  excluded: { days: number; reasons: string[] }
}

const HORIZONS = [5, 20, 30, 40, 60, 90, 180]
const EMPTY_RESULTS: BacktestResult[] = []

const SIGNAL_OPTIONS = [
  { code: 'pullback_candidate', label: '押し目候補' },
  { code: 'pre_breakout', label: 'ブレイク直前' },
  { code: 'volatility_squeeze', label: 'ボラ収縮' },
  { code: 'stage_improvement_setup', label: '好転予兆' },
  { code: 'higher_timeframe_alignment', label: '上位足一致' },
  { code: 'high_breakout_continuation', label: '高値継続' },
  { code: 'ma_cross_up_daily_25', label: '日25MA上抜け' },
  { code: 'ma_upper_touch_daily_25', label: '日25MA上タッチ' },
  { code: 'ma_cross_up_weekly_13', label: '週13MA上抜け' },
  { code: 'ma_upper_touch_weekly_13', label: '週13MA上タッチ' },
]

const RETURN_PRESETS = [
  { key: 'all', label: '全て', metric: 'max', min: null, max: null, target: null },
  { key: 'up10', label: '+10%以上', metric: 'max', min: 10, max: null, target: 10 },
  { key: 'up20', label: '+20%以上', metric: 'max', min: 20, max: null, target: 20 },
  { key: 'up40', label: '+40%以上', metric: 'max', min: 40, max: null, target: 40 },
  { key: 'down5', label: '期間 -5%未満', metric: 'period', min: null, max: -5, target: null },
  { key: 'down5to8', label: '期間 -5%〜-8%', metric: 'period', min: -8, max: -5, target: null },
] as const

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土']

type CalendarCell = {
  key: string
  day: number | null
  date: string | null
  option: DateOption | null
}

function fmtPct(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`
}

function fmtNum(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return Math.round(value).toLocaleString('ja-JP')
}

function monthKey(date: string): string {
  return date.slice(0, 7)
}

function monthLabel(month: string): string {
  const [year, rawMonth] = month.split('-')
  return `${year}年${Number(rawMonth)}月`
}

function shiftMonth(month: string, delta: number): string {
  const [year, rawMonth] = month.split('-').map(Number)
  const date = new Date(year, rawMonth - 1 + delta, 1)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

function buildCalendarCells(month: string, dateMap: Map<string, DateOption>): CalendarCell[] {
  const [year, rawMonth] = month.split('-').map(Number)
  const firstDay = new Date(year, rawMonth - 1, 1).getDay()
  const daysInMonth = new Date(year, rawMonth, 0).getDate()
  const cells: CalendarCell[] = []

  for (let i = 0; i < firstDay; i += 1) {
    cells.push({ key: `blank-${i}`, day: null, date: null, option: null })
  }
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = `${month}-${String(day).padStart(2, '0')}`
    cells.push({ key: date, day, date, option: dateMap.get(date) ?? null })
  }
  while (cells.length % 7 !== 0) {
    cells.push({ key: `blank-tail-${cells.length}`, day: null, date: null, option: null })
  }
  return cells
}

function compactSignal(code: string): string {
  const labels: Record<string, string> = {
    pullback_candidate: '押し目',
    pre_breakout: '直前',
    volatility_squeeze: '収縮',
    stage_improvement_setup: '好転',
    higher_timeframe_alignment: '上位一致',
    high_breakout_continuation: '高値継続',
  }
  if (labels[code]) return labels[code]
  if (code.includes('ma_cross_up')) return 'MA上抜け'
  if (code.includes('ma_upper_touch')) return 'MA上タッチ'
  if (code.includes('ma_cross_down')) return 'MA下割れ'
  if (code.includes('ma_lower_touch')) return 'MA下タッチ'
  if (code.includes('ma_touch')) return 'MA接触'
  return code
}

function stagePathText(path: Array<{ date: string; code: string }>): string {
  if (path.length === 0) return '-'
  return path.map((item) => item.code).join(' → ')
}

export default function BacktestPage() {
  const [dates, setDates] = useState<DateOption[]>([])
  const [selectedDate, setSelectedDate] = useState('')
  const [calendarMonth, setCalendarMonth] = useState('')
  const [horizon, setHorizon] = useState(40)
  const [preset, setPreset] = useState<typeof RETURN_PRESETS[number]['key']>('all')
  const [selectedSector17, setSelectedSector17] = useState('')
  const [selectedSector33, setSelectedSector33] = useState('')
  const [selectedSignals, setSelectedSignals] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState<QueryResponse | null>(null)
  const [latestSignals, setLatestSignals] = useState<LatestSignal[]>([])
  const [signalStats, setSignalStats] = useState<SignalStat[]>([])
  const [candidateMode, setCandidateMode] = useState<'both' | 'up' | 'down'>('both')
  const [mlCandidates, setMlCandidates] = useState<MlCandidate[]>([])
  const [mlCandidateNotice, setMlCandidateNotice] = useState('')
  const [currentSimilars, setCurrentSimilars] = useState<CurrentSimilarInsight[]>([])
  const [mlSectorRankings, setMlSectorRankings] = useState<MlSectorRanking[]>([])
  const [mlPerformance, setMlPerformance] = useState<MlPerformance[]>([])
  const [mlModelStatus, setMlModelStatus] = useState<MlModelStatus | null>(null)
  const [expandedKey, setExpandedKey] = useState('')
  const [details, setDetails] = useState<Record<string, BacktestDetail>>({})
  const [coverage, setCoverage] = useState<CoverageInfo | null>(null)
  const [detailLoading, setDetailLoading] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    fetch(`/api/backtest/dates?horizon=${horizon}`, { cache: 'no-store' })
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return
        const nextDates: DateOption[] = data.dates ?? []
        setDates(nextDates)
        const firstDate = nextDates[0]?.date || ''
        setSelectedDate((current) => nextDates.some((item) => item.date === current) ? current : firstDate)
        setCalendarMonth((current) => {
          if (current && nextDates.some((item) => monthKey(item.date) === current)) return current
          return firstDate ? monthKey(firstDate) : ''
        })
      })
      .catch((err) => setError((err as Error).message))
    return () => { cancelled = true }
  }, [horizon])

  useEffect(() => {
    let cancelled = false
    fetch(`/api/backtest/coverage?horizon=${horizon}`, { cache: 'no-store' })
      .then((res) => res.json())
      .then((data) => {
        if (cancelled || data.error) return
        setCoverage(data)
      })
      .catch(() => { if (!cancelled) setCoverage(null) })
    return () => { cancelled = true }
  }, [horizon])

  useEffect(() => {
    if (!selectedDate) return
    let cancelled = false
    setLoading(true)
    setError('')

    const activePreset = RETURN_PRESETS.find((item) => item.key === preset) ?? RETURN_PRESETS[0]
    const params = new URLSearchParams({
      date: selectedDate,
      horizon: String(horizon),
      limit: '350',
      sort: 'maxReturn',
      returnMetric: activePreset.metric,
    })
    if (activePreset.min != null) params.set('returnMin', String(activePreset.min))
    if (activePreset.max != null) params.set('returnMax', String(activePreset.max))
    if (activePreset.target != null) params.set('targetPct', String(activePreset.target))
    if (selectedSector17) params.set('sector17', selectedSector17)
    if (selectedSector33) params.set('sector33', selectedSector33)
    if (selectedSignals.size > 0) params.set('signals', Array.from(selectedSignals).join(','))

    fetch(`/api/backtest/query?${params}`, { cache: 'no-store' })
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return
        if (data.error) throw new Error(data.message ?? data.error)
        setQuery(data)
      })
      .catch((err) => { if (!cancelled) setError((err as Error).message) })
      .finally(() => { if (!cancelled) setLoading(false) })

    fetch(`/api/backtest/signals?date=${selectedDate}&limit=40`, { cache: 'no-store' })
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return
        setLatestSignals(data.latest ?? [])
        setSignalStats(data.stats ?? [])
      })
      .catch(() => { /* query result is primary */ })

    return () => { cancelled = true }
  }, [selectedDate, horizon, preset, selectedSignals, selectedSector17, selectedSector33])

  const summary = query?.summary
  const rows = query?.results ?? EMPTY_RESULTS
  const activePreset = RETURN_PRESETS.find((item) => item.key === preset) ?? RETURN_PRESETS[0]
  const dateMap = useMemo(() => new Map(dates.map((item) => [item.date, item])), [dates])
  const availableMonths = useMemo(() => {
    const months = new Set(dates.map((item) => monthKey(item.date)))
    return Array.from(months).sort((a, b) => b.localeCompare(a))
  }, [dates])
  const calendarCells = useMemo(
    () => calendarMonth ? buildCalendarCells(calendarMonth, dateMap) : [],
    [calendarMonth, dateMap],
  )
  const selectedDateInfo = selectedDate ? dateMap.get(selectedDate) : undefined
  const monthIndex = availableMonths.indexOf(calendarMonth)
  const newerMonth = monthIndex > 0 ? availableMonths[monthIndex - 1] : ''
  const olderMonth = monthIndex >= 0 && monthIndex < availableMonths.length - 1 ? availableMonths[monthIndex + 1] : ''

  const sectorCounts = useMemo(() => {
    const map = new Map<string, number>()
    for (const row of rows) {
      const key = row.sector17_name ?? row.sector_large ?? 'その他'
      map.set(key, (map.get(key) ?? 0) + 1)
    }
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8)
  }, [rows])
  const sector17Options = useMemo(() => {
    const map = new Map<string, number>()
    for (const row of rows) {
      const key = row.sector17_name
      if (key) map.set(key, (map.get(key) ?? 0) + 1)
    }
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1])
  }, [rows])
  const sector33Options = useMemo(() => {
    const map = new Map<string, number>()
    for (const row of rows) {
      if (selectedSector17 && row.sector17_name !== selectedSector17) continue
      const key = row.sector33_name
      if (key) map.set(key, (map.get(key) ?? 0) + 1)
    }
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1])
  }, [rows, selectedSector17])

  useEffect(() => {
    let cancelled = false
    fetch(`/api/backtest/ml-candidates?direction=${candidateMode}&limit=10`, { cache: 'no-store' })
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return
        setMlCandidates(Array.isArray(data.candidates) ? data.candidates : [])
        setMlCandidateNotice(typeof data.notice === 'string' ? data.notice : '')
      })
      .catch(() => {
        if (!cancelled) {
          setMlCandidates([])
          setMlCandidateNotice('ML候補データを取得できませんでした。')
        }
      })
    return () => { cancelled = true }
  }, [candidateMode])

  useEffect(() => {
    let cancelled = false
    Promise.all([
      fetch('/api/ml/current-similars?limit=12', { cache: 'no-store' }).then((res) => res.json()),
      fetch(`/api/ml/sector-rankings?direction=${candidateMode}&limit=12`, { cache: 'no-store' }).then((res) => res.json()),
      fetch(`/api/ml/performance?direction=${candidateMode}&sectorType=all&limit=12`, { cache: 'no-store' }).then((res) => res.json()),
      fetch('/api/ml/model-status', { cache: 'no-store' }).then((res) => res.json()),
    ])
      .then(([similarData, sectorData, performanceData, statusData]) => {
        if (cancelled) return
        setCurrentSimilars(Array.isArray(similarData.similars) ? similarData.similars : [])
        setMlSectorRankings(Array.isArray(sectorData.rankings) ? sectorData.rankings : [])
        setMlPerformance(Array.isArray(performanceData.performance) ? performanceData.performance : [])
        setMlModelStatus(statusData && !statusData.error ? statusData : null)
      })
      .catch(() => {
        if (!cancelled) {
          setCurrentSimilars([])
          setMlSectorRankings([])
          setMlPerformance([])
          setMlModelStatus(null)
        }
      })
    return () => { cancelled = true }
  }, [candidateMode])

  function toggleSignal(code: string) {
    setSelectedSignals((prev) => {
      const next = new Set(prev)
      if (next.has(code)) next.delete(code)
      else next.add(code)
      return next
    })
  }

  function chooseDate(date: string) {
    setSelectedDate(date)
    setCalendarMonth(monthKey(date))
  }

  function detailKey(row: BacktestResult): string {
    return `${row.ticker}-${row.date}-${row.horizon_days ?? horizon}`
  }

  function toggleDetail(row: BacktestResult) {
    const key = detailKey(row)
    setExpandedKey((current) => current === key ? '' : key)
    if (details[key]) return
    setDetailLoading(key)
    const params = new URLSearchParams({
      ticker: row.ticker,
      date: row.date,
      horizon: String(row.horizon_days ?? horizon),
      move: activePreset.key.startsWith('down') ? 'down' : 'up',
    })
    fetch(`/api/backtest/detail?${params}`, { cache: 'no-store' })
      .then((res) => res.json())
      .then((data) => {
        if (data.error) throw new Error(data.message ?? data.error)
        setDetails((current) => ({ ...current, [key]: data }))
      })
      .catch((err) => setError((err as Error).message))
      .finally(() => setDetailLoading((current) => current === key ? '' : current))
  }

  function candidatesFor(detail: BacktestDetail): MlCandidate[] {
    const up = detail.maCandidateAnalysis?.up ?? []
    const down = detail.maCandidateAnalysis?.down ?? []
    if (candidateMode === 'up') return up
    if (candidateMode === 'down') return down
    return [...up.slice(0, 4), ...down.slice(0, 4)]
  }

  return (
    <div className="sb-page">
      <div className="sb-page-title">
        <h1>過去検証・シグナル分析</h1>
        <p>6桁ステージと移動平均線の形から、過去検証と現在の候補銘柄をつなげて確認します。</p>
      </div>

      <div className="backtest-shell">
        <section className="backtest-toolbar calendar-mode">
          <div className="bt-calendar-card">
            <div className="bt-calendar-head">
              <div>
                <CalendarDays size={16} />
                <span>検証日カレンダー</span>
                <strong>{selectedDate || '-'}</strong>
              </div>
              <div className="bt-calendar-actions">
                <button type="button" disabled={!olderMonth} onClick={() => setCalendarMonth(olderMonth)} aria-label="前月">
                  <ChevronLeft size={15} />
                </button>
                <select value={calendarMonth} onChange={(e) => setCalendarMonth(e.target.value)} aria-label="月を選択">
                  {availableMonths.map((month) => (
                    <option key={month} value={month}>{monthLabel(month)}</option>
                  ))}
                </select>
                <button type="button" disabled={!newerMonth} onClick={() => setCalendarMonth(newerMonth)} aria-label="次月">
                  <ChevronRight size={15} />
                </button>
              </div>
            </div>
            <div className="bt-weekdays">
              {WEEKDAYS.map((day) => <span key={day}>{day}</span>)}
            </div>
            <div className="bt-calendar-grid">
              {calendarCells.map((cell) => {
                if (!cell.date || !cell.day) return <div key={cell.key} className="bt-day empty" />
                const date = cell.date
                const active = selectedDate === date
                return (
                  <button
                    key={cell.key}
                    type="button"
                    className="bt-day"
                    data-active={active}
                    data-available={Boolean(cell.option)}
                    disabled={!cell.option}
                    title={cell.option ? `${date} / ${cell.option.total_tickers.toLocaleString('ja-JP')}銘柄` : date}
                    onClick={() => chooseDate(date)}
                  >
                    <span>{cell.day}</span>
                    {cell.option && <small>{Math.round(cell.option.total_tickers / 100) / 10}k</small>}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="bt-filter-stack">
            <div className="bt-control">
              <Target size={15} />
              <span>期間</span>
              <select value={horizon} onChange={(e) => setHorizon(Number(e.target.value))}>
                {HORIZONS.map((value) => (
                  <option key={value} value={value}>{value}営業日</option>
                ))}
              </select>
            </div>

            <div className="bt-control wide">
              <Filter size={15} />
              <span>条件</span>
              <select value={preset} onChange={(e) => setPreset(e.target.value as typeof preset)}>
                {RETURN_PRESETS.map((item) => (
                  <option key={item.key} value={item.key}>{item.label}</option>
                ))}
              </select>
            </div>

            <div className="bt-date-meta">
              <span>検証可能日数</span>
              <strong>{(coverage?.backtest.days ?? dates.length).toLocaleString('ja-JP')}日</strong>
              <p>
                選択日: {selectedDateInfo ? `${selectedDateInfo.total_tickers.toLocaleString('ja-JP')}銘柄 / シグナル${selectedDateInfo.signal_tickers.toLocaleString('ja-JP')}件` : '-'}
              </p>
              {coverage && (
                <p>
                  DB内市場期間: {coverage.market.startDate ?? '-'}〜{coverage.market.endDate ?? '-'} / 市場日数 {coverage.market.days.toLocaleString('ja-JP')}日
                </p>
              )}
            </div>
          </div>
        </section>

        <section className="bt-signal-strip" aria-label="J-Quants業種フィルタ">
          <span className="bt-chip ghost">J-Quants業種</span>
          <select
            className="bt-inline-select"
            value={selectedSector17}
            onChange={(e) => {
              setSelectedSector17(e.target.value)
              setSelectedSector33('')
            }}
            aria-label="17業種分類で絞り込み"
          >
            <option value="">17業種すべて</option>
            {sector17Options.map(([sector, count]) => (
              <option key={sector} value={sector}>{sector}（{count}）</option>
            ))}
          </select>
          <select
            className="bt-inline-select"
            value={selectedSector33}
            onChange={(e) => setSelectedSector33(e.target.value)}
            aria-label="33業種分類で絞り込み"
          >
            <option value="">33業種すべて</option>
            {sector33Options.map(([sector, count]) => (
              <option key={sector} value={sector}>{sector}（{count}）</option>
            ))}
          </select>
          {(selectedSector17 || selectedSector33) && (
            <button
              className="bt-chip ghost"
              type="button"
              onClick={() => { setSelectedSector17(''); setSelectedSector33('') }}
            >
              業種クリア
            </button>
          )}
        </section>

        <section className="bt-signal-strip">
          {SIGNAL_OPTIONS.map((item) => {
            const active = selectedSignals.has(item.code)
            return (
              <button
                key={item.code}
                type="button"
                className="bt-chip"
                data-active={active}
                onClick={() => toggleSignal(item.code)}
              >
                {item.label}
              </button>
            )
          })}
          {selectedSignals.size > 0 && (
            <button className="bt-chip ghost" type="button" onClick={() => setSelectedSignals(new Set())}>
              クリア
            </button>
          )}
        </section>

        {error && <div className="bt-alert">エラー: {error}</div>}
        {query?.notice && <div className="bt-alert">{query.notice}</div>}

        <section className="bt-summary-grid">
          <MetricCard icon={Search} label="抽出銘柄" value={summary?.count?.toLocaleString('ja-JP') ?? '-'} sub={activePreset.label} />
          <MetricCard icon={Target} label="40%到達率" value={fmtPct(summary?.hit40Rate == null ? null : summary.hit40Rate * 100)} sub={`${horizon}営業日内`} tone="red" />
          <MetricCard icon={LineChart} label="平均最大上昇" value={fmtPct(summary?.avgMaxReturnPct)} sub={`平均到達 ${summary?.avgDaysToMax?.toFixed(1) ?? '-'}日`} tone="red" />
          <MetricCard icon={Activity} label="平均最大下落" value={fmtPct(summary?.avgMinReturnPct)} sub="リスク確認" tone="blue" />
        </section>

        <div className="bt-main-grid">
          <section className="sb-card">
            <div className="bt-card-head">
              <div>
                <h2>検証結果</h2>
                <p>{selectedDate || '-'} 時点から {horizon} 営業日内の到達率分析</p>
              </div>
              {loading && <span className="bt-loading">更新中</span>}
            </div>
            <div className="bt-table-wrap">
              <table className="sb-tbl bt-table">
                <thead>
                  <tr>
                    <th style={{ width: 86 }}>コード</th>
                    <th style={{ width: 190 }}>銘柄</th>
                    <th style={{ width: 126 }}>ステージ</th>
                    <th style={{ width: 170 }}>シグナル</th>
                    <th className="right" style={{ width: 100 }}>基準日終値</th>
                    <th className="right" style={{ width: 108 }}>基準日出来高</th>
                    <th className="right" style={{ width: 82 }}>出来高倍率</th>
                    <th className="right" style={{ width: 82 }}>MA25乖離</th>
                    <th className="right" style={{ width: 92 }}>最大上昇</th>
                    <th className="right" style={{ width: 84 }}>到達日数</th>
                    <th className="right" style={{ width: 92 }}>期間騰落</th>
                    <th className="right" style={{ width: 92 }}>最大下落</th>
                    <th style={{ width: 70 }}>根拠</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={13} style={{ textAlign: 'center', padding: '28px', color: 'var(--color-text-tertiary)' }}>
                        該当する検証結果がありません
                      </td>
                    </tr>
                  )}
                  {rows.map((row) => {
                    const key = detailKey(row)
                    const detail = details[key]
                    const expanded = expandedKey === key
                    const detailCandidates = detail ? candidatesFor(detail) : []
                    return (
                      <Fragment key={key}>
                        <tr>
                          <td>
                            <Link href={`/stock/${row.ticker}`} className="bt-code">{row.ticker}</Link>
                          </td>
                          <td>
                            <div className="bt-name">{row.name ?? row.ticker}</div>
                            <div className="bt-sub">
                              <MarginBadges marginType={row.margin_type} compact />
                              <IndustryBadges
                                sector17={row.sector17_name ?? row.sector_large}
                                sector33={row.sector33_name ?? row.sector_small}
                                marketSegment={row.market_segment}
                                compact
                              />
                            </div>
                          </td>
                          <td>
                            <StageDots
                              size={18}
                              values={[
                                row.daily_a_stage,
                                row.daily_b_stage,
                                row.weekly_a_stage,
                                row.weekly_b_stage,
                                row.monthly_a_stage,
                                row.monthly_b_stage,
                              ]}
                            />
                          </td>
                          <td>
                            <div className="bt-tags">
                              {row.signal_codes.slice(0, 3).map((code) => (
                                <span key={code}>{compactSignal(code)}</span>
                              ))}
                              {row.signal_codes.length > 3 && <span>+{row.signal_codes.length - 3}</span>}
                            </div>
                          </td>
                          <td className="right">{fmtNum(row.close)}</td>
                          <td className="right">{fmtNum(row.volume)}</td>
                          <td className="right">{row.volume_ratio_20 == null ? '-' : `${row.volume_ratio_20.toFixed(2)}x`}</td>
                          <td className="right">{fmtPct(row.ma25_pos_pct)}</td>
                          <td className="right price-up">{fmtPct(row.max_return_pct)}</td>
                          <td className="right">{row.days_to_max ?? '-'}</td>
                          <td className={`right ${(row.return_pct ?? 0) >= 0 ? 'price-up' : 'price-down'}`}>{fmtPct(row.return_pct)}</td>
                          <td className="right price-down">{fmtPct(row.min_return_pct)}</td>
                          <td>
                            <button
                              type="button"
                              className="bt-detail-btn"
                              data-open={expanded}
                              onClick={() => toggleDetail(row)}
                            >
                              <ChevronDown size={14} />
                              {detailLoading === key ? '読込' : '詳細'}
                            </button>
                          </td>
                        </tr>
                        {expanded && (
                          <tr className="bt-detail-row">
                            <td colSpan={13}>
                              {!detail && <div className="bt-detail-box">根拠データを読み込んでいます。</div>}
                              {detail && (
                                <div className="bt-detail-box">
                                  <div className="bt-detail-topline">
                                    <strong>
                                      {detail.movePeriod?.startDate ?? row.date}から{detail.movePeriod?.endDate ?? '-'}までに、
                                      株価が{fmtPct(detail.movePeriod?.returnPct)}動きました。
                                    </strong>
                                    <span>{detail.outcome?.horizonDays ?? horizon}営業日内 / {detail.move === 'down' ? '下落局面' : '上昇局面'}を表示</span>
                                  </div>

                                  <div className="bt-detail-grid rich">
                                    <div>
                                      <h3>対象期間</h3>
                                      <dl>
                                        <div><dt>開始日</dt><dd>{detail.movePeriod?.startDate ?? row.date}</dd></div>
                                        <div><dt>終了日</dt><dd>{detail.movePeriod?.endDate ?? '-'}</dd></div>
                                        <div><dt>開始価格</dt><dd>{fmtNum(detail.movePeriod?.startPrice)}円</dd></div>
                                        <div><dt>終了価格</dt><dd>{fmtNum(detail.movePeriod?.endPrice)}円</dd></div>
                                        <div><dt>株価変動</dt><dd className={detail.move === 'down' ? 'price-down' : 'price-up'}>{fmtPct(detail.movePeriod?.returnPct)}</dd></div>
                                        <div><dt>営業日数</dt><dd>{detail.movePeriod?.tradingDays ?? '-'}日</dd></div>
                                      </dl>
                                    </div>
                                    <div>
                                      <h3>MA構造とステージ</h3>
                                      <dl>
                                        <div><dt>MA並び</dt><dd>{detail.maAnalysis?.maOrder ?? '-'}</dd></div>
                                        <div><dt>5日MA維持</dt><dd>{detail.maAnalysis?.daysHeldAboveSma5 ?? '-'}営業日</dd></div>
                                        <div><dt>直近高値距離</dt><dd>{fmtPct(detail.maAnalysis?.distanceToRecentHighPct)}</dd></div>
                                        <div><dt>6桁ステージ</dt><dd>{stagePathText(detail.selectedStagePath ?? [])}</dd></div>
                                      </dl>
                                    </div>
                                  </div>

                                  <BacktestHighlightChart
                                    series={detail.chartSeries ?? []}
                                    highlightStart={detail.movePeriod?.startDate ?? row.date}
                                    highlightEnd={detail.movePeriod?.endDate ?? null}
                                    direction={detail.move}
                                    stagePath={detail.selectedStagePath}
                                    startPrice={detail.movePeriod?.startPrice}
                                    endPrice={detail.movePeriod?.endPrice}
                                    returnPct={detail.movePeriod?.returnPct}
                                  />

                                  {detail.analysisComment && (
                                    <div className="bt-insight-grid">
                                      <div className="bt-insight-main">
                                        <h3>この値動きから読めること</h3>
                                        <p>{detail.analysisComment.summary}</p>
                                        <ul>
                                          {detail.analysisComment.evidence.map((item) => <li key={item}>{item}</li>)}
                                        </ul>
                                      </div>
                                      <div>
                                        <h3>次に見るポイント</h3>
                                        <ul>
                                          {detail.analysisComment.watchPoints.map((item) => <li key={item}>{item}</li>)}
                                        </ul>
                                        <h3>注意点</h3>
                                        <ul>
                                          {detail.analysisComment.riskNotes.map((item) => <li key={item}>{item}</li>)}
                                        </ul>
                                      </div>
                                    </div>
                                  )}

                                  <div className="bt-similar-box bt-ml-candidate-box">
                                    <div className="bt-candidate-head">
                                      <div>
                                        <h3>現在のMA候補</h3>
                                        <p>{detail.analysisComment?.candidateComment ?? detail.maCandidateAnalysis?.comment ?? 'ML候補はまだ生成されていません。'}</p>
                                      </div>
                                      <div className="bt-candidate-toggle" aria-label="候補方向">
                                        <button type="button" data-active={candidateMode === 'both'} onClick={() => setCandidateMode('both')}>両方</button>
                                        <button type="button" data-active={candidateMode === 'up'} onClick={() => setCandidateMode('up')}>上昇</button>
                                        <button type="button" data-active={candidateMode === 'down'} onClick={() => setCandidateMode('down')}>下落</button>
                                      </div>
                                    </div>
                                    {detailCandidates.length > 0 ? (
                                      <div className="bt-candidate-grid">
                                        {detailCandidates.map((item) => (
                                          <Link key={`${item.direction}-${item.ticker}`} href={`/stock/${item.ticker}`} className="bt-candidate-card" data-direction={item.direction}>
                                            <div>
                                              <span>{item.direction === 'up' ? '上昇候補' : '下落警戒'} #{item.rank}</span>
                                              <strong>{item.ticker} {item.name ?? ''}</strong>
                                              <small>{item.sectorLarge ?? '-'} / {item.confidenceLabel}</small>
                                            </div>
                                            <dl>
                                              <div><dt>6ステージ</dt><dd>{item.stageCode ?? '-'}</dd></div>
                                              <div><dt>MA並び</dt><dd>{item.maOrder ?? '-'}</dd></div>
                                              <div><dt>MA角度</dt><dd>{item.reason.maAngle ?? '-'}</dd></div>
                                              <div><dt>MA距離</dt><dd>{item.reason.maDistance ?? '-'}</dd></div>
                                              <div><dt>株価位置</dt><dd>{item.reason.pricePosition ?? '-'}</dd></div>
                                              <div><dt>ML根拠</dt><dd>{item.reason.mlEvidence ?? '-'}</dd></div>
                                            </dl>
                                          </Link>
                                        ))}
                                      </div>
                                    ) : (
                                      <p className="bt-empty">ML候補は未作成です。batch:ml-candidates 実行後に表示されます。</p>
                                    )}
                                  </div>
                                </div>
                              )}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <aside className="bt-side">
            <section className="sb-card bt-side-card">
              <div className="bt-card-head compact">
                <div>
                  <h2>注目シグナル</h2>
                  <p>Turso配信用ランキング</p>
                </div>
                <DatabaseZap size={17} />
              </div>
              <div className="bt-rank-list">
                {latestSignals.slice(0, 8).map((item) => (
                  <div className="bt-rank" key={item.ticker}>
                    <span className="bt-rank-no">{item.rank}</span>
                    <div>
                      <Link href={`/stock/${item.ticker}`}>{item.ticker} {item.summary.name ?? ''}</Link>
                      <p>{item.signalCodes.slice(0, 3).map(compactSignal).join(' / ')}</p>
                    </div>
                    <strong>{item.score.toFixed(1)}</strong>
                  </div>
                ))}
                {latestSignals.length === 0 && <p className="bt-empty">配信用ランキングは未作成です</p>}
              </div>
            </section>

            <section className="sb-card bt-side-card">
              <div className="bt-card-head compact">
                <div>
                  <h2>業種分布</h2>
                  <p>抽出結果の偏り</p>
                </div>
                <BarChart3 size={17} />
              </div>
              <div className="bt-sector-bars">
                {sectorCounts.map(([sector, count]) => (
                  <div key={sector}>
                    <span>{sector}</span>
                    <div><i style={{ width: `${Math.max(8, (count / Math.max(1, rows.length)) * 100)}%` }} /></div>
                    <b>{count}</b>
                  </div>
                ))}
              </div>
            </section>

            <section className="sb-card bt-side-card">
              <div className="bt-card-head compact">
                <div>
                  <h2>現在のMA候補</h2>
                  <p>{mlCandidateNotice || '最新日の6ステージ・MA形状'}</p>
                </div>
                <Search size={17} />
              </div>
              <div className="bt-candidate-toggle side" aria-label="候補方向">
                <button type="button" data-active={candidateMode === 'both'} onClick={() => setCandidateMode('both')}>両方</button>
                <button type="button" data-active={candidateMode === 'up'} onClick={() => setCandidateMode('up')}>上昇</button>
                <button type="button" data-active={candidateMode === 'down'} onClick={() => setCandidateMode('down')}>下落</button>
              </div>
              <div className="bt-rank-list">
                {mlCandidates.slice(0, 8).map((item) => (
                  <div className="bt-rank" key={`${item.direction}-${item.ticker}`}>
                    <span className="bt-rank-no">{item.rank}</span>
                    <div>
                      <Link href={`/stock/${item.ticker}`}>{item.ticker} {item.name ?? ''}</Link>
                      <p>{item.direction === 'up' ? '上昇候補' : '下落警戒'} / {item.stageCode ?? '-'} / {item.confidenceLabel}</p>
                    </div>
                    <strong>{item.maOrder?.split(' > ')[0] ?? '-'}</strong>
                  </div>
                ))}
                {mlCandidates.length === 0 && <p className="bt-empty">ML候補データは未作成です</p>}
              </div>
            </section>

            <section className="sb-card bt-side-card">
              <div className="bt-card-head compact">
                <div>
                  <h2>現在類似銘柄</h2>
                  <p>最新データでMA形状と6ステージが近い銘柄</p>
                </div>
                <LineChart size={17} />
              </div>
              <div className="bt-rank-list">
                {currentSimilars.slice(0, 6).map((item) => (
                  <div className="bt-rank" key={`${item.baseTicker}-${item.similarTicker}-${item.rank}`}>
                    <span className="bt-rank-no">{item.rank}</span>
                    <div>
                      <Link href={`/stock/${item.baseTicker}`}>{item.baseTicker}</Link>
                      <p>
                        → <Link href={`/stock/${item.similarTicker}`}>{item.similarTicker}</Link>
                        {' / '}
                        {item.payload.similar?.stageCode ?? '-'}
                      </p>
                    </div>
                    <strong>{Math.round(item.similarityScore * 100)}%</strong>
                  </div>
                ))}
                {currentSimilars.length === 0 && <p className="bt-empty">現在類似データは未作成です</p>}
              </div>
            </section>

            <section className="sb-card bt-side-card">
              <div className="bt-card-head compact">
                <div>
                  <h2>ML業種ランキング</h2>
                  <p>上昇/下落候補が集まる17・33業種</p>
                </div>
                <BarChart3 size={17} />
              </div>
              <div className="bt-rank-list">
                {mlSectorRankings.slice(0, 7).map((item, index) => (
                  <div className="bt-rank" key={`${item.sectorType}-${item.direction}-${item.sectorName}`}>
                    <span className="bt-rank-no">{index + 1}</span>
                    <div>
                      <strong style={{ color: 'var(--color-brand-900)', textAlign: 'left' }}>
                        {item.sectorType}業種: {item.sectorName}
                      </strong>
                      <p>
                        {item.direction === 'up' ? '上昇候補' : '下落警戒'} {item.candidateCount}件
                        {item.representativeTickers.length > 0 ? ` / ${item.representativeTickers.slice(0, 3).map((row) => row.ticker).join(', ')}` : ''}
                      </p>
                    </div>
                    <strong>{item.avgScore == null ? '-' : Math.round(item.avgScore * 100)}</strong>
                  </div>
                ))}
                {mlSectorRankings.length === 0 && <p className="bt-empty">ML業種ランキングは未作成です</p>}
              </div>
            </section>

            <section className="sb-card bt-side-card">
              <div className="bt-card-head compact">
                <div>
                  <h2>MLモデル成績</h2>
                  <p>学習モデルが過去データ上で抽出した候補群</p>
                </div>
                <Sigma size={17} />
              </div>
              <div className="bt-rank-list">
                {mlPerformance.filter((item) => item.sectorType === 'all').slice(0, 6).map((item) => {
                  const mainRate = item.direction === 'up' ? item.upRate : item.downRate
                  const accuracy = item.payload?.metrics?.accuracy
                  const precision = item.payload?.precisionAt20
                  return (
                    <div className="bt-rank" key={`${item.direction}-${item.horizonDays}-${item.sectorName}`}>
                      <span className="bt-rank-no">{item.horizonDays}</span>
                      <div>
                        <strong style={{ color: 'var(--color-brand-900)', textAlign: 'left' }}>
                          {item.direction === 'up' ? '上昇候補' : '下落警戒'} / {item.horizonDays}営業日
                        </strong>
                        <p>
                          N={item.sampleCount.toLocaleString()}
                          {' / '}
                          {precision == null
                            ? item.medianReturnPct == null
                              ? `学習精度 ${accuracy == null ? '-' : `${Math.round(accuracy * 100)}%`}`
                              : `中央値 ${fmtPct(item.medianReturnPct)}`
                            : `上位20的中 ${Math.round(precision * 100)}%`}
                        </p>
                      </div>
                      <strong>{mainRate == null ? (precision == null ? (accuracy == null ? '-' : `${Math.round(accuracy * 100)}%`) : `${Math.round(precision * 100)}%`) : `${Math.round(mainRate * 100)}%`}</strong>
                    </div>
                  )
                })}
                {mlPerformance.length === 0 && <p className="bt-empty">モデル成績は未作成です</p>}
              </div>
            </section>

            <section className="sb-card bt-side-card">
              <div className="bt-card-head compact">
                <div>
                  <h2>シグナル勝率</h2>
                  <p>{'N>=40 / 40営業日'}</p>
                </div>
                <Target size={17} />
              </div>
              <div className="bt-rank-list">
                {signalStats.slice(0, 6).map((item, index) => (
                  <div className="bt-rank" key={`${item.signalCode}-${item.patternCode}-${item.horizonDays}`}>
                    <span className="bt-rank-no">{index + 1}</span>
                    <div>
                      <strong style={{ color: 'var(--color-brand-900)', textAlign: 'left' }}>{compactSignal(item.signalCode)}</strong>
                      <p>N={item.payload.count ?? '-'} / 平均最大 {fmtPct(item.payload.max_return_p50)}</p>
                    </div>
                    <strong>{fmtPct(item.payload.hit_40_rate == null ? null : item.payload.hit_40_rate * 100, 0)}</strong>
                  </div>
                ))}
                {signalStats.length === 0 && <p className="bt-empty">勝率統計は未作成です</p>}
              </div>
            </section>

            <section className="sb-card bt-side-card">
              <div className="bt-card-head compact">
                <div>
                  <h2>ML/RLデータ</h2>
                  <p>特徴量とラベルを分離保存</p>
                </div>
                <Sigma size={17} />
              </div>
              <div className="bt-ml-note">
                <span>特徴量 {mlModelStatus?.latestFeatureDate ?? '-'}</span>
                <span>予測 {mlModelStatus?.latestPredictionDate ?? '-'}</span>
                <span>評価 {mlModelStatus?.latestEvaluationDate ?? '-'}</span>
                <span>モデル {mlModelStatus?.models.length ?? 0}世代</span>
              </div>
              <div className="bt-rank-list" style={{ marginTop: 12 }}>
                {(mlModelStatus?.models ?? []).slice(0, 4).map((model) => (
                  <div className="bt-rank" key={model.modelName}>
                    <span className="bt-rank-no">{model.horizonDays}</span>
                    <div>
                      <strong style={{ color: 'var(--color-brand-900)', textAlign: 'left' }}>
                        {model.direction === 'up' ? '上昇' : '下落'}モデル
                      </strong>
                      <p>
                        {model.metrics.trainStartDate ?? '2008-05-07'}〜{model.metrics.trainEndDate ?? '-'}
                        {' / '}
                        N={Number(model.metrics.samples ?? 0).toLocaleString()}
                      </p>
                    </div>
                    <strong>{model.metrics.accuracy == null ? '-' : `${Math.round(model.metrics.accuracy * 100)}%`}</strong>
                  </div>
                ))}
                {!mlModelStatus?.models?.length && <p className="bt-empty">モデル状態は未作成です</p>}
              </div>
            </section>
          </aside>
        </div>
      </div>
    </div>
  )
}

function MetricCard({
  icon: Icon,
  label,
  value,
  sub,
  tone = 'neutral',
}: {
  icon: typeof Search
  label: string
  value: string
  sub: string
  tone?: 'neutral' | 'red' | 'blue'
}) {
  return (
    <div className="bt-metric" data-tone={tone}>
      <Icon size={18} />
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        <p>{sub}</p>
      </div>
    </div>
  )
}
