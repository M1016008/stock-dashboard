'use client'

import { useEffect, useMemo, useState } from 'react'
import { LoaderCircle, X } from 'lucide-react'
import { isPathDimension, pathBandLabel } from '@/lib/trigger-path-bands'
import type { TriggerOutcomeHorizon } from '@/lib/trigger-discovery-outcome-contract'
import type {
  PathResearchDimension, PathResearchJobSummary, PathResearchMetric,
  PathResearchSegmentsResponse, PathResearchUnit,
} from '@/lib/trigger-path-research-contract'

const AXES: ReadonlyArray<{ value: PathResearchDimension; label: string }> = [
  { value: 'pathDepthLow', label: 'Zone最深下抜け率（Low）' },
  { value: 'pathDepthClose', label: 'Zone最深下抜け率（終値）' },
  { value: 'timeToDeepest', label: '最深部までの営業日' },
  { value: 'belowZoneDuration', label: 'Zone下の滞在営業日' },
  { value: 'longestBelowStreak', label: 'Zone下の連続営業日' },
  { value: 'reclaimSpeed', label: 'Zone下限の回復速度' },
  { value: 'reclaimStatus', label: '回復状態' },
  { value: 'zoneWidthDepth', label: 'Zone幅で正規化した深さ' },
  { value: 'atrDepth', label: 'ATR20で正規化した深さ' },
  { value: 'scoreBand', label: 'Trigger Score帯' },
  { value: 'stage:dayA', label: '日A Stage' },
  { value: 'stage:dayB', label: '日B Stage' },
  { value: 'stage:weekA', label: '週A Stage' },
  { value: 'stage:weekB', label: '週B Stage' },
  { value: 'stage:monthA', label: '月A Stage' },
  { value: 'stage:monthB', label: '月B Stage' },
  { value: 'spreadExpansion', label: 'MA間隔拡大' },
]

const SCORE_LABELS: Record<string, string> = {
  LOW: '0〜40未満', MID_LOW: '40〜60未満', MID_HIGH: '60〜80未満', HIGH: '80〜100',
  PASS: '拡大条件あり', FAIL: '拡大条件なし', UNKNOWN: '不明・未確定',
}

function bandLabel(dimension: PathResearchDimension, value: string): string {
  return isPathDimension(dimension) ? pathBandLabel(dimension, value) : SCORE_LABELS[value] ?? value
}

function percent(value: number | null, digits = 1): string {
  return value == null || !Number.isFinite(value) ? '—' : `${(value * 100).toFixed(digits)}%`
}

function errorMessage(body: unknown, fallback: string): string {
  return body && typeof body === 'object' && 'message' in body && typeof body.message === 'string'
    ? body.message : fallback
}

