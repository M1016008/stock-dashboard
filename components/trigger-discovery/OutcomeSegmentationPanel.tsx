'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, CircleHelp, LoaderCircle, Scale } from 'lucide-react'
import { DataPopover } from '@/components/shared/DataPopover'
import { StageTag } from '@/components/ui/StageTag'
import { OutcomeRobustnessPanel } from '@/components/trigger-discovery/OutcomeRobustnessPanel'
import type { TriggerHistoricalScanResponse } from '@/lib/trigger-discovery-historical-scan-contract'
import {
  TRIGGER_OUTCOME_HORIZONS,
  type TriggerOutcomeEventSelector,
  type TriggerOutcomeHorizon,
  type TriggerOutcomeJobSummary,
  type TriggerOutcomeRecentJob,
  type TriggerOutcomeRecentJobListResponse,
} from '@/lib/trigger-discovery-outcome-contract'
import {
  TRIGGER_OUTCOME_SCORE_BANDS,
  TRIGGER_OUTCOME_STAGE_BUCKETS,
  type TriggerOutcomeSegmentComparisonResponse,
  type TriggerOutcomeSegmentDimension,
  type TriggerOutcomeSegmentGroup,
  type TriggerOutcomeSegmentHorizonSummary,
  type TriggerOutcomeSegmentationResponse,
} from '@/lib/trigger-discovery-outcome-segmentation'

type OutcomeSelector = 'NEAR_ENTERED' | 'IN_ZONE_ENTERED' | 'ENTERED' | 'RE_ENTRY'
type SegmentTab = 'score' | 'spread' | 'stage' | 'pair' | 'compare' | 'robustness'
type SegmentMetric = 'medianReturn' | 'positiveReturnRatio' | 'medianMfe' | 'medianMae'
type StageDimension = Exclude<TriggerOutcomeSegmentDimension, 'scoreBand' | 'spreadExpansion'>
type ComparisonKind = 'event' | 'source'
type ComparisonView = 'score' | 'stage' | 'pair'

interface Props {
  scanResult: TriggerHistoricalScanResponse
  primarySelector: OutcomeSelector
  primaryOutcomeJob: TriggerOutcomeJobSummary
  nearOutcomeJob?: TriggerOutcomeJobSummary
  zoneOutcomeJob?: TriggerOutcomeJobSummary
  horizon: TriggerOutcomeHorizon
  onHorizonChange: (horizon: TriggerOutcomeHorizon) => void
}

const SEGMENT_TABS: ReadonlyArray<{ value: SegmentTab; label: string }> = [
  { value: 'score', label: 'Score帯' },
  { value: 'spread', label: 'MA間隔拡大' },
  { value: 'stage', label: 'Stage別' },
  { value: 'pair', label: 'Stage組み合わせ' },
  { value: 'compare', label: '月足 vs 2週足' },
  { value: 'robustness', label: '観測単位' },
]

const METRIC_OPTIONS: ReadonlyArray<{ value: SegmentMetric; label: string; shortLabel: string }> = [
  { value: 'medianReturn', label: '中央値リターン', shortLabel: 'Median' },
  { value: 'positiveReturnRatio', label: 'プラス比率', shortLabel: 'プラス比率' },
  { value: 'medianMfe', label: '期間中最大上昇幅中央値', shortLabel: 'MFE' },
  { value: 'medianMae', label: '期間中最大下落幅中央値', shortLabel: 'MAE' },
]

const STAGE_DIMENSIONS: ReadonlyArray<{ value: StageDimension; label: string }> = [
  { value: 'stage:dayA', label: '日A' },
  { value: 'stage:dayB', label: '日B' },
  { value: 'stage:weekA', label: '週A' },
  { value: 'stage:weekB', label: '週B' },
  { value: 'stage:monthA', label: '月A' },
  { value: 'stage:monthB', label: '月B' },
]

const SCORE_LABELS: Record<string, string> = {
  LOW: '0–40未満',
  MID_LOW: '40–60未満',
  MID_HIGH: '60–80未満',
  HIGH: '80–100',
  UNKNOWN: '不明',
}

const SELECTOR_LABELS: Partial<Record<TriggerOutcomeEventSelector, string>> = {
  NEAR_ENTERED: 'NEAR入り',
  IN_ZONE_ENTERED: 'Trigger Zone入り',
  ENTERED: '新規候補',
  RE_ENTRY: '再エントリー',
}

const HORIZON_LABELS: Record<TriggerOutcomeHorizon, string> = {
  20: '1カ月',
  60: '3カ月',
  120: '6カ月',
  245: '12カ月',
}

function formatPercent(value: number | null, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return 'N/A'
  const percent = value * 100
  return `${percent >= 0 ? '+' : ''}${percent.toFixed(digits)}%`
}

function formatRatio(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return 'N/A'
  return `${(value * 100).toFixed(1)}%`
}

function formatMetric(value: number | null, metric: SegmentMetric): string {
  return metric === 'positiveReturnRatio' ? formatRatio(value) : formatPercent(value)
}

function formatDifference(left: number | null, right: number | null): string {
  if (left == null || right == null || !Number.isFinite(left) || !Number.isFinite(right)) return '—'
  const points = (right - left) * 100
  return `${points >= 0 ? '+' : ''}${points.toFixed(2)}pt`
}

function metricValue(summary: TriggerOutcomeSegmentHorizonSummary, metric: SegmentMetric): number | null {
  return summary[metric]
}

function stageLabel(value: string): string {
  return value === 'UNKNOWN' ? '不明' : value
}

function dimensionLabel(dimension: StageDimension): string {
  return STAGE_DIMENSIONS.find((option) => option.value === dimension)?.label ?? dimension
}

function sourceLabel(source: TriggerOutcomeSegmentationResponse['meta']['source']): string {
  const unit = source.maPeriods.unit === 'MONTHLY_BARS' ? 'か月' : '本'
  const timeframe = source.timeframe === 'MONTHLY' ? '月足' : '2週足'
  return `${timeframe} ${source.maPeriods.ma1}${unit} / ${source.maPeriods.ma2}${unit}`
}

function recentOutcomeLabel(job: TriggerOutcomeRecentJob): string {
  const timeframe = job.timeframe === 'BIWEEKLY' ? '2週足' : '月足'
  const unit = job.timeframe === 'BIWEEKLY' ? '本' : 'か月'
  return `${timeframe} ${job.ma1Period}${unit}/${job.ma2Period}${unit}｜${SELECTOR_LABELS[job.eventSelector] ?? job.eventSelector}｜${job.resolvedStartDate ?? job.requestedStartDate}〜${job.resolvedEndDate ?? job.requestedEndDate}｜MA間隔拡大 ${job.spreadExpansionEnabled ? 'ON' : 'OFF'}`
}

function sourceSummaryFromScan(
  scanResult: TriggerHistoricalScanResponse,
  selector: OutcomeSelector,
  cutoff: string | null,
): string[] {
  const timeframe = scanResult.scanMeta.timeframe === 'BIWEEKLY' ? '2週足' : '月足'
  const unit = scanResult.scanMeta.timeframe === 'BIWEEKLY' ? '本' : 'か月'
  return [
    `${timeframe} ${scanResult.scanMeta.ma1Period}${unit} / ${scanResult.scanMeta.ma2Period}${unit}`,
    SELECTOR_LABELS[selector] ?? selector,
    `${scanResult.scanMeta.resolvedStartDate ?? scanResult.scanMeta.requestedStartDate}〜${scanResult.scanMeta.resolvedEndDate ?? scanResult.scanMeta.requestedEndDate}`,
    `分析可能データ ${cutoff ?? '—'}まで`,
  ]
}

async function apiErrorMessage(response: Response, fallback: string): Promise<string> {
  const body = await response.json().catch(() => null) as { message?: string; error?: string } | null
  if (response.status === 410) return 'Outcome分析結果の保存期限が切れています。再度「その後の値動き」を分析してください。'
  if (response.status === 409) return 'Outcome分析がまだ完了していません。完了後にもう一度お試しください。'
  if (response.status === 404) return 'Outcome分析結果が見つかりません。'
  if (response.status === 400) return body?.message ?? '比較条件を確認してください。'
  return body?.message ?? fallback
}

function horizonSummary(
  group: TriggerOutcomeSegmentGroup,
  horizon: TriggerOutcomeHorizon,
): TriggerOutcomeSegmentHorizonSummary | null {
  return group.horizons.find((summary) => summary.horizonSessions === horizon) ?? null
}

