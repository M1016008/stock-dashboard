'use client'

import Link from 'next/link'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  CalendarRange,
  ChevronLeft,
  ChevronRight,
  History,
  LoaderCircle,
  RotateCcw,
  Search,
  Square,
  X,
} from 'lucide-react'
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { MeasuredChartFrame } from '@/components/charts/MeasuredChartFrame'
import { HistoricalOutcomeWorkspace } from '@/components/trigger-discovery/HistoricalOutcomeWorkspace'
import { TriggerScoreCell } from '@/components/trigger-discovery/TriggerScoreCell'
import { StageTag } from '@/components/ui/StageTag'
import { TRIGGER_DISCOVERY_STAGE_AXES } from '@/lib/trigger-discovery-contract'
import type {
  TriggerHistoricalScanEventType,
  TriggerHistoricalScanRequest,
  TriggerHistoricalScanResponse,
} from '@/lib/trigger-discovery-historical-scan-contract'
import type {
  TriggerHistoricalScanJobListResponse,
  TriggerHistoricalScanJobStartResponse,
  TriggerHistoricalScanJobStatus,
  TriggerHistoricalScanJobSummary,
} from '@/lib/trigger-discovery-historical-scan-job'

const JOB_STATUS_LABELS: Record<TriggerHistoricalScanJobStatus, string> = {
  QUEUED: '待機中',
  RUNNING: '検証中',
  COMPLETED: '完了',
  FAILED: '失敗',
  CANCEL_REQUESTED: 'キャンセル要求中',
  CANCELLED: 'キャンセル済み',
}

const JOB_STATUS_STYLES: Record<TriggerHistoricalScanJobStatus, string> = {
  QUEUED: 'border-slate-200 bg-slate-50 text-slate-700',
  RUNNING: 'border-sky-200 bg-sky-50 text-sky-800',
  COMPLETED: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  FAILED: 'border-red-200 bg-red-50 text-red-800',
  CANCEL_REQUESTED: 'border-amber-200 bg-amber-50 text-amber-800',
  CANCELLED: 'border-slate-200 bg-slate-50 text-slate-600',
}

const EVENT_LABELS: Record<TriggerHistoricalScanEventType, string> = {
  ENTERED: '新規候補',
  RE_ENTRY: '再エントリー',
  STATUS_CHANGED: '状態変化',
  EXITED: '候補離脱',
}

const EVENT_STYLES: Record<TriggerHistoricalScanEventType, string> = {
  ENTERED: 'border-sky-200 bg-sky-50 text-sky-800',
  RE_ENTRY: 'border-indigo-200 bg-indigo-50 text-indigo-800',
  STATUS_CHANGED: 'border-amber-200 bg-amber-50 text-amber-800',
  EXITED: 'border-slate-200 bg-slate-50 text-slate-700',
}

const STATUS_LABELS = {
  IN_ZONE: 'IN ZONE',
  NEAR: 'NEAR',
  APPROACHING: 'APPROACHING',
  NOT_MATCHED: '対象外',
  BELOW_ZONE: 'Zone下方',
} as const

const TERMINAL_STATUSES = new Set<TriggerHistoricalScanJobStatus>(['COMPLETED', 'FAILED', 'CANCELLED'])

type EventFilter = 'ALL' | TriggerHistoricalScanEventType | 'NEAR_ENTERED' | 'IN_ZONE_ENTERED'
type EventOrder = 'asc' | 'desc'

const EVENT_FILTER_OPTIONS: ReadonlyArray<{ value: EventFilter; label: string }> = [
  { value: 'ALL', label: 'すべて' },
  { value: 'ENTERED', label: '新規候補' },
  { value: 'RE_ENTRY', label: '再エントリー' },
  { value: 'STATUS_CHANGED', label: '状態変化' },
  { value: 'NEAR_ENTERED', label: 'NEAR入り' },
  { value: 'IN_ZONE_ENTERED', label: 'Trigger Zone入り' },
  { value: 'EXITED', label: '候補離脱' },
]

interface Props {
  buildRequest: () => TriggerHistoricalScanRequest
}

interface ChartTooltipProps {
  active?: boolean
  label?: string
  payload?: Array<{ dataKey?: string; value?: number; color?: string }>
}

const CHART_LABELS: Record<string, string> = {
  candidateCount: '候補数',
  approachingCount: 'APPROACHING',
  nearCount: 'NEAR',
  inZoneCount: 'IN ZONE',
}

function HistoricalChartTooltip({ active, label, payload }: ChartTooltipProps) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-[4px] border border-[var(--color-border)] bg-white px-3 py-2 text-[10px] shadow-lg">
      <div className="mb-1 font-semibold tabular-nums text-[var(--color-text-primary)]">{label}</div>
      {payload.map((item) => (
        <div key={item.dataKey} className="flex min-w-[130px] items-center justify-between gap-4 leading-5">
          <span style={{ color: item.color }}>{CHART_LABELS[item.dataKey ?? ''] ?? item.dataKey}</span>
          <strong className="tabular-nums text-[var(--color-text-primary)]">{Number(item.value ?? 0).toLocaleString('ja-JP')}</strong>
        </div>
      ))}
    </div>
  )
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('ja-JP', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date(value))
}

