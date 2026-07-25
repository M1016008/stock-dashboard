// app/screener/page.tsx
'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { Columns3, Filter, GitCompareArrows, RotateCcw } from 'lucide-react'
import { toTvSymbol, buildTvWatchlistText } from '@/lib/tv-format'
import { WatchlistButton } from '@/components/ui/WatchlistButton'
import { StageDots } from '@/components/ui/StageDots'
import { MarketDateCalendar } from '@/components/ui/MarketDateCalendar'
import { SavedViewManager } from '@/components/ui/SavedViewManager'
import { getCompareSymbols, toggleComparedSymbol } from '@/lib/client/stock-workspace'
import { getUniverseFilterMeta, parseUniverseFilter, UNIVERSE_FILTER_PARAM } from '@/lib/market-universe'
import { formatShortTermStrength, SHORT_TERM_CHECK_LABELS, type ShortTermCheckLabel } from '@/lib/short-term-check'
import type { PhysicsStatus } from '@/lib/ml/physics-analysis'
import {
  earningsTimeBucketLabel,
  type EarningsTimeBucket,
  type EarningsTimeKind,
} from '@/lib/earnings-time'

type Market = 'JP'
type AxisKey = 'daily_a' | 'daily_b' | 'weekly_a' | 'weekly_b' | 'monthly_a' | 'monthly_b'
type TableView = 'compact' | 'core' | 'all'

const TABLE_VIEW_KEY = 'stockboard_jp_screener_columns_v1'

// 時価総額レンジ（円）。.minは含む / .maxは含まない。億単位の閾値で設計。
const MCAP_BINS: { label: string; min: number; max: number }[] = [
  { label: '〜100億',     min: 0,           max: 1e10 },
  { label: '100〜500億',  min: 1e10,        max: 5e10 },
  { label: '500〜2,000億', min: 5e10,        max: 2e11 },
  { label: '2,000億〜1兆', min: 2e11,        max: 1e12 },
  { label: '1兆〜5兆',    min: 1e12,        max: 5e12 },
  { label: '5兆〜',       min: 5e12,        max: Number.POSITIVE_INFINITY },
]

const MARGIN_FILTER_ORDER = ['貸借', '信用', 'その他', '未設定']
const EARNINGS_WINDOW_OPTIONS = [
  { weeks: 1, label: '1週間以内', businessDays: 5 },
  { weeks: 2, label: '2週間以内', businessDays: 10 },
  { weeks: 3, label: '3週間以内', businessDays: 15 },
] as const
type EarningsWindowWeeks = typeof EARNINGS_WINDOW_OPTIONS[number]['weeks']
const EARNINGS_TIME_BUCKET_OPTIONS: EarningsTimeBucket[] = [
  'pre_open',
  'morning',
  'lunch',
  'afternoon',
  'after_close',
  'unknown',
]
const VOLUME_MIN_OPTIONS = [
  { value: 100_000, label: '10万株以上' },
  { value: 300_000, label: '30万株以上' },
  { value: 500_000, label: '50万株以上' },
  { value: 1_000_000, label: '100万株以上' },
  { value: 3_000_000, label: '300万株以上' },
] as const
type VolumeMinValue = typeof VOLUME_MIN_OPTIONS[number]['value']
const MA200_DIRECTION_OPTIONS = [
  { key: 'up', label: '上向き', description: '200日線が上向き' },
  { key: 'down', label: '下向き', description: '200日線が下向き' },
  { key: 'flat', label: '横ばい', description: '200日線がほぼ横ばい' },
] as const
type Ma200Direction = typeof MA200_DIRECTION_OPTIONS[number]['key']
const MA200_FLAT_THRESHOLD = 0.05
const MARKET_SEGMENT_SORT_ORDER = [
  'プライム',
  'スタンダード',
  'グロース',
  'TOKYO PRO Market',
  'その他',
  '未設定',
] as const
const PHYSICAL_STATUS_LABELS: PhysicsStatus[] = [
  '上昇加速',
  '上昇継続',
  '押し目形成',
  '反発準備',
  '過熱注意',
  '失速警戒',
  '下落加速',
  '見送り',
  '算出待ち',
]
const PHYSICAL_STATUS_HORIZONS = [5, 10, 20, 40, 60, 90, 200] as const
type PhysicalStatusHorizon = typeof PHYSICAL_STATUS_HORIZONS[number]
type PhysicalStatusOption = {
  label: PhysicsStatus
  count: number
  confidence: number | null
  evaluatedCount: number
}

const AXES: { key: AxisKey; label: string; color: string }[] = [
  { key: 'daily_a',   label: '日足A', color: '#ef4444' },
  { key: 'daily_b',   label: '日足B', color: '#f59e0b' },
  { key: 'weekly_a',  label: '週足A', color: '#22c55e' },
  { key: 'weekly_b',  label: '週足B', color: '#3b82f6' },
  { key: 'monthly_a', label: '月足A', color: '#a855f7' },
  { key: 'monthly_b', label: '月足B', color: '#ec4899' },
]

interface StockRow {
  ticker: string
  name: string
  market: Market
  marketSegment: string
  marginType?: string
  sectorLarge: string
  sector33?: string | null
  sector17Name?: string | null
  sector33Name?: string | null
  price: number | null
  currency?: string | null
  changePercent: number | null
  changePercentWeek?: number
  changePercentMonth?: number
  perfPct3m?: number | null
  perfPct6m?: number | null
  perfPctYtd?: number | null
  volume: number | null
  avgVolume10d?: number | null
  avgVolume30d?: number | null
  marketCap?: number | null
  marketCapCurrency?: string | null
  marketCapStatus?: 'calculated' | 'not_applicable' | 'shares_missing' | 'price_missing'
  sma5Angle?: number | null
  sma25Angle?: number | null
  sma75Angle?: number | null
  sma200Angle?: number | null
  earningsLastDate?: string | null
  earningsLastDateKind?: 'reported' | 'not_applicable' | 'not_collected' | 'unverified'
  earningsLastDateSource?: string | null
  earningsLastFiscalPeriod?: string | null
  earningsNextDate?: string | null
  earningsNextDateKind?: 'confirmed' | 'estimated' | 'not_announced' | 'not_applicable' | 'no_history'
  earningsNextDateSource?: string | null
  earningsNextFiscalPeriod?: string | null
  earningsNextTime?: string | null
  earningsNextTimeKind?: EarningsTimeKind
  earningsNextTimeBucket?: string | null
  earningsNextPredictionConfidence?: string | null
  earningsNextPredictionSampleCount?: number | null
  earningsNextPredictionModeCount?: number | null
  daily_a_stage: number | null
  daily_b_stage: number | null
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
  physicalMomentumScore?: number | null
  physicalForceScore?: number | null
  physicalEnergyScore?: number | null
  physicalMomentumRank?: number | null
  physicalMomentumTrend?: 'rising' | 'falling' | 'flat' | null
  physicalAcceleration?: number | null
  physicalForce?: number | null
  physicalStatusLabel: PhysicsStatus
  physicalStatusScore?: number | null
  physicalStatusSourceDate?: string | null
  physicalStatusTargetDirection?: 'up' | 'down' | 'wait' | null
  physicalStatusHitRate?: number | null
  physicalStatusBaseRate?: number | null
  physicalStatusLift?: number | null
  physicalStatusConfidence?: number | null
  physicalStatusSampleCount?: number | null
  physicalStatusHorizonDays?: number | null
  physicalStatusEvaluationDate?: string | null
  shortTermCheckLabel: ShortTermCheckLabel
  shortTermCheckScore: number
  shortTermCheckReasons?: string[]
  shortTermCheckMlText?: string
}

type SortKey =
  | 'ticker'
  | 'marginType'
  | 'marketSegment'
  | 'sector33'
  | 'sectorLarge'
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
  | 'sma5Angle'
  | 'sma25Angle'
  | 'sma75Angle'
  | 'sma200Angle'
  | 'physicalMomentumScore'
  | 'physicalForceScore'
  | 'physicalEnergyScore'
  | 'physicalMomentumRank'
  | 'physicalStatusScore'
  | 'physicalStatusConfidence'
  | 'physicalStatusHitRate'
  | 'physicalStatusLift'
  | 'shortTermCheckScore'
  | 'earningsLastDate'
  | 'earningsLastElapsedDays'
  | 'earningsNextDate'
  | 'earningsNextBusinessDays'

interface SortState {
  key: SortKey
  dir: 'asc' | 'desc'
}

interface JpScreenerView {
  stages: Partial<Record<AxisKey, number[]>>
  selectedDate: string | null
  selectedMarketSegment: string
  selectedSectorLarge: string
  selectedSector33: string
  selectedMarginType: string
  selectedVolumeMin: VolumeMinValue | null
  selectedEarningsWindowWeeks: EarningsWindowWeeks | null
  selectedEarningsTimeBucket?: EarningsTimeBucket | ''
  selectedMa200Direction: Ma200Direction | ''
  selectedShortTermCheck: string
  selectedPhysicalStatus: string
  selectedMcapBins: number[]
  pmsMin: string
  pfsMin: string
  pesMin: string
  accelerationPositive: boolean
  forcePositive: boolean
  stage23Candidate: boolean
  pmsTrend: string
  selectedPhysicalStatusHorizon: PhysicalStatusHorizon
  sort: SortState | null
}

interface ActiveFilterChip {
  key: string
  label: string
  value: string
  tone?: 'red' | 'blue' | 'green' | 'amber' | 'purple' | 'neutral'
}

interface SummaryMetric {
  label: string
  value: string
  sub: string
  tone?: 'red' | 'blue' | 'green' | 'amber' | 'purple' | 'neutral'
}

const SORT_KEY_VALUES: readonly SortKey[] = [
  'ticker',
  'marginType',
  'marketSegment',
  'sector33',
  'sectorLarge',
  'name',
  'price',
  'currency',
  'changePercent',
  'changePercentWeek',
  'changePercentMonth',
  'perfPct3m',
  'perfPct6m',
  'perfPctYtd',
  'volume',
  'avgVolume10d',
  'avgVolume30d',
  'marketCap',
  'marketCapCurrency',
  'sma5Angle',
  'sma25Angle',
  'sma75Angle',
  'sma200Angle',
  'physicalMomentumScore',
  'physicalForceScore',
  'physicalEnergyScore',
  'physicalMomentumRank',
  'physicalStatusScore',
  'physicalStatusConfidence',
  'physicalStatusHitRate',
  'physicalStatusLift',
  'shortTermCheckScore',
  'earningsLastDate',
  'earningsLastElapsedDays',
  'earningsNextDate',
  'earningsNextBusinessDays',
]

const SORT_OPTIONS: Array<{ key: SortKey; label: string; descLabel?: string; ascLabel?: string }> = [
  { key: 'marketSegment', label: '市場区分', descLabel: '逆順', ascLabel: 'プライム順' },
  { key: 'marketCap', label: '時価総額', descLabel: '大きい順', ascLabel: '小さい順' },
  { key: 'volume', label: '出来高', descLabel: '多い順', ascLabel: '少ない順' },
  { key: 'avgVolume10d', label: '10日平均出来高', descLabel: '多い順', ascLabel: '少ない順' },
  { key: 'avgVolume30d', label: '30日平均出来高', descLabel: '多い順', ascLabel: '少ない順' },
  { key: 'changePercent', label: '日次騰落率', descLabel: '上昇順', ascLabel: '下落順' },
  { key: 'changePercentWeek', label: '週次騰落率', descLabel: '上昇順', ascLabel: '下落順' },
  { key: 'changePercentMonth', label: '月次騰落率', descLabel: '上昇順', ascLabel: '下落順' },
  { key: 'shortTermCheckScore', label: '短期チェック', descLabel: '強い順', ascLabel: '弱い順' },
  { key: 'physicalStatusScore', label: '物理状態スコア', descLabel: '強い順', ascLabel: '弱い順' },
  { key: 'physicalMomentumScore', label: 'PMS', descLabel: '高い順', ascLabel: '低い順' },
  { key: 'physicalForceScore', label: 'PFS', descLabel: '高い順', ascLabel: '低い順' },
  { key: 'physicalEnergyScore', label: 'PES', descLabel: '高い順', ascLabel: '低い順' },
  { key: 'sma200Angle', label: '200日線の向き', descLabel: '上向き順', ascLabel: '下向き順' },
  { key: 'physicalStatusConfidence', label: '物理状態 確度', descLabel: '高い順', ascLabel: '低い順' },
  { key: 'earningsNextBusinessDays', label: '次回決算まで', descLabel: '遠い順', ascLabel: '近い順' },
  { key: 'ticker', label: 'コード', descLabel: '降順', ascLabel: '昇順' },
  { key: 'name', label: '銘柄名', descLabel: '降順', ascLabel: '昇順' },
]

function isSortKey(value: string | null): value is SortKey {
  return SORT_KEY_VALUES.includes(value as SortKey)
}

function parsePhysicalStatusHorizon(value: string | null): PhysicalStatusHorizon {
  const parsed = Number(value)
  return PHYSICAL_STATUS_HORIZONS.includes(parsed as PhysicalStatusHorizon)
    ? parsed as PhysicalStatusHorizon
    : 20
}

