'use client'

// components/us/backtest/UsBacktestExplorer.tsx
//
// US Historical Outcome Explorer。基準日・検証期間・フィルターで serving_backtest_results を引き、
// 集計・一覧・詳細を表示する。計算・PIT・分類の扱いはすべて API 側で確定済み。
// - 取得順: 検証期間 → dates API (基準日一覧と結果確定範囲) → query API
//   期間を変えた直後に旧期間の基準日で query しないよう、{horizon, date} を 1 つの状態で切り替える
// - dates / query はそれぞれ AbortController で前のリクエストを打ち切る (競合した応答を表示しない)
// - 選んだ基準日が新しい期間で未確定なら、その期間の最新の確定済み基準日へ移し、その旨を示す

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { SectionHeader } from '@/components/ui/SectionHeader'
import { EmptyState, Notice } from '@/components/ui/EmptyState'
import { UsBacktestContextBar, UsBacktestFilters } from '@/components/us/backtest/UsBacktestControls'
import { UsBacktestSummary } from '@/components/us/backtest/UsBacktestSummary'
import { UsBacktestResults } from '@/components/us/backtest/UsBacktestResults'
import {
  EMPTY_FILTERS,
  activeFilterCount,
  buildQueryUrl,
  fetchJson,
  hasFilterErrors,
  isAbortError,
  sameFilters,
  validateFilters,
  type UsBacktestDatesResponse,
  type UsBacktestFilterState,
  type UsBacktestHorizon,
  type UsBacktestQueryResponse,
  type UsBacktestSort,
} from '@/components/us/backtest/usBacktestShared'

type Selection = { horizon: UsBacktestHorizon; date: string }

type DatesState =
  | { status: 'loading'; data: UsBacktestDatesResponse | null }
  | { status: 'ready'; data: UsBacktestDatesResponse }
  | { status: 'error'; data: UsBacktestDatesResponse | null; message: string }

type QueryState = {
  loading: boolean
  data: UsBacktestQueryResponse | null
  error: string | null
}

const MAX_SIGNAL_OPTIONS = 200

