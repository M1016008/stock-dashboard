'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ArrowUpDown,
  CalendarRange,
  CircleHelp,
  GitCompareArrows,
  ListFilter,
  RefreshCw,
  RotateCcw,
  ScanSearch,
} from 'lucide-react'
import {
  BacktestHighlightChart,
  type HighlightChartPoint,
  type MovingAveragePeriod,
} from '@/components/charts/BacktestHighlightChart'
import { StageTag } from '@/components/ui/StageTag'
import { movingAverageColor } from '@/lib/chart-colors'
import type { OHLCV } from '@/types/stock'
import type {
  HistoricalAnalogProfile,
  HistoricalAnalogRecency,
  HistoricalAnalogSort,
} from '@/lib/ml/historical-analogs'
import {
  buildHistoricalAnalogChartSeries,
  type HistoricalAnalogChartInterval,
} from '@/lib/ml/historical-analog-chart'
import { CHART_INTERVAL_OPTIONS, type TimeframeUnit } from '@/lib/timeframes'
import { getUsSecondaryName } from '@/lib/us-symbol-aliases'

type Market = 'JP' | 'US'

function tickerNameLabel(market: Market, ticker: string, name: string | null): string {
  if (market === 'US') {
    const secondary = getUsSecondaryName(ticker, name)
    return secondary ? `${ticker} ${secondary}` : ticker
  }
  return `${ticker}${name ? ` ${name}` : ''}`
}
type AnalogTableSortKey =
  | 'rank'
  | 'recent'
  | 'ticker'
  | 'market'
  | 'sector17'
  | 'sector33'
  | 'margin'
  | 'similarity'
  | 'daily'
  | 'weekly'
  | 'monthly'
  | 'yearly'
  | 'ml'
  | 'volume'
  | 'avgVolume30'
  | 'volumeRatio30'
type AnalogTableSortDirection = 'asc' | 'desc'
type AnalogVolumeFilter = 'all' | 'above_avg' | 'below_avg' | 'surge' | 'missing'

type StructurePoint = HighlightChartPoint & {
  relativeDay: number
  ma5: number | null
  ma10: number | null
  ma20: number | null
  ma40: number | null
  ma60: number | null
  ma90: number | null
  ma200: number | null
}

type StagePoint = {
  relativeDay: number
  date: string
  stageCode: string
}

type AnalogRow = {
  rank: number
  ticker: string
  name: string | null
  marketSegment: string | null
  sector17Name: string | null
  sector33Name: string | null
  marginType: string | null
  caseStartDate: string
  caseEndDate: string
  elapsedDays: number
  recencyBucket: '2w' | '1m' | '3m' | 'older'
  stageCode: string | null
  similarityScore: number
  dailyScore: number | null
  weeklyScore: number | null
  monthlyScore: number | null
  yearlyScore: number | null
  mlFeatureScore: number | null
  mlFeaturePointCount: number
  mlFeatureTotalPoints: number
  approximationScore: number
  bandMatches: number
  volume: number | null
  avgVolume30: number | null
  volumeRatio30: number | null
  volumeObservationCount: number
  components: Array<{
    key: string
    label: string
    score: number
    weight: number
  }>
  window: StructurePoint[]
  stagePath: StagePoint[]
}

type AnalogResponse = {
  market: Market
  ticker: string
  latestMarketDate: string
  featureSet: string
  base: {
    ticker: string
    name: string | null
    startDate: string
    endDate: string
    sessionCount: number
    stageCode: string | null
    window: StructurePoint[]
    stagePath: StagePoint[]
  }
  profile: HistoricalAnalogProfile
  recency: HistoricalAnalogRecency
  sort: HistoricalAnalogSort
  minScore: number
  summary: {
    matchCount: number
    displayedCount: number
    sameTickerCount: number
    otherTickerCount: number
    latestMatchEndDate: string | null
    medianSimilarity: number | null
  }
  analogs: AnalogRow[]
  search: {
    method: string
    maPeriods: number[]
    maPeriodsByTimeframe: {
      daily: number[]
      weekly: number[]
      monthly: number[]
      yearly: number[]
    }
    periodSessions: number
    higherTimeframes: string[]
    scoringProfile: {
      key: string
      label: string
      weights: {
        daily: number
        weekly: number
        monthly: number
        yearly: number
      }
    }
    mlRerankWeight: number
    indexedCandidateCount: number
    coverageRejectedCount: number
    exactCoverageRejectedCount: number
    requiredComponents: string[]
    approximateCount: number
    stageCandidateCount: number
    stageShortlistCount: number
    retrievalPolicy: 'global-stage-first' | 'recency-first'
    recencyShortlistTarget: number
    recencyPoolCount: number
    recencyShortlistCount: number
    recencyStagePoolCount: number
    fallbackShortlistCount: number
    candidateRangeCount: number
    candidatePriceRowCount: number
    alignedCount: number
    dtwRerankCount: number
    scoredCount: number
    coverageFrom: string | null
    coverageTo: string | null
    indexSourceDate: string | null
    indexRows: number
    indexVersion: number
    indexFeatureSchema: string | null
    indexEmbeddingBytes: number | null
    truncated: boolean
  }
}

const PROFILE_OPTIONS: Array<{
  value: HistoricalAnalogProfile
  label: string
  description: string
  weights: string
}> = [
  {
    value: 'balanced',
    label: '標準',
    description: '日・週・月・年足の構造を総合して探します。迷った場合はこちら。',
    weights: '日足40%・週足25%・月足20%・年足15%',
  },
  {
    value: 'short',
    label: '日足を優先',
    description: '目先の値動きと移動平均線の形が近い局面を優先します。',
    weights: '日足55%・週足20%・月足15%・年足10%',
  },
  {
    value: 'long',
    label: '上位足を優先',
    description: '週・月・年足のトレンドや大局的な位置関係が近い局面を優先します。',
    weights: '日足25%・週足30%・月足25%・年足20%',
  },
]

const RECENCY_OPTIONS: Array<{
  value: HistoricalAnalogRecency
  label: string
}> = [
  { value: 'all', label: '全期間' },
  { value: '2w', label: '直近2週間' },
  { value: '1m', label: '直近1か月' },
  { value: '3m', label: '直近3か月' },
]

const SORT_OPTIONS: Array<{ value: HistoricalAnalogSort; label: string }> = [
  { value: 'similarity', label: '総合類似度' },
  { value: 'recent', label: '発生日が新しい順' },
]