function parseEarningsWindowWeeks(value: string | null): EarningsWindowWeeks | null {
  const parsed = Number(value)
  return EARNINGS_WINDOW_OPTIONS.some((option) => option.weeks === parsed)
    ? parsed as EarningsWindowWeeks
    : null
}

function parseVolumeMin(value: string | null): VolumeMinValue | null {
  const parsed = Number(value)
  return VOLUME_MIN_OPTIONS.some((option) => option.value === parsed)
    ? parsed as VolumeMinValue
    : null
}

function parseMa200Direction(value: string | null): Ma200Direction | '' {
  return MA200_DIRECTION_OPTIONS.some((option) => option.key === value)
    ? value as Ma200Direction
    : ''
}

function parseMcapBins(value: string | null): Set<number> {
  if (!value) return new Set()
  const selected = value
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((idx) => Number.isInteger(idx) && idx >= 0 && idx < MCAP_BINS.length)
  return new Set(selected)
}

function parseStageSelection(value: string | null): number[] {
  if (!value) return []
  return Array.from(new Set(
    value
      .split(',')
      .map((item) => Number(item.trim()))
      .filter((stage) => Number.isInteger(stage) && stage >= 1 && stage <= 6),
  )).sort((a, b) => a - b)
}

function initialStageFilters(searchParams: ReturnType<typeof useSearchParams>): Partial<Record<AxisKey, number[]>> {
  const next: Partial<Record<AxisKey, number[]>> = {}
  for (const axis of AXES) {
    const stages = parseStageSelection(searchParams.get(axis.key))
    if (stages.length > 0) next[axis.key] = stages
  }
  return next
}

function defaultSortDir(key: SortKey): SortState['dir'] {
  return key === 'earningsNextBusinessDays' || key === 'marketSegment' ? 'asc' : 'desc'
}

function initialSortState(searchParams: ReturnType<typeof useSearchParams>): SortState {
  const requested = searchParams.get('sort')
  if (isSortKey(requested)) {
    return {
      key: requested,
      dir: searchParams.get('dir') === 'asc' ? 'asc' : 'desc',
    }
  }
  return { key: 'marketCap', dir: 'desc' }
}

function parseUrlLimit(value: string | null): number | null {
  if (!value) return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return Math.min(5000, Math.max(1, Math.floor(parsed)))
}

interface AvailableDate {
  date: string
  tickers: number
}

