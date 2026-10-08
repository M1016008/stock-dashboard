'use client'

// components/hex/StageTransitionScanner.tsx
// 遷移スキャナー: 6桁ステージコードの完全一致、または片側Anyで遷移銘柄を探す。
// 判定・集計は GET /api/hex/transitions が唯一の根拠。ここでは入力・表示のみを扱う。

import Link from 'next/link'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
} from 'react'
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  ChevronUp,
  Info,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  Search,
  SlidersHorizontal,
  TriangleAlert,
} from 'lucide-react'
import { STAGE_BG_COLORS, STAGE_LABELS } from '@/lib/hex-stage'
import { StageCodeDigits } from '@/components/hex/StageCodeDigits'
import { StageTransitionAxisChips } from '@/components/hex/StageTransitionAxisChips'
import {
  STAGE_CODE_AXES,
  STAGE_TRANSITION_ANY_CODE,
  STAGE_TRANSITION_MAX_CUSTOM_DAYS,
  changedStageCodeAxes,
  inclusiveCalendarDays,
  isIsoDate,
  isStageCode,
  isStageCodeFilter,
  type StageTransitionPeriod,
  type StageTransitionRow,
  type StageTransitionSort,
  type StageTransitionSortDirection,
} from '@/lib/stage-transition-scanner'

// ───────────────────────── 型・定数 ─────────────────────────

interface ScanQuery {
  from: string
  to: string
  universe: string
  period: StageTransitionPeriod
  dateFrom: string
  dateTo: string
  industry33: string
  marketSegment: string
  minPrice: string
  maxPrice: string
  minAvgVolume: string
  maxAvgVolume: string
  /** 円 (API 契約どおり)。UI 入力は百万円で、境界でのみ換算する */
  minAvgTurnover: string
  maxAvgTurnover: string
  sort: StageTransitionSort
  direction: StageTransitionSortDirection
  page: number
  pageSize: number
}

interface Draft {
  from: string[]
  to: string[]
  fromAny: boolean
  toAny: boolean
  period: StageTransitionPeriod
  dateFrom: string
  dateTo: string
  industry33: string
  marketSegment: string
  minPrice: string
  maxPrice: string
  minAvgVolume: string
  maxAvgVolume: string
  /** 百万円 */
  minTurnoverM: string
  maxTurnoverM: string
}

interface ScanPayload {
  data: StageTransitionRow[]
  pagination: { page: number; pageSize: number; total: number; totalPages: number }
  meta: {
    pit: boolean
    averageSessions: number
    missingStagePolicy: string
    range: {
      latestDate: string
      requestedStartDate: string
      requestedEndDate: string
      startDate: string
      endDate: string
      previousMarketDate: string | null
    }
    elapsedMs: number
  }
  options?: { industries33?: string[]; marketSegments?: string[] }
}

type Outcome =
  | { key: string; ok: true; payload: ScanPayload }
  | { key: string; ok: false; message: string }

const DEFAULT_FROM = '211111'
const DEFAULT_TO = '111111'
const PAGE_SIZES = [25, 50, 100] as const
const YEN_PER_MILLION = 1_000_000

const PERIOD_OPTIONS: { key: StageTransitionPeriod; label: string }[] = [
  { key: 'today', label: '本日' },
  { key: 'week', label: '今週' },
  { key: 'month', label: '今月' },
  { key: 'custom', label: '期間指定' },
]

const SORT_OPTIONS: { key: StageTransitionSort; label: string; defaultDirection: StageTransitionSortDirection }[] = [
  { key: 'date', label: '遷移日', defaultDirection: 'desc' },
  { key: 'ticker', label: '銘柄コード', defaultDirection: 'asc' },
  { key: 'industry', label: '33業種', defaultDirection: 'asc' },
  { key: 'price', label: '株価', defaultDirection: 'desc' },
  { key: 'avgVolume', label: '20日平均出来高', defaultDirection: 'desc' },
  { key: 'avgTurnover', label: '20日平均売買代金', defaultDirection: 'desc' },
]

const DEFAULT_QUERY: ScanQuery = {
  from: DEFAULT_FROM,
  to: DEFAULT_TO,
  universe: '',
  period: 'today',
  dateFrom: '',
  dateTo: '',
  industry33: '',
  marketSegment: '',
  minPrice: '',
  maxPrice: '',
  minAvgVolume: '',
  maxAvgVolume: '',
  minAvgTurnover: '',
  maxAvgTurnover: '',
  sort: 'date',
  direction: 'desc',
  page: 1,
  pageSize: 50,
}

// グローバル CSS の input/select/.sb-tab が unlayered で Tailwind ユーティリティより強いため、
// 枠・角丸・背景・表示方式はインラインで指定する。
const FIELD_STYLE: CSSProperties = {
  border: '1px solid var(--color-border-default)',
  borderRadius: 4,
  background: 'var(--color-surface-field)',
}
const SEGMENT_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minHeight: 44,
  minWidth: 64,
  padding: '0 14px',
  borderRadius: 4,
}
const BUTTON_STYLE: CSSProperties = {
  border: '1px solid var(--color-border-default)',
  borderRadius: 4,
  background: '#fff',
}

const FOCUS_RING =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-brand-500)]'
const DIGIT_INPUT_CHANGED = `h-11 w-full min-w-0 p-0 text-center text-[18px] font-bold tabular-nums ${FOCUS_RING}`
const DIGIT_INPUT_PLAIN = `h-11 w-full min-w-0 p-0 text-center text-[18px] font-medium tabular-nums ${FOCUS_RING}`
const LABEL_TEXT = 'text-[11px] font-semibold text-[var(--color-text-secondary)]'
const TEXT_FIELD = `h-11 w-full min-w-0 px-2 text-[13px] tabular-nums ${FOCUS_RING}`
const ICON_BUTTON = `inline-flex h-11 min-w-11 items-center justify-center gap-1 px-3 text-[12px] font-medium text-[var(--color-text-secondary)] disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS_RING}`

// ───────────────────────── 入力の正規化 ─────────────────────────

function digitOf(value: string): string {
  const normalized = value.normalize('NFKC')
  return /^[1-6]$/.test(normalized) ? normalized : ''
}

/** '' = 未入力 / null = 不正 / それ以外は 0 以上の数値を表す正規化済み文字列 */
function normalizeNumber(raw: string): string | null {
  const text = raw.normalize('NFKC').replace(/[,\s]/g, '')
  if (text === '') return ''
  if (!/^\d+(\.\d+)?$/.test(text)) return null
  const value = Number(text)
  return Number.isFinite(value) ? String(value) : null
}

function millionToYen(raw: string): string | null {
  const normalized = normalizeNumber(raw)
  if (normalized == null) return null
  if (normalized === '') return ''
  return String(Math.round(Number(normalized) * YEN_PER_MILLION))
}

function yenToMillion(yen: string): string {
  if (yen === '') return ''
  const value = Number(yen)
  return Number.isFinite(value) ? String(Number((value / YEN_PER_MILLION).toFixed(6))) : ''
}

function queryToDraft(query: ScanQuery): Draft {
  return {
    from: isStageCode(query.from) ? query.from.split('') : DEFAULT_FROM.split(''),
    to: isStageCode(query.to) ? query.to.split('') : DEFAULT_TO.split(''),
    fromAny: query.from === STAGE_TRANSITION_ANY_CODE,
    toAny: query.to === STAGE_TRANSITION_ANY_CODE,
    period: query.period,
    dateFrom: query.dateFrom,
    dateTo: query.dateTo,
    industry33: query.industry33,
    marketSegment: query.marketSegment,
    minPrice: query.minPrice,
    maxPrice: query.maxPrice,
    minAvgVolume: query.minAvgVolume,
    maxAvgVolume: query.maxAvgVolume,
    minTurnoverM: yenToMillion(query.minAvgTurnover),
    maxTurnoverM: yenToMillion(query.maxAvgTurnover),
  }
}