const TABLE_SORT_OPTIONS: Array<{ value: AnalogTableSortKey; label: string }> = [
  { value: 'rank', label: '類似順位' },
  { value: 'recent', label: '発生日' },
  { value: 'similarity', label: '総合類似度' },
  { value: 'daily', label: '日足類似度' },
  { value: 'weekly', label: '週足類似度' },
  { value: 'monthly', label: '月足類似度' },
  { value: 'yearly', label: '年足類似度' },
  { value: 'ml', label: '学習特徴量' },
  { value: 'volume', label: '当日出来高' },
  { value: 'avgVolume30', label: '30日平均出来高' },
  { value: 'volumeRatio30', label: '出来高の平均比' },
  { value: 'ticker', label: '銘柄コード' },
  { value: 'market', label: '市場' },
  { value: 'sector17', label: '17業種' },
  { value: 'sector33', label: '33業種' },
  { value: 'margin', label: '貸借・信用区分' },
]

const ANALOG_MA_DEFAULTS: Record<
  HistoricalAnalogChartInterval,
  readonly MovingAveragePeriod[]
> = CHART_INTERVAL_OPTIONS.reduce((defaults, option) => {
  defaults[option.code] = option.defaultMaLines as MovingAveragePeriod[]
  return defaults
}, {} as Record<HistoricalAnalogChartInterval, readonly MovingAveragePeriod[]>)

const ANALOG_TIMEFRAME_META: Record<TimeframeUnit, {
  groupLabel: string
  maUnit: string
  description: string
}> = {
  day: { groupLabel: '日足系', maUnit: '日', description: '短期の値動きと日次MA' },
  week: { groupLabel: '週足系', maUnit: '週', description: '中期トレンドと週次MA' },
  month: { groupLabel: '月足系', maUnit: 'か月', description: '長期構造と月次MA' },
  year: { groupLabel: '年足系', maUnit: '年', description: '大局的な位置と年次MA' },
}

const ANALOG_CHART_INTERVALS: Array<{
  value: HistoricalAnalogChartInterval
  label: string
  timeframe: TimeframeUnit
  maUnit: string
  description: string
}> = CHART_INTERVAL_OPTIONS.map((option) => {
  const meta = ANALOG_TIMEFRAME_META[option.spec.timeframe]
  return {
    value: option.code,
    label: option.label,
    timeframe: option.spec.timeframe,
    maUnit: meta.maUnit,
    description: `${option.label}で見る${meta.description}`,
  }
})

const ANALOG_CHART_GROUPS = (['day', 'week', 'month', 'year'] as const).map(
  (timeframe) => ({
    timeframe,
    label: ANALOG_TIMEFRAME_META[timeframe].groupLabel,
    options: ANALOG_CHART_INTERVALS.filter((option) => option.timeframe === timeframe),
  }),
)

function initialMaSelections(): Record<
  HistoricalAnalogChartInterval,
  MovingAveragePeriod[]
> {
  return ANALOG_CHART_INTERVALS.reduce((selections, option) => {
    selections[option.value] = [...ANALOG_MA_DEFAULTS[option.value]]
    return selections
  }, {} as Record<HistoricalAnalogChartInterval, MovingAveragePeriod[]>)
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

function todayIso(): string {
  const now = new Date()
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 10)
}

function fmtScore(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return `${Math.round(value * 100)}%`
}

function fmtVolume(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return Math.round(value).toLocaleString('ja-JP')
}

function uniqueLabels(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))]
    .sort((a, b) => a.localeCompare(b, 'ja'))
}

function numericSortValue(row: AnalogRow, key: AnalogTableSortKey): number | null {
  if (key === 'rank') return row.rank
  if (key === 'recent') return row.elapsedDays
  if (key === 'similarity') return row.similarityScore
  if (key === 'daily') return row.dailyScore
  if (key === 'weekly') return row.weeklyScore
  if (key === 'monthly') return row.monthlyScore
  if (key === 'yearly') return row.yearlyScore
  if (key === 'ml') return row.mlFeatureScore
  if (key === 'volume') return row.volume
  if (key === 'avgVolume30') return row.avgVolume30
  if (key === 'volumeRatio30') return row.volumeRatio30
  return null
}

function textSortValue(row: AnalogRow, key: AnalogTableSortKey): string {
  if (key === 'ticker') return row.ticker
  if (key === 'market') return row.marketSegment ?? ''
  if (key === 'sector17') return row.sector17Name ?? ''
  if (key === 'sector33') return row.sector33Name ?? ''
  if (key === 'margin') return row.marginType ?? ''
  return ''
}

function compareAnalogRows(
  first: AnalogRow,
  second: AnalogRow,
  key: AnalogTableSortKey,
  direction: AnalogTableSortDirection,
): number {
  if (['ticker', 'market', 'sector17', 'sector33', 'margin'].includes(key)) {
    const compared = textSortValue(first, key).localeCompare(
      textSortValue(second, key),
      'ja',
      { numeric: true },
    )
    return direction === 'asc' ? compared : -compared
  }
  const firstValue = numericSortValue(first, key)
  const secondValue = numericSortValue(second, key)
  if (firstValue == null && secondValue == null) return first.rank - second.rank
  if (firstValue == null) return 1
  if (secondValue == null) return -1
  const compared = firstValue - secondValue
  return direction === 'asc' ? compared : -compared
}

function elapsedLabel(days: number): string {
  if (days === 0) return '市場最新日'
  if (days < 31) return `${days}日前`
  if (days < 365) return `${Math.max(1, Math.round(days / 30))}か月前`
  return `${(days / 365).toFixed(days < 730 ? 1 : 0)}年前`
}

function stageTags(code: string | null | undefined) {
  if (!code) {
    return <span className="text-[10px] font-bold text-[var(--color-text-tertiary)]">-----</span>
  }
  return (
    <span className="inline-flex gap-0.5">
      {code.split('').map((value, index) => {
        const stage = Number(value)
        return stage >= 1 && stage <= 6
          ? <StageTag key={`${value}-${index}`} stage={stage} size="xs" />
          : null
      })}
    </span>
  )
}