function SmallSampleIndicator() {
  return (
    <DataPopover
      trigger={<span className="whitespace-nowrap rounded-[3px] border border-dashed border-amber-400 bg-amber-50 px-1.5 py-0.5 text-[9px] font-semibold text-amber-900">n&lt;30</span>}
      title="少数サンプル"
      triggerAriaLabel="少数サンプルの説明"
      triggerTitle="少数サンプルの説明"
      triggerClassName="rounded-[3px] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand-200)]"
      showPatternBadge={false}
      openOnHover
    >
      対象件数が30件未満のため、参考値として表示しています。
    </DataPopover>
  )
}

function MethodHelp({ kind }: { kind: 'score' | 'stage' | 'events' }) {
  const content = kind === 'score'
    ? 'ScoreはTrigger条件への適合度です。0–40、40–60、60–80、80–100の4帯で比較しています。その後のリターン評価ではありません。'
    : kind === 'stage'
      ? 'S1〜S6は循環的な相場構造を表す分類で、数字の大小がそのまま強弱順位を意味するものではありません。'
      : '同一銘柄で複数のTrigger Eventが発生するため、Event数と銘柄数は一致しない場合があります。各Eventは統計的に完全独立ではありません。'
  return (
    <DataPopover
      trigger={<CircleHelp size={13} aria-hidden />}
      title={kind === 'score' ? 'Trigger Score帯' : kind === 'stage' ? '6 Stage' : 'Event数と銘柄数'}
      triggerAriaLabel={`${kind === 'score' ? 'Trigger Score帯' : kind === 'stage' ? '6 Stage' : 'Event数と銘柄数'}の説明`}
      triggerTitle="説明を見る"
      triggerClassName="h-6 w-6 justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand-200)]"
      showPatternBadge={false}
      openOnHover
    >
      <p className="leading-5">{content}</p>
    </DataPopover>
  )
}

function SegmentLabel({ value, dimension }: { value: string; dimension: TriggerOutcomeSegmentDimension }) {
  if (dimension === 'scoreBand') return <span className="font-semibold">{SCORE_LABELS[value] ?? value}</span>
  if (dimension === 'spreadExpansion') return <span className="font-semibold">{value === 'PASS' ? '拡大条件あり' : value === 'FAIL' ? '拡大条件なし' : '判定不能'}</span>
  if (value === 'UNKNOWN') return <span className="text-[var(--color-text-secondary)]">不明</span>
  const stage = Number(value.slice(1))
  return <span className="inline-flex items-center gap-1.5"><StageTag stage={stage} size="xs" /><span>S{stage}</span></span>
}

function ScoreBandCards({ response, horizon }: { response: TriggerOutcomeSegmentationResponse; horizon: TriggerOutcomeHorizon }) {
  const groups = new Map(response.segmentation.groups.map((group) => [group.keys.scoreBand, group]))
  return (
    <div className="grid gap-x-5 gap-y-4 sm:grid-cols-2 xl:grid-cols-4">
      {TRIGGER_OUTCOME_SCORE_BANDS.map((band) => {
        const group = groups.get(band)
        if (!group || (band === 'UNKNOWN' && group.eventCount === 0)) return null
        const summary = horizonSummary(group, horizon)
        const eligible = summary?.eligibleCount ?? 0
        return (
          <article key={band} className="min-w-0 border-t border-[var(--color-border)] pt-3">
            <div className="flex items-center justify-between gap-2">
              <h6 className="text-[11px] font-semibold text-[var(--color-text-primary)]">{SCORE_LABELS[band]}</h6>
              {summary?.smallSample && eligible > 0 && <SmallSampleIndicator />}
            </div>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <div><span className="block text-[9px] text-[var(--color-text-secondary)]">中央値</span><strong className="text-[17px] tabular-nums text-[var(--color-text-primary)]">{eligible ? formatPercent(summary!.medianReturn) : 'N/A'}</strong></div>
              <div><span className="block text-[9px] text-[var(--color-text-secondary)]">プラス比率</span><strong className="text-[15px] tabular-nums text-[var(--color-text-primary)]">{eligible ? formatRatio(summary!.positiveReturnRatio) : 'N/A'}</strong></div>
            </div>
            <p className="mt-2 text-[10px] tabular-nums text-[var(--color-text-secondary)]">Eligible {eligible.toLocaleString('ja-JP')} / {group.eventCount.toLocaleString('ja-JP')} Event <span className="mx-1">·</span> {group.uniqueTickerCount.toLocaleString('ja-JP')}銘柄</p>
            <p className="text-[9px] tabular-nums text-[var(--color-text-tertiary)]">将来データ不足 {summary?.censoredCount.toLocaleString('ja-JP') ?? '0'}件</p>
            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 border-t border-[var(--color-border-soft)] pt-2 text-[9px] text-[var(--color-text-secondary)]">
              {([
                ['Q25', summary?.p25Return], ['Q75', summary?.p75Return],
                ['MFE', summary?.medianMfe], ['MAE', summary?.medianMae],
                ['Mean', summary?.meanReturn],
              ] as const).map(([label, value]) => <div key={label} className="flex justify-between gap-1"><dt>{label}</dt><dd className="tabular-nums text-[var(--color-text-primary)]">{eligible ? formatPercent(value ?? null) : 'N/A'}</dd></div>)}
            </dl>
          </article>
        )
      })}
    </div>
  )
}