function formatDuration(value: number): string {
  if (!value) return '—'
  if (value < 60_000) return `${Math.max(1, Math.round(value / 1_000))}秒`
  return `${Math.round(value / 60_000)}分`
}

function formatPercent(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`
}

function statusLabel(value: keyof typeof STATUS_LABELS | null): string {
  return value ? STATUS_LABELS[value] : '—'
}

function updateActiveJobUrl(jobId: string): void {
  const url = new URL(window.location.href)
  url.searchParams.set('mode', 'period')
  url.searchParams.set('historicalJob', jobId)
  for (const key of [
    'outcomeMode',
    'outcomeScoreMin',
    'outcomeScoreMax',
    'outcomeNearJob',
    'outcomeZoneJob',
    'outcomeEnteredJob',
    'outcomeReentryJob',
    'outcomeDetail',
  ]) url.searchParams.delete(key)
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
}

function errorMessage(category: string | null): string {
  if (category === 'memory_limit') return '処理対象が大きすぎました。期間を短くして再度お試しください。'
  return '期間検証に失敗しました。条件を確認して再実行してください。'
}

export function HistoricalScanWorkspace({ buildRequest }: Props) {
  const [jobs, setJobs] = useState<TriggerHistoricalScanJobSummary[]>([])
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null)
  const [selectedJob, setSelectedJob] = useState<TriggerHistoricalScanJobSummary | null>(null)
  const [result, setResult] = useState<TriggerHistoricalScanResponse | null>(null)
  const [jobsLoading, setJobsLoading] = useState(true)
  const [startBusy, setStartBusy] = useState(false)
  const [cancelBusy, setCancelBusy] = useState(false)
  const [resultLoading, setResultLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [eventFilter, setEventFilter] = useState<EventFilter>('ALL')
  const [eventOrder, setEventOrder] = useState<EventOrder>('desc')
  const [eventSearchDraft, setEventSearchDraft] = useState('')
  const [eventSearch, setEventSearch] = useState('')
  const [eventDate, setEventDate] = useState('')
  const [eventOffset, setEventOffset] = useState(0)
  const [eventLimit, setEventLimit] = useState(100)
  const cancelRequestedJob = useRef<string | null>(null)
  const listSequence = useRef(0)

  const refreshJobs = async (preferredJobId?: string | null) => {
    const sequence = ++listSequence.current
    const response = await fetch('/api/trigger-discovery/historical-scan/jobs?limit=20', { cache: 'no-store' })
    const body = await response.json() as TriggerHistoricalScanJobListResponse | { message?: string }
    if (!response.ok || !('jobs' in body)) throw new Error('message' in body && body.message ? body.message : '最近の期間検証を取得できませんでした。')
    if (sequence !== listSequence.current) return
    setJobs(body.jobs)
    setSelectedJobId((current) => {
      if (preferredJobId) return preferredJobId
      if (current && body.jobs.some((job) => job.jobId === current)) return current
      if (typeof window !== 'undefined') {
        const urlJob = new URL(window.location.href).searchParams.get('historicalJob')
        if (urlJob && body.jobs.some((job) => job.jobId === urlJob)) return urlJob
      }
      return body.jobs.find((job) => !TERMINAL_STATUSES.has(job.status))?.jobId ?? null
    })
  }

  useEffect(() => {
    let cancelled = false
    void refreshJobs().catch((loadError) => {
      if (!cancelled) setError(loadError instanceof Error ? loadError.message : '最近の期間検証を取得できませんでした。')
    }).finally(() => {
      if (!cancelled) setJobsLoading(false)
    })
    return () => {
      cancelled = true
      listSequence.current += 1
    }
  }, [])

  useEffect(() => {
    if (!selectedJobId) {
      setSelectedJob(null)
      setResult(null)
      return
    }
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | null = null
    let stopped = false

    const poll = async () => {
      try {
        const response = await fetch(`/api/trigger-discovery/historical-scan/jobs/${selectedJobId}`, {
          cache: 'no-store',
          signal: controller.signal,
        })
        const body = await response.json() as TriggerHistoricalScanJobSummary | { message?: string }
        if (!response.ok || !('jobId' in body)) throw new Error('message' in body && body.message ? body.message : '期間検証の状態を取得できませんでした。')
        if (stopped || body.jobId !== selectedJobId) return
        if (cancelRequestedJob.current === selectedJobId && (body.status === 'QUEUED' || body.status === 'RUNNING')) {
          timer = setTimeout(poll, 1_500)
          return
        }
        setSelectedJob(body)
        setJobs((current) => current.map((job) => job.jobId === body.jobId ? body : job))
        if (!TERMINAL_STATUSES.has(body.status)) timer = setTimeout(poll, 1_500)
        else void refreshJobs(body.jobId).catch(() => undefined)
      } catch (pollError) {
        if (controller.signal.aborted || stopped) return
        setError(pollError instanceof Error ? pollError.message : '期間検証の状態を取得できませんでした。')
      }
    }

    setResult(null)
    setError(null)
    void poll()
    return () => {
      stopped = true
      controller.abort()
      if (timer) clearTimeout(timer)
    }
  }, [selectedJobId])

  useEffect(() => {
    if (!selectedJob || selectedJob.status !== 'COMPLETED' || !selectedJob.resultAvailable) {
      setResult(null)
      return
    }
    const controller = new AbortController()
    const params = new URLSearchParams({
      eventOffset: String(eventOffset),
      eventLimit: String(eventLimit),
      eventOrder,
    })
    if (eventFilter === 'NEAR_ENTERED') {
      params.set('eventType', 'STATUS_CHANGED')
      params.set('currentStatus', 'NEAR')
    } else if (eventFilter === 'IN_ZONE_ENTERED') {
      params.set('eventType', 'STATUS_CHANGED')
      params.set('currentStatus', 'IN_ZONE')
    } else if (eventFilter !== 'ALL') {
      params.set('eventType', eventFilter)
    }
    if (eventDate) params.set('eventDate', eventDate)
    if (eventSearch) params.set('eventSearch', eventSearch)
    setResultLoading(true)
    setError(null)
    void fetch(`/api/trigger-discovery/historical-scan/jobs/${selectedJob.jobId}/result?${params}`, {
      cache: 'no-store',
      signal: controller.signal,
    }).then(async (response) => {
      const body = await response.json() as TriggerHistoricalScanResponse | { error?: string; message?: string }
      if (response.status === 410) throw new Error('保存期限を過ぎたため結果を表示できません。同じ条件で再実行してください。')
      if (!response.ok || !('scanMeta' in body)) throw new Error('message' in body && body.message ? body.message : '期間検証の結果を取得できませんでした。')
      setResult(body)
    }).catch((resultError) => {
      if (!controller.signal.aborted) setError(resultError instanceof Error ? resultError.message : '期間検証の結果を取得できませんでした。')
    }).finally(() => {
      if (!controller.signal.aborted) setResultLoading(false)
    })
    return () => controller.abort()
  }, [selectedJob?.jobId, selectedJob?.status, selectedJob?.resultAvailable, eventFilter, eventOrder, eventSearch, eventDate, eventOffset, eventLimit])

  const startRequest = async (request: TriggerHistoricalScanRequest, rerun = false) => {
    setStartBusy(true)
    setError(null)
    setMessage(null)
    try {
      const response = await fetch('/api/trigger-discovery/historical-scan/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        cache: 'no-store',
      })
      const body = await response.json() as TriggerHistoricalScanJobStartResponse | { message?: string }
      if (!response.ok || !('jobId' in body)) throw new Error('message' in body && body.message ? body.message : '期間検証を開始できませんでした。')
      cancelRequestedJob.current = null
      setEventOffset(0)
      setEventFilter('ALL')
      setEventSearch('')
      setEventSearchDraft('')
      setEventDate('')
      setSelectedJob(null)
      setResult(null)
      setSelectedJobId(body.jobId)
      updateActiveJobUrl(body.jobId)
      setMessage(body.reused
        ? body.status === 'COMPLETED' ? '保存済みの同一結果を表示します。' : '同じ条件の実行中ジョブを表示します。'
        : rerun ? '同じ条件で期間検証を再実行します。' : '期間検証を受け付けました。')
      await refreshJobs(body.jobId)
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : '期間検証を開始できませんでした。')
    } finally {
      setStartBusy(false)
    }
  }

  const start = async () => {
    try {
      await startRequest(buildRequest())
    } catch (validationError) {
      setError(validationError instanceof Error ? validationError.message : '入力内容を確認してください。')
    }
  }

  const cancel = async () => {
    if (!selectedJobId) return
    setCancelBusy(true)
    setError(null)
    cancelRequestedJob.current = selectedJobId
    try {
      const response = await fetch(`/api/trigger-discovery/historical-scan/jobs/${selectedJobId}`, {
        method: 'DELETE',
        cache: 'no-store',
      })
      const body = await response.json() as TriggerHistoricalScanJobSummary | { message?: string }
      if (!response.ok || !('jobId' in body)) throw new Error('message' in body && body.message ? body.message : 'キャンセルを要求できませんでした。')
      setSelectedJob(body)
      setJobs((current) => current.map((job) => job.jobId === body.jobId ? body : job))
      setMessage(body.status === 'CANCELLED' ? '期間検証をキャンセルしました。' : 'キャンセルを要求しました。')
    } catch (cancelError) {
      cancelRequestedJob.current = null
      setError(cancelError instanceof Error ? cancelError.message : 'キャンセルを要求できませんでした。')
    } finally {
      setCancelBusy(false)
    }
  }

  const openJob = (job: TriggerHistoricalScanJobSummary) => {
    cancelRequestedJob.current = null
    setSelectedJobId(job.jobId)
    setSelectedJob(job)
    setResult(null)
    setEventOffset(0)
    setEventFilter('ALL')
    setEventSearch('')
    setEventSearchDraft('')
    setEventDate('')
    updateActiveJobUrl(job.jobId)
  }

  const progressPct = selectedJob && selectedJob.progress.totalTradingDays > 0
    ? Math.min(100, Math.round(selectedJob.progress.processedTradingDays / selectedJob.progress.totalTradingDays * 100))
    : 0
  const active = selectedJob && !TERMINAL_STATUSES.has(selectedJob.status)
  const expired = selectedJob?.status === 'COMPLETED' && !selectedJob.resultAvailable
  const resultPage = result?.eventPage
  const eventPageNumber = resultPage ? Math.floor(resultPage.offset / resultPage.limit) + 1 : 1
  const eventTotalPages = resultPage ? Math.max(1, Math.ceil(resultPage.totalCount / resultPage.limit)) : 1
  const chartData = useMemo(() => result?.dailyCounts ?? [], [result?.dailyCounts])

  return (
    <section aria-labelledby="historical-scan-heading" className="border-t border-[var(--color-border)] pt-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-3xl">
          <h2 id="historical-scan-heading" className="inline-flex items-center gap-1.5 text-[14px] font-semibold text-[var(--color-text-primary)]">
            <CalendarRange size={15} aria-hidden /> 3. 期間検証
          </h2>
          <p className="mt-1 text-[11px] leading-5 text-[var(--color-text-secondary)]">指定期間の各営業日時点でTrigger条件を再現し、候補入り・状態変化・候補離脱を確認します。</p>
          <p className="text-[10px] leading-5 text-[var(--color-text-tertiary)]">価格・MA・Stage・流動性は各評価日時点以前のデータのみを使用します。上場期間は現在保持する取引履歴から復元します。最大520営業日です。</p>
        </div>
        <button
          type="button"
          disabled={startBusy || Boolean(active)}
          onClick={() => void start()}
          className="inline-flex h-10 min-w-[170px] items-center justify-center gap-2 rounded-[4px] border border-[var(--color-brand-700)] bg-white px-5 text-[12px] font-semibold text-[var(--color-brand-800)] hover:bg-[var(--color-brand-50)] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {startBusy ? <LoaderCircle size={15} className="animate-spin" aria-hidden /> : <History size={15} aria-hidden />}
          {startBusy ? '受け付け中…' : active ? '期間検証を実行中' : '期間検証を開始'}
        </button>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[9px] leading-4 text-[var(--color-text-tertiary)]">
        <span>期間によって1〜2分程度かかる場合があります。</span>
        <span>検証中はデータベース処理のため、他の分析画面が一時的に遅くなる場合があります。</span>
        <span>本機能はTrigger発生履歴を確認するもので、その後の投資成果を評価するものではありません。</span>
      </div>

      {(error || message) && (
        <div className={`mt-3 border-l-2 px-3 py-2 text-[11px] ${error ? 'border-red-500 bg-red-50 text-red-800' : 'border-[var(--color-brand-500)] bg-[var(--color-brand-50)] text-[var(--color-brand-800)]'}`} role={error ? 'alert' : 'status'}>
          {error ?? message}
        </div>
      )}

      <div className="mt-4 grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0">
          {!selectedJob ? (
            <div className="border-y border-[var(--color-border-soft)] py-10 text-center text-[12px] text-[var(--color-text-secondary)]">期間と条件を確認し、期間検証を開始してください。</div>
          ) : (
            <div className="border-y border-[var(--color-border)] py-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`inline-flex rounded-[3px] border px-2 py-1 text-[10px] font-semibold ${JOB_STATUS_STYLES[selectedJob.status]}`}>{JOB_STATUS_LABELS[selectedJob.status]}</span>
                  <strong className="text-[12px] text-[var(--color-text-primary)]">
                    {selectedJob.requestedStartDate}〜{selectedJob.requestedEndDate}
                  </strong>
                  <span className="text-[10px] text-[var(--color-text-secondary)]">{selectedJob.timeframe === 'BIWEEKLY' ? '2週足' : '月足'} {selectedJob.request.ma1Period}/{selectedJob.request.ma2Period}</span>
                </div>
                <div className="flex items-center gap-2">
                  {active && (
                    <button type="button" disabled={cancelBusy || selectedJob.status === 'CANCEL_REQUESTED'} onClick={() => void cancel()} className="inline-flex h-8 items-center gap-1.5 rounded-[3px] border border-[var(--color-border)] bg-white px-2.5 text-[10px] font-medium text-[var(--color-text-secondary)] disabled:opacity-45">
                      {cancelBusy ? <LoaderCircle size={12} className="animate-spin" aria-hidden /> : <Square size={11} aria-hidden />}
                      検証をキャンセル
                    </button>
                  )}
                  {expired && (
                    <button type="button" disabled={startBusy} onClick={() => void startRequest(selectedJob.request, true)} className="inline-flex h-8 items-center gap-1.5 rounded-[3px] border border-[var(--color-border)] bg-white px-2.5 text-[10px] font-medium text-[var(--color-brand-700)] disabled:opacity-45">
                      <RotateCcw size={12} aria-hidden /> 同じ条件で再実行
                    </button>
                  )}
                </div>
              </div>

              {active && (
                <div className="mt-3">
                  <div className="mb-1.5 flex items-center justify-between gap-3 text-[10px] text-[var(--color-text-secondary)]">
                    <span>{selectedJob.status === 'QUEUED' ? '実行順を待っています。' : `${selectedJob.progress.processedTradingDays.toLocaleString('ja-JP')} / ${selectedJob.progress.totalTradingDays.toLocaleString('ja-JP')}営業日を処理中`}</span>
                    <strong className="tabular-nums text-[var(--color-text-primary)]">{progressPct}%</strong>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-[var(--color-surface-muted)]" role="progressbar" aria-label="期間検証の進捗" aria-valuemin={0} aria-valuemax={selectedJob.progress.totalTradingDays || 1} aria-valuenow={selectedJob.progress.processedTradingDays} aria-valuetext={`${selectedJob.progress.processedTradingDays}/${selectedJob.progress.totalTradingDays}営業日`}>
                    <div className="h-full bg-[var(--color-brand-600)] transition-[width] duration-300" style={{ width: `${progressPct}%` }} />
                  </div>
                  {selectedJob.status === 'CANCEL_REQUESTED' && <p className="mt-2 text-[9px] text-amber-700">処理位置によってキャンセル完了まで少し時間がかかる場合があります。</p>}
                </div>
              )}
              {selectedJob.status === 'FAILED' && <p className="mt-3 text-[11px] text-red-800">{errorMessage(selectedJob.errorCategory)}</p>}
              {selectedJob.status === 'CANCELLED' && <p className="mt-3 text-[11px] text-[var(--color-text-secondary)]">この期間検証はキャンセルされました。</p>}
              {expired && <p className="mt-3 text-[11px] text-amber-800">保存期限を過ぎたため結果は期限切れです。同じ条件で再実行できます。</p>}
            </div>
          )}

          {result && selectedJob && (
            <div className="mt-5 space-y-6 opacity-100" aria-busy={resultLoading}>
              <section aria-labelledby="historical-summary-heading">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 id="historical-summary-heading" className="text-[13px] font-semibold text-[var(--color-text-primary)]">検証サマリー</h3>
                  <span className="text-[10px] text-[var(--color-text-tertiary)]">{result.scanMeta.timeframe === 'BIWEEKLY' ? '2週足' : '月足'} {result.scanMeta.ma1Period}/{result.scanMeta.ma2Period} · 処理 {formatDuration(result.performance.totalMs)}</span>
                </div>
                <p className="mt-1 text-[10px] text-[var(--color-text-secondary)]">実評価期間 {result.scanMeta.resolvedStartDate ?? '—'}〜{result.scanMeta.resolvedEndDate ?? '—'}</p>
                <dl className="mt-3 grid grid-cols-2 border-y border-[var(--color-border-soft)] sm:grid-cols-4">
                  {[
                    ['営業日数', result.summary.tradingDays],
                    ['ユニーク候補', result.summary.uniqueCandidateCount],
                    ['新規候補', result.summary.enteredCount],
                    ['再エントリー', result.summary.reEntryCount],
                    ['状態変化', result.summary.statusChangeCount],
                    ['候補離脱', result.summary.exitedCount],
                    ['最大候補数', result.summary.maxDailyCandidates],
                    ['平均候補数', result.summary.averageDailyCandidates.toFixed(1)],
                  ].map(([label, value]) => (
                    <div key={label} className="border-b border-[var(--color-border-soft)] px-3 py-2 last:border-b-0 sm:[&:nth-last-child(-n+4)]:border-b-0">
                      <dt className="text-[9px] text-[var(--color-text-tertiary)]">{label}</dt>
                      <dd className="mt-0.5 text-[15px] font-semibold tabular-nums text-[var(--color-text-primary)]">{typeof value === 'number' ? value.toLocaleString('ja-JP') : value}</dd>
                    </div>
                  ))}
                </dl>
              </section>

              <section aria-labelledby="historical-count-chart-heading">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 id="historical-count-chart-heading" className="text-[13px] font-semibold text-[var(--color-text-primary)]">候補数推移</h3>
                    <p className="mt-0.5 text-[9px] text-[var(--color-text-tertiary)]">グラフの日付を選ぶと、その日のイベントに絞り込みます。</p>
                  </div>
                  {eventDate && (
                    <span className="inline-flex h-7 items-center gap-1.5 rounded-[3px] border border-[var(--color-brand-200)] bg-[var(--color-brand-50)] px-2 text-[10px] font-medium tabular-nums text-[var(--color-brand-800)]" aria-live="polite">
                      {eventDate} のイベント
                      <button type="button" onClick={() => { setEventDate(''); setEventOffset(0) }} className="inline-flex h-5 w-5 items-center justify-center rounded-[2px] hover:bg-white/70" aria-label="日付絞り込みを解除">
                        <X size={12} aria-hidden />
                      </button>
                    </span>
                  )}
                </div>
                {chartData.length ? (
                  <MeasuredChartFrame className="mt-3 h-[260px] w-full sm:h-[300px]">
                    {({ width, height }) => (
                      <LineChart
                        width={width}
                        height={height}
                        data={chartData}
                        margin={{ top: 8, right: 12, bottom: 2, left: 0 }}
                        onClick={(state) => {
                          const selectedDate = typeof state?.activeLabel === 'string' ? state.activeLabel : null
                          if (!selectedDate) return
                          setEventDate(selectedDate)
                          setEventOffset(0)
                        }}
                      >
                        <CartesianGrid vertical={false} stroke="var(--color-border-soft)" />
                        <XAxis dataKey="date" minTickGap={28} tick={{ fontSize: 9, fill: 'var(--color-text-tertiary)' }} tickLine={false} axisLine={{ stroke: 'var(--color-border-soft)' }} tickFormatter={(value) => String(value).slice(5)} />
                        <YAxis width={34} allowDecimals={false} tick={{ fontSize: 9, fill: 'var(--color-text-tertiary)' }} tickLine={false} axisLine={false} />
                        <Tooltip content={<HistoricalChartTooltip />} />
                        {eventDate && <ReferenceLine x={eventDate} stroke="var(--color-brand-700)" strokeWidth={1} strokeDasharray="3 3" />}
                        <Line type="monotone" dataKey="candidateCount" name="候補数" stroke="var(--color-brand-800)" strokeWidth={2} dot={false} isAnimationActive={false} />
                        <Line type="monotone" dataKey="approachingCount" name="APPROACHING" stroke="#64748b" strokeWidth={1} strokeDasharray="4 3" dot={false} isAnimationActive={false} />
                        <Line type="monotone" dataKey="nearCount" name="NEAR" stroke="#d97706" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                        <Line type="monotone" dataKey="inZoneCount" name="IN ZONE" stroke="#059669" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                      </LineChart>
                    )}
                  </MeasuredChartFrame>
                ) : <p className="mt-3 py-8 text-center text-[11px] text-[var(--color-text-secondary)]">候補数データはありません。</p>}
              </section>

              <section aria-labelledby="historical-events-heading">
                <div className="flex flex-wrap items-end justify-between gap-3">
                  <div>
                    <h3 id="historical-events-heading" className="text-[13px] font-semibold text-[var(--color-text-primary)]">変化イベント</h3>
                    <p className="mt-0.5 text-[9px] text-[var(--color-text-tertiary)]">開始日の既存候補はbaselineとしてイベント件数に含みません。</p>
                  </div>
                  {resultLoading && <span role="status" className="inline-flex items-center gap-1 text-[10px] text-[var(--color-brand-700)]"><LoaderCircle size={12} className="animate-spin" />更新中</span>}
                </div>
                <div className="mt-3 flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
                  <div className="flex max-w-full gap-1 overflow-x-auto pb-1">
                    {EVENT_FILTER_OPTIONS.map(({ value, label }) => (
                      <button key={value} type="button" aria-pressed={eventFilter === value} onClick={() => { setEventFilter(value); setEventOffset(0) }} className={`h-8 shrink-0 rounded-[3px] border px-2.5 text-[10px] font-medium ${eventFilter === value ? 'border-[var(--color-brand-700)] bg-[var(--color-brand-700)] text-white' : 'border-[var(--color-border)] bg-white text-[var(--color-text-secondary)]'}`}>{label}</button>
                    ))}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="inline-flex h-8 items-center gap-1.5 rounded-[3px] border border-[var(--color-border)] bg-white px-2 text-[9px] text-[var(--color-text-secondary)] focus-within:border-[var(--color-brand-500)]">
                      日付
                      <input
                        type="date"
                        value={eventDate}
                        min={result.scanMeta.resolvedStartDate ?? undefined}
                        max={result.scanMeta.resolvedEndDate ?? undefined}
                        onChange={(event) => { setEventDate(event.target.value); setEventOffset(0) }}
                        aria-label="イベント日付で絞り込む"
                        className="min-w-0 bg-transparent text-[10px] tabular-nums text-[var(--color-text-primary)] outline-none"
                      />
                    </label>
                    {eventDate && (
                      <button type="button" onClick={() => { setEventDate(''); setEventOffset(0) }} className="inline-flex h-8 items-center gap-1 rounded-[3px] border border-[var(--color-border)] bg-white px-2 text-[9px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-subtle)]">
                        <X size={11} aria-hidden /> 日付解除
                      </button>
                    )}
                    <form onSubmit={(event) => { event.preventDefault(); setEventSearch(eventSearchDraft.trim()); setEventOffset(0) }} className="flex h-8 min-w-0 items-center rounded-[3px] border border-[var(--color-border)] bg-white px-2 focus-within:border-[var(--color-brand-500)]">
                      <Search size={12} className="shrink-0 text-[var(--color-text-tertiary)]" aria-hidden />
                      <input value={eventSearchDraft} onChange={(event) => setEventSearchDraft(event.target.value)} maxLength={80} aria-label="イベントの銘柄コードまたは会社名を検索" placeholder="銘柄・会社名" className="min-w-0 flex-1 bg-transparent px-1.5 text-[10px] outline-none sm:w-32" />
                      <button type="submit" className="text-[9px] font-medium text-[var(--color-brand-700)]">検索</button>
                    </form>
                    <button type="button" onClick={() => { setEventOrder((current) => current === 'desc' ? 'asc' : 'desc'); setEventOffset(0) }} className="inline-flex h-8 items-center gap-1 rounded-[3px] border border-[var(--color-border)] bg-white px-2 text-[10px] text-[var(--color-text-secondary)]" aria-label={`イベントを${eventOrder === 'desc' ? '古い日付順' : '新しい日付順'}へ変更`}>
                      {eventOrder === 'desc' ? <ArrowDown size={12} aria-hidden /> : <ArrowUp size={12} aria-hidden />}
                      {eventOrder === 'desc' ? '新しい順' : '古い順'}
                    </button>
                  </div>
                </div>

                {result.events.length === 0 ? (
                  <div className="mt-3 border-y border-[var(--color-border-soft)] py-10 text-center text-[11px] text-[var(--color-text-secondary)]">該当する変化イベントはありません。</div>
                ) : (
                  <div className="mt-3 overflow-x-auto border-y border-[var(--color-border)]">
                    <table className="w-full min-w-[980px] border-collapse text-[10px]">
                      <thead className="bg-[var(--color-surface-muted)] text-[var(--color-text-secondary)]">
                        <tr className="border-b border-[var(--color-border)]">
                          <th className="px-2 py-2 text-left">日付</th>
                          <th className="px-2 py-2 text-left">銘柄</th>
                          <th className="px-2 py-2 text-left">Event</th>
                          <th className="px-2 py-2 text-left">状態</th>
                          <th className="px-2 py-2 text-center">Score</th>
                          <th className="px-2 py-2 text-right">Zone距離</th>
                          {TRIGGER_DISCOVERY_STAGE_AXES.map((axis) => <th key={axis} className="px-1 py-2 text-center">{{ dayAStage: '日A', dayBStage: '日B', weekAStage: '週A', weekBStage: '週B', monthAStage: '月A', monthBStage: '月B' }[axis]}</th>)}
                        </tr>
                      </thead>
                      <tbody>
                        {result.events.map((event, index) => {
                          const singleDayParams = new URLSearchParams({
                            mode: 'current',
                            asOf: event.date,
                            timeframe: result.scanMeta.timeframe,
                            ma1: String(result.scanMeta.ma1Period),
                            ma2: String(result.scanMeta.ma2Period),
                          })
                          return (
                            <tr key={`${event.date}-${event.ticker}-${event.eventType}-${index}`} className="border-b border-[var(--color-border-soft)] bg-white hover:bg-[var(--color-surface-subtle)]">
                              <td className="whitespace-nowrap px-2 py-2 align-top tabular-nums">
                                <div className="font-medium text-[var(--color-text-primary)]">{event.date}</div>
                                <a href={`/trigger-discovery?${singleDayParams}`} className="mt-0.5 block text-[9px] text-[var(--color-brand-700)] hover:underline">単日で見る</a>
                              </td>
                              <td className="max-w-[180px] px-2 py-2 align-top">
                                <Link href={`/stock/${event.ticker}`} className="font-semibold text-[var(--color-text-primary)] hover:text-[var(--color-brand-700)]">{event.ticker}</Link>
                                <span className="ml-1.5 text-[9px] text-[var(--color-text-secondary)]">{event.companyName}</span>
                              </td>
                              <td className="px-2 py-2 align-top"><span className={`inline-flex whitespace-nowrap rounded-[3px] border px-1.5 py-1 text-[9px] font-semibold ${EVENT_STYLES[event.eventType]}`}>{EVENT_LABELS[event.eventType]}</span></td>
                              <td className="whitespace-nowrap px-2 py-2 align-top text-[9px] text-[var(--color-text-secondary)]"><span>{statusLabel(event.previousStatus)}</span><span className="mx-1 text-[var(--color-text-tertiary)]">→</span><strong className="font-semibold text-[var(--color-text-primary)]">{statusLabel(event.currentStatus)}</strong></td>
                              <td className="px-2 py-2 text-center align-top"><TriggerScoreCell triggerScore={event.triggerScore} scoreBreakdown={event.scoreBreakdown} /></td>
                              <td className="whitespace-nowrap px-2 py-2 text-right align-top font-medium tabular-nums text-[var(--color-text-primary)]">{formatPercent(event.zoneDistancePct)}</td>
                              {TRIGGER_DISCOVERY_STAGE_AXES.map((axis) => <td key={axis} className="px-1 py-2 text-center align-top"><StageTag stage={event[axis]} size="xs" /></td>)}
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-[10px] text-[var(--color-text-secondary)]">
                  <span>{resultPage?.totalCount.toLocaleString('ja-JP') ?? 0}件中 {resultPage && resultPage.returnedCount ? (resultPage.offset + 1).toLocaleString('ja-JP') : 0}〜{resultPage ? (resultPage.offset + resultPage.returnedCount).toLocaleString('ja-JP') : 0}件</span>
                  <div className="flex items-center gap-2">
                    <label className="inline-flex items-center gap-1">表示
                      <select value={eventLimit} onChange={(event) => { setEventLimit(Number(event.target.value)); setEventOffset(0) }} className="h-8 rounded-[3px] border border-[var(--color-border)] bg-white px-2 text-[10px]">
                        {[50, 100, 200].map((value) => <option key={value} value={value}>{value}件</option>)}
                      </select>
                    </label>
                    <button type="button" disabled={resultLoading || eventPageNumber <= 1} onClick={() => setEventOffset(Math.max(0, eventOffset - eventLimit))} className="inline-flex h-8 w-8 items-center justify-center rounded-[3px] border border-[var(--color-border)] bg-white disabled:opacity-35" aria-label="前のイベントページ"><ChevronLeft size={14} /></button>
                    <span className="min-w-[62px] text-center tabular-nums">{eventPageNumber} / {eventTotalPages}</span>
                    <button type="button" disabled={resultLoading || !resultPage?.hasMore} onClick={() => setEventOffset(eventOffset + eventLimit)} className="inline-flex h-8 w-8 items-center justify-center rounded-[3px] border border-[var(--color-border)] bg-white disabled:opacity-35" aria-label="次のイベントページ"><ChevronRight size={14} /></button>
                  </div>
                </div>
              </section>

              <HistoricalOutcomeWorkspace
                key={selectedJob.jobId}
                historicalJob={selectedJob}
                scanResult={result}
              />
            </div>
          )}
        </div>

        <aside aria-labelledby="recent-historical-scans" className="min-w-0 border-t border-[var(--color-border)] pt-3 xl:border-l xl:border-t-0 xl:pl-4 xl:pt-0">
          <div className="flex items-center justify-between gap-2">
            <h3 id="recent-historical-scans" className="text-[11px] font-semibold text-[var(--color-text-primary)]">最近の期間検証</h3>
            <button type="button" disabled={jobsLoading} onClick={() => { setJobsLoading(true); void refreshJobs().catch((loadError) => setError(loadError instanceof Error ? loadError.message : '履歴を更新できませんでした。')).finally(() => setJobsLoading(false)) }} className="inline-flex h-7 w-7 items-center justify-center rounded-[3px] text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-muted)] disabled:opacity-40" aria-label="期間検証履歴を更新"><RotateCcw size={12} className={jobsLoading ? 'animate-spin' : ''} /></button>
          </div>
          {jobs.length === 0 ? (
            <p className="mt-3 text-[10px] text-[var(--color-text-tertiary)]">{jobsLoading ? '読み込み中…' : '期間検証の履歴はありません。'}</p>
          ) : (
            <div className="mt-2 max-h-[440px] space-y-1 overflow-y-auto pr-1">
              {jobs.map((job) => {
                const jobExpired = job.status === 'COMPLETED' && !job.resultAvailable
                return (
                  <button key={job.jobId} type="button" onClick={() => openJob(job)} aria-pressed={selectedJobId === job.jobId} className={`w-full border-l-2 px-2 py-2 text-left hover:bg-[var(--color-surface-subtle)] ${selectedJobId === job.jobId ? 'border-[var(--color-brand-700)] bg-[var(--color-brand-50)]' : 'border-[var(--color-border-soft)] bg-white'}`}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[9px] tabular-nums text-[var(--color-text-tertiary)]">{formatDateTime(job.createdAt)}</span>
                      <span className={`rounded-[3px] border px-1.5 py-0.5 text-[9px] font-medium ${jobExpired ? 'border-amber-200 bg-amber-50 text-amber-800' : JOB_STATUS_STYLES[job.status]}`}>{jobExpired ? '期限切れ' : JOB_STATUS_LABELS[job.status]}</span>
                    </div>
                    <div className="mt-1 truncate text-[10px] font-medium tabular-nums text-[var(--color-text-primary)]">{job.requestedStartDate}〜{job.requestedEndDate}</div>
                    <div className="mt-0.5 text-[9px] text-[var(--color-text-secondary)]">{job.timeframe === 'BIWEEKLY' ? '2週足' : '月足'} · MA {job.request.ma1Period}/{job.request.ma2Period} · {job.progress.processedTradingDays}/{job.progress.totalTradingDays}日</div>
                  </button>
                )
              })}
            </div>
          )}
        </aside>
      </div>
    </section>
  )
}