function draftToQuery(draft: Draft, base: ScanQuery): { query: ScanQuery } | { error: string } {
  const from = draft.fromAny ? STAGE_TRANSITION_ANY_CODE : draft.from.join('')
  const to = draft.toAny ? STAGE_TRANSITION_ANY_CODE : draft.to.join('')
  if (!isStageCodeFilter(from) || !isStageCodeFilter(to)) return { error: '6桁すべてに1〜6の数字を入力するか、Anyを指定してください。' }
  if (isStageCode(from) && from === to) return { error: '遷移前と遷移後には異なるコードを指定してください。' }

  if (draft.period === 'custom') {
    if (!isIsoDate(draft.dateFrom) || !isIsoDate(draft.dateTo)) return { error: '期間指定には開始日と終了日が必要です。' }
    if (draft.dateFrom > draft.dateTo) return { error: '終了日は開始日以降にしてください。' }
    if (inclusiveCalendarDays(draft.dateFrom, draft.dateTo) > STAGE_TRANSITION_MAX_CUSTOM_DAYS) {
      return { error: `期間指定は${STAGE_TRANSITION_MAX_CUSTOM_DAYS}日以内にしてください。` }
    }
  }

  const ranges: Array<{ label: string; min: string | null; max: string | null }> = [
    { label: '株価', min: normalizeNumber(draft.minPrice), max: normalizeNumber(draft.maxPrice) },
    { label: '20日平均出来高', min: normalizeNumber(draft.minAvgVolume), max: normalizeNumber(draft.maxAvgVolume) },
    { label: '20日平均売買代金', min: millionToYen(draft.minTurnoverM), max: millionToYen(draft.maxTurnoverM) },
  ]
  for (const { label, min, max } of ranges) {
    if (min == null || max == null) return { error: `${label}には0以上の数値を入力してください。` }
    if (min !== '' && max !== '' && Number(min) > Number(max)) {
      return { error: `${label}の下限は上限以下にしてください。` }
    }
  }

  return {
    query: {
      ...base,
      from,
      to,
      period: draft.period,
      dateFrom: draft.period === 'custom' ? draft.dateFrom : '',
      dateTo: draft.period === 'custom' ? draft.dateTo : '',
      industry33: draft.industry33,
      marketSegment: draft.marketSegment,
      minPrice: ranges[0].min ?? '',
      maxPrice: ranges[0].max ?? '',
      minAvgVolume: ranges[1].min ?? '',
      maxAvgVolume: ranges[1].max ?? '',
      minAvgTurnover: ranges[2].min ?? '',
      maxAvgTurnover: ranges[2].max ?? '',
    },
  }
}

/** ソート・ページ以外 (= 検索条件) の同一性比較用 */
function conditionSignature(query: ScanQuery): string {
  return JSON.stringify([
    query.from, query.to, query.period, query.dateFrom, query.dateTo,
    query.universe,
    query.industry33, query.marketSegment,
    query.minPrice, query.maxPrice, query.minAvgVolume, query.maxAvgVolume,
    query.minAvgTurnover, query.maxAvgTurnover,
  ])
}

function buildSearchParams(query: ScanQuery): URLSearchParams {
  const params = new URLSearchParams()
  params.set('from', query.from)
  params.set('to', query.to)
  params.set('period', query.period)
  if (query.universe) params.set('universe', query.universe)
  if (query.period === 'custom') {
    params.set('dateFrom', query.dateFrom)
    params.set('dateTo', query.dateTo)
  }
  const optional: Array<[string, string]> = [
    ['industry33', query.industry33],
    ['marketSegment', query.marketSegment],
    ['minPrice', query.minPrice],
    ['maxPrice', query.maxPrice],
    ['minAvgVolume', query.minAvgVolume],
    ['maxAvgVolume', query.maxAvgVolume],
    ['minAvgTurnover', query.minAvgTurnover],
    ['maxAvgTurnover', query.maxAvgTurnover],
  ]
  for (const [key, value] of optional) if (value !== '') params.set(key, value)
  params.set('sort', query.sort)
  params.set('direction', query.direction)
  params.set('page', String(query.page))
  params.set('pageSize', String(query.pageSize))
  return params
}

function parseInitialQuery(params: Record<string, string>): ScanQuery {
  const query: ScanQuery = { ...DEFAULT_QUERY }
  const from = (params.from ?? '').toLowerCase()
  const to = (params.to ?? '').toLowerCase()
  if (isStageCodeFilter(from) && isStageCodeFilter(to) && !(isStageCode(from) && from === to)) {
    query.from = from
    query.to = to
  }
  query.universe = params.universe === 'nikkei225' ? 'nikkei225' : ''
  const period = PERIOD_OPTIONS.find((option) => option.key === params.period)?.key
  if (period) query.period = period
  if (query.period === 'custom') {
    if (isIsoDate(params.dateFrom ?? '') && isIsoDate(params.dateTo ?? '')) {
      query.dateFrom = params.dateFrom
      query.dateTo = params.dateTo
    } else {
      query.period = 'today'
    }
  }
  query.industry33 = (params.industry33 ?? '').slice(0, 120)
  query.marketSegment = (params.marketSegment ?? '').slice(0, 120)
  query.minPrice = normalizeNumber(params.minPrice ?? '') ?? ''
  query.maxPrice = normalizeNumber(params.maxPrice ?? '') ?? ''
  query.minAvgVolume = normalizeNumber(params.minAvgVolume ?? '') ?? ''
  query.maxAvgVolume = normalizeNumber(params.maxAvgVolume ?? '') ?? ''
  query.minAvgTurnover = normalizeNumber(params.minAvgTurnover ?? '') ?? ''
  query.maxAvgTurnover = normalizeNumber(params.maxAvgTurnover ?? '') ?? ''
  const sort = SORT_OPTIONS.find((option) => option.key === params.sort)
  if (sort) {
    query.sort = sort.key
    query.direction = params.direction === 'asc' || params.direction === 'desc' ? params.direction : sort.defaultDirection
  }
  const page = Number(params.page)
  if (Number.isInteger(page) && page >= 1) query.page = page
  const pageSize = Number(params.pageSize)
  if ((PAGE_SIZES as readonly number[]).includes(pageSize)) query.pageSize = pageSize
  return query
}

// ───────────────────────── 表示整形 ─────────────────────────

function formatNumber(value: number | null | undefined, maximumFractionDigits = 0): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return value.toLocaleString('ja-JP', { maximumFractionDigits })
}

function formatTurnoverMillion(yen: number | null | undefined): string {
  if (yen == null || !Number.isFinite(yen)) return '—'
  const million = yen / YEN_PER_MILLION
  return million.toLocaleString('ja-JP', { maximumFractionDigits: Math.abs(million) >= 100 ? 0 : 1 })
}