export function UsBacktestExplorer({
  horizons,
  defaultHorizon,
}: {
  horizons: readonly UsBacktestHorizon[]
  defaultHorizon: UsBacktestHorizon
}) {
  const [horizon, setHorizon] = useState<UsBacktestHorizon>(defaultHorizon)
  const [datesReload, setDatesReload] = useState(0)
  const [dates, setDates] = useState<DatesState>({ status: 'loading', data: null })
  const [selection, setSelection] = useState<Selection | null>(null)
  const [dateNotice, setDateNotice] = useState<string | null>(null)
  const [draft, setDraft] = useState<UsBacktestFilterState>(EMPTY_FILTERS)
  const [applied, setApplied] = useState<UsBacktestFilterState>(EMPTY_FILTERS)
  const [sort, setSort] = useState<UsBacktestSort>('maxReturn')
  const [page, setPage] = useState(1)
  const [queryReload, setQueryReload] = useState(0)
  const [query, setQuery] = useState<QueryState>({ loading: false, data: null, error: null })
  const [expanded, setExpanded] = useState<string | null>(null)
  const [signalOptions, setSignalOptions] = useState<string[]>([])
  const selectionRef = useRef<Selection | null>(null)

  useEffect(() => { selectionRef.current = selection }, [selection])

  // 基準日一覧と結果確定範囲 (検証期間ごと)
  useEffect(() => {
    const controller = new AbortController()
    setDates((current) => ({ status: 'loading', data: current.data }))
    fetchJson<UsBacktestDatesResponse>(`/api/us/backtest/dates?horizon=${horizon}`, controller.signal)
      .then((data) => {
        const current = selectionRef.current
        const keep = current != null && data.dates.some((item) => item.date === current.date)
        const nextDate = keep && current ? current.date : data.dates[0]?.date ?? null
        setDates({ status: 'ready', data })
        setSelection(nextDate ? { horizon, date: nextDate } : null)
        setDateNotice(current && !keep && nextDate
          ? `${current.date} は ${horizon}営業日の結果が未確定のため、確定済みの最新基準日 ${nextDate} を表示しています。`
          : null)
        setExpanded(null)
        setPage(1)
      })
      .catch((error: unknown) => {
        if (isAbortError(error)) return
        setDates((current) => ({ status: 'error', data: current.data, message: (error as Error).message }))
      })
    return () => controller.abort()
  }, [horizon, datesReload])

  const queryUrl = useMemo(
    () => selection ? buildQueryUrl({ ...selection, filters: applied, sort, page }) : null,
    [selection, applied, sort, page],
  )

  // 結果一覧と集計
  useEffect(() => {
    if (!queryUrl) return
    const controller = new AbortController()
    setQuery((current) => ({ ...current, loading: true, error: null }))
    fetchJson<UsBacktestQueryResponse>(queryUrl, controller.signal)
      .then((data) => {
        setQuery({ loading: false, data, error: null })
        setSignalOptions((current) => {
          const merged = new Set(current)
          for (const row of data.results) for (const code of row.signalCodes) merged.add(code)
          if (merged.size === current.length) return current
          return Array.from(merged).sort().slice(0, MAX_SIGNAL_OPTIONS)
        })
      })
      .catch((error: unknown) => {
        if (isAbortError(error)) return
        setQuery((current) => ({ ...current, loading: false, error: (error as Error).message }))
      })
    return () => controller.abort()
  }, [queryUrl, queryReload])

  const errors = useMemo(() => validateFilters(draft), [draft])
  const dirty = !sameFilters(draft, applied)
  const appliedCount = activeFilterCount(applied)

  const changeHorizon = useCallback((next: UsBacktestHorizon) => {
    if (next === horizon) return
    setHorizon(next)
  }, [horizon])

  const changeDate = useCallback((date: string) => {
    setSelection((current) => current ? { ...current, date } : current)
    setDateNotice(null)
    setExpanded(null)
    setPage(1)
  }, [])

  const apply = useCallback(() => {
    if (hasFilterErrors(errors)) return
    setApplied({ ...draft })
    setExpanded(null)
    setPage(1)
  }, [draft, errors])

  const reset = useCallback(() => {
    setDraft(EMPTY_FILTERS)
    setApplied(EMPTY_FILTERS)
    setExpanded(null)
    setPage(1)
  }, [])

  const changeSort = useCallback((next: UsBacktestSort) => {
    setSort(next)
    setExpanded(null)
    setPage(1)
  }, [])

  const changePage = useCallback((next: number) => {
    setPage(next)
    setExpanded(null)
  }, [])

  const toggle = useCallback((ticker: string) => {
    setExpanded((current) => current === ticker ? null : ticker)
  }, [])

  const datesData = dates.data
  const datesLoading = dates.status === 'loading'
  const noDates = dates.status === 'ready' && dates.data.dates.length === 0
  const detailMove = applied.returnMetric === 'min' || sort === 'minReturn' ? 'down' : 'up'

  return (
    <section aria-labelledby="us-bt-explorer-title" className="flex min-w-0 flex-col gap-3">
      <SectionHeader
        id="us-bt-explorer-title"
        level={1}
        title="Historical Outcome Explorer"
        description="過去の基準日時点の状態と、その後に実際に起きた値動きを確認します。未来の予測や売買推奨ではありません。"
      />

      <div className="panel">
        <UsBacktestContextBar
          horizons={horizons}
          horizon={horizon}
          onHorizonChange={changeHorizon}
          date={selection?.horizon === horizon ? selection.date : null}
          onDateChange={changeDate}
          dates={datesLoading ? null : datesData}
          datesLoading={datesLoading}
        />
        <UsBacktestFilters
          draft={draft}
          onDraftChange={setDraft}
          errors={errors}
          canApply={dirty && !hasFilterErrors(errors)}
          dirty={dirty}
          activeCount={appliedCount}
          onApply={apply}
          onReset={reset}
          signalOptions={signalOptions}
        />
        <p className="border-t border-[var(--color-border-soft)] px-3 py-1.5 text-[10px] leading-4 text-[var(--color-text-tertiary)] sm:px-4">
          セクター・業種・取引所は、過去時点の分類を保証できないため表示・絞り込みに使いません。結果確定済みの基準日は検証期間ごとに異なり、市場データ最新日とは一致しません。
        </p>
      </div>

      {dates.status === 'error' && (
        <Notice
          tone="error"
          role="alert"
          title="基準日の一覧を取得できませんでした"
          action={<button type="button" className="btn" data-size="sm" onClick={() => setDatesReload((value) => value + 1)}>再試行</button>}
        >
          {dates.message}
        </Notice>
      )}
      {dateNotice && <Notice tone="info" role="status">{dateNotice}</Notice>}

      {noDates ? (
        <div className="panel">
          <EmptyState
            className="py-10"
            title={`${horizon}営業日の検証結果はまだありません`}
            description="結果が確定した基準日がこの検証期間にはありません。より短い検証期間を選んでください。"
          />
        </div>
      ) : dates.status === 'error' && selection == null ? null : (
        <>
          {!query.error && (
            <UsBacktestSummary
              summary={query.data?.summary ?? null}
              appliedTarget={applied.targetPct}
              loading={query.loading || (datesLoading && query.data == null)}
            />
          )}
          <UsBacktestResults
            data={query.data}
            loading={query.loading}
            error={query.error}
            onRetry={() => setQueryReload((value) => value + 1)}
            sort={sort}
            onSortChange={changeSort}
            onPageChange={changePage}
            expanded={expanded}
            onToggle={toggle}
            detailMove={detailMove}
            hasFilters={appliedCount > 0}
            onResetFilters={reset}
          />
        </>
      )}
    </section>
  )
}
