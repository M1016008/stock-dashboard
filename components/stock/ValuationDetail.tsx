'use client'

import { useEffect, useMemo, useState } from 'react'
import { CircleGauge, History, Info, Layers, Scale, Users } from 'lucide-react'
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
import {
  VALUATION_HISTORY_METRICS,
  VALUATION_PEER_METRICS,
  type ValuationAvailability,
  type ValuationDetailReadModel,
  type ValuationHistoryMetric,
  type ValuationHistoryWindow,
  type ValuationPeerGroup,
  type ValuationPeerMetric,
  type ValuationPeerMetricComparison,
  type ValuationRangeStatistics,
  type ValuationValue,
} from '@/lib/valuation-detail'
import type { MedianComparison } from '@/lib/valuation-comparison'
import {
  directionFromMedianComparison,
  UNAVAILABLE_LEGEND,
  unavailableLabel,
  type Direction,
} from '@/components/stock/fundamentals/format'
import {
  DirectionMark,
  ErrorBlock,
  Fact,
  LoadingBlock,
  PanelSection,
  PeerBand,
  Pill,
  RangeRuler,
  Segmented,
  TabBanner,
  TabSwitch,
  UnavailableNote,
} from '@/components/stock/fundamentals/primitives'

interface ValuationDetailProps {
  ticker: string
  analysisDate: string | null
}

type Taxonomy = 'sector33' | 'custom60'

const HISTORY_WINDOWS: Array<{ value: ValuationHistoryWindow; label: string }> = [
  { value: '3y', label: '3年' },
  { value: '5y', label: '5年' },
  { value: '10y', label: '10年' },
]

const TAXONOMY_OPTIONS: Array<{ value: Taxonomy; label: string }> = [
  { value: 'sector33', label: '33業種' },
  { value: 'custom60', label: '独自60分類' },
]

function valuationUrl(ticker: string, analysisDate: string | null): string {
  return `/api/valuation-detail/${encodeURIComponent(ticker)}${analysisDate ? `?as_of=${encodeURIComponent(analysisDate)}` : ''}`
}

function compactNumber(value: number): string {
  const absolute = Math.abs(value)
  if (absolute >= 1e12) return `${(value / 1e12).toFixed(1)}兆円`
  if (absolute >= 1e8) return `${(value / 1e8).toFixed(0)}億円`
  if (absolute >= 1e4) return `${(value / 1e4).toFixed(0)}万円`
  return `${value.toLocaleString('ja-JP', { maximumFractionDigits: 1 })}円`
}

function metricNumber(value: number | null, unit: string | null): string {
  if (value == null) return unavailableLabel('missing')
  if (unit === 'MULTIPLE') return `${value.toFixed(2)}倍`
  if (unit === 'PERCENT') return `${value.toFixed(2)}%`
  if (unit === 'JPY') return compactNumber(value)
  return value.toLocaleString('ja-JP', { maximumFractionDigits: 2 })
}

function availabilityText(availability: ValuationAvailability): string {
  return unavailableLabel(availability)
}

function valueText(value: ValuationValue): string {
  return value.availability === 'available'
    ? metricNumber(value.value, value.unit)
    : availabilityText(value.availability)
}

function comparisonLabel(comparison: MedianComparison): string {
  if (comparison.kind === 'ratio_percent') return '中央値比'
  if (comparison.kind === 'percentage_point') return '中央値差'
  if (comparison.kind === 'absolute_difference') return '平均との差'
  return '中央値比較'
}

function comparisonText(comparison: MedianComparison, unit: string | null): string {
  if (comparison.value == null) return unavailableLabel('missing')
  const sign = comparison.value > 0 ? '+' : ''
  if (comparison.kind === 'ratio_percent') return `${sign}${comparison.value.toFixed(1)}%`
  if (comparison.kind === 'percentage_point') return `${sign}${comparison.value.toFixed(2)}pt`
  return `${sign}${metricNumber(comparison.value, unit)}`
}

