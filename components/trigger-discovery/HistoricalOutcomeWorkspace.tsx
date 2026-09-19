'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import {
  BarChart3,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  LoaderCircle,
  Play,
  Square,
} from 'lucide-react'
import { DataPopover } from '@/components/shared/DataPopover'
import { StageTag } from '@/components/ui/StageTag'
import { OutcomeSegmentationPanel } from '@/components/trigger-discovery/OutcomeSegmentationPanel'
import type { TriggerHistoricalScanResponse } from '@/lib/trigger-discovery-historical-scan-contract'
import type { TriggerHistoricalScanJobSummary } from '@/lib/trigger-discovery-historical-scan-job'
import {
  TRIGGER_OUTCOME_HORIZONS,
  TRIGGER_OUTCOME_STAGE_AXES,
  type TriggerOutcomeEventSelector,
  type TriggerOutcomeHorizon,
  type TriggerOutcomeHorizonSummary,
  type TriggerOutcomeJobStartResponse,
  type TriggerOutcomeJobStatus,
  type TriggerOutcomeJobSummary,
  type TriggerOutcomeResultResponse,
} from '@/lib/trigger-discovery-outcome-contract'

type OutcomeSelector = 'NEAR_ENTERED' | 'IN_ZONE_ENTERED' | 'ENTERED' | 'RE_ENTRY'
type OutcomeMode = OutcomeSelector | 'COMPARE'
type OutcomeSort = 'eventDate' | 'ticker'
type OutcomeOrder = 'asc' | 'desc'

const OUTCOME_TERMINAL_STATUSES = new Set<TriggerOutcomeJobStatus>([
  'COMPLETED',
  'FAILED',
  'CANCELLED',
])

const OUTCOME_MODE_OPTIONS: ReadonlyArray<{ value: OutcomeMode; label: string }> = [
  { value: 'NEAR_ENTERED', label: 'NEAR入り' },
  { value: 'IN_ZONE_ENTERED', label: 'Trigger Zone入り' },
  { value: 'COMPARE', label: 'NEAR入り vs Zone入り' },
  { value: 'ENTERED', label: '新規候補' },
  { value: 'RE_ENTRY', label: '再エントリー' },
]

const SELECTOR_LABELS: Record<OutcomeSelector, string> = {
  NEAR_ENTERED: 'NEAR入り',
  IN_ZONE_ENTERED: 'Trigger Zone入り',
  ENTERED: '新規候補',
  RE_ENTRY: '再エントリー',
}

const OUTCOME_STATUS_LABELS: Record<TriggerOutcomeJobStatus, string> = {
  QUEUED: '待機中',
  RUNNING: '分析中',
  COMPLETED: '完了',
  FAILED: '失敗',
  CANCEL_REQUESTED: 'キャンセル要求中',
  CANCELLED: 'キャンセル済み',
}

const OUTCOME_STATUS_STYLES: Record<TriggerOutcomeJobStatus, string> = {
  QUEUED: 'border-slate-200 bg-slate-50 text-slate-700',
  RUNNING: 'border-sky-200 bg-sky-50 text-sky-800',
  COMPLETED: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  FAILED: 'border-red-200 bg-red-50 text-red-800',
  CANCEL_REQUESTED: 'border-amber-200 bg-amber-50 text-amber-800',
  CANCELLED: 'border-slate-200 bg-slate-50 text-slate-600',
}

const HORIZON_LABELS: Record<TriggerOutcomeHorizon, string> = {
  20: '1カ月',
  60: '3カ月',
  120: '6カ月',
  245: '12カ月',
}

const URL_JOB_KEYS: Record<OutcomeSelector, string> = {
  NEAR_ENTERED: 'outcomeNearJob',
  IN_ZONE_ENTERED: 'outcomeZoneJob',
  ENTERED: 'outcomeEnteredJob',
  RE_ENTRY: 'outcomeReentryJob',
}

interface Props {
  historicalJob: TriggerHistoricalScanJobSummary
  scanResult: TriggerHistoricalScanResponse
}

function selectorsForMode(mode: OutcomeMode): OutcomeSelector[] {
  return mode === 'COMPARE' ? ['NEAR_ENTERED', 'IN_ZONE_ENTERED'] : [mode]
}

function parseOptionalScore(value: string): number | null {
  if (!value.trim()) return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new Error('Scoreは0〜100の範囲で指定してください。')
  }
  return parsed
}

function analysisSignature(mode: OutcomeMode, scoreMin: string, scoreMax: string): string {
  return `${mode}:${scoreMin.trim() || '-'}:${scoreMax.trim() || '-'}`
}

function formatOutcomePercent(value: number | null, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return 'N/A'
  const percent = value * 100
  return `${percent >= 0 ? '+' : ''}${percent.toFixed(digits)}%`
}

function formatRatio(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return 'N/A'
  return `${(value * 100).toFixed(1)}%`
}

function formatPointDifference(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const points = value * 100
  return `${points >= 0 ? '+' : ''}${points.toFixed(2)}pt`
}

function formatPrice(value: number): string {
  return value.toLocaleString('ja-JP', { maximumFractionDigits: 2 })
}

function outcomeEventLabel(row: TriggerOutcomeResultResponse['rows'][number]): string {
  if (row.eventType === 'STATUS_CHANGED' && row.currentStatus === 'NEAR') return 'NEAR入り'
  if (row.eventType === 'STATUS_CHANGED' && row.currentStatus === 'IN_ZONE') return 'Trigger Zone入り'
  if (row.eventType === 'ENTERED') return '新規候補'
  if (row.eventType === 'RE_ENTRY') return '再エントリー'
  if (row.eventType === 'EXITED') return '候補離脱'
  return '状態変化'
}

function outcomeErrorMessage(category: string | null): string {
  if (category === 'memory_limit') return '分析対象が大きすぎました。条件を絞って再度お試しください。'
  if (category === 'source_changed') return '元の期間検証データが更新されました。Outcome分析を再実行してください。'
  return 'その後の値動きの分析に失敗しました。時間をおいて再度お試しください。'
}