function describeFilters(query: ScanQuery): string[] {
  const parts: string[] = []
  if (query.universe === 'nikkei225') parts.push('ユニバース 日経225')
  if (query.industry33) parts.push(`33業種 ${query.industry33}`)
  if (query.marketSegment) parts.push(`市場 ${query.marketSegment}`)
  const range = (label: string, min: string, max: string, unit: string, convert: (v: string) => string) => {
    if (min === '' && max === '') return
    parts.push(`${label} ${min !== '' ? convert(min) : ''}〜${max !== '' ? convert(max) : ''}${unit}`)
  }
  const asNumber = (value: string) => formatNumber(Number(value), 2)
  range('株価', query.minPrice, query.maxPrice, '円', asNumber)
  range('20日平均出来高', query.minAvgVolume, query.maxAvgVolume, '株', asNumber)
  range('20日平均売買代金', query.minAvgTurnover, query.maxAvgTurnover, '百万円', (v) => asNumber(yenToMillion(v)))
  return parts
}

/** Overview 等から from / to を指定されて到着した場合は、条件を要約して検索フォームを畳む */
function hasExplicitCondition(params: Record<string, string>): boolean {
  return isStageCodeFilter((params.from ?? '').toLowerCase()) && isStageCodeFilter((params.to ?? '').toLowerCase())
}

function describePeriod(query: ScanQuery): string {
  if (query.period === 'today') return '本日'
  if (query.period === 'week') return '今週'
  if (query.period === 'month') return '今月'
  return query.dateFrom === query.dateTo ? query.dateFrom : `${query.dateFrom} 〜 ${query.dateTo}`
}

function describeDirection(query: ScanQuery): string | null {
  const fromAny = query.from === STAGE_TRANSITION_ANY_CODE
  const toAny = query.to === STAGE_TRANSITION_ANY_CODE
  if (fromAny && !toAny) return `${query.to}へ到達`
  if (!fromAny && toAny) return `${query.from}から離脱`
  return null
}

function countActiveFilters(draft: Draft): number {
  return [
    draft.industry33, draft.marketSegment,
    draft.minPrice, draft.maxPrice, draft.minAvgVolume, draft.maxAvgVolume,
    draft.minTurnoverM, draft.maxTurnoverM,
  ].filter((value) => value !== '').length
}

// ───────────────────────── 本体 ─────────────────────────