function AnalogPeriodChart({
  ticker,
  market,
  interval,
  points,
  maPeriods,
  label,
  startDate,
  endDate,
  currency,
}: {
  ticker: string
  market: Market
  interval: HistoricalAnalogChartInterval
  points: StructurePoint[]
  maPeriods: readonly MovingAveragePeriod[]
  label: string
  startDate: string
  endDate: string
  currency: 'JPY' | 'USD'
}) {
  const historyKey = `${market}:${ticker}`
  const [historyState, setHistoryState] = useState<{
    key: string
    rows: OHLCV[]
  } | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const history = historyState?.key === historyKey ? historyState.rows : null
  const activeInterval = ANALOG_CHART_INTERVALS.find((option) => option.value === interval)
    ?? ANALOG_CHART_INTERVALS[0]

  useEffect(() => {
    if (history) return
    const controller = new AbortController()
    const basePath = market === 'US' ? '/api/us/history' : '/api/history'
    setHistoryLoading(true)
    setHistoryError('')
    fetch(`${basePath}/${encodeURIComponent(ticker)}?period=all`, {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        const json = await response.json()
        if (!response.ok || !Array.isArray(json)) {
          throw new Error(json?.error ?? `HTTP ${response.status}`)
        }
        setHistoryState({ key: historyKey, rows: json as OHLCV[] })
      })
      .catch((fetchError) => {
        if (controller.signal.aborted) return
        setHistoryError(fetchError instanceof Error
          ? fetchError.message
          : '全履歴の取得に失敗しました。')
      })
      .finally(() => {
        if (!controller.signal.aborted) setHistoryLoading(false)
      })
    return () => controller.abort()
  }, [history, historyKey, market, ticker])

  const chartSeries = useMemo(() => {
    const fallbackRows: OHLCV[] = points.flatMap((point) => {
      if (
        point.open == null
        || point.high == null
        || point.low == null
        || point.close == null
      ) return []
      return [{
        date: point.date,
        open: point.open,
        high: point.high,
        low: point.low,
        close: point.close,
        volume: point.volume ?? 0,
      }]
    })
    return buildHistoricalAnalogChartSeries(
      history ?? fallbackRows,
      interval,
      startDate,
      endDate,
    )
  }, [endDate, history, interval, points, startDate])

  if (!chartSeries) {
    return (
      <div className="grid h-[280px] place-items-center text-[11px] font-bold text-[var(--color-text-tertiary)]">
        {historyLoading ? `${activeInterval.label}を作成中` : 'チャートデータがありません'}
      </div>
    )
  }

  const availableMaPeriods = maPeriods.filter((period) =>
    chartSeries.points.some((point) => point[`ma${period}`] != null)
  )
  return (
    <div aria-label={`${label}（${activeInterval.label}）`}>
      {historyLoading && (
        <div className="px-1 pt-1 text-[9px] font-bold text-teal-700">
          全履歴から{activeInterval.label}を作成中
        </div>
      )}
      {historyError && (
        <div className="px-1 pt-1 text-[9px] font-bold text-amber-700">
          取得済み範囲で表示：{historyError}
        </div>
      )}
      <BacktestHighlightChart
        series={chartSeries.points}
        highlightStart={chartSeries.highlightStart}
        highlightEnd={chartSeries.highlightEnd}
        direction={(chartSeries.returnPct ?? 0) >= 0 ? 'up' : 'down'}
        height={280}
        startPrice={chartSeries.startPrice}
        endPrice={chartSeries.endPrice}
        returnPct={chartSeries.returnPct}
        displayStartDate={startDate}
        displayEndDate={endDate}
        currency={currency}
        maPeriods={availableMaPeriods}
        showMovingAverages={availableMaPeriods.length > 0}
        showMovingAverageLegend={false}
        maUnitLabel={activeInterval.maUnit}
      />
    </div>
  )
}

function StageTimeline({ points }: { points: StagePoint[] }) {
  if (points.length === 0) {
    return <span className="text-[10px] font-bold text-[var(--color-text-tertiary)]">遷移データなし</span>
  }
  return (
    <div className="flex max-w-full items-center gap-1 overflow-x-auto pb-1">
      {points.map((point, index) => (
        <div key={`${point.date}-${point.stageCode}`} className="inline-flex shrink-0 items-center gap-1">
          {index > 0 && <span className="text-[10px] text-[var(--color-text-tertiary)]">→</span>}
          <span className="border border-[var(--color-border-soft)] bg-white px-1.5 py-1">
            <span className="mr-1 text-[9px] font-bold text-[var(--color-text-tertiary)]">
              {point.relativeDay + 1}日目
            </span>
            {stageTags(point.stageCode)}
          </span>
        </div>
      ))}
    </div>
  )
}