export default function ScreenerPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const activeUniverse = parseUniverseFilter(searchParams.get(UNIVERSE_FILTER_PARAM))
  const activeUniverseMeta = getUniverseFilterMeta(activeUniverse)
  const requestedLimit = parseUrlLimit(searchParams.get('limit'))
  const [stages, setStages] = useState<Partial<Record<AxisKey, number[]>>>(() => initialStageFilters(searchParams))
  const [results, setResults] = useState<StockRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [universe, setUniverse] = useState(0)
  const [cached, setCached] = useState(false)
  const [snapshotDate, setSnapshotDate] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [sort, setSort] = useState<SortState | null>(() => initialSortState(searchParams))
  const [copiedTicker, setCopiedTicker] = useState<string | null>(null)
  const [availableDates, setAvailableDates] = useState<AvailableDate[]>([])
  const [selectedDate, setSelectedDate] = useState<string | null>(() => searchParams.get('date')) // null = 最新
  const [selectedMarketSegment, setSelectedMarketSegment] = useState<string>(() => searchParams.get('marketSegment') ?? '')
  const [selectedSectorLarge, setSelectedSectorLarge] = useState<string>(() => searchParams.get('sectorLarge') ?? '')
  const [selectedSector33, setSelectedSector33] = useState<string>(() => searchParams.get('sector33') ?? '')
  const [selectedMarginType, setSelectedMarginType] = useState<string>(() => searchParams.get('marginType') ?? '')
  const [selectedVolumeMin, setSelectedVolumeMin] = useState<VolumeMinValue | null>(() => (
    parseVolumeMin(searchParams.get('volumeMin'))
  ))
  const [selectedEarningsWindowWeeks, setSelectedEarningsWindowWeeks] = useState<EarningsWindowWeeks | null>(() => (
    parseEarningsWindowWeeks(searchParams.get('earningsWindowWeeks'))
  ))
  const [selectedEarningsTimeBucket, setSelectedEarningsTimeBucket] = useState<EarningsTimeBucket | ''>(() => {
    const value = searchParams.get('earningsTimeBucket')
    return EARNINGS_TIME_BUCKET_OPTIONS.includes(value as EarningsTimeBucket)
      ? value as EarningsTimeBucket
      : ''
  })
  const [selectedMa200Direction, setSelectedMa200Direction] = useState<Ma200Direction | ''>(() => (
    parseMa200Direction(searchParams.get('ma200Direction'))
  ))
  const [selectedShortTermCheck, setSelectedShortTermCheck] = useState<string>(() => searchParams.get('shortTermCheck') ?? '')
  const [selectedPhysicalStatus, setSelectedPhysicalStatus] = useState<string>(() => searchParams.get('physicalStatus') ?? '')
  const [selectedMcapBins, setSelectedMcapBins] = useState<Set<number>>(() => parseMcapBins(searchParams.get('mcapBins')))
  const [pmsMin, setPmsMin] = useState(() => searchParams.get('pmsMin') ?? '')
  const [pfsMin, setPfsMin] = useState(() => searchParams.get('pfsMin') ?? '')
  const [pesMin, setPesMin] = useState(() => searchParams.get('pesMin') ?? '')
  const [accelerationPositive, setAccelerationPositive] = useState(() => searchParams.get('accelerationPositive') === '1')
  const [forcePositive, setForcePositive] = useState(() => searchParams.get('forcePositive') === '1')
  const [stage23Candidate, setStage23Candidate] = useState(() => searchParams.get('stage23Candidate') === '1')
  const [pmsTrend, setPmsTrend] = useState(() => searchParams.get('pmsTrend') ?? '')
  const [selectedPhysicalStatusHorizon, setSelectedPhysicalStatusHorizon] = useState<PhysicalStatusHorizon>(() => (
    parsePhysicalStatusHorizon(searchParams.get('physicalStatusHorizon'))
  ))
  const [filtersExpanded, setFiltersExpanded] = useState(true)
  const [tableView, setTableView] = useState<TableView>('core')
  const [selectedForComparison, setSelectedForComparison] = useState<Set<string>>(new Set())
  const referenceDate = snapshotDate ?? selectedDate
  const tradingDates = useMemo(
    () => availableDates.map((item) => item.date).filter(Boolean).sort(),
    [availableDates],
  )

  const hasAnyStage = Object.values(stages).some((v) => v && v.length > 0)

  // J-Quants 由来のスナップショット日付リストの取得
  useEffect(() => {
    let cancelled = false
    fetch('/api/hex/available-dates?limit=10000', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return
        setAvailableDates(d.dates ?? [])
      })
      .catch(() => { /* 無視 */ })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const saved = window.localStorage.getItem(TABLE_VIEW_KEY)
    if (saved === 'compact' || saved === 'core' || saved === 'all') setTableView(saved)
  }, [])

  const updateTableView = (next: TableView) => {
    setTableView(next)
    window.localStorage.setItem(TABLE_VIEW_KEY, next)
  }

  const toggleComparisonSelection = (ticker: string) => {
    setSelectedForComparison((current) => {
      const next = new Set(current)
      if (next.has(ticker)) next.delete(ticker)
      else if (next.size < 4) next.add(ticker)
      return next
    })
  }

  const addSelectedToComparison = () => {
    const compared = new Set(getCompareSymbols().map((symbol) => `${symbol.market}:${symbol.ticker}`))
    results
      .filter((row) => selectedForComparison.has(row.ticker))
      .forEach((row) => {
        const ticker = row.ticker.replace(/\.T$/i, '')
        if (!compared.has(`JP:${ticker}`)) {
          toggleComparedSymbol({ market: 'JP', ticker, name: row.name })
        }
      })
    setSelectedForComparison(new Set())
  }

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    const params = new URLSearchParams({ market: 'JP' })
    if (activeUniverse) params.set(UNIVERSE_FILTER_PARAM, activeUniverse)
    if (selectedDate) params.set('date', selectedDate)
    if (pmsMin.trim()) params.set('pmsMin', pmsMin.trim())
    if (pfsMin.trim()) params.set('pfsMin', pfsMin.trim())
    if (pesMin.trim()) params.set('pesMin', pesMin.trim())
    if (accelerationPositive) params.set('accelerationPositive', '1')
    if (forcePositive) params.set('forcePositive', '1')
    if (stage23Candidate) params.set('stage23Candidate', '1')
    if (pmsTrend) params.set('pmsTrend', pmsTrend)
    if (requestedLimit != null) params.set('limit', String(requestedLimit))
    params.set('physicalStatusHorizon', String(selectedPhysicalStatusHorizon))
    for (const [k, v] of Object.entries(stages)) {
      if (v && v.length > 0) params.set(k, v.join(','))
    }

    fetch(`/api/screener?${params}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return
        if (d.error) throw new Error(d.error)
        setResults(d.results ?? [])
        setUniverse(d.universe ?? 0)
        setCached(d.cached)
        setSnapshotDate(d.date ?? null)
        setNotice(d.notice ?? null)
        setLoading(false)
      })
      .catch((e) => {
        if (!cancelled) {
          setError((e as Error).message)
          setLoading(false)
        }
      })
    return () => { cancelled = true }
  }, [stages, selectedDate, activeUniverse, pmsMin, pfsMin, pesMin, accelerationPositive, forcePositive, stage23Candidate, pmsTrend, selectedPhysicalStatusHorizon, requestedLimit])

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

  // 業種・時価総額のクライアントサイド絞り込み
  const filteredResults = useMemo(() => {
    return results.filter((r) => {
      if (selectedMarketSegment && marketSegmentFilterValue(r.marketSegment) !== selectedMarketSegment) return false
      if (selectedSectorLarge && r.sectorLarge !== selectedSectorLarge) return false
      if (selectedSector33 && (r.sector33 ?? r.sector33Name) !== selectedSector33) return false
      if (selectedMarginType && (r.marginType ?? '未設定') !== selectedMarginType) return false
      if (selectedVolumeMin != null && ((r.volume ?? 0) < selectedVolumeMin)) return false
      if (selectedEarningsWindowWeeks != null) {
        const window = EARNINGS_WINDOW_OPTIONS.find((option) => option.weeks === selectedEarningsWindowWeeks)
        const days = businessDaysUntil(r.earningsNextDate, referenceDate, tradingDates)
        if (!window || days == null || days < 0 || days > window.businessDays) return false
      }
      if (selectedEarningsTimeBucket && r.earningsNextTimeBucket !== selectedEarningsTimeBucket) return false
      if (selectedMa200Direction && ma200DirectionOf(r.sma200Angle) !== selectedMa200Direction) return false
      if (selectedShortTermCheck && r.shortTermCheckLabel !== selectedShortTermCheck) return false
      if (selectedPhysicalStatus && r.physicalStatusLabel !== selectedPhysicalStatus) return false
      if (selectedMcapBins.size > 0) {
        const cap = r.marketCap ?? -1
        const matched = Array.from(selectedMcapBins).some((idx) => {
          const bin = MCAP_BINS[idx]
          if (!bin) return false
          return cap >= bin.min && cap < bin.max
        })
        if (!matched) return false
      }
      return true
    })
  }, [results, selectedMarketSegment, selectedSectorLarge, selectedSector33, selectedMarginType, selectedVolumeMin, selectedEarningsWindowWeeks, selectedEarningsTimeBucket, referenceDate, tradingDates, selectedMa200Direction, selectedShortTermCheck, selectedPhysicalStatus, selectedMcapBins])

  const shortTermOptions = useMemo(() => {
    const counts = new Map<string, number>()
    for (const r of results) {
      counts.set(r.shortTermCheckLabel, (counts.get(r.shortTermCheckLabel) ?? 0) + 1)
    }
    return SHORT_TERM_CHECK_LABELS.map((label) => [label, counts.get(label) ?? 0] as const)
  }, [results])

  const physicalStatusOptions = useMemo<PhysicalStatusOption[]>(() => {
    const stats = new Map<string, { count: number; confidenceTotal: number; evaluatedCount: number }>()
    for (const r of results) {
      const current = stats.get(r.physicalStatusLabel) ?? { count: 0, confidenceTotal: 0, evaluatedCount: 0 }
      current.count += 1
      const confidence = physicalStatusConfidencePct(r)
      if (confidence != null) {
        current.confidenceTotal += confidence
        current.evaluatedCount += 1
      }
      stats.set(r.physicalStatusLabel, current)
    }
    return PHYSICAL_STATUS_LABELS.map((label) => {
      const item = stats.get(label)
      return {
        label,
        count: item?.count ?? 0,
        confidence: item && item.evaluatedCount > 0 ? item.confidenceTotal / item.evaluatedCount : null,
        evaluatedCount: item?.evaluatedCount ?? 0,
      }
    })
  }, [results])

  const marginOptions = useMemo(() => {
    const counts = new Map<string, number>()
    for (const r of results) {
      const key = r.marginType?.trim() || '未設定'
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return Array.from(counts.entries())
      .sort(([a], [b]) => {
        const ai = MARGIN_FILTER_ORDER.indexOf(a)
        const bi = MARGIN_FILTER_ORDER.indexOf(b)
        if (ai !== -1 || bi !== -1) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi)
        return a.localeCompare(b, 'ja')
      })
  }, [results])

  const marketSegmentOptions = useMemo(() => {
    const counts = new Map<string, number>()
    for (const r of results) {
      const key = marketSegmentFilterValue(r.marketSegment)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return Array.from(counts.entries())
      .sort(([a], [b]) => marketSegmentSortValue(a).localeCompare(marketSegmentSortValue(b), 'ja'))
  }, [results])

  const volumeMinCounts = useMemo(() => (
    VOLUME_MIN_OPTIONS.map((option) => [
      option.value,
      results.filter((row) => (row.volume ?? 0) >= option.value).length,
    ] as const)
  ), [results])

  // セクターのドロップダウン候補
  const sectorOptions = useMemo(() => {
    const large: Record<string, number> = {}
    const sector33: Record<string, { count: number; large: string }> = {}
    for (const r of results) {
      const l = r.sectorLarge || '（未分類）'
      large[l] = (large[l] ?? 0) + 1
      const s33 = r.sector33 ?? r.sector33Name
      if (s33) {
        const cur = sector33[s33] ?? { count: 0, large: l }
        cur.count++
        cur.large = l
        sector33[s33] = cur
      }
    }
    const largeArr = Object.entries(large).sort((a, b) => b[1] - a[1])
    // 大分類が選ばれている場合は、小分類はその配下のみ
    const sector33Arr = Object.entries(sector33)
      .filter(([, v]) => !selectedSectorLarge || v.large === selectedSectorLarge)
      .sort((a, b) => b[1].count - a[1].count)
    return { largeArr, sector33Arr, sector33Map: sector33 }
  }, [results, selectedSectorLarge])

  const sortedResults = useMemo(() => {
    if (!sort) return filteredResults
    const copy = [...filteredResults]
    const dir = sort.dir === 'asc' ? 1 : -1
    copy.sort((a, b) => {
      const av = sortValue(a, sort.key, referenceDate, tradingDates)
      const bv = sortValue(b, sort.key, referenceDate, tradingDates)
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
  }, [filteredResults, sort, referenceDate, tradingDates])
  const displayLimit = requestedLimit ?? 500
  const displayedResults = useMemo(() => sortedResults.slice(0, Math.min(500, displayLimit)), [sortedResults, displayLimit])
  const marketCapCoverage = useMemo(() => {
    const calculated = filteredResults.filter((r) => r.marketCap != null && r.marketCap > 0).length
    const notApplicable = filteredResults.filter((r) => r.marketCapStatus === 'not_applicable').length
    const missing = filteredResults.length - calculated - notApplicable
    return { calculated, notApplicable, missing }
  }, [filteredResults])
  const activeFilterChips = useMemo<ActiveFilterChip[]>(() => {
    const chips: ActiveFilterChip[] = []
    if (selectedDate) chips.push({ key: 'date', label: '日付', value: selectedDate, tone: 'blue' })
    if (activeUniverseMeta) chips.push({ key: 'universe', label: 'ユニバース', value: activeUniverseMeta.shortLabel, tone: 'red' })
    if (selectedMarketSegment) chips.push({ key: 'marketSegment', label: '市場区分', value: selectedMarketSegment, tone: 'purple' })
    if (selectedSectorLarge) chips.push({ key: 'sectorLarge', label: '17業種', value: selectedSectorLarge, tone: 'green' })
    if (selectedSector33) chips.push({ key: 'sector33', label: '33業種', value: selectedSector33, tone: 'green' })
    if (selectedMarginType) chips.push({ key: 'marginType', label: '貸借/信用', value: selectedMarginType, tone: selectedMarginType === '貸借' ? 'blue' : 'neutral' })
    if (selectedVolumeMin != null) chips.push({ key: 'volumeMin', label: '出来高', value: `${selectedVolumeMin.toLocaleString('ja-JP')}株以上`, tone: 'amber' })
    if (selectedEarningsWindowWeeks != null) {
      const option = EARNINGS_WINDOW_OPTIONS.find((item) => item.weeks === selectedEarningsWindowWeeks)
      chips.push({ key: 'earningsWindowWeeks', label: '次回決算', value: option?.label ?? `${selectedEarningsWindowWeeks}週間以内`, tone: 'amber' })
    }
    if (selectedEarningsTimeBucket) {
      chips.push({
        key: 'earningsTimeBucket',
        label: '発表時間帯',
        value: earningsTimeBucketLabel(selectedEarningsTimeBucket),
        tone: 'amber',
      })
    }
    if (selectedMa200Direction) {
      const option = MA200_DIRECTION_OPTIONS.find((item) => item.key === selectedMa200Direction)
      chips.push({ key: 'ma200Direction', label: '200日線', value: option?.label ?? selectedMa200Direction, tone: selectedMa200Direction === 'down' ? 'blue' : selectedMa200Direction === 'up' ? 'red' : 'neutral' })
    }
    if (selectedMcapBins.size > 0) {
      const labels = Array.from(selectedMcapBins)
        .sort((a, b) => a - b)
        .map((idx) => MCAP_BINS[idx]?.label)
        .filter(Boolean)
      chips.push({ key: 'mcapBins', label: '時価総額', value: labels.join(' / '), tone: 'purple' })
    }
    if (selectedShortTermCheck) chips.push({ key: 'shortTermCheck', label: '短期チェック', value: selectedShortTermCheck, tone: selectedShortTermCheck.includes('下落') || selectedShortTermCheck.includes('弱') ? 'blue' : 'red' })
    if (selectedPhysicalStatus) chips.push({ key: 'physicalStatus', label: '物理状態', value: selectedPhysicalStatus, tone: selectedPhysicalStatus.includes('下落') || selectedPhysicalStatus.includes('失速') ? 'blue' : 'red' })
    if (selectedPhysicalStatusHorizon !== 20) chips.push({ key: 'physicalStatusHorizon', label: '物理検証', value: `${selectedPhysicalStatusHorizon}営業日`, tone: 'neutral' })
    if (pmsMin.trim()) chips.push({ key: 'pmsMin', label: 'PMS', value: `${pmsMin.trim()}以上`, tone: 'red' })
    if (pfsMin.trim()) chips.push({ key: 'pfsMin', label: 'PFS', value: `${pfsMin.trim()}以上`, tone: 'red' })
    if (pesMin.trim()) chips.push({ key: 'pesMin', label: 'PES', value: `${pesMin.trim()}以上`, tone: 'red' })
    if (pmsTrend) chips.push({ key: 'pmsTrend', label: 'PMS方向', value: pmsTrend === 'rising' ? '上昇中' : '低下中', tone: pmsTrend === 'rising' ? 'red' : 'blue' })
    if (accelerationPositive) chips.push({ key: 'accelerationPositive', label: '加速度', value: 'プラス', tone: 'red' })
    if (forcePositive) chips.push({ key: 'forcePositive', label: '力', value: 'プラス', tone: 'red' })
    if (stage23Candidate) chips.push({ key: 'stage23Candidate', label: 'ステージ', value: '2→3候補', tone: 'green' })
    for (const axis of AXES) {
      const selected = stages[axis.key]
      if (selected && selected.length > 0) {
        chips.push({ key: axis.key, label: axis.label, value: selected.join(','), tone: 'neutral' })
      }
    }
    return chips
  }, [
    activeUniverseMeta,
    accelerationPositive,
    forcePositive,
    pesMin,
    pfsMin,
    pmsMin,
    pmsTrend,
    selectedDate,
    selectedEarningsWindowWeeks,
    selectedEarningsTimeBucket,
    selectedMa200Direction,
    selectedMarginType,
    selectedMarketSegment,
    selectedMcapBins,
    selectedPhysicalStatus,
    selectedPhysicalStatusHorizon,
    selectedSector33,
    selectedSectorLarge,
    selectedShortTermCheck,
    selectedVolumeMin,
    stage23Candidate,
    stages,
  ])
  const resultSummaryMetrics = useMemo<SummaryMetric[]>(() => {
    const count = filteredResults.length
    const liquid = filteredResults.filter((row) => (row.volume ?? 0) >= 1_000_000).length
    const upcoming = filteredResults.filter((row) => {
      const days = businessDaysUntil(row.earningsNextDate, referenceDate, tradingDates)
      return days != null && days >= 0 && days <= 5
    }).length
    const bullish = filteredResults.filter((row) => row.shortTermCheckLabel === '強気優勢' || row.shortTermCheckLabel === '好転候補').length
    const bearish = filteredResults.filter((row) => row.shortTermCheckLabel === '下落警戒' || row.shortTermCheckLabel === '弱含み注意').length
    const pmsReady = filteredResults.filter((row) => row.physicalMomentumScore != null && Number.isFinite(row.physicalMomentumScore)).length
    return [
      {
        label: '抽出件数',
        value: count.toLocaleString('ja-JP'),
        sub: `母集団 ${universe.toLocaleString('ja-JP')} / 表示 ${Math.min(displayedResults.length, count).toLocaleString('ja-JP')}`,
        tone: 'neutral',
      },
      {
        label: '流動性',
        value: `${liquid.toLocaleString('ja-JP')}件`,
        sub: '当日出来高100万株以上',
        tone: liquid > 0 ? 'amber' : 'neutral',
      },
      {
        label: '決算注意',
        value: `${upcoming.toLocaleString('ja-JP')}件`,
        sub: '5営業日以内',
        tone: upcoming > 0 ? 'amber' : 'neutral',
      },
      {
        label: '短期ラベル',
        value: `強 ${bullish.toLocaleString('ja-JP')} / 弱 ${bearish.toLocaleString('ja-JP')}`,
        sub: '強気・好転 / 下落・弱含み',
        tone: bullish >= bearish ? 'red' : 'blue',
      },
      {
        label: 'PMS coverage',
        value: `${pmsReady.toLocaleString('ja-JP')}件`,
        sub: count > 0 ? `${Math.round((pmsReady / count) * 100)}% 算出済み` : '抽出なし',
        tone: pmsReady === count && count > 0 ? 'green' : 'neutral',
      },
    ]
  }, [displayedResults.length, filteredResults, referenceDate, tradingDates, universe])

  function toggleSort(key: SortKey) {
    setSort((prev) => {
      if (!prev || prev.key !== key) return { key, dir: defaultSortDir(key) }
      if (prev.dir === 'desc') return { key, dir: 'asc' }
      return null
    })
  }

  function setSortKey(key: SortKey) {
    setSort((prev) => ({
      key,
      dir: prev?.key === key ? prev.dir : defaultSortDir(key),
    }))
  }

  function setSortDir(dir: SortState['dir']) {
    setSort((prev) => prev ? { ...prev, dir } : { key: 'volume', dir })
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

  function resetAllFilters() {
    setStages({})
    setSelectedDate(null)
    setSelectedMarketSegment('')
    setSelectedSectorLarge('')
    setSelectedSector33('')
    setSelectedMarginType('')
    setSelectedVolumeMin(null)
    setSelectedEarningsWindowWeeks(null)
    setSelectedMa200Direction('')
    setSelectedShortTermCheck('')
    setSelectedPhysicalStatus('')
    setSelectedMcapBins(new Set())
    setPmsMin('')
    setPfsMin('')
    setPesMin('')
    setAccelerationPositive(false)
    setForcePositive(false)
    setStage23Candidate(false)
    setPmsTrend('')
    setSelectedPhysicalStatusHorizon(20)
    setSort({ key: 'marketCap', dir: 'desc' })
    router.replace('/screener')
  }

  function removeUrlParams(...keys: string[]) {
    const params = new URLSearchParams(searchParams.toString())
    for (const key of keys) params.delete(key)
    const qs = params.toString()
    router.replace(`/screener${qs ? `?${qs}` : ''}`)
  }

  function clearFilterChip(key: string) {
    switch (key) {
      case 'date':
        setSelectedDate(null)
        removeUrlParams('date')
        break
      case 'universe': {
        removeUrlParams(UNIVERSE_FILTER_PARAM)
        break
      }
      case 'marketSegment':
        setSelectedMarketSegment('')
        removeUrlParams('marketSegment')
        break
      case 'sectorLarge':
        setSelectedSectorLarge('')
        setSelectedSector33('')
        removeUrlParams('sectorLarge', 'sector33')
        break
      case 'sector33':
        setSelectedSector33('')
        removeUrlParams('sector33')
        break
      case 'marginType':
        setSelectedMarginType('')
        removeUrlParams('marginType')
        break
      case 'volumeMin':
        setSelectedVolumeMin(null)
        removeUrlParams('volumeMin')
        break
      case 'earningsWindowWeeks':
        setSelectedEarningsWindowWeeks(null)
        removeUrlParams('earningsWindowWeeks')
        break
      case 'earningsTimeBucket':
        setSelectedEarningsTimeBucket('')
        removeUrlParams('earningsTimeBucket')
        break
      case 'ma200Direction':
        setSelectedMa200Direction('')
        removeUrlParams('ma200Direction')
        break
      case 'mcapBins':
        setSelectedMcapBins(new Set())
        removeUrlParams('mcapBins')
        break
      case 'shortTermCheck':
        setSelectedShortTermCheck('')
        removeUrlParams('shortTermCheck')
        break
      case 'physicalStatus':
        setSelectedPhysicalStatus('')
        removeUrlParams('physicalStatus')
        break
      case 'physicalStatusHorizon':
        setSelectedPhysicalStatusHorizon(20)
        removeUrlParams('physicalStatusHorizon')
        break
      case 'pmsMin':
        setPmsMin('')
        removeUrlParams('pmsMin')
        break
      case 'pfsMin':
        setPfsMin('')
        removeUrlParams('pfsMin')
        break
      case 'pesMin':
        setPesMin('')
        removeUrlParams('pesMin')
        break
      case 'pmsTrend':
        setPmsTrend('')
        removeUrlParams('pmsTrend')
        break
      case 'accelerationPositive':
        setAccelerationPositive(false)
        removeUrlParams('accelerationPositive')
        break
      case 'forcePositive':
        setForcePositive(false)
        removeUrlParams('forcePositive')
        break
      case 'stage23Candidate':
        setStage23Candidate(false)
        removeUrlParams('stage23Candidate')
        break
      default:
        if (AXES.some((axis) => axis.key === key)) {
          setStages((prev) => {
            const next = { ...prev }
            delete next[key as AxisKey]
            return next
          })
          removeUrlParams(key)
        }
        break
    }
  }

  const savedView = {
    stages,
    selectedDate,
    selectedMarketSegment,
    selectedSectorLarge,
    selectedSector33,
    selectedMarginType,
    selectedVolumeMin,
    selectedEarningsWindowWeeks,
    selectedEarningsTimeBucket,
    selectedMa200Direction,
    selectedShortTermCheck,
    selectedPhysicalStatus,
    selectedMcapBins: Array.from(selectedMcapBins),
    pmsMin,
    pfsMin,
    pesMin,
    accelerationPositive,
    forcePositive,
    stage23Candidate,
    pmsTrend,
    selectedPhysicalStatusHorizon,
    sort,
  } satisfies JpScreenerView

  function applySavedView(view: JpScreenerView) {
    setStages(view.stages ?? {})
    setSelectedDate(view.selectedDate ?? null)
    setSelectedMarketSegment(view.selectedMarketSegment ?? '')
    setSelectedSectorLarge(view.selectedSectorLarge ?? '')
    setSelectedSector33(view.selectedSector33 ?? '')
    setSelectedMarginType(view.selectedMarginType ?? '')
    setSelectedVolumeMin(view.selectedVolumeMin ?? null)
    setSelectedEarningsWindowWeeks(view.selectedEarningsWindowWeeks ?? null)
    setSelectedEarningsTimeBucket(view.selectedEarningsTimeBucket ?? '')
    setSelectedMa200Direction(view.selectedMa200Direction ?? '')
    setSelectedShortTermCheck(view.selectedShortTermCheck ?? '')
    setSelectedPhysicalStatus(view.selectedPhysicalStatus ?? '')
    setSelectedMcapBins(new Set(view.selectedMcapBins ?? []))
    setPmsMin(view.pmsMin ?? '')
    setPfsMin(view.pfsMin ?? '')
    setPesMin(view.pesMin ?? '')
    setAccelerationPositive(Boolean(view.accelerationPositive))
    setForcePositive(Boolean(view.forcePositive))
    setStage23Candidate(Boolean(view.stage23Candidate))
    setPmsTrend(view.pmsTrend ?? '')
    setSelectedPhysicalStatusHorizon(
      PHYSICAL_STATUS_HORIZONS.includes(view.selectedPhysicalStatusHorizon)
        ? view.selectedPhysicalStatusHorizon
        : 20,
    )
    setSort(view.sort && isSortKey(view.sort.key)
      ? { key: view.sort.key, dir: view.sort.dir === 'asc' ? 'asc' : 'desc' }
      : { key: 'marketCap', dir: 'desc' })
  }

  return (
    <div className="sb-page">
      <div className="sb-page-title">
        <h1>スクリーナー（マルチ軸ステージフィルタ）</h1>
        <p>J-Quants由来の最新スナップショットを表示。HEXステージで絞り込み（複数系統は AND）</p>
      </div>

      <div style={{ padding: '14px 16px 16px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
      <div className="flex flex-wrap items-center justify-between gap-2 border border-[var(--color-border-default)] bg-white px-3 py-2">
        <SavedViewManager
          storageKey="stockboard_jp_screener_views"
          value={savedView}
          onApply={applySavedView}
        />
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={resetAllFilters}
            className="inline-flex h-8 w-8 items-center justify-center border border-[var(--color-border-default)] bg-white text-[var(--color-text-secondary)]"
            title="条件をリセット"
            aria-label="条件をリセット"
          >
            <RotateCcw size={14} />
          </button>
          <button
            type="button"
            onClick={() => setFiltersExpanded((current) => !current)}
            className={`inline-flex h-8 items-center gap-1.5 border px-2.5 text-[11px] font-black ${
              filtersExpanded
                ? 'border-[var(--color-brand-700)] bg-[var(--color-brand-700)] text-white'
                : 'border-[var(--color-border-default)] bg-white text-[var(--color-text-secondary)]'
            }`}
            aria-expanded={filtersExpanded}
          >
            <Filter size={14} />
            条件 {activeFilterChips.length > 0 ? `(${activeFilterChips.length})` : ''}
          </button>
        </div>
      </div>
      {filtersExpanded && (
      <div className="flex flex-col gap-3">
      {/* 市場区分で絞り込み */}
      <Section step={1} label="市場区分で絞り込み（任意）">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
          <button
            type="button"
            onClick={() => setSelectedMarketSegment('')}
            style={mcChipStyle(selectedMarketSegment === '')}
          >
            全て（{results.length.toLocaleString('ja-JP')}）
          </button>
          {marketSegmentOptions.map(([segment, count]) => (
            <button
              key={segment}
              type="button"
              onClick={() => setSelectedMarketSegment((current) => current === segment ? '' : segment)}
              style={mcChipStyle(selectedMarketSegment === segment)}
            >
              {segment}（{count.toLocaleString('ja-JP')}）
            </button>
          ))}
        </div>
      </Section>

      {/* 業種で絞り込み */}
      <Section step={2} label="業種で絞り込み（任意）">
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--text-muted)' }}>
            17業種
            <select
              value={selectedSectorLarge}
              onChange={(e) => {
                setSelectedSectorLarge(e.target.value)
                setSelectedSector33('') // 17業種が変わったら33業種はリセット
              }}
              style={mcSelectStyle}
            >
              <option value="">全て（{results.length}）</option>
              {sectorOptions.largeArr.map(([cat, n]) => (
                <option key={cat} value={cat}>{cat}（{n}）</option>
              ))}
            </select>
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--text-muted)' }}>
            33業種
            <select
              value={selectedSector33}
              onChange={(e) => {
                const v = e.target.value
                setSelectedSector33(v)
                // 33業種を選んだら、対応する17業種も常に上書きする。
                // 「全て」を選んだ場合は大分類はそのまま。
                if (v) {
                  const owner = sectorOptions.sector33Map[v]?.large
                  if (owner && owner !== '（未分類）') setSelectedSectorLarge(owner)
                }
              }}
              style={mcSelectStyle}
            >
              <option value="">全て</option>
              {sectorOptions.sector33Arr.map(([cat, v]) => (
                <option key={cat} value={cat}>{cat}（{v.count}）</option>
              ))}
            </select>
          </label>

          {(selectedSectorLarge || selectedSector33) && (
            <button
              onClick={() => { setSelectedSectorLarge(''); setSelectedSector33('') }}
              style={mcChipStyle(false)}
            >
              × クリア
            </button>
          )}
        </div>
      </Section>

      {/* 貸借/信用で絞り込み */}
      <Section step={3} label="貸借/信用で絞り込み（任意）">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
          <button
            onClick={() => setSelectedMarginType('')}
            style={mcChipStyle(selectedMarginType === '')}
          >
            全て（{results.length.toLocaleString('ja-JP')}）
          </button>
          {marginOptions.map(([type, count]) => (
            <button
              key={type}
              onClick={() => setSelectedMarginType((current) => current === type ? '' : type)}
              style={mcChipStyle(selectedMarginType === type)}
            >
              {type}（{count.toLocaleString('ja-JP')}）
            </button>
          ))}
        </div>
      </Section>

      {/* 出来高で絞り込み */}
      <Section step={4} label="出来高下限で絞り込み（任意）">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' }}>
          <button
            type="button"
            onClick={() => setSelectedVolumeMin(null)}
            style={mcChipStyle(selectedVolumeMin == null)}
          >
            全て（{results.length.toLocaleString('ja-JP')}）
          </button>
          {VOLUME_MIN_OPTIONS.map((option) => {
            const count = volumeMinCounts.find(([value]) => value === option.value)?.[1] ?? 0
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => setSelectedVolumeMin((current) => current === option.value ? null : option.value)}
                style={mcChipStyle(selectedVolumeMin === option.value)}
                title={`当日出来高が${option.label}の銘柄だけを表示します`}
              >
                {option.label}（{count.toLocaleString('ja-JP')}）
              </button>
            )
          })}
          {selectedVolumeMin != null && (
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
              選択中: {selectedVolumeMin.toLocaleString('ja-JP')}株以上
            </span>
          )}
        </div>
      </Section>

      {/* 次回決算までで絞り込み */}
      <Section step={5} label="次回決算までで絞り込み・並び替え（任意）">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' }}>
          <button
            type="button"
            onClick={() => setSelectedEarningsWindowWeeks(null)}
            style={mcChipStyle(selectedEarningsWindowWeeks == null)}
          >
            全て
          </button>
          {EARNINGS_WINDOW_OPTIONS.map((option) => (
            <button
              key={option.weeks}
              type="button"
              onClick={() => setSelectedEarningsWindowWeeks((current) => current === option.weeks ? null : option.weeks)}
              style={mcChipStyle(selectedEarningsWindowWeeks === option.weeks)}
              title={`次回決算まで${option.businessDays}営業日以内の銘柄だけを表示`}
            >
              {option.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setSort({ key: 'earningsNextBusinessDays', dir: 'asc' })}
            style={mcChipStyle(sort?.key === 'earningsNextBusinessDays' && sort.dir === 'asc')}
            title="次回決算までの残営業日が少ない順に並べます"
          >
            近い順に並べる
          </button>
          <button
            type="button"
            onClick={() => setSort({ key: 'earningsNextBusinessDays', dir: 'desc' })}
            style={mcChipStyle(sort?.key === 'earningsNextBusinessDays' && sort.dir === 'desc')}
            title="次回決算までの残営業日が多い順に並べます"
          >
            遠い順に並べる
          </button>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center', marginTop: '10px' }}>
          <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', marginRight: '2px' }}>
            発表時間帯
          </span>
          <button
            type="button"
            onClick={() => setSelectedEarningsTimeBucket('')}
            style={mcChipStyle(selectedEarningsTimeBucket === '')}
          >
            全て
          </button>
          {EARNINGS_TIME_BUCKET_OPTIONS.map((bucket) => (
            <button
              key={bucket}
              type="button"
              onClick={() => setSelectedEarningsTimeBucket((current) => current === bucket ? '' : bucket)}
              style={mcChipStyle(selectedEarningsTimeBucket === bucket)}
            >
              {earningsTimeBucketLabel(bucket)}
            </button>
          ))}
        </div>
      </Section>

      {/* 200日移動平均線で絞り込み */}
      <Section step={6} label="200日移動平均線で絞り込み・並び替え（任意）">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' }}>
          <button
            type="button"
            onClick={() => setSelectedMa200Direction('')}
            style={mcChipStyle(selectedMa200Direction === '')}
          >
            全て
          </button>
          {MA200_DIRECTION_OPTIONS.map((option) => (
            <button
              key={option.key}
              type="button"
              onClick={() => setSelectedMa200Direction((current) => current === option.key ? '' : option.key)}
              style={mcChipStyle(selectedMa200Direction === option.key)}
              title={option.description}
            >
              {option.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setSort({ key: 'sma200Angle', dir: 'desc' })}
            style={mcChipStyle(sort?.key === 'sma200Angle' && sort.dir === 'desc')}
            title="200日線の角度が強く上向きの順に並べます"
          >
            上向きが強い順
          </button>
          <button
            type="button"
            onClick={() => setSort({ key: 'sma200Angle', dir: 'asc' })}
            style={mcChipStyle(sort?.key === 'sma200Angle' && sort.dir === 'asc')}
            title="200日線の角度が強く下向きの順に並べます"
          >
            下向きが強い順
          </button>
          <button
            type="button"
            onClick={() => setSort({ key: 'physicalStatusConfidence', dir: 'desc' })}
            style={mcChipStyle(sort?.key === 'physicalStatusConfidence' && sort.dir === 'desc')}
            title="物理状態の過去検証 confidence が高い順に並べます"
          >
            確度が高い順
          </button>
        </div>
      </Section>

      {/* 時価総額で絞り込み */}
      <Section step={7} label="時価総額で絞り込み（任意 / 複数選択可）">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
          {MCAP_BINS.map((bin, idx) => {
            const active = selectedMcapBins.has(idx)
            return (
              <button
                key={bin.label}
                onClick={() => setSelectedMcapBins((prev) => {
                  const next = new Set(prev)
                  if (next.has(idx)) next.delete(idx)
                  else next.add(idx)
                  return next
                })}
                style={mcChipStyle(active)}
              >
                {bin.label}
              </button>
            )
          })}
          {selectedMcapBins.size > 0 && (
            <button onClick={() => setSelectedMcapBins(new Set())} style={mcChipStyle(false)}>
              × クリア
            </button>
          )}
        </div>
      </Section>

      <Section step={8} label="短期チェックで絞り込み（任意）">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
          <button
            onClick={() => setSelectedShortTermCheck('')}
            style={mcChipStyle(selectedShortTermCheck === '')}
          >
            全て（{results.length.toLocaleString('ja-JP')}）
          </button>
          {shortTermOptions.map(([label, count]) => (
            <button
              key={label}
              onClick={() => setSelectedShortTermCheck((current) => current === label ? '' : label)}
              style={shortTermFilterChipStyle(label, selectedShortTermCheck === label)}
            >
              {label}（{count.toLocaleString('ja-JP')}）
            </button>
          ))}
        </div>
      </Section>

      {/* Physical Momentumで絞り込み */}
      <Section step={9} label="Physical Momentumで絞り込み（任意）">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '8px', alignItems: 'end' }}>
          <MomentumNumberInput label="PMS >=" value={pmsMin} onChange={setPmsMin} placeholder="例: 1.0" />
          <MomentumNumberInput label="PFS >=" value={pfsMin} onChange={setPfsMin} placeholder="例: 0.8" />
          <MomentumNumberInput label="PES >=" value={pesMin} onChange={setPesMin} placeholder="例: 0.8" />
          <label style={momentumSelectLabelStyle}>
            PMS方向
            <select value={pmsTrend} onChange={(event) => setPmsTrend(event.target.value)} style={mcSelectStyle}>
              <option value="">全て</option>
              <option value="rising">上昇中</option>
              <option value="falling">低下中</option>
            </select>
          </label>
        </div>
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '8px', alignItems: 'center' }}>
          <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 700, marginRight: '2px' }}>
            物理状態
          </span>
          <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 700, marginLeft: '6px' }}>
            検証期間
          </span>
          {PHYSICAL_STATUS_HORIZONS.map((horizon) => (
            <button
              key={horizon}
              type="button"
              onClick={() => setSelectedPhysicalStatusHorizon(horizon)}
              style={mcChipStyle(selectedPhysicalStatusHorizon === horizon)}
              title={
                horizon === 5
                  ? '超短期の初動・急失速を見ます'
                  : horizon === 10
                    ? '初動が本物か、短期で確認します'
                    : horizon === 20
                      ? '標準の短期〜1か月目線です'
                      : '中期の答え合わせです'
              }
            >
              {horizon}営業日
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '8px', alignItems: 'center' }}>
          <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 700, marginRight: '2px' }}>
            ラベル
          </span>
          <button
            type="button"
            onClick={() => setSelectedPhysicalStatus('')}
            style={mcChipStyle(selectedPhysicalStatus === '')}
          >
            全て（{results.length.toLocaleString('ja-JP')}）
          </button>
          {physicalStatusOptions.map((option) => (
            <button
              key={option.label}
              type="button"
              onClick={() => setSelectedPhysicalStatus((current) => current === option.label ? '' : option.label)}
              style={physicalStatusFilterChipStyle(option.label, selectedPhysicalStatus === option.label)}
              title={`${option.label}: 過去ML検証ベースの平均確度 ${formatPhysicalConfidence(option.confidence)} / 対象 ${option.count.toLocaleString('ja-JP')}件 / 検証済み ${option.evaluatedCount.toLocaleString('ja-JP')}件`}
            >
              {option.label} 確度{formatPhysicalConfidence(option.confidence)}
              <span style={{ opacity: 0.7, marginLeft: 4, fontFamily: 'var(--font-mono)' }}>
                {' / '}n={option.count.toLocaleString('ja-JP')}
              </span>
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '8px' }}>
          <button type="button" onClick={() => setAccelerationPositive((v) => !v)} style={mcChipStyle(accelerationPositive)}>
            Acceleration &gt; 0
          </button>
          <button type="button" onClick={() => setForcePositive((v) => !v)} style={mcChipStyle(forcePositive)}>
            Force &gt; 0
          </button>
          <button type="button" onClick={() => setStage23Candidate((v) => !v)} style={mcChipStyle(stage23Candidate)}>
            Stage2→3候補
          </button>
          {(pmsMin || pfsMin || pesMin || accelerationPositive || forcePositive || stage23Candidate || pmsTrend || selectedPhysicalStatus) && (
            <button
              type="button"
              onClick={() => {
                setPmsMin('')
                setPfsMin('')
                setPesMin('')
                setAccelerationPositive(false)
                setForcePositive(false)
                setStage23Candidate(false)
                setPmsTrend('')
                setSelectedPhysicalStatus('')
              }}
              style={mcChipStyle(false)}
            >
              × クリア
            </button>
          )}
        </div>
      </Section>

      {/* HEXステージ（任意の絞り込み） */}
      <Section step={10} label="HEXステージで絞り込み（任意 / 複数系統 AND）">
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

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 172px), 1fr))', gap: '6px' }}>
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
            background: 'var(--color-brand-50)',
            border: '1px solid var(--accent-dim)',
            borderRadius: 'var(--radius-sm)',
            fontSize: '11px',
            color: 'var(--text-secondary)',
          }}>
            🔍 フィルタ条件: <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>{filterText}</span>
          </div>
        )}
      </Section>
      </div>
      )}

      <ScreenerConditionPanel
        chips={activeFilterChips}
        onReset={resetAllFilters}
        onClearChip={clearFilterChip}
        sort={sort}
      />

      <ResultSummaryStrip metrics={resultSummaryMetrics} />

      {error && (
        <div className="card" style={{ padding: '12px', borderLeft: '3px solid var(--price-down)' }}>
          <p style={{ fontSize: '12px', color: 'var(--price-down)', margin: 0 }}>エラー: {error}</p>
        </div>
      )}

      {notice && (
        <div className="card" style={{ padding: '12px', borderLeft: '3px solid var(--accent-primary)' }}>
          <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: 0 }}>
            ℹ️ {notice}
          </p>
        </div>
      )}

      {loading && results.length === 0 ? (
        <ScreenerLoadingSkeleton />
      ) : (
        <div className="card" style={{ overflow: 'hidden' }}>
          <div style={{ padding: '8px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-subtle)', gap: '8px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '12px', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <span><strong>{sortedResults.length}</strong>件 / 母集団 {universe}銘柄</span>
              {activeUniverseMeta && (
                <span className="rounded-full border border-[var(--color-market-red)] bg-[var(--color-price-up-bg)] px-2 py-0.5 text-[11px] font-bold text-[var(--color-market-red)]">
                  {activeUniverseMeta.shortLabel}
                </span>
              )}
              <span style={{ color: 'var(--text-muted)' }}>
                時価総額 {marketCapCoverage.calculated.toLocaleString()}件算出
                {marketCapCoverage.notApplicable > 0 ? ` / ${marketCapCoverage.notApplicable.toLocaleString()}件対象外` : ''}
                {marketCapCoverage.missing > 0 ? ` / ${marketCapCoverage.missing.toLocaleString()}件未取得` : ''}
              </span>
              {sortedResults.length > displayedResults.length && (
                <span style={{ color: 'var(--text-muted)' }}>
                  表示は先頭 {displayedResults.length} 件
                </span>
              )}
              {availableDates.length > 0 && (
                <MarketDateCalendar
                  dates={availableDates}
                  value={selectedDate}
                  onChange={setSelectedDate}
                  label="スクリーナー日付"
                  align="left"
                  compact
                />
              )}
              {cached && <span style={{ color: 'var(--text-muted)' }}>（DB）</span>}
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              {selectedForComparison.size > 0 && (
                <button
                  type="button"
                  onClick={addSelectedToComparison}
                  style={{
                    display: 'inline-flex',
                    height: 32,
                    alignItems: 'center',
                    gap: 6,
                    padding: '0 10px',
                    border: '1px solid var(--accent-primary)',
                    background: 'var(--accent-primary)',
                    color: '#fff',
                    fontSize: 11,
                    fontWeight: 800,
                    cursor: 'pointer',
                  }}
                >
                  <GitCompareArrows size={14} />
                  {selectedForComparison.size}銘柄を比較
                </button>
              )}
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700, color: 'var(--text-muted)' }}>
                並び替え
                <select
                  value={sort?.key ?? ''}
                  onChange={(event) => {
                    const key = event.target.value
                    if (isSortKey(key)) setSortKey(key)
                    else setSort(null)
                  }}
                  style={{ ...mcSelectStyle, minWidth: 168 }}
                  aria-label="スクリーナーの並び替え条件"
                >
                  <option value="">未指定</option>
                  {SORT_OPTIONS.map((option) => (
                    <option key={option.key} value={option.key}>{option.label}</option>
                  ))}
                </select>
              </label>
              <select
                value={sort?.dir ?? 'desc'}
                onChange={(event) => setSortDir(event.target.value === 'asc' ? 'asc' : 'desc')}
                disabled={!sort}
                style={{ ...mcSelectStyle, minWidth: 104, opacity: sort ? 1 : 0.55 }}
                aria-label="スクリーナーの並び替え順序"
              >
                <option value="desc">{sortDirectionLabels(sort).desc}</option>
                <option value="asc">{sortDirectionLabels(sort).asc}</option>
              </select>
              <div
                style={{ display: 'inline-flex', height: 32, border: '1px solid var(--border-base)', background: 'var(--bg-surface)' }}
                aria-label="表示する列"
              >
                {([
                  ['compact', '判断'],
                  ['core', '主要'],
                  ['all', '全列'],
                ] as const).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => updateTableView(value)}
                    aria-pressed={tableView === value}
                    title={`${label}列を表示`}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                      padding: '0 9px',
                      border: 0,
                      borderRight: value === 'all' ? 0 : '1px solid var(--border-base)',
                      background: tableView === value ? 'var(--accent-primary)' : 'transparent',
                      color: tableView === value ? '#fff' : 'var(--text-secondary)',
                      fontSize: 11,
                      fontWeight: 800,
                      cursor: 'pointer',
                    }}
                  >
                    {value === 'all' && <Columns3 size={13} />}
                    {label}
                  </button>
                ))}
              </div>
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
          </div>
          {sortedResults.length === 0 ? (
            <div style={{ padding: '32px', textAlign: 'center', display: 'grid', gap: '12px', justifyItems: 'center' }}>
              <div style={{
                width: '44px',
                height: '44px',
                borderRadius: 999,
                display: 'grid',
                placeItems: 'center',
                color: 'var(--text-muted)',
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border-base)',
                fontSize: '18px',
              }}>
                0
              </div>
              <div>
                <p style={{ fontSize: '13px', fontWeight: 800, color: 'var(--text-primary)', margin: '0 0 4px' }}>
                  該当する銘柄がありません
                </p>
                <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: 0 }}>
                  出来高下限・決算日・200日線・HEXステージのいずれかを緩めると候補が戻りやすいです。
                </p>
              </div>
              <button
                type="button"
                onClick={resetAllFilters}
                style={mcChipStyle(false)}
              >
                条件をすべてクリア
              </button>
            </div>
          ) : (
            <div style={{ overflow: 'auto', maxHeight: '72vh' }}>
              <table
                className={`data-table jp-screener-table jp-screener-table--${tableView}`}
                style={{
                  minWidth: tableView === 'all' ? '3480px' : tableView === 'core' ? '1760px' : '1080px',
                  borderCollapse: 'collapse',
                  fontSize: '12px',
                }}
              >
                <thead>
                  <tr style={{ background: 'var(--bg-elevated)', borderBottom: '1px solid var(--border-dim)' }}>
                    <th scope="col" style={th}></th>
                    <SortableTh label="コード"     sortKey="ticker"              current={sort} onClick={toggleSort} />
                    <th scope="col" style={th}>TV形式</th>
                    <SortableTh label="銘柄名"     sortKey="name"                current={sort} onClick={toggleSort} />
                    <SortableTh label="短期チェック" sortKey="shortTermCheckScore" current={sort} onClick={toggleSort} />
                    <SortableTh label="物理状態"   sortKey="physicalStatusScore" current={sort} onClick={toggleSort} />
                    <SortableTh label="貸借/信用"  sortKey="marginType"          current={sort} onClick={toggleSort} />
                    <SortableTh label="市場区分"   sortKey="marketSegment"       current={sort} onClick={toggleSort} />
                    <SortableTh label="33業種" sortKey="sector33"            current={sort} onClick={toggleSort} />
                    <SortableTh label="17業種" sortKey="sectorLarge"         current={sort} onClick={toggleSort} />
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
                    <SortableTh label="SMA5角度"   sortKey="sma5Angle"           current={sort} onClick={toggleSort} align="right" />
                    <SortableTh label="SMA25角度"  sortKey="sma25Angle"          current={sort} onClick={toggleSort} align="right" />
                    <SortableTh label="SMA75角度"  sortKey="sma75Angle"          current={sort} onClick={toggleSort} align="right" />
                    <SortableTh label="SMA200角度" sortKey="sma200Angle"         current={sort} onClick={toggleSort} align="right" />
                    <SortableTh label="PMS"        sortKey="physicalMomentumScore" current={sort} onClick={toggleSort} align="right" />
                    <SortableTh label="PFS"        sortKey="physicalForceScore"  current={sort} onClick={toggleSort} align="right" />
                    <SortableTh label="PES"        sortKey="physicalEnergyScore" current={sort} onClick={toggleSort} align="right" />
                    <SortableTh label="PMS順位"     sortKey="physicalMomentumRank" current={sort} onClick={toggleSort} align="right" />
                    <SortableTh label="前回決算"   sortKey="earningsLastDate"    current={sort} onClick={toggleSort} />
                    <SortableTh label="前回から"   sortKey="earningsLastElapsedDays" current={sort} onClick={toggleSort} align="right" />
                    <SortableTh label="次回決算"   sortKey="earningsNextDate"    current={sort} onClick={toggleSort} />
                    <SortableTh label="残営業日"   sortKey="earningsNextBusinessDays" current={sort} onClick={toggleSort} align="right" />
                    <th scope="col" style={th}>ステージ (日A/B 週A/B 月A/B)</th>
                  </tr>
                </thead>
                <tbody>
                  {displayedResults.map((r) => {
                    const tv = toTvSymbol(r.ticker, r.marketSegment)
                    const copied = copiedTicker === r.ticker
                    const lastElapsedDays = daysSince(r.earningsLastDate, referenceDate)
                    const nextBusinessDays = businessDaysUntil(r.earningsNextDate, referenceDate, tradingDates)
                    const lastEarnings = earningsLastDisplay(r)
                    const nextEarnings = earningsNextDisplay(r)
                    return (
                      <tr key={r.ticker} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                        <td style={{ ...td, width: '56px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <input
                              type="checkbox"
                              checked={selectedForComparison.has(r.ticker)}
                              onChange={() => toggleComparisonSelection(r.ticker)}
                              aria-label={`${r.ticker.replace('.T', '')}を比較対象にする`}
                              style={{ width: 14, height: 14, accentColor: 'var(--accent-primary)' }}
                            />
                          <WatchlistButton ticker={r.ticker} size="sm" />
                          </div>
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
                        <td style={td}>
                          <ShortTermCheckBadge row={r} />
                        </td>
                        <td style={td}>
                          <PhysicalStatusBadge row={r} />
                        </td>
                        <td style={td}>
                          {r.marginType ? (
                            <span style={{
                              display: 'inline-block',
                              padding: '1px 6px',
                              fontSize: '10px',
                              border: `1px solid ${r.marginType === '貸借' ? 'var(--accent-primary)' : 'var(--text-muted)'}`,
                              color: r.marginType === '貸借' ? 'var(--accent-primary)' : 'var(--text-muted)',
                              borderRadius: '2px',
                            }}>
                              {r.marginType}
                            </span>
                          ) : '---'}
                        </td>
                        <td style={td}>{r.marketSegment || '---'}</td>
                        <td style={td}>{r.sector33 || '---'}</td>
                        <td style={td}>{r.sectorLarge || '---'}</td>
                        <td style={tdR}>{r.price?.toLocaleString('ja-JP', { maximumFractionDigits: 2 }) ?? '---'}</td>
                        <td style={{ ...tdR, color: pctColor(r.changePercent ?? undefined) }}>{fmtPct(r.changePercent ?? undefined)}</td>
                        <td style={{ ...tdR, color: pctColor(r.changePercentWeek ?? undefined) }}>{fmtPct(r.changePercentWeek ?? undefined)}</td>
                        <td style={{ ...tdR, color: pctColor(r.changePercentMonth ?? undefined) }}>{fmtPct(r.changePercentMonth ?? undefined)}</td>
                        <td style={{ ...tdR, color: pctColor(r.perfPct3m ?? undefined) }}>{fmtPct(r.perfPct3m ?? undefined)}</td>
                        <td style={{ ...tdR, color: pctColor(r.perfPct6m ?? undefined) }}>{fmtPct(r.perfPct6m ?? undefined)}</td>
                        <td style={{ ...tdR, color: pctColor(r.perfPctYtd ?? undefined) }}>{fmtPct(r.perfPctYtd ?? undefined)}</td>
                        <td style={tdR}>{r.volume?.toLocaleString('ja-JP') ?? '---'}</td>
                        <td style={tdR}>{r.avgVolume10d != null ? r.avgVolume10d.toLocaleString('ja-JP') : '---'}</td>
                        <td style={tdR}>{r.avgVolume30d != null ? r.avgVolume30d.toLocaleString('ja-JP') : '---'}</td>
                        <td style={tdR}>{fmtMarketCap(r)}</td>
                        <td style={{ ...tdR, color: pctColor(r.sma5Angle ?? undefined) }}>{fmtAngleWithTrend(r.sma5Angle ?? undefined)}</td>
                        <td style={{ ...tdR, color: pctColor(r.sma25Angle ?? undefined) }}>{fmtAngle(r.sma25Angle ?? undefined)}</td>
                        <td style={{ ...tdR, color: pctColor(r.sma75Angle ?? undefined) }}>{fmtAngle(r.sma75Angle ?? undefined)}</td>
                        <td style={{ ...tdR, minWidth: '74px', color: sma200Tone(r.sma200Angle ?? undefined) }}>{fmtLongSmaAngle(r.sma200Angle ?? undefined)}</td>
                        <td style={{ ...tdR, color: scoreColor(r.physicalMomentumScore) }}>
                          {fmtScore(r.physicalMomentumScore)}
                          <span style={{ marginLeft: '4px', color: 'var(--text-muted)', fontSize: '10px' }}>
                            {pmsTrendSymbol(r.physicalMomentumTrend)}
                          </span>
                        </td>
                        <td style={{ ...tdR, color: scoreColor(r.physicalForceScore) }}>{fmtScore(r.physicalForceScore)}</td>
                        <td style={{ ...tdR, color: scoreColor(r.physicalEnergyScore) }}>{fmtScore(r.physicalEnergyScore)}</td>
                        <td style={tdR}>{r.physicalMomentumRank != null ? r.physicalMomentumRank.toLocaleString('ja-JP') : '---'}</td>
                        <td style={{ ...td, minWidth: '112px', whiteSpace: 'nowrap' }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', alignItems: 'flex-start' }}>
                            <span style={{
                              fontFamily: r.earningsLastDate ? 'var(--font-mono)' : undefined,
                              fontSize: '11px',
                              color: r.earningsLastDate ? 'var(--text-secondary)' : lastEarnings.color,
                              fontWeight: r.earningsLastDate ? 500 : 700,
                            }}>
                              {r.earningsLastDate ?? lastEarnings.label}
                            </span>
                            <span
                              title={lastEarnings.title}
                              style={{
                                display: 'inline-block',
                                padding: '1px 5px',
                                borderRadius: '2px',
                                border: `1px solid ${lastEarnings.border}`,
                                color: lastEarnings.color,
                                background: lastEarnings.background,
                                fontSize: '10px',
                                lineHeight: 1.25,
                                fontWeight: 700,
                              }}
                            >
                              {lastEarnings.badge}
                            </span>
                          </div>
                        </td>
                        <td style={{ ...tdR, color: lastElapsedDays == null ? lastEarnings.color : elapsedDaysColor(lastElapsedDays) }}>
                          {lastElapsedDays == null ? lastEarnings.label : fmtDaysSince(lastElapsedDays)}
                        </td>
                        <td style={{ ...td, minWidth: '116px', whiteSpace: 'nowrap' }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', alignItems: 'flex-start' }}>
                            <span style={{
                              fontFamily: r.earningsNextDate ? 'var(--font-mono)' : undefined,
                              fontSize: '11px',
                              color: r.earningsNextDate ? 'var(--text-secondary)' : 'var(--text-muted)',
                            }}>
                              {r.earningsNextDate ?? nextEarnings.label}
                            </span>
                            {r.earningsNextDate && (
                              <span style={{
                                fontFamily: 'var(--font-mono)',
                                fontSize: '10px',
                                color: r.earningsNextTimeKind === 'predicted' ? '#b45309' : 'var(--text-secondary)',
                                fontWeight: 700,
                              }}>
                                {r.earningsNextTime
                                  ? `${r.earningsNextTime}${r.earningsNextTimeKind === 'predicted' ? '頃（予想）' : ''}`
                                  : '時刻未定'}
                                {' / '}
                                {earningsTimeBucketLabel((r.earningsNextTimeBucket ?? 'unknown') as EarningsTimeBucket)}
                              </span>
                            )}
                            <span
                              title={nextEarnings.title}
                              style={{
                                display: 'inline-block',
                                padding: '1px 5px',
                                borderRadius: '2px',
                                border: `1px solid ${nextEarnings.border}`,
                                color: nextEarnings.color,
                                background: nextEarnings.background,
                                fontSize: '10px',
                                lineHeight: 1.25,
                                fontWeight: 700,
                              }}
                            >
                              {nextEarnings.badge}
                            </span>
                          </div>
                        </td>
                        <td style={{ ...tdR, color: daysColor(nextBusinessDays) }}>{fmtBusinessDaysUntil(nextBusinessDays)}</td>
                        <td style={{ ...td, whiteSpace: 'nowrap' }}>
                          <StageDots
                            values={[r.daily_a_stage, r.daily_b_stage, r.weekly_a_stage, r.weekly_b_stage, r.monthly_a_stage, r.monthly_b_stage]}
                          />
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
    </div>
  )
}

function ScreenerConditionPanel({
  chips,
  sort,
  onReset,
  onClearChip,
}: {
  chips: ActiveFilterChip[]
  sort: SortState | null
  onReset: () => void
  onClearChip: (key: string) => void
}) {
  const sortLabel = sort
    ? `${SORT_OPTIONS.find((option) => option.key === sort.key)?.label ?? sort.key} / ${sort.dir === 'desc' ? sortDirectionLabels(sort).desc : sortDirectionLabels(sort).asc}`
    : '未指定'
  return (
    <div className="card" style={{
      padding: '12px',
      display: 'grid',
      gridTemplateColumns: 'minmax(0, 1fr) auto',
      gap: '12px',
      alignItems: 'start',
      border: '1px solid var(--border-subtle)',
      background: 'linear-gradient(180deg, var(--bg-surface), var(--bg-elevated))',
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '8px' }}>
          <span style={{ fontSize: '12px', fontWeight: 900, color: 'var(--text-primary)' }}>
            現在の条件
          </span>
          <span style={{
            padding: '2px 7px',
            borderRadius: 999,
            border: '1px solid var(--border-base)',
            color: 'var(--text-secondary)',
            background: 'var(--bg-elevated)',
            fontSize: '10px',
            fontWeight: 800,
            fontFamily: 'var(--font-mono)',
          }}>
            並び替え: {sortLabel}
          </span>
        </div>
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
          {chips.length === 0 ? (
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
              条件未指定。全銘柄から広く確認中。
            </span>
          ) : chips.map((chip) => (
            <button
              key={`${chip.key}-${chip.value}`}
              type="button"
              onClick={() => onClearChip(chip.key)}
              title={`${chip.label} 条件を外す`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '5px',
                padding: '4px 8px',
                borderRadius: 999,
                fontSize: '11px',
                fontWeight: 800,
                whiteSpace: 'nowrap',
                cursor: 'pointer',
                ...filterChipToneStyle(chip.tone ?? 'neutral'),
              }}
            >
              <span style={{ opacity: 0.72 }}>{chip.label}</span>
              <span>{chip.value}</span>
              <span aria-hidden="true" style={{ opacity: 0.7, fontWeight: 900 }}>×</span>
            </button>
          ))}
        </div>
      </div>
      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        <button
          type="button"
          onClick={onReset}
          style={{
            ...mcChipStyle(false),
            borderColor: chips.length > 0 ? 'var(--accent-primary)' : 'var(--border-base)',
            color: chips.length > 0 ? 'var(--accent-primary)' : 'var(--text-secondary)',
            fontWeight: 800,
          }}
        >
          全条件クリア
        </button>
      </div>
    </div>
  )
}

function ResultSummaryStrip({ metrics }: { metrics: SummaryMetric[] }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '8px' }}>
      {metrics.map((metric) => (
        <div
          key={metric.label}
          className="card"
          style={{
            padding: '10px 12px',
            minHeight: 72,
            border: `1px solid ${filterChipToneStyle(metric.tone ?? 'neutral').borderColor}`,
            background: filterChipToneStyle(metric.tone ?? 'neutral').background,
          }}
        >
          <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 800, marginBottom: '5px' }}>
            {metric.label}
          </div>
          <div style={{ fontSize: '17px', lineHeight: 1.15, fontWeight: 900, color: filterChipToneStyle(metric.tone ?? 'neutral').color }}>
            {metric.value}
          </div>
          <div style={{ marginTop: '4px', fontSize: '11px', color: 'var(--text-secondary)' }}>
            {metric.sub}
          </div>
        </div>
      ))}
    </div>
  )
}

function ScreenerLoadingSkeleton() {
  return (
    <div className="card" style={{ overflow: 'hidden' }}>
      <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border-subtle)' }}>
        <div style={{ ...skeletonBlock, width: '180px', height: '14px' }} />
      </div>
      <div style={{ padding: '10px 12px', display: 'grid', gap: '8px' }}>
        {Array.from({ length: 8 }).map((_, index) => (
          <div
            key={index}
            style={{
              display: 'grid',
              gridTemplateColumns: '70px minmax(130px, 1fr) 90px 80px 120px',
              gap: '10px',
              alignItems: 'center',
              minWidth: 0,
            }}
          >
            <div style={{ ...skeletonBlock, height: '12px' }} />
            <div style={{ ...skeletonBlock, height: '12px', width: `${70 + (index % 3) * 8}%` }} />
            <div style={{ ...skeletonBlock, height: '12px' }} />
            <div style={{ ...skeletonBlock, height: '12px' }} />
            <div style={{ ...skeletonBlock, height: '12px' }} />
          </div>
        ))}
      </div>
      <div style={{ padding: '0 12px 12px', fontSize: '11px', color: 'var(--text-muted)' }}>
        初回表示用データを段階ロード中です。
      </div>
    </div>
  )
}

function fmtPct(v: number | undefined): string {
  if (v == null || !Number.isFinite(v)) return '---'
  const sign = v > 0 ? '+' : ''
  return `${sign}${v.toFixed(2)}%`
}

function fmtScore(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '---'
  return v.toFixed(2)
}

function fmtRate(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '---'
  return `${(v * 100).toFixed(0)}%`
}

function fmtLift(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '---'
  return `${v.toFixed(2)}x`
}

function scoreColor(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return 'var(--text-muted)'
  if (v > 0) return 'var(--price-up)'
  if (v < 0) return 'var(--price-down)'
  return 'var(--text-secondary)'
}

function pmsTrendSymbol(trend: StockRow['physicalMomentumTrend']): string {
  if (trend === 'rising') return '↑'
  if (trend === 'falling') return '↓'
  if (trend === 'flat') return '→'
  return ''
}

function shortTermTone(label: ShortTermCheckLabel) {
  switch (label) {
    case '強気優勢':
      return {
        color: 'var(--price-up)',
        border: 'rgba(220, 38, 38, 0.28)',
        background: 'rgba(220, 38, 38, 0.07)',
      }
    case '好転候補':
      return {
        color: '#0f766e',
        border: 'rgba(20, 184, 166, 0.3)',
        background: 'rgba(20, 184, 166, 0.07)',
      }
    case '下落警戒':
      return {
        color: 'var(--price-down)',
        border: 'rgba(37, 99, 235, 0.3)',
        background: 'rgba(37, 99, 235, 0.07)',
      }
    case '弱含み注意':
      return {
        color: '#1d4ed8',
        border: 'rgba(37, 99, 235, 0.22)',
        background: 'rgba(37, 99, 235, 0.05)',
      }
    default:
      return {
        color: 'var(--text-secondary)',
        border: 'var(--border-base)',
        background: 'var(--bg-elevated)',
      }
  }
}

function shortTermFilterChipStyle(label: ShortTermCheckLabel, active: boolean): React.CSSProperties {
  const tone = shortTermTone(label)
  return {
    ...mcChipStyle(false),
    background: active ? tone.color : tone.background,
    color: active ? '#fff' : tone.color,
    border: `1px solid ${active ? tone.color : tone.border}`,
    fontWeight: 700,
  }
}

function ShortTermCheckBadge({ row }: { row: StockRow }) {
  const tone = shortTermTone(row.shortTermCheckLabel)
  const strengthText = formatShortTermStrength(row.shortTermCheckLabel, row.shortTermCheckScore)
  const title = [
    `${strengthText}（内部スコア ${row.shortTermCheckScore.toFixed(2)} を0〜100換算）`,
    ...(row.shortTermCheckReasons ?? []),
    row.shortTermCheckMlText ? `ML類似: ${row.shortTermCheckMlText}` : null,
  ].filter(Boolean).join(' / ')
  return (
    <span
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '5px',
        border: `1px solid ${tone.border}`,
        background: tone.background,
        color: tone.color,
        borderRadius: '999px',
        padding: '3px 8px',
        fontSize: '11px',
        fontWeight: 800,
        whiteSpace: 'nowrap',
      }}
    >
      {row.shortTermCheckLabel}
      <small style={{ fontFamily: 'var(--font-mono)', opacity: 0.84 }}>
        / {strengthText}
      </small>
    </span>
  )
}

function physicalStatusTone(label: PhysicsStatus) {
  switch (label) {
    case '上昇加速':
    case '上昇継続':
      return {
        color: 'var(--price-up)',
        border: 'rgba(220, 38, 38, 0.28)',
        background: 'rgba(220, 38, 38, 0.07)',
      }
    case '押し目形成':
    case '反発準備':
      return {
        color: '#0f766e',
        border: 'rgba(20, 184, 166, 0.3)',
        background: 'rgba(20, 184, 166, 0.07)',
      }
    case '下落加速':
      return {
        color: 'var(--price-down)',
        border: 'rgba(37, 99, 235, 0.32)',
        background: 'rgba(37, 99, 235, 0.08)',
      }
    case '失速警戒':
      return {
        color: '#1d4ed8',
        border: 'rgba(37, 99, 235, 0.24)',
        background: 'rgba(37, 99, 235, 0.06)',
      }
    case '過熱注意':
      return {
        color: '#b45309',
        border: 'rgba(245, 158, 11, 0.34)',
        background: 'rgba(245, 158, 11, 0.1)',
      }
    default:
      return {
        color: 'var(--text-secondary)',
        border: 'var(--border-base)',
        background: 'var(--bg-elevated)',
      }
  }
}

function physicalStatusFilterChipStyle(label: PhysicsStatus, active: boolean): React.CSSProperties {
  const tone = physicalStatusTone(label)
  return {
    ...mcChipStyle(false),
    background: active ? tone.color : tone.background,
    color: active ? '#fff' : tone.color,
    border: `1px solid ${active ? tone.color : tone.border}`,
    fontWeight: 700,
  }
}

function PhysicalStatusBadge({ row }: { row: StockRow }) {
  const tone = physicalStatusTone(row.physicalStatusLabel)
  const confidence = physicalStatusConfidencePct(row)
  const source = row.physicalStatusSourceDate ? `特徴量日付 ${row.physicalStatusSourceDate}` : '特徴量未取得'
  const score = row.physicalStatusScore != null && Number.isFinite(row.physicalStatusScore)
    ? ` / 並び替えスコア ${row.physicalStatusScore.toFixed(1)}`
    : ''
  const target = row.physicalStatusTargetDirection === 'up'
    ? '上昇'
    : row.physicalStatusTargetDirection === 'down'
      ? '下落'
      : row.physicalStatusTargetDirection === 'wait'
        ? '見送り'
        : '未検証'
  const calibration = row.physicalStatusHitRate != null
    ? ` / 過去検証 ${row.physicalStatusHorizonDays ?? '-'}営業日 ${target}: 的中${fmtRate(row.physicalStatusHitRate)} base${fmtRate(row.physicalStatusBaseRate)} lift${fmtLift(row.physicalStatusLift)} 信頼${row.physicalStatusConfidence?.toFixed(0) ?? '-'} n=${row.physicalStatusSampleCount ?? '-'} 評価日${row.physicalStatusEvaluationDate ?? '-'}`
    : ' / 過去検証は次回ML日次後に反映'
  return (
    <span
      title={`${source}${score}${calibration}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '5px',
        border: `1px solid ${tone.border}`,
        background: tone.background,
        color: tone.color,
        borderRadius: '999px',
        padding: '3px 8px',
        fontSize: '11px',
        fontWeight: 800,
        whiteSpace: 'nowrap',
      }}
    >
      {row.physicalStatusLabel}
      {confidence != null ? (
        <small style={{ fontFamily: 'var(--font-mono)', opacity: 0.82 }}>
          確度{formatPhysicalConfidence(confidence)}
        </small>
      ) : row.physicalStatusScore != null && Number.isFinite(row.physicalStatusScore) && (
        <small style={{ fontFamily: 'var(--font-mono)', opacity: 0.78 }}>
          {row.physicalStatusScore.toFixed(0)}
        </small>
      )}
    </span>
  )
}