export function StageTransitionScanner({ initialParams = {} }: { initialParams?: Record<string, string> }) {
  const [applied, setApplied] = useState<ScanQuery>(() => parseInitialQuery(initialParams))
  const [draft, setDraft] = useState<Draft>(() => queryToDraft(parseInitialQuery(initialParams)))
  const [filtersOpen, setFiltersOpen] = useState(() => countActiveFilters(queryToDraft(parseInitialQuery(initialParams))) > 0)
  // 条件つきで到着した場合のみ初期折りたたみ。直接訪問時は検索フォームを開いたままにする
  const [formOpen, setFormOpen] = useState(() => !hasExplicitCondition(initialParams))
  const [formError, setFormError] = useState<string | null>(null)
  const [seq, setSeq] = useState(0)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [options, setOptions] = useState<{ industries33: string[]; marketSegments: string[] }>({
    industries33: [],
    marketSegments: [],
  })
  const digitRefs = useRef<Array<HTMLInputElement | null>>([])
  const resultsTopRef = useRef<HTMLDivElement | null>(null)

  const queryString = useMemo(() => buildSearchParams(applied).toString(), [applied])
  const requestKey = `${seq}|${queryString}`
  const loading = outcome?.key !== requestKey

  // 検索実行 (入力ごとではなく、確定した applied / 再試行時のみ)
  useEffect(() => {
    const controller = new AbortController()
    const key = `${seq}|${queryString}`
    const fail = (message: string) => {
      if (!controller.signal.aborted) setOutcome({ key, ok: false, message })
    }
    const run = async () => {
      try {
        const response = await fetch(`/api/hex/transitions?${queryString}`, {
          cache: 'no-store',
          signal: controller.signal,
        })
        let json: Record<string, unknown> | null = null
        try {
          json = (await response.json()) as Record<string, unknown>
        } catch {
          json = null
        }
        if (controller.signal.aborted) return
        if (!response.ok || !json || json.success !== true) {
          const message = typeof json?.message === 'string' && json.message ? json.message : null
          fail(message ?? '遷移銘柄の検索に失敗しました。時間をおいて再試行してください。')
          return
        }
        const payload = json as unknown as ScanPayload
        if (!Array.isArray(payload.data) || !payload.pagination || !payload.meta?.range) {
          fail('検索結果の形式を読み取れませんでした。時間をおいて再試行してください。')
          return
        }
        if (payload.options) {
          setOptions({
            industries33: payload.options.industries33 ?? [],
            marketSegments: payload.options.marketSegments ?? [],
          })
        }
        setOutcome({ key, ok: true, payload })
      } catch {
        fail('通信に失敗しました。接続を確認して再試行してください。')
      }
    }
    void run()
    return () => controller.abort()
  }, [queryString, seq])

  // 確定した検索条件を URL に反映 (共有・再読込用。サーバー再描画はしない)
  useEffect(() => {
    const params = new URLSearchParams({ view: 'scanner' })
    new URLSearchParams(queryString).forEach((value, key) => params.set(key, value))
    window.history.replaceState(window.history.state, '', `${window.location.pathname}?${params.toString()}`)
  }, [queryString])

  const parsedDraft = useMemo(() => draftToQuery(draft, applied), [draft, applied])
  const dirty = 'error' in parsedDraft || conditionSignature(parsedDraft.query) !== conditionSignature(applied)
  const draftFrom = draft.fromAny ? STAGE_TRANSITION_ANY_CODE : draft.from.join('')
  const draftTo = draft.toAny ? STAGE_TRANSITION_ANY_CODE : draft.to.join('')
  const draftChanged = useMemo(
    () => changedStageCodeAxes(draftFrom, draftTo),
    [draftFrom, draftTo],
  )
  const activeFilterCount = countActiveFilters(draft)

  const updateDraft = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }))

  const setDigit = (row: 'from' | 'to', index: number, value: string) => {
    setDraft((current) => {
      const next = [...current[row]]
      next[index] = value
      return { ...current, [row]: next }
    })
  }
  const focusDigit = (row: number, index: number) => {
    const target = digitRefs.current[row * 6 + index]
    if (target) {
      target.focus()
      target.select()
    }
  }

  const handleDigitChange = (rowKey: 'from' | 'to', row: number, index: number, raw: string) => {
    if (raw === '') {
      setDigit(rowKey, index, '')
      return
    }
    const digit = digitOf(raw.slice(-1))
    if (!digit) return
    setDigit(rowKey, index, digit)
    if (index < 5) focusDigit(row, index + 1)
  }
  const handleDigitKeyDown = (
    event: KeyboardEvent<HTMLInputElement>,
    rowKey: 'from' | 'to',
    row: number,
    index: number,
  ) => {
    if (event.key === 'ArrowLeft' && index > 0) {
      event.preventDefault()
      focusDigit(row, index - 1)
    } else if (event.key === 'ArrowRight' && index < 5) {
      event.preventDefault()
      focusDigit(row, index + 1)
    } else if (event.key === 'Backspace' && draft[rowKey][index] === '' && index > 0) {
      event.preventDefault()
      setDigit(rowKey, index - 1, '')
      focusDigit(row, index - 1)
    }
  }
  const handleDigitPaste = (
    event: ClipboardEvent<HTMLInputElement>,
    rowKey: 'from' | 'to',
    row: number,
    index: number,
  ) => {
    const digits = event.clipboardData.getData('text').normalize('NFKC').replace(/[^1-6]/g, '').slice(0, 6 - index)
    if (!digits) return
    event.preventDefault()
    setDraft((current) => {
      const next = [...current[rowKey]]
      digits.split('').forEach((digit, offset) => {
        next[index + offset] = digit
      })
      return { ...current, [rowKey]: next }
    })
    focusDigit(row, Math.min(5, index + digits.length))
  }

  const submitSearch = (event?: FormEvent) => {
    event?.preventDefault()
    const parsed = draftToQuery(draft, applied)
    if ('error' in parsed) {
      setFormError(parsed.error)
      return
    }
    setFormError(null)
    setApplied({ ...parsed.query, page: 1 })
    setSeq((current) => current + 1)
  }

  const resetAll = () => {
    setDraft(queryToDraft(DEFAULT_QUERY))
    setApplied(DEFAULT_QUERY)
    setFormError(null)
    setFiltersOpen(false)
    setFormOpen(true)
    setSeq((current) => current + 1)
  }

  const scrollToResults = () => resultsTopRef.current?.scrollIntoView({ block: 'start' })

  const changeSort = (key: StageTransitionSort) => {
    setApplied((current) => {
      const defaultDirection = SORT_OPTIONS.find((option) => option.key === key)?.defaultDirection ?? 'desc'
      const direction = current.sort === key ? (current.direction === 'asc' ? 'desc' : 'asc') : defaultDirection
      return { ...current, sort: key, direction, page: 1 }
    })
  }
  const changePage = (page: number) => {
    setApplied((current) => ({ ...current, page }))
    scrollToResults()
  }
  const changePageSize = (pageSize: number) => {
    setApplied((current) => ({ ...current, pageSize, page: 1 }))
  }

  const payload = outcome && outcome.key === requestKey && outcome.ok ? outcome.payload : null
  const errorMessage = outcome && outcome.key === requestKey && !outcome.ok ? outcome.message : null

  return (
    <div className="space-y-3">
      {!formOpen ? <ConditionSummary query={applied} onEdit={() => setFormOpen(true)} /> : null}
      <form
        id="scanner-search-form"
        onSubmit={submitSearch}
        hidden={!formOpen}
        style={formOpen ? undefined : { display: 'none' }}
        className="sb-card sb-card-pad-lg"
        aria-label="遷移スキャナーの検索条件"
      >
        <div className="mb-3 flex items-center justify-between gap-2">
          <span className="text-[12px] font-bold text-[var(--color-text-secondary)]">検索条件</span>
          <button
            type="button"
            aria-expanded={formOpen}
            aria-controls="scanner-search-form"
            onClick={() => setFormOpen(false)}
            className={`inline-flex h-11 items-center gap-1 px-3 text-[12px] font-medium text-[var(--color-text-secondary)] ${FOCUS_RING}`}
            style={BUTTON_STYLE}
          >
            <ChevronUp size={14} aria-hidden />
            条件を折りたたむ
          </button>
        </div>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,480px)_minmax(0,1fr)] lg:gap-6">
          {/* 6桁コード入力 */}
          <fieldset className="m-0 min-w-0 border-0 p-0">
            <legend className="mb-1 p-0 text-[13px] font-bold text-[var(--color-brand-800)]">ステージコード</legend>
            <p className="mb-2 text-[11px] leading-4 text-[var(--color-text-tertiary)]">
              左から 日足A・日足B・週足A・週足B・月足A・月足B。完全一致を基本とし、片側をAnyにすると到達・離脱を横断検索できます。
            </p>
            <div className="mb-2 flex flex-wrap gap-1" aria-label="コード一致方式">
              <AnyModeButton label="遷移前" active={draft.fromAny} onClick={() => updateDraft({ fromAny: !draft.fromAny })} />
              <AnyModeButton label="遷移後" active={draft.toAny} onClick={() => updateDraft({ toAny: !draft.toAny })} />
            </div>
            <div className="grid grid-cols-[48px_repeat(6,minmax(0,1fr))] items-center gap-1">
              <span aria-hidden />
              {STAGE_CODE_AXES.map((axis) => {
                const changed = draftChanged.some((entry) => entry.key === axis.key)
                return (
                  <span
                    key={`head-${axis.key}`}
                    className={
                      changed
                        ? 'border-b-2 border-[var(--color-brand-700)] pb-0.5 text-center text-[10px] font-bold text-[var(--color-brand-800)]'
                        : 'border-b-2 border-transparent pb-0.5 text-center text-[10px] font-medium text-[var(--color-text-tertiary)]'
                    }
                  >
                    {axis.longLabel}
                  </span>
                )
              })}

              {([
                { rowKey: 'from', row: 0, caption: '前', name: '遷移前' },
                { rowKey: 'to', row: 1, caption: '後', name: '遷移後' },
              ] as const).map(({ rowKey, row, caption, name }) => (
                <DigitRow
                  key={rowKey}
                  caption={caption}
                  name={name}
                  digits={draft[rowKey]}
                  otherDigits={draft[rowKey === 'from' ? 'to' : 'from']}
                  any={rowKey === 'from' ? draft.fromAny : draft.toAny}
                  setRef={(index, node) => {
                    digitRefs.current[row * 6 + index] = node
                  }}
                  onChange={(index, raw) => handleDigitChange(rowKey, row, index, raw)}
                  onKeyDown={(event, index) => handleDigitKeyDown(event, rowKey, row, index)}
                  onPaste={(event, index) => handleDigitPaste(event, rowKey, row, index)}
                />
              ))}

              <span className="text-[10px] font-semibold text-[var(--color-text-tertiary)]">変化</span>
              {STAGE_CODE_AXES.map((axis) => {
                const entry = draftChanged.find((candidate) => candidate.key === axis.key)
                return entry ? (
                  <span key={`diff-${axis.key}`} className="text-center text-[12px] font-bold tabular-nums text-[var(--color-brand-800)]">
                    {entry.from}→{entry.to}
                  </span>
                ) : (
                  <span key={`diff-${axis.key}`} className="text-center text-[12px] text-[var(--color-text-tertiary)]">
                    ・
                  </span>
                )
              })}
            </div>
            <p className="mt-2 text-[11px] leading-4 text-[var(--color-text-secondary)]" aria-live="polite">
              {draft.fromAny || draft.toAny
                ? `${draft.fromAny ? 'Any' : draftFrom} → ${draft.toAny ? 'Any' : draftTo}。各結果行には実際の6桁コードと変化軸を表示します。`
                : draftChanged.length > 0
                ? `変化する軸 ${draftChanged.length} 件: ${draftChanged.map((entry) => `${entry.label} ${entry.from}→${entry.to}`).join(' / ')}`
                : '遷移前と遷移後が同じコードです。変化させる軸を指定してください。'}
            </p>
            <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-[var(--color-text-tertiary)]" aria-label="ステージ番号の凡例">
              {[1, 2, 3, 4, 5, 6].map((stage) => (
                <li key={stage} className="inline-flex items-center gap-1">
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-[2px] border border-[var(--color-border-default)]"
                    style={{ background: STAGE_BG_COLORS[stage] }}
                    aria-hidden
                  />
                  {stage} {STAGE_LABELS[stage]}
                </li>
              ))}
            </ul>
          </fieldset>

          {/* 期間 */}
          <div className="min-w-0 space-y-3">
            <fieldset className="m-0 min-w-0 border-0 p-0">
              <legend className="mb-1 p-0 text-[13px] font-bold text-[var(--color-brand-800)]">期間</legend>
              <div role="group" aria-label="期間" className="flex flex-wrap gap-1">
                {PERIOD_OPTIONS.map((option) => (
                  <button
                    key={option.key}
                    type="button"
                    aria-pressed={draft.period === option.key}
                    onClick={() => updateDraft({ period: option.key })}
                    className={`sb-tab${draft.period === option.key ? ' sb-on' : ''} ${FOCUS_RING}`}
                    style={SEGMENT_STYLE}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              {draft.period === 'custom' ? (
                <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <label className="block min-w-0">
                    <span className={LABEL_TEXT}>開始日</span>
                    <input
                      type="date"
                      value={draft.dateFrom}
                      max={draft.dateTo || undefined}
                      onChange={(event) => updateDraft({ dateFrom: event.target.value })}
                      className={`mt-0.5 ${TEXT_FIELD}`}
                      style={FIELD_STYLE}
                    />
                  </label>
                  <label className="block min-w-0">
                    <span className={LABEL_TEXT}>終了日</span>
                    <input
                      type="date"
                      value={draft.dateTo}
                      min={draft.dateFrom || undefined}
                      onChange={(event) => updateDraft({ dateTo: event.target.value })}
                      className={`mt-0.5 ${TEXT_FIELD}`}
                      style={FIELD_STYLE}
                    />
                  </label>
                  <p className="text-[10px] leading-4 text-[var(--color-text-tertiary)] sm:col-span-2">
                    最長 {STAGE_TRANSITION_MAX_CUSTOM_DAYS} 日。休日は営業日に補正され、実際の対象日は検索結果に表示します。
                  </p>
                </div>
              ) : (
                <p className="mt-2 text-[10px] leading-4 text-[var(--color-text-tertiary)]">
                  最新営業日を基準に、本日 = 最新営業日、今週 = 月曜起算、今月 = 当月1日から。
                </p>
              )}
            </fieldset>

            <div>
              <button
                type="button"
                aria-expanded={filtersOpen}
                aria-controls="scanner-secondary-filters"
                onClick={() => setFiltersOpen((open) => !open)}
                className={`inline-flex h-11 items-center gap-1.5 px-3 text-[12px] font-semibold text-[var(--color-brand-800)] ${FOCUS_RING}`}
                style={BUTTON_STYLE}
              >
                <SlidersHorizontal size={14} aria-hidden />
                絞り込み条件
                {activeFilterCount > 0 ? (
                  <span className="rounded-[3px] bg-[var(--color-brand-700)] px-1.5 text-[10px] font-bold leading-4 text-white">
                    {activeFilterCount}
                  </span>
                ) : null}
              </button>
            </div>
          </div>
        </div>

        {filtersOpen ? (
          <div id="scanner-secondary-filters" className="mt-3 grid grid-cols-1 gap-3 border-t border-[var(--color-border-soft)] pt-3 sm:grid-cols-2 lg:grid-cols-3">
            <label className="block min-w-0">
              <span className={LABEL_TEXT}>33業種</span>
              <select
                value={draft.industry33}
                onChange={(event) => updateDraft({ industry33: event.target.value })}
                className={`mt-0.5 ${TEXT_FIELD}`}
                style={FIELD_STYLE}
              >
                <option value="">すべて</option>
                {withCurrent(options.industries33, draft.industry33).map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
            </label>
            <label className="block min-w-0">
              <span className={LABEL_TEXT}>市場区分</span>
              <select
                value={draft.marketSegment}
                onChange={(event) => updateDraft({ marketSegment: event.target.value })}
                className={`mt-0.5 ${TEXT_FIELD}`}
                style={FIELD_STYLE}
              >
                <option value="">すべて</option>
                {withCurrent(options.marketSegments, draft.marketSegment).map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
            </label>
            <div className="hidden lg:block" aria-hidden />
            <RangeField
              label="株価（円）"
              minValue={draft.minPrice}
              maxValue={draft.maxPrice}
              onMin={(value) => updateDraft({ minPrice: value })}
              onMax={(value) => updateDraft({ maxPrice: value })}
            />
            <RangeField
              label="20日平均出来高（株）"
              minValue={draft.minAvgVolume}
              maxValue={draft.maxAvgVolume}
              onMin={(value) => updateDraft({ minAvgVolume: value })}
              onMax={(value) => updateDraft({ maxAvgVolume: value })}
            />
            <RangeField
              label="20日平均売買代金（百万円）"
              minValue={draft.minTurnoverM}
              maxValue={draft.maxTurnoverM}
              onMin={(value) => updateDraft({ minTurnoverM: value })}
              onMax={(value) => updateDraft({ maxTurnoverM: value })}
            />
          </div>
        ) : null}

        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-[var(--color-border-soft)] pt-3">
          <button
            type="submit"
            className={`inline-flex h-11 min-w-[112px] items-center justify-center gap-1.5 px-4 text-[13px] font-bold text-white ${FOCUS_RING}`}
            style={{ background: 'var(--color-brand-700)', border: '1px solid var(--color-brand-700)', borderRadius: 4 }}
          >
            <Search size={15} aria-hidden />
            検索
          </button>
          <button
            type="button"
            onClick={resetAll}
            className={`inline-flex h-11 min-w-[96px] items-center justify-center gap-1.5 px-4 text-[13px] font-medium text-[var(--color-text-secondary)] ${FOCUS_RING}`}
            style={BUTTON_STYLE}
          >
            <RotateCcw size={14} aria-hidden />
            リセット
          </button>
          <span className="min-w-0 text-[11px] leading-4 text-[var(--color-text-tertiary)]">
            {dirty && !formError ? '未反映の変更があります。「検索」または Enter で反映されます。' : ''}
          </span>
        </div>
        {formError ? (
          <p role="alert" className="mt-2 flex items-start gap-1.5 text-[12px] font-medium text-[var(--color-price-up-mid)]">
            <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden />
            {formError}
          </p>
        ) : null}
      </form>

      {/* 結果 */}
      <div ref={resultsTopRef} className="scroll-mt-32" />
      {errorMessage ? (
        <div className="sb-card sb-card-pad-lg" role="alert">
          <div className="flex items-start gap-2">
            <TriangleAlert size={18} className="mt-0.5 shrink-0 text-[var(--color-price-up-mid)]" aria-hidden />
            <div className="min-w-0">
              <div className="text-[13px] font-bold text-[var(--color-text-primary)]">検索できませんでした</div>
              <p className="mt-1 text-[12px] leading-5 text-[var(--color-text-secondary)]">{errorMessage}</p>
              <button
                type="button"
                onClick={() => setSeq((current) => current + 1)}
                className={`mt-3 inline-flex h-11 items-center gap-1.5 px-4 text-[13px] font-medium text-[var(--color-brand-800)] ${FOCUS_RING}`}
                style={BUTTON_STYLE}
              >
                <RefreshCw size={14} aria-hidden />
                再試行
              </button>
            </div>
          </div>
        </div>
      ) : loading || !payload ? (
        <ResultSkeleton />
      ) : (
        <ResultView
          payload={payload}
          applied={applied}
          showConditions={formOpen}
          onSort={changeSort}
          onPage={changePage}
          onPageSize={changePageSize}
        />
      )}
    </div>
  )
}

function withCurrent(values: string[], current: string): string[] {
  return current && !values.includes(current) ? [current, ...values] : values
}

/** 検索フォームを畳んだ状態で、確定済みの検索条件を1ブロックで示す */
function ConditionSummary({ query, onEdit }: { query: ScanQuery; onEdit: () => void }) {
  const filters = describeFilters(query)
  const direction = describeDirection(query)
  return (
    <section className="sb-card sb-card-pad" aria-label="現在の検索条件">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <CodePair from={query.from} to={query.to} />
            {direction ? (
              <span className="rounded-[3px] bg-[var(--color-brand-50)] px-1.5 text-[11px] font-bold leading-5 text-[var(--color-brand-800)]">
                {direction}
              </span>
            ) : null}
            <span className="text-[12px] tabular-nums text-[var(--color-text-secondary)]">期間 {describePeriod(query)}</span>
            {filters.length > 0 ? (
              <span className="min-w-0 text-[12px] text-[var(--color-text-secondary)]">{filters.join(' / ')}</span>
            ) : null}
          </div>
          <StageTransitionAxisChips fromCode={query.from} toCode={query.to} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={query.universe ? `/hex-stage?universe=${encodeURIComponent(query.universe)}` : '/hex-stage'}
            className={`inline-flex h-11 items-center gap-1.5 px-3 text-[12px] font-semibold text-[var(--color-brand-800)] no-underline ${FOCUS_RING}`}
            style={BUTTON_STYLE}
          >
            <ArrowLeft size={14} aria-hidden />
            市場概況へ
          </Link>
          <button
            type="button"
            aria-expanded={false}
            aria-controls="scanner-search-form"
            onClick={onEdit}
            className={`inline-flex h-11 items-center gap-1.5 px-3 text-[12px] font-semibold text-[var(--color-brand-800)] ${FOCUS_RING}`}
            style={BUTTON_STYLE}
          >
            <SlidersHorizontal size={14} aria-hidden />
            条件を変更
          </button>
        </div>
      </div>
    </section>
  )
}

// ───────────────────────── 入力部品 ─────────────────────────

function AnyModeButton({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`inline-flex h-8 items-center gap-1.5 px-2.5 text-[11px] font-semibold ${FOCUS_RING}`}
      style={{
        border: `1px solid ${active ? 'var(--color-brand-700)' : 'var(--color-border-default)'}`,
        borderRadius: 4,
        background: active ? 'var(--color-brand-50)' : '#fff',
        color: active ? 'var(--color-brand-800)' : 'var(--color-text-secondary)',
      }}
    >
      {label}: {active ? 'Any' : '完全一致'}
    </button>
  )
}

function DigitRow({
  caption,
  name,
  digits,
  otherDigits,
  any,
  setRef,
  onChange,
  onKeyDown,
  onPaste,
}: {
  caption: string
  name: string
  digits: string[]
  otherDigits: string[]
  any: boolean
  setRef: (index: number, node: HTMLInputElement | null) => void
  onChange: (index: number, raw: string) => void
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>, index: number) => void
  onPaste: (event: ClipboardEvent<HTMLInputElement>, index: number) => void
}) {
  return (
    <>
      <span className="text-[11px] font-bold text-[var(--color-text-secondary)]" aria-hidden>{caption}</span>
      {any ? (
        <span className="col-span-6 flex h-11 items-center justify-center rounded-[4px] border border-dashed border-[var(--color-brand-500)] bg-[var(--color-brand-50)] text-[12px] font-bold text-[var(--color-brand-800)]">
          Any（全コード）
        </span>
      ) : STAGE_CODE_AXES.map((axis, index) => {
        const digit = digits[index] ?? ''
        const valid = /^[1-6]$/.test(digit)
        const changed = valid && /^[1-6]$/.test(otherDigits[index] ?? '') && digit !== otherDigits[index]
        return (
          <input
            key={axis.key}
            ref={(node) => setRef(index, node)}
            value={digit}
            inputMode="numeric"
            autoComplete="off"
            maxLength={2}
            aria-label={`${name} ${axis.longLabel}`}
            aria-invalid={digit !== '' && !valid}
            onChange={(event) => onChange(index, event.target.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
            onPaste={(event) => onPaste(event, index)}
            onFocus={(event) => event.target.select()}
            className={changed ? DIGIT_INPUT_CHANGED : DIGIT_INPUT_PLAIN}
            style={{
              borderStyle: 'solid',
              borderWidth: changed ? 2 : 1,
              borderColor: changed ? 'var(--color-brand-700)' : 'var(--color-border-default)',
              borderRadius: 4,
              background: valid ? STAGE_BG_COLORS[Number(digit)] : 'var(--color-surface-field)',
              color: valid ? `var(--color-stage-${digit}-text)` : 'var(--color-text-primary)',
            }}
          />
        )
      })}
    </>
  )
}

function RangeField({
  label,
  minValue,
  maxValue,
  onMin,
  onMax,
}: {
  label: string
  minValue: string
  maxValue: string
  onMin: (value: string) => void
  onMax: (value: string) => void
}) {
  return (
    <fieldset className="m-0 min-w-0 border-0 p-0">
      <legend className={`${LABEL_TEXT} mb-0.5 p-0`}>{label}</legend>
      <div className="flex items-center gap-1.5">
        <input
          value={minValue}
          onChange={(event) => onMin(event.target.value)}
          inputMode="decimal"
          autoComplete="off"
          placeholder="下限"
          aria-label={`${label} 下限`}
          className={TEXT_FIELD}
          style={FIELD_STYLE}
        />
        <span className="text-[12px] text-[var(--color-text-tertiary)]" aria-hidden>〜</span>
        <input
          value={maxValue}
          onChange={(event) => onMax(event.target.value)}
          inputMode="decimal"
          autoComplete="off"
          placeholder="上限"
          aria-label={`${label} 上限`}
          className={TEXT_FIELD}
          style={FIELD_STYLE}
        />
      </div>
    </fieldset>
  )
}

// ───────────────────────── 結果表示 ─────────────────────────

function ResultSkeleton() {
  return (
    <div className="sb-card" role="status" aria-live="polite" aria-busy="true">
      <div className="flex items-center gap-2 border-b border-[var(--color-border-soft)] px-3 py-3 text-[12px] text-[var(--color-text-secondary)]">
        <LoaderCircle size={14} className="animate-spin" aria-hidden />
        遷移銘柄を検索中…
      </div>
      <div className="space-y-px">
        {Array.from({ length: 8 }, (_, index) => (
          <div key={index} className="flex h-[60px] items-center gap-3 border-b border-[var(--color-border-soft)] px-3 last:border-b-0">
            <div className="h-3 w-20 animate-pulse rounded-[3px] bg-[var(--color-surface-muted)]" />
            <div className="h-3 flex-1 animate-pulse rounded-[3px] bg-[var(--color-surface-muted)]" />
            <div className="hidden h-3 w-24 animate-pulse rounded-[3px] bg-[var(--color-surface-muted)] md:block" />
          </div>
        ))}
      </div>
    </div>
  )
}

function ResultView({
  payload,
  applied,
  showConditions,
  onSort,
  onPage,
  onPageSize,
}: {
  payload: ScanPayload
  applied: ScanQuery
  /** 条件要約が別に表示されていない (フォームが開いている) 場合に、結果側で条件を併記する */
  showConditions: boolean
  onSort: (key: StageTransitionSort) => void
  onPage: (page: number) => void
  onPageSize: (pageSize: number) => void
}) {
  const { data, pagination, meta } = payload
  const range = meta.range
  const anyMode = applied.from === STAGE_TRANSITION_ANY_CODE || applied.to === STAGE_TRANSITION_ANY_CODE
  const changedAxes = anyMode ? [] : data[0]?.changedAxes ?? changedStageCodeAxes(applied.from, applied.to)
  const filters = describeFilters(applied)
  const first = pagination.total === 0 ? 0 : (pagination.page - 1) * pagination.pageSize + 1
  const last = Math.min(pagination.total, (pagination.page - 1) * pagination.pageSize + data.length)
  const sameRange = range.startDate === range.endDate
  const adjusted =
    range.requestedStartDate !== range.startDate || range.requestedEndDate !== range.endDate

  return (
    <div className="space-y-3">
      <section className="sb-card sb-card-pad" aria-label="検索結果の概要">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <div className="text-[18px] font-bold tabular-nums text-[var(--color-brand-900)]">
            {pagination.total.toLocaleString('ja-JP')}
            <span className="ml-0.5 text-[12px] font-medium text-[var(--color-text-secondary)]">件の遷移</span>
          </div>
          {showConditions ? <CodePair from={applied.from} to={applied.to} /> : null}
          <span className="text-[12px] tabular-nums text-[var(--color-text-secondary)]">
            対象期間 <span className="font-medium text-[var(--color-text-primary)]">{sameRange ? range.startDate : `${range.startDate} 〜 ${range.endDate}`}</span>
          </span>
        </div>
        {anyMode ? (
          <div className="mt-1 text-[12px] leading-5 text-[var(--color-text-secondary)]">
            変化した桁・軸は行ごとに異なります。各行に実際のコードと変化軸を表示します。
          </div>
        ) : showConditions ? (
          // 条件要約が出ている間は要約側に同じチップがあるため、フォーム展開時だけ結果側に出す
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[12px] text-[var(--color-text-secondary)]">変化した軸</span>
            {changedAxes.length > 0 ? <StageTransitionAxisChips fromCode={applied.from} toCode={applied.to} /> : <span className="text-[12px] text-[var(--color-text-tertiary)]">なし</span>}
          </div>
        ) : null}
        {adjusted ? (
          <div className="mt-0.5 text-[11px] tabular-nums text-[var(--color-text-tertiary)]">
            指定期間 {range.requestedStartDate} 〜 {range.requestedEndDate} を営業日に補正
          </div>
        ) : null}
        {showConditions && filters.length > 0 ? (
          <div className="mt-0.5 text-[11px] text-[var(--color-text-secondary)]">絞り込み: {filters.join(' / ')}</div>
        ) : null}
        <details className="group mt-1">
          <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-1.5 text-[11px] font-medium text-[var(--color-text-tertiary)] marker:hidden">
            <Info size={13} aria-hidden />
            判定の前提（PIT・欠損の扱い）
            <span className="group-open:hidden" aria-hidden>▾</span>
            <span className="hidden group-open:inline" aria-hidden>▴</span>
          </summary>
          <div className="space-y-1 pb-1 text-[11px] leading-4 text-[var(--color-text-tertiary)]">
            <p className="m-0 tabular-nums">
              最新営業日 {range.latestDate}
              {range.previousMarketDate ? ` · 直前営業日 ${range.previousMarketDate}` : ''}
            </p>
            <p className="m-0">
              {meta.pit ? '各営業日に保存されたステージ記録（PIT）で判定しています。' : ''}
              {meta.missingStagePolicy === 'EXCLUDE_AND_DO_NOT_BRIDGE'
                ? 'ステージが欠けている行は除外し、前後の日を結んで遷移とは扱いません。'
                : ''}
              株価は遷移日の終値、{meta.averageSessions}日平均は遷移日までの{meta.averageSessions}営業日で算出しています。同じ銘柄が複数日に該当する場合は、それぞれ1件として数えます。
            </p>
          </div>
        </details>
      </section>

      <section className="sb-card" aria-label="遷移銘柄一覧">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-3 py-2">
          <div className="text-[12px] tabular-nums text-[var(--color-text-secondary)]" aria-live="polite">
            {pagination.total === 0
              ? '該当なし'
              : `${first.toLocaleString('ja-JP')}–${last.toLocaleString('ja-JP')} / ${pagination.total.toLocaleString('ja-JP')} 件`}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 xl:hidden">
              <label className="sr-only" htmlFor="scanner-sort-key">並び替え</label>
              <select
                id="scanner-sort-key"
                value={applied.sort}
                onChange={(event) => onSort(event.target.value as StageTransitionSort)}
                className={`h-11 px-2 text-[12px] ${FOCUS_RING}`}
                style={FIELD_STYLE}
              >
                {SORT_OPTIONS.map((option) => (
                  <option key={option.key} value={option.key}>{option.label}</option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => onSort(applied.sort)}
                aria-label={`並び順を切り替え（現在: ${applied.direction === 'asc' ? '昇順' : '降順'}）`}
                className={ICON_BUTTON}
                style={BUTTON_STYLE}
              >
                {applied.direction === 'asc' ? <ArrowUp size={14} aria-hidden /> : <ArrowDown size={14} aria-hidden />}
                {applied.direction === 'asc' ? '昇順' : '降順'}
              </button>
            </div>
            <label className="flex items-center gap-1.5 text-[12px] text-[var(--color-text-secondary)]">
              表示件数
              <select
                value={applied.pageSize}
                onChange={(event) => onPageSize(Number(event.target.value))}
                className={`h-11 px-2 text-[12px] ${FOCUS_RING}`}
                style={FIELD_STYLE}
              >
                {PAGE_SIZES.map((size) => (
                  <option key={size} value={size}>{size}件</option>
                ))}
              </select>
            </label>
          </div>
        </div>

        {data.length === 0 ? (
          <EmptyState outOfRange={pagination.total > 0} onFirstPage={() => onPage(1)} />
        ) : (
          <>
            <DesktopTable rows={data} sort={applied.sort} direction={applied.direction} onSort={onSort} />
            <MobileList rows={data} />
          </>
        )}

        <Pagination pagination={pagination} onPage={onPage} />
      </section>
    </div>
  )
}

function CodePair({ from, to, size = 'md' }: { from: string; to: string; size?: 'md' | 'sm' }) {
  return (
    <div className="flex items-center gap-2" role="img" aria-label={`遷移 ${from} から ${to}`}>
      <StageCodeDigits code={from} other={to} size={size} />
      <span className="text-[14px] text-[var(--color-text-tertiary)]" aria-hidden>→</span>
      <StageCodeDigits code={to} other={from} size={size} />
    </div>
  )
}

function EmptyState({ outOfRange, onFirstPage }: { outOfRange: boolean; onFirstPage: () => void }) {
  return (
    <div className="flex min-h-[200px] flex-col items-center justify-center gap-2 px-4 py-8 text-center">
      <Search size={22} className="text-[var(--color-text-tertiary)]" aria-hidden />
      {outOfRange ? (
        <>
          <p className="m-0 text-[13px] font-bold text-[var(--color-text-primary)]">このページには結果がありません</p>
          <button
            type="button"
            onClick={onFirstPage}
            className={`inline-flex h-11 items-center gap-1.5 px-4 text-[13px] font-medium text-[var(--color-brand-800)] ${FOCUS_RING}`}
            style={BUTTON_STYLE}
          >
            <ChevronsLeft size={14} aria-hidden />
            1ページ目へ
          </button>
        </>
      ) : (
        <>
          <p className="m-0 text-[13px] font-bold text-[var(--color-text-primary)]">条件に一致する遷移はありません</p>
          <p className="m-0 max-w-[420px] text-[12px] leading-5 text-[var(--color-text-secondary)]">
            期間を広げる、絞り込み条件を外す、またはステージコードを変更して再検索してください。
          </p>
        </>
      )}
    </div>
  )
}

const TABLE_COLUMNS: Array<({
  key: StageTransitionSort
  sortable: true
} | {
  key: 'transition'
  sortable: false
}) & {
  label: string
  align: 'left' | 'right'
}> = [
  { key: 'date', sortable: true, label: '遷移日', align: 'left' },
  { key: 'ticker', sortable: true, label: '銘柄', align: 'left' },
  { key: 'transition', sortable: false, label: '遷移前 → 遷移後 / 変化した軸', align: 'left' },
  { key: 'industry', sortable: true, label: '33業種 / 市場', align: 'left' },
  { key: 'price', sortable: true, label: '遷移日終値（円）', align: 'right' },
  { key: 'avgVolume', sortable: true, label: '20日平均出来高（株）', align: 'right' },
  { key: 'avgTurnover', sortable: true, label: '20日平均売買代金（百万円）', align: 'right' },
]

function DesktopTable({
  rows,
  sort,
  direction,
  onSort,
}: {
  rows: StageTransitionRow[]
  sort: StageTransitionSort
  direction: StageTransitionSortDirection
  onSort: (key: StageTransitionSort) => void
}) {
  return (
    <div className="hidden overflow-x-auto xl:block">
      <table className="w-full min-w-[1020px] border-collapse text-[13px] tabular-nums">
        <thead>
          <tr className="bg-[var(--color-surface-muted)]">
            {TABLE_COLUMNS.map((column) => {
              const active = column.sortable && sort === column.key
              return (
                <th
                  key={column.key}
                  scope="col"
                  aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}
                  className={`border-b border-[var(--color-border-default)] p-0 text-[12px] font-bold text-[var(--color-brand-800)] ${
                    column.align === 'right' ? 'text-right' : 'text-left'
                  }`}
                >
                  {column.sortable ? (
                    <button
                      type="button"
                      onClick={() => onSort(column.key)}
                      className={`inline-flex min-h-11 w-full items-center gap-1 px-3 py-1 font-bold ${
                        column.align === 'right' ? 'justify-end text-right' : 'justify-start text-left'
                      } ${FOCUS_RING}`}
                    >
                      {column.label}
                      {active ? (
                        direction === 'asc' ? <ArrowUp size={12} aria-hidden /> : <ArrowDown size={12} aria-hidden />
                      ) : (
                        <ArrowUpDown size={12} className="opacity-40" aria-hidden />
                      )}
                    </button>
                  ) : (
                    <span className="inline-flex min-h-11 w-full items-center px-3 py-1">{column.label}</span>
                  )}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.ticker}-${row.transitionDate}`} className="border-b border-[var(--color-border-soft)] last:border-b-0 hover:bg-[#fff8e6]">
              <td className="whitespace-nowrap px-3 py-2.5 text-[var(--color-text-secondary)]">{row.transitionDate}</td>
              <td className="max-w-[240px] px-3 py-2.5">
                <TickerLink row={row} />
              </td>
              <td className="min-w-[270px] px-3 py-2.5">
                <CodePair from={row.fromCode} to={row.toCode} size="sm" />
                <StageTransitionAxisChips className="mt-1" fromCode={row.fromCode} toCode={row.toCode} />
              </td>
              <td className="max-w-[200px] px-3 py-2.5">
                <div className="truncate text-[var(--color-text-primary)]">{row.sector33 ?? '—'}</div>
                <div className="truncate text-[11px] text-[var(--color-text-tertiary)]">{row.marketSegment ?? '—'}</div>
              </td>
              <td className="whitespace-nowrap px-3 py-2.5 text-right">{formatNumber(row.price, 1)}</td>
              <td className="whitespace-nowrap px-3 py-2.5 text-right">{formatNumber(row.averageVolume20)}</td>
              <td className="whitespace-nowrap px-3 py-2.5 text-right">{formatTurnoverMillion(row.averageTurnover20)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function MobileList({ rows }: { rows: StageTransitionRow[] }) {
  return (
    <ul className="m-0 list-none p-0 xl:hidden">
      {rows.map((row) => (
        <li key={`${row.ticker}-${row.transitionDate}`} className="border-b border-[var(--color-border-soft)] px-3 py-3 last:border-b-0">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <TickerLink row={row} />
            </div>
            <span className="shrink-0 pt-0.5 text-[11px] tabular-nums text-[var(--color-text-tertiary)]">{row.transitionDate}</span>
          </div>
          <div className="mt-1 truncate text-[11px] text-[var(--color-text-secondary)]">
            {row.sector33 ?? '—'}
            <span className="text-[var(--color-text-tertiary)]"> · {row.marketSegment ?? '—'}</span>
          </div>
          <div className="mt-2 space-y-1.5">
            <CodePair from={row.fromCode} to={row.toCode} />
            <StageTransitionAxisChips fromCode={row.fromCode} toCode={row.toCode} />
          </div>
          <dl className="mt-2 grid grid-cols-3 gap-2 text-[11px] tabular-nums">
            <MobileStat label="遷移日終値（円）" value={formatNumber(row.price, 1)} />
            <MobileStat label="20日平均出来高（株）" value={formatNumber(row.averageVolume20)} />
            <MobileStat label="20日平均売買代金（百万円）" value={formatTurnoverMillion(row.averageTurnover20)} />
          </dl>
        </li>
      ))}
    </ul>
  )
}

function MobileStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] leading-3 text-[var(--color-text-tertiary)]">{label}</dt>
      <dd className="m-0 mt-0.5 truncate text-[13px] font-medium text-[var(--color-text-primary)]">{value}</dd>
    </div>
  )
}

function TickerLink({ row }: { row: StageTransitionRow }) {
  return (
    <Link
      href={`/stock/${encodeURIComponent(row.ticker)}`}
      className={`flex min-h-11 min-w-0 flex-col justify-center text-[var(--color-brand-700)] hover:underline ${FOCUS_RING}`}
    >
      <span className="font-bold tabular-nums">{row.ticker}</span>
      <span className="truncate text-[12px] font-medium text-[var(--color-text-primary)]">{row.name}</span>
    </Link>
  )
}

function Pagination({
  pagination,
  onPage,
}: {
  pagination: ScanPayload['pagination']
  onPage: (page: number) => void
}) {
  const { page, totalPages } = pagination
  if (totalPages <= 1) return null
  return (
    <nav
      aria-label="ページ送り"
      className="flex items-center justify-center gap-1 border-t border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-3 py-2"
    >
      <button type="button" onClick={() => onPage(1)} disabled={page <= 1} aria-label="最初のページ" className={ICON_BUTTON} style={BUTTON_STYLE}>
        <ChevronsLeft size={16} aria-hidden />
      </button>
      <button type="button" onClick={() => onPage(page - 1)} disabled={page <= 1} aria-label="前のページ" className={ICON_BUTTON} style={BUTTON_STYLE}>
        <ChevronLeft size={16} aria-hidden />
      </button>
      <span className="min-w-[88px] text-center text-[12px] tabular-nums text-[var(--color-text-secondary)]">
        {page} / {totalPages}
      </span>
      <button type="button" onClick={() => onPage(page + 1)} disabled={page >= totalPages} aria-label="次のページ" className={ICON_BUTTON} style={BUTTON_STYLE}>
        <ChevronRight size={16} aria-hidden />
      </button>
      <button type="button" onClick={() => onPage(totalPages)} disabled={page >= totalPages} aria-label="最後のページ" className={ICON_BUTTON} style={BUTTON_STYLE}>
        <ChevronsRight size={16} aria-hidden />
      </button>
    </nav>
  )
}