export function HistoricalAnalogExplorer({
  ticker,
  market = 'JP',
  analysisDate = null,
}: {
  ticker: string
  market?: Market
  analysisDate?: string | null
}) {
  const initialEndDate = analysisDate ?? todayIso()
  const [startDate, setStartDate] = useState(() => addDays(initialEndDate, -90))
  const [endDate, setEndDate] = useState(initialEndDate)
  const [profile, setProfile] = useState<HistoricalAnalogProfile>('balanced')
  const [recency, setRecency] = useState<HistoricalAnalogRecency>('all')
  const [sort, setSort] = useState<HistoricalAnalogSort>('similarity')
  const [minScore, setMinScore] = useState(0.4)
  const [chartInterval, setChartInterval] = useState<HistoricalAnalogChartInterval>('D')
  const [maSelections, setMaSelections] = useState<
    Record<HistoricalAnalogChartInterval, MovingAveragePeriod[]>
  >(initialMaSelections)
  const [data, setData] = useState<AnalogResponse | null>(null)
  const [selectedKey, setSelectedKey] = useState('')
  const [started, setStarted] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [marketFilter, setMarketFilter] = useState('all')
  const [sector17Filter, setSector17Filter] = useState('all')
  const [sector33Filter, setSector33Filter] = useState('all')
  const [marginFilter, setMarginFilter] = useState('all')
  const [volumeFilter, setVolumeFilter] = useState<AnalogVolumeFilter>('all')
  const [tableSortKey, setTableSortKey] = useState<AnalogTableSortKey>('rank')
  const [tableSortDirection, setTableSortDirection] =
    useState<AnalogTableSortDirection>('asc')

  const runSearch = useCallback(async () => {
    if (!startDate || !endDate) {
      setError('分析対象の開始日と終了日を指定してください。')
      return
    }
    if (startDate > endDate) {
      setError('開始日は終了日以前の日付を指定してください。')
      return
    }
    setStarted(true)
    setLoading(true)
    setError('')
    const params = new URLSearchParams({
      ticker: ticker.replace(/\.T$/i, ''),
      market,
      startDate,
      endDate,
      profile,
      recency,
      sort,
      minScore: String(minScore),
      limit: '40',
    })
    try {
      const response = await fetch(`/api/ml/historical-analogs?${params.toString()}`, {
        cache: 'no-store',
      })
      const json = await response.json()
      if (!response.ok) throw new Error(json.error ?? '本質類似局面の検索に失敗しました。')
      const next = json as AnalogResponse
      setData(next)
      setStartDate(next.base.startDate)
      setEndDate(next.base.endDate)
      setSelectedKey((current) => {
        if (
          next.analogs.some((row) =>
            `${row.ticker}-${row.caseStartDate}-${row.caseEndDate}` === current
          )
        ) return current
        const first = next.analogs[0]
        return first ? `${first.ticker}-${first.caseStartDate}-${first.caseEndDate}` : ''
      })
    } catch (searchError) {
      setData(null)
      setError(searchError instanceof Error
        ? searchError.message
        : '本質類似局面の検索に失敗しました。')
    } finally {
      setLoading(false)
    }
  }, [endDate, market, minScore, profile, recency, sort, startDate, ticker])

  useEffect(() => {
    const nextEndDate = analysisDate ?? todayIso()
    setStartDate(addDays(nextEndDate, -90))
    setEndDate(nextEndDate)
    setStarted(false)
    setData(null)
    setSelectedKey('')
    setError('')
    setMarketFilter('all')
    setSector17Filter('all')
    setSector33Filter('all')
    setMarginFilter('all')
    setVolumeFilter('all')
    setTableSortKey('rank')
    setTableSortDirection('asc')
  }, [analysisDate, market, ticker])

  const filterOptions = useMemo(() => ({
    marketSegments: uniqueLabels(data?.analogs.map((row) => row.marketSegment) ?? []),
    sector17Names: uniqueLabels(data?.analogs.map((row) => row.sector17Name) ?? []),
    sector33Names: uniqueLabels(data?.analogs.map((row) => row.sector33Name) ?? []),
    marginTypes: uniqueLabels(data?.analogs.map((row) => row.marginType) ?? []),
  }), [data])
  const displayedAnalogs = useMemo(() => {
    const rows = (data?.analogs ?? []).filter((row) => {
      if (marketFilter !== 'all' && row.marketSegment !== marketFilter) return false
      if (sector17Filter !== 'all' && row.sector17Name !== sector17Filter) return false
      if (sector33Filter !== 'all' && row.sector33Name !== sector33Filter) return false
      if (marginFilter !== 'all' && row.marginType !== marginFilter) return false
      if (volumeFilter === 'missing') return row.volume == null || row.avgVolume30 == null
      if (row.volume == null || row.avgVolume30 == null) return volumeFilter === 'all'
      if (volumeFilter === 'above_avg') return row.volume >= row.avgVolume30
      if (volumeFilter === 'below_avg') return row.volume < row.avgVolume30
      if (volumeFilter === 'surge') return row.volumeRatio30 != null && row.volumeRatio30 >= 1.5
      return true
    })
    return rows.sort((first, second) =>
      compareAnalogRows(first, second, tableSortKey, tableSortDirection)
      || first.rank - second.rank
    )
  }, [
    data,
    marginFilter,
    marketFilter,
    sector17Filter,
    sector33Filter,
    tableSortDirection,
    tableSortKey,
    volumeFilter,
  ])
  const selected = useMemo(
    () => displayedAnalogs.find((row) =>
      `${row.ticker}-${row.caseStartDate}-${row.caseEndDate}` === selectedKey
    ) ?? displayedAnalogs[0] ?? null,
    [displayedAnalogs, selectedKey],
  )
  const activeProfile = PROFILE_OPTIONS.find((option) => option.value === profile)
    ?? PROFILE_OPTIONS[0]
  const activeChartInterval = ANALOG_CHART_INTERVALS.find(
    (option) => option.value === chartInterval,
  ) ?? ANALOG_CHART_INTERVALS[0]
  const activeMaPeriods = maSelections[chartInterval]
  const toggleMaPeriod = (period: MovingAveragePeriod) => {
    setMaSelections((current) => {
      const selected = current[chartInterval]
      const next = selected.includes(period)
        ? selected.filter((value) => value !== period)
        : [...selected, period].sort((a, b) => a - b)
      return { ...current, [chartInterval]: next }
    })
  }

  return (
    <section className="overflow-hidden border border-[var(--color-border-default)] bg-white">
      <div className="flex flex-col gap-3 border-b border-[var(--color-border-default)] px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <ScanSearch size={17} className="shrink-0 text-teal-700" aria-hidden="true" />
            <h2 className="text-[14px] font-black text-[var(--color-text-primary)]">本質類似局面</h2>
          </div>
          <p className="mt-1 text-[10px] font-bold text-[var(--color-text-tertiary)]">
            指定期間の日足・週足・月足・年足を照合し、比較チャートは14時間軸で表示
          </p>
        </div>
        <button
          type="button"
          onClick={() => void runSearch()}
          disabled={loading}
          className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-[4px] bg-teal-700 px-3 text-[12px] font-black text-white hover:bg-teal-800 disabled:cursor-wait disabled:opacity-60"
        >
          {started ? <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> : <ScanSearch size={14} />}
          {loading ? '精密検索中' : started ? '条件を反映して再検索' : '本質類似局面を検索'}
        </button>
      </div>

      <div className="grid gap-3 border-b border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-3 py-3 sm:px-4 xl:grid-cols-[minmax(320px,1.1fr)_minmax(270px,.9fr)_minmax(320px,1fr)]">
        <div>
          <div className="mb-1.5 flex items-center gap-1 text-[10px] font-black text-[var(--color-text-tertiary)]">
            <CalendarRange size={12} aria-hidden="true" />
            分析対象期間
          </div>
          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
            <input
              type="date"
              value={startDate}
              onChange={(event) => setStartDate(event.target.value)}
              disabled={loading}
              aria-label="分析開始日"
              className="h-9 min-w-0 rounded-[3px] border border-[var(--color-border-default)] bg-white px-2 text-[11px] font-bold text-[var(--color-text-primary)] disabled:opacity-50"
            />
            <span className="text-[10px] font-black text-[var(--color-text-tertiary)]">〜</span>
            <input
              type="date"
              value={endDate}
              onChange={(event) => setEndDate(event.target.value)}
              disabled={loading}
              aria-label="分析終了日"
              className="h-9 min-w-0 rounded-[3px] border border-[var(--color-border-default)] bg-white px-2 text-[11px] font-bold text-[var(--color-text-primary)] disabled:opacity-50"
            />
          </div>
        </div>

        <div>
          <div className="mb-1.5 flex items-center gap-1 text-[10px] font-black text-[var(--color-text-tertiary)]">
            比較で重視する時間軸
            <span
              title="日足・週足・月足・年足を、総合類似度へどの割合で反映するかを選びます。"
              className="inline-flex"
            >
              <CircleHelp size={12} aria-hidden="true" />
            </span>
          </div>
          <div className="grid grid-cols-3 border border-[var(--color-border-default)] bg-white p-0.5">
            {PROFILE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setProfile(option.value)}
                disabled={loading}
                aria-pressed={profile === option.value}
                className={`h-8 px-1 text-[10px] font-black ${
                  profile === option.value
                    ? 'bg-teal-700 text-white'
                    : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-subtle)]'
                } disabled:opacity-50`}
              >
                {option.label}
              </button>
            ))}
          </div>
          <div className="mt-1.5 min-h-[34px] text-[9px] font-bold leading-[1.35] text-[var(--color-text-tertiary)]">
            <strong className="text-teal-700">{activeProfile.weights}</strong>
            <span className="ml-1">{activeProfile.description}</span>
          </div>
        </div>

        <div>
          <div className="mb-1.5 text-[10px] font-black text-[var(--color-text-tertiary)]">類似局面の発生時期</div>
          <div className="grid grid-cols-4 gap-1">
            {RECENCY_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setRecency(option.value)}
                disabled={loading}
                aria-pressed={recency === option.value}
                className={`h-9 min-w-0 rounded-[3px] border px-1 text-[10px] font-black ${
                  recency === option.value
                    ? 'border-teal-700 bg-teal-700 text-white'
                    : 'border-[var(--color-border-default)] bg-white text-[var(--color-text-secondary)] hover:border-teal-400'
                } disabled:opacity-50`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3 border-b border-[var(--color-border-soft)] px-3 py-2 sm:px-4">
        <label className="grid gap-1 text-[9px] font-black text-[var(--color-text-tertiary)]">
          並び順
          <select
            value={sort}
            onChange={(event) => setSort(event.target.value as HistoricalAnalogSort)}
            disabled={loading}
            className="h-8 min-w-[148px] rounded-[3px] border border-[var(--color-border-default)] bg-white px-2 text-[10px] font-bold text-[var(--color-text-primary)] disabled:opacity-50"
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-[9px] font-black text-[var(--color-text-tertiary)]">
          最低類似度
          <select
            value={minScore}
            onChange={(event) => setMinScore(Number(event.target.value))}
            disabled={loading}
            className="h-8 rounded-[3px] border border-[var(--color-border-default)] bg-white px-2 text-[10px] font-bold text-[var(--color-text-primary)]"
          >
            {[0.3, 0.35, 0.4, 0.45, 0.5, 0.55].map((value) => (
              <option key={value} value={value}>{Math.round(value * 100)}%</option>
            ))}
          </select>
        </label>
        <span className="pb-1 text-[9px] font-bold text-[var(--color-text-tertiary)]">
          5〜250営業日・同一市場内
        </span>
      </div>

      {!started && (
        <div className="grid min-h-[150px] place-items-center px-4 text-center">
          <div>
            <CalendarRange size={25} className="mx-auto text-teal-700" aria-hidden="true" />
            <div className="mt-2 text-[13px] font-black text-[var(--color-text-primary)]">
              比較したい期間を指定
            </div>
            <div className="mt-1 text-[10px] font-bold text-[var(--color-text-tertiary)]">
              開始日と終了日の取引日へ自動調整されます
            </div>
          </div>
        </div>
      )}

      {loading && !data && (
        <div className="grid gap-2 p-3 sm:grid-cols-2 sm:p-4">
          <div className="h-[360px] animate-pulse border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)]" />
          <div className="h-[360px] animate-pulse border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)]" />
        </div>
      )}

      {error && (
        <div role="alert" className="m-3 border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] font-bold text-rose-800 sm:m-4">
          {error}
        </div>
      )}

      {data && (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 pt-3 text-[9px] font-bold text-[var(--color-text-tertiary)] sm:px-4">
            <span>基準 {data.base.startDate}〜{data.base.endDate}</span>
            <span>{data.base.sessionCount}営業日</span>
            <span>市場最新 {data.latestMarketDate}</span>
            <span>履歴 {data.search.coverageFrom ?? '-'}〜{data.search.coverageTo ?? '-'}</span>
            <span>索引 {data.search.indexRows.toLocaleString('ja-JP')}局面</span>
            <span>
              アンカー D {data.search.maPeriodsByTimeframe.daily.join('/')}
              {' · '}W {data.search.maPeriodsByTimeframe.weekly.join('/')}
              {' · '}M {data.search.maPeriodsByTimeframe.monthly.join('/')}
              {' · '}Y {data.search.maPeriodsByTimeframe.yearly.join('/')}
            </span>
            <span>精密再評価 {data.search.dtwRerankCount.toLocaleString('ja-JP')}局面</span>
            <span>{data.search.scoringProfile.label}</span>
            <span>学習特徴量 最大{Math.round(data.search.mlRerankWeight * 100)}%</span>
            {data.search.truncated && <span className="font-black text-amber-700">候補上限到達</span>}
          </div>

          <div className="mx-3 mt-3 grid grid-cols-2 border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] sm:mx-4 sm:grid-cols-5">
            {[
              {
                label: '該当 / 表示',
                value: `${data.summary.matchCount} / ${data.summary.displayedCount}件`,
              },
              { label: '同一銘柄', value: `${data.summary.sameTickerCount}件` },
              { label: '他銘柄', value: `${data.summary.otherTickerCount}件` },
              { label: '類似度中央値', value: fmtScore(data.summary.medianSimilarity) },
              { label: '最新の類似局面', value: data.summary.latestMatchEndDate ?? '-' },
            ].map((item) => (
              <div key={item.label} className="min-w-0 border-b border-r border-[var(--color-border-soft)] px-2 py-2.5 text-center last:border-r-0 sm:border-b-0">
                <div className="truncate text-[9px] font-black text-[var(--color-text-tertiary)]">{item.label}</div>
                <div className="mt-1 truncate text-[13px] font-black text-[var(--color-text-primary)]">{item.value}</div>
              </div>
            ))}
          </div>

          {selected && (
            <div className="mx-3 mt-4 border border-[var(--color-border-default)] bg-white sm:mx-4">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border-soft)] px-3 py-2.5">
                <div className="flex min-w-0 items-center gap-2">
                  <GitCompareArrows size={15} className="shrink-0 text-teal-700" />
                  <span className="text-[12px] font-black text-[var(--color-text-primary)]">指定期間比較</span>
                  <span className="text-[9px] font-bold text-[var(--color-text-tertiary)]">
                    黄色の範囲が比較対象・前後の値動きも表示
                  </span>
                </div>
                <span className="shrink-0 border border-amber-300 bg-amber-100 px-2 py-1 text-[9px] font-black text-amber-800">
                  黄色 = 指定期間
                </span>
              </div>
              <div className="grid gap-2 border-b border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-3 py-2">
                <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
                  <div>
                    <div className="text-[9px] font-black text-[var(--color-text-tertiary)]">
                      チャート時間軸（14種類）
                    </div>
                    <div className="mt-0.5 text-[9px] font-bold text-[var(--color-text-secondary)]">
                      {activeChartInterval.description}
                    </div>
                  </div>
                  <div className="grid w-full gap-1.5 sm:grid-cols-2 lg:w-[620px]">
                    {ANALOG_CHART_GROUPS.map((group) => (
                      <div
                        key={group.timeframe}
                        className="grid grid-cols-[42px_minmax(0,1fr)] items-center border border-[var(--color-border-default)] bg-white p-0.5"
                      >
                        <span className="px-1 text-[9px] font-black text-[var(--color-text-tertiary)]">
                          {group.label}
                        </span>
                        <div
                          className="grid"
                          style={{
                            gridTemplateColumns: `repeat(${group.options.length}, minmax(0, 1fr))`,
                          }}
                        >
                          {group.options.map((option) => (
                            <button
                              key={option.value}
                              type="button"
                              onClick={() => setChartInterval(option.value)}
                              aria-pressed={chartInterval === option.value}
                              className={`h-8 whitespace-nowrap px-0.5 text-[9px] font-black sm:px-1 sm:text-[10px] ${
                                chartInterval === option.value
                                  ? 'bg-teal-700 text-white'
                                  : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-subtle)]'
                              }`}
                            >
                              {option.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                <fieldset className="flex flex-wrap items-center gap-2 border-t border-[var(--color-border-soft)] pt-2">
                  <legend className="sr-only">{activeChartInterval.label}の移動平均線</legend>
                  <span className="mr-1 text-[9px] font-black text-[var(--color-text-tertiary)]">
                    移動平均線
                  </span>
                  {ANALOG_MA_DEFAULTS[chartInterval].map((period) => {
                    const checked = activeMaPeriods.includes(period)
                    return (
                      <label
                        key={period}
                        className={`inline-flex h-7 cursor-pointer items-center gap-1.5 border px-2 text-[9px] font-black ${
                          checked
                            ? 'border-[var(--color-border-default)] bg-white text-[var(--color-text-primary)]'
                            : 'border-[var(--color-border-soft)] bg-transparent text-[var(--color-text-tertiary)]'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleMaPeriod(period)}
                          aria-label={`${period}${activeChartInterval.maUnit}移動平均線`}
                          className="h-3.5 w-3.5 accent-teal-700"
                        />
                        <span
                          aria-hidden="true"
                          className="h-0.5 w-3"
                          style={{ backgroundColor: movingAverageColor(period) }}
                        />
                        {period}{activeChartInterval.maUnit}
                      </label>
                    )
                  })}
                  {activeMaPeriods.length === 0 && (
                    <span className="text-[9px] font-bold text-[var(--color-text-tertiary)]">
                      すべて非表示
                    </span>
                  )}
                </fieldset>
              </div>
              <div className="grid min-w-0 lg:grid-cols-2">
                <div className="min-w-0 border-b border-[var(--color-border-soft)] p-2 lg:border-b-0 lg:border-r">
                  <div className="flex items-center justify-between gap-2 px-1">
                    <div className="truncate text-[11px] font-black text-[var(--color-text-primary)]">
                      基準 {tickerNameLabel(market, data.base.ticker, data.base.name)}
                    </div>
                    <span className="shrink-0 text-[9px] font-bold text-[var(--color-text-tertiary)]">
                      {data.base.startDate}〜{data.base.endDate}
                    </span>
                  </div>
                  <AnalogPeriodChart
                    ticker={data.base.ticker}
                    market={market}
                    interval={chartInterval}
                    points={data.base.window}
                    maPeriods={activeMaPeriods}
                    label={`${data.base.ticker}の指定期間チャート`}
                    startDate={data.base.startDate}
                    endDate={data.base.endDate}
                    currency={market === 'US' ? 'USD' : 'JPY'}
                  />
                  <div className="border-t border-[var(--color-border-soft)] px-1 pt-2">
                    <div className="mb-1 text-[9px] font-black text-[var(--color-text-tertiary)]">
                      日足6ステージ推移
                    </div>
                    <StageTimeline points={data.base.stagePath} />
                  </div>
                </div>
                <div className="min-w-0 p-2">
                  <div className="flex items-center justify-between gap-2 px-1">
                    <Link
                      href={market === 'US'
                        ? `/us/stock/${encodeURIComponent(selected.ticker)}?date=${selected.caseEndDate}`
                        : `/stock/${encodeURIComponent(selected.ticker)}?date=${selected.caseEndDate}`}
                      className="min-w-0 truncate text-[11px] font-black text-[var(--color-brand-700)] hover:text-[var(--color-market-red)]"
                    >
                      類似 {tickerNameLabel(market, selected.ticker, selected.name)}
                    </Link>
                    <span className="shrink-0 text-[9px] font-bold text-[var(--color-text-tertiary)]">
                      {selected.caseStartDate}〜{selected.caseEndDate}
                    </span>
                  </div>
                  <AnalogPeriodChart
                    ticker={selected.ticker}
                    market={market}
                    interval={chartInterval}
                    points={selected.window}
                    maPeriods={activeMaPeriods}
                    label={`${selected.ticker}の類似期間チャート`}
                    startDate={selected.caseStartDate}
                    endDate={selected.caseEndDate}
                    currency={market === 'US' ? 'USD' : 'JPY'}
                  />
                  <div className="border-t border-[var(--color-border-soft)] px-1 pt-2">
                    <div className="mb-1 text-[9px] font-black text-[var(--color-text-tertiary)]">
                      日足6ステージ推移
                    </div>
                    <StageTimeline points={selected.stagePath} />
                  </div>
                </div>
              </div>

              <div className="grid border-t border-[var(--color-border-default)] lg:grid-cols-[minmax(0,1fr)_340px]">
                <div className="grid grid-cols-2 sm:grid-cols-5">
                  {[
                    { label: '総合類似度', value: selected.similarityScore },
                    { label: '日足', value: selected.dailyScore },
                    { label: '週足', value: selected.weeklyScore },
                    { label: '月足', value: selected.monthlyScore },
                    { label: '年足', value: selected.yearlyScore },
                  ].map((item) => (
                    <div key={item.label} className="border-b border-r border-[var(--color-border-soft)] px-3 py-3 text-center lg:border-b-0">
                      <div className="text-[9px] font-black text-[var(--color-text-tertiary)]">{item.label}</div>
                      <div className={`mt-1 text-[18px] font-black ${item.label === '総合類似度' ? 'text-teal-700' : 'text-[var(--color-text-primary)]'}`}>
                        {fmtScore(item.value)}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="min-w-0 p-3">
                  <div className="flex items-center justify-between gap-2 border-b border-[var(--color-border-soft)] pb-2">
                    <span className="text-[10px] font-black text-[var(--color-text-primary)]">
                      {selected.caseEndDate} に終了
                    </span>
                    <span className="text-[10px] font-black text-teal-700">
                      市場最新から {elapsedLabel(selected.elapsedDays)}
                    </span>
                  </div>
                  <div className="mt-2 grid gap-1.5">
                    {selected.components.map((component) => (
                      <div key={component.key} className="grid grid-cols-[64px_1fr_38px] items-center gap-2">
                        <span className="truncate text-[9px] font-black text-[var(--color-text-secondary)]">
                          {component.label}
                        </span>
                        <div className="h-1.5 bg-[var(--color-surface-muted)]">
                          <div className="h-full bg-teal-600" style={{ width: `${Math.max(2, component.score * 100)}%` }} />
                        </div>
                        <span className="text-right text-[9px] font-black text-teal-700">
                          {fmtScore(component.score)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {data.analogs.length > 0 && (
            <div className="mx-3 mt-4 border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] sm:mx-4">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border-soft)] px-3 py-2">
                <div className="flex items-center gap-2">
                  <ListFilter size={14} className="text-teal-700" aria-hidden="true" />
                  <span className="text-[11px] font-black text-[var(--color-text-primary)]">
                    ランキング絞り込み・ソート
                  </span>
                  <span className="text-[9px] font-bold text-[var(--color-text-tertiary)]">
                    表示中{data.analogs.length}件を対象
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-black tabular-nums text-teal-700">
                    {displayedAnalogs.length}件表示
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setMarketFilter('all')
                      setSector17Filter('all')
                      setSector33Filter('all')
                      setMarginFilter('all')
                      setVolumeFilter('all')
                      setTableSortKey('rank')
                      setTableSortDirection('asc')
                    }}
                    title="絞り込みとソートを初期状態へ戻す"
                    className="inline-flex h-7 items-center gap-1 border border-[var(--color-border-default)] bg-white px-2 text-[9px] font-black text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-muted)]"
                  >
                    <RotateCcw size={11} aria-hidden="true" />
                    リセット
                  </button>
                </div>
              </div>
              <div className="grid gap-2 p-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
                <label className="min-w-0">
                  <span className="mb-1 block text-[9px] font-black text-[var(--color-text-tertiary)]">市場</span>
                  <select
                    value={marketFilter}
                    onChange={(event) => setMarketFilter(event.target.value)}
                    className="h-8 w-full min-w-0 border border-[var(--color-border-default)] bg-white px-2 text-[10px] font-bold text-[var(--color-text-primary)]"
                  >
                    <option value="all">すべて</option>
                    {filterOptions.marketSegments.map((value) => (
                      <option key={value} value={value}>{value}</option>
                    ))}
                  </select>
                </label>
                <label className="min-w-0">
                  <span className="mb-1 block text-[9px] font-black text-[var(--color-text-tertiary)]">17業種</span>
                  <select
                    value={sector17Filter}
                    onChange={(event) => setSector17Filter(event.target.value)}
                    className="h-8 w-full min-w-0 border border-[var(--color-border-default)] bg-white px-2 text-[10px] font-bold text-[var(--color-text-primary)]"
                  >
                    <option value="all">すべて</option>
                    {filterOptions.sector17Names.map((value) => (
                      <option key={value} value={value}>{value}</option>
                    ))}
                  </select>
                </label>
                <label className="min-w-0">
                  <span className="mb-1 block text-[9px] font-black text-[var(--color-text-tertiary)]">33業種</span>
                  <select
                    value={sector33Filter}
                    onChange={(event) => setSector33Filter(event.target.value)}
                    className="h-8 w-full min-w-0 border border-[var(--color-border-default)] bg-white px-2 text-[10px] font-bold text-[var(--color-text-primary)]"
                  >
                    <option value="all">すべて</option>
                    {filterOptions.sector33Names.map((value) => (
                      <option key={value} value={value}>{value}</option>
                    ))}
                  </select>
                </label>
                <label className="min-w-0">
                  <span className="mb-1 block text-[9px] font-black text-[var(--color-text-tertiary)]">貸借・信用</span>
                  <select
                    value={marginFilter}
                    onChange={(event) => setMarginFilter(event.target.value)}
                    className="h-8 w-full min-w-0 border border-[var(--color-border-default)] bg-white px-2 text-[10px] font-bold text-[var(--color-text-primary)]"
                  >
                    <option value="all">すべて</option>
                    {filterOptions.marginTypes.map((value) => (
                      <option key={value} value={value}>{value}</option>
                    ))}
                  </select>
                </label>
                <label className="min-w-0">
                  <span className="mb-1 block text-[9px] font-black text-[var(--color-text-tertiary)]">出来高</span>
                  <select
                    value={volumeFilter}
                    onChange={(event) => setVolumeFilter(event.target.value as AnalogVolumeFilter)}
                    className="h-8 w-full min-w-0 border border-[var(--color-border-default)] bg-white px-2 text-[10px] font-bold text-[var(--color-text-primary)]"
                  >
                    <option value="all">すべて</option>
                    <option value="above_avg">30日平均以上</option>
                    <option value="below_avg">30日平均未満</option>
                    <option value="surge">30日平均の1.5倍以上</option>
                    <option value="missing">データなし</option>
                  </select>
                </label>
                <label className="min-w-0">
                  <span className="mb-1 flex items-center gap-1 text-[9px] font-black text-[var(--color-text-tertiary)]">
                    <ArrowUpDown size={10} aria-hidden="true" />
                    一覧ソート
                  </span>
                  <select
                    value={tableSortKey}
                    onChange={(event) => {
                      const next = event.target.value as AnalogTableSortKey
                      setTableSortKey(next)
                      setTableSortDirection(
                        next === 'rank' || next === 'recent' || next === 'ticker' ? 'asc' : 'desc',
                      )
                    }}
                    className="h-8 w-full min-w-0 border border-[var(--color-border-default)] bg-white px-2 text-[10px] font-bold text-[var(--color-text-primary)]"
                  >
                    {TABLE_SORT_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
                <label className="min-w-0">
                  <span className="mb-1 block text-[9px] font-black text-[var(--color-text-tertiary)]">並び方向</span>
                  <select
                    value={tableSortDirection}
                    onChange={(event) =>
                      setTableSortDirection(event.target.value as AnalogTableSortDirection)
                    }
                    className="h-8 w-full min-w-0 border border-[var(--color-border-default)] bg-white px-2 text-[10px] font-bold text-[var(--color-text-primary)]"
                  >
                    <option value="desc">降順（大きい順）</option>
                    <option value="asc">昇順（小さい順）</option>
                  </select>
                </label>
              </div>
            </div>
          )}

          {data.analogs.length === 0 ? (
            <div className="mx-3 my-4 border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-3 py-5 text-center text-[12px] font-bold text-[var(--color-text-tertiary)] sm:mx-4">
              指定条件に合う本質類似局面は見つかりませんでした。
            </div>
          ) : displayedAnalogs.length === 0 ? (
            <div className="mx-3 my-4 border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-3 py-5 text-center text-[12px] font-bold text-[var(--color-text-tertiary)] sm:mx-4">
              絞り込み条件に合う候補はありません。条件を変更するかリセットしてください。
            </div>
          ) : (
            <div className="mx-3 my-4 overflow-x-auto border border-[var(--color-border-default)] sm:mx-4">
              <table className="w-full min-w-[1480px] border-collapse text-left">
                <thead className="bg-[var(--color-surface-subtle)] text-[9px] font-black text-[var(--color-text-tertiary)]">
                  <tr>
                    <th className="w-10 px-2 py-2 text-center">類似順位</th>
                    <th className="px-2 py-2">銘柄・類似期間</th>
                    <th className="px-2 py-2">市場・取引区分</th>
                    <th className="px-2 py-2">17・33業種</th>
                    <th className="px-2 py-2">発生日</th>
                    <th className="px-2 py-2 text-center">ステージ</th>
                    <th className="px-2 py-2 text-right">総合</th>
                    <th className="px-2 py-2 text-right">日足</th>
                    <th className="px-2 py-2 text-right">週足</th>
                    <th className="px-2 py-2 text-right">月足</th>
                    <th className="px-2 py-2 text-right">年足</th>
                    <th className="px-2 py-2 text-right">学習特徴量</th>
                    <th className="px-2 py-2 text-right">出来高・30日平均</th>
                  </tr>
                </thead>
                <tbody>
                  {displayedAnalogs.map((row) => {
                    const key = `${row.ticker}-${row.caseStartDate}-${row.caseEndDate}`
                    const active = key === `${selected?.ticker}-${selected?.caseStartDate}-${selected?.caseEndDate}`
                    return (
                      <tr
                        key={key}
                        onClick={() => setSelectedKey(key)}
                        onKeyDown={(event) => {
                          if (event.key !== 'Enter' && event.key !== ' ') return
                          event.preventDefault()
                          setSelectedKey(key)
                        }}
                        tabIndex={0}
                        aria-selected={active}
                        className={`cursor-pointer border-t border-[var(--color-border-soft)] text-[10px] font-bold ${
                          active ? 'bg-teal-50' : 'bg-white hover:bg-[var(--color-surface-subtle)]'
                        }`}
                      >
                        <td className="px-2 py-2.5 text-center">
                          <span className={`inline-grid h-5 min-w-5 place-items-center rounded-full px-1 text-[9px] font-black ${
                            active
                              ? 'bg-teal-700 text-white'
                              : 'bg-[var(--color-surface-muted)] text-[var(--color-text-secondary)]'
                          }`}>
                            {row.rank}
                          </span>
                        </td>
                        <td className="px-2 py-2.5">
                          <div className="font-black text-[var(--color-brand-800)]">{tickerNameLabel(market, row.ticker, row.name)}</div>
                          <div className="mt-0.5 text-[9px] text-[var(--color-text-tertiary)]">
                            {row.caseStartDate}〜{row.caseEndDate}
                          </div>
                        </td>
                        <td className="px-2 py-2.5">
                          <div className="font-black text-[var(--color-text-primary)]">
                            {row.marketSegment ?? '市場未分類'}
                          </div>
                          <div className="mt-0.5 text-[9px] text-[var(--color-text-tertiary)]">
                            {row.marginType ?? (market === 'JP' ? '信用区分未登録' : '信用区分対象外')}
                          </div>
                        </td>
                        <td className="px-2 py-2.5">
                          <div className="font-black text-[var(--color-text-primary)]">
                            17: {row.sector17Name ?? '未分類'}
                          </div>
                          <div className="mt-0.5 text-[9px] text-[var(--color-text-tertiary)]">
                            33: {row.sector33Name ?? '未分類'}
                          </div>
                        </td>
                        <td className="px-2 py-2.5">
                          <div className="font-black text-[var(--color-text-primary)]">{row.caseEndDate}</div>
                          <div className="mt-0.5 text-[9px] text-[var(--color-text-tertiary)]">{elapsedLabel(row.elapsedDays)}</div>
                        </td>
                        <td className="px-2 py-2.5 text-center">{stageTags(row.stageCode)}</td>
                        <td className="px-2 py-2.5 text-right text-[12px] font-black text-teal-700">{fmtScore(row.similarityScore)}</td>
                        <td className="px-2 py-2.5 text-right text-[var(--color-text-secondary)]">{fmtScore(row.dailyScore)}</td>
                        <td className="px-2 py-2.5 text-right text-[var(--color-text-secondary)]">{fmtScore(row.weeklyScore)}</td>
                        <td className="px-2 py-2.5 text-right text-[var(--color-text-secondary)]">{fmtScore(row.monthlyScore)}</td>
                        <td className="px-2 py-2.5 text-right text-[var(--color-text-secondary)]">{fmtScore(row.yearlyScore)}</td>
                        <td className="px-2 py-2.5 text-right text-[var(--color-text-secondary)]">
                          <div>{fmtScore(row.mlFeatureScore)}</div>
                          {row.mlFeaturePointCount > 0 && (
                            <div className="mt-0.5 text-[8px] text-[var(--color-text-tertiary)]">
                              {row.mlFeaturePointCount}/{row.mlFeatureTotalPoints}時点
                            </div>
                          )}
                        </td>
                        <td className="px-2 py-2.5 text-right">
                          <div className="font-black tabular-nums text-[var(--color-text-primary)]">
                            {fmtVolume(row.volume)}
                          </div>
                          <div className="mt-0.5 text-[9px] tabular-nums text-[var(--color-text-tertiary)]">
                            平均 {fmtVolume(row.avgVolume30)}
                          </div>
                          <div className={`mt-0.5 text-[9px] font-black tabular-nums ${
                            row.volumeRatio30 != null && row.volumeRatio30 >= 1.5
                              ? 'text-amber-700'
                              : 'text-[var(--color-text-secondary)]'
                          }`}>
                            {row.volumeRatio30 == null ? '-' : `${row.volumeRatio30.toFixed(2)}倍`}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  )
}