function SegmentTable({
  response,
  dimension,
  horizon,
  selectedMetric,
  visibleSpreadBucket = 'ALL',
}: {
  response: TriggerOutcomeSegmentationResponse
  dimension: TriggerOutcomeSegmentDimension
  horizon: TriggerOutcomeHorizon
  selectedMetric: SegmentMetric
  visibleSpreadBucket?: 'ALL' | 'PASS' | 'FAIL'
}) {
  return (
    <div className="overflow-x-auto border-y border-[var(--color-border)]">
      <table className="w-full min-w-[930px] border-collapse text-[10px]">
        <thead className="bg-[var(--color-surface-muted)] text-[var(--color-text-secondary)]">
          <tr className="border-b border-[var(--color-border)]">
            <th className="px-3 py-2 text-left">{dimension === 'scoreBand' ? 'Score帯' : dimension === 'spreadExpansion' ? 'MA間隔拡大' : dimensionLabel(dimension as StageDimension)}</th>
            <th className="px-2 py-2 text-right">Event</th>
            <th className="px-2 py-2 text-right">銘柄</th>
            <th className="px-2 py-2 text-right">Eligible</th>
            <th className="px-2 py-2 text-right">将来不足</th>
            <th className={`px-2 py-2 text-right ${selectedMetric === 'medianReturn' ? 'text-[var(--color-brand-800)]' : ''}`}>Median</th>
            <th className="px-2 py-2 text-right">Mean</th>
            <th className={`px-2 py-2 text-right ${selectedMetric === 'positiveReturnRatio' ? 'text-[var(--color-brand-800)]' : ''}`}>プラス比率</th>
            <th className="px-2 py-2 text-right">Q25–Q75</th>
            <th className={`px-2 py-2 text-right ${selectedMetric === 'medianMfe' ? 'text-[var(--color-brand-800)]' : ''}`}>MFE</th>
            <th className={`px-3 py-2 text-right ${selectedMetric === 'medianMae' ? 'text-[var(--color-brand-800)]' : ''}`}>MAE</th>
          </tr>
        </thead>
        <tbody>
          {response.segmentation.groups.filter((group) => (
            (dimension !== 'spreadExpansion' || visibleSpreadBucket === 'ALL' || group.keys.spreadExpansion === visibleSpreadBucket)
            && (group.keys[dimension] !== 'UNKNOWN' || group.eventCount > 0)
          )).map((group) => {
            const value = String(group.keys[dimension] ?? 'UNKNOWN')
            const summary = horizonSummary(group, horizon)
            const unavailable = !summary || summary.eligibleCount === 0
            return (
              <tr key={value} className="border-b border-[var(--color-border-soft)] bg-white last:border-b-0">
                <th className="px-3 py-2.5 text-left font-medium text-[var(--color-text-primary)]"><SegmentLabel value={value} dimension={dimension} /></th>
                <td className="px-2 py-2.5 text-right tabular-nums">{group.eventCount.toLocaleString('ja-JP')}</td>
                <td className="px-2 py-2.5 text-right tabular-nums">{group.uniqueTickerCount.toLocaleString('ja-JP')}</td>
                <td className="px-2 py-2.5 text-right tabular-nums"><span className="inline-flex items-center justify-end gap-1.5">{summary?.eligibleCount.toLocaleString('ja-JP') ?? '0'} / {group.eventCount.toLocaleString('ja-JP')}{summary?.smallSample && summary.eligibleCount > 0 && <SmallSampleIndicator />}</span></td>
                <td className="px-2 py-2.5 text-right tabular-nums">{summary?.censoredCount.toLocaleString('ja-JP') ?? '0'}</td>
                <td className="px-2 py-2.5 text-right font-semibold tabular-nums">{unavailable ? 'N/A' : formatPercent(summary.medianReturn)}</td>
                <td className="px-2 py-2.5 text-right tabular-nums">{unavailable ? 'N/A' : formatPercent(summary.meanReturn)}</td>
                <td className="px-2 py-2.5 text-right tabular-nums">{unavailable ? 'N/A' : formatRatio(summary.positiveReturnRatio)}</td>
                <td className="px-2 py-2.5 text-right tabular-nums text-[var(--color-text-secondary)]">{unavailable ? 'N/A' : `${formatPercent(summary.p25Return)} – ${formatPercent(summary.p75Return)}`}</td>
                <td className="px-2 py-2.5 text-right tabular-nums">{unavailable ? 'N/A' : formatPercent(summary.medianMfe)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{unavailable ? 'N/A' : formatPercent(summary.medianMae)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

interface HeatScale {
  center: number
  extent: number
  mode: 'diverging' | 'positive' | 'negative'
}

function heatScale(
  responses: TriggerOutcomeSegmentationResponse[],
  horizon: TriggerOutcomeHorizon,
  metric: SegmentMetric,
): HeatScale {
  const values = responses.flatMap((response) => response.segmentation.groups.flatMap((group) => {
    const summary = horizonSummary(group, horizon)
    const value = summary && summary.eligibleCount > 0 ? metricValue(summary, metric) : null
    return value == null || !Number.isFinite(value) ? [] : [value]
  }))
  if (metric === 'positiveReturnRatio') {
    return { center: 0.5, extent: Math.max(0.1, ...values.map((value) => Math.abs(value - 0.5))), mode: 'diverging' }
  }
  if (metric === 'medianMfe') return { center: 0, extent: Math.max(0.01, ...values.map(Math.abs)), mode: 'positive' }
  if (metric === 'medianMae') return { center: 0, extent: Math.max(0.01, ...values.map(Math.abs)), mode: 'negative' }
  return { center: 0, extent: Math.max(0.01, ...values.map(Math.abs)), mode: 'diverging' }
}

function heatCellStyle(value: number | null, scale: HeatScale): React.CSSProperties {
  if (value == null || !Number.isFinite(value)) return { backgroundColor: 'var(--color-surface-subtle)' }
  const ratio = Math.min(1, Math.abs(value - scale.center) / scale.extent)
  const strength = Math.round(7 + ratio * 25)
  const positive = scale.mode === 'positive' || (scale.mode === 'diverging' && value >= scale.center)
  const token = positive ? 'var(--color-price-up)' : 'var(--color-price-down)'
  return { backgroundColor: `color-mix(in srgb, ${token} ${strength}%, white)` }
}

function heatLegendLabels(scale: HeatScale, metric: SegmentMetric): [string, string, string] {
  if (scale.mode === 'positive') return ['0%', '中間', formatMetric(scale.extent, metric)]
  if (scale.mode === 'negative') return [formatMetric(-scale.extent, metric), '0%', '0%']
  return [formatMetric(scale.center - scale.extent, metric), formatMetric(scale.center, metric), formatMetric(scale.center + scale.extent, metric)]
}

function groupTitle(
  group: TriggerOutcomeSegmentGroup,
  rowDimension: StageDimension,
  columnDimension: StageDimension,
  horizon: TriggerOutcomeHorizon,
): string {
  const summary = horizonSummary(group, horizon)
  const row = stageLabel(String(group.keys[rowDimension] ?? 'UNKNOWN'))
  const column = stageLabel(String(group.keys[columnDimension] ?? 'UNKNOWN'))
  return [
    `${dimensionLabel(rowDimension)} ${row} / ${dimensionLabel(columnDimension)} ${column}`,
    `Event ${group.eventCount}件、銘柄 ${group.uniqueTickerCount}件、Eligible ${summary?.eligibleCount ?? 0}件`,
    `将来データ不足 ${summary?.censoredCount ?? 0}件`,
    `Median ${formatPercent(summary?.medianReturn ?? null)}、Mean ${formatPercent(summary?.meanReturn ?? null)}`,
    `プラス比率 ${formatRatio(summary?.positiveReturnRatio ?? null)}、Q25/Q75 ${formatPercent(summary?.p25Return ?? null)} / ${formatPercent(summary?.p75Return ?? null)}`,
    `MFE ${formatPercent(summary?.medianMfe ?? null)}、MAE ${formatPercent(summary?.medianMae ?? null)}`,
  ].join('。')
}

function SegmentHeatmap({
  response,
  rowDimension,
  columnDimension,
  horizon,
  metric,
  scale,
  title,
  selected,
  onSelect,
}: {
  response: TriggerOutcomeSegmentationResponse
  rowDimension: StageDimension
  columnDimension: StageDimension
  horizon: TriggerOutcomeHorizon
  metric: SegmentMetric
  scale: HeatScale
  title?: string
  selected: [string, string]
  onSelect: (values: [string, string]) => void
}) {
  const groups = useMemo(() => new Map(response.segmentation.groups.map((group) => [
    `${group.keys[rowDimension] ?? 'UNKNOWN'}|${group.keys[columnDimension] ?? 'UNKNOWN'}`,
    group,
  ])), [response, rowDimension, columnDimension])
  const buckets = TRIGGER_OUTCOME_STAGE_BUCKETS.filter((bucket) => bucket !== 'UNKNOWN' || response.segmentation.groups.some((group) =>
    group.eventCount > 0 && (group.keys[rowDimension] === 'UNKNOWN' || group.keys[columnDimension] === 'UNKNOWN')))
  const legend = heatLegendLabels(scale, metric)
  return (
    <div className="min-w-0">
      {title && <h6 className="mb-2 text-[11px] font-semibold text-[var(--color-text-primary)]">{title}</h6>}
      <div className="max-w-full overflow-x-auto pb-1">
        <div className="grid min-w-[620px] gap-1" style={{ gridTemplateColumns: `74px repeat(${buckets.length}, minmax(68px, 1fr))` }} role="grid" aria-label={`${dimensionLabel(rowDimension)}と${dimensionLabel(columnDimension)}のOutcome Heatmap`}>
          <div className="flex items-end px-1 pb-1 text-[9px] leading-4 text-[var(--color-text-tertiary)]">{dimensionLabel(rowDimension)} ↓<br />{dimensionLabel(columnDimension)} →</div>
          {buckets.map((bucket) => <div key={bucket} role="columnheader" className="flex min-h-8 items-center justify-center text-[9px] font-semibold text-[var(--color-text-secondary)]">{stageLabel(bucket)}</div>)}
          {buckets.flatMap((rowBucket) => [
            <div key={`row-${rowBucket}`} role="rowheader" className="flex min-h-[54px] items-center px-1 text-[9px] font-semibold text-[var(--color-text-secondary)]">{stageLabel(rowBucket)}</div>,
            ...buckets.map((columnBucket) => {
              const group = groups.get(`${rowBucket}|${columnBucket}`)
              const summary = group ? horizonSummary(group, horizon) : null
              const value = summary && summary.eligibleCount > 0 ? metricValue(summary, metric) : null
              const isSelected = selected[0] === rowBucket && selected[1] === columnBucket
              return (
                <button
                  key={`${rowBucket}-${columnBucket}`}
                  type="button"
                  role="gridcell"
                  title={group ? groupTitle(group, rowDimension, columnDimension, horizon) : `${rowBucket} / ${columnBucket}: N/A`}
                  aria-label={group ? groupTitle(group, rowDimension, columnDimension, horizon) : `${rowBucket} / ${columnBucket}: N/A`}
                  aria-pressed={isSelected}
                  onClick={() => onSelect([rowBucket, columnBucket])}
                  className={`relative min-h-[54px] rounded-[3px] border px-1 py-1.5 text-center outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand-500)] ${isSelected ? 'border-[var(--color-brand-800)] ring-1 ring-[var(--color-brand-700)]' : summary?.smallSample && summary.eligibleCount > 0 ? 'border-dashed border-amber-400' : 'border-[var(--color-border-soft)]'}`}
                  style={heatCellStyle(value, scale)}
                >
                  <span className="block text-[10px] font-semibold tabular-nums text-[var(--color-text-primary)]">{summary?.eligibleCount ? formatMetric(value, metric) : 'N/A'}</span>
                  <span className="mt-0.5 block text-[9px] tabular-nums text-[var(--color-text-secondary)]">n={summary?.eligibleCount.toLocaleString('ja-JP') ?? 0}</span>
                  {summary?.smallSample && summary.eligibleCount > 0 && <span className="mt-0.5 block text-[9px] font-semibold text-amber-900">n&lt;30</span>}
                </button>
              )
            }),
          ])}
        </div>
      </div>
      <div className="mt-2" aria-label="Heatmap凡例">
        <div
          className="h-2 rounded-[2px] border border-[var(--color-border-soft)]"
          style={{
            background: scale.mode === 'positive'
              ? 'linear-gradient(90deg, white, var(--color-price-up-bg), color-mix(in srgb, var(--color-price-up) 28%, white))'
              : scale.mode === 'negative'
                ? 'linear-gradient(90deg, color-mix(in srgb, var(--color-price-down) 28%, white), var(--color-price-down-bg), white)'
                : 'linear-gradient(90deg, color-mix(in srgb, var(--color-price-down) 28%, white), white 50%, color-mix(in srgb, var(--color-price-up) 28%, white))',
          }}
        />
        <div className="mt-1 flex justify-between text-[9px] tabular-nums text-[var(--color-text-tertiary)]"><span>{legend[0]}</span><span>{legend[1]}</span><span>{legend[2]}</span></div>
      </div>
    </div>
  )
}

function SegmentDetail({
  response,
  rowDimension,
  columnDimension,
  selected,
  horizon,
  label,
}: {
  response: TriggerOutcomeSegmentationResponse
  rowDimension: StageDimension
  columnDimension: StageDimension
  selected: [string, string]
  horizon: TriggerOutcomeHorizon
  label?: string
}) {
  const group = response.segmentation.groups.find((candidate) => (
    candidate.keys[rowDimension] === selected[0] && candidate.keys[columnDimension] === selected[1]
  ))
  const summary = group ? horizonSummary(group, horizon) : null
  const unavailable = !summary || summary.eligibleCount === 0
  return (
    <article className="border-l-2 border-[var(--color-border)] pl-3">
      <div className="flex flex-wrap items-center gap-2">
        {label && <strong className="text-[10px] text-[var(--color-text-primary)]">{label}</strong>}
        <span className="text-[10px] font-semibold text-[var(--color-text-primary)]">{dimensionLabel(rowDimension)} {stageLabel(selected[0])} × {dimensionLabel(columnDimension)} {stageLabel(selected[1])}</span>
        {summary?.smallSample && summary.eligibleCount > 0 && <SmallSampleIndicator />}
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-[9px] sm:grid-cols-4 xl:grid-cols-6">
        {[
          ['Event数', group?.eventCount.toLocaleString('ja-JP') ?? '0'],
          ['銘柄数', group?.uniqueTickerCount.toLocaleString('ja-JP') ?? '0'],
          ['Eligible', summary?.eligibleCount.toLocaleString('ja-JP') ?? '0'],
          ['将来不足', summary?.censoredCount.toLocaleString('ja-JP') ?? '0'],
          ['Median', unavailable ? 'N/A' : formatPercent(summary.medianReturn)],
          ['Mean', unavailable ? 'N/A' : formatPercent(summary.meanReturn)],
          ['プラス比率', unavailable ? 'N/A' : formatRatio(summary.positiveReturnRatio)],
          ['Q25', unavailable ? 'N/A' : formatPercent(summary.p25Return)],
          ['Q75', unavailable ? 'N/A' : formatPercent(summary.p75Return)],
          ['MFE', unavailable ? 'N/A' : formatPercent(summary.medianMfe)],
          ['MAE', unavailable ? 'N/A' : formatPercent(summary.medianMae)],
        ].map(([term, value]) => <div key={term}><dt className="text-[var(--color-text-tertiary)]">{term}</dt><dd className="mt-0.5 font-semibold tabular-nums text-[var(--color-text-primary)]">{value}</dd></div>)}
      </dl>
    </article>
  )
}

function ComparisonTable({
  response,
  dimension,
  horizon,
  metric,
}: {
  response: TriggerOutcomeSegmentComparisonResponse
  dimension: TriggerOutcomeSegmentDimension
  horizon: TriggerOutcomeHorizon
  metric: SegmentMetric
}) {
  const rightGroups = new Map(response.right.segmentation.groups.map((group) => [String(group.keys[dimension] ?? 'UNKNOWN'), group]))
  const leftLabel = sourceLabel(response.left.meta.source)
  const rightLabel = sourceLabel(response.right.meta.source)
  return (
    <div className="overflow-x-auto border-y border-[var(--color-border)]">
      <table className="w-full min-w-[980px] border-collapse text-[10px]">
        <thead className="bg-[var(--color-surface-muted)] text-[var(--color-text-secondary)]"><tr className="border-b border-[var(--color-border)]"><th className="px-3 py-2 text-left">{dimension === 'scoreBand' ? 'Score帯' : dimensionLabel(dimension as StageDimension)}</th><th className="px-2 py-2 text-right">{leftLabel}<br />{METRIC_OPTIONS.find((option) => option.value === metric)?.shortLabel}</th><th className="px-2 py-2 text-right">{rightLabel}<br />{METRIC_OPTIONS.find((option) => option.value === metric)?.shortLabel}</th><th className="px-2 py-2 text-right">差</th><th className="px-2 py-2 text-right">左 Event / 銘柄 / Eligible</th><th className="px-3 py-2 text-right">右 Event / 銘柄 / Eligible</th></tr></thead>
        <tbody>
          {response.left.segmentation.groups.map((leftGroup) => {
            const key = String(leftGroup.keys[dimension] ?? 'UNKNOWN')
            const rightGroup = rightGroups.get(key)
            const leftSummary = horizonSummary(leftGroup, horizon)
            const rightSummary = rightGroup ? horizonSummary(rightGroup, horizon) : null
            const leftValue = leftSummary && leftSummary.eligibleCount > 0 ? metricValue(leftSummary, metric) : null
            const rightValue = rightSummary && rightSummary.eligibleCount > 0 ? metricValue(rightSummary, metric) : null
            return (
              <tr key={key} className="border-b border-[var(--color-border-soft)] bg-white last:border-b-0">
                <th className="px-3 py-2.5 text-left font-medium"><SegmentLabel value={key} dimension={dimension} /></th>
                <td className="px-2 py-2.5 text-right font-semibold tabular-nums">{formatMetric(leftValue, metric)} {leftSummary?.smallSample && leftSummary.eligibleCount > 0 && <SmallSampleIndicator />}</td>
                <td className="px-2 py-2.5 text-right font-semibold tabular-nums">{formatMetric(rightValue, metric)} {rightSummary?.smallSample && rightSummary.eligibleCount > 0 && <SmallSampleIndicator />}</td>
                <td className="px-2 py-2.5 text-right tabular-nums text-[var(--color-text-secondary)]">{formatDifference(leftValue, rightValue)}</td>
                <td className="px-2 py-2.5 text-right tabular-nums">{leftGroup.eventCount.toLocaleString('ja-JP')} / {leftGroup.uniqueTickerCount.toLocaleString('ja-JP')} / {leftSummary?.eligibleCount.toLocaleString('ja-JP') ?? '0'}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{rightGroup?.eventCount.toLocaleString('ja-JP') ?? '0'} / {rightGroup?.uniqueTickerCount.toLocaleString('ja-JP') ?? '0'} / {rightSummary?.eligibleCount.toLocaleString('ja-JP') ?? '0'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function OverallComparisonTable({ response, horizon }: { response: TriggerOutcomeSegmentComparisonResponse; horizon: TriggerOutcomeHorizon }) {
  const left = response.left.overall
  const right = response.right.overall
  const leftSummary = left.horizons.find((item) => item.horizonSessions === horizon)
  const rightSummary = right.horizons.find((item) => item.horizonSessions === horizon)
  const leftEligible = leftSummary?.eligibleCount ?? 0
  const rightEligible = rightSummary?.eligibleCount ?? 0
  const rows: Array<[string, string, string]> = [
    ['Event', left.selectedEventCount.toLocaleString('ja-JP'), right.selectedEventCount.toLocaleString('ja-JP')],
    ['銘柄', left.uniqueTickerCount.toLocaleString('ja-JP'), right.uniqueTickerCount.toLocaleString('ja-JP')],
    ['Eligible / Event', `${leftEligible.toLocaleString('ja-JP')} / ${left.selectedEventCount.toLocaleString('ja-JP')}`, `${rightEligible.toLocaleString('ja-JP')} / ${right.selectedEventCount.toLocaleString('ja-JP')}`],
    ['将来データ不足', leftSummary?.censoredCount.toLocaleString('ja-JP') ?? '0', rightSummary?.censoredCount.toLocaleString('ja-JP') ?? '0'],
    ['Median', leftEligible ? formatPercent(leftSummary!.medianReturn) : 'N/A', rightEligible ? formatPercent(rightSummary!.medianReturn) : 'N/A'],
    ['プラス比率', leftEligible ? formatRatio(leftSummary!.positiveReturnRatio) : 'N/A', rightEligible ? formatRatio(rightSummary!.positiveReturnRatio) : 'N/A'],
    ['Q25', leftEligible ? formatPercent(leftSummary!.p25Return) : 'N/A', rightEligible ? formatPercent(rightSummary!.p25Return) : 'N/A'],
    ['Q75', leftEligible ? formatPercent(leftSummary!.p75Return) : 'N/A', rightEligible ? formatPercent(rightSummary!.p75Return) : 'N/A'],
    ['MFE', leftEligible ? formatPercent(leftSummary!.medianMfe) : 'N/A', rightEligible ? formatPercent(rightSummary!.medianMfe) : 'N/A'],
    ['MAE', leftEligible ? formatPercent(leftSummary!.medianMae) : 'N/A', rightEligible ? formatPercent(rightSummary!.medianMae) : 'N/A'],
  ]
  return (
    <div className="max-w-full overflow-x-auto border-y border-[var(--color-border)]">
      <table className="w-full min-w-[560px] border-collapse text-[10px]">
        <thead><tr className="bg-[var(--color-surface-muted)] text-[var(--color-text-secondary)]"><th className="px-3 py-2 text-left">{HORIZON_LABELS[horizon]}後</th><th className="px-3 py-2 text-right">左: {sourceLabel(response.left.meta.source)}</th><th className="px-3 py-2 text-right">右: {sourceLabel(response.right.meta.source)}</th></tr></thead>
        <tbody>{rows.map(([label, leftValue, rightValue]) => <tr key={label} className="border-t border-[var(--color-border-soft)]"><th className="px-3 py-2 text-left font-medium text-[var(--color-text-secondary)]">{label}</th><td className="px-3 py-2 text-right tabular-nums">{leftValue}</td><td className="px-3 py-2 text-right tabular-nums">{rightValue}</td></tr>)}</tbody>
      </table>
    </div>
  )
}

function CompatibilitySummary({ response }: { response: TriggerOutcomeSegmentComparisonResponse }) {
  const labels: Record<string, string> = {
    timeframe: '時間軸', maPeriods: 'MA期間', requestedScanPeriod: '指定期間', resolvedScanPeriod: '取引日期間', marketFilters: '市場', priceFilters: '価格', liquidityFilters: '流動性', triggerFilters: 'Trigger条件', stageFilters: 'Stage条件', eventSelector: 'Event種類', scoreFilters: 'Score条件', horizons: '表示期間', analysisCutoffDate: '分析可能日',
  }
  return (
    <div className="border-l-2 border-[var(--color-brand-500)] bg-[var(--color-surface-subtle)] px-3 py-2 text-[9px] leading-5 text-[var(--color-text-secondary)]">
      {response.analysisType === 'OPERATIONAL_SCAN_COMPARISON' && <p className="font-semibold text-[var(--color-text-primary)]">OPERATIONAL_SCAN_COMPARISON：別Scanの運用比較。Candidate集合・Event日も異なり得ます。</p>}
      <div className="flex flex-wrap gap-x-5 gap-y-1">
        <span><strong className="text-[var(--color-text-primary)]">左:</strong> {sourceLabel(response.left.meta.source)} / {SELECTOR_LABELS[response.left.meta.source.eventSelector] ?? response.left.meta.source.eventSelector}</span>
        <span><strong className="text-[var(--color-text-primary)]">右:</strong> {sourceLabel(response.right.meta.source)} / {SELECTOR_LABELS[response.right.meta.source.eventSelector] ?? response.right.meta.source.eventSelector}</span>
      </div>
      <p>相違: {response.compatibility.differences.length ? response.compatibility.differences.map((difference) => labels[difference] ?? difference).join(' / ') : 'なし'}</p>
      {response.compatibility.differences.length > 0 && <p className="text-amber-900">同条件比較ではありません。条件差を確認してから数値を読んでください。</p>}
      <p className="text-[var(--color-text-tertiary)]">この比較は統計的に独立したRandomized comparisonではありません。数値と母数を並べて確認してください。</p>
      {response.analysisType === 'OPERATIONAL_SCAN_COMPARISON' && (() => {
        const left = response.left.meta.source
        const right = response.right.meta.source
        const matchingExceptSpread = response.compatibility.differences.length === 1
          && response.compatibility.differences[0] === 'triggerFilters'
          && left.filters.triggerCore.spreadExpansionEnabled !== right.filters.triggerCore.spreadExpansionEnabled
          && left.filters.triggerCore.spreadLookbackIntervals === right.filters.triggerCore.spreadLookbackIntervals
          && left.filters.triggerCore.minExpansionRatio === right.filters.triggerCore.minExpansionRatio
          && left.filters.triggerCore.requireBullishMaOrder === right.filters.triggerCore.requireBullishMaOrder
        if (!matchingExceptSpread) return <p>MA間隔拡大以外にも条件差があります。候補削減率は表示しません。</p>
        const off = left.filters.triggerCore.spreadExpansionEnabled ? response.right : response.left
        const on = left.filters.triggerCore.spreadExpansionEnabled ? response.left : response.right
        const offCandidates = off.meta.source.scanCounts.uniqueCandidates
        const onCandidates = on.meta.source.scanCounts.uniqueCandidates
        return <p>MA間隔拡大 OFF → ON：候補銘柄 {offCandidates.toLocaleString('ja-JP')} → {onCandidates.toLocaleString('ja-JP')}件{offCandidates > 0 ? `（${((offCandidates - onCandidates) / offCandidates * 100).toFixed(1)}%減）` : ''} / {SELECTOR_LABELS[off.meta.source.eventSelector] ?? off.meta.source.eventSelector} Event {off.overall.selectedEventCount.toLocaleString('ja-JP')} → {on.overall.selectedEventCount.toLocaleString('ja-JP')}件。これは改善率ではありません。</p>
      })()}
    </div>
  )
}

export function OutcomeSegmentationPanel({
  scanResult,
  primarySelector,
  primaryOutcomeJob,
  nearOutcomeJob,
  zoneOutcomeJob,
  horizon,
  onHorizonChange,
}: Props) {
  const [expanded, setExpanded] = useState(false)
  const [tab, setTab] = useState<SegmentTab>('score')
  const [spreadView, setSpreadView] = useState<'ALL' | 'PASS' | 'FAIL'>('ALL')
  const [metric, setMetric] = useState<SegmentMetric>('medianReturn')
  const [stageDimension, setStageDimension] = useState<StageDimension>('stage:monthA')
  const [rowDimension, setRowDimension] = useState<StageDimension>('stage:weekA')
  const [columnDimension, setColumnDimension] = useState<StageDimension>('stage:monthA')
  const [selectedCell, setSelectedCell] = useState<[string, string]>(['S1', 'S1'])
  const [segmentData, setSegmentData] = useState<TriggerOutcomeSegmentationResponse | null>(null)
  const [segmentLoading, setSegmentLoading] = useState(false)
  const [segmentError, setSegmentError] = useState<string | null>(null)
  const [comparisonKind, setComparisonKind] = useState<ComparisonKind>('event')
  const [comparisonView, setComparisonView] = useState<ComparisonView>('score')
  const [comparisonData, setComparisonData] = useState<TriggerOutcomeSegmentComparisonResponse | null>(null)
  const [comparisonLoading, setComparisonLoading] = useState(false)
  const [comparisonError, setComparisonError] = useState<string | null>(null)
  const [recentOutcomeJobs, setRecentOutcomeJobs] = useState<TriggerOutcomeRecentJob[]>([])
  const [recentJobsLoaded, setRecentJobsLoaded] = useState(false)
  const [recentJobsLoading, setRecentJobsLoading] = useState(false)
  const [selectedComparisonJobId, setSelectedComparisonJobId] = useState('')
  const segmentCache = useRef(new Map<string, TriggerOutcomeSegmentationResponse>())
  const comparisonCache = useRef(new Map<string, TriggerOutcomeSegmentComparisonResponse>())
  const segmentSequence = useRef(0)
  const comparisonSequence = useRef(0)

  const dimensions = useMemo<TriggerOutcomeSegmentDimension[]>(() => {
    if (tab === 'score') return ['scoreBand']
    if (tab === 'spread') return ['spreadExpansion']
    if (tab === 'stage') return [stageDimension]
    if (tab === 'robustness') return []
    return [rowDimension, columnDimension]
  }, [tab, stageDimension, rowDimension, columnDimension])
  const dimensionKey = dimensions.join(',')
  const visibleSegmentData = segmentData?.segmentation.dimensions.join(',') === dimensionKey
    && segmentData.meta.source.outcomeJobId === primaryOutcomeJob.jobId
    ? segmentData
    : null

  useEffect(() => {
    if (!expanded || tab === 'compare' || tab === 'robustness' || primaryOutcomeJob.status !== 'COMPLETED' || !primaryOutcomeJob.resultAvailable) return
    const cacheKey = `${primaryOutcomeJob.jobId}|${dimensionKey}`
    const cached = segmentCache.current.get(cacheKey)
    if (cached) {
      setSegmentData(cached)
      setSegmentError(null)
      setSegmentLoading(false)
      return
    }
    const controller = new AbortController()
    const sequence = ++segmentSequence.current
    setSegmentLoading(true)
    setSegmentError(null)
    const params = new URLSearchParams()
    dimensions.forEach((dimension) => params.append('dimension', dimension))
    void fetch(`/api/trigger-discovery/outcome-jobs/${primaryOutcomeJob.jobId}/segments?${params}`, {
      cache: 'no-store', signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error(await apiErrorMessage(response, '条件別Outcomeを取得できませんでした。'))
      return response.json() as Promise<TriggerOutcomeSegmentationResponse>
    }).then((body) => {
      if (controller.signal.aborted || sequence !== segmentSequence.current) return
      segmentCache.current.set(cacheKey, body)
      setSegmentData(body)
    }).catch((error) => {
      if (!controller.signal.aborted && sequence === segmentSequence.current) setSegmentError(error instanceof Error ? error.message : '条件別Outcomeを取得できませんでした。')
    }).finally(() => {
      if (!controller.signal.aborted && sequence === segmentSequence.current) setSegmentLoading(false)
    })
    return () => controller.abort()
  }, [expanded, tab, primaryOutcomeJob.jobId, primaryOutcomeJob.status, primaryOutcomeJob.resultAvailable, dimensionKey])

  useEffect(() => {
    if (!expanded || tab !== 'compare' || comparisonKind !== 'source' || recentJobsLoaded) return
    const controller = new AbortController()
    setRecentJobsLoading(true)
    void fetch('/api/trigger-discovery/outcome-jobs/recent', { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await apiErrorMessage(response, '保存済みOutcome履歴を取得できませんでした。'))
        return response.json() as Promise<TriggerOutcomeRecentJobListResponse>
      })
      .then((body) => {
        if (!controller.signal.aborted) {
          setRecentOutcomeJobs(body.jobs)
          setRecentJobsLoaded(true)
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) setComparisonError(error instanceof Error ? error.message : '保存済みOutcome履歴を取得できませんでした。')
      })
      .finally(() => {
        if (!controller.signal.aborted) setRecentJobsLoading(false)
      })
    return () => controller.abort()
  }, [expanded, tab, comparisonKind, recentJobsLoaded])

  const comparisonDimensions = useMemo<TriggerOutcomeSegmentDimension[]>(() => (
    comparisonView === 'score' ? ['scoreBand'] : comparisonView === 'stage' ? [stageDimension] : [rowDimension, columnDimension]
  ), [comparisonView, stageDimension, rowDimension, columnDimension])
  const comparisonDimensionKey = comparisonDimensions.join(',')
  const eventLeftId = nearOutcomeJob?.status === 'COMPLETED' && nearOutcomeJob.resultAvailable ? nearOutcomeJob.jobId : ''
  const eventRightId = zoneOutcomeJob?.status === 'COMPLETED' && zoneOutcomeJob.resultAvailable ? zoneOutcomeJob.jobId : ''
  const sourceRightId = recentOutcomeJobs.some((job) => job.jobId === selectedComparisonJobId) ? selectedComparisonJobId : ''
  const comparisonLeftId = comparisonKind === 'event' ? eventLeftId : primaryOutcomeJob.jobId
  const comparisonRightId = comparisonKind === 'event' ? eventRightId : sourceRightId
  const visibleComparisonData = comparisonData?.dimensions.join(',') === comparisonDimensionKey
    && comparisonData.left.meta.source.outcomeJobId === comparisonLeftId
    && comparisonData.right.meta.source.outcomeJobId === comparisonRightId
    ? comparisonData
    : null

  useEffect(() => {
    if (!expanded || tab !== 'compare' || !comparisonLeftId || !comparisonRightId) return
    const cacheKey = `${comparisonLeftId}|${comparisonRightId}|${comparisonDimensionKey}`
    const cached = comparisonCache.current.get(cacheKey)
    if (cached) {
      setComparisonData(cached)
      setComparisonError(null)
      setComparisonLoading(false)
      return
    }
    const controller = new AbortController()
    const sequence = ++comparisonSequence.current
    setComparisonLoading(true)
    setComparisonError(null)
    void fetch('/api/trigger-discovery/outcome-segment-comparisons', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leftOutcomeJobId: comparisonLeftId, rightOutcomeJobId: comparisonRightId, dimensions: comparisonDimensions }),
      cache: 'no-store',
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error(await apiErrorMessage(response, '条件別比較を取得できませんでした。'))
      return response.json() as Promise<TriggerOutcomeSegmentComparisonResponse>
    }).then((body) => {
      if (controller.signal.aborted || sequence !== comparisonSequence.current) return
      comparisonCache.current.set(cacheKey, body)
      setComparisonData(body)
    }).catch((error) => {
      if (!controller.signal.aborted && sequence === comparisonSequence.current) setComparisonError(error instanceof Error ? error.message : '条件別比較を取得できませんでした。')
    }).finally(() => {
      if (!controller.signal.aborted && sequence === comparisonSequence.current) setComparisonLoading(false)
    })
    return () => controller.abort()
  }, [expanded, tab, comparisonLeftId, comparisonRightId, comparisonDimensionKey])

  const candidateJobs = useMemo(() => recentOutcomeJobs
    .filter((job) => job.jobId !== primaryOutcomeJob.jobId)
    .sort((left, right) => {
      const leftOpposite = left.timeframe !== scanResult.scanMeta.timeframe ? 1 : 0
      const rightOpposite = right.timeframe !== scanResult.scanMeta.timeframe ? 1 : 0
      if (leftOpposite !== rightOpposite) return rightOpposite - leftOpposite
      return right.completedAt.localeCompare(left.completedAt)
    }), [recentOutcomeJobs, primaryOutcomeJob.jobId, scanResult.scanMeta.timeframe])
  const selectedComparisonJob = candidateJobs.find((job) => job.jobId === selectedComparisonJobId) ?? null

  const sourceSummary = visibleSegmentData?.meta.source
    ? [sourceLabel(visibleSegmentData.meta.source), SELECTOR_LABELS[visibleSegmentData.meta.source.eventSelector] ?? visibleSegmentData.meta.source.eventSelector, `${visibleSegmentData.meta.source.scanPeriod.resolvedStartDate ?? visibleSegmentData.meta.source.scanPeriod.requestedStartDate}〜${visibleSegmentData.meta.source.scanPeriod.resolvedEndDate ?? visibleSegmentData.meta.source.scanPeriod.requestedEndDate}`, `分析可能データ ${visibleSegmentData.meta.source.analysisCutoffDate}まで`]
    : sourceSummaryFromScan(scanResult, primarySelector, primaryOutcomeJob.analysisCutoffDate)
  const sourceFilters = visibleSegmentData?.meta.source.filters
  const sourceFilterLabels = sourceFilters ? [
    sourceFilters.markets?.length ? `市場 ${sourceFilters.markets.map((market) => market ?? '不明').join(' / ')}` : null,
    sourceFilters.outcomeScore.min != null || sourceFilters.outcomeScore.max != null
      ? `Score ${sourceFilters.outcomeScore.min ?? 0}〜${sourceFilters.outcomeScore.max ?? 100}` : null,
    Object.keys(sourceFilters.outcomeStage).length ? 'Outcome Stage条件あり' : null,
    Object.keys(sourceFilters.historicalStage).length ? 'Scan Stage条件あり' : null,
    sourceFilters.triggerCore.spreadExpansionEnabled ? 'MA間隔拡大 ON' : null,
    sourceFilters.outcomeTicker ? `銘柄 ${sourceFilters.outcomeTicker}` : null,
  ].filter((item): item is string => item !== null) : []

  const pairScale = visibleSegmentData ? heatScale([visibleSegmentData], horizon, metric) : null
  const compareScale = visibleComparisonData ? heatScale([visibleComparisonData.left, visibleComparisonData.right], horizon, metric) : null

  const selectTab = (nextTab: SegmentTab) => {
    setTab(nextTab)
    setSegmentError(null)
    setComparisonError(null)
    setComparisonLoading(false)
  }

  return (
    <section aria-labelledby="outcome-segmentation-heading" className="border-t border-[var(--color-border)] pt-4">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls="outcome-segmentation-content"
        onClick={() => setExpanded((current) => !current)}
        className="group flex w-full items-start justify-between gap-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand-200)]"
      >
        <span>
          <span id="outcome-segmentation-heading" className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-[var(--color-text-primary)]"><Scale size={14} aria-hidden />条件別に見る</span>
          <span className="mt-0.5 block text-[9px] leading-5 text-[var(--color-text-tertiary)]">Trigger発生時のScore・MA間隔・Stageごとに、その後の値動きを分解して確認します。</span>
        </span>
        <ChevronDown size={15} className={`mt-1 shrink-0 text-[var(--color-text-tertiary)] transition-transform ${expanded ? 'rotate-180' : ''}`} aria-hidden />
      </button>

      {expanded && (
        <div id="outcome-segmentation-content" className="mt-4">
          <div className="flex flex-wrap gap-x-5 gap-y-1 border-l-2 border-[var(--color-border)] pl-3 text-[9px] text-[var(--color-text-secondary)]">
            {sourceSummary.map((item) => <span key={item}>{item}</span>)}
            {visibleSegmentData && <span>Event {visibleSegmentData.overall.selectedEventCount.toLocaleString('ja-JP')}件 / {visibleSegmentData.overall.uniqueTickerCount.toLocaleString('ja-JP')}銘柄</span>}
            <MethodHelp kind="events" />
          </div>
          {sourceFilterLabels.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5" aria-label="元Outcomeの条件">{sourceFilterLabels.map((label) => <span key={label} className="rounded-[3px] bg-[var(--color-surface-muted)] px-2 py-1 text-[9px] text-[var(--color-text-secondary)]">{label}</span>)}</div>}
          <p className="mt-2 text-[9px] leading-5 text-[var(--color-text-secondary)]">Historical Trigger Eventの記述統計です。Triggerの良し悪しや将来リターンを保証しません。同一銘柄の複数Eventは完全に独立した観測ではありません。各期間の将来価格が揃わないEventは、その期間のEligibleから除外します。</p>

          <div className="mt-3 flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <div
              role="tablist"
              aria-label="条件別Outcome分析"
              className="flex max-w-full gap-1 overflow-x-auto pb-1"
              onKeyDown={(event) => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
                event.preventDefault()
                const currentIndex = SEGMENT_TABS.findIndex((option) => option.value === tab)
                const offset = event.key === 'ArrowRight' ? 1 : -1
                const next = SEGMENT_TABS[(currentIndex + offset + SEGMENT_TABS.length) % SEGMENT_TABS.length]!
                selectTab(next.value)
                document.getElementById(`outcome-segment-tab-${next.value}`)?.focus()
              }}
            >
              {SEGMENT_TABS.map((option) => <button key={option.value} id={`outcome-segment-tab-${option.value}`} type="button" role="tab" aria-selected={tab === option.value} onClick={() => selectTab(option.value)} className={`h-8 shrink-0 rounded-[3px] border px-3 text-[10px] font-medium ${tab === option.value ? 'border-[var(--color-brand-700)] bg-[var(--color-brand-700)] text-white' : 'border-[var(--color-border)] bg-white text-[var(--color-text-secondary)]'}`}>{option.label}</button>)}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex max-w-full gap-1 overflow-x-auto pb-1" aria-label="条件別Outcome表示期間">
                {TRIGGER_OUTCOME_HORIZONS.map((value) => <button key={value} type="button" aria-pressed={horizon === value} onClick={() => onHorizonChange(value)} className={`h-8 shrink-0 rounded-[3px] border px-2.5 text-[10px] font-medium ${horizon === value ? 'border-[var(--color-brand-700)] bg-[var(--color-brand-700)] text-white' : 'border-[var(--color-border)] bg-white text-[var(--color-text-secondary)]'}`}>{HORIZON_LABELS[value]}</button>)}
              </div>
              <label className="inline-flex h-8 items-center gap-1.5 text-[9px] text-[var(--color-text-secondary)]">表示指標
                <select value={metric} onChange={(event) => setMetric(event.target.value as SegmentMetric)} className="h-8 rounded-[3px] border border-[var(--color-border)] bg-white px-2 text-[10px]">
                  {METRIC_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
            </div>
          </div>

          {tab === 'score' && <div className="mt-3 flex items-center gap-1 text-[9px] text-[var(--color-text-secondary)]"><MethodHelp kind="score" /><span>ScoreはTrigger条件への適合度であり、その後のリターン評価ではありません。</span></div>}
          {tab === 'spread' && <div className="mt-3 space-y-2 text-[10px] leading-5 text-[var(--color-text-secondary)]">
            <p><strong className="text-[var(--color-text-primary)]">同一Event集合の比較</strong>。Event日・基準価格・Scoreを固定し、当日のMA間隔拡大条件で分けています。判定不能は条件なしに混ぜません。</p>
            {scanResult.criteria.spreadExpansionEnabled && <p className="text-amber-900">元ScanがMA間隔拡大ONのため、条件なしのEventは原則含まれません。同条件のOFF Scanで分析すると両群を比較できます。</p>}
            <div className="flex gap-1" aria-label="MA間隔拡大グループ">
              {([['ALL', 'すべて'], ['PASS', '拡大条件あり'], ['FAIL', '拡大条件なし']] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={spreadView === value} onClick={() => setSpreadView(value)} className={`h-8 rounded-[3px] border px-2.5 text-[10px] ${spreadView === value ? 'border-[var(--color-brand-700)] bg-[var(--color-brand-50)] font-semibold text-[var(--color-brand-800)]' : 'border-[var(--color-border)] bg-white'}`}>{label}</button>)}
            </div>
          </div>}
          {(tab === 'stage' || tab === 'pair') && <div className="mt-3 flex items-center gap-1 text-[9px] text-[var(--color-text-secondary)]"><MethodHelp kind="stage" /><span>S1〜S6は強弱順位ではなく、循環的な相場構造です。</span></div>}

          {tab === 'stage' && (
            <label className="mt-3 inline-flex h-8 items-center gap-2 text-[10px] text-[var(--color-text-secondary)]">Stage軸
              <select value={stageDimension} onChange={(event) => setStageDimension(event.target.value as StageDimension)} className="h-8 rounded-[3px] border border-[var(--color-border)] bg-white px-2 text-[10px]">{STAGE_DIMENSIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
            </label>
          )}

          {(tab === 'pair' || (tab === 'compare' && comparisonView === 'pair')) && (
            <div className="mt-3 flex flex-wrap items-center gap-3 text-[10px] text-[var(--color-text-secondary)]">
              <label>縦軸 <select value={rowDimension} onChange={(event) => setRowDimension(event.target.value as StageDimension)} className="ml-1 h-8 rounded-[3px] border border-[var(--color-border)] bg-white px-2 text-[10px]">{STAGE_DIMENSIONS.map((option) => <option key={option.value} value={option.value} disabled={option.value === columnDimension}>{option.label}</option>)}</select></label>
              <label>横軸 <select value={columnDimension} onChange={(event) => setColumnDimension(event.target.value as StageDimension)} className="ml-1 h-8 rounded-[3px] border border-[var(--color-border)] bg-white px-2 text-[10px]">{STAGE_DIMENSIONS.map((option) => <option key={option.value} value={option.value} disabled={option.value === rowDimension}>{option.label}</option>)}</select></label>
            </div>
          )}

          {segmentError && tab !== 'compare' && <div role="alert" className="mt-3 border-l-2 border-red-500 bg-red-50 px-3 py-2 text-[10px] text-red-800">{segmentError}</div>}
          {segmentLoading && tab !== 'compare' && <div role="status" className="mt-4 inline-flex items-center gap-2 text-[10px] text-[var(--color-brand-700)]"><LoaderCircle size={13} className="animate-spin" aria-hidden />条件別データを集計しています…</div>}

          {!segmentLoading && visibleSegmentData && tab === 'score' && <div className="mt-3"><ScoreBandCards response={visibleSegmentData} horizon={horizon} /></div>}
          {!segmentLoading && visibleSegmentData && tab === 'spread' && (visibleSegmentData.meta.spreadDiagnosticsStatus === 'SPREAD_DIAGNOSTICS_UNAVAILABLE'
            ? <p role="status" className="mt-3 border-l-2 border-amber-400 bg-amber-50 px-3 py-2 text-[10px] text-amber-900">SPREAD_DIAGNOSTICS_UNAVAILABLE：この保存済みOutcomeに当時のMA診断値はありません。元の期間検証から再実行してください。現在データで補完しません。</p>
            : <div className="mt-3">{visibleSegmentData.meta.spreadDiagnosticsStatus === 'PARTIAL' && <p className="mb-2 text-[10px] text-amber-900">一部の保存済みEventに診断値がありません。補完せずUNKNOWNに含めています。</p>}<p className="mb-2 text-[9px] text-[var(--color-text-tertiary)]">PASS + FAIL + UNKNOWN = {visibleSegmentData.overall.selectedEventCount.toLocaleString('ja-JP')} Event。Eligible 30件未満は参考値です。</p><SegmentTable response={visibleSegmentData} dimension="spreadExpansion" horizon={horizon} selectedMetric={metric} visibleSpreadBucket={spreadView} /></div>)}
          {!segmentLoading && visibleSegmentData && tab === 'stage' && <div className="mt-3"><SegmentTable response={visibleSegmentData} dimension={stageDimension} horizon={horizon} selectedMetric={metric} /></div>}
          {!segmentLoading && visibleSegmentData && tab === 'pair' && pairScale && (
            <div className="mt-3 space-y-4">
              <SegmentHeatmap response={visibleSegmentData} rowDimension={rowDimension} columnDimension={columnDimension} horizon={horizon} metric={metric} scale={pairScale} selected={selectedCell} onSelect={setSelectedCell} />
              <SegmentDetail response={visibleSegmentData} rowDimension={rowDimension} columnDimension={columnDimension} selected={selectedCell} horizon={horizon} />
            </div>
          )}

          <OutcomeRobustnessPanel
            active={expanded && tab === 'robustness'}
            outcomeJobId={primaryOutcomeJob.jobId}
            horizon={horizon}
            onHorizonChange={onHorizonChange}
          />

          {tab === 'compare' && (
            <div className="mt-3">
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex gap-1" aria-label="比較対象">
                  <button type="button" aria-pressed={comparisonKind === 'event'} onClick={() => { setComparisonKind('event'); setComparisonData(null); setComparisonError(null); setComparisonLoading(false) }} className={`h-8 rounded-[3px] border px-2.5 text-[10px] ${comparisonKind === 'event' ? 'border-[var(--color-brand-700)] bg-[var(--color-brand-50)] font-semibold text-[var(--color-brand-800)]' : 'border-[var(--color-border)] bg-white text-[var(--color-text-secondary)]'}`}>NEAR入り vs Zone入り</button>
                  <button type="button" aria-pressed={comparisonKind === 'source'} onClick={() => { setComparisonKind('source'); setComparisonData(null); setComparisonError(null); setComparisonLoading(false) }} className={`h-8 rounded-[3px] border px-2.5 text-[10px] ${comparisonKind === 'source' ? 'border-[var(--color-brand-700)] bg-[var(--color-brand-50)] font-semibold text-[var(--color-brand-800)]' : 'border-[var(--color-border)] bg-white text-[var(--color-text-secondary)]'}`}>別の期間・時間軸</button>
                </div>
                <label className="inline-flex h-8 items-center gap-1.5 text-[9px] text-[var(--color-text-secondary)]">比較軸
                  <select value={comparisonView} onChange={(event) => setComparisonView(event.target.value as ComparisonView)} className="h-8 rounded-[3px] border border-[var(--color-border)] bg-white px-2 text-[10px]"><option value="score">Score帯</option><option value="stage">Stage別</option><option value="pair">Stage組み合わせ</option></select>
                </label>
                {comparisonView === 'stage' && <label className="inline-flex h-8 items-center gap-1.5 text-[9px] text-[var(--color-text-secondary)]">Stage軸<select value={stageDimension} onChange={(event) => setStageDimension(event.target.value as StageDimension)} className="h-8 rounded-[3px] border border-[var(--color-border)] bg-white px-2 text-[10px]">{STAGE_DIMENSIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>}
              </div>

              {comparisonKind === 'event' && (!eventLeftId || !eventRightId) && <p className="mt-3 border-l-2 border-amber-400 bg-amber-50 px-3 py-2 text-[10px] text-amber-900">NEAR入りとTrigger Zone入りの両方を分析すると、条件別に比較できます。</p>}

              {comparisonKind === 'source' && (
                <div className="mt-3 border-y border-[var(--color-border-soft)] py-3">
                  <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] lg:items-end">
                    <div className="text-[9px] leading-5 text-[var(--color-text-secondary)]"><strong className="block text-[10px] text-[var(--color-text-primary)]">比較元</strong>{sourceSummaryFromScan(scanResult, primarySelector, primaryOutcomeJob.analysisCutoffDate).join(' / ')}</div>
                    <label className="text-[9px] text-[var(--color-text-secondary)]">比較先の保存済みOutcome
                      <select value={selectedComparisonJobId} onChange={(event) => { setSelectedComparisonJobId(event.target.value); setComparisonData(null); setComparisonLoading(false); setComparisonError(null) }} className="mt-1 block h-9 w-full rounded-[3px] border border-[var(--color-border)] bg-white px-2 text-[10px]">
                        <option value="">選択してください</option>
                        {candidateJobs.map((job) => <option key={job.jobId} value={job.jobId}>{recentOutcomeLabel(job)}｜完了 {job.completedAt.slice(0, 10)}</option>)}
                      </select>
                    </label>
                  </div>
                  {recentJobsLoading && <p role="status" className="mt-2 inline-flex items-center gap-1 text-[9px] text-[var(--color-text-secondary)]"><LoaderCircle size={11} className="animate-spin" />保存済みOutcomeを読み込み中</p>}
                  {recentJobsLoaded && candidateJobs.length === 0 && <p className="mt-2 text-[9px] text-[var(--color-text-secondary)]">比較できる別の保存済みOutcomeがありません。比較のために新しい分析は開始しません。</p>}
                  {selectedComparisonJob && <p className="mt-2 text-[9px] leading-5 text-[var(--color-text-secondary)]">比較先: {recentOutcomeLabel(selectedComparisonJob)}</p>}
                </div>
              )}

              {comparisonError && <div role="alert" className="mt-3 border-l-2 border-red-500 bg-red-50 px-3 py-2 text-[10px] text-red-800">{comparisonError}</div>}
              {comparisonLoading && <div role="status" className="mt-4 inline-flex items-center gap-2 text-[10px] text-[var(--color-brand-700)]"><LoaderCircle size={13} className="animate-spin" aria-hidden />条件別比較を読み込み中</div>}
              {!comparisonLoading && visibleComparisonData && (
                <div className="mt-3 space-y-4">
                  <CompatibilitySummary response={visibleComparisonData} />
                  <OverallComparisonTable response={visibleComparisonData} horizon={horizon} />
                  {comparisonView !== 'pair' ? (
                    <ComparisonTable response={visibleComparisonData} dimension={comparisonView === 'score' ? 'scoreBand' : stageDimension} horizon={horizon} metric={metric} />
                  ) : compareScale ? (
                    <>
                      <div className="grid gap-5 xl:grid-cols-2">
                        <SegmentHeatmap title={`${sourceLabel(visibleComparisonData.left.meta.source)} / ${SELECTOR_LABELS[visibleComparisonData.left.meta.source.eventSelector] ?? visibleComparisonData.left.meta.source.eventSelector}`} response={visibleComparisonData.left} rowDimension={rowDimension} columnDimension={columnDimension} horizon={horizon} metric={metric} scale={compareScale} selected={selectedCell} onSelect={setSelectedCell} />
                        <SegmentHeatmap title={`${sourceLabel(visibleComparisonData.right.meta.source)} / ${SELECTOR_LABELS[visibleComparisonData.right.meta.source.eventSelector] ?? visibleComparisonData.right.meta.source.eventSelector}`} response={visibleComparisonData.right} rowDimension={rowDimension} columnDimension={columnDimension} horizon={horizon} metric={metric} scale={compareScale} selected={selectedCell} onSelect={setSelectedCell} />
                      </div>
                      <div className="grid gap-4 xl:grid-cols-2">
                        <SegmentDetail label="左" response={visibleComparisonData.left} rowDimension={rowDimension} columnDimension={columnDimension} selected={selectedCell} horizon={horizon} />
                        <SegmentDetail label="右" response={visibleComparisonData.right} rowDimension={rowDimension} columnDimension={columnDimension} selected={selectedCell} horizon={horizon} />
                      </div>
                    </>
                  ) : null}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