function physicalStatusConfidencePct(row: StockRow): number | null {
  if (row.physicalStatusConfidence != null && Number.isFinite(row.physicalStatusConfidence)) {
    return clampPercent(row.physicalStatusConfidence)
  }
  if (row.physicalStatusHitRate != null && Number.isFinite(row.physicalStatusHitRate)) {
    const hitRate = normalizeRate(row.physicalStatusHitRate)
    const baseRate = row.physicalStatusBaseRate != null && Number.isFinite(row.physicalStatusBaseRate)
      ? normalizeRate(row.physicalStatusBaseRate)
      : null
    const lift = row.physicalStatusLift != null && Number.isFinite(row.physicalStatusLift)
      ? row.physicalStatusLift
      : null
    const liftBonus = lift != null ? Math.max(-15, Math.min(15, (lift - 1) * 12)) : 0
    const baseBonus = baseRate != null ? Math.max(-12, Math.min(12, (hitRate - baseRate) * 35)) : 0
    return clampPercent((hitRate * 100) + liftBonus + baseBonus)
  }
  return null
}

function normalizeRate(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value > 1) return Math.max(0, Math.min(1, value / 100))
  return Math.max(0, Math.min(1, value))
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value))
}

function formatPhysicalConfidence(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '未検証'
  return `${Math.round(value)}%`
}