function comparisonReason(comparison: MedianComparison): string | null {
  return comparison.kind === 'percentage_point' || comparison.kind === 'absolute_difference'
    ? '負値・0近傍・符号跨ぎを含むため差で表示'
    : null
}

/** 倍率の大小は優劣ではない。「より高い/より低い」とだけ書く。 */
function medianWord(direction: Direction): string {
  return direction === 'same' ? 'と同水準' : direction === 'higher' ? 'より高い' : 'より低い'
}

function windowLabel(window: ValuationHistoryWindow): string {
  return HISTORY_WINDOWS.find((item) => item.value === window)?.label ?? window
}

export function ValuationDetail({ ticker, analysisDate }: ValuationDetailProps) {
  const [model, setModel] = useState<ValuationDetailReadModel | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [metric, setMetric] = useState<ValuationHistoryMetric>('forward_per')
  const [window, setWindow] = useState<ValuationHistoryWindow>('5y')
  const [taxonomy, setTaxonomy] = useState<Taxonomy>('sector33')

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    fetch(valuationUrl(ticker, analysisDate), { cache: 'no-store', signal: controller.signal })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`)))
      .then((payload: ValuationDetailReadModel) => {
        if (!controller.signal.aborted) setModel(payload)
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [analysisDate, ticker, reloadKey])

  const selected = model?.history[metric] ?? null
  const stats = selected?.statistics[window] ?? null
  const startDate = stats?.observationStartDate ?? ''
  const chartPoints = useMemo(() => selected?.points.filter((point) => point.date >= startDate) ?? [], [selected, startDate])
  const peer = model?.peers[taxonomy] ?? null

  if (loading) return <LoadingBlock label="バリュエーションを読み込んでいます..." />
  if (error || !model || !selected || !stats || !peer) {
    return <ErrorBlock label="バリュエーションを取得できませんでした。" onRetry={() => setReloadKey((value) => value + 1)} />
  }

  return (
    <section className="space-y-5 bg-white" aria-labelledby="valuation-detail-title">
      <TabBanner
        icon={Scale}
        id="valuation-detail-title"
        title="バリュエーション"
        lead="いまの倍率が、自社の過去と同業の中でどこにあるかを並べて確認します(割安・割高の判定や推奨はしません)。"
        meta={(
          <>
            <div>分析基準日 {model.asOf}</div>
            <div>価格日 {model.priceDate ?? '—'}</div>
          </>
        )}
        flow={['現在の倍率', '自社過去・同業との位置', '履歴グラフ・同業の分布表', '定義']}
      />

      <CurrentValuation model={model} />
      <PositionOverview
        model={model}
        window={window}
        onWindowChange={setWindow}
        taxonomy={taxonomy}
        onTaxonomyChange={setTaxonomy}
        selectedMetric={metric}
        onSelectMetric={setMetric}
      />
      <HistoricalRange
        model={model}
        metric={metric}
        onMetricChange={setMetric}
        window={window}
        stats={stats}
        chartPoints={chartPoints}
      />
      <PeerComparison peer={peer} />
      <Definitions model={model} />
    </section>
  )
}

/* ------------------------------------------------------------------ */
/* 1. 現在の評価                                                        */
/* ------------------------------------------------------------------ */

function CurrentValuation({ model }: { model: ValuationDetailReadModel }) {
  const visibleSecondary = model.current.secondary
  return (
    <PanelSection
      icon={CircleGauge}
      id="current-valuation-title"
      title="現在の評価"
      lead="同じ基準日の事実を表示。評価の断定ではありません"
      bleed
    >
      <div className="grid grid-cols-2 gap-px bg-[var(--color-border-soft)] md:grid-cols-4">
        {model.current.primary.map((value, index) => (
          <article key={value.metric} className="min-h-20 bg-white px-3 py-3 md:px-4">
            <div className="text-[12px] font-bold text-[var(--color-text-secondary)]">{value.label}</div>
            <div className="mt-0.5 text-[11px] font-medium text-[var(--color-text-tertiary)]">
              {index === 0 ? '会社予想ベース' : value.metric === 'fcf_yield' ? '標準FCFベース' : '現在値'}
            </div>
            <div className={`mt-1.5 font-mono ${value.availability === 'available' ? 'text-[20px] font-black text-[var(--color-text-primary)]' : 'text-[13px] font-semibold text-[var(--color-text-tertiary)]'}`}>{valueText(value)}</div>
            <div className="mt-0.5 break-words text-[11px] font-medium leading-4 text-[var(--color-text-tertiary)]">
              {value.availability === 'available'
                ? value.flags.includes('negative_fcf') ? '負のFCF' : value.periodEnd ?? model.priceDate ?? ''
                : value.reason}
            </div>
          </article>
        ))}
      </div>
      {visibleSecondary.length > 0 && (
        <dl className="m-0 grid grid-cols-2 gap-x-6 gap-y-2.5 border-t border-[var(--color-border-soft)] px-4 py-3 sm:grid-cols-3 sm:px-5 lg:grid-cols-4">
          {visibleSecondary.map((value) => (
            <div key={value.metric} className="min-w-0" title={value.reason ?? undefined}>
              <dt className="text-[11px] font-semibold text-[var(--color-text-tertiary)]">{value.label}</dt>
              <dd className="m-0 font-mono text-[13px] font-bold text-[var(--color-text-primary)]">{valueText(value)}</dd>
              {value.availability !== 'available' && value.reason && <div className="mt-0.5 break-words text-[11px] font-medium leading-4 text-[var(--color-text-tertiary)]">{value.reason}</div>}
            </div>
          ))}
        </dl>
      )}
      {model.current.cautions.length > 0 && (
        <div className="space-y-1 border-t border-[var(--color-border-default)] px-4 py-2.5 sm:px-5">
          {model.current.cautions.map((caution) => (
            <p key={caution} className="flex items-start gap-1.5 text-[12px] font-medium leading-5 text-[var(--color-text-secondary)]">
              <Info size={12} className="mt-1 shrink-0" aria-hidden="true" />
              {caution}
            </p>
          ))}
        </div>
      )}
    </PanelSection>
  )
}

/* ------------------------------------------------------------------ */
/* 2. 位置の一覧: 現在値 × 自社過去 × 同業                               */
/* ------------------------------------------------------------------ */

function PositionOverview({
  model,
  window,
  onWindowChange,
  taxonomy,
  onTaxonomyChange,
  selectedMetric,
  onSelectMetric,
}: {
  model: ValuationDetailReadModel
  window: ValuationHistoryWindow
  onWindowChange: (window: ValuationHistoryWindow) => void
  taxonomy: Taxonomy
  onTaxonomyChange: (taxonomy: Taxonomy) => void
  selectedMetric: ValuationHistoryMetric
  onSelectMetric: (metric: ValuationHistoryMetric) => void
}) {
  const peer = model.peers[taxonomy]
  return (
    <PanelSection
      icon={Layers}
      id="valuation-position-title"
      title="自社過去と同業の中での位置"
      lead="指標ごとに「現在値 → 自社の過去レンジ → 同業の分布」を1行で比較。大小は優劣を意味しません"
      bleed
      aside={(
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Segmented label="自社過去" options={HISTORY_WINDOWS} value={window} onChange={onWindowChange} />
          <Segmented label="同業" options={TAXONOMY_OPTIONS} value={taxonomy} onChange={onTaxonomyChange} />
        </div>
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-4 py-2 text-[12px] sm:px-5">
        <span className="min-w-0">
          <span className="font-semibold text-[var(--color-text-tertiary)]">{peer.label}</span>
          <strong className="ml-2 font-bold text-[var(--color-text-primary)]">{peer.groupName ?? '未分類'}</strong>
        </span>
        <span className="font-mono text-[11px] font-bold text-[var(--color-text-tertiary)]">対象 {peer.peerCount}銘柄</span>
      </div>
      <ul className="m-0 list-none divide-y divide-[var(--color-border-soft)] p-0" aria-label="指標別の位置">
        {VALUATION_HISTORY_METRICS.map((metric) => (
          <PositionRow
            key={metric}
            model={model}
            metric={metric}
            window={window}
            peer={peer}
            active={selectedMetric === metric}
            onSelect={() => onSelectMetric(metric)}
          />
        ))}
      </ul>
      <p className="border-t border-[var(--color-border-soft)] px-4 py-2 text-[11px] font-medium leading-5 text-[var(--color-text-tertiary)] sm:px-5">
        自社過去=各時点で公表済みの財務・予想だけで再計算した月末値の5%点〜95%点の帯。同業=25%点〜75%点の帯(矢印は帯の外)。{UNAVAILABLE_LEGEND}。
      </p>
    </PanelSection>
  )
}

function PositionRow({
  model,
  metric,
  window,
  peer,
  active,
  onSelect,
}: {
  model: ValuationDetailReadModel
  metric: ValuationHistoryMetric
  window: ValuationHistoryWindow
  peer: ValuationPeerGroup
  active: boolean
  onSelect: () => void
}) {
  const history = model.history[metric]
  const stats = history.statistics[window]
  const current = history.current
  const peerRow: ValuationPeerMetricComparison | null = VALUATION_PEER_METRICS.includes(metric as ValuationPeerMetric)
    ? peer.metrics[metric as ValuationPeerMetric]
    : null
  const available = current.availability === 'available' && stats.current != null
  const ownDirection = directionFromMedianComparison(stats.medianComparison)
  const peerDirection = peerRow && peerRow.displayable ? directionFromMedianComparison(peerRow.medianComparison) : null
  const label = windowLabel(window)

  return (
    <li className={`grid gap-x-6 gap-y-3 px-4 py-3 sm:px-5 lg:grid-cols-[170px_minmax(0,1fr)_minmax(0,1fr)] ${active ? 'bg-[var(--color-brand-50)]' : 'bg-white'}`} data-valuation-metric={metric}>
      <div className="min-w-0">
        <div className="flex items-center justify-between gap-2 lg:block">
          <span className="text-[13px] font-bold text-[var(--color-text-primary)]">{history.label}</span>
          <button
            type="button"
            onClick={onSelect}
            aria-pressed={active}
            className="inline-flex min-h-11 items-center px-1 text-[12px] font-bold text-[var(--color-brand-700)] hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-brand-700)] sm:min-h-8 lg:-ml-1"
          >
            {active ? '履歴グラフに表示中' : '履歴グラフで見る'}
          </button>
        </div>
        <Fact
          label="現在値"
          value={valueText(current)}
          unavailable={current.availability !== 'available'}
          emphasis
          sub={current.availability === 'available' ? (current.flags.includes('negative_fcf') ? '負のFCF' : current.periodEnd) : current.reason}
        />
      </div>

      <div className="min-w-0">
        <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-2 text-[11px] font-bold text-[var(--color-text-secondary)]">
          <span>自社過去{label}</span>
          {available && stats.percentile != null && <span className="font-mono font-semibold text-[var(--color-text-tertiary)]">過去{label}の{stats.percentile.toFixed(0)}%水準</span>}
        </div>
        {available && stats.displayMinimum != null && stats.displayMaximum != null ? (
          <>
            {ownDirection && (
              <p className="mb-1 flex items-center gap-1 text-[12px] font-bold leading-5 text-[var(--color-text-primary)]">
                <DirectionMark direction={ownDirection} />
                自社の中央値{medianWord(ownDirection)}
                <span className="font-mono text-[11px] font-medium text-[var(--color-text-tertiary)]" title={comparisonReason(stats.medianComparison) ?? undefined}>
                  ({comparisonLabel(stats.medianComparison)} {comparisonText(stats.medianComparison, history.unit)})
                </span>
              </p>
            )}
            <RangeRuler
              low={stats.displayMinimum}
              high={stats.displayMaximum}
              current={stats.current}
              median={stats.median}
              lowText={`5% ${metricNumber(stats.displayMinimum, history.unit)}`}
              highText={`95% ${metricNumber(stats.displayMaximum, history.unit)}`}
              medianText={`中央値 ${metricNumber(stats.median, history.unit)}`}
              currentText={metricNumber(stats.current, history.unit)}
              ariaLabel={`${history.label} 現在 ${metricNumber(stats.current, history.unit)}、過去${label}の5%点から95%点の帯の中の位置`}
            />
            {!stats.fullWindow && <div className="mt-1"><Pill tone="notice">観測期間が{label}未満</Pill></div>}
          </>
        ) : (
          <p className="text-[12px] font-medium leading-5 text-[var(--color-text-tertiary)]">
            {current.availability !== 'available' ? `現在値が${availabilityText(current.availability)}のため、過去レンジとは比べません。` : '過去履歴(PIT)が不足しているため表示できません。'}
          </p>
        )}
      </div>

      <div className="min-w-0">
        <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-2 text-[11px] font-bold text-[var(--color-text-secondary)]">
          <span>同業 {peer.groupName ?? '未分類'}</span>
          {peerRow && peerRow.displayable && <span className="font-mono font-semibold text-[var(--color-text-tertiary)]">有効 {peerRow.validCount}/{peerRow.peerCount}</span>}
        </div>
        {!peerRow ? (
          <p className="text-[12px] font-medium leading-5 text-[var(--color-text-tertiary)]">この指標は同業比較の対象に含めていません。</p>
        ) : !peerRow.displayable ? (
          <p className="text-[12px] font-medium leading-5 text-[var(--color-text-tertiary)]">{peerRow.reason ?? '有効な母数が不足しているため、同業比較は表示しません。'}</p>
        ) : (
          <>
            {peerDirection && (
              <p className="mb-1 flex items-center gap-1 text-[12px] font-bold leading-5 text-[var(--color-text-primary)]">
                <DirectionMark direction={peerDirection} />
                同業の中央値{medianWord(peerDirection)}
                <span className="font-mono text-[11px] font-medium text-[var(--color-text-tertiary)]" title={comparisonReason(peerRow.medianComparison) ?? undefined}>
                  ({comparisonLabel(peerRow.medianComparison)} {comparisonText(peerRow.medianComparison, peerRow.unit)})
                </span>
              </p>
            )}
            <PeerBand
              label={history.label}
              p25={peerRow.percentile25}
              median={peerRow.median}
              p75={peerRow.percentile75}
              target={peerRow.target.value}
              targetText={metricNumber(peerRow.target.value, peerRow.unit)}
              medianText={metricNumber(peerRow.median, peerRow.unit)}
            />
            <div className="mt-0.5 flex flex-wrap justify-between gap-x-3 font-mono text-[11px] text-[var(--color-text-tertiary)]">
              <span>25%点 {metricNumber(peerRow.percentile25, peerRow.unit)}</span>
              <span>中央値 {metricNumber(peerRow.median, peerRow.unit)}</span>
              <span>75%点 {metricNumber(peerRow.percentile75, peerRow.unit)}</span>
            </div>
          </>
        )}
      </div>
    </li>
  )
}

/* ------------------------------------------------------------------ */
/* 3. 自社過去レンジの詳細                                              */
/* ------------------------------------------------------------------ */

function HistoricalRange({
  model,
  metric,
  onMetricChange,
  window,
  stats,
  chartPoints,
}: {
  model: ValuationDetailReadModel
  metric: ValuationHistoryMetric
  onMetricChange: (metric: ValuationHistoryMetric) => void
  window: ValuationHistoryWindow
  stats: ValuationRangeStatistics
  chartPoints: ValuationDetailReadModel['history'][ValuationHistoryMetric]['points']
}) {
  const selected = model.history[metric]
  const peerMedian = VALUATION_PEER_METRICS.includes(metric as ValuationPeerMetric)
    ? model.peers.sector33.metrics[metric as ValuationPeerMetric].median
    : null
  const label = windowLabel(window)
  return (
    <PanelSection
      icon={History}
      id="valuation-history-title"
      title="自社過去レンジの詳細"
      lead={`${selected.label}の推移(過去${label})。各時点で公表済みだった財務・予想だけを使用。期間は上の「自社過去」で切り替え`}
      bleed
    >
      <TabSwitch
        label="履歴の指標"
        options={VALUATION_HISTORY_METRICS.map((option) => ({ value: option, label: model.history[option].label }))}
        value={metric}
        onChange={onMetricChange}
      />
      <div className="grid lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 px-3 py-3 sm:px-4">
          <div className="h-44 sm:h-56">
            {chartPoints.length > 1 ? (
              <MeasuredChartFrame className="h-full">
                {({ width, height }) => (
                  <LineChart width={width} height={height} data={chartPoints} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                    <CartesianGrid stroke="var(--color-border-soft)" vertical={false} />
                    <XAxis dataKey="date" tick={{ fontSize: 11, fill: 'var(--color-text-tertiary)' }} minTickGap={44} tickFormatter={(value) => String(value).slice(2, 7)} />
                    <YAxis tick={{ fontSize: 11, fill: 'var(--color-text-tertiary)' }} width={44} domain={['auto', 'auto']} tickFormatter={(value) => Number(value).toFixed(1)} />
                    <Tooltip
                      labelFormatter={(label) => String(label)}
                      formatter={(value) => [metricNumber(Number(value), selected.unit), selected.label]}
                      contentStyle={{ fontSize: 11, borderRadius: 0 }}
                    />
                    {stats.median != null && <ReferenceLine y={stats.median} stroke="var(--color-text-tertiary)" strokeDasharray="4 3" />}
                    <Line type="monotone" dataKey="value" stroke="var(--color-brand-700)" strokeWidth={1.8} dot={false} isAnimationActive={false} />
                  </LineChart>
                )}
              </MeasuredChartFrame>
            ) : (
              <div className="grid h-full place-items-center px-4 text-center text-[12px] font-semibold text-[var(--color-text-tertiary)]">PIT履歴が不足しています。</div>
            )}
          </div>
          <p className="mt-1 text-[11px] font-medium text-[var(--color-text-tertiary)]">破線=過去{label}の中央値</p>
        </div>
        <aside className="space-y-3 border-t border-[var(--color-border-soft)] bg-white px-4 py-4 sm:px-5 lg:border-l lg:border-t-0">
          <div>
            <div className="text-[11px] font-semibold text-[var(--color-text-tertiary)]">{selected.label}の現在位置</div>
            <div className="mt-1 font-mono text-[26px] font-semibold leading-none text-[var(--color-text-primary)]">{metricNumber(stats.current, selected.unit)}</div>
            <div className="mt-2.5 space-y-1 text-[12px] font-medium text-[var(--color-text-secondary)]">
              <p>{label}中央値 <b className="font-mono">{metricNumber(stats.median, selected.unit)}</b></p>
              <p>33業種中央値 <b className="font-mono">{metricNumber(peerMedian, selected.unit)}</b></p>
              <p>過去{label}の <b className="font-mono">{stats.percentile == null ? unavailableLabel('missing') : `${stats.percentile.toFixed(0)}%`}</b> 水準</p>
            </div>
          </div>
          <RangeRuler
            low={stats.displayMinimum}
            high={stats.displayMaximum}
            current={stats.current}
            median={stats.median}
            lowText={`5% ${metricNumber(stats.displayMinimum, selected.unit)}`}
            highText={`95% ${metricNumber(stats.displayMaximum, selected.unit)}`}
            currentText={metricNumber(stats.current, selected.unit)}
            ariaLabel="過去レンジ内の現在位置"
          />
          <div className="grid grid-cols-2 gap-x-4 gap-y-2">
            <Fact label={comparisonLabel(stats.medianComparison)} value={comparisonText(stats.medianComparison, selected.unit)} />
            <Fact label="実際の最小値" value={metricNumber(stats.minimum, selected.unit)} />
            <Fact label="実際の最大値" value={metricNumber(stats.maximum, selected.unit)} />
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Pill>観測 n={stats.observationCount.toLocaleString()}</Pill>
            {!stats.fullWindow && <Pill tone="notice">観測期間が限定的</Pill>}
          </div>
          <p className="text-[11px] font-medium leading-4 text-[var(--color-text-tertiary)]">
            {stats.observationStartDate ? `${stats.observationStartDate}〜${stats.observationEndDate}` : ''}
            {!stats.fullWindow ? ` / ${label}未満` : ''}
          </p>
          {selected.note && <p className="text-[12px] font-semibold text-[var(--color-text-secondary)]">{selected.note}</p>}
        </aside>
      </div>
    </PanelSection>
  )
}

/* ------------------------------------------------------------------ */
/* 4. 同業の分布表                                                      */
/* ------------------------------------------------------------------ */

function PeerComparison({ peer }: { peer: ValuationPeerGroup }) {
  const rows = VALUATION_PEER_METRICS.map((metric) => peer.metrics[metric]).filter((row) => row.displayable)
  const hiddenEv = !peer.metrics.ev_ebitda.displayable
  return (
    <PanelSection
      icon={Users}
      id="valuation-peers-title"
      title="同業の分布(数値表)"
      lead={`${peer.label} ${peer.groupName ?? '未分類'}・対象${peer.peerCount}銘柄。数値の高低を割安・割高とは断定しません`}
      bleed
    >
      {rows.length === 0 ? (
        <div className="px-4 py-3 sm:px-5"><UnavailableNote>この区分では同業比較に必要な有効母数がありません。</UnavailableNote></div>
      ) : (
        <>
          <ul className="m-0 list-none divide-y divide-[var(--color-border-soft)] p-0 md:hidden" aria-label="同業比較(カード表示)">
            {rows.map((row) => (
              <li key={row.metric} className="px-4 py-3">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[13px] font-black text-[var(--color-text-primary)]">{row.label}</span>
                  <span className="font-mono text-[11px] text-[var(--color-text-tertiary)]">有効 {row.validCount}/{row.peerCount}</span>
                </div>
                <dl className="m-0 mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1.5">
                  <PeerCell label="対象銘柄" value={valueText(row.target)} strong />
                  <PeerCell label="中央値" value={metricNumber(row.median, row.unit)} strong />
                  <PeerCell label="25%点" value={metricNumber(row.percentile25, row.unit)} />
                  <PeerCell label="75%点" value={metricNumber(row.percentile75, row.unit)} />
                  <PeerCell label="業種内位置" value={row.targetPercentile == null ? unavailableLabel('missing') : `${row.targetPercentile.toFixed(0)}%`} />
                  <PeerCell label={comparisonLabel(row.medianComparison)} value={comparisonText(row.medianComparison, row.unit)} />
                </dl>
              </li>
            ))}
          </ul>
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full min-w-[720px] border-collapse text-[12px]">
              <thead className="bg-white text-[var(--color-text-tertiary)]">
                <tr>
                  <th className="border-b border-[var(--color-border-default)] px-3 py-2 text-left">指標</th>
                  <th className="border-b border-[var(--color-border-default)] px-3 py-2 text-right">対象銘柄</th>
                  <th className="border-b border-[var(--color-border-default)] px-3 py-2 text-right">25%点</th>
                  <th className="border-b border-[var(--color-border-default)] px-3 py-2 text-right">中央値</th>
                  <th className="border-b border-[var(--color-border-default)] px-3 py-2 text-right">75%点</th>
                  <th className="border-b border-[var(--color-border-default)] px-3 py-2 text-right">業種内位置</th>
                  <th className="border-b border-[var(--color-border-default)] px-3 py-2 text-right">中央値との比較</th>
                  <th className="border-b border-[var(--color-border-default)] px-3 py-2 text-right">有効母数</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.metric} className="border-b border-[var(--color-border-soft)] last:border-b-0">
                    <th className="px-3 py-2 text-left font-black text-[var(--color-text-primary)]">{row.label}</th>
                    <td className="px-3 py-2 text-right font-mono font-black">{valueText(row.target)}</td>
                    <td className="px-3 py-2 text-right font-mono">{metricNumber(row.percentile25, row.unit)}</td>
                    <td className="px-3 py-2 text-right font-mono font-black">{metricNumber(row.median, row.unit)}</td>
                    <td className="px-3 py-2 text-right font-mono">{metricNumber(row.percentile75, row.unit)}</td>
                    <td className="px-3 py-2 text-right font-mono">{row.targetPercentile == null ? unavailableLabel('missing') : `${row.targetPercentile.toFixed(0)}%`}</td>
                    <td className="px-3 py-2 text-right font-mono" title={comparisonReason(row.medianComparison) ?? undefined}>
                      <span className="block text-[11px] font-semibold text-[var(--color-text-tertiary)]">{comparisonLabel(row.medianComparison)}</span>
                      {comparisonText(row.medianComparison, row.unit)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">{row.validCount}/{row.peerCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {hiddenEv && (
        <p className="border-t border-[var(--color-border-soft)] px-4 py-2 text-[12px] font-medium text-[var(--color-text-tertiary)] sm:px-5">
          EV/EBITDAは有効値8銘柄以上かつカバレッジ25%以上の場合だけ比較へ表示します。
        </p>
      )}
      <p className="border-t border-[var(--color-border-soft)] px-4 py-2 text-[11px] font-medium leading-5 text-[var(--color-text-tertiary)] sm:px-5">
        {UNAVAILABLE_LEGEND}。負値・0近傍・符号跨ぎは比率ではなく差で表示します。
      </p>
    </PanelSection>
  )
}

function PeerCell({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium text-[var(--color-text-tertiary)]">{label}</dt>
      <dd className={`m-0 font-mono ${strong ? 'text-[14px] font-black' : 'text-[13px] font-bold'} text-[var(--color-text-primary)]`}>{value}</dd>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 5. 定義                                                              */
/* ------------------------------------------------------------------ */

function Definitions({ model }: { model: ValuationDetailReadModel }) {
  const metrics = [...new Set([
    ...VALUATION_HISTORY_METRICS,
    'dividend_yield',
    'net_debt',
    'roe',
    'revenue_growth',
  ] as Array<keyof ValuationDetailReadModel['definitions']>)]
  return (
    <details className="border-y border-[var(--color-border-soft)] bg-white">
      <summary className="flex min-h-11 cursor-pointer items-center px-4 text-[12px] font-bold text-[var(--color-text-secondary)] sm:px-5">指標の定義とデータソース</summary>
      <div className="grid border-t border-[var(--color-border-default)] md:grid-cols-2">
        {metrics.map((metric) => {
          const definition = model.definitions[metric]
          return (
            <div key={metric} className="border-b border-[var(--color-border-soft)] px-4 py-3 odd:md:border-r">
              <div className="text-[12px] font-bold text-[var(--color-text-primary)]">{definition.displayName}</div>
              <div className="mt-1 text-[12px] leading-5 text-[var(--color-text-secondary)]">{definition.formula}</div>
              <div className="mt-1 font-mono text-[11px] text-[var(--color-text-tertiary)]">{definition.dataSource} / {definition.version}</div>
            </div>
          )
        })}
      </div>
    </details>
  )
}