export function PathResearchPanel({ active, outcomeJobId, horizon }: {
  active: boolean; outcomeJobId: string; horizon: TriggerOutcomeHorizon
}) {
  const [job, setJob] = useState<PathResearchJobSummary | null>(null)
  const [dimension, setDimension] = useState<PathResearchDimension>('pathDepthLow')
  const [secondDimension, setSecondDimension] = useState<PathResearchDimension | ''>('')
  const [unit, setUnit] = useState<PathResearchUnit>('EVENT')
  const [cohortEnabled, setCohortEnabled] = useState(false)
  const [cohortMetric, setCohortMetric] = useState<PathResearchMetric>('mfe')
  const [cohortHorizon, setCohortHorizon] = useState<TriggerOutcomeHorizon>(60)
  const [cohortMin, setCohortMin] = useState('20')
  const [cohortMax, setCohortMax] = useState('')
  const [result, setResult] = useState<PathResearchSegmentsResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { setJob(null); setResult(null); setError(null) }, [outcomeJobId])

  useEffect(() => {
    if (!active || !job || !['QUEUED', 'RUNNING', 'CANCEL_REQUESTED'].includes(job.status)) return
    let cancelled = false
    const timer = window.setInterval(() => {
      void fetch(`/api/trigger-discovery/path-research/jobs/${job.jobId}`, { cache: 'no-store' })
        .then((response) => response.ok ? response.json() as Promise<PathResearchJobSummary> : Promise.reject(new Error('Job状態を取得できませんでした。')))
        .then((next) => { if (!cancelled) setJob(next) })
        .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : 'Job状態を取得できませんでした。') })
    }, 2_000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [active, job])

  const query = useMemo(() => {
    const params = new URLSearchParams({ horizon: String(horizon), unit })
    params.append('dimension', dimension)
    if (secondDimension && secondDimension !== dimension) params.append('dimension', secondDimension)
    if (cohortEnabled) {
      params.set('cohortMetric', cohortMetric)
      params.set('cohortHorizon', String(cohortHorizon))
      if (cohortMin.trim()) params.set('cohortMin', String(Number(cohortMin) / 100))
      if (cohortMax.trim()) params.set('cohortMax', String(Number(cohortMax) / 100))
    }
    return params.toString()
  }, [horizon, unit, dimension, secondDimension, cohortEnabled, cohortMetric, cohortHorizon, cohortMin, cohortMax])

  useEffect(() => {
    if (!active || job?.status !== 'COMPLETED' || !job.resultAvailable) return
    if (cohortEnabled && ((cohortMin.trim() && !Number.isFinite(Number(cohortMin)))
      || (cohortMax.trim() && !Number.isFinite(Number(cohortMax)))
      || (!cohortMin.trim() && !cohortMax.trim()))) {
      setResult(null)
      setError('Outcome条件の数値を確認してください。')
      return
    }
    const controller = new AbortController()
    setBusy(true)
    setResult(null)
    setError(null)
    void fetch(`/api/trigger-discovery/path-research/jobs/${job.jobId}/segments?${query}`, {
      cache: 'no-store', signal: controller.signal,
    }).then(async (response) => {
      const body = await response.json()
      if (!response.ok) throw new Error(errorMessage(body, 'Path集計を取得できませんでした。'))
      return body as PathResearchSegmentsResponse
    }).then((body) => { if (!controller.signal.aborted) setResult(body) })
      .catch((reason) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Path集計を取得できませんでした。') })
      .finally(() => { if (!controller.signal.aborted) setBusy(false) })
    return () => controller.abort()
  }, [active, job?.jobId, job?.status, job?.resultAvailable, query, cohortEnabled, cohortMin, cohortMax])

  if (!active) return null

  const start = async () => {
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(`/api/trigger-discovery/outcome-jobs/${outcomeJobId}/path-research`, { method: 'POST' })
      const body = await response.json()
      if (!response.ok) throw new Error(errorMessage(body, 'Path分析を開始できませんでした。'))
      const statusResponse = await fetch(`/api/trigger-discovery/path-research/jobs/${body.jobId}`, { cache: 'no-store' })
      if (!statusResponse.ok) throw new Error('Job状態を取得できませんでした。')
      setJob(await statusResponse.json() as PathResearchJobSummary)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Path分析を開始できませんでした。') }
    finally { setBusy(false) }
  }
  const cancel = async () => {
    if (!job) return
    try {
      const response = await fetch(`/api/trigger-discovery/path-research/jobs/${job.jobId}`, { method: 'DELETE' })
      if (!response.ok) throw new Error('中断できませんでした。')
      setJob(await response.json() as PathResearchJobSummary)
    } catch (reason) { setError(reason instanceof Error ? reason.message : '中断できませんでした。') }
  }

  const count = result?.overall.eventCount ?? 0
  const first = dimension
  const second = result?.meta.dimensions[1]
  const matrixColumns = second ? result.meta.bandOrder[second] : []
  const matrixRows = result ? result.meta.bandOrder[first] : []
  const matrix = new Map(result?.groups.map((group) => [JSON.stringify([group.keys[first], second ? group.keys[second] : '']), group]) ?? [])

  return <section className="mt-4 min-w-0 space-y-3" aria-label="Path分析">
    <p className="text-[11px] leading-6 text-[var(--color-text-secondary)]">Path分析はTrigger後に実際に起きた軌跡を用いた事後分析です。Trigger Hit時点で利用可能だった情報だけを使う予測分析ではありません。</p>
    {!job && <button type="button" disabled={busy} onClick={() => void start()} className="h-9 rounded-[3px] border border-[var(--color-brand-700)] px-3 text-[11px] font-semibold text-[var(--color-brand-800)] disabled:opacity-50">全EventのPathを生成</button>}
    {job && job.status !== 'COMPLETED' && <div className="flex flex-wrap items-center gap-3 border-y border-[var(--color-border-soft)] py-2 text-[11px]">
      <span role="status" className="inline-flex items-center gap-1.5">{['RUNNING', 'QUEUED', 'CANCEL_REQUESTED'].includes(job.status) && <LoaderCircle size={14} className="animate-spin" aria-hidden />}{job.status} · {job.progress.processedEvents.toLocaleString('ja-JP')} / {job.progress.totalEvents.toLocaleString('ja-JP')} Event · {job.progress.processedTickers.toLocaleString('ja-JP')} / {job.progress.totalTickers.toLocaleString('ja-JP')}銘柄</span>
      {['RUNNING', 'QUEUED'].includes(job.status) && <button type="button" onClick={() => void cancel()} className="inline-flex items-center gap-1 text-[var(--color-text-secondary)]"><X size={12} />中断</button>}
      {['FAILED', 'CANCELLED'].includes(job.status) && <button type="button" disabled={busy} onClick={() => void start()} className="text-[var(--color-brand-700)]">再実行</button>}
    </div>}
    {job?.status === 'COMPLETED' && !job.resultAvailable && <p className="text-[11px] text-amber-900">保存期限切れのため再分析が必要です。<button type="button" onClick={() => void start()} className="ml-2 underline">再実行</button></p>}
    {job?.status === 'COMPLETED' && job.resultAvailable && <>
      <div className="flex flex-wrap items-end gap-2 border-y border-[var(--color-border-soft)] py-3 text-[11px]">
        <label>分析軸 <select value={dimension} onChange={(event) => { const next = event.target.value as PathResearchDimension; setDimension(next); if (secondDimension === next) setSecondDimension('') }} className="ml-1 h-9 rounded-[3px] border border-[var(--color-border)] bg-white px-2">{AXES.map((axis) => <option key={axis.value} value={axis.value}>{axis.label}</option>)}</select></label>
        <label>掛け合わせ <select value={secondDimension} onChange={(event) => setSecondDimension(event.target.value as PathResearchDimension | '')} className="ml-1 h-9 rounded-[3px] border border-[var(--color-border)] bg-white px-2"><option value="">なし</option>{AXES.filter((axis) => axis.value !== dimension).map((axis) => <option key={axis.value} value={axis.value}>{axis.label}</option>)}</select></label>
        <div className="inline-flex h-9 items-center gap-1" aria-label="観測単位">{(['EVENT', 'EPISODE'] as const).map((value) => <button key={value} type="button" aria-pressed={unit === value} onClick={() => setUnit(value)} className={`h-8 rounded-[3px] border px-2 ${unit === value ? 'border-[var(--color-brand-700)] bg-[var(--color-brand-50)] font-semibold' : 'border-[var(--color-border)]'}`}>{value === 'EVENT' ? 'Event' : 'Episode'}</button>)}</div>
      </div>
      <details className="text-[11px]"><summary className="cursor-pointer text-[var(--color-text-secondary)]">結果から母集団を絞る（事後分析）</summary>
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <label className="inline-flex items-center gap-1"><input type="checkbox" checked={cohortEnabled} onChange={(event) => setCohortEnabled(event.target.checked)} />有効</label>
          <label>指標 <select value={cohortMetric} onChange={(event) => setCohortMetric(event.target.value as PathResearchMetric)} className="ml-1 h-8 border border-[var(--color-border)] bg-white px-1"><option value="return">Return</option><option value="mfe">MFE</option><option value="mae">MAE</option></select></label>
          <label>期間 <select value={cohortHorizon} onChange={(event) => setCohortHorizon(Number(event.target.value) as TriggerOutcomeHorizon)} className="ml-1 h-8 border border-[var(--color-border)] bg-white px-1">{([20, 60, 120, 245] as const).map((value) => <option key={value} value={value}>{value}営業日</option>)}</select></label>
          <label>下限% <input type="number" value={cohortMin} onChange={(event) => setCohortMin(event.target.value)} className="ml-1 h-8 w-20 border border-[var(--color-border)] px-1" /></label>
          <label>上限% <input type="number" value={cohortMax} onChange={(event) => setCohortMax(event.target.value)} className="ml-1 h-8 w-20 border border-[var(--color-border)] px-1" /></label>
        </div>
      </details>
      {busy && <p role="status" className="inline-flex items-center gap-1 text-[11px]"><LoaderCircle size={13} className="animate-spin" />集計中</p>}
      {result && <>
        <p className="text-[11px] text-[var(--color-text-secondary)]">{horizon}営業日Path × {horizon}営業日Outcome · {count.toLocaleString('ja-JP')} {unit === 'EVENT' ? 'Event' : 'Episode'} · Eligible {result.overall.horizon.eligibleCount.toLocaleString('ja-JP')} · Path未確定 {result.meta.excludedForMissingFixedPath.toLocaleString('ja-JP')} · 基準 {result.meta.analysisCutoffDate}{result.meta.outcomeConditioned && <strong className="ml-2 text-amber-900">Outcome条件付き・事後抽出</strong>}</p>
        {result.meta.anchorSemanticsCounts.PREVIOUS_CANDIDATE_SAVED_PRICE > 0 && <p className="text-[11px] text-amber-900">Anchor: Event当日保存価格 {result.meta.anchorSemanticsCounts.EVENT_SAVED_PRICE.toLocaleString('ja-JP')}件 / 前回候補保存価格 {result.meta.anchorSemanticsCounts.PREVIOUS_CANDIDATE_SAVED_PRICE.toLocaleString('ja-JP')}件。価格基準が異なるため、集計を比較する際はEvent selectorを分けてください。</p>}
        <div className="max-w-full overflow-x-auto" role="region" aria-label="Path分析結果">
          {second && <table className="min-w-max border-collapse text-right text-[11px]"><caption className="mb-2 text-left text-[var(--color-text-secondary)]">{AXES.find((axis) => axis.value === first)?.label} × {AXES.find((axis) => axis.value === second)?.label} · 中央値リターン / Eligible</caption><thead><tr><th className="border-b p-2 text-left">{AXES.find((axis) => axis.value === first)?.label}</th>{matrixColumns.map((column) => <th key={column} className="border-b p-2">{bandLabel(second, column)}</th>)}</tr></thead><tbody>{matrixRows.map((row) => <tr key={row}><th className="border-b p-2 text-left font-medium">{bandLabel(first, row)}</th>{matrixColumns.map((column) => { const group = matrix.get(JSON.stringify([row, column])); return <td key={column} className="border-b p-2 tabular-nums">{group?.horizon.eligibleCount ? `${percent(group.horizon.medianReturn)} / ${group.horizon.eligibleCount}${group.smallSample ? ' *' : ''}` : '—'}</td> })}</tr>)}</tbody></table>}
          <table className="mt-3 min-w-[860px] border-collapse text-right text-[11px]"><thead><tr className="border-b border-[var(--color-border)]"><th className="px-2 py-2 text-left">{second ? '組合せ' : AXES.find((axis) => axis.value === first)?.label}</th>{['Event', 'Unique', 'Eligible', 'Median', 'プラス比率', 'Q25', 'Q75', 'MFE', 'MAE'].map((label) => <th key={label} className="px-2 py-2">{label}</th>)}</tr></thead><tbody>{result.groups.map((group) => <tr key={JSON.stringify(group.keys)} className="border-b border-[var(--color-border-soft)]"><th className="px-2 py-2 text-left font-medium">{result.meta.dimensions.map((axis) => bandLabel(axis, group.keys[axis])).join(' × ')}{group.smallSample && group.eventCount > 0 && <small className="ml-1 text-amber-900">n&lt;30</small>}</th><td className="px-2 tabular-nums">{group.eventCount}</td><td className="px-2 tabular-nums">{group.uniqueTickerCount}</td><td className="px-2 tabular-nums">{group.horizon.eligibleCount}</td><td className="px-2 tabular-nums">{percent(group.horizon.medianReturn)}</td><td className="px-2 tabular-nums">{percent(group.horizon.positiveReturnRatio)}</td><td className="px-2 tabular-nums">{percent(group.horizon.p25Return)}</td><td className="px-2 tabular-nums">{percent(group.horizon.p75Return)}</td><td className="px-2 tabular-nums">{percent(group.horizon.medianMfe)}</td><td className="px-2 tabular-nums">{percent(group.horizon.medianMae)}</td></tr>)}</tbody></table>
        </div>
        <p className="text-[10px] text-[var(--color-text-secondary)]">* Eligible 30件未満は少数サンプルです。UNKNOWNは母集団に残しますが、固定期間Path未確定のEventはOutcome集計のEligibleに含めません。数値は投資推奨ではありません。</p>
      </>}
    </>}
    {error && <p role="alert" className="border-l-2 border-red-500 bg-red-50 px-3 py-2 text-[11px] text-red-800">{error}</p>}
  </section>
}