function OutcomeHelp() {
  return (
    <DataPopover
      trigger={<CircleHelp size={14} aria-hidden />}
      title="その後の値動きについて"
      triggerAriaLabel="その後の値動きの計算方法"
      triggerTitle="その後の値動きの計算方法"
      triggerClassName="h-6 w-6 justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand-200)]"
      showPatternBadge={false}
      openOnHover
      className="max-w-[calc(100vw-24px)] text-[11px] leading-5"
    >
      <div className="space-y-2 text-[11px] leading-5 text-[var(--color-text-secondary)]">
        <p>Historical Trigger Event発生後の株価推移を確認する分析です。Trigger条件やScoreの計算には利用されません。</p>
        <p>売買価格、手数料、ポジション管理等を含む売買バックテストではありません。</p>
        <p>Event日の終値を基準とし、20 / 60 / 120 / 245営業日後の終値を比較します。</p>
        <p>期間中の最大上昇幅・最大下落幅は、Event翌営業日から各期間終了までのHigh / Lowを基準価格と比較しています。</p>
        <p>同一銘柄の複数イベントを含むため、各観測は統計的に完全独立ではありません。</p>
      </div>
    </DataPopover>
  )
}

function HorizonSummaryBlock({ summary }: { summary: TriggerOutcomeHorizonSummary }) {
  const unavailable = summary.eligibleCount === 0
  return (
    <article className="min-w-0 border-t-2 border-[var(--color-border)] px-3 py-3 sm:px-4">
      <div className="flex items-baseline justify-between gap-2">
        <h5 className="text-[12px] font-semibold text-[var(--color-text-primary)]">{HORIZON_LABELS[summary.horizonSessions]}後</h5>
        <span className="text-[9px] tabular-nums text-[var(--color-text-tertiary)]">{summary.horizonSessions}営業日</span>
      </div>
      {unavailable ? (
        <div className="py-4">
          <div className="text-[20px] font-semibold text-[var(--color-text-secondary)]">N/A</div>
          <p className="mt-1 text-[10px] leading-5 text-[var(--color-text-secondary)]">Event後{summary.horizonSessions}営業日の価格データがまだ揃っていません。</p>
        </div>
      ) : (
        <>
          <div className="mt-3 grid grid-cols-[minmax(0,1fr)_auto] items-end gap-4">
            <div>
              <div className="text-[9px] text-[var(--color-text-tertiary)]">中央値リターン</div>
              <div className="mt-0.5 text-[22px] font-semibold tabular-nums text-[var(--color-text-primary)]">{formatOutcomePercent(summary.medianReturn)}</div>
            </div>
            <div className="text-right">
              <div className="text-[9px] text-[var(--color-text-tertiary)]">プラス比率</div>
              <div className="mt-0.5 text-[16px] font-semibold tabular-nums text-[var(--color-text-primary)]">{formatRatio(summary.positiveReturnRatio)}</div>
            </div>
          </div>
          <dl className="mt-3 grid grid-cols-3 gap-2 border-y border-[var(--color-border-soft)] py-2 text-center">
            <div><dt className="text-[9px] text-[var(--color-text-tertiary)]">25%</dt><dd className="mt-0.5 text-[11px] font-medium tabular-nums text-[var(--color-text-secondary)]">{formatOutcomePercent(summary.p25Return)}</dd></div>
            <div><dt className="text-[9px] text-[var(--color-text-tertiary)]">Median</dt><dd className="mt-0.5 text-[11px] font-semibold tabular-nums text-[var(--color-text-primary)]">{formatOutcomePercent(summary.medianReturn)}</dd></div>
            <div><dt className="text-[9px] text-[var(--color-text-tertiary)]">75%</dt><dd className="mt-0.5 text-[11px] font-medium tabular-nums text-[var(--color-text-secondary)]">{formatOutcomePercent(summary.p75Return)}</dd></div>
          </dl>
          <dl className="mt-3 space-y-1.5 text-[10px]">
            <div className="flex items-center justify-between gap-3"><dt className="text-[var(--color-text-tertiary)]">平均値</dt><dd className="font-medium tabular-nums text-[var(--color-text-secondary)]">{formatOutcomePercent(summary.meanReturn)}</dd></div>
            <div className="flex items-center justify-between gap-3"><dt className="text-[var(--color-text-tertiary)]">期間中の最大上昇幅 <span className="text-[8px]">MFE</span></dt><dd className="font-medium tabular-nums text-[var(--color-text-primary)]">{formatOutcomePercent(summary.medianMfe)}</dd></div>
            <div className="flex items-center justify-between gap-3"><dt className="text-[var(--color-text-tertiary)]">期間中の最大下落幅 <span className="text-[8px]">MAE</span></dt><dd className="font-medium tabular-nums text-[var(--color-text-primary)]">{formatOutcomePercent(summary.medianMae)}</dd></div>
          </dl>
        </>
      )}
      <div className="mt-3 text-[10px] tabular-nums text-[var(--color-text-secondary)]">
        対象 <strong className="font-semibold text-[var(--color-text-primary)]">{summary.eligibleCount.toLocaleString('ja-JP')} / {summary.totalSelectedEvents.toLocaleString('ja-JP')}件</strong>
      </div>
      {summary.unavailableCount > 0 && <div className="mt-1 text-[9px] text-[var(--color-text-tertiary)]">Future data不足 {summary.unavailableCount.toLocaleString('ja-JP')}件</div>}
    </article>
  )
}

