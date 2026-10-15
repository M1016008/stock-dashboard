'use client'

// app/us/trigger-discovery/UsTriggerDiscoveryClient.tsx
//
// US 条件トリガーの画面状態。
// - 検索は送信 (ボタン / Enter) と、結果の表示操作 (Status・並び順・ページ) のときだけ実行する。入力中は検索しない
// - 成功したら条件フォームを畳み、サマリーと「条件を編集」だけを残す
// - 再検索中は前の結果を薄く残す。古いリクエストは AbortController と連番で捨てる
// - ミニチャートは表示中ページ分を 1 回のリクエストで取り、ticker / 足種 / 評価日 / MA 期間で cache する。
//   失敗しても検索結果は消さない
// - Status / Score / 距離はサーバーの値をそのまま表示する。クライアントで行う変換は $M → USD のみ

import Link from 'next/link'
import {
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { ChevronLeft, ChevronRight, LoaderCircle, RefreshCw, Search } from 'lucide-react'
import { EmptyState, Notice } from '@/components/ui/EmptyState'
import { fmtCount, fmtUsd } from '@/components/us/UsMarketMomentumParts'
import { UsSavedTriggerBar } from '@/components/us/trigger-discovery/UsSavedTriggerBar'
import { UsTriggerConditionBuilder } from '@/components/us/trigger-discovery/UsTriggerConditionBuilder'
import { FOCUS_RING } from '@/components/us/trigger-discovery/UsTriggerControls'
import { UsTriggerResultCards } from '@/components/us/trigger-discovery/UsTriggerResultCards'
import { UsTriggerResultHeader } from '@/components/us/trigger-discovery/UsTriggerResultHeader'
import {
  UsTriggerResultsTable,
  type UsTriggerChartState,
} from '@/components/us/trigger-discovery/UsTriggerResultsTable'
import {
  STAGE_AXIS_LABELS,
  STATUS_LABELS,
  US_TRIGGER_DEFAULTS,
  US_TRIGGER_PAGE_SIZES,
  buildUsTriggerRequest,
  defaultUsTriggerDraft,
  fmtUsdCompact,
  maPeriodCode,
  usMiniChartKey,
  usTriggerStateFromRequest,
  type UsTriggerDraft,
  type UsTriggerPageSize,
  type UsTriggerStatusFilter,
  type UsTriggerViewConfig,
} from '@/components/us/trigger-discovery/usTriggerDiscoveryShared'
import {
  savedTriggerConfigsFromSearchRequest,
  searchRequestFromSavedTrigger,
  type SavedTriggerDefinition,
} from '@/lib/trigger-definition'
import type {
  TriggerDiscoveryMiniChart,
  TriggerDiscoveryMiniChartsResponse,
  TriggerDiscoverySearchRequest,
  TriggerDiscoverySortKey,
} from '@/lib/trigger-discovery-contract'
import type {
  UsTriggerDiscoveryOptionsResponse,
  UsTriggerDiscoverySearchResponse,
} from '@/lib/us-trigger-discovery-contract'

const SEARCH_CONTRACT = 'us-trigger-discovery-search-v1'
const RETURN_STORAGE_KEY = 'stockboard:us-trigger-discovery:return'
const RETURN_HISTORY_KEY = '__usTriggerDiscoveryReturn'
const MINI_CHART_CACHE_LIMIT = 600

/** 値が大きいほど良い列は、最初のクリックで降順にする */
const DESC_FIRST_SORT_KEYS = new Set<TriggerDiscoverySortKey>(['triggerScore', 'price', 'averageTradingValue', 'averageVolume'])

/** lg 未満 (カード表示) の並び順。列見出しがないため選択式にする */
const CARD_SORT_OPTIONS: Array<{ value: string; label: string; sort: TriggerDiscoverySearchRequest['sort'] }> = [
  { value: '', label: '既定', sort: null },
  { value: 'triggerScore:desc', label: 'Score 高い順', sort: { key: 'triggerScore', direction: 'desc' } },
  { value: 'zoneDistance:asc', label: 'Zone距離 近い順', sort: { key: 'zoneDistance', direction: 'asc' } },
  { value: 'averageTradingValue:desc', label: '平均売買代金 多い順', sort: { key: 'averageTradingValue', direction: 'desc' } },
  { value: 'price:desc', label: '株価 高い順', sort: { key: 'price', direction: 'desc' } },
  { value: 'ticker:asc', label: 'ティッカー順', sort: { key: 'ticker', direction: 'asc' } },
]

interface ReturnSnapshot {
  version: 1
  token: string
  url: string
  draft: UsTriggerDraft
  view: UsTriggerViewConfig
  response: UsTriggerDiscoverySearchResponse
  lastRequest: TriggerDiscoverySearchRequest
  builderOpen: boolean
  scrollY: number
  /** 読込・保存済みの US Trigger。古い snapshot には無い */
  activeSavedId?: string | null
}

function messageFrom(body: unknown): string | null {
  if (body && typeof body === 'object' && 'message' in body && typeof body.message === 'string' && body.message) {
    return body.message
  }
  return null
}

function currentUrl(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`
}

function sortValue(sort: TriggerDiscoverySearchRequest['sort']): string {
  return sort ? `${sort.key}:${sort.direction}` : ''
}

/** 表の列見出しや復元で選択肢にない並び順になったとき、選択欄にその並び順を示すための名前 */
function sortKeyLabel(key: TriggerDiscoverySortKey, response: UsTriggerDiscoverySearchResponse): string {
  if (key in STAGE_AXIS_LABELS) return `6ステージ ${STAGE_AXIS_LABELS[key as keyof typeof STAGE_AXIS_LABELS]}`
  const ma = (period: number) => maPeriodCode(period, response.meta.timeframe)
  const labels: Partial<Record<TriggerDiscoverySortKey, string>> = {
    ticker: 'ティッカー',
    triggerStatus: 'Status',
    triggerScore: 'Trigger Score',
    price: '株価',
    zoneDistance: 'Zone距離',
    ma1Distance: `${ma(response.criteria.ma1Period)}距離`,
    ma2Distance: `${ma(response.criteria.ma2Period)}距離`,
    averageTradingValue: '平均売買代金',
    averageVolume: '平均出来高',
    approachVelocity: '接近速度',
  }
  return labels[key] ?? key
}

export function UsTriggerDiscoveryClient({ options }: { options: UsTriggerDiscoveryOptionsResponse }) {
  const [draft, setDraft] = useState<UsTriggerDraft>(() => defaultUsTriggerDraft(options.latestAsOf))
  const [view, setView] = useState<UsTriggerViewConfig>({ sort: null, pageSize: US_TRIGGER_DEFAULTS.pageSize, statusFilter: null })
  const [response, setResponse] = useState<UsTriggerDiscoverySearchResponse | null>(null)
  const [lastRequest, setLastRequest] = useState<TriggerDiscoverySearchRequest | null>(null)
  const [builderOpen, setBuilderOpen] = useState(true)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeSavedId, setActiveSavedId] = useState<string | null>(null)
  const requestSequence = useRef(0)
  const abortController = useRef<AbortController | null>(null)
  const resultsRef = useRef<HTMLElement | null>(null)
  const pendingScrollY = useRef<number | null>(null)

  const chartCache = useRef(new Map<string, TriggerDiscoveryMiniChart>())
  const chartSequence = useRef(0)
  const chartAbortController = useRef<AbortController | null>(null)
  const [charts, setCharts] = useState<ReadonlyMap<string, TriggerDiscoveryMiniChart>>(() => new Map())
  const [chartLoadingKeys, setChartLoadingKeys] = useState<ReadonlySet<string>>(() => new Set())
  const [chartFailedKeys, setChartFailedKeys] = useState<ReadonlySet<string>>(() => new Set())
  const [chartBatchFailed, setChartBatchFailed] = useState(false)
  const [chartRetry, setChartRetry] = useState(0)

  const exchangeLabel = useCallback((value: string | null) => (
    value == null ? '取引所不明' : options.exchanges.find((exchange) => exchange.value === value)?.label ?? value
  ), [options.exchanges])

  /* ---------- 検索 ---------- */

  const runSearch = async (
    request: TriggerDiscoverySearchRequest,
    { collapse = false, revealResults = false }: { collapse?: boolean; revealResults?: boolean } = {},
  ) => {
    abortController.current?.abort()
    const controller = new AbortController()
    abortController.current = controller
    const sequence = ++requestSequence.current
    setLoading(true)
    setError(null)
    try {
      const apiResponse = await fetch('/api/us/trigger-discovery/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        cache: 'no-store',
        signal: controller.signal,
      })
      let body: unknown = null
      try {
        body = await apiResponse.json()
      } catch {
        body = null
      }
      if (!apiResponse.ok) {
        throw new Error(messageFrom(body) ?? (apiResponse.status === 422 || apiResponse.status === 400
          ? '検索条件を確認してください。'
          : '検索に失敗しました。時間をおいて再度お試しください。'))
      }
      if (sequence !== requestSequence.current) return
      const result = body as UsTriggerDiscoverySearchResponse | null
      if (result?.contractVersion !== SEARCH_CONTRACT) {
        throw new Error('検索結果の形式が想定と異なります。ページを再読み込みしてください。')
      }
      setResponse(result)
      setLastRequest(request)
      if (collapse) {
        setBuilderOpen(false)
        // 畳んだフォームにあったフォーカスを結果の見出しへ移す
        window.requestAnimationFrame(() => resultsRef.current?.focus({ preventScroll: false }))
      } else if (revealResults && resultsRef.current && resultsRef.current.getBoundingClientRect().top < 0) {
        resultsRef.current.scrollIntoView({ block: 'start' })
      }
    } catch (searchError) {
      if (controller.signal.aborted || sequence !== requestSequence.current) return
      const message = searchError instanceof TypeError
        ? '通信に失敗しました。接続を確認して再度お試しください。'
        : searchError instanceof Error ? searchError.message : '検索に失敗しました。'
      setError(message)
    } finally {
      if (sequence === requestSequence.current) {
        setLoading(false)
        abortController.current = null
      }
    }
  }

  const submit = () => {
    try {
      void runSearch(buildUsTriggerRequest(draft, view, options.latestAsOf), { collapse: true })
    } catch (validationError) {
      setError(validationError instanceof Error ? validationError.message : '入力内容を確認してください。')
    }
  }

  const cancelSearch = () => {
    abortController.current?.abort()
    abortController.current = null
    requestSequence.current += 1
    setLoading(false)
  }

  const rerun = (patch: Partial<TriggerDiscoverySearchRequest>, revealResults = false) => {
    if (!lastRequest) return
    void runSearch({ ...lastRequest, ...patch }, { revealResults })
  }

  const changeSort = (key: TriggerDiscoverySortKey) => {
    if (!lastRequest) return
    const current = lastRequest.sort
    const direction = current?.key === key
      ? (current.direction === 'asc' ? 'desc' : 'asc')
      : (DESC_FIRST_SORT_KEYS.has(key) ? 'desc' : 'asc')
    const sort = { key, direction } as const
    setView((value) => ({ ...value, sort }))
    rerun({ sort, page: 1 })
  }

  const changeCardSort = (value: string) => {
    const sort = CARD_SORT_OPTIONS.find((option) => option.value === value)?.sort
      ?? (value !== '' && value === sortValue(lastRequest?.sort ?? null) ? lastRequest!.sort! : null)
    setView((current) => ({ ...current, sort }))
    rerun({ sort, page: 1 })
  }

  const changeStatusFilter = (statusFilter: UsTriggerStatusFilter) => {
    setView((current) => ({ ...current, statusFilter }))
    rerun({ statusFilter, page: 1 })
  }

  const changePageSize = (pageSize: UsTriggerPageSize) => {
    setView((current) => ({ ...current, pageSize }))
    rerun({ pageSize, page: 1 })
  }

  const changePage = (page: number) => rerun({ page }, true)

  const openBuilder = () => {
    setBuilderOpen(true)
    window.requestAnimationFrame(() => document.getElementById('us-trigger-builder-heading')?.focus())
  }

  const resetDraft = () => {
    setDraft((current) => ({ ...defaultUsTriggerDraft(options.latestAsOf), asOf: current.asOf }))
  }

  /* ---------- 保存済み Trigger ---------- */

  // 保存・未保存変更の比較に使う設定値。基準日は保存しない契約のため、過去日を入力中でも
  // 最新データ日の request として組む (過去日だと取引所の条件が request から外れ、保存内容が欠けるため)
  const savedComparison = useMemo(() => {
    try {
      const draftForSave = { ...draft, asOf: options.latestAsOf ?? draft.asOf }
      const configs = savedTriggerConfigsFromSearchRequest(buildUsTriggerRequest(draftForSave, view, options.latestAsOf))
      return { configs, error: null }
    } catch (configError) {
      return { configs: null, error: configError instanceof Error ? configError.message : '検索条件を確認してください。' }
    }
  }, [draft, view, options.latestAsOf])

  /** 保存済み定義を draft/view へ戻し、最新データ日で即時検索する (日付は保存しない) */
  const loadSavedDefinition = (definition: SavedTriggerDefinition) => {
    const request = searchRequestFromSavedTrigger(definition, options.latestAsOf ?? draft.asOf)
    const state = usTriggerStateFromRequest(request, options.latestAsOf)
    setDraft(state.draft)
    setView(state.view)
    void runSearch(request, { collapse: true })
  }

  /* ---------- 銘柄詳細から戻ったときの復元 ---------- */

  const preserveBeforeStockNavigation = (event: ReactMouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    if (!response || !lastRequest) return
    try {
      const token = window.crypto.randomUUID()
      const snapshot: ReturnSnapshot = {
        version: 1,
        token,
        url: currentUrl(),
        draft,
        view,
        response,
        lastRequest,
        builderOpen,
        scrollY: window.scrollY,
        activeSavedId,
      }
      window.sessionStorage.setItem(RETURN_STORAGE_KEY, JSON.stringify(snapshot))
      const historyState = typeof window.history.state === 'object' && window.history.state !== null
        ? window.history.state as Record<string, unknown>
        : {}
      window.history.replaceState({ ...historyState, [RETURN_HISTORY_KEY]: token }, '', window.location.href)
    } catch {
      // sessionStorage が使えなくても遷移はそのまま行う
    }
  }

  useEffect(() => {
    const historyState = typeof window.history.state === 'object' && window.history.state !== null
      ? window.history.state as Record<string, unknown>
      : {}
    const token = historyState[RETURN_HISTORY_KEY]
    if (typeof token !== 'string') return
    let serialized: string | null = null
    try {
      serialized = window.sessionStorage.getItem(RETURN_STORAGE_KEY)
      window.sessionStorage.removeItem(RETURN_STORAGE_KEY)
    } catch {
      return
    }
    const nextHistoryState = { ...historyState }
    delete nextHistoryState[RETURN_HISTORY_KEY]
    window.history.replaceState(nextHistoryState, '', window.location.href)
    if (!serialized) return
    try {
      const snapshot = JSON.parse(serialized) as ReturnSnapshot
      if (
        snapshot.version !== 1
        || snapshot.token !== token
        || snapshot.url !== currentUrl()
        || snapshot.response?.contractVersion !== SEARCH_CONTRACT
      ) return
      pendingScrollY.current = snapshot.scrollY
      setDraft({ ...defaultUsTriggerDraft(options.latestAsOf), ...snapshot.draft })
      setView(snapshot.view)
      setResponse(snapshot.response)
      setLastRequest(snapshot.lastRequest)
      setBuilderOpen(snapshot.builderOpen)
      setActiveSavedId(typeof snapshot.activeSavedId === 'string' ? snapshot.activeSavedId : null)
    } catch {
      // 壊れた snapshot は捨てて初期表示にする
    }
  }, [options.latestAsOf])

  useEffect(() => {
    if (!response || pendingScrollY.current == null) return
    const scrollY = pendingScrollY.current
    pendingScrollY.current = null
    let secondFrame = 0
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => window.scrollTo({ top: scrollY, left: 0, behavior: 'instant' }))
    })
    return () => {
      window.cancelAnimationFrame(firstFrame)
      if (secondFrame) window.cancelAnimationFrame(secondFrame)
    }
  }, [response])

  useEffect(() => () => {
    abortController.current?.abort()
    chartAbortController.current?.abort()
  }, [])

  /* ---------- ミニチャート (表示中ページを 1 バッチ) ---------- */

  useEffect(() => {
    chartAbortController.current?.abort()
    const sequence = ++chartSequence.current
    setChartBatchFailed(false)
    setChartFailedKeys(new Set())
    if (!response?.meta.resolvedAsOf || response.rows.length === 0) {
      setChartLoadingKeys(new Set())
      return
    }
    const base = {
      timeframe: response.meta.timeframe,
      date: response.meta.resolvedAsOf,
      ma1Period: response.criteria.ma1Period,
      ma2Period: response.criteria.ma2Period,
    }
    const entries = response.rows.map((row) => ({
      ticker: row.ticker.toUpperCase(),
      key: usMiniChartKey({ ...base, ticker: row.ticker }),
    }))
    const cache = chartCache.current
    // 表示中の cache は新しい側へ寄せ、上限で古いものから捨てる
    for (const entry of entries) {
      const hit = cache.get(entry.key)
      if (hit) {
        cache.delete(entry.key)
        cache.set(entry.key, hit)
      }
    }
    const missing = entries.filter((entry) => !cache.has(entry.key))
    setCharts(new Map(cache))
    setChartLoadingKeys(new Set(missing.map((entry) => entry.key)))
    if (missing.length === 0) return

    const controller = new AbortController()
    chartAbortController.current = controller
    void (async () => {
      try {
        const apiResponse = await fetch('/api/us/trigger-discovery/mini-charts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tickers: [...new Set(missing.map((entry) => entry.ticker))],
            requestedAsOf: base.date,
            timeframe: base.timeframe,
            ma1Period: base.ma1Period,
            ma2Period: base.ma2Period,
          }),
          cache: 'no-store',
          signal: controller.signal,
        })
        const body = await apiResponse.json() as TriggerDiscoveryMiniChartsResponse | { message?: string }
        if (!apiResponse.ok || !('charts' in body)) throw new Error(messageFrom(body) ?? 'mini chart request failed')
        if (sequence !== chartSequence.current) return
        const received = new Set<string>()
        for (const chart of body.charts) {
          const key = usMiniChartKey({ ...base, ticker: chart.ticker })
          cache.set(key, chart)
          received.add(key)
        }
        while (cache.size > MINI_CHART_CACHE_LIMIT) cache.delete(cache.keys().next().value!)
        setCharts(new Map(cache))
        setChartFailedKeys(new Set(missing.map((entry) => entry.key).filter((key) => !received.has(key))))
      } catch {
        if (controller.signal.aborted || sequence !== chartSequence.current) return
        setChartFailedKeys(new Set(missing.map((entry) => entry.key)))
        setChartBatchFailed(true)
      } finally {
        if (sequence === chartSequence.current) setChartLoadingKeys(new Set())
      }
    })()
    return () => controller.abort()
  }, [response, chartRetry])

  const chartFor = (ticker: string): UsTriggerChartState => {
    if (!response?.meta.resolvedAsOf) return { loading: false, failed: true }
    const key = usMiniChartKey({
      ticker,
      timeframe: response.meta.timeframe,
      date: response.meta.resolvedAsOf,
      ma1Period: response.criteria.ma1Period,
      ma2Period: response.criteria.ma2Period,
    })
    return { chart: charts.get(key), loading: chartLoadingKeys.has(key), failed: chartFailedKeys.has(key) }
  }

  /* ---------- 表示 ---------- */

  const linkDate = response && !response.meta.isLatest ? response.meta.resolvedAsOf : null
  const showExchange = response?.meta.classificationAvailability === 'CURRENT'
  const activeSort = lastRequest?.sort ?? null
  const firstResult = response && response.meta.returnedCount > 0 ? (response.meta.page - 1) * response.meta.pageSize + 1 : 0
  const lastResult = response ? firstResult + response.meta.returnedCount - 1 : 0
  const statusFilter = lastRequest?.statusFilter ?? null
  const hasViewFilter = Boolean(statusFilter)
    || Object.values(lastRequest?.stageFilters ?? {}).some((values) => values?.length)
  const activeSortValue = sortValue(activeSort)
  // 表の列見出しや復元で選択肢にない並び順になっていても、選択欄は実際の並び順を示す
  const extraCardSortOption = activeSort && response && !CARD_SORT_OPTIONS.some((option) => option.value === activeSortValue)
    ? { value: activeSortValue, label: `${sortKeyLabel(activeSort.key, response)}（${activeSort.direction === 'asc' ? '昇順' : '降順'}）` }
    : null
  const totalPages = response ? Math.max(1, response.meta.totalPages) : 1

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {/* 「条件を編集」の aria-controls 先。閉じていても要素は残し、display: contents で余白を作らない */}
      <div id="us-trigger-builder-region" className="contents">
        {builderOpen && (
          <UsTriggerConditionBuilder
            draft={draft}
            onDraftChange={setDraft}
            options={options}
            loading={loading}
            hasResult={response != null}
            onSubmit={submit}
            onCancelSearch={cancelSearch}
            onClose={() => setBuilderOpen(false)}
            onReset={resetDraft}
          />
        )}
      </div>

      {/* 検索フォームと結果の間。US 専用 API (/api/us/trigger-discovery/saved) だけを使う */}
      <UsSavedTriggerBar
        activeId={activeSavedId}
        onActiveIdChange={setActiveSavedId}
        currentConfigs={savedComparison.configs}
        currentConfigsError={savedComparison.error}
        latestAsOf={options.latestAsOf}
        onLoad={loadSavedDefinition}
      />

      {/* aria-busy の領域の外に置き、検索中の読み上げが抑止されないようにする */}
      <p className="sr-only" role="status" aria-live="polite">
        {loading ? '検索しています' : response ? `候補 ${response.meta.matchedCount}件` : ''}
      </p>

      {error && (
        <Notice tone="error" role="alert" title="検索できませんでした">
          {error}{response && ' 前回の結果はそのまま表示しています。'}
        </Notice>
      )}

      <section
        ref={resultsRef}
        tabIndex={-1}
        aria-labelledby={response ? 'us-trigger-results-heading' : 'us-trigger-results-empty-heading'}
        aria-busy={loading}
        className="flex min-w-0 scroll-mt-28 flex-col gap-3 outline-none"
      >
        {!response ? (
          <>
            <h2 id="us-trigger-results-empty-heading" className="sr-only">検索結果</h2>
            {loading ? (
              <div className="panel" aria-hidden>
                <div className="flex items-center gap-2 border-b border-[var(--color-border-soft)] px-3.5 py-3 text-[12px] text-[var(--color-text-secondary)]">
                  <LoaderCircle size={15} className="animate-spin text-[var(--color-brand-700)]" aria-hidden />
                  候補を検索しています… 対象の全銘柄で移動平均を計算するため、時間がかかる場合があります。
                </div>
                <div className="divide-y divide-[var(--color-border-soft)]">
                  {Array.from({ length: 5 }, (_, index) => (
                    <div key={index} className="flex items-center gap-4 px-3.5 py-2">
                      <div className="h-8 w-28 animate-pulse rounded-[3px] bg-[var(--color-surface-muted)]" />
                      <div className="h-[56px] w-[156px] animate-pulse rounded-[3px] bg-[var(--color-surface-muted)]" />
                      <div className="hidden h-4 flex-1 animate-pulse rounded-[3px] bg-[var(--color-surface-muted)] sm:block" />
                    </div>
                  ))}
                </div>
              </div>
            ) : !error ? (
              <div className="panel">
                <EmptyState
                  icon={<Search size={22} aria-hidden />}
                  title="条件を確認して「Triggerを検索」を押してください"
                  description={(
                    <>
                      上向きの {draft.timeframe === 'BIWEEKLY' ? '2週足' : '月足'}移動平均 2 本へ上から近づく米国株を探します。
                      現在上場中の普通株 {fmtCount(options.activeCount)} 銘柄から、株価・売買代金の条件と価格履歴で絞り込みます。
                    </>
                  )}
                />
              </div>
            ) : null}
          </>
        ) : (
          <>
            <UsTriggerResultHeader
              response={response}
              request={lastRequest!}
              exchangeLabel={exchangeLabel}
              builderOpen={builderOpen}
              onEdit={openBuilder}
            />

            <div data-us-trigger-result-toolbar className="toolbar justify-between border-t border-[var(--color-border-soft)] pt-2.5">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <label className="inline-flex items-center gap-1.5 text-[11px] font-medium text-[var(--color-text-secondary)]">
                  Status
                  <select
                    value={statusFilter ?? ''}
                    disabled={loading}
                    onChange={(event) => changeStatusFilter((event.target.value || null) as UsTriggerStatusFilter)}
                    className={`h-8 rounded-[3px] border bg-white px-2 text-[11px] font-normal text-[var(--color-text-primary)] outline-none focus:border-[var(--color-brand-500)] focus:ring-1 focus:ring-[var(--color-brand-100)] ${statusFilter ? 'border-[var(--color-brand-500)]' : 'border-[var(--color-border-default)]'}`}
                  >
                    <option value="">すべて</option>
                    <option value="APPROACHING">{STATUS_LABELS.APPROACHING}</option>
                    <option value="NEAR">{STATUS_LABELS.NEAR}</option>
                    <option value="IN_ZONE">{STATUS_LABELS.IN_ZONE}</option>
                    {response.criteria.belowZoneToleranceEnabled && <option value="BELOW_ZONE">{STATUS_LABELS.BELOW_ZONE}</option>}
                  </select>
                </label>
                <label className="inline-flex items-center gap-1.5 text-[11px] font-medium text-[var(--color-text-secondary)] lg:hidden">
                  並び順
                  <select
                    value={activeSortValue}
                    disabled={loading}
                    onChange={(event) => changeCardSort(event.target.value)}
                    className="h-8 rounded-[3px] border border-[var(--color-border-default)] bg-white px-2 text-[11px] font-normal text-[var(--color-text-primary)] outline-none focus:border-[var(--color-brand-500)] focus:ring-1 focus:ring-[var(--color-brand-100)]"
                  >
                    {CARD_SORT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    {extraCardSortOption && <option value={extraCardSortOption.value}>{extraCardSortOption.label}</option>}
                  </select>
                </label>
                {loading && (
                  <span className="inline-flex items-center gap-1 text-[11px] text-[var(--color-brand-700)]">
                    <LoaderCircle size={12} className="animate-spin" aria-hidden />再検索中…
                  </span>
                )}
              </div>
              {response.rows.length > 0 && (
                <span className="text-[11px] tabular-nums text-[var(--color-text-secondary)]">
                  {fmtCount(response.meta.matchedCount)}件中 {fmtCount(firstResult)}–{fmtCount(lastResult)}件
                </span>
              )}
            </div>

            {chartBatchFailed && (
              <Notice
                tone="warning"
                action={(
                  <button type="button" className="btn" data-size="sm" onClick={() => setChartRetry((value) => value + 1)}>
                    <RefreshCw size={12} aria-hidden />再試行
                  </button>
                )}
              >
                ミニチャートを取得できませんでした。検索結果の数値はそのまま使えます。
              </Notice>
            )}

            <div className={`min-w-0 transition-opacity ${loading ? 'pointer-events-none opacity-55' : ''}`}>
              {response.rows.length === 0 ? (
                <ResultEmpty
                  response={response}
                  hasViewFilter={hasViewFilter}
                  onClearStatus={statusFilter ? () => changeStatusFilter(null) : undefined}
                  onFirstPage={response.meta.matchedCount > 0 && response.meta.page > 1 ? () => changePage(1) : undefined}
                  onEdit={builderOpen ? undefined : openBuilder}
                />
              ) : (
                <>
                  <div className="hidden lg:block">
                    <UsTriggerResultsTable
                      response={response}
                      linkDate={linkDate}
                      showExchange={showExchange}
                      activeSort={activeSort}
                      onSort={changeSort}
                      sortDisabled={loading}
                      chartFor={chartFor}
                      onStockNavigate={preserveBeforeStockNavigation}
                    />
                  </div>
                  <div className="lg:hidden">
                    <UsTriggerResultCards
                      response={response}
                      linkDate={linkDate}
                      showExchange={showExchange}
                      chartFor={chartFor}
                      onStockNavigate={preserveBeforeStockNavigation}
                    />
                  </div>
                </>
              )}
            </div>

            {response.rows.length > 0 && (
              <nav aria-label="検索結果のページ" className="toolbar justify-between text-[11px] text-[var(--color-text-secondary)]">
                <span className="tabular-nums">{fmtCount(response.meta.matchedCount)}件中 {fmtCount(firstResult)}–{fmtCount(lastResult)}件</span>
                <div className="flex items-center gap-2">
                  <label className="inline-flex items-center gap-1">
                    表示件数
                    <select
                      value={response.meta.pageSize}
                      disabled={loading}
                      onChange={(event) => changePageSize(Number(event.target.value) as UsTriggerPageSize)}
                      className="h-8 rounded-[3px] border border-[var(--color-border-default)] bg-white px-2 text-[11px]"
                    >
                      {US_TRIGGER_PAGE_SIZES.map((size) => <option key={size} value={size}>{size}件</option>)}
                    </select>
                  </label>
                  <button
                    type="button"
                    disabled={loading || response.meta.page <= 1}
                    onClick={() => changePage(response.meta.page - 1)}
                    className={`inline-flex h-8 w-8 items-center justify-center rounded-[3px] border border-[var(--color-border-default)] bg-white disabled:opacity-35 ${FOCUS_RING}`}
                    aria-label="前のページ"
                  >
                    <ChevronLeft size={15} aria-hidden />
                  </button>
                  <span className="min-w-[56px] text-center tabular-nums">
                    <span aria-hidden>{response.meta.page} / {totalPages}</span>
                    <span className="sr-only">{totalPages}ページ中 {response.meta.page}ページ目</span>
                  </span>
                  <button
                    type="button"
                    disabled={loading || response.meta.page >= response.meta.totalPages}
                    onClick={() => changePage(response.meta.page + 1)}
                    className={`inline-flex h-8 w-8 items-center justify-center rounded-[3px] border border-[var(--color-border-default)] bg-white disabled:opacity-35 ${FOCUS_RING}`}
                    aria-label="次のページ"
                  >
                    <ChevronRight size={15} aria-hidden />
                  </button>
                </div>
              </nav>
            )}
          </>
        )}
      </section>

      <p className="border-t border-[var(--color-border-soft)] pt-3 text-[11px] leading-relaxed text-[var(--color-text-tertiary)]">
        株価は USD 終値（米国時間）、平均売買代金は USD、出来高は株数です。Status・Score・距離はサーバー側の判定エンジンの値をそのまま表示しています。
        保存済みTriggerと通知設定は米国株専用で、日本株の保存条件とは共有しません。期間検証は日本株のみ対応しています。
        <Link href="/trigger-discovery" prefetch={false} className="ml-1 font-medium text-[var(--color-brand-700)] hover:underline">日本株の条件トリガー</Link>
      </p>
    </div>
  )
}

function ResultEmpty({
  response,
  hasViewFilter,
  onClearStatus,
  onFirstPage,
  onEdit,
}: {
  response: UsTriggerDiscoverySearchResponse
  hasViewFilter: boolean
  onClearStatus?: () => void
  onFirstPage?: () => void
  onEdit?: () => void
}) {
  const { meta } = response
  const editAction = onEdit
    ? <button type="button" className="btn" data-size="sm" aria-expanded={false} aria-controls="us-trigger-builder-region" onClick={onEdit}>条件を編集</button>
    : undefined

  let title: string
  let description: ReactNode
  let action: ReactNode = editAction
  if (onFirstPage) {
    title = 'このページに候補はありません'
    description = `候補は ${fmtCount(meta.matchedCount)} 件です。1 ページ目に戻ってください。`
    action = <button type="button" className="btn" data-size="sm" onClick={onFirstPage}>1 ページ目へ</button>
  } else if (meta.pitUniverseCount === 0) {
    title = 'この基準日には評価できる米国株がありません'
    description = '価格データのある日付を指定してください。'
  } else if (meta.triggerEvaluatedCount === 0) {
    title = '株価・流動性の条件を満たす銘柄がありません'
    description = `母集団 ${fmtCount(meta.pitUniverseCount)} 銘柄のうち、株価・売買代金・出来高の条件を満たす銘柄がありませんでした。下限（既定 ${fmtUsd(US_TRIGGER_DEFAULTS.priceMinUsd)}・${fmtUsdCompact(US_TRIGGER_DEFAULTS.tradingValueMinUsdM * 1_000_000)}）を下げるか、取引所の指定を外してください。`
  } else if (meta.triggerMatchedCount === 0 && meta.insufficientHistoryCount >= meta.triggerEvaluatedCount) {
    title = '履歴不足で評価できる銘柄がありませんでした'
    description = `条件を満たす ${fmtCount(meta.triggerEvaluatedCount)} 銘柄すべてで、移動平均の計算に必要な履歴が足りませんでした。MA 期間を短くするか、より新しい基準日を指定してください。`
  } else if (meta.triggerMatchedCount > 0 && hasViewFilter) {
    title = '表示条件（Status・Stage）に合う候補がありません'
    description = `Trigger 条件には ${fmtCount(meta.triggerMatchedCount)} 件が一致しています。Status または 6ステージの指定を外してください。`
    if (onClearStatus) action = <button type="button" className="btn" data-size="sm" onClick={onClearStatus}>Status の絞り込みを外す</button>
  } else {
    title = 'この条件に一致する Trigger 候補はありません'
    description = `${fmtCount(meta.triggerEvaluatedCount)} 銘柄を評価しました。Trigger距離を広げるか、MA 期間を変えてください。`
  }

  return (
    <div className="panel" role="status">
      <EmptyState title={title} description={description} action={action} />
    </div>
  )
}