function fmtAngle(v: number | undefined): string {
  if (v == null || !Number.isFinite(v)) return '---'
  const sign = v > 0 ? '+' : ''
  return `${sign}${v.toFixed(2)}°`
}

function fmtAngleWithTrend(v: number | undefined): string {
  if (v == null || !Number.isFinite(v)) return '---'
  return fmtAngle(v)
}

function fmtLongSmaAngle(v: number | undefined): string {
  if (v == null || !Number.isFinite(v)) return '---'
  const label = ma200DirectionLabel(v)
  return `${label} ${fmtAngle(v)}`
}

function ma200DirectionOf(v: number | null | undefined): Ma200Direction | null {
  if (v == null || !Number.isFinite(v)) return null
  if (Math.abs(v) < MA200_FLAT_THRESHOLD) return 'flat'
  return v > 0 ? 'up' : 'down'
}

function ma200DirectionLabel(v: number | null | undefined): string {
  const direction = ma200DirectionOf(v)
  if (direction === 'up') return '上向き'
  if (direction === 'down') return '下向き'
  if (direction === 'flat') return '横ばい'
  return '判定不可'
}

function sma200Tone(v: number | undefined): string {
  if (v == null || !Number.isFinite(v)) return 'var(--text-muted)'
  if (ma200DirectionOf(v) === 'flat') return 'var(--text-secondary)'
  return pctColor(v)
}

