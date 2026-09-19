'use client'

import Link from 'next/link'
import {
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import {
  ArrowDown,
  ArrowUp,
  Bookmark,
  CalendarDays,
  CircleHelp,
  ChevronLeft,
  ChevronRight,
  Copy,
  LoaderCircle,
  Pencil,
  Save,
  Search,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-react'
import { DataPopover } from '@/components/shared/DataPopover'
import { StageTag } from '@/components/ui/StageTag'
import { WatchlistButton } from '@/components/ui/WatchlistButton'
import { TriggerMiniChart } from '@/components/trigger-discovery/TriggerMiniChart'
import { TriggerNotificationSettingsPanel } from '@/components/trigger-discovery/TriggerNotificationSettingsPanel'
import { TriggerScoreCell } from '@/components/trigger-discovery/TriggerScoreCell'
import { HistoricalScanWorkspace } from '@/components/trigger-discovery/HistoricalScanWorkspace'
import {
  TRIGGER_DISCOVERY_STAGE_AXES,
  type TriggerDiscoveryOptionsResponse,
  type TriggerDiscoveryMiniChart,
  type TriggerDiscoveryMiniChartsResponse,
  type TriggerDiscoverySearchRequest,
  type TriggerDiscoverySearchResponse,
  type TriggerDiscoverySortKey,
  type TriggerDiscoveryStageAxis,
  type TriggerDiscoveryStageFilters,
  type TriggerDiscoveryStageFilterValue,
} from '@/lib/trigger-discovery-contract'
import { DEFAULT_MA_ZONE_TRIGGER_CONFIG } from '@/lib/trigger-discovery-engine'
import {
  DEFAULT_TRIGGER_DISCOVERY_TIMEFRAME,
  type TriggerDiscoveryTimeframe,
} from '@/lib/trigger-discovery-timeframe'
import type { TriggerHistoricalScanRequest } from '@/lib/trigger-discovery-historical-scan-contract'
import {
  parseTriggerDiscoveryNavigationSnapshot,
  serializeTriggerDiscoveryNavigationSnapshot,
  TRIGGER_DISCOVERY_NAVIGATION_HISTORY_KEY,
  TRIGGER_DISCOVERY_NAVIGATION_STORAGE_KEY,
  type TriggerDiscoveryNavigationDraft,
  type TriggerDiscoveryNavigationPayload,
} from '@/lib/client/trigger-discovery-navigation-restore'
import {
  DEFAULT_TRIGGER_MAX_PRICE_STALENESS_SESSIONS,
  SAVED_TRIGGER_CONTRACT_VERSION,
  savedTriggerConfigsFromSearchRequest,
  searchRequestFromSavedTrigger,
  type SavedTriggerDefinition,
  type SavedTriggerDetailResponse,
  type SavedTriggerListResponse,
  type SavedTriggerViewConfig,
} from '@/lib/trigger-definition'

const STAGE_AXIS_LABELS: Record<TriggerDiscoveryStageAxis, string> = {
  dayAStage: '日A',
  dayBStage: '日B',
  weekAStage: '週A',
  weekBStage: '週B',
  monthAStage: '月A',
  monthBStage: '月B',
}

const STATUS_LABELS = {
  IN_ZONE: 'ゾーン内',
  NEAR: '近接',
  APPROACHING: '接近中',
  NOT_MATCHED: '対象外',
  BELOW_ZONE: '下方',
} as const

const STATUS_STYLES = {
  IN_ZONE: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  NEAR: 'border-amber-200 bg-amber-50 text-amber-800',
  APPROACHING: 'border-sky-200 bg-sky-50 text-sky-800',
  NOT_MATCHED: 'border-slate-200 bg-slate-50 text-slate-600',
  BELOW_ZONE: 'border-slate-200 bg-slate-50 text-slate-600',
} as const

interface Props {
  options: TriggerDiscoveryOptionsResponse
}

type DraftState = TriggerDiscoveryNavigationDraft
type DraftStringKey = {
  [Key in keyof DraftState]-?: NonNullable<DraftState[Key]> extends string ? Key : never
}[keyof DraftState]

type SaveMode = 'create' | 'update' | 'copy' | 'rename'
type DiscoveryMode = 'current' | 'period'

function monthsBefore(date: string | null, months: number): string {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return ''
  const value = new Date(`${date}T12:00:00Z`)
  value.setUTCMonth(value.getUTCMonth() - months)
  return value.toISOString().slice(0, 10)
}

function parseOptionalNumber(value: string): number | null {
  const normalized = value.replaceAll(',', '').trim()
  return normalized === '' ? null : Number(normalized)
}

function numberOrDash(value: number | null, formatter: Intl.NumberFormat): string {
  return value == null ? '—' : formatter.format(value)
}

function percent(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`
}

function compactAmount(value: number | null): string {
  if (value == null) return '—'
  if (Math.abs(value) >= 100_000_000) return `${(value / 100_000_000).toFixed(1)}億`
  if (Math.abs(value) >= 10_000) return `${(value / 10_000).toFixed(1)}万`
  return new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 0 }).format(value)
}

function activeCriteriaSummary(request: TriggerDiscoverySearchRequest | null): string {
  if (!request) return ''
  const parts: string[] = [
    `Trigger距離 ${request.maxApproachDistancePct}%`,
    `Near ${request.nearDistancePct}%`,
    '2本とも上向き',
    '上から接近',
    request.markets?.length ? request.markets.map((market) => market ?? '市場区分なし').join(' / ') : '全市場',
  ]
  if (request.priceMin != null || request.priceMax != null) {
    const minimum = request.priceMin == null ? '下限なし' : `${compactAmount(request.priceMin)}円`
    const maximum = request.priceMax == null ? '上限なし' : `${compactAmount(request.priceMax)}円`
    parts.push(`株価 ${minimum}〜${maximum}`)
  }
  if (request.averageTradingValueMin != null || request.averageTradingValueMax != null) {
    const minimum = request.averageTradingValueMin == null ? '下限なし' : `${compactAmount(request.averageTradingValueMin)}円`
    const maximum = request.averageTradingValueMax == null ? '上限なし' : `${compactAmount(request.averageTradingValueMax)}円`
    parts.push(`売買代金 ${minimum}〜${maximum}`)
  }
  const stageAxisCount = Object.values(request.stageFilters ?? {}).filter((values) => values?.length).length
  if (stageAxisCount > 0) parts.push(`Stage条件 ${stageAxisCount}軸`)
  if (request.spreadExpansionEnabled) {
    parts.push(`MA間隔拡大 ${request.spreadLookbackIntervals ?? 4}区間 / ${Math.round((request.minExpansionRatio ?? 0.7) * 100)}%`)
  }
  if (request.belowZoneToleranceEnabled) parts.push(`Zone下抜け ${request.maxBelowZonePct ?? 3}%まで`)
  if (request.statusFilter) parts.push(`表示: ${STATUS_LABELS[request.statusFilter]}`)
  return parts.join(' ・ ')
}

function miniChartKey(input: {
  ticker: string
  timeframe: TriggerDiscoveryTimeframe
  requestedAsOf: string
  resolvedAsOf: string | null
  ma1Period: number
  ma2Period: number
}): string {
  return [input.ticker, input.timeframe, input.requestedAsOf, input.resolvedAsOf ?? '', input.ma1Period, input.ma2Period].join('|')
}

function SortButton({
  label,
  sortKey,
  activeSort,
  onSort,
  ariaLabel,
  align = 'start',
}: {
  label: string
  sortKey: TriggerDiscoverySortKey
  activeSort: TriggerDiscoverySearchRequest['sort']
  onSort: (key: TriggerDiscoverySortKey) => void
  ariaLabel?: string
  align?: 'start' | 'center' | 'end'
}) {
  const active = activeSort?.key === sortKey
  const alignment = align === 'end' ? 'justify-end' : align === 'center' ? 'justify-center' : 'justify-start'
  return (
    <button
      type="button"
      onClick={() => onSort(sortKey)}
      className={`inline-flex w-full items-center ${alignment} gap-0.5 whitespace-nowrap rounded-[2px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--color-brand-200)] ${active ? 'font-semibold text-[var(--color-brand-800)]' : 'font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-brand-700)]'}`}
      aria-label={`${ariaLabel ?? label}で並べ替え${active ? `（現在${activeSort?.direction === 'asc' ? '昇順' : '降順'}）` : ''}`}
    >
      {label}
      {active && activeSort?.direction === 'asc'
        ? <ArrowUp size={12} className="text-[var(--color-brand-700)]" aria-hidden />
        : active && activeSort?.direction === 'desc'
          ? <ArrowDown size={12} className="text-[var(--color-brand-700)]" aria-hidden />
          : <span className="w-[11px] text-center text-[9px] text-[var(--color-text-tertiary)] opacity-40">↕</span>}
    </button>
  )
}

function HelpPopover({ title, children, align = 'center' }: {
  title: string
  children: ReactNode
  align?: 'start' | 'center' | 'end'
}) {
  return (
    <DataPopover
      trigger={<CircleHelp size={13} aria-hidden />}
      title={title}
      align={align}
      triggerAriaLabel={`${title}の説明`}
      triggerTitle={`${title}の説明`}
      triggerClassName="h-5 w-5 shrink-0 justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand-200)]"
      showPatternBadge={false}
      openOnHover
      className="max-w-[calc(100vw-24px)] text-[11px] leading-5"
    >
      <div className="space-y-2 text-[11px] leading-5 text-[var(--color-text-secondary)]">
        {children}
      </div>
    </DataPopover>
  )
}

function Field({ label, value, onChange, suffix, type = 'text', min, max, help, action }: {
  label: string
  value: string
  onChange: (value: string) => void
  suffix?: string
  type?: 'text' | 'number' | 'date'
  min?: number
  max?: number
  help?: ReactNode
  action?: ReactNode
}) {
  const inputId = useId()
  return (
    <div className="block min-w-0">
      <span className="mb-1 flex min-h-5 items-center justify-between gap-1 text-[10px] font-medium text-[var(--color-text-tertiary)]">
        <span className="flex items-center gap-0.5">
          <label htmlFor={inputId}>{label}</label>
          {help}
        </span>
        {action}
      </span>
      <span className="flex h-9 items-center rounded-[4px] border border-[var(--color-border)] bg-white px-2 focus-within:border-[var(--color-brand-500)] focus-within:ring-1 focus-within:ring-[var(--color-brand-100)]">
        <input
          id={inputId}
          type={type}
          value={value}
          min={min}
          max={max}
          onChange={(event) => onChange(event.target.value)}
          className="min-w-0 flex-1 bg-transparent text-[13px] tabular-nums text-[var(--color-text-primary)] outline-none"
        />
        {suffix && <span className="ml-1 shrink-0 text-[10px] text-[var(--color-text-tertiary)]">{suffix}</span>}
      </span>
    </div>
  )
}

export function TriggerDiscoveryClient({ options }: Props) {
  const [mode, setMode] = useState<DiscoveryMode>('current')
  const [timeframe, setTimeframe] = useState<TriggerDiscoveryTimeframe>(DEFAULT_TRIGGER_DISCOVERY_TIMEFRAME)
  const [historicalStartDate, setHistoricalStartDate] = useState(monthsBefore(options.latestAsOf, 3))
  const [historicalEndDate, setHistoricalEndDate] = useState(options.latestAsOf ?? '')
  const [draft, setDraft] = useState<DraftState>({
    asOf: options.latestAsOf ?? '',
    ma1Period: '20',
    ma2Period: '25',
    maxDistance: '5',
    nearDistance: '2',
    spreadExpansionEnabled: false,
    spreadLookbackIntervals: String(DEFAULT_MA_ZONE_TRIGGER_CONFIG.spreadLookbackIntervals),
    minExpansionRatioPct: String(DEFAULT_MA_ZONE_TRIGGER_CONFIG.minExpansionRatio * 100),
    requireBullishMaOrder: true,
    belowZoneToleranceEnabled: false,
    maxBelowZonePct: String(DEFAULT_MA_ZONE_TRIGGER_CONFIG.maxBelowZonePct),
    priceMin: '',
    priceMax: '',
    averageVolumeMin: '',
    averageVolumeMax: '',
    averageTradingValueMin: '',
    averageTradingValueMax: '',
    liquidityLookbackSessions: '20',
  })
  const [selectedMarkets, setSelectedMarkets] = useState<Array<string | null>>([])
  const [stageFilters, setStageFilters] = useState<TriggerDiscoveryStageFilters>({})
  const [effectiveEngineConfig, setEffectiveEngineConfig] = useState({
    slopeLookbackSessions: DEFAULT_MA_ZONE_TRIGGER_CONFIG.slopeLookbackSessions,
    approachLookbackSessions: DEFAULT_MA_ZONE_TRIGGER_CONFIG.approachLookbackSessions,
    minimumAboveZoneRatio: DEFAULT_MA_ZONE_TRIGGER_CONFIG.minimumAboveZoneRatio,
    maxPriceStalenessSessions: DEFAULT_TRIGGER_MAX_PRICE_STALENESS_SESSIONS,
  })
  const [viewConfig, setViewConfig] = useState<SavedTriggerViewConfig>({ sort: null, pageSize: 50, statusFilter: null })
  const [response, setResponse] = useState<TriggerDiscoverySearchResponse | null>(null)
  const [lastRequest, setLastRequest] = useState<TriggerDiscoverySearchRequest | null>(null)
  const [builderOpen, setBuilderOpen] = useState(true)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestSequence = useRef(0)
  const abortController = useRef<AbortController | null>(null)
  const resultsTableRef = useRef<HTMLDivElement | null>(null)
  const pendingScrollRestore = useRef<TriggerDiscoveryNavigationPayload['scroll'] | null>(null)
  const restoredNavigation = useRef(false)
  const miniChartSequence = useRef(0)
  const miniChartAbortController = useRef<AbortController | null>(null)
  const miniChartCache = useRef(new Map<string, TriggerDiscoveryMiniChart>())
  const [, setMiniChartVersion] = useState(0)
  const [miniChartLoadingKeys, setMiniChartLoadingKeys] = useState<Set<string>>(new Set())
  const [miniChartFailedKeys, setMiniChartFailedKeys] = useState<Set<string>>(new Set())
  const [savedTriggers, setSavedTriggers] = useState<SavedTriggerDefinition[]>([])
  const [selectedSavedId, setSelectedSavedId] = useState('')
  const [activeSavedId, setActiveSavedId] = useState<string | null>(null)
  const [saveMode, setSaveMode] = useState<SaveMode | null>(null)
  const [saveName, setSaveName] = useState('')
  const [savedLoading, setSavedLoading] = useState(true)
  const [savedBusy, setSavedBusy] = useState(false)
  const [savedError, setSavedError] = useState<string | null>(null)
  const [savedMessage, setSavedMessage] = useState<string | null>(null)
  const numberFormatter = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 0 })

  const updateDraft = (key: DraftStringKey, value: string) => {
    setDraft((current) => ({ ...current, [key]: value }))
  }

  const validateAndBuildRequest = (requestedAsOf = draft.asOf): TriggerDiscoverySearchRequest => {
    const ma1Period = Number(draft.ma1Period)
    const ma2Period = Number(draft.ma2Period)
    const maxApproachDistancePct = Number(draft.maxDistance)
    const nearDistancePct = Number(draft.nearDistance)
    const spreadLookbackIntervals = Number(draft.spreadLookbackIntervals)
    const minExpansionRatio = Number(draft.minExpansionRatioPct) / 100
    const maxBelowZonePct = Number(draft.maxBelowZonePct ?? DEFAULT_MA_ZONE_TRIGGER_CONFIG.maxBelowZonePct)
    const liquidityLookbackSessions = Number(draft.liquidityLookbackSessions)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedAsOf)) throw new Error('基準日を指定してください。')
    if (![ma1Period, ma2Period].every((value) => Number.isInteger(value) && value >= 2 && value <= 120)) {
      throw new Error(`MA期間は2〜120${timeframe === 'BIWEEKLY' ? '本' : 'か月'}で指定してください。`)
    }
    if (ma1Period === ma2Period) throw new Error('MA1とMA2は異なる期間にしてください。')
    if (!Number.isFinite(maxApproachDistancePct) || maxApproachDistancePct < 0 || maxApproachDistancePct > 100) {
      throw new Error('Trigger距離は0〜100%で指定してください。')
    }
    if (!Number.isFinite(nearDistancePct) || nearDistancePct < 0 || nearDistancePct > maxApproachDistancePct) {
      throw new Error('Near閾値は0以上、Trigger距離以下で指定してください。')
    }
    if (!Number.isInteger(spreadLookbackIntervals) || spreadLookbackIntervals < 2 || spreadLookbackIntervals > 24) {
      throw new Error('MA間隔の比較区間は2〜24で指定してください。')
    }
    if (!Number.isFinite(minExpansionRatio) || minExpansionRatio < 0 || minExpansionRatio > 1) {
      throw new Error('MA間隔の拡大区間比率は0〜100%で指定してください。')
    }
    if (!Number.isFinite(maxBelowZonePct) || maxBelowZonePct <= 0 || maxBelowZonePct > 20) {
      throw new Error('最大下抜け幅は0より大きく20%以下で指定してください。')
    }
    if (!Number.isInteger(liquidityLookbackSessions) || liquidityLookbackSessions < 1 || liquidityLookbackSessions > 252) {
      throw new Error('平均期間は1〜252営業日で指定してください。')
    }
    const ranges = [
      ['株価', parseOptionalNumber(draft.priceMin), parseOptionalNumber(draft.priceMax)],
      ['平均出来高', parseOptionalNumber(draft.averageVolumeMin), parseOptionalNumber(draft.averageVolumeMax)],
      ['平均売買代金', parseOptionalNumber(draft.averageTradingValueMin), parseOptionalNumber(draft.averageTradingValueMax)],
    ] as const
    for (const [label, min, max] of ranges) {
      if ((min != null && (!Number.isFinite(min) || min < 0)) || (max != null && (!Number.isFinite(max) || max < 0))) {
        throw new Error(`${label}は0以上の数値で指定してください。`)
      }
      if (min != null && max != null && min > max) throw new Error(`${label}の下限が上限を超えています。`)
    }
    return {
      requestedAsOf,
      timeframe,
      ma1Period,
      ma2Period,
      slopeLookbackSessions: effectiveEngineConfig.slopeLookbackSessions,
      approachLookbackSessions: effectiveEngineConfig.approachLookbackSessions,
      minimumAboveZoneRatio: effectiveEngineConfig.minimumAboveZoneRatio,
      maxApproachDistancePct,
      nearDistancePct,
      spreadExpansionEnabled: draft.spreadExpansionEnabled,
      spreadLookbackIntervals,
      minExpansionRatio,
      requireBullishMaOrder: draft.requireBullishMaOrder,
      belowZoneToleranceEnabled: draft.belowZoneToleranceEnabled ?? false,
      maxBelowZonePct,
      markets: selectedMarkets.length ? selectedMarkets : undefined,
      priceMin: ranges[0][1],
      priceMax: ranges[0][2],
      averageVolumeMin: ranges[1][1],
      averageVolumeMax: ranges[1][2],
      averageTradingValueMin: ranges[2][1],
      averageTradingValueMax: ranges[2][2],
      liquidityLookbackSessions,
      maxPriceStalenessSessions: effectiveEngineConfig.maxPriceStalenessSessions,
      stageFilters,
      sort: viewConfig.sort,
      page: 1,
      pageSize: viewConfig.pageSize,
      statusFilter: viewConfig.statusFilter ?? null,
    }
  }

  const validateAndBuildHistoricalRequest = (): TriggerHistoricalScanRequest => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(historicalStartDate) || !/^\d{4}-\d{2}-\d{2}$/.test(historicalEndDate)) {
      throw new Error('開始日と終了日を指定してください。')
    }
    if (historicalStartDate > historicalEndDate) throw new Error('開始日は終了日以前にしてください。')
    const request = validateAndBuildRequest(historicalEndDate)
    return {
      startDate: historicalStartDate,
      endDate: historicalEndDate,
      timeframe: request.timeframe,
      ma1Period: request.ma1Period,
      ma2Period: request.ma2Period,
      slopeLookbackSessions: request.slopeLookbackSessions,
      approachLookbackSessions: request.approachLookbackSessions,
      minimumAboveZoneRatio: request.minimumAboveZoneRatio,
      maxApproachDistancePct: request.maxApproachDistancePct,
      nearDistancePct: request.nearDistancePct,
      spreadExpansionEnabled: request.spreadExpansionEnabled,
      spreadLookbackIntervals: request.spreadLookbackIntervals,
      minExpansionRatio: request.minExpansionRatio,
      requireBullishMaOrder: request.requireBullishMaOrder,
      belowZoneToleranceEnabled: request.belowZoneToleranceEnabled,
      maxBelowZonePct: request.maxBelowZonePct,
      markets: request.markets,
      priceMin: request.priceMin,
      priceMax: request.priceMax,
      averageVolumeMin: request.averageVolumeMin,
      averageVolumeMax: request.averageVolumeMax,
      averageTradingValueMin: request.averageTradingValueMin,
      averageTradingValueMax: request.averageTradingValueMax,
      liquidityLookbackSessions: request.liquidityLookbackSessions,
      maxPriceStalenessSessions: request.maxPriceStalenessSessions,
      stageFilters: request.stageFilters,
    }
  }

  const runSearch = async (request: TriggerDiscoverySearchRequest, collapseBuilderOnSuccess = false) => {
    abortController.current?.abort()
    const controller = new AbortController()
    abortController.current = controller
    const sequence = ++requestSequence.current
    setLoading(true)
    setError(null)
    try {
      const apiResponse = await fetch('/api/trigger-discovery/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        cache: 'no-store',
        signal: controller.signal,
      })
      const body = await apiResponse.json() as TriggerDiscoverySearchResponse | { message?: string }
      if (!apiResponse.ok) throw new Error('message' in body && body.message ? body.message : '検索に失敗しました。')
      if (sequence !== requestSequence.current) return
      setResponse(body as TriggerDiscoverySearchResponse)
      setLastRequest(request)
      if (collapseBuilderOnSuccess) setBuilderOpen(false)
    } catch (searchError) {
      if (controller.signal.aborted || sequence !== requestSequence.current) return
      setError(searchError instanceof Error ? searchError.message : '検索に失敗しました。')
    } finally {
      if (sequence === requestSequence.current) setLoading(false)
    }
  }

  const submit = async () => {
    try {
      await runSearch(validateAndBuildRequest(), true)
    } catch (validationError) {
      setError(validationError instanceof Error ? validationError.message : '入力内容を確認してください。')
    }
  }

  const toggleMarket = (market: string | null) => {
    setSelectedMarkets((current) => current.some((value) => value === market)
      ? current.filter((value) => value !== market)
      : [...current, market])
  }

  const toggleStage = (axis: TriggerDiscoveryStageAxis, value: TriggerDiscoveryStageFilterValue) => {
    setStageFilters((current) => {
      const values = current[axis] ?? []
      const next = values.includes(value) ? values.filter((item) => item !== value) : [...values, value]
      const copy = { ...current }
      if (next.length) copy[axis] = next
      else delete copy[axis]
      return copy
    })
  }

  const applyStageFilters = () => {
    if (!lastRequest) return
    void runSearch({ ...lastRequest, stageFilters, page: 1 })
  }

  const changeSort = (key: TriggerDiscoverySortKey) => {
    if (!lastRequest) return
    const direction = lastRequest.sort?.key === key && lastRequest.sort.direction === 'asc' ? 'desc' : 'asc'
    const sort = { key, direction } as const
    setViewConfig((current) => ({ ...current, sort }))
    void runSearch({ ...lastRequest, sort, stageFilters, page: 1 })
  }

  const changePage = (page: number) => {
    if (!lastRequest) return
    void runSearch({ ...lastRequest, stageFilters, page })
  }

  const changePageSize = (pageSize: number) => {
    if (!lastRequest) return
    setViewConfig((current) => ({ ...current, pageSize: pageSize as SavedTriggerViewConfig['pageSize'] }))
    void runSearch({ ...lastRequest, stageFilters, pageSize, page: 1 })
  }

  const changeStatusFilter = (statusFilter: SavedTriggerViewConfig['statusFilter']) => {
    setViewConfig((current) => ({ ...current, statusFilter }))
    if (lastRequest) void runSearch({ ...lastRequest, statusFilter, page: 1 })
  }

  const activeSort = lastRequest?.sort ?? null
  const sortAria = (key: TriggerDiscoverySortKey): 'ascending' | 'descending' | 'none' => (
    activeSort?.key === key ? (activeSort.direction === 'asc' ? 'ascending' : 'descending') : 'none'
  )
  const firstResult = response && response.meta.returnedCount > 0
    ? (response.meta.page - 1) * response.meta.pageSize + 1
    : 0
  const lastResult = response ? firstResult + response.meta.returnedCount - 1 : 0
  const isHistoricalResult = Boolean(
    response?.meta.resolvedAsOf
    && options.latestAsOf
    && response.meta.resolvedAsOf < options.latestAsOf,
  )
  const criteriaSummary = activeCriteriaSummary(lastRequest)
  const spreadExpansionActive = response?.criteria.spreadExpansionEnabled ?? false

  const activeSavedTrigger = savedTriggers.find((definition) => definition.id === activeSavedId) ?? null
  let hasUnsavedChanges = false
  if (activeSavedTrigger) {
    try {
      const current = savedTriggerConfigsFromSearchRequest(validateAndBuildRequest())
      hasUnsavedChanges = JSON.stringify(current.evaluationConfig) !== JSON.stringify(activeSavedTrigger.evaluationConfig)
        || JSON.stringify(current.viewConfig) !== JSON.stringify(activeSavedTrigger.viewConfig)
    } catch {
      hasUnsavedChanges = true
    }
  }

  const fetchSavedTriggers = async (): Promise<SavedTriggerDefinition[]> => {
    const apiResponse = await fetch('/api/trigger-discovery/saved', { cache: 'no-store' })
    const body = await apiResponse.json() as SavedTriggerListResponse | { message?: string }
    if (!apiResponse.ok || !('definitions' in body)) {
      throw new Error('message' in body && body.message ? body.message : '保存済みTriggerを取得できませんでした。')
    }
    if (body.contractVersion !== SAVED_TRIGGER_CONTRACT_VERSION) {
      throw new Error('保存済みTriggerの契約バージョンが一致しません。')
    }
    setSavedTriggers(body.definitions)
    return body.definitions
  }

  const clearSearchResult = () => {
    abortController.current?.abort()
    miniChartAbortController.current?.abort()
    requestSequence.current += 1
    miniChartSequence.current += 1
    setLoading(false)
    setResponse(null)
    setLastRequest(null)
    setBuilderOpen(true)
    setError(null)
    setMiniChartLoadingKeys(new Set())
    setMiniChartFailedKeys(new Set())
  }

  const preserveBeforeStockNavigation = (event: ReactMouseEvent<HTMLAnchorElement>) => {
    if (
      event.defaultPrevented
      || event.button !== 0
      || event.metaKey
      || event.ctrlKey
      || event.shiftKey
      || event.altKey
      || mode !== 'current'
      || !response
      || !lastRequest
    ) return

    try {
      const returnToken = window.crypto.randomUUID()
      const returnUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`
      const payload: TriggerDiscoveryNavigationPayload = {
        mode: 'current',
        timeframe,
        draft,
        selectedMarkets,
        stageFilters,
        effectiveEngineConfig,
        viewConfig,
        response,
        lastRequest,
        builderOpen,
        selectedSavedId,
        activeSavedId,
        scroll: {
          windowY: window.scrollY,
          resultsTableX: resultsTableRef.current?.scrollLeft ?? 0,
          resultsTableY: resultsTableRef.current?.scrollTop ?? 0,
        },
      }
      window.sessionStorage.setItem(
        TRIGGER_DISCOVERY_NAVIGATION_STORAGE_KEY,
        serializeTriggerDiscoveryNavigationSnapshot({ returnToken, returnUrl, payload }),
      )
      const historyState = typeof window.history.state === 'object' && window.history.state !== null
        ? window.history.state as Record<string, unknown>
        : {}
      window.history.replaceState(
        { ...historyState, [TRIGGER_DISCOVERY_NAVIGATION_HISTORY_KEY]: returnToken },
        '',
        window.location.href,
      )
    } catch {
      try {
        window.sessionStorage.removeItem(TRIGGER_DISCOVERY_NAVIGATION_STORAGE_KEY)
      } catch {
        // Navigation still works when session storage is unavailable.
      }
    }
  }

  const loadSavedTrigger = async () => {
    if (!selectedSavedId) return
    setSavedBusy(true)
    setSavedError(null)
    setSavedMessage(null)
    try {
      const apiResponse = await fetch(`/api/trigger-discovery/saved/${selectedSavedId}`, { cache: 'no-store' })
      const body = await apiResponse.json() as SavedTriggerDetailResponse | { message?: string }
      if (!apiResponse.ok || !('definition' in body)) {
        throw new Error('message' in body && body.message ? body.message : '保存済みTriggerを読み込めませんでした。')
      }
      if (body.contractVersion !== SAVED_TRIGGER_CONTRACT_VERSION) {
        throw new Error('保存済みTriggerの契約バージョンが一致しません。')
      }
      const definition = body.definition
      const request = searchRequestFromSavedTrigger(definition, options.latestAsOf ?? draft.asOf)
      clearSearchResult()
      setTimeframe(request.timeframe ?? 'MONTHLY')
      setDraft({
        asOf: request.requestedAsOf,
        ma1Period: String(request.ma1Period),
        ma2Period: String(request.ma2Period),
        maxDistance: String(request.maxApproachDistancePct),
        nearDistance: String(request.nearDistancePct),
        spreadExpansionEnabled: request.spreadExpansionEnabled ?? false,
        spreadLookbackIntervals: String(
          request.spreadLookbackIntervals ?? DEFAULT_MA_ZONE_TRIGGER_CONFIG.spreadLookbackIntervals,
        ),
        minExpansionRatioPct: String(
          (request.minExpansionRatio ?? DEFAULT_MA_ZONE_TRIGGER_CONFIG.minExpansionRatio) * 100,
        ),
        requireBullishMaOrder: request.requireBullishMaOrder ?? true,
        belowZoneToleranceEnabled: request.belowZoneToleranceEnabled ?? false,
        maxBelowZonePct: String(request.maxBelowZonePct ?? DEFAULT_MA_ZONE_TRIGGER_CONFIG.maxBelowZonePct),
        priceMin: request.priceMin == null ? '' : String(request.priceMin),
        priceMax: request.priceMax == null ? '' : String(request.priceMax),
        averageVolumeMin: request.averageVolumeMin == null ? '' : String(request.averageVolumeMin),
        averageVolumeMax: request.averageVolumeMax == null ? '' : String(request.averageVolumeMax),
        averageTradingValueMin: request.averageTradingValueMin == null ? '' : String(request.averageTradingValueMin),
        averageTradingValueMax: request.averageTradingValueMax == null ? '' : String(request.averageTradingValueMax),
        liquidityLookbackSessions: String(request.liquidityLookbackSessions),
      })
      setSelectedMarkets(request.markets ?? [])
      setStageFilters(request.stageFilters ?? {})
      setEffectiveEngineConfig({
        slopeLookbackSessions: request.slopeLookbackSessions!,
        approachLookbackSessions: request.approachLookbackSessions!,
        minimumAboveZoneRatio: request.minimumAboveZoneRatio!,
        maxPriceStalenessSessions: request.maxPriceStalenessSessions!,
      })
      setViewConfig(definition.viewConfig)
      setActiveSavedId(definition.id)
      setSaveMode(null)
      setSavedMessage('条件を読み込みました。内容を確認してからTriggerを検索してください。')
    } catch (loadError) {
      setSavedError(loadError instanceof Error ? loadError.message : '保存済みTriggerを読み込めませんでした。')
    } finally {
      setSavedBusy(false)
    }
  }

  const openSaveEditor = (mode: SaveMode) => {
    setSaveMode(mode)
    setSaveName(mode === 'rename' || mode === 'update' ? activeSavedTrigger?.name ?? '' : '')
    setSavedError(null)
    setSavedMessage(null)
  }

  const persistSavedTrigger = async () => {
    if (!saveMode) return
    setSavedBusy(true)
    setSavedError(null)
    setSavedMessage(null)
    try {
      const isExistingUpdate = saveMode === 'update' || saveMode === 'rename'
      if (isExistingUpdate && !activeSavedTrigger) throw new Error('更新する保存済みTriggerを選択してください。')
      const endpoint = isExistingUpdate
        ? `/api/trigger-discovery/saved/${activeSavedTrigger!.id}`
        : '/api/trigger-discovery/saved'
      const payload = saveMode === 'rename'
        ? { name: saveName }
        : { name: saveName, ...savedTriggerConfigsFromSearchRequest(validateAndBuildRequest()) }
      const apiResponse = await fetch(endpoint, {
        method: isExistingUpdate ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = await apiResponse.json() as SavedTriggerDetailResponse | { message?: string }
      if (!apiResponse.ok || !('definition' in body)) {
        throw new Error('message' in body && body.message ? body.message : '保存できませんでした。')
      }
      const definitions = await fetchSavedTriggers()
      setActiveSavedId(body.definition.id)
      setSelectedSavedId(body.definition.id)
      setSaveMode(null)
      setSaveName('')
      setSavedMessage(saveMode === 'rename' ? '名前を変更しました。' : 'Trigger条件を保存しました。')
      if (!definitions.some((definition) => definition.id === body.definition.id)) {
        setSavedTriggers((current) => [body.definition, ...current])
      }
    } catch (saveError) {
      setSavedError(saveError instanceof Error ? saveError.message : '保存できませんでした。')
    } finally {
      setSavedBusy(false)
    }
  }

  const archiveSavedTrigger = async () => {
    if (!activeSavedTrigger || !window.confirm(`「${activeSavedTrigger.name}」をアーカイブしますか？`)) return
    setSavedBusy(true)
    setSavedError(null)
    setSavedMessage(null)
    try {
      const apiResponse = await fetch(`/api/trigger-discovery/saved/${activeSavedTrigger.id}`, { method: 'DELETE' })
      const body = await apiResponse.json() as { archived?: boolean; message?: string }
      if (!apiResponse.ok || body.archived !== true) throw new Error(body.message ?? 'アーカイブできませんでした。')
      await fetchSavedTriggers()
      setActiveSavedId(null)
      setSelectedSavedId('')
      setSaveMode(null)
      setSavedMessage('保存済みTriggerをアーカイブしました。現在の入力条件は維持しています。')
    } catch (archiveError) {
      setSavedError(archiveError instanceof Error ? archiveError.message : 'アーカイブできませんでした。')
    } finally {
      setSavedBusy(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        await fetchSavedTriggers()
      } catch (loadError) {
        if (!cancelled) setSavedError(loadError instanceof Error ? loadError.message : '保存済みTriggerを取得できませんでした。')
      } finally {
        if (!cancelled) setSavedLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const historyState = typeof window.history.state === 'object' && window.history.state !== null
      ? window.history.state as Record<string, unknown>
      : {}
    let serializedSnapshot: string | null = null
    try {
      serializedSnapshot = window.sessionStorage.getItem(TRIGGER_DISCOVERY_NAVIGATION_STORAGE_KEY)
    } catch {
      return
    }
    const snapshot = parseTriggerDiscoveryNavigationSnapshot({
      serialized: serializedSnapshot,
      historyToken: historyState[TRIGGER_DISCOVERY_NAVIGATION_HISTORY_KEY],
      currentUrl: `${window.location.pathname}${window.location.search}${window.location.hash}`,
    })
    if (!snapshot) return

    try {
      window.sessionStorage.removeItem(TRIGGER_DISCOVERY_NAVIGATION_STORAGE_KEY)
    } catch {
      // The validated in-memory snapshot can still be restored for this mount.
    }
    const nextHistoryState = { ...historyState }
    delete nextHistoryState[TRIGGER_DISCOVERY_NAVIGATION_HISTORY_KEY]
    window.history.replaceState(nextHistoryState, '', window.location.href)

    abortController.current?.abort()
    miniChartAbortController.current?.abort()
    requestSequence.current += 1
    miniChartSequence.current += 1
    restoredNavigation.current = true
    pendingScrollRestore.current = snapshot.payload.scroll
    setMode('current')
    setTimeframe(snapshot.payload.timeframe)
    setDraft({
      ...snapshot.payload.draft,
      spreadExpansionEnabled: snapshot.payload.draft.spreadExpansionEnabled ?? false,
      spreadLookbackIntervals: snapshot.payload.draft.spreadLookbackIntervals
        ?? String(DEFAULT_MA_ZONE_TRIGGER_CONFIG.spreadLookbackIntervals),
      minExpansionRatioPct: snapshot.payload.draft.minExpansionRatioPct
        ?? String(DEFAULT_MA_ZONE_TRIGGER_CONFIG.minExpansionRatio * 100),
      requireBullishMaOrder: snapshot.payload.draft.requireBullishMaOrder ?? true,
      belowZoneToleranceEnabled: snapshot.payload.draft.belowZoneToleranceEnabled ?? false,
      maxBelowZonePct: snapshot.payload.draft.maxBelowZonePct
        ?? String(DEFAULT_MA_ZONE_TRIGGER_CONFIG.maxBelowZonePct),
    })
    setSelectedMarkets(snapshot.payload.selectedMarkets)
    setStageFilters(snapshot.payload.stageFilters)
    setEffectiveEngineConfig(snapshot.payload.effectiveEngineConfig)
    setViewConfig(snapshot.payload.viewConfig)
    setResponse(snapshot.payload.response)
    setLastRequest(snapshot.payload.lastRequest)
    setBuilderOpen(snapshot.payload.builderOpen)
    setSelectedSavedId(snapshot.payload.selectedSavedId)
    setActiveSavedId(snapshot.payload.activeSavedId)
    setLoading(false)
    setError(null)
  }, [])

  useEffect(() => {
    miniChartAbortController.current?.abort()
    const sequence = ++miniChartSequence.current
    if (!response?.meta.resolvedAsOf || response.rows.length === 0) {
      setMiniChartLoadingKeys(new Set())
      return
    }
    const entries = response.rows.map((row) => ({
      ticker: row.ticker,
      key: miniChartKey({
        ticker: row.ticker,
        timeframe: response.meta.timeframe,
        requestedAsOf: response.meta.requestedAsOf,
        resolvedAsOf: response.meta.resolvedAsOf,
        ma1Period: response.criteria.ma1Period,
        ma2Period: response.criteria.ma2Period,
      }),
    }))
    const missing = entries.filter((entry) => !miniChartCache.current.has(entry.key))
    setMiniChartLoadingKeys(new Set(missing.map((entry) => entry.key)))
    if (missing.length === 0) return

    const controller = new AbortController()
    miniChartAbortController.current = controller
    void (async () => {
      try {
        const apiResponse = await fetch('/api/trigger-discovery/mini-charts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tickers: missing.map((entry) => entry.ticker),
            requestedAsOf: response.meta.requestedAsOf,
            timeframe: response.meta.timeframe,
            ma1Period: response.criteria.ma1Period,
            ma2Period: response.criteria.ma2Period,
          }),
          cache: 'no-store',
          signal: controller.signal,
        })
        const body = await apiResponse.json() as TriggerDiscoveryMiniChartsResponse | { message?: string }
        if (!apiResponse.ok || !('charts' in body)) {
          throw new Error('message' in body && body.message ? body.message : 'Mini Chartを取得できませんでした。')
        }
        if (sequence !== miniChartSequence.current) return
        const receivedKeys = new Set<string>()
        for (const chart of body.charts) {
          const key = miniChartKey({
            ticker: chart.ticker,
            timeframe: body.timeframe,
            requestedAsOf: chart.requestedAsOf,
            resolvedAsOf: chart.resolvedAsOf,
            ma1Period: body.ma1Period,
            ma2Period: body.ma2Period,
          })
          miniChartCache.current.set(key, chart)
          receivedKeys.add(key)
        }
        setMiniChartFailedKeys(new Set(missing.map((entry) => entry.key).filter((key) => !receivedKeys.has(key))))
        setMiniChartVersion((current) => current + 1)
      } catch {
        if (controller.signal.aborted || sequence !== miniChartSequence.current) return
        setMiniChartFailedKeys(new Set(missing.map((entry) => entry.key)))
      } finally {
        if (sequence === miniChartSequence.current) setMiniChartLoadingKeys(new Set())
      }
    })()
    return () => controller.abort()
  }, [response])

  useEffect(() => {
    const params = new URL(window.location.href).searchParams
    if (restoredNavigation.current) return
    if (params.get('mode') === 'period') setMode('period')
    const requestedAsOf = params.get('asOf')
    const requestedTimeframe = params.get('timeframe')
    const requestedMa1 = params.get('ma1')
    const requestedMa2 = params.get('ma2')
    if (requestedAsOf && /^\d{4}-\d{2}-\d{2}$/.test(requestedAsOf)) {
      setDraft((current) => ({ ...current, asOf: requestedAsOf }))
    }
    if (requestedTimeframe === 'MONTHLY' || requestedTimeframe === 'BIWEEKLY') setTimeframe(requestedTimeframe)
    if (requestedMa1 && /^\d+$/.test(requestedMa1)) setDraft((current) => ({ ...current, ma1Period: requestedMa1 }))
    if (requestedMa2 && /^\d+$/.test(requestedMa2)) setDraft((current) => ({ ...current, ma2Period: requestedMa2 }))
  }, [])

  useEffect(() => {
    if (!response || !pendingScrollRestore.current) return
    const scroll = pendingScrollRestore.current
    pendingScrollRestore.current = null
    let secondFrame = 0
    let settleTimer = 0
    const restoreScroll = () => {
      if (resultsTableRef.current) {
        resultsTableRef.current.scrollLeft = scroll.resultsTableX
        resultsTableRef.current.scrollTop = scroll.resultsTableY
      }
      window.scrollTo({ top: scroll.windowY, left: 0, behavior: 'instant' })
    }
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        restoreScroll()
        // Native history restoration can settle after the first painted frame.
        settleTimer = window.setTimeout(restoreScroll, 120)
      })
    })
    return () => {
      window.cancelAnimationFrame(firstFrame)
      if (secondFrame) window.cancelAnimationFrame(secondFrame)
      if (settleTimer) window.clearTimeout(settleTimer)
    }
  }, [response])

  const changeMode = (next: DiscoveryMode) => {
    setMode(next)
    setBuilderOpen(true)
    setError(null)
    const url = new URL(window.location.href)
    url.searchParams.set('mode', next)
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
  }

  const stageFilterControls = (showApply: boolean) => (
    <details className={`${showApply ? 'mt-3 border-y border-[var(--color-border-soft)] py-2' : 'mt-4 border-t border-[var(--color-border-soft)] pt-3'}`}>
      <summary className="cursor-pointer list-none text-[11px] font-medium text-[var(--color-brand-700)]">Stageで絞り込む</summary>
      <div className="mt-3 grid gap-x-5 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
        {TRIGGER_DISCOVERY_STAGE_AXES.map((axis) => (
          <div key={axis} className="flex items-center gap-1.5">
            <span className="w-7 shrink-0 text-[10px] font-semibold text-[var(--color-text-secondary)]">{STAGE_AXIS_LABELS[axis]}</span>
            {[1, 2, 3, 4, 5, 6, 'unknown'].map((value) => {
              const typedValue = value as TriggerDiscoveryStageFilterValue
              const selected = stageFilters[axis]?.includes(typedValue) ?? false
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => toggleStage(axis, typedValue)}
                  aria-label={`${STAGE_AXIS_LABELS[axis]} ${value === 'unknown' ? 'Unknown' : `Stage ${value}`}`}
                  className={`h-7 min-w-7 rounded-[3px] border px-1 text-[10px] tabular-nums ${selected ? 'border-[var(--color-brand-600)] bg-[var(--color-brand-50)] font-semibold text-[var(--color-brand-800)]' : 'border-[var(--color-border)] bg-white text-[var(--color-text-secondary)]'}`}
                  aria-pressed={selected}
                >
                  {value === 'unknown' ? '—' : value}
                </button>
              )
            })}
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-2">
        {showApply && <button type="button" disabled={loading || !lastRequest} onClick={applyStageFilters} className="rounded-[3px] bg-[var(--color-brand-700)] px-3 py-1.5 text-[11px] font-medium text-white disabled:opacity-50">現在の結果へ適用</button>}
        <button type="button" disabled={loading} onClick={() => setStageFilters({})} className="px-2 py-1.5 text-[11px] text-[var(--color-text-secondary)] hover:text-[var(--color-brand-700)]">選択をクリア</button>
        {showApply && response && response.meta.triggerMatchedCount !== response.meta.matchedCount && <span className="text-[10px] text-[var(--color-text-tertiary)]">Trigger一致 {response.meta.triggerMatchedCount}件から絞り込み</span>}
      </div>
    </details>
  )

  return (
    <div className="w-full pb-16">
      <header className="border-b border-[var(--color-border)] pb-4 pt-1">
        <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-brand-600)]">Trigger Discovery</p>
        <div className="mt-1 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-[24px] font-semibold leading-tight text-[var(--color-text-primary)]">条件トリガー</h1>
            <p className="mt-1 text-[12px] text-[var(--color-text-secondary)]">上向きの移動平均へ上から接近する銘柄を、6軸Stageとともに探索します。</p>
          </div>
          <span className="inline-flex items-center gap-1.5 text-[11px] text-[var(--color-text-tertiary)]">
            <CalendarDays size={13} aria-hidden /> 最新データ {options.latestAsOf ?? '—'}
          </span>
        </div>
      </header>

      <nav aria-label="Trigger Discoveryの検索モード" className="flex items-center gap-1 border-b border-[var(--color-border)] py-2">
        <button type="button" aria-current={mode === 'current' ? 'page' : undefined} onClick={() => changeMode('current')} className={`h-8 rounded-[3px] px-3 text-[11px] font-semibold ${mode === 'current' ? 'bg-[var(--color-brand-800)] text-white' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-muted)]'}`}>現在・単日時点</button>
        <button type="button" aria-current={mode === 'period' ? 'page' : undefined} onClick={() => changeMode('period')} className={`h-8 rounded-[3px] px-3 text-[11px] font-semibold ${mode === 'period' ? 'bg-[var(--color-brand-800)] text-white' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-muted)]'}`}>期間検証</button>
      </nav>

      {mode === 'current' && response && !builderOpen && (
        <section data-trigger-compact-summary aria-labelledby="trigger-results" className="border-b border-[var(--color-border)] bg-[var(--color-surface-subtle)] px-2 py-2.5 sm:px-3">
          <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <h2 id="trigger-results" className="inline-flex items-baseline gap-1">
                  <span className="text-[11px] font-medium text-[var(--color-text-tertiary)]">候補</span>
                  <strong data-trigger-candidate-count className="text-[22px] font-semibold leading-none tabular-nums text-[var(--color-text-primary)]">{response.meta.matchedCount.toLocaleString('ja-JP')}</strong>
                  <span className="text-[12px] font-medium text-[var(--color-text-secondary)]">件</span>
                </h2>
                <span className="inline-flex items-baseline gap-1 text-[11px]">
                  <span className="text-[var(--color-text-tertiary)]">評価日</span>
                  <strong className="font-medium tabular-nums text-[var(--color-text-secondary)]">{response.meta.resolvedAsOf ?? '—'}</strong>
                </span>
                <span className="inline-flex items-baseline gap-1 text-[11px] text-[var(--color-text-secondary)]">
                  <strong className="font-semibold">{response.meta.timeframe === 'BIWEEKLY' ? '2週足' : '月足'}</strong>
                  <span className="tabular-nums">{response.criteria.ma1Period}/{response.criteria.ma2Period}</span>
                </span>
                {isHistoricalResult && <span className="rounded-[3px] border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--color-text-secondary)]">過去検証</span>}
              </div>
              {isHistoricalResult && (
                <p className="mt-1 text-[10px] tabular-nums text-[var(--color-text-tertiary)]">
                  指定日 {response.meta.requestedAsOf} / 評価日 {response.meta.resolvedAsOf ?? '—'}
                </p>
              )}
              <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] leading-5 text-[var(--color-text-tertiary)]">
                <p className="min-w-0 flex-1 truncate"><span className="font-medium text-[var(--color-text-secondary)]">適用条件</span> {criteriaSummary}</p>
                <details className="shrink-0">
                  <summary className="cursor-pointer select-none font-medium hover:text-[var(--color-text-secondary)]">評価内訳</summary>
                  <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                    <span>PIT Universe {response.meta.pitUniverseCount.toLocaleString('ja-JP')}</span>
                    <span>Current Price {response.meta.currentPriceCount.toLocaleString('ja-JP')}</span>
                    <span>Stale accepted {response.meta.staleAcceptedCount.toLocaleString('ja-JP')}</span>
                    <span>Trigger evaluated {response.meta.triggerEvaluatedCount.toLocaleString('ja-JP')}</span>
                    <span>Trigger matched {response.meta.triggerMatchedCount.toLocaleString('ja-JP')}</span>
                    <span>Stage filter後 {response.meta.matchedCount.toLocaleString('ja-JP')}</span>
                    <span>Returned {response.meta.returnedCount.toLocaleString('ja-JP')}</span>
                    <span>Trigger Scoreは条件への適合度です</span>
                  </p>
                </details>
              </div>
            </div>
            <button
              type="button"
              data-trigger-builder-toggle
              aria-expanded="false"
              onClick={() => setBuilderOpen(true)}
              className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 self-start rounded-[3px] border border-[var(--color-border)] bg-white px-2.5 text-[10px] font-medium text-[var(--color-text-secondary)] outline-none hover:border-[var(--color-brand-300)] hover:text-[var(--color-brand-700)] focus-visible:ring-2 focus-visible:ring-[var(--color-brand-200)] sm:self-center"
            >
              <SlidersHorizontal size={13} aria-hidden /> 条件を変更
            </button>
          </div>
        </section>
      )}

      {(!response || builderOpen) && <div data-trigger-builder>
      <section aria-labelledby="saved-trigger-heading" className="border-b border-[var(--color-border)] py-3">
        <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            <span id="saved-trigger-heading" className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-[var(--color-text-primary)]">
              <Bookmark size={13} aria-hidden /> 保存済みTrigger
            </span>
            <select
              aria-label="保存済みTrigger"
              value={selectedSavedId}
              disabled={savedLoading || savedBusy || savedTriggers.length === 0}
              onChange={(event) => setSelectedSavedId(event.target.value)}
              className="h-8 min-w-0 flex-1 rounded-[3px] border border-[var(--color-border)] bg-white px-2 text-[11px] sm:max-w-[330px]"
            >
              <option value="">{savedLoading ? '読み込み中…' : savedTriggers.length ? '選択してください' : '保存済みTriggerなし'}</option>
              {savedTriggers.map((definition) => <option key={definition.id} value={definition.id}>{definition.name}｜{definition.evaluationConfig.timeframe === 'BIWEEKLY' ? '2週足' : '月足'}</option>)}
            </select>
            <button type="button" disabled={!selectedSavedId || savedBusy} onClick={() => void loadSavedTrigger()} className="h-8 rounded-[3px] border border-[var(--color-border)] bg-white px-3 text-[11px] font-medium text-[var(--color-brand-700)] disabled:opacity-40">読み込む</button>
            {activeSavedTrigger && (
              <span className="inline-flex min-w-0 items-center gap-1 text-[10px] text-[var(--color-text-secondary)]">
                <span className="max-w-[190px] truncate">編集中: {activeSavedTrigger.name}</span>
                <strong className="rounded-[3px] bg-[var(--color-surface-muted)] px-1.5 py-0.5 font-medium text-[var(--color-text-secondary)]">
                  {activeSavedTrigger.evaluationConfig.timeframe === 'BIWEEKLY' ? '2週足' : '月足'}
                </strong>
                {hasUnsavedChanges && <strong className="rounded-[3px] bg-amber-50 px-1.5 py-0.5 font-semibold text-amber-800">変更あり</strong>}
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {activeSavedTrigger && (
              <>
                <button type="button" disabled={savedBusy || !hasUnsavedChanges} onClick={() => openSaveEditor('update')} className="inline-flex h-8 items-center gap-1 rounded-[3px] border border-[var(--color-border)] bg-white px-2.5 text-[10px] font-medium text-[var(--color-text-secondary)] disabled:opacity-40"><Save size={12} aria-hidden />保存</button>
                <button type="button" disabled={savedBusy} onClick={() => openSaveEditor('rename')} className="inline-flex h-8 items-center gap-1 rounded-[3px] border border-[var(--color-border)] bg-white px-2.5 text-[10px] font-medium text-[var(--color-text-secondary)] disabled:opacity-40"><Pencil size={12} aria-hidden />名前変更</button>
                <TriggerNotificationSettingsPanel key={activeSavedTrigger.id} definition={activeSavedTrigger} />
              </>
            )}
            <button type="button" disabled={savedBusy} onClick={() => openSaveEditor(activeSavedTrigger ? 'copy' : 'create')} className="inline-flex h-8 items-center gap-1 rounded-[3px] border border-[var(--color-border)] bg-white px-2.5 text-[10px] font-medium text-[var(--color-text-secondary)] disabled:opacity-40"><Copy size={12} aria-hidden />別名で保存</button>
            {activeSavedTrigger && <button type="button" disabled={savedBusy} onClick={() => void archiveSavedTrigger()} className="inline-flex h-8 w-8 items-center justify-center rounded-[3px] text-[var(--color-text-tertiary)] hover:bg-red-50 hover:text-red-700 disabled:opacity-40" aria-label="保存済みTriggerをアーカイブ"><Trash2 size={13} aria-hidden /></button>}
          </div>
        </div>
        {saveMode && (
          <div className="mt-2 flex flex-wrap items-center gap-2 border-l-2 border-[var(--color-brand-300)] pl-2">
            <input autoFocus value={saveName} maxLength={80} onChange={(event) => setSaveName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void persistSavedTrigger() }} placeholder="Trigger名" aria-label="Trigger名" className="h-8 min-w-0 flex-1 rounded-[3px] border border-[var(--color-border)] bg-white px-2 text-[11px] sm:max-w-[360px]" />
            <button type="button" disabled={savedBusy} onClick={() => void persistSavedTrigger()} className="inline-flex h-8 items-center gap-1 rounded-[3px] bg-[var(--color-brand-700)] px-3 text-[10px] font-semibold text-white disabled:opacity-50"><Save size={12} aria-hidden />{saveMode === 'rename' ? '名前を更新' : saveMode === 'update' ? '変更を保存' : '保存する'}</button>
            <button type="button" disabled={savedBusy} onClick={() => setSaveMode(null)} className="inline-flex h-8 w-8 items-center justify-center rounded-[3px] text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-muted)]" aria-label="保存をキャンセル"><X size={13} aria-hidden /></button>
          </div>
        )}
        <div className="mt-1.5 flex flex-wrap items-center justify-between gap-1 text-[9px] leading-4 text-[var(--color-text-tertiary)]">
          <span>{mode === 'period' ? '開始日・終了日は保存されません。保存条件を読み込んだ後に期間を指定してください。' : '基準日は保存されません。読み込み時の最新利用可能日を使用します。'}</span>
          {savedError ? <span role="alert" className="text-red-700">{savedError}</span> : savedMessage ? <span role="status" className="text-[var(--color-brand-700)]">{savedMessage}</span> : null}
        </div>
      </section>

      <section aria-labelledby="trigger-conditions" className="border-b border-[var(--color-border)] py-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h2 id="trigger-conditions" className="text-[14px] font-semibold text-[var(--color-text-primary)]">1. Trigger条件</h2>
            <p className="mt-0.5 text-[10px] text-[var(--color-text-tertiary)]">{timeframe === 'BIWEEKLY' ? '2週足' : '月足'} / 2本とも上向き / 上から接近</p>
          </div>
          <span className="text-[10px] text-[var(--color-text-tertiary)]" title={timeframe === 'BIWEEKLY' ? '2週足は、週足を2本ずつ束ねて作成します。' : '月足を基準に移動平均線を計算します。'}>
            {timeframe === 'BIWEEKLY' ? '2週足は週足2本を束ねて計算' : '月足終値を基準に計算'}
          </span>
        </div>
        <div className={`grid grid-cols-2 gap-2 sm:grid-cols-4 ${mode === 'period' ? 'lg:grid-cols-[110px_110px_110px_130px_145px_145px_1fr]' : 'lg:grid-cols-[120px_120px_120px_140px_160px_1fr]'}`}>
          <label className="block min-w-0">
            <span className="mb-1 block text-[10px] font-medium text-[var(--color-text-tertiary)]">足種</span>
            <select
              value={timeframe}
              onChange={(event) => {
                const next = event.target.value as TriggerDiscoveryTimeframe
                if (next === timeframe) return
                setTimeframe(next)
                setSaveMode(null)
                setSavedError(null)
                setSavedMessage(null)
                clearSearchResult()
              }}
              className="h-9 w-full rounded-[4px] border border-[var(--color-border)] bg-white px-2 text-[13px] text-[var(--color-text-primary)] outline-none focus:border-[var(--color-brand-500)] focus:ring-1 focus:ring-[var(--color-brand-100)]"
              aria-label="Triggerの足種"
            >
              <option value="MONTHLY">月足</option>
              <option value="BIWEEKLY">2週足</option>
            </select>
          </label>
          <Field label="MA 1" value={draft.ma1Period} onChange={(value) => updateDraft('ma1Period', value)} suffix={timeframe === 'BIWEEKLY' ? '本' : 'か月'} type="number" min={2} max={120} />
          <Field label="MA 2" value={draft.ma2Period} onChange={(value) => updateDraft('ma2Period', value)} suffix={timeframe === 'BIWEEKLY' ? '本' : 'か月'} type="number" min={2} max={120} />
          <Field
            label="Trigger距離"
            value={draft.maxDistance}
            onChange={(value) => updateDraft('maxDistance', value)}
            suffix="%以内"
            type="number"
            min={0}
            max={100}
            help={(
              <HelpPopover title="Trigger距離">
                <p>MA1〜MA2で形成される価格帯（Trigger Zone）まで、何％手前から「接近中」と判定するかを設定します。</p>
                <p><strong className="font-semibold text-[var(--color-text-primary)]">Trigger Zone</strong>とは、MA1とMA2の間の価格帯です。</p>
                <p className="text-[10px] text-[var(--color-text-tertiary)]">例：MA1が3,000円、MA2が2,850円ならZoneは2,850〜3,000円。5%設定では、株価が上からZoneの5%以内まで近づくと候補になります。</p>
                <dl className="grid grid-cols-[auto_1fr] gap-x-2 border-t border-[var(--color-border-soft)] pt-2 text-[10px]">
                  <dt>Trigger距離以内</dt><dd>APPROACHING</dd>
                  <dt>Near距離以内</dt><dd>NEAR</dd>
                  <dt>MA1〜MA2の間</dt><dd>IN ZONE</dd>
                </dl>
              </HelpPopover>
            )}
          />
          {mode === 'period' ? (
            <>
              <Field label="開始日" value={historicalStartDate} onChange={setHistoricalStartDate} type="date" />
              <Field
                label="終了日"
                value={historicalEndDate}
                onChange={setHistoricalEndDate}
                type="date"
                action={options.latestAsOf && historicalEndDate !== options.latestAsOf ? (
                  <button type="button" onClick={() => setHistoricalEndDate(options.latestAsOf!)} className="text-[9px] font-medium text-[var(--color-brand-700)] hover:underline" aria-label={`終了日を最新利用可能日${options.latestAsOf}へ戻す`}>最新へ</button>
                ) : null}
              />
            </>
          ) : (
            <Field
              label="基準日"
              value={draft.asOf}
              onChange={(value) => updateDraft('asOf', value)}
              type="date"
              action={options.latestAsOf && draft.asOf !== options.latestAsOf ? (
                <button
                  type="button"
                  onClick={() => updateDraft('asOf', options.latestAsOf!)}
                  className="text-[9px] font-medium text-[var(--color-brand-700)] hover:underline"
                  aria-label={`基準日を最新利用可能日${options.latestAsOf}へ戻す`}
                >
                  最新へ
                </button>
              ) : null}
              help={(
                <HelpPopover title="基準日">
                  <p>指定した日付時点で利用可能な価格・MA・Stageだけを使ってTriggerを検索します。休日の場合は、その日以前の直近取引日に解決されます。</p>
                  <p className="text-[10px] text-[var(--color-text-tertiary)]">例：指定日が2025-11-02（日）の場合、評価日は2025-10-31（金）です。最新データより未来の日付も、最新の利用可能日に解決されます。</p>
                  <p className="border-t border-[var(--color-border-soft)] pt-2 text-[10px] text-[var(--color-text-tertiary)]">上場期間は、現在保持している全取引履歴から過去時点を復元しています。</p>
                </HelpPopover>
              )}
            />
          )}
          <div className="col-span-2 flex items-end gap-2 sm:col-span-4 lg:col-span-1 lg:justify-end">
            <dl className="mb-1 grid gap-0.5 text-[10px] text-[var(--color-text-tertiary)]">
              <div className="flex items-center gap-1">
                <dt>MA方向:</dt><dd className="font-medium text-[var(--color-text-secondary)]">2本とも上向き</dd>
                <HelpPopover title="2本とも上向き" align="end">
                  <p>MA1とMA2の両方が上向いている銘柄だけを対象とします。いずれかの移動平均線が下降している銘柄は対象外です。</p>
                </HelpPopover>
              </div>
              <div className="flex items-center gap-1">
                <dt>接近方向:</dt><dd className="font-medium text-[var(--color-text-secondary)]">上から</dd>
                <HelpPopover title="上から接近" align="end">
                  <p>株価がMA1〜MA2のTrigger Zoneより上にあり、そこへ向かって下落・接近している銘柄を対象とします。</p>
                  <p className="text-[10px] text-[var(--color-text-tertiary)]">Zoneの下側から上昇して近づいている銘柄は、デフォルト条件では対象外です。</p>
                </HelpPopover>
              </div>
            </dl>
          </div>
        </div>
        <details className="group mt-4">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-[11px] font-medium text-[var(--color-brand-700)]">
            <SlidersHorizontal size={13} aria-hidden /> Trigger詳細条件
            {draft.spreadExpansionEnabled && <span className="rounded-[3px] bg-[var(--color-brand-50)] px-1.5 py-0.5 text-[9px] font-semibold text-[var(--color-brand-800)]">MA間隔拡大 ON</span>}
            {draft.belowZoneToleranceEnabled && <span className="rounded-[3px] bg-[var(--color-brand-50)] px-1.5 py-0.5 text-[9px] font-semibold text-[var(--color-brand-800)]">Zone下抜け ON</span>}
          </summary>
          <div className="mt-3 border-l-2 border-[var(--color-border-soft)] pl-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="inline-flex items-center gap-1 text-[12px] font-medium text-[var(--color-text-primary)]">
                <label className="inline-flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={draft.spreadExpansionEnabled}
                    onChange={(event) => setDraft((current) => ({
                      ...current,
                      spreadExpansionEnabled: event.target.checked,
                    }))}
                    className="h-4 w-4 rounded border-[var(--color-border)] accent-[var(--color-brand-700)]"
                  />
                  MA間隔拡大
                </label>
                <HelpPopover title="MA間隔拡大" align="start">
                  <p>MA1とMA2がともに上昇し、MA1がMA2を上回った状態で、両者の相対間隔が拡大傾向にある銘柄だけを抽出します。</p>
                  <p className="text-[10px] text-[var(--color-text-tertiary)]">一時的な縮小を許容するため、単純な連続拡大ではなく、間隔率のSlopeと拡大区間比率を組み合わせて判定します。</p>
                  <p className="border-t border-[var(--color-border-soft)] pt-2 text-[10px] text-[var(--color-text-tertiary)]">2本が同じ速度で平行上昇する場合、「2本とも上向き」でもMA間隔拡大には該当しないことがあります。</p>
                </HelpPopover>
              </div>
              <span className="text-[10px] text-[var(--color-text-tertiary)]">既定OFF・Trigger Scoreへの加点なし</span>
            </div>
            {draft.spreadExpansionEnabled && (
              <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3 lg:max-w-[660px]">
                <Field label="比較区間数" value={draft.spreadLookbackIntervals} onChange={(value) => updateDraft('spreadLookbackIntervals', value)} suffix="区間" type="number" min={2} max={24} />
                <Field label="最低拡大区間比率" value={draft.minExpansionRatioPct} onChange={(value) => updateDraft('minExpansionRatioPct', value)} suffix="%" type="number" min={0} max={100} />
                <div className="rounded-[3px] bg-[var(--color-surface-subtle)] px-2.5 py-2 text-[10px] leading-5 text-[var(--color-text-secondary)]">
                  <span className="block text-[9px] font-medium text-[var(--color-text-tertiary)]">上方順序</span>
                  MA1がMA2より上（固定）
                </div>
              </div>
            )}
          </div>
          <div className="mt-3 border-l-2 border-[var(--color-border-soft)] pl-3">
            <label className="inline-flex cursor-pointer items-center gap-2 text-[12px] font-medium text-[var(--color-text-primary)]">
              <input type="checkbox" checked={draft.belowZoneToleranceEnabled ?? false}
                onChange={(event) => setDraft((current) => ({ ...current, belowZoneToleranceEnabled: event.target.checked }))}
                className="h-4 w-4 rounded border-[var(--color-border)] accent-[var(--color-brand-700)]" />
              Zone下抜けも候補に含める
            </label>
            <p className="mt-1 text-[10px] text-[var(--color-text-secondary)]">株価が上からTrigger Zoneへ接近し、Zone下限を少しだけ下回った銘柄も候補に含めます。</p>
            {draft.belowZoneToleranceEnabled && (
              <div className="mt-2 max-w-[220px]">
                <Field label="最大下抜け幅" value={draft.maxBelowZonePct ?? '3'} onChange={(value) => updateDraft('maxBelowZonePct', value)} suffix="%" type="number" min={0.01} max={20} />
                <p className="mt-1 text-[10px] text-[var(--color-text-tertiary)]">例：3%ならZone下限から0〜3%下のBELOW_ZONEを許容します。</p>
              </div>
            )}
          </div>
        </details>
      </section>

      <section aria-labelledby="universe-conditions" className="border-b border-[var(--color-border)] py-5">
        <h2 id="universe-conditions" className="text-[14px] font-semibold text-[var(--color-text-primary)]">2. Universe</h2>
        <div className="mt-3 grid gap-4 lg:grid-cols-[minmax(280px,1.3fr)_repeat(2,minmax(180px,.7fr))]">
          <fieldset>
            <legend className="mb-1 text-[10px] font-medium text-[var(--color-text-tertiary)]">市場（未選択はすべて）</legend>
            <div className="flex flex-wrap gap-1.5">
              {options.markets.map((market) => {
                const selected = selectedMarkets.some((value) => value === market.value)
                return (
                  <label key={market.value ?? '__unknown__'} className={`inline-flex cursor-pointer items-center gap-1 rounded-[3px] border px-2 py-1.5 text-[11px] ${selected ? 'border-[var(--color-brand-500)] bg-[var(--color-brand-50)] text-[var(--color-brand-800)]' : 'border-[var(--color-border)] bg-white text-[var(--color-text-secondary)]'}`}>
                    <input type="checkbox" className="sr-only" checked={selected} onChange={() => toggleMarket(market.value)} />
                    {market.label}<span className="text-[9px] text-[var(--color-text-tertiary)]">{market.count.toLocaleString('ja-JP')}</span>
                  </label>
                )
              })}
            </div>
          </fieldset>
          <div className="grid grid-cols-2 gap-2">
            <Field label="株価 下限" value={draft.priceMin} onChange={(value) => updateDraft('priceMin', value)} suffix="円" />
            <Field label="株価 上限" value={draft.priceMax} onChange={(value) => updateDraft('priceMax', value)} suffix="円" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Field label="平均売買代金 下限" value={draft.averageTradingValueMin} onChange={(value) => updateDraft('averageTradingValueMin', value)} suffix="円" />
            <Field label="平均売買代金 上限" value={draft.averageTradingValueMax} onChange={(value) => updateDraft('averageTradingValueMax', value)} suffix="円" />
          </div>
        </div>
        <details className="group mt-4">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-[11px] font-medium text-[var(--color-brand-700)]">
            <SlidersHorizontal size={13} aria-hidden /> 詳細条件
          </summary>
          <div className="mt-3 grid grid-cols-2 gap-2 border-l-2 border-[var(--color-border-soft)] pl-3 sm:grid-cols-4 lg:max-w-[720px]">
            <Field label="平均出来高 下限" value={draft.averageVolumeMin} onChange={(value) => updateDraft('averageVolumeMin', value)} suffix="株" />
            <Field label="平均出来高 上限" value={draft.averageVolumeMax} onChange={(value) => updateDraft('averageVolumeMax', value)} suffix="株" />
            <Field label="平均期間" value={draft.liquidityLookbackSessions} onChange={(value) => updateDraft('liquidityLookbackSessions', value)} suffix="営業日" type="number" min={1} max={252} />
            <Field
              label="Near距離"
              value={draft.nearDistance}
              onChange={(value) => updateDraft('nearDistance', value)}
              suffix="%以内"
              type="number"
              min={0}
              max={100}
              help={(
                <HelpPopover title="Near距離" align="end">
                  <p>Trigger Zoneのさらに近くまで接近した銘柄を「NEAR」と判定するための距離です。</p>
                  <p className="text-[10px] text-[var(--color-text-tertiary)]">Trigger距離5%、Near距離2%の場合、Zoneまで5%以内でAPPROACHING、2%以内でNEARになります。</p>
                </HelpPopover>
              )}
            />
          </div>
        </details>
        {mode === 'period' && (
          <>
            {stageFilterControls(false)}
            <p className="mt-3 text-[10px] leading-5 text-[var(--color-text-tertiary)]">指定期間内の各営業日時点でTrigger条件を評価します。休日は期間内の有効取引日に自動調整されます。</p>
          </>
        )}
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3 py-4">
        <p className="text-[11px] text-[var(--color-text-tertiary)]">入力変更だけでは{mode === 'period' ? '期間検証' : '検索'}されません。条件を確認して実行してください。</p>
        <div className="flex items-center gap-2">
          <button type="button" disabled={savedBusy} onClick={() => activeSavedTrigger ? openSaveEditor('update') : openSaveEditor('create')} className="inline-flex h-9 items-center gap-1.5 rounded-[3px] border border-[var(--color-border)] bg-white px-3 text-[11px] font-medium text-[var(--color-text-secondary)] disabled:opacity-50"><Bookmark size={13} aria-hidden />条件を保存</button>
          {mode === 'current' && (
            <button
              type="button"
              disabled={loading}
              onClick={() => void submit()}
              className="inline-flex h-10 min-w-[160px] items-center justify-center gap-2 rounded-[4px] bg-[var(--color-brand-700)] px-5 text-[13px] font-semibold text-white transition hover:bg-[var(--color-brand-800)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading ? <LoaderCircle size={16} className="animate-spin" aria-hidden /> : <Search size={16} aria-hidden />}
              {loading ? '検索中…' : 'Triggerを検索'}
            </button>
          )}
        </div>
      </div>
      </div>}

      {mode === 'current' && error && <div role="alert" className="mb-4 border-l-2 border-red-500 bg-red-50 px-3 py-2 text-[12px] text-red-800">{error}</div>}

      {mode === 'period' ? (
        <HistoricalScanWorkspace buildRequest={validateAndBuildHistoricalRequest} />
      ) : <section aria-labelledby="trigger-results" className={builderOpen ? 'border-t border-[var(--color-border)] pt-4' : ''}>
        {builderOpen && <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="trigger-results" className="text-[14px] font-semibold text-[var(--color-text-primary)]">3. 検索結果</h2>
            {response && (
              <div className="mt-2">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  {isHistoricalResult && <span className="rounded-[3px] border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--color-text-secondary)]">過去検証</span>}
                  <strong className="text-[20px] font-semibold tabular-nums text-[var(--color-text-primary)]">{response.meta.matchedCount.toLocaleString('ja-JP')}件</strong>
                  <span className="text-[12px] tabular-nums text-[var(--color-text-secondary)]">{response.meta.resolvedAsOf ?? '評価日なし'}</span>
                  <span className="text-[12px] font-medium text-[var(--color-text-secondary)]">{response.meta.timeframe === 'BIWEEKLY' ? '2週足' : '月足'} {response.criteria.ma1Period}/{response.criteria.ma2Period}</span>
                </div>
                {criteriaSummary && <p className="mt-1 text-[10px] leading-5 text-[var(--color-text-tertiary)]">{criteriaSummary}</p>}
                <details className="mt-1 text-[10px] text-[var(--color-text-tertiary)]">
                  <summary className="w-fit cursor-pointer select-none font-medium hover:text-[var(--color-text-secondary)]">評価内訳</summary>
                  <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 leading-5">
                    <span>PIT Universe {response.meta.pitUniverseCount.toLocaleString('ja-JP')}</span>
                    <span>Current Price {response.meta.currentPriceCount.toLocaleString('ja-JP')}</span>
                    <span>Stale accepted {response.meta.staleAcceptedCount.toLocaleString('ja-JP')}</span>
                    <span>Trigger evaluated {response.meta.triggerEvaluatedCount.toLocaleString('ja-JP')}</span>
                    <span>Trigger matched {response.meta.triggerMatchedCount.toLocaleString('ja-JP')}</span>
                    <span>Stage filter後 {response.meta.matchedCount.toLocaleString('ja-JP')}</span>
                    <span>Returned {response.meta.returnedCount.toLocaleString('ja-JP')}</span>
                    <span>Trigger Scoreは条件への適合度です</span>
                  </p>
                </details>
              </div>
            )}
          </div>
          {response && response.meta.requestedAsOf !== response.meta.resolvedAsOf && (
            <p className="text-[11px] tabular-nums text-[var(--color-text-secondary)]">
              指定日 {response.meta.requestedAsOf} → 評価日 <strong>{response.meta.resolvedAsOf ?? '—'}</strong>
            </p>
          )}
        </div>}

        {builderOpen && stageFilterControls(true)}
        {response && (
          <label className="my-2 inline-flex items-center gap-2 text-[11px] text-[var(--color-text-secondary)]">
            Status表示
            <select aria-label="Status表示フィルター" value={lastRequest?.statusFilter ?? ''}
              disabled={loading} onChange={(event) => changeStatusFilter(event.target.value as SavedTriggerViewConfig['statusFilter'] || null)}
              className="h-8 rounded-[3px] border border-[var(--color-border)] bg-white px-2 text-[11px] text-[var(--color-text-primary)]">
              <option value="">すべて</option>
              <option value="APPROACHING">APPROACHING</option>
              <option value="NEAR">NEAR</option>
              <option value="IN_ZONE">IN_ZONE</option>
              <option value="BELOW_ZONE">BELOW_ZONE</option>
            </select>
          </label>
        )}

        {!response ? (
          <div className="py-16 text-center">
            <Search size={22} className="mx-auto text-[var(--color-text-tertiary)]" aria-hidden />
            <p className="mt-3 text-[13px] text-[var(--color-text-secondary)]">条件を設定し、Trigger検索を実行してください。</p>
          </div>
        ) : response.rows.length === 0 ? (
          <div className="py-14 text-center text-[13px] text-[var(--color-text-secondary)]">この条件に一致するTrigger候補はありません。</div>
        ) : (
          <>
            <div ref={resultsTableRef} data-trigger-results-table className={`relative ${builderOpen ? 'mt-3' : ''} overflow-x-auto border-y border-[var(--color-border)] bg-white lg:max-h-[min(72vh,760px)] lg:overflow-auto ${loading ? 'opacity-65' : ''}`} aria-busy={loading}>
              {loading && <div className="absolute right-2 top-2 z-30 inline-flex items-center gap-1 rounded bg-white/95 px-2 py-1 text-[10px] text-[var(--color-brand-700)] shadow-sm"><LoaderCircle size={12} className="animate-spin" />再検索中</div>}
              <table className={`w-full ${spreadExpansionActive ? 'min-w-[1490px]' : 'min-w-[1390px]'} border-collapse text-[13px]`}>
                <thead className="sticky top-0 z-30 bg-[var(--color-surface-muted)] text-[var(--color-text-secondary)] shadow-[0_1px_0_var(--color-border)]">
                  <tr className="border-b border-[var(--color-border)]">
                    <th data-column="stock" aria-sort={sortAria('ticker')} className="sticky left-0 z-40 w-[168px] bg-[var(--color-surface-muted)] px-2 py-1 text-left shadow-[4px_0_7px_-7px_rgba(15,23,42,.28)]"><SortButton label="銘柄" sortKey="ticker" activeSort={activeSort} onSort={changeSort} /></th>
                    <th data-column="status" aria-sort={sortAria('triggerStatus')} className="w-[82px] px-2 py-1 text-left"><SortButton label="Status" sortKey="triggerStatus" activeSort={activeSort} onSort={changeSort} /></th>
                    <th data-column="score" aria-sort={sortAria('triggerScore')} className="w-[64px] px-1 py-1 text-center"><SortButton label="Score" ariaLabel="Trigger Score" sortKey="triggerScore" activeSort={activeSort} onSort={changeSort} align="center" /></th>
                    <th data-column="chart" className="w-[168px] px-2 py-1 text-center text-[10px] font-semibold tracking-[0.04em]">MINI CHART</th>
                    <th data-column="price" data-group-start aria-sort={sortAria('price')} className="w-[78px] border-l border-[var(--color-border)] px-2 py-1 text-right"><SortButton label="株価" sortKey="price" activeSort={activeSort} onSort={changeSort} align="end" /></th>
                    <th data-column="market" className="w-[84px] px-2 py-1 text-left">市場</th>
                    <th data-column="zone" aria-sort={sortAria('zoneDistance')} className="w-[92px] px-2 py-1 text-right"><SortButton label="Zone距離" sortKey="zoneDistance" activeSort={activeSort} onSort={changeSort} align="end" /></th>
                    <th data-column="ma1" aria-sort={sortAria('ma1Distance')} className="w-[88px] px-2 py-1 text-right"><SortButton label={`${response.criteria.ma1Period}${response.meta.timeframe === 'BIWEEKLY' ? '本' : 'M'}距離`} sortKey="ma1Distance" activeSort={activeSort} onSort={changeSort} align="end" /></th>
                    <th data-column="ma2" aria-sort={sortAria('ma2Distance')} className="w-[88px] px-2 py-1 text-right"><SortButton label={`${response.criteria.ma2Period}${response.meta.timeframe === 'BIWEEKLY' ? '本' : 'M'}距離`} sortKey="ma2Distance" activeSort={activeSort} onSort={changeSort} align="end" /></th>
                    {spreadExpansionActive && <th data-column="ma-spread" className="w-[96px] px-2 py-1 text-right">MA間隔</th>}
                    <th data-column="trading-value" data-group-start aria-sort={sortAria('averageTradingValue')} className="w-[112px] border-l border-[var(--color-border)] px-2 py-1 text-right"><SortButton label="平均売買代金" sortKey="averageTradingValue" activeSort={activeSort} onSort={changeSort} align="end" /></th>
                    <th data-column="volume" aria-sort={sortAria('averageVolume')} className="w-[102px] px-2 py-1 text-right"><SortButton label="平均出来高" sortKey="averageVolume" activeSort={activeSort} onSort={changeSort} align="end" /></th>
                    <th data-column="stage" data-group-start className="w-[188px] border-l border-[var(--color-border)] px-2 py-1 text-center">
                      <span className="block text-[9px] font-semibold tracking-[0.06em]">6 STAGE</span>
                      <span className="mt-0.5 grid grid-cols-6 gap-1">
                        {TRIGGER_DISCOVERY_STAGE_AXES.map((axis) => (
                          <SortButton key={axis} label={STAGE_AXIS_LABELS[axis]} sortKey={axis} activeSort={activeSort} onSort={changeSort} align="center" />
                        ))}
                      </span>
                    </th>
                    <th data-column="watchlist" data-group-start className="w-10 border-l border-[var(--color-border)] px-1 py-1 text-center"><span className="sr-only">ウォッチ</span></th>
                  </tr>
                </thead>
                <tbody>
                  {response.rows.map((row) => {
                    const chartKey = miniChartKey({
                      ticker: row.ticker,
                      timeframe: response.meta.timeframe,
                      requestedAsOf: response.meta.requestedAsOf,
                      resolvedAsOf: response.meta.resolvedAsOf,
                      ma1Period: response.criteria.ma1Period,
                      ma2Period: response.criteria.ma2Period,
                    })
                    return <tr key={row.ticker} className="border-b border-[var(--color-border-soft)] bg-white transition-colors hover:bg-[var(--color-surface-subtle)]">
                      <td data-column="stock" className="sticky left-0 z-20 bg-inherit px-2 py-1.5 shadow-[4px_0_7px_-7px_rgba(15,23,42,.28)]">
                        <Link href={`/stock/${row.ticker}`} onClick={preserveBeforeStockNavigation} className="block min-w-0 leading-tight hover:text-[var(--color-brand-700)]">
                          <span className="block text-[13px] font-semibold tabular-nums text-[var(--color-text-primary)]">{row.ticker}</span>
                          <span className="mt-0.5 block max-w-[152px] truncate text-[11px] font-normal text-[var(--color-text-secondary)]" title={row.companyName}>{row.companyName}</span>
                        </Link>
                        {row.priceFreshness === 'STALE_ACCEPTED' && <span className="mt-1 block text-[9px] text-amber-700">価格 {row.priceDate}（{row.priceStalenessSessions}営業日前）</span>}
                      </td>
                      <td data-column="status" className="px-2 py-1.5"><span className={`inline-flex whitespace-nowrap rounded-[3px] border px-1.5 py-0.5 text-[10px] font-semibold ${STATUS_STYLES[row.triggerStatus]}`}>{STATUS_LABELS[row.triggerStatus]}</span></td>
                      <td data-column="score" className="px-1 py-1.5 text-center"><TriggerScoreCell triggerScore={row.triggerScore} scoreBreakdown={row.scoreBreakdown} /></td>
                      <td data-column="chart" className="px-2 py-0.5">
                        <TriggerMiniChart
                          chart={miniChartCache.current.get(chartKey)}
                          loading={miniChartLoadingKeys.has(chartKey)}
                          failed={miniChartFailedKeys.has(chartKey)}
                          timeframe={response.meta.timeframe}
                          ma1Period={response.criteria.ma1Period}
                          ma2Period={response.criteria.ma2Period}
                        />
                      </td>
                      <td data-column="price" data-group-start className="border-l border-[var(--color-border)] px-2 py-1.5 text-right font-medium tabular-nums text-[var(--color-text-primary)]">{numberFormatter.format(row.price)}</td>
                      <td data-column="market" className="px-2 py-1.5"><span className="inline-flex max-w-[76px] truncate whitespace-nowrap rounded-[3px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-text-secondary)]" title={row.market ?? '市場区分なし'}>{row.market ?? '—'}</span></td>
                      <td data-column="zone" className="px-2 py-1.5 text-right font-semibold tabular-nums text-[var(--color-text-primary)]">{percent(row.zoneDistancePct)}</td>
                      <td data-column="ma1" className="px-2 py-1.5 text-right font-normal tabular-nums text-[var(--color-text-secondary)]">{percent(row.ma1DistancePct)}</td>
                      <td data-column="ma2" className="px-2 py-1.5 text-right font-normal tabular-nums text-[var(--color-text-secondary)]">{percent(row.ma2DistancePct)}</td>
                      {spreadExpansionActive && (
                        <td data-column="ma-spread" className="px-2 py-1.5 text-right tabular-nums" title={row.maSpreadSlope == null ? undefined : `Slope ${row.maSpreadSlope.toFixed(3)}pt / observation`}>
                          <span className="block font-medium text-[var(--color-text-primary)]">{row.maSpreadPct == null ? '—' : percent(row.maSpreadPct)}</span>
                          <span className="block text-[9px] text-[var(--color-text-tertiary)]">拡大 {row.maSpreadExpansionRatio == null ? '—' : `${Math.round(row.maSpreadExpansionRatio * 100)}%`}</span>
                        </td>
                      )}
                      <td data-column="trading-value" data-group-start className="border-l border-[var(--color-border)] px-2 py-1.5 text-right tabular-nums text-[var(--color-text-secondary)]">{compactAmount(row.averageTradingValue)}</td>
                      <td data-column="volume" className="px-2 py-1.5 text-right tabular-nums text-[var(--color-text-secondary)]">{numberOrDash(row.averageVolume, numberFormatter)}</td>
                      <td data-column="stage" data-group-start className="border-l border-[var(--color-border)] px-2 py-1.5">
                        <span className="grid grid-cols-6 gap-1">
                          {TRIGGER_DISCOVERY_STAGE_AXES.map((axis) => <StageTag key={axis} stage={row[axis]} size="xs" className="w-full" />)}
                        </span>
                      </td>
                      <td data-column="watchlist" data-group-start className="border-l border-[var(--color-border)] px-1 py-1.5 text-center"><WatchlistButton ticker={row.ticker} size="sm" /></td>
                    </tr>
                  })}
                </tbody>
              </table>
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-[11px] text-[var(--color-text-secondary)]">
              <span>{response.meta.matchedCount.toLocaleString('ja-JP')}件中 {firstResult.toLocaleString('ja-JP')}–{lastResult.toLocaleString('ja-JP')}件</span>
              <div className="flex items-center gap-2">
                <label className="inline-flex items-center gap-1">表示
                  <select value={response.meta.pageSize} disabled={loading} onChange={(event) => changePageSize(Number(event.target.value))} className="h-8 rounded-[3px] border border-[var(--color-border)] bg-white px-2 text-[11px]">
                    {[25, 50, 100].map((size) => <option key={size} value={size}>{size}件</option>)}
                  </select>
                </label>
                <button type="button" disabled={loading || response.meta.page <= 1} onClick={() => changePage(response.meta.page - 1)} className="inline-flex h-8 w-8 items-center justify-center rounded-[3px] border border-[var(--color-border)] bg-white disabled:opacity-35" aria-label="前のページ"><ChevronLeft size={15} /></button>
                <span className="min-w-[62px] text-center tabular-nums">{response.meta.page} / {Math.max(1, response.meta.totalPages)}</span>
                <button type="button" disabled={loading || response.meta.page >= response.meta.totalPages} onClick={() => changePage(response.meta.page + 1)} className="inline-flex h-8 w-8 items-center justify-center rounded-[3px] border border-[var(--color-border)] bg-white disabled:opacity-35" aria-label="次のページ"><ChevronRight size={15} /></button>
              </div>
            </div>
          </>
        )}
      </section>}
    </div>
  )
}
