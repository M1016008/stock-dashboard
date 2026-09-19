'use client'

import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, CircleHelp, LoaderCircle } from 'lucide-react'
import {
  CartesianGrid,
  Line,
  LineChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { MeasuredChartFrame } from '@/components/charts/MeasuredChartFrame'
import { DataPopover } from '@/components/shared/DataPopover'
import { StageTag } from '@/components/ui/StageTag'
import {
  TRIGGER_OUTCOME_HORIZONS,
  type TriggerOutcomeHorizon,
} from '@/lib/trigger-discovery-outcome-contract'
import {
  TRIGGER_OUTCOME_ANALYSIS_UNITS,
  type TriggerOutcomeAnalysisUnit,
  type TriggerOutcomeRobustnessBlock,
  type TriggerOutcomeRobustnessHorizonSummary,
  type TriggerOutcomeRobustnessResponse,
  type TriggerOutcomeRobustnessSegmentGroup,
} from '@/lib/trigger-discovery-outcome-robustness'
import {
  TRIGGER_OUTCOME_SCORE_BANDS,
  TRIGGER_OUTCOME_SPREAD_BUCKETS,
  TRIGGER_OUTCOME_STAGE_BUCKETS,
  type TriggerOutcomeSegmentDimension,
} from '@/lib/trigger-discovery-outcome-segmentation'

type RobustnessScope = 'overall' | 'score' | 'spread' | 'stage' | 'pair'
type RobustnessMetric = 'medianReturn' | 'positiveReturnRatio' | 'medianMfe' | 'medianMae'
type StageDimension = Exclude<TriggerOutcomeSegmentDimension, 'scoreBand' | 'spreadExpansion'>

interface Props {
  active: boolean
  outcomeJobId: string
  horizon: TriggerOutcomeHorizon
  onHorizonChange: (horizon: TriggerOutcomeHorizon) => void
}

interface HeatScale {
  center: number
  extent: number
  mode: 'diverging' | 'positive' | 'negative'
}

const RESPONSE_CACHE = new Map<string, TriggerOutcomeRobustnessResponse>()

const UNIT_LABELS: Record<TriggerOutcomeAnalysisUnit, string> = {
  EVENT: 'Event単位',
  EPISODE: 'Episode単位',
  TICKER_EQUAL_WEIGHT: '銘柄均等',
}

const UNIT_ELIGIBLE_LABELS: Record<TriggerOutcomeAnalysisUnit, string> = {
  EVENT: 'Eligible Event',
  EPISODE: 'Eligible Episode',
  TICKER_EQUAL_WEIGHT: 'Eligible銘柄',
}

const UNIT_DESCRIPTIONS: Record<TriggerOutcomeAnalysisUnit, string> = {
  EVENT: 'Trigger Eventをそのまま1件として集計します。',
  EPISODE: '連続した1回のTrigger局面につき、最初の該当Eventだけを集計します。',
  TICKER_EQUAL_WEIGHT: '同じ銘柄の複数Episodeについて、各HorizonのOutcome中央値をその銘柄の代表値とし、各銘柄を均等に集計します。',
}

const UNIT_ELIGIBILITY_DESCRIPTIONS: Record<TriggerOutcomeAnalysisUnit, string> = {
  EVENT: 'そのHorizonの将来データが揃うEventをeligibleとして集計します。',
  EPISODE: '代表となるEventで、そのHorizonの将来データが揃うEpisodeをeligibleとして集計します。',
  TICKER_EQUAL_WEIGHT: 'そのHorizonでeligibleなEpisodeが1件以上ある銘柄をeligibleとして集計します。',
}

const SCOPE_OPTIONS: ReadonlyArray<{ value: RobustnessScope; label: string }> = [
  { value: 'overall', label: '全体' },
  { value: 'score', label: 'Score帯' },
  { value: 'spread', label: 'MA間隔拡大' },
  { value: 'stage', label: 'Stage別' },
  { value: 'pair', label: 'Stage組み合わせ' },
]

const METRIC_OPTIONS: ReadonlyArray<{ value: RobustnessMetric; label: string }> = [
  { value: 'medianReturn', label: '中央値リターン' },
  { value: 'positiveReturnRatio', label: 'プラス比率' },
  { value: 'medianMfe', label: '期間中最大上昇幅中央値' },
  { value: 'medianMae', label: '期間中最大下落幅中央値' },
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

const SELECTOR_LABELS: Record<string, string> = {
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

const HORIZON_SHORT_LABELS: Record<TriggerOutcomeHorizon, string> = {
  20: '1M',
  60: '3M',
  120: '6M',
  245: '12M',
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

function formatMetric(value: number | null, metric: RobustnessMetric): string {
  return metric === 'positiveReturnRatio' ? formatRatio(value) : formatPercent(value)
}

function metricValue(
  summary: TriggerOutcomeRobustnessHorizonSummary | null,
  metric: RobustnessMetric,
): number | null {
  if (!summary || summary.eligibleCount === 0) return null
  return summary[metric]
}

function horizonSummary(
  block: TriggerOutcomeRobustnessBlock,
  unit: TriggerOutcomeAnalysisUnit,
  horizon: TriggerOutcomeHorizon,
): TriggerOutcomeRobustnessHorizonSummary | null {
  return block.units[unit].horizons.find((summary) => summary.horizonSessions === horizon) ?? null
}

function stageLabel(value: string): string {
  return value === 'UNKNOWN' ? '不明' : value
}

function dimensionLabel(dimension: StageDimension): string {
  return STAGE_DIMENSIONS.find((option) => option.value === dimension)?.label ?? dimension
}

function UnitHelp({ unit }: { unit: TriggerOutcomeAnalysisUnit }) {
  return (
    <DataPopover
      trigger={<CircleHelp size={12} aria-hidden />}
      title={UNIT_LABELS[unit]}
      triggerAriaLabel={`${UNIT_LABELS[unit]}の説明`}
      triggerTitle={`${UNIT_LABELS[unit]}の説明`}
      triggerClassName="h-5 w-5 justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand-200)]"
      showPatternBadge={false}
      openOnHover
    >
      <p className="leading-5">{UNIT_DESCRIPTIONS[unit]}</p>
      <p className="mt-2 leading-5">{UNIT_ELIGIBILITY_DESCRIPTIONS[unit]}</p>
    </DataPopover>
  )
}

function RobustnessHelp() {
  return (
    <DataPopover
      trigger={<CircleHelp size={14} aria-hidden />}
      title="観測単位について"
      triggerAriaLabel="観測単位分析の説明"
      triggerTitle="観測単位分析の説明"
      triggerClassName="h-6 w-6 justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand-200)]"
      showPatternBadge={false}
      openOnHover
      className="max-w-[calc(100vw-24px)]"
    >
      <div className="space-y-2 leading-5">
        <p>同じ銘柄・同じTrigger局面で複数回発生するEventの影響を除いた場合に、Outcomeがどの程度変わるかを確認します。</p>
        <p>候補入りからEXITEDまでを1 Episodeとし、その期間の最初の対象Eventを採用します。NEAR分析とZone分析ではAnchor日が異なる場合があります。</p>
        <p>本分析は同一銘柄・同一Trigger局面で繰り返し発生するEventの影響を確認するもので、統計的有意性を判定するものではありません。</p>
        <p>銘柄均等では、同じ銘柄の複数Episodeについて各HorizonのOutcome中央値を銘柄の代表値にします。</p>
      </div>
    </DataPopover>
  )
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
      選択した観測単位のeligible数が30件未満のため、参考値として表示しています。
    </DataPopover>
  )
}

function ObservationFunnel({ response }: { response: TriggerOutcomeRobustnessResponse }) {
  const block = response.overall
  const diagnostics = response.episodeDiagnostics
  const values = [
    ['Event', block.diagnostics.sourceEventCount],
    ['Episode', block.diagnostics.episodeObservationCount],
    ['銘柄', block.diagnostics.uniqueTickerCount],
  ] as const
  return (
    <div>
      <div className="grid gap-1.5 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-center" aria-label="Observation Funnel">
        {values.flatMap(([label, value], index) => [
          <div key={label} className="flex items-baseline justify-between gap-3 border-y border-[var(--color-border-soft)] px-3 py-2 sm:block sm:text-center">
            <span className="text-[10px] text-[var(--color-text-secondary)]">{label}</span>
            <strong className="text-[18px] font-semibold tabular-nums text-[var(--color-text-primary)] sm:ml-2">{value.toLocaleString('ja-JP')}</strong>
          </div>,
          index < values.length - 1
            ? <ChevronRight key={`${label}-arrow`} size={14} className="hidden text-[var(--color-text-tertiary)] sm:block" aria-hidden />
            : null,
        ])}
      </div>
      <details className="mt-2 border-b border-[var(--color-border-soft)] pb-2">
        <summary className="cursor-pointer text-[10px] font-medium text-[var(--color-text-secondary)]">重複集中度を見る</summary>
        <dl className="mt-2 grid gap-x-5 gap-y-2 text-[10px] sm:grid-cols-2 xl:grid-cols-3">
          <div><dt className="text-[var(--color-text-tertiary)]">tickerあたりEvent数 中央 / P90 / 最大</dt><dd className="mt-0.5 font-semibold tabular-nums text-[var(--color-text-primary)]">{block.diagnostics.eventsPerTicker.median ?? 'N/A'} / {block.diagnostics.eventsPerTicker.p90 ?? 'N/A'} / {block.diagnostics.eventsPerTicker.max}</dd></div>
          <div><dt className="text-[var(--color-text-tertiary)]">tickerあたりEpisode数 中央 / P90 / 最大</dt><dd className="mt-0.5 font-semibold tabular-nums text-[var(--color-text-primary)]">{block.diagnostics.episodesPerTicker.median ?? 'N/A'} / {block.diagnostics.episodesPerTicker.p90 ?? 'N/A'} / {block.diagnostics.episodesPerTicker.max}</dd></div>
          <div><dt className="text-[var(--color-text-tertiary)]">上位10銘柄Event占有率</dt><dd className="mt-0.5 font-semibold tabular-nums text-[var(--color-text-primary)]">{formatRatio(block.diagnostics.top10TickerEventShare)}</dd></div>
          <div><dt className="text-[var(--color-text-tertiary)]">Scan開始時点Episode</dt><dd className="mt-0.5 font-semibold tabular-nums text-[var(--color-text-primary)]">{block.diagnostics.selectedSyntheticBaselineEpisodeCount.toLocaleString('ja-JP')} / {block.diagnostics.syntheticBaselineEpisodeCount.toLocaleString('ja-JP')}</dd></div>
          <div><dt className="text-[var(--color-text-tertiary)]">対象Event 2件以上のEpisode</dt><dd className="mt-0.5 font-semibold tabular-nums text-[var(--color-text-primary)]">{diagnostics.episodesWithRepeatedSelectedEvents.toLocaleString('ja-JP')}件</dd></div>
          <div><dt className="text-[var(--color-text-tertiary)]">対象Event / Episode 平均・中央値・P95・最大</dt><dd className="mt-0.5 font-semibold tabular-nums text-[var(--color-text-primary)]">{diagnostics.selectedEventsPerEpisode.mean?.toFixed(2) ?? 'N/A'} / {diagnostics.selectedEventsPerEpisode.median ?? 'N/A'} / {diagnostics.selectedEventsPerEpisode.p95 ?? 'N/A'} / {diagnostics.selectedEventsPerEpisode.max}</dd></div>
          <div><dt className="text-[var(--color-text-tertiary)]">Scan開始前から継続 / 終了時継続中</dt><dd className="mt-0.5 font-semibold tabular-nums text-[var(--color-text-primary)]">{diagnostics.selectedLeftCensoredCount} / {diagnostics.selectedRightCensoredCount}</dd></div>
          <div><dt className="text-[var(--color-text-tertiary)]">Episode / Event 観測数比</dt><dd className="mt-0.5 font-semibold tabular-nums text-[var(--color-text-primary)]">{formatRatio(diagnostics.episodeToEventObservationRatio)}</dd></div>
        </dl>
      </details>
    </div>
  )
}

function SummaryTable({ block, horizon }: {
  block: TriggerOutcomeRobustnessBlock
  horizon: TriggerOutcomeHorizon
}) {
  const eventSummary = horizonSummary(block, 'EVENT', horizon)
  return (
    <div className="overflow-x-auto border-y border-[var(--color-border)]">
      <table className="w-full min-w-[1050px] border-collapse text-[10px]">
        <thead className="bg-[var(--color-surface-muted)] text-[var(--color-text-secondary)]">
          <tr className="border-b border-[var(--color-border)]">
            <th className="px-3 py-2 text-left">観測単位</th>
            <th className="px-2 py-2 text-right">Observation数</th>
            <th className="px-2 py-2 text-right">銘柄数</th>
            <th className="px-2 py-2 text-right">Eligible</th>
            <th className="px-2 py-2 text-right">Unavailable</th>
            <th className="px-2 py-2 text-right">Median Return</th>
            <th className="px-2 py-2 text-right">Eventとの差</th>
            <th className="px-2 py-2 text-right">プラス比率</th>
            <th className="px-2 py-2 text-right">Q25–Q75</th>
            <th className="px-2 py-2 text-right">Median MFE</th>
            <th className="px-3 py-2 text-right">Median MAE</th>
          </tr>
        </thead>
        <tbody>
          {TRIGGER_OUTCOME_ANALYSIS_UNITS.map((unit) => {
            const unitSummary = block.units[unit]
            const summary = horizonSummary(block, unit, horizon)
            const unavailable = !summary || summary.eligibleCount === 0
            const delta = unavailable || !eventSummary || eventSummary.eligibleCount === 0 || summary.medianReturn == null || eventSummary.medianReturn == null
              ? null
              : summary.medianReturn - eventSummary.medianReturn
            return (
              <tr key={unit} className="border-b border-[var(--color-border-soft)] bg-white last:border-b-0">
                <th className="px-3 py-2.5 text-left font-medium text-[var(--color-text-primary)]"><span className="inline-flex items-center gap-1">{UNIT_LABELS[unit]} <UnitHelp unit={unit} /></span></th>
                <td className="px-2 py-2.5 text-right tabular-nums">{unitSummary.observationCount.toLocaleString('ja-JP')}</td>
                <td className="px-2 py-2.5 text-right tabular-nums">{unitSummary.uniqueTickerCount.toLocaleString('ja-JP')}</td>
                <td className="px-2 py-2.5 text-right tabular-nums"><span className="inline-flex items-center justify-end gap-1.5"><span className="text-[9px] text-[var(--color-text-tertiary)]">{UNIT_ELIGIBLE_LABELS[unit]}</span> {summary?.eligibleCount.toLocaleString('ja-JP') ?? 0}{summary?.smallSample && summary.eligibleCount > 0 && <SmallSampleIndicator />}</span></td>
                <td className="px-2 py-2.5 text-right tabular-nums">{summary?.unavailableCount.toLocaleString('ja-JP') ?? 0}</td>
                <td className="px-2 py-2.5 text-right font-semibold tabular-nums">{unavailable ? 'N/A' : formatPercent(summary.medianReturn)}</td>
                <td className="px-2 py-2.5 text-right tabular-nums text-[var(--color-text-secondary)]">{unit === 'EVENT' ? '基準' : formatPercent(delta)}</td>
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

interface ChartDatum {
  horizon: string
  EVENT: number | null
  EPISODE: number | null
  TICKER_EQUAL_WEIGHT: number | null
  EVENTEligible: number
  EPISODEEligible: number
  TICKER_EQUAL_WEIGHTEligible: number
}

function RobustnessChartTooltip({ active, payload, label, metric }: {
  active?: boolean
  payload?: Array<{ dataKey?: string | number; value?: number; payload?: ChartDatum }>
  label?: string
  metric: RobustnessMetric
}) {
  if (!active || !payload?.length) return null
  const row = payload[0]?.payload
  return (
    <div className="rounded-[3px] border border-[var(--color-border)] bg-white px-3 py-2 shadow-lg">
      <div className="text-[10px] font-semibold text-[var(--color-text-primary)]">{label}</div>
      <div className="mt-1 space-y-1">
        {payload.map((item) => {
          const unit = String(item.dataKey) as TriggerOutcomeAnalysisUnit
          const eligible = row?.[`${unit}Eligible` as keyof ChartDatum] ?? 0
          return <div key={unit} className="flex min-w-[210px] items-center justify-between gap-4 text-[10px]"><span className="text-[var(--color-text-secondary)]">{UNIT_LABELS[unit]}</span><span className="font-semibold tabular-nums text-[var(--color-text-primary)]">{formatMetric(item.value ?? null, metric)} <span className="font-normal text-[var(--color-text-tertiary)]">Eligible {eligible}</span></span></div>
        })}
      </div>
    </div>
  )
}

function HorizonChart({ block, metric }: {
  block: TriggerOutcomeRobustnessBlock
  metric: RobustnessMetric
}) {
  const data = TRIGGER_OUTCOME_HORIZONS.map((horizon): ChartDatum => {
    const summaries = Object.fromEntries(TRIGGER_OUTCOME_ANALYSIS_UNITS.map((unit) => [unit, horizonSummary(block, unit, horizon)])) as Record<TriggerOutcomeAnalysisUnit, TriggerOutcomeRobustnessHorizonSummary | null>
    return {
      horizon: HORIZON_SHORT_LABELS[horizon],
      EVENT: metricValue(summaries.EVENT, metric),
      EPISODE: metricValue(summaries.EPISODE, metric),
      TICKER_EQUAL_WEIGHT: metricValue(summaries.TICKER_EQUAL_WEIGHT, metric),
      EVENTEligible: summaries.EVENT?.eligibleCount ?? 0,
      EPISODEEligible: summaries.EPISODE?.eligibleCount ?? 0,
      TICKER_EQUAL_WEIGHTEligible: summaries.TICKER_EQUAL_WEIGHT?.eligibleCount ?? 0,
    }
  })
  const series = [
    { unit: 'EVENT' as const, stroke: 'var(--color-brand-800)', dash: undefined },
    { unit: 'EPISODE' as const, stroke: 'var(--color-price-up)', dash: '6 3' },
    { unit: 'TICKER_EQUAL_WEIGHT' as const, stroke: 'var(--color-text-secondary)', dash: '2 3' },
  ]
  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[9px] text-[var(--color-text-secondary)]">
        {series.map(({ unit, stroke, dash }) => <span key={unit} className="inline-flex items-center gap-1.5"><span className="inline-block h-0.5 w-5" style={{ backgroundColor: stroke, opacity: dash ? 0.8 : 1 }} />{UNIT_LABELS[unit]}</span>)}
      </div>
      <MeasuredChartFrame className="h-[250px] w-full sm:h-[290px]">
        {({ width, height }) => (
          <LineChart width={width} height={height} data={data} margin={{ top: 8, right: 16, bottom: 4, left: 2 }} accessibilityLayer>
            <CartesianGrid vertical={false} stroke="var(--color-border-soft)" />
            <XAxis dataKey="horizon" tick={{ fontSize: 10, fill: 'var(--color-text-secondary)' }} tickLine={false} axisLine={{ stroke: 'var(--color-border-soft)' }} />
            <YAxis width={48} tickFormatter={(value) => `${(Number(value) * 100).toFixed(0)}%`} tick={{ fontSize: 9, fill: 'var(--color-text-tertiary)' }} tickLine={false} axisLine={false} />
            <Tooltip content={<RobustnessChartTooltip metric={metric} />} />
            {series.map(({ unit, stroke, dash }) => <Line key={unit} type="monotone" dataKey={unit} name={UNIT_LABELS[unit]} stroke={stroke} strokeWidth={2} strokeDasharray={dash} dot={{ r: 3, fill: 'white', strokeWidth: 2 }} activeDot={{ r: 4 }} connectNulls={false} isAnimationActive={false} />)}
          </LineChart>
        )}
      </MeasuredChartFrame>
    </div>
  )
}

function segmentValue(summary: TriggerOutcomeRobustnessHorizonSummary | null, metric: RobustnessMetric): string {
  return formatMetric(metricValue(summary, metric), metric)
}

function SegmentComparisonTable({ response, dimension, horizon, metric }: {
  response: TriggerOutcomeRobustnessResponse
  dimension: TriggerOutcomeSegmentDimension
  horizon: TriggerOutcomeHorizon
  metric: RobustnessMetric
}) {
  const groups = response.segmentation?.groups ?? []
  const orderedValues = dimension === 'scoreBand' ? TRIGGER_OUTCOME_SCORE_BANDS
    : dimension === 'spreadExpansion' ? TRIGGER_OUTCOME_SPREAD_BUCKETS : TRIGGER_OUTCOME_STAGE_BUCKETS
  const groupsByValue = new Map(groups.map((group) => [String(group.keys[dimension] ?? 'UNKNOWN'), group]))
  return (
    <div className="overflow-x-auto border-y border-[var(--color-border)]">
      <table className="w-full min-w-[820px] border-collapse text-[10px]">
        <thead className="bg-[var(--color-surface-muted)] text-[var(--color-text-secondary)]">
          <tr className="border-b border-[var(--color-border)]">
            <th className="px-3 py-2 text-left">{dimension === 'scoreBand' ? 'Score帯' : dimension === 'spreadExpansion' ? 'MA間隔拡大' : dimensionLabel(dimension as StageDimension)}</th>
            {TRIGGER_OUTCOME_ANALYSIS_UNITS.map((unit) => <th key={unit} className="px-3 py-2 text-right">{UNIT_LABELS[unit]}<span className="block text-[9px] font-normal">{METRIC_OPTIONS.find((option) => option.value === metric)?.label}</span></th>)}
          </tr>
        </thead>
        <tbody>
          {orderedValues.map((value) => {
            const group = groupsByValue.get(value)
            return (
              <tr key={value} className="border-b border-[var(--color-border-soft)] bg-white last:border-b-0">
                <th className="px-3 py-2.5 text-left font-medium text-[var(--color-text-primary)]">
                  {dimension === 'scoreBand'
                    ? SCORE_LABELS[value] ?? value
                    : dimension === 'spreadExpansion' ? value === 'PASS' ? '拡大条件あり' : value === 'FAIL' ? '拡大条件なし' : '判定不能'
                    : value === 'UNKNOWN' ? '不明' : <span className="inline-flex items-center gap-1.5"><StageTag stage={Number(value.slice(1))} size="xs" /><span>{value}</span></span>}
                </th>
                {TRIGGER_OUTCOME_ANALYSIS_UNITS.map((unit) => {
                  const summary = group ? horizonSummary(group, unit, horizon) : null
                  return (
                    <td key={unit} className="px-3 py-2.5 text-right">
                      <div className="inline-flex items-center justify-end gap-1.5 font-semibold tabular-nums text-[var(--color-text-primary)]">{segmentValue(summary, metric)}{summary?.smallSample && summary.eligibleCount > 0 && <SmallSampleIndicator />}</div>
                      <div className="mt-0.5 text-[9px] tabular-nums text-[var(--color-text-tertiary)]">{UNIT_ELIGIBLE_LABELS[unit]} {summary?.eligibleCount.toLocaleString('ja-JP') ?? 0}</div>
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function heatScale(response: TriggerOutcomeRobustnessResponse, horizon: TriggerOutcomeHorizon, metric: RobustnessMetric): HeatScale {
  const values = (response.segmentation?.groups ?? []).flatMap((group) => TRIGGER_OUTCOME_ANALYSIS_UNITS.flatMap((unit) => {
    const value = metricValue(horizonSummary(group, unit, horizon), metric)
    return value == null || !Number.isFinite(value) ? [] : [value]
  }))
  if (metric === 'positiveReturnRatio') return { center: 0.5, extent: Math.max(0.1, ...values.map((value) => Math.abs(value - 0.5))), mode: 'diverging' }
  if (metric === 'medianMfe') return { center: 0, extent: Math.max(0.01, ...values.map(Math.abs)), mode: 'positive' }
  if (metric === 'medianMae') return { center: 0, extent: Math.max(0.01, ...values.map(Math.abs)), mode: 'negative' }
  return { center: 0, extent: Math.max(0.01, ...values.map(Math.abs)), mode: 'diverging' }
}

function heatCellStyle(value: number | null, scale: HeatScale): CSSProperties {
  if (value == null || !Number.isFinite(value)) return { backgroundColor: 'var(--color-surface-subtle)' }
  const ratio = Math.min(1, Math.abs(value - scale.center) / scale.extent)
  const strength = Math.round(7 + ratio * 25)
  const positive = scale.mode === 'positive' || (scale.mode === 'diverging' && value >= scale.center)
  const token = positive ? 'var(--color-price-up)' : 'var(--color-price-down)'
  return { backgroundColor: `color-mix(in srgb, ${token} ${strength}%, white)` }
}

function groupTitle(group: TriggerOutcomeRobustnessSegmentGroup | undefined, unit: TriggerOutcomeAnalysisUnit, rowDimension: StageDimension, columnDimension: StageDimension, horizon: TriggerOutcomeHorizon): string {
  if (!group) return 'N/A'
  const summary = horizonSummary(group, unit, horizon)
  const row = stageLabel(String(group.keys[rowDimension] ?? 'UNKNOWN'))
  const column = stageLabel(String(group.keys[columnDimension] ?? 'UNKNOWN'))
  const observation = group.units[unit].observationCount
  return [
    `${dimensionLabel(rowDimension)} ${row} / ${dimensionLabel(columnDimension)} ${column}`,
    `${UNIT_LABELS[unit]} Observation ${observation}件、${UNIT_ELIGIBLE_LABELS[unit]} ${summary?.eligibleCount ?? 0}件`,
    `Median ${formatPercent(summary?.medianReturn ?? null)}、Mean ${formatPercent(summary?.meanReturn ?? null)}`,
    `プラス比率 ${formatRatio(summary?.positiveReturnRatio ?? null)}、Q25/Q75 ${formatPercent(summary?.p25Return ?? null)} / ${formatPercent(summary?.p75Return ?? null)}`,
    `MFE ${formatPercent(summary?.medianMfe ?? null)}、MAE ${formatPercent(summary?.medianMae ?? null)}`,
  ].join('。')
}

function RobustnessHeatmap({ response, unit, rowDimension, columnDimension, horizon, metric, scale, selected, onSelect }: {
  response: TriggerOutcomeRobustnessResponse
  unit: TriggerOutcomeAnalysisUnit
  rowDimension: StageDimension
  columnDimension: StageDimension
  horizon: TriggerOutcomeHorizon
  metric: RobustnessMetric
  scale: HeatScale
  selected: [string, string]
  onSelect: (value: [string, string]) => void
}) {
  const groups = new Map((response.segmentation?.groups ?? []).map((group) => [`${group.keys[rowDimension] ?? 'UNKNOWN'}|${group.keys[columnDimension] ?? 'UNKNOWN'}`, group]))
  return (
    <section className="min-w-0">
      <div className="mb-2 flex items-center gap-1"><h6 className="text-[11px] font-semibold text-[var(--color-text-primary)]">{UNIT_LABELS[unit]}</h6><UnitHelp unit={unit} /></div>
      <div className="max-w-full overflow-x-auto pb-1">
        <div className="grid min-w-[440px] grid-cols-[54px_repeat(7,minmax(48px,1fr))] gap-1" role="grid" aria-label={`${UNIT_LABELS[unit]} ${dimensionLabel(rowDimension)}と${dimensionLabel(columnDimension)}のOutcome Heatmap`}>
          <div className="flex items-end px-1 pb-1 text-[9px] leading-4 text-[var(--color-text-tertiary)]">{dimensionLabel(rowDimension)} ↓<br />{dimensionLabel(columnDimension)} →</div>
          {TRIGGER_OUTCOME_STAGE_BUCKETS.map((bucket) => <div key={bucket} role="columnheader" className="flex min-h-7 items-center justify-center text-[9px] font-semibold text-[var(--color-text-secondary)]">{stageLabel(bucket)}</div>)}
          {TRIGGER_OUTCOME_STAGE_BUCKETS.flatMap((rowBucket) => [
            <div key={`row-${rowBucket}`} role="rowheader" className="flex min-h-[50px] items-center px-1 text-[9px] font-semibold text-[var(--color-text-secondary)]">{stageLabel(rowBucket)}</div>,
            ...TRIGGER_OUTCOME_STAGE_BUCKETS.map((columnBucket) => {
              const group = groups.get(`${rowBucket}|${columnBucket}`)
              const summary = group ? horizonSummary(group, unit, horizon) : null
              const value = metricValue(summary, metric)
              const isSelected = selected[0] === rowBucket && selected[1] === columnBucket
              return (
                <button
                  key={`${rowBucket}-${columnBucket}`}
                  type="button"
                  role="gridcell"
                  title={groupTitle(group, unit, rowDimension, columnDimension, horizon)}
                  aria-label={groupTitle(group, unit, rowDimension, columnDimension, horizon)}
                  aria-pressed={isSelected}
                  onClick={() => onSelect([rowBucket, columnBucket])}
                  className={`min-h-[50px] rounded-[3px] border px-1 py-1 text-center outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand-500)] ${isSelected ? 'border-[var(--color-brand-800)] ring-1 ring-[var(--color-brand-700)]' : summary?.smallSample && summary.eligibleCount > 0 ? 'border-dashed border-amber-400' : 'border-[var(--color-border-soft)]'}`}
                  style={heatCellStyle(value, scale)}
                >
                  <span className="block text-[10px] font-semibold tabular-nums text-[var(--color-text-primary)]">{formatMetric(value, metric)}</span>
                  <span className="mt-0.5 block text-[9px] tabular-nums text-[var(--color-text-secondary)]">n={summary?.eligibleCount.toLocaleString('ja-JP') ?? 0}</span>
                  {summary?.smallSample && summary.eligibleCount > 0 && <span className="mt-0.5 block text-[9px] font-semibold text-amber-900">n&lt;30</span>}
                </button>
              )
            }),
          ])}
        </div>
      </div>
    </section>
  )
}

function SelectedPairDetail({ response, rowDimension, columnDimension, selected, horizon }: {
  response: TriggerOutcomeRobustnessResponse
  rowDimension: StageDimension
  columnDimension: StageDimension
  selected: [string, string]
  horizon: TriggerOutcomeHorizon
}) {
  const group = response.segmentation?.groups.find((candidate) => candidate.keys[rowDimension] === selected[0] && candidate.keys[columnDimension] === selected[1])
  return (
    <section className="border-l-2 border-[var(--color-border)] pl-3">
      <h6 className="text-[10px] font-semibold text-[var(--color-text-primary)]">選択Segment詳細: {dimensionLabel(rowDimension)} {stageLabel(selected[0])} × {dimensionLabel(columnDimension)} {stageLabel(selected[1])}</h6>
      <div className="mt-2 grid gap-3 md:grid-cols-3">
        {TRIGGER_OUTCOME_ANALYSIS_UNITS.map((unit) => {
          const summary = group ? horizonSummary(group, unit, horizon) : null
          const unavailable = !summary || summary.eligibleCount === 0
          return (
            <article key={unit} className="border-t border-[var(--color-border-soft)] pt-2">
              <div className="flex items-center gap-1 text-[10px] font-semibold text-[var(--color-text-primary)]">{UNIT_LABELS[unit]}{summary?.smallSample && summary.eligibleCount > 0 && <SmallSampleIndicator />}</div>
              <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[9px]">
                {[
                  ['Observation', group?.units[unit].observationCount.toLocaleString('ja-JP') ?? '0'],
                  [UNIT_ELIGIBLE_LABELS[unit], summary?.eligibleCount.toLocaleString('ja-JP') ?? '0'],
                  ['Median', unavailable ? 'N/A' : formatPercent(summary.medianReturn)],
                  ['Mean', unavailable ? 'N/A' : formatPercent(summary.meanReturn)],
                  ['プラス比率', unavailable ? 'N/A' : formatRatio(summary.positiveReturnRatio)],
                  ['Q25 / Q75', unavailable ? 'N/A' : `${formatPercent(summary.p25Return)} / ${formatPercent(summary.p75Return)}`],
                  ['MFE', unavailable ? 'N/A' : formatPercent(summary.medianMfe)],
                  ['MAE', unavailable ? 'N/A' : formatPercent(summary.medianMae)],
                ].map(([label, value]) => <div key={label}><dt className="text-[var(--color-text-tertiary)]">{label}</dt><dd className="mt-0.5 font-semibold tabular-nums text-[var(--color-text-primary)]">{value}</dd></div>)}
              </dl>
            </article>
          )
        })}
      </div>
    </section>
  )
}

async function robustnessErrorMessage(response: Response): Promise<string> {
  const body = await response.json().catch(() => null) as { message?: string } | null
  if (response.status === 410) return 'Outcomeまたは期間検証結果の保存期限が切れています。'
  if (response.status === 409) return 'Outcome分析がまだ完了していません。'
  if (response.status === 404) return 'Outcome分析結果が見つかりません。'
  return body?.message ?? '観測単位の比較を取得できませんでした。'
}

export function OutcomeRobustnessPanel({ active, outcomeJobId, horizon, onHorizonChange }: Props) {
  const [scope, setScope] = useState<RobustnessScope>('overall')
  const [metric, setMetric] = useState<RobustnessMetric>('medianReturn')
  const [stageDimension, setStageDimension] = useState<StageDimension>('stage:monthA')
  const [rowDimension, setRowDimension] = useState<StageDimension>('stage:weekA')
  const [columnDimension, setColumnDimension] = useState<StageDimension>('stage:monthA')
  const [selectedCell, setSelectedCell] = useState<[string, string]>(['S1', 'S1'])
  const [response, setResponse] = useState<TriggerOutcomeRobustnessResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestSequence = useRef(0)

  const dimensions = useMemo<TriggerOutcomeSegmentDimension[]>(() => {
    if (scope === 'score') return ['scoreBand']
    if (scope === 'spread') return ['spreadExpansion']
    if (scope === 'stage') return [stageDimension]
    if (scope === 'pair') return [rowDimension, columnDimension]
    return []
  }, [scope, stageDimension, rowDimension, columnDimension])
  const dimensionKey = dimensions.join(',')
  const cacheKey = `${outcomeJobId}|${dimensionKey || 'overall'}`
  const visibleResponse = response?.meta.source.outcomeJobId === outcomeJobId
    && response.meta.dimensions.join(',') === dimensionKey
    ? response
    : null

  useEffect(() => {
    if (!active || !outcomeJobId) return
    const cached = RESPONSE_CACHE.get(cacheKey)
    if (cached && Date.parse(cached.meta.expiresAt) > Date.now()) {
      setResponse(cached)
      setError(null)
      setLoading(false)
      return
    }
    const controller = new AbortController()
    const sequence = ++requestSequence.current
    const params = new URLSearchParams()
    dimensions.forEach((dimension) => params.append('dimension', dimension))
    setLoading(true)
    setError(null)
    void fetch(`/api/trigger-discovery/outcome-jobs/${outcomeJobId}/robustness?${params}`, {
      cache: 'no-store',
      signal: controller.signal,
    }).then(async (result) => {
      if (!result.ok) throw new Error(await robustnessErrorMessage(result))
      return result.json() as Promise<TriggerOutcomeRobustnessResponse>
    }).then((body) => {
      if (controller.signal.aborted || sequence !== requestSequence.current) return
      RESPONSE_CACHE.set(cacheKey, body)
      setResponse(body)
    }).catch((loadError) => {
      if (!controller.signal.aborted && sequence === requestSequence.current) {
        setError(loadError instanceof Error ? loadError.message : '観測単位の比較を取得できませんでした。')
      }
    }).finally(() => {
      if (!controller.signal.aborted && sequence === requestSequence.current) setLoading(false)
    })
    return () => controller.abort()
  }, [active, outcomeJobId, cacheKey, dimensionKey])

  if (!active) return null

  const source = visibleResponse?.meta.source
  const timeframe = source?.timeframe === 'BIWEEKLY' ? '2週足' : '月足'
  const maUnit = source?.maPeriods.unit === 'BIWEEKLY_BARS' ? '本' : 'か月'
  const pairScale = visibleResponse && scope === 'pair' ? heatScale(visibleResponse, horizon, metric) : null

  return (
    <div className="mt-3" data-outcome-robustness-panel>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-3xl">
          <h5 className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-[var(--color-text-primary)]">重複の影響 <RobustnessHelp /></h5>
          <p className="mt-0.5 text-[10px] leading-5 text-[var(--color-text-secondary)]">同じ銘柄・同じTrigger局面で繰り返すEventをまとめたとき、Outcomeがどの程度変わるかを比較します。</p>
        </div>
        {source && <div className="flex flex-wrap gap-x-4 gap-y-1 border-l-2 border-[var(--color-border)] pl-3 text-[9px] text-[var(--color-text-secondary)]"><span>{timeframe}</span><span>MA {source.maPeriods.ma1}{maUnit} / {source.maPeriods.ma2}{maUnit}</span><span>{SELECTOR_LABELS[source.eventSelector] ?? source.eventSelector}</span><span>{source.scanPeriod.resolvedStartDate ?? source.scanPeriod.requestedStartDate}〜{source.scanPeriod.resolvedEndDate ?? source.scanPeriod.requestedEndDate}</span></div>}
      </div>

      {error && <div role="alert" className="mt-3 border-l-2 border-red-500 bg-red-50 px-3 py-2 text-[10px] text-red-800">{error}</div>}
      {loading && <div role="status" className="mt-4 inline-flex items-center gap-2 text-[10px] text-[var(--color-brand-700)]"><LoaderCircle size={13} className="animate-spin" aria-hidden />観測単位の比較を読み込み中</div>}

      {visibleResponse && (
        <div className="mt-4 space-y-5">
          <ObservationFunnel response={visibleResponse} />
          {(visibleResponse.episodeDiagnostics.sequenceAnomalyCount > 0
            || visibleResponse.episodeDiagnostics.unmappedOutcomeRows > 0
            || visibleResponse.episodeDiagnostics.ambiguousOutcomeRows > 0) && (
            <p role="alert" className="border-l-2 border-amber-500 bg-amber-50 px-3 py-2 text-[10px] text-amber-900">
              Event順序異常 {visibleResponse.episodeDiagnostics.sequenceAnomalyCount}件 / 対応不能 {visibleResponse.episodeDiagnostics.unmappedOutcomeRows}件 / 曖昧 {visibleResponse.episodeDiagnostics.ambiguousOutcomeRows}件。順序異常 {visibleResponse.episodeDiagnostics.excludedForSequenceIntegrity} Episode、対応曖昧 {visibleResponse.episodeDiagnostics.excludedForMappingIntegrity} Episodeを除外しています。
            </p>
          )}

          <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <div className="flex max-w-full gap-1 overflow-x-auto pb-1" aria-label="観測単位の分析範囲">
              {SCOPE_OPTIONS.map((option) => <button key={option.value} type="button" aria-pressed={scope === option.value} onClick={() => { setScope(option.value); setError(null) }} className={`h-8 shrink-0 rounded-[3px] border px-2.5 text-[10px] font-medium ${scope === option.value ? 'border-[var(--color-brand-700)] bg-[var(--color-brand-50)] text-[var(--color-brand-800)]' : 'border-[var(--color-border)] bg-white text-[var(--color-text-secondary)]'}`}>{option.label}</button>)}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex max-w-full gap-1 overflow-x-auto pb-1" aria-label="観測単位Outcome表示期間">
                {TRIGGER_OUTCOME_HORIZONS.map((value) => <button key={value} type="button" aria-pressed={horizon === value} onClick={() => onHorizonChange(value)} className={`h-8 shrink-0 rounded-[3px] border px-2.5 text-[10px] font-medium ${horizon === value ? 'border-[var(--color-brand-700)] bg-[var(--color-brand-700)] text-white' : 'border-[var(--color-border)] bg-white text-[var(--color-text-secondary)]'}`}>{HORIZON_LABELS[value]}</button>)}
              </div>
              <label className="inline-flex h-8 items-center gap-1.5 text-[9px] text-[var(--color-text-secondary)]">表示指標
                <select value={metric} onChange={(event) => setMetric(event.target.value as RobustnessMetric)} className="h-8 rounded-[3px] border border-[var(--color-border)] bg-white px-2 text-[10px]">
                  {METRIC_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
            </div>
          </div>

          <section aria-labelledby="robustness-summary-heading">
            <div className="mb-2"><h6 id="robustness-summary-heading" className="text-[11px] font-semibold text-[var(--color-text-primary)]">{HORIZON_LABELS[horizon]}後の3方式比較</h6><p className="mt-0.5 text-[9px] text-[var(--color-text-tertiary)]">eligibleが0件の場合はN/Aです。差はEvent単位との差を単純表示しています。</p></div>
            <SummaryTable block={visibleResponse.overall} horizon={horizon} />
          </section>

          <section aria-labelledby="robustness-chart-heading" className="border-t border-[var(--color-border-soft)] pt-4">
            <div className="mb-2"><h6 id="robustness-chart-heading" className="text-[11px] font-semibold text-[var(--color-text-primary)]">Horizon横断比較</h6><p className="mt-0.5 text-[9px] text-[var(--color-text-tertiary)]">欠損は0として描画せず、各点のEligible数をTooltipで確認できます。</p></div>
            <HorizonChart block={visibleResponse.overall} metric={metric} />
          </section>

          {scope === 'stage' && <div className="flex flex-wrap items-center gap-3"><label className="inline-flex h-8 items-center gap-2 text-[10px] text-[var(--color-text-secondary)]">Stage軸<select value={stageDimension} onChange={(event) => setStageDimension(event.target.value as StageDimension)} className="h-8 rounded-[3px] border border-[var(--color-border)] bg-white px-2 text-[10px]">{STAGE_DIMENSIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label><span className="text-[9px] text-[var(--color-text-tertiary)]">S1〜S6は強弱順位ではなく、循環的な相場構造です。</span></div>}
          {scope === 'pair' && <div className="flex flex-wrap items-center gap-3 text-[10px] text-[var(--color-text-secondary)]"><label>縦軸<select value={rowDimension} onChange={(event) => setRowDimension(event.target.value as StageDimension)} className="ml-1 h-8 rounded-[3px] border border-[var(--color-border)] bg-white px-2 text-[10px]">{STAGE_DIMENSIONS.map((option) => <option key={option.value} value={option.value} disabled={option.value === columnDimension}>{option.label}</option>)}</select></label><label>横軸<select value={columnDimension} onChange={(event) => setColumnDimension(event.target.value as StageDimension)} className="ml-1 h-8 rounded-[3px] border border-[var(--color-border)] bg-white px-2 text-[10px]">{STAGE_DIMENSIONS.map((option) => <option key={option.value} value={option.value} disabled={option.value === rowDimension}>{option.label}</option>)}</select></label><span className="text-[9px] text-[var(--color-text-tertiary)]">3方式で同じColor Scaleを使用します。</span></div>}

          {scope === 'score' && visibleResponse.segmentation && <section><h6 className="mb-2 text-[11px] font-semibold text-[var(--color-text-primary)]">Score帯別の3方式比較</h6><SegmentComparisonTable response={visibleResponse} dimension="scoreBand" horizon={horizon} metric={metric} /></section>}
          {scope === 'spread' && visibleResponse.segmentation && <section><h6 className="mb-2 text-[11px] font-semibold text-[var(--color-text-primary)]">MA間隔拡大別の3方式比較</h6><SegmentComparisonTable response={visibleResponse} dimension="spreadExpansion" horizon={horizon} metric={metric} /></section>}
          {scope === 'stage' && visibleResponse.segmentation && <section><h6 className="mb-2 text-[11px] font-semibold text-[var(--color-text-primary)]">{dimensionLabel(stageDimension)}別の3方式比較</h6><SegmentComparisonTable response={visibleResponse} dimension={stageDimension} horizon={horizon} metric={metric} /></section>}
          {scope === 'pair' && visibleResponse.segmentation && pairScale && (
            <section className="space-y-4">
              <div className="grid gap-5 xl:grid-cols-2 2xl:grid-cols-3">
                {TRIGGER_OUTCOME_ANALYSIS_UNITS.map((unit) => <RobustnessHeatmap key={unit} response={visibleResponse} unit={unit} rowDimension={rowDimension} columnDimension={columnDimension} horizon={horizon} metric={metric} scale={pairScale} selected={selectedCell} onSelect={setSelectedCell} />)}
              </div>
              <SelectedPairDetail response={visibleResponse} rowDimension={rowDimension} columnDimension={columnDimension} selected={selectedCell} horizon={horizon} />
            </section>
          )}

          <p className="border-t border-[var(--color-border-soft)] pt-3 text-[9px] leading-5 text-[var(--color-text-tertiary)]">この表示は保存済みOutcomeとHistorical Eventから作る追加分析です。Trigger条件、Score、Stage、Outcomeの計算値には影響しません。</p>
        </div>
      )}
    </div>
  )
}