function DistributionRow({
  horizon,
  series,
}: {
  horizon: TriggerOutcomeHorizon
  series: Array<{ label: string; summary: TriggerOutcomeHorizonSummary }>
}) {
  const bounds = series.flatMap(({ summary }) => [summary.p25Return, summary.medianReturn, summary.p75Return])
    .filter((value): value is number => value != null && Number.isFinite(value))
  const extent = Math.max(0.01, ...bounds.map((value) => Math.abs(value)))
  const position = (value: number) => Math.max(0, Math.min(100, 50 + value / (extent * 2) * 100))

  return (
    <div className="border-t border-[var(--color-border-soft)] py-3 first:border-t-0">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <strong className="text-[11px] text-[var(--color-text-primary)]">{HORIZON_LABELS[horizon]}</strong>
        <span className="text-[9px] text-[var(--color-text-tertiary)]">25%〜75% / 中央値</span>
      </div>
      <div className="space-y-2.5">
        {series.map(({ label, summary }) => {
          if (summary.eligibleCount === 0 || summary.p25Return == null || summary.p75Return == null || summary.medianReturn == null) {
            return <div key={label} className="grid grid-cols-[100px_minmax(0,1fr)] items-center gap-3 text-[10px]"><span className="truncate text-[var(--color-text-secondary)]">{label}</span><span className="text-[var(--color-text-tertiary)]">N/A</span></div>
          }
          const left = position(summary.p25Return)
          const right = position(summary.p75Return)
          const median = position(summary.medianReturn)
          return (
            <div key={label} className="grid grid-cols-[100px_minmax(0,1fr)] items-center gap-3">
              <span className="truncate text-[10px] text-[var(--color-text-secondary)]">{label}</span>
              <div className="min-w-0">
                <div className="relative h-5" aria-label={`${label} ${HORIZON_LABELS[horizon]}の25%から75% ${formatOutcomePercent(summary.p25Return)}から${formatOutcomePercent(summary.p75Return)}、中央値${formatOutcomePercent(summary.medianReturn)}`}>
                  <div className="absolute inset-x-0 top-2 h-px bg-[var(--color-border)]" />
                  <div className="absolute bottom-0 top-0 left-1/2 w-px bg-[var(--color-border)]" />
                  <div className="absolute top-[5px] h-[7px] rounded-[2px] bg-[var(--color-brand-200)]" style={{ left: `${left}%`, width: `${Math.max(1, right - left)}%` }} />
                  <div className="absolute top-[3px] h-[11px] w-[3px] rounded-full bg-[var(--color-brand-800)]" style={{ left: `calc(${median}% - 1px)` }} />
                </div>
                <div className="flex items-center justify-between text-[9px] tabular-nums text-[var(--color-text-tertiary)]"><span>{formatOutcomePercent(summary.p25Return, 1)}</span><strong className="font-semibold text-[var(--color-text-primary)]">{formatOutcomePercent(summary.medianReturn, 1)}</strong><span>{formatOutcomePercent(summary.p75Return, 1)}</span></div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function CompareHorizonBlock({ near, zone }: {
  near: TriggerOutcomeHorizonSummary
  zone: TriggerOutcomeHorizonSummary
}) {
  const metricRows: Array<{
    label: string
    nearValue: number | null
    zoneValue: number | null
    formatter: (value: number | null) => string
    difference: boolean
  }> = [
    { label: '中央値リターン', nearValue: near.medianReturn, zoneValue: zone.medianReturn, formatter: formatOutcomePercent, difference: true },
    { label: 'プラス比率', nearValue: near.positiveReturnRatio, zoneValue: zone.positiveReturnRatio, formatter: formatRatio, difference: true },
    { label: '期間中の最大上昇幅', nearValue: near.medianMfe, zoneValue: zone.medianMfe, formatter: formatOutcomePercent, difference: true },
    { label: '期間中の最大下落幅', nearValue: near.medianMae, zoneValue: zone.medianMae, formatter: formatOutcomePercent, difference: true },
  ]
  return (
    <article className="min-w-0 border-t-2 border-[var(--color-border)] py-3">
      <div className="flex items-baseline justify-between gap-2 px-3 sm:px-4">
        <h5 className="text-[12px] font-semibold text-[var(--color-text-primary)]">{HORIZON_LABELS[near.horizonSessions]}後</h5>
        <span className="text-[9px] tabular-nums text-[var(--color-text-tertiary)]">{near.horizonSessions}営業日</span>
      </div>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full min-w-[430px] border-collapse text-[10px]">
          <thead className="text-[var(--color-text-tertiary)]"><tr><th className="px-3 py-1 text-left font-medium">指標</th><th className="px-2 py-1 text-right font-medium">NEAR入り</th><th className="px-2 py-1 text-right font-medium">Zone入り</th><th className="px-3 py-1 text-right font-medium">差</th></tr></thead>
          <tbody>
            {metricRows.map((row) => (
              <tr key={row.label} className="border-t border-[var(--color-border-soft)]">
                <th className="px-3 py-2 text-left font-normal text-[var(--color-text-secondary)]">{row.label}</th>
                <td className="px-2 py-2 text-right font-medium tabular-nums text-[var(--color-text-primary)]">{row.formatter(row.nearValue)}</td>
                <td className="px-2 py-2 text-right font-medium tabular-nums text-[var(--color-text-primary)]">{row.formatter(row.zoneValue)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-[var(--color-text-secondary)]">{row.difference && row.nearValue != null && row.zoneValue != null ? formatPointDifference(row.zoneValue - row.nearValue) : '—'}</td>
              </tr>
            ))}
            <tr className="border-t border-[var(--color-border-soft)]">
              <th className="px-3 py-2 text-left font-normal text-[var(--color-text-secondary)]">対象件数</th>
              <td className="px-2 py-2 text-right tabular-nums text-[var(--color-text-primary)]">{near.eligibleCount.toLocaleString('ja-JP')} / {near.totalSelectedEvents.toLocaleString('ja-JP')}</td>
              <td className="px-2 py-2 text-right tabular-nums text-[var(--color-text-primary)]">{zone.eligibleCount.toLocaleString('ja-JP')} / {zone.totalSelectedEvents.toLocaleString('ja-JP')}</td>
              <td className="px-3 py-2 text-right text-[var(--color-text-tertiary)]">—</td>
            </tr>
            <tr className="border-t border-[var(--color-border-soft)]">
              <th className="px-3 py-2 text-left font-normal text-[var(--color-text-secondary)]">将来データ不足</th>
              <td className="px-2 py-2 text-right tabular-nums text-[var(--color-text-secondary)]">{near.unavailableCount.toLocaleString('ja-JP')}件</td>
              <td className="px-2 py-2 text-right tabular-nums text-[var(--color-text-secondary)]">{zone.unavailableCount.toLocaleString('ja-JP')}件</td>
              <td className="px-3 py-2 text-right text-[var(--color-text-tertiary)]">—</td>
            </tr>
          </tbody>
        </table>
      </div>
      {(near.eligibleCount === 0 || zone.eligibleCount === 0) && <p className="px-3 pt-2 text-[9px] leading-4 text-[var(--color-text-tertiary)]">N/AはEvent後{near.horizonSessions}営業日の価格データがまだ揃っていないことを示します。</p>}
    </article>
  )
}

function selectorFromMode(mode: OutcomeMode): OutcomeSelector {
  return mode === 'COMPARE' ? 'NEAR_ENTERED' : mode
}

export function HistoricalOutcomeWorkspace({ historicalJob, scanResult }: Props) {
  const [mode, setMode] = useState<OutcomeMode>('NEAR_ENTERED')
  const [scoreMin, setScoreMin] = useState('')
  const [scoreMax, setScoreMax] = useState('')
  const [startedSignature, setStartedSignature] = useState<string | null>(null)
  const [jobIds, setJobIds] = useState<Partial<Record<OutcomeSelector, string>>>({})
  const [jobs, setJobs] = useState<Partial<Record<OutcomeSelector, TriggerOutcomeJobSummary>>>({})
  const [results, setResults] = useState<Partial<Record<OutcomeSelector, TriggerOutcomeResultResponse>>>({})
  const [detailSelector, setDetailSelector] = useState<OutcomeSelector>('NEAR_ENTERED')
  const [detailHorizon, setDetailHorizon] = useState<TriggerOutcomeHorizon>(60)
  const [detailOffset, setDetailOffset] = useState(0)
  const [detailLimit, setDetailLimit] = useState(100)
  const [detailSort, setDetailSort] = useState<OutcomeSort>('eventDate')
  const [detailOrder, setDetailOrder] = useState<OutcomeOrder>('desc')
  const [startBusy, setStartBusy] = useState(false)
  const [cancelBusy, setCancelBusy] = useState(false)
  const [resultLoading, setResultLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const currentSignature = analysisSignature(mode, scoreMin, scoreMax)
  const activeSelectors = startedSignature === currentSignature ? selectorsForMode(mode) : []

  useEffect(() => {
    const url = new URL(window.location.href)
    if (url.searchParams.get('historicalJob') !== historicalJob.jobId) return
    const urlMode = url.searchParams.get('outcomeMode')
    const restoredMode = OUTCOME_MODE_OPTIONS.some((option) => option.value === urlMode)
      ? urlMode as OutcomeMode
      : 'NEAR_ENTERED'
    const restoredMin = url.searchParams.get('outcomeScoreMin') ?? ''
    const restoredMax = url.searchParams.get('outcomeScoreMax') ?? ''
    const restoredIds: Partial<Record<OutcomeSelector, string>> = {}
    for (const selector of selectorsForMode(restoredMode)) {
      const id = url.searchParams.get(URL_JOB_KEYS[selector])
      if (id) restoredIds[selector] = id
    }
    setMode(restoredMode)
    setScoreMin(restoredMin)
    setScoreMax(restoredMax)
    setDetailSelector(restoredMode === 'COMPARE'
      ? url.searchParams.get('outcomeDetail') === 'IN_ZONE_ENTERED' ? 'IN_ZONE_ENTERED' : 'NEAR_ENTERED'
      : selectorFromMode(restoredMode))
    setJobIds(restoredIds)
    setJobs({})
    setResults({})
    setStartedSignature(Object.keys(restoredIds).length ? analysisSignature(restoredMode, restoredMin, restoredMax) : null)
  }, [historicalJob.jobId])

  const writeOutcomeUrl = (
    nextMode: OutcomeMode,
    nextScoreMin: string,
    nextScoreMax: string,
    nextJobIds: Partial<Record<OutcomeSelector, string>>,
    nextDetail: OutcomeSelector,
  ) => {
    const url = new URL(window.location.href)
    url.searchParams.set('mode', 'period')
    url.searchParams.set('historicalJob', historicalJob.jobId)
    url.searchParams.set('outcomeMode', nextMode)
    if (nextScoreMin.trim()) url.searchParams.set('outcomeScoreMin', nextScoreMin.trim())
    else url.searchParams.delete('outcomeScoreMin')
    if (nextScoreMax.trim()) url.searchParams.set('outcomeScoreMax', nextScoreMax.trim())
    else url.searchParams.delete('outcomeScoreMax')
    for (const [selector, key] of Object.entries(URL_JOB_KEYS) as Array<[OutcomeSelector, string]>) {
      const id = nextJobIds[selector]
      if (id) url.searchParams.set(key, id)
      else url.searchParams.delete(key)
    }
    if (nextMode === 'COMPARE') url.searchParams.set('outcomeDetail', nextDetail)
    else url.searchParams.delete('outcomeDetail')
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
  }

  const startOutcome = async () => {
    setStartBusy(true)
    setError(null)
    setMessage(null)
    try {
      const parsedMin = parseOptionalScore(scoreMin)
      const parsedMax = parseOptionalScore(scoreMax)
      if (parsedMin != null && parsedMax != null && parsedMin > parsedMax) {
        throw new Error('Score下限は上限以下にしてください。')
      }
      const nextSelectors = selectorsForMode(mode)
      const nextIds: Partial<Record<OutcomeSelector, string>> = {}
      let reusedCount = 0
      for (const selector of nextSelectors) {
        const response = await fetch(`/api/trigger-discovery/historical-scan/jobs/${historicalJob.jobId}/outcomes`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            historicalScanJobId: historicalJob.jobId,
            eventFilter: selector as TriggerOutcomeEventSelector,
            horizons: [...TRIGGER_OUTCOME_HORIZONS],
            ticker: null,
            triggerScoreMin: parsedMin,
            triggerScoreMax: parsedMax,
            stageFilters: {},
          }),
          cache: 'no-store',
        })
        const body = await response.json() as TriggerOutcomeJobStartResponse | { error?: string; message?: string }
        if (response.status === 410) throw new Error('元の期間検証データの保存期限が切れています。期間検証を再実行してください。')
        if (!response.ok || !('jobId' in body)) {
          throw new Error('message' in body && body.message ? body.message : 'その後の値動きの分析を開始できませんでした。')
        }
        nextIds[selector] = body.jobId
        if (body.reused) reusedCount += 1
      }
      const nextDetail = mode === 'COMPARE' ? 'NEAR_ENTERED' : selectorFromMode(mode)
      setDetailSelector(nextDetail)
      setDetailOffset(0)
      setJobIds(nextIds)
      setJobs({})
      setResults({})
      setStartedSignature(currentSignature)
      writeOutcomeUrl(mode, scoreMin, scoreMax, nextIds, nextDetail)
      setMessage(reusedCount === nextSelectors.length
        ? '保存済みの同一Outcome結果を再利用します。'
        : mode === 'COMPARE' ? 'NEAR入りとZone入りの分析を順番に受け付けました。' : 'その後の値動きの分析を受け付けました。')
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : 'その後の値動きの分析を開始できませんでした。')
    } finally {
      setStartBusy(false)
    }
  }

  useEffect(() => {
    const entries = activeSelectors.flatMap((selector) => jobIds[selector] ? [[selector, jobIds[selector]!] as const] : [])
    if (!entries.length) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | null = null
    let stopped = false

    const poll = async () => {
      try {
        const loaded = await Promise.all(entries.map(async ([selector, id]) => {
          const response = await fetch(`/api/trigger-discovery/outcome-jobs/${id}`, { cache: 'no-store', signal: controller.signal })
          const body = await response.json() as TriggerOutcomeJobSummary | { error?: string }
          if (response.status === 404) throw new Error('Outcome結果の保存期限が切れています。再分析してください。')
          if (!response.ok || !('jobId' in body)) throw new Error('Outcome Jobの状態を取得できませんでした。')
          if (body.historicalScanJobId !== historicalJob.jobId) throw new Error('Outcome Jobと期間検証の対応が一致しません。')
          return [selector, body] as const
        }))
        if (stopped) return
        setJobs(Object.fromEntries(loaded) as Partial<Record<OutcomeSelector, TriggerOutcomeJobSummary>>)
        if (loaded.some(([, job]) => !OUTCOME_TERMINAL_STATUSES.has(job.status))) timer = setTimeout(poll, 1_500)
      } catch (pollError) {
        if (!controller.signal.aborted && !stopped) setError(pollError instanceof Error ? pollError.message : 'Outcome Jobの状態を取得できませんでした。')
      }
    }
    void poll()
    return () => {
      stopped = true
      controller.abort()
      if (timer) clearTimeout(timer)
    }
  }, [historicalJob.jobId, startedSignature, currentSignature, JSON.stringify(jobIds)])

  useEffect(() => {
    if (!activeSelectors.length) return
    const controller = new AbortController()
    const loadable = activeSelectors.flatMap((selector) => {
      const job = jobs[selector]
      if (job?.status !== 'COMPLETED' || !job.resultAvailable) return []
      const query = selector === detailSelector
        ? { offset: detailOffset, limit: detailLimit, sortBy: detailSort, sortOrder: detailOrder }
        : { offset: 0, limit: 1, sortBy: 'eventDate' as const, sortOrder: 'asc' as const }
      const existing = results[selector]
      const alreadyLoaded = existing?.outcomeJobId === job.jobId
        && existing.rowPage.offset === query.offset
        && existing.rowPage.limit === query.limit
        && existing.rowPage.sortBy === query.sortBy
        && existing.rowPage.sortOrder === query.sortOrder
      return alreadyLoaded ? [] : [[selector, job, query] as const]
    })
    if (!loadable.length) {
      setResultLoading(false)
      return () => controller.abort()
    }
    setResultLoading(true)
    void Promise.all(loadable.map(async ([selector, job, query]) => {
      const params = new URLSearchParams(Object.fromEntries(Object.entries(query).map(([key, value]) => [key, String(value)])))
      const response = await fetch(`/api/trigger-discovery/outcome-jobs/${job.jobId}/result?${params}`, { cache: 'no-store', signal: controller.signal })
      const body = await response.json() as TriggerOutcomeResultResponse | { error?: string }
      if (response.status === 410) throw new Error('Outcome結果の保存期限が切れています。同じ条件で再分析してください。')
      if (!response.ok || !('summary' in body)) throw new Error('Outcome結果を取得できませんでした。')
      return [selector, body] as const
    })).then((loaded) => {
      if (controller.signal.aborted) return
      setResults((current) => ({ ...current, ...Object.fromEntries(loaded) }))
    }).catch((resultError) => {
      if (!controller.signal.aborted) setError(resultError instanceof Error ? resultError.message : 'Outcome結果を取得できませんでした。')
    }).finally(() => {
      if (!controller.signal.aborted) setResultLoading(false)
    })
    return () => controller.abort()
  }, [startedSignature, currentSignature, detailSelector, detailOffset, detailLimit, detailSort, detailOrder, JSON.stringify(jobs)])

  const cancelOutcome = async () => {
    const cancellable = activeSelectors.flatMap((selector) => {
      const job = jobs[selector]
      return job && ['QUEUED', 'RUNNING', 'CANCEL_REQUESTED'].includes(job.status) ? [[selector, job] as const] : []
    })
    if (!cancellable.length) return
    setCancelBusy(true)
    setError(null)
    try {
      for (const [selector, job] of cancellable) {
        const response = await fetch(`/api/trigger-discovery/outcome-jobs/${job.jobId}`, { method: 'DELETE', cache: 'no-store' })
        const body = await response.json() as TriggerOutcomeJobSummary | { error?: string }
        if (!response.ok || !('jobId' in body)) throw new Error('Outcome分析をキャンセルできませんでした。')
        setJobs((current) => ({ ...current, [selector]: body }))
      }
      setMessage('Outcome分析のキャンセルを要求しました。')
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : 'Outcome分析をキャンセルできませんでした。')
    } finally {
      setCancelBusy(false)
    }
  }

  const selectedResults = activeSelectors.flatMap((selector) => results[selector] ? [[selector, results[selector]!] as const] : [])
  const compareReady = mode === 'COMPARE' && results.NEAR_ENTERED && results.IN_ZONE_ENTERED
  const singleSelector = mode === 'COMPARE' ? null : selectorFromMode(mode)
  const singleResult = singleSelector ? results[singleSelector] : null
  const detailResult = results[detailSelector]
  const detailPage = detailResult?.rowPage
  const detailPageNumber = detailPage ? Math.floor(detailPage.offset / detailPage.limit) + 1 : 1
  const detailTotalPages = detailPage ? Math.max(1, Math.ceil(detailPage.totalCount / detailPage.limit)) : 1
  const hasAnyDetailEvents = mode === 'COMPARE'
    ? Boolean(compareReady && (
      results.NEAR_ENTERED!.summary.selectedEventCount
      + results.IN_ZONE_ENTERED!.summary.selectedEventCount > 0
    ))
    : Boolean(detailResult && detailResult.summary.selectedEventCount > 0)
  const outcomeActive = activeSelectors.some((selector) => {
    const status = jobs[selector]?.status
    return status != null && !OUTCOME_TERMINAL_STATUSES.has(status)
  })
  const selectedJobCount = activeSelectors.filter((selector) => jobIds[selector]).length

  const sourceConditions = useMemo(() => {
    const markets = scanResult.criteria.markets?.filter((market): market is string => Boolean(market)) ?? []
    const conditions = [
      `${scanResult.scanMeta.timeframe === 'BIWEEKLY' ? '2週足' : '月足'} ${scanResult.scanMeta.ma1Period}/${scanResult.scanMeta.ma2Period}`,
      `${scanResult.scanMeta.resolvedStartDate ?? scanResult.scanMeta.requestedStartDate}〜${scanResult.scanMeta.resolvedEndDate ?? scanResult.scanMeta.requestedEndDate}`,
      markets.length ? markets.join(' / ') : '全市場',
      `Trigger距離 ${scanResult.criteria.maxApproachDistancePct}%`,
    ]
    if (scanResult.criteria.spreadExpansionEnabled) {
      conditions.push(`MA間隔拡大 ${scanResult.criteria.spreadLookbackIntervals ?? 4}区間 / ${Math.round((scanResult.criteria.minExpansionRatio ?? 0.7) * 100)}%`)
    }
    return conditions
  }, [scanResult])

  return (
    <section aria-labelledby="historical-outcome-heading" className="border-t border-[var(--color-border)] pt-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-3xl">
          <h3 id="historical-outcome-heading" className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-[var(--color-text-primary)]">
            <BarChart3 size={15} aria-hidden /> その後の値動き <OutcomeHelp />
          </h3>
          <p className="mt-1 text-[10px] leading-5 text-[var(--color-text-secondary)]">Historical Trigger Event発生後の値動きを、営業日ベースで比較します。現在の候補・Score・通知には影響しません。</p>
        </div>
        <div className="flex items-center gap-2">
          {outcomeActive && (
            <button type="button" disabled={cancelBusy} onClick={() => void cancelOutcome()} className="inline-flex h-9 items-center gap-1.5 rounded-[3px] border border-[var(--color-border)] bg-white px-3 text-[10px] font-medium text-[var(--color-text-secondary)] disabled:opacity-45">
              {cancelBusy ? <LoaderCircle size={12} className="animate-spin" aria-hidden /> : <Square size={11} aria-hidden />} 分析をキャンセル
            </button>
          )}
          <button type="button" disabled={startBusy || outcomeActive} onClick={() => void startOutcome()} className="inline-flex h-10 min-w-[170px] items-center justify-center gap-2 rounded-[4px] border border-[var(--color-brand-700)] bg-[var(--color-brand-700)] px-4 text-[11px] font-semibold text-white hover:bg-[var(--color-brand-800)] disabled:cursor-not-allowed disabled:opacity-55">
            {startBusy ? <LoaderCircle size={14} className="animate-spin" aria-hidden /> : <Play size={13} aria-hidden />}
            {startBusy ? '受け付け中…' : mode === 'COMPARE' ? 'NEAR入りとZone入りを比較' : 'その後の値動きを分析'}
          </button>
        </div>
      </div>

      <div className="mt-3 flex max-w-full gap-1 overflow-x-auto pb-1" aria-label="Outcome Event種類">
        {OUTCOME_MODE_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={mode === option.value}
            onClick={() => {
              setMode(option.value)
              setDetailSelector(selectorFromMode(option.value))
              setDetailOffset(0)
              setError(null)
              setMessage(null)
            }}
            className={`h-8 shrink-0 rounded-[3px] border px-2.5 text-[10px] font-medium ${mode === option.value ? 'border-[var(--color-brand-700)] bg-[var(--color-brand-700)] text-white' : 'border-[var(--color-border)] bg-white text-[var(--color-text-secondary)]'}`}
          >{option.label}</button>
        ))}
      </div>

      <details className="mt-2 border-y border-[var(--color-border-soft)] py-2">
        <summary className="cursor-pointer text-[10px] font-medium text-[var(--color-text-secondary)]">詳細条件</summary>
        <div className="mt-2 flex flex-wrap items-end gap-3">
          <label className="text-[9px] text-[var(--color-text-tertiary)]">Score下限
            <input type="number" min={0} max={100} step="any" value={scoreMin} onChange={(event) => setScoreMin(event.target.value)} placeholder="指定なし" className="mt-1 block h-8 w-28 rounded-[3px] border border-[var(--color-border)] bg-white px-2 text-[10px] tabular-nums text-[var(--color-text-primary)]" />
          </label>
          <label className="text-[9px] text-[var(--color-text-tertiary)]">Score上限
            <input type="number" min={0} max={100} step="any" value={scoreMax} onChange={(event) => setScoreMax(event.target.value)} placeholder="指定なし" className="mt-1 block h-8 w-28 rounded-[3px] border border-[var(--color-border)] bg-white px-2 text-[10px] tabular-nums text-[var(--color-text-primary)]" />
          </label>
          <p className="pb-1 text-[9px] leading-4 text-[var(--color-text-tertiary)]">Event発生時に保存されたTrigger Scoreで絞り込みます。現在Scoreは使用しません。</p>
        </div>
      </details>

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[9px] text-[var(--color-text-tertiary)]">
        {sourceConditions.map((condition) => <span key={condition}>{condition}</span>)}
      </div>

      {(error || message) && (
        <div className={`mt-3 border-l-2 px-3 py-2 text-[10px] ${error ? 'border-red-500 bg-red-50 text-red-800' : 'border-[var(--color-brand-500)] bg-[var(--color-brand-50)] text-[var(--color-brand-800)]'}`} role={error ? 'alert' : 'status'}>{error ?? message}</div>
      )}

      {startedSignature && startedSignature !== currentSignature && (
        <p className="mt-3 border-l-2 border-amber-400 bg-amber-50 px-3 py-2 text-[10px] text-amber-900">Outcome条件が変更されています。新しい条件で分析を開始してください。</p>
      )}

      {activeSelectors.length > 0 && selectedJobCount > 0 && (
        <div className="mt-4 space-y-2" aria-live="polite">
          {activeSelectors.map((selector) => {
            const job = jobs[selector]
            if (!job) return <div key={selector} className="flex items-center gap-2 text-[10px] text-[var(--color-text-secondary)]"><LoaderCircle size={12} className="animate-spin" aria-hidden />{SELECTOR_LABELS[selector]}の状態を確認中</div>
            const total = job.progress.totalEvents
            const processed = job.progress.processedEvents
            const progress = total > 0 ? Math.min(100, Math.round(processed / total * 100)) : 0
            return (
              <div key={selector} className="border-l-2 border-[var(--color-border)] pl-3">
                <div className="flex flex-wrap items-center justify-between gap-2 text-[10px]">
                  <div className="flex items-center gap-2"><strong className="text-[var(--color-text-primary)]">{SELECTOR_LABELS[selector]}</strong><span className={`rounded-[3px] border px-1.5 py-0.5 text-[9px] font-medium ${OUTCOME_STATUS_STYLES[job.status]}`}>{OUTCOME_STATUS_LABELS[job.status]}</span></div>
                  <span className="tabular-nums text-[var(--color-text-secondary)]">{job.status === 'QUEUED' ? '実行順を待っています' : `${processed.toLocaleString('ja-JP')} / ${total.toLocaleString('ja-JP')}イベント`}</span>
                </div>
                {!OUTCOME_TERMINAL_STATUSES.has(job.status) && <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[var(--color-surface-muted)]" role="progressbar" aria-label={`${SELECTOR_LABELS[selector]} Outcome分析の進捗`} aria-valuemin={0} aria-valuemax={total || 1} aria-valuenow={processed}><div className="h-full bg-[var(--color-brand-600)] transition-[width] duration-300" style={{ width: `${progress}%` }} /></div>}
                {job.status === 'FAILED' && <p className="mt-1 text-[9px] text-red-800">{outcomeErrorMessage(job.errorCategory)}</p>}
                {job.status === 'CANCELLED' && <p className="mt-1 text-[9px] text-[var(--color-text-secondary)]">この分析はキャンセルされました。</p>}
                {job.status === 'COMPLETED' && !job.resultAvailable && <p className="mt-1 text-[9px] text-amber-800">Outcome結果の保存期限が切れています。同じ条件で再分析してください。</p>}
              </div>
            )
          })}
          {outcomeActive && <p className="text-[9px] text-[var(--color-text-tertiary)]">分析中はバックグラウンドで価格データを処理しています。画面を閉じても処理は継続します。</p>}
        </div>
      )}

      {(singleResult || compareReady) && (
        <div className="mt-5 space-y-6">
          <section aria-labelledby="outcome-summary-heading">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <h4 id="outcome-summary-heading" className="text-[12px] font-semibold text-[var(--color-text-primary)]">Outcomeサマリー</h4>
                <p className="mt-0.5 text-[9px] text-[var(--color-text-tertiary)]">中央値・プラス比率・Eligible件数を中心に表示しています。</p>
              </div>
              <span className="text-[9px] tabular-nums text-[var(--color-text-tertiary)]">分析可能データ: {(singleResult ?? results.NEAR_ENTERED)?.metadata.analysisCutoffDate ?? '—'}まで</span>
            </div>

            {singleResult && (
              <>
                {singleResult.summary.selectedEventCount === 0 ? (
                  <div className="mt-3 border-y border-[var(--color-border-soft)] py-8 text-center text-[11px] text-[var(--color-text-secondary)]">この条件に該当するTrigger Eventはありません。</div>
                ) : (
                  <div className="mt-3 grid sm:grid-cols-2 xl:grid-cols-4">
                    {singleResult.summary.horizons.map((summary) => <HorizonSummaryBlock key={summary.horizonSessions} summary={summary} />)}
                  </div>
                )}
              </>
            )}

            {compareReady && (
              results.NEAR_ENTERED!.summary.selectedEventCount + results.IN_ZONE_ENTERED!.summary.selectedEventCount === 0
                ? <div className="mt-3 border-y border-[var(--color-border-soft)] py-8 text-center text-[11px] text-[var(--color-text-secondary)]">この条件に該当するTrigger Eventはありません。</div>
                : (
                  <div className="mt-3 grid gap-x-5 sm:grid-cols-2">
                    {TRIGGER_OUTCOME_HORIZONS.map((horizon) => {
                      const near = results.NEAR_ENTERED!.summary.horizons.find((summary) => summary.horizonSessions === horizon)!
                      const zone = results.IN_ZONE_ENTERED!.summary.horizons.find((summary) => summary.horizonSessions === horizon)!
                      return <CompareHorizonBlock key={horizon} near={near} zone={zone} />
                    })}
                  </div>
                )
            )}
          </section>

          {selectedResults.length > 0 && (
            <section aria-labelledby="outcome-distribution-heading" className="border-t border-[var(--color-border)] pt-4">
              <div>
                <h4 id="outcome-distribution-heading" className="text-[12px] font-semibold text-[var(--color-text-primary)]">リターン分布</h4>
                <p className="mt-0.5 text-[9px] text-[var(--color-text-tertiary)]">線は25%〜75%、濃い印は中央値です。各期間内で共通スケールを使用します。</p>
              </div>
              <div className="mt-2">
                {TRIGGER_OUTCOME_HORIZONS.map((horizon) => (
                  <DistributionRow
                    key={horizon}
                    horizon={horizon}
                    series={selectedResults.map(([selector, outcome]) => ({
                      label: SELECTOR_LABELS[selector],
                      summary: outcome.summary.horizons.find((summary) => summary.horizonSessions === horizon)!,
                    }))}
                  />
                ))}
              </div>
            </section>
          )}

          {detailResult && hasAnyDetailEvents && (
            <section aria-labelledby="outcome-events-heading" className="border-t border-[var(--color-border)] pt-4">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h4 id="outcome-events-heading" className="text-[12px] font-semibold text-[var(--color-text-primary)]">個別Event結果</h4>
                  <p className="mt-0.5 text-[9px] text-[var(--color-text-tertiary)]">選択中の期間についてReturn・最大上昇幅・最大下落幅を表示します。</p>
                </div>
                {resultLoading && <span role="status" className="inline-flex items-center gap-1 text-[10px] text-[var(--color-brand-700)]"><LoaderCircle size={12} className="animate-spin" aria-hidden />更新中</span>}
              </div>

              {mode === 'COMPARE' && (
                <div className="mt-3 flex gap-1" aria-label="個別Eventの種類">
                  {(['NEAR_ENTERED', 'IN_ZONE_ENTERED'] as const).map((selector) => (
                    <button key={selector} type="button" aria-pressed={detailSelector === selector} onClick={() => { setDetailSelector(selector); setDetailOffset(0); writeOutcomeUrl(mode, scoreMin, scoreMax, jobIds, selector) }} className={`h-8 rounded-[3px] border px-2.5 text-[10px] font-medium ${detailSelector === selector ? 'border-[var(--color-brand-700)] bg-[var(--color-brand-50)] text-[var(--color-brand-800)]' : 'border-[var(--color-border)] bg-white text-[var(--color-text-secondary)]'}`}>{SELECTOR_LABELS[selector]}</button>
                  ))}
                </div>
              )}

              <div className="mt-3 flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex max-w-full gap-1 overflow-x-auto pb-1" aria-label="Outcome表示期間">
                  {TRIGGER_OUTCOME_HORIZONS.map((horizon) => <button key={horizon} type="button" aria-pressed={detailHorizon === horizon} onClick={() => setDetailHorizon(horizon)} className={`h-8 shrink-0 rounded-[3px] border px-3 text-[10px] font-medium ${detailHorizon === horizon ? 'border-[var(--color-brand-700)] bg-[var(--color-brand-700)] text-white' : 'border-[var(--color-border)] bg-white text-[var(--color-text-secondary)]'}`}>{HORIZON_LABELS[horizon]}</button>)}
                </div>
                <div className="flex flex-wrap items-center gap-2 text-[10px]">
                  <label className="inline-flex h-8 items-center gap-1.5 text-[var(--color-text-secondary)]">並び順
                    <select value={detailSort} onChange={(event) => { setDetailSort(event.target.value as OutcomeSort); setDetailOffset(0) }} className="h-8 rounded-[3px] border border-[var(--color-border)] bg-white px-2 text-[10px]"><option value="eventDate">Event日</option><option value="ticker">銘柄コード</option></select>
                  </label>
                  <button type="button" onClick={() => { setDetailOrder((current) => current === 'desc' ? 'asc' : 'desc'); setDetailOffset(0) }} className="h-8 rounded-[3px] border border-[var(--color-border)] bg-white px-2.5 text-[10px] text-[var(--color-text-secondary)]">{detailOrder === 'desc' ? '降順' : '昇順'}</button>
                </div>
              </div>

              {detailResult.summary.selectedEventCount === 0 ? (
                <div className="mt-3 border-y border-[var(--color-border-soft)] py-8 text-center text-[11px] text-[var(--color-text-secondary)]">{SELECTOR_LABELS[detailSelector]}に該当するTrigger Eventはありません。</div>
              ) : (
                <>
                  <div className="mt-3 overflow-x-auto border-y border-[var(--color-border)]">
                    <table className="w-full min-w-[1120px] border-collapse text-[10px]">
                  <thead className="bg-[var(--color-surface-muted)] text-[var(--color-text-secondary)]"><tr className="border-b border-[var(--color-border)]"><th className="px-2 py-2 text-left">Event日</th><th className="px-2 py-2 text-left">銘柄</th><th className="px-2 py-2 text-left">Event</th><th className="px-2 py-2 text-right">Score</th><th className="px-2 py-2 text-right">基準価格</th><th className="px-2 py-2 text-right">{HORIZON_LABELS[detailHorizon]} Return</th><th className="px-2 py-2 text-right">最大上昇幅</th><th className="px-2 py-2 text-right">最大下落幅</th>{TRIGGER_OUTCOME_STAGE_AXES.map((axis) => <th key={axis} className="px-1 py-2 text-center">{{ dayAStage: '日A', dayBStage: '日B', weekAStage: '週A', weekBStage: '週B', monthAStage: '月A', monthBStage: '月B' }[axis]}</th>)}</tr></thead>
                  <tbody>
                    {detailResult.rows.map((row, index) => {
                      const suffix = String(detailHorizon) as '20' | '60' | '120' | '245'
                      const available = row[`availability${suffix}`] === 'AVAILABLE'
                      return (
                        <tr key={`${row.eventDate}-${row.ticker}-${row.eventType}-${index}`} className="border-b border-[var(--color-border-soft)] bg-white hover:bg-[var(--color-surface-subtle)]">
                          <td className="whitespace-nowrap px-2 py-2 tabular-nums text-[var(--color-text-primary)]">{row.eventDate}</td>
                          <td className="max-w-[190px] px-2 py-2"><Link href={`/stock/${row.ticker}`} className="font-semibold text-[var(--color-text-primary)] hover:text-[var(--color-brand-700)]">{row.ticker}</Link><span className="ml-1.5 text-[9px] text-[var(--color-text-secondary)]">{row.companyName}</span></td>
                          <td className="whitespace-nowrap px-2 py-2 text-[var(--color-text-secondary)]">{outcomeEventLabel(row)}</td>
                          <td className="px-2 py-2 text-right font-medium tabular-nums text-[var(--color-text-primary)]">{row.triggerScore.toFixed(1)}</td>
                          <td className="px-2 py-2 text-right font-medium tabular-nums text-[var(--color-text-primary)]">{formatPrice(row.anchorPrice)}</td>
                          <td className="px-2 py-2 text-right font-semibold tabular-nums text-[var(--color-text-primary)]">{available ? formatOutcomePercent(row[`return${suffix}`]) : 'N/A'}</td>
                          <td className="px-2 py-2 text-right font-medium tabular-nums text-[var(--color-text-primary)]">{available ? formatOutcomePercent(row[`mfe${suffix}`]) : '—'}</td>
                          <td className="px-2 py-2 text-right font-medium tabular-nums text-[var(--color-text-primary)]">{available ? formatOutcomePercent(row[`mae${suffix}`]) : '—'}</td>
                          {TRIGGER_OUTCOME_STAGE_AXES.map((axis) => <td key={axis} className="px-1 py-2 text-center"><StageTag stage={row[axis]} size="xs" /></td>)}
                        </tr>
                      )
                    })}
                  </tbody>
                    </table>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-[10px] text-[var(--color-text-secondary)]">
                    <span>{detailPage?.totalCount.toLocaleString('ja-JP') ?? 0}件中 {detailPage && detailPage.returnedCount ? (detailPage.offset + 1).toLocaleString('ja-JP') : 0}〜{detailPage ? (detailPage.offset + detailPage.returnedCount).toLocaleString('ja-JP') : 0}件</span>
                    <div className="flex items-center gap-2">
                      <label className="inline-flex items-center gap-1">表示<select value={detailLimit} onChange={(event) => { setDetailLimit(Number(event.target.value)); setDetailOffset(0) }} className="h-8 rounded-[3px] border border-[var(--color-border)] bg-white px-2 text-[10px]">{[50, 100, 200].map((value) => <option key={value} value={value}>{value}件</option>)}</select></label>
                      <button type="button" disabled={resultLoading || detailPageNumber <= 1} onClick={() => setDetailOffset(Math.max(0, detailOffset - detailLimit))} className="inline-flex h-8 w-8 items-center justify-center rounded-[3px] border border-[var(--color-border)] bg-white disabled:opacity-35" aria-label="前のOutcome Eventページ"><ChevronLeft size={14} /></button>
                      <span className="min-w-[62px] text-center tabular-nums">{detailPageNumber} / {detailTotalPages}</span>
                      <button type="button" disabled={resultLoading || !detailPage?.hasMore} onClick={() => setDetailOffset(detailOffset + detailLimit)} className="inline-flex h-8 w-8 items-center justify-center rounded-[3px] border border-[var(--color-border)] bg-white disabled:opacity-35" aria-label="次のOutcome Eventページ"><ChevronRight size={14} /></button>
                    </div>
                  </div>
                </>
              )}
            </section>
          )}

          {jobs[detailSelector]?.status === 'COMPLETED' && jobs[detailSelector]?.resultAvailable && (
            <OutcomeSegmentationPanel
              scanResult={scanResult}
              primarySelector={detailSelector}
              primaryOutcomeJob={jobs[detailSelector]!}
              nearOutcomeJob={jobs.NEAR_ENTERED}
              zoneOutcomeJob={jobs.IN_ZONE_ENTERED}
              horizon={detailHorizon}
              onHorizonChange={setDetailHorizon}
            />
          )}
        </div>
      )}
    </section>
  )
}