function fmtMarketCap(row: StockRow): string {
  if (row.marketCap != null && row.marketCap > 0) {
    return `${(row.marketCap / 1e8).toLocaleString('ja-JP', { maximumFractionDigits: 0 })} 億`
  }
  if (row.marketCapStatus === 'not_applicable') return '対象外'
  if (row.marketCapStatus === 'shares_missing') return '未取得'
  if (row.marketCapStatus === 'price_missing') return '株価なし'
  return '未取得'
}

function earningsNextDisplay(row: StockRow): {
  label: string
  badge: string
  title: string
  color: string
  border: string
  background: string
} {
  const source = earningsSourceLabel(row.earningsNextDateSource)
  const fiscal = row.earningsNextFiscalPeriod ? ` / ${row.earningsNextFiscalPeriod}` : ''
  switch (row.earningsNextDateKind) {
    case 'confirmed':
      return {
        label: row.earningsNextDate ?? '公式予定',
        badge: source ? `公式 ${source}` : '公式予定',
        title: `公式ソースから取得した決算発表予定です${fiscal}。`,
        color: 'var(--accent-primary)',
        border: 'var(--accent-primary)',
        background: 'var(--bg-elevated)',
      }
    case 'estimated':
      return {
        label: row.earningsNextDate ?? '推定',
        badge: '推定',
        title: '公式予定が未公表のため、直近の決算発表日から約3か月後として推定しています。確定日は決算ページで公式取得後に置き換わります。',
        color: 'var(--text-secondary)',
        border: 'var(--border-base)',
        background: 'var(--bg-surface)',
      }
    case 'not_applicable':
      return {
        label: '対象外',
        badge: '対象外',
        title: 'ETF、REIT、投資法人など、通常の事業会社決算予定として扱わない銘柄です。',
        color: 'var(--text-muted)',
        border: 'var(--border-subtle)',
        background: 'var(--bg-elevated)',
      }
    case 'not_announced':
      return {
        label: '未公表',
        badge: '公式予定なし',
        title: '過去の決算履歴はありますが、基準日以降の公式予定はまだDBにありません。',
        color: 'var(--text-muted)',
        border: 'var(--border-subtle)',
        background: 'var(--bg-elevated)',
      }
    case 'no_history':
    default:
      return {
        label: '未取得',
        badge: '履歴なし',
        title: 'この銘柄の決算発表予定・履歴がDBにありません。JPX公式またはJ-Quants取得後に反映されます。',
        color: 'var(--text-muted)',
        border: 'var(--border-subtle)',
        background: 'var(--bg-elevated)',
      }
  }
}

function earningsLastDisplay(row: StockRow): {
  label: string
  badge: string
  title: string
  color: string
  border: string
  background: string
} {
  const source = earningsSourceLabel(row.earningsLastDateSource)
  const fiscal = row.earningsLastFiscalPeriod ? ` / ${row.earningsLastFiscalPeriod}` : ''
  switch (row.earningsLastDateKind) {
    case 'reported':
      return {
        label: row.earningsLastDate ?? '前回決算',
        badge: source ? source : '実績',
        title: `J-Quants等から取得した決算発表実績です${fiscal}。`,
        color: 'var(--accent-primary)',
        border: 'var(--accent-primary)',
        background: 'var(--bg-elevated)',
      }
    case 'not_applicable':
      return {
        label: '対象外',
        badge: '対象外',
        title: 'ETF、REIT、投資法人など、通常の事業会社決算として扱わない銘柄です。',
        color: 'var(--text-muted)',
        border: 'var(--border-subtle)',
        background: 'var(--bg-elevated)',
      }
    case 'unverified':
      return {
        label: '未検証',
        badge: '未検証',
        title: '表示中の日付が、DBに保存済みのJ-Quants決算実績より古いため、前回決算を検証できません。',
        color: 'var(--text-muted)',
        border: 'var(--border-subtle)',
        background: 'var(--bg-elevated)',
      }
    case 'not_collected':
    default:
      return {
        label: '未取得',
        badge: '未取得',
        title: '普通株ですが、J-Quants fins/summary 由来の決算実績がまだDBにありません。補完バッチの対象です。',
        color: 'var(--text-muted)',
        border: 'var(--border-subtle)',
        background: 'var(--bg-elevated)',
      }
  }
}

function earningsSourceLabel(source: string | null | undefined): string | null {
  if (source === 'jquants_fins_summary') return 'JQ実績'
  if (source === 'jpx') return 'JPX'
  if (source === 'jquants') return 'JQ'
  return null
}

function sortValue(row: StockRow, key: SortKey, referenceDate: string | null, tradingDates: string[]): unknown {
  if (key === 'earningsLastElapsedDays') return daysSince(row.earningsLastDate, referenceDate)
  if (key === 'earningsNextBusinessDays') return businessDaysUntil(row.earningsNextDate, referenceDate, tradingDates)
  if (key === 'marketSegment') return marketSegmentSortValue(row.marketSegment)
  return (row as unknown as Record<string, unknown>)[key]
}

function marketSegmentSortValue(segment: string | null | undefined): string {
  const normalized = marketSegmentFilterValue(segment)
  const matchedIndex = MARKET_SEGMENT_SORT_ORDER.findIndex((item) => normalized.includes(item))
  const order = matchedIndex >= 0 ? matchedIndex : MARKET_SEGMENT_SORT_ORDER.length
  return `${String(order).padStart(2, '0')}:${normalized}`
}

function marketSegmentFilterValue(segment: string | null | undefined): string {
  return segment?.trim() || '未設定'
}

function parseDateUtc(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr)
  if (!m) return null
  return Date.UTC(+m[1], +m[2] - 1, +m[3])
}

function referenceDateUtc(referenceDate: string | null): number {
  const parsed = parseDateUtc(referenceDate)
  if (parsed != null) return parsed
  const now = new Date()
  return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
}

function referenceDateIso(referenceDate: string | null): string {
  const parsed = parseDateUtc(referenceDate)
  const base = parsed ?? referenceDateUtc(null)
  return formatIsoUtc(base)
}

function formatIsoUtc(time: number): string {
  const d = new Date(time)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

function addDaysUtc(time: number, days: number): number {
  return time + days * 86400000
}

function isWeekdayUtc(time: number): boolean {
  const day = new Date(time).getUTCDay()
  return day >= 1 && day <= 5
}

/** 前回決算日から基準日までの経過日数。基準日は表示中のスナップショット日付。 */
function daysSince(dateStr: string | null | undefined, referenceDate: string | null): number | null {
  const target = parseDateUtc(dateStr)
  if (target == null) return null
  return Math.round((referenceDateUtc(referenceDate) - target) / 86400000)
}

/** 次回決算日までの残営業日数。DB内取引日を優先し、将来未収録分は平日換算する。 */
function businessDaysUntil(dateStr: string | null | undefined, referenceDate: string | null, tradingDates: string[]): number | null {
  const target = parseDateUtc(dateStr)
  if (target == null) return null
  const from = referenceDateIso(referenceDate)
  const to = formatIsoUtc(target)
  if (from === to) return 0
  if (to < from) return -countBusinessDaysForward(to, from, tradingDates)
  return countBusinessDaysForward(from, to, tradingDates)
}

function countBusinessDaysForward(fromExclusive: string, toInclusive: string, tradingDates: string[]): number {
  let count = tradingDates.filter((date) => date > fromExclusive && date <= toInclusive).length
  const latestTradingDate = tradingDates[tradingDates.length - 1]
  const fallbackStart = latestTradingDate && latestTradingDate > fromExclusive ? latestTradingDate : fromExclusive
  if (toInclusive > fallbackStart) {
    const start = parseDateUtc(fallbackStart)
    const end = parseDateUtc(toInclusive)
    if (start != null && end != null) {
      for (let time = addDaysUtc(start, 1); time <= end; time = addDaysUtc(time, 1)) {
        if (isWeekdayUtc(time)) count += 1
      }
    }
  }
  return count
}

function fmtDaysSince(d: number | null): string {
  if (d == null) return '---'
  if (d === 0) return '本日'
  if (d > 0) return `${d}日経過`
  return `${Math.abs(d)}日後`
}

function fmtBusinessDaysUntil(d: number | null): string {
  if (d == null) return '---'
  if (d === 0) return '本日'
  if (d > 0) return `${d}営業日`
  return `${d}営業日 (過去)`
}

function elapsedDaysColor(d: number | null): string {
  if (d == null) return 'var(--text-muted)'
  if (d < 0) return 'var(--accent-primary)'
  if (d <= 14) return 'var(--accent-primary)'
  if (d <= 45) return 'var(--text-secondary)'
  return 'var(--text-muted)'
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

function sortDirectionLabels(sort: SortState | null): { desc: string; asc: string } {
  if (!sort) return { desc: '多い順', asc: '少ない順' }
  const option = SORT_OPTIONS.find((item) => item.key === sort.key)
  return {
    desc: option?.descLabel ?? '降順',
    asc: option?.ascLabel ?? '昇順',
  }
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
      scope="col"
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
  return (
    <div className="card" style={{ padding: '6px 8px', opacity: disabled ? 0.5 : 1, display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '5px', minWidth: '58px' }}>
        <span style={{
          width: '8px',
          height: '8px',
          borderRadius: '50%',
          background: axis.color,
          flexShrink: 0,
        }} />
        <span style={{ fontSize: '12px', fontWeight: 600, whiteSpace: 'nowrap' }}>{axis.label}</span>
      </div>

      <div style={{ display: 'flex', gap: '3px', flex: 1, minWidth: 0 }}>
        {[1, 2, 3, 4, 5, 6].map((s) => {
          const active = selected.includes(s)
          return (
            <button
              key={s}
              disabled={disabled}
              onClick={() => onToggle(s)}
              style={{
                flex: 1,
                padding: '4px 0',
                fontSize: '12px',
                fontWeight: 700,
                fontFamily: 'var(--font-mono)',
                background: active ? axis.color : 'var(--bg-elevated)',
                color: active ? '#fff' : 'var(--text-secondary)',
                border: `1px solid ${active ? axis.color : 'var(--border-base)'}`,
                borderRadius: 'var(--radius-sm)',
                cursor: disabled ? 'not-allowed' : 'pointer',
              }}
            >
              {s}
            </button>
          )
        })}
      </div>

      {selected.length > 0 && (
        <button
          onClick={onClear}
          disabled={disabled}
          style={{
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

function MomentumNumberInput({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder: string
}) {
  return (
    <label style={momentumSelectLabelStyle}>
      {label}
      <input
        type="number"
        step="0.1"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        style={momentumInputStyle}
      />
    </label>
  )
}

function filterChipToneStyle(tone: ActiveFilterChip['tone'] = 'neutral'): React.CSSProperties {
  switch (tone) {
    case 'red':
      return {
        color: 'var(--price-up)',
        background: 'rgba(220, 38, 38, 0.07)',
        borderColor: 'rgba(220, 38, 38, 0.28)',
        border: '1px solid rgba(220, 38, 38, 0.28)',
      }
    case 'blue':
      return {
        color: 'var(--price-down)',
        background: 'rgba(37, 99, 235, 0.07)',
        borderColor: 'rgba(37, 99, 235, 0.28)',
        border: '1px solid rgba(37, 99, 235, 0.28)',
      }
    case 'green':
      return {
        color: '#0f766e',
        background: 'rgba(20, 184, 166, 0.08)',
        borderColor: 'rgba(20, 184, 166, 0.32)',
        border: '1px solid rgba(20, 184, 166, 0.32)',
      }
    case 'amber':
      return {
        color: '#b45309',
        background: 'rgba(245, 158, 11, 0.1)',
        borderColor: 'rgba(245, 158, 11, 0.34)',
        border: '1px solid rgba(245, 158, 11, 0.34)',
      }
    case 'purple':
      return {
        color: '#7c3aed',
        background: 'rgba(124, 58, 237, 0.08)',
        borderColor: 'rgba(124, 58, 237, 0.28)',
        border: '1px solid rgba(124, 58, 237, 0.28)',
      }
    default:
      return {
        color: 'var(--text-secondary)',
        background: 'var(--bg-elevated)',
        borderColor: 'var(--border-base)',
        border: '1px solid var(--border-base)',
      }
  }
}

const mcSelectStyle: React.CSSProperties = {
  padding: '5px 8px',
  fontSize: '12px',
  fontFamily: 'var(--font-mono)',
  background: 'var(--bg-elevated)',
  color: 'var(--text-primary)',
  border: '1px solid var(--border-base)',
  borderRadius: 'var(--radius-sm)',
  cursor: 'pointer',
  minWidth: '180px',
}

const momentumSelectLabelStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
  fontSize: '11px',
  color: 'var(--text-muted)',
  fontWeight: 600,
}

const momentumInputStyle: React.CSSProperties = {
  ...mcSelectStyle,
  minWidth: 0,
  width: '100%',
  cursor: 'text',
}

const mcChipStyle = (active: boolean): React.CSSProperties => ({
  padding: '6px 12px',
  fontSize: '11px',
  fontFamily: 'var(--font-mono)',
  background: active ? 'var(--accent-primary)' : 'var(--bg-elevated)',
  color: active ? '#fff' : 'var(--text-secondary)',
  border: `1px solid ${active ? 'var(--accent-primary)' : 'var(--border-base)'}`,
  borderRadius: 'var(--radius-sm)',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  fontWeight: active ? 600 : 400,
})

const skeletonBlock: React.CSSProperties = {
  width: '100%',
  borderRadius: '4px',
  background: 'linear-gradient(90deg, var(--bg-elevated), var(--bg-surface), var(--bg-elevated))',
  border: '1px solid var(--border-subtle)',
}

const th: React.CSSProperties = {
  padding: '8px 12px',
  textAlign: 'left',
  fontFamily: 'var(--font-mono)',
  fontWeight: 500,
  color: 'var(--text-muted)',
  fontSize: '11px',
  whiteSpace: 'nowrap',
  position: 'sticky',
  top: 0,
  zIndex: 3,
  background: 'var(--bg-elevated)',
  boxShadow: '0 1px 0 var(--border-dim)',
}
const thR: React.CSSProperties = { ...th, textAlign: 'right' }
const td: React.CSSProperties = { padding: '8px 12px', fontSize: '12px', color: 'var(--text-primary)', whiteSpace: 'nowrap' }
const tdR: React.CSSProperties = { ...td, textAlign: 'right', fontFamily: 'var(--font-mono)' }
