'use client'

import { useEffect, useMemo, useState } from 'react'
import { CircleGauge, History, Info, Scale, Users } from 'lucide-react'
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import {
  VALUATION_HISTORY_METRICS,
  VALUATION_PEER_METRICS,
  type ValuationAvailability,
  type ValuationDetailReadModel,
  type ValuationHistoryMetric,
  type ValuationHistoryWindow,
  type ValuationPeerGroup,
  type ValuationPeerMetric,
  type ValuationRangeStatistics,
  type ValuationValue,
} from '@/lib/valuation-detail'

interface ValuationDetailProps {
  ticker: string
  analysisDate: string | null
}

const HISTORY_WINDOWS: Array<{ value: ValuationHistoryWindow; label: string }> = [
  { value: '3y', label: '3年' },
  { value: '5y', label: '5年' },
  { value: '10y', label: '10年' },
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
  if (value == null) return '—'
  if (unit === 'MULTIPLE') return `${value.toFixed(2)}x`
  if (unit === 'PERCENT') return `${value.toFixed(2)}%`
  if (unit === 'JPY') return compactNumber(value)
  return value.toLocaleString('ja-JP', { maximumFractionDigits: 2 })
}

function availabilityText(availability: ValuationAvailability): string {
  if (availability === 'not_applicable') return 'N/A'
  if (availability === 'not_meaningful') return 'N/M'
  return '—'
}

function valueText(value: ValuationValue): string {
  return value.availability === 'available'
    ? metricNumber(value.value, value.unit)
    : availabilityText(value.availability)
}

function signedPercent(value: number | null): string {
  if (value == null) return '—'
  return `${value > 0 ? '+' : ''}${value.toFixed(1)}%`
}

function RangeBar({ stats, unit }: { stats: ValuationRangeStatistics; unit: string }) {
  const low = stats.displayMinimum
  const high = stats.displayMaximum
  const current = stats.current
  const position = low != null && high != null && current != null && high > low
    ? Math.max(0, Math.min(100, 100 * (current - low) / (high - low)))
    : null
  return (
    <div className="space-y-1.5">
      <div className="relative h-2 bg-[var(--color-surface-muted)]" aria-label="過去レンジ内の現在位置">
        <div className="absolute inset-y-0 left-0 right-0 bg-[var(--color-brand-100)]" />
        {position != null && (
          <span
            className="absolute top-1/2 h-4 w-1 -translate-x-1/2 -translate-y-1/2 bg-[var(--color-brand-900)]"
            style={{ left: `${position}%` }}
          />
        )}
      </div>
      <div className="flex justify-between font-mono text-[8px] font-bold text-[var(--color-text-tertiary)]">
        <span>5% {metricNumber(low, unit)}</span>
        <span>95% {metricNumber(high, unit)}</span>
      </div>
    </div>
  )
}

export function ValuationDetail({ ticker, analysisDate }: ValuationDetailProps) {
  const [model, setModel] = useState<ValuationDetailReadModel | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [metric, setMetric] = useState<ValuationHistoryMetric>('forward_per')
  const [window, setWindow] = useState<ValuationHistoryWindow>('5y')
  const [taxonomy, setTaxonomy] = useState<'sector33' | 'custom60'>('sector33')

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
  }, [analysisDate, ticker])

  const selected = model?.history[metric] ?? null
  const stats = selected?.statistics[window] ?? null
  const startDate = stats?.observationStartDate ?? ''
  const chartPoints = useMemo(() => selected?.points.filter((point) => point.date >= startDate) ?? [], [selected, startDate])
  const peer = model?.peers[taxonomy] ?? null

  if (loading) {
    return <div className="grid min-h-80 place-items-center border border-[var(--color-border-default)] bg-white text-[11px] font-bold text-[var(--color-text-tertiary)]">Valuationを読み込んでいます...</div>
  }
  if (error || !model || !selected || !stats || !peer) {
    return <div className="grid min-h-48 place-items-center border border-[var(--color-border-default)] bg-white px-4 text-center text-[11px] font-bold text-[var(--color-text-tertiary)]">Valuationを取得できませんでした。</div>
  }

  return (
    <section className="space-y-3" aria-labelledby="valuation-detail-title">
      <header className="flex flex-wrap items-start justify-between gap-2 border border-[var(--color-border-default)] bg-[var(--color-brand-50)] px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Scale size={17} className="shrink-0 text-[var(--color-brand-700)]" aria-hidden="true" />
          <div>
            <h2 id="valuation-detail-title" className="text-[13px] font-black text-[var(--color-brand-900)]">Valuation</h2>
            <p className="text-[9px] font-semibold text-[var(--color-text-tertiary)]">現在の評価 → 自社過去 → 同業比較</p>
          </div>
        </div>
        <div className="text-right font-mono text-[9px] font-bold text-[var(--color-text-tertiary)]">
          <div>分析基準日 {model.asOf}</div>
          <div>価格日 {model.priceDate ?? '—'}</div>
        </div>
      </header>

      <CurrentValuation model={model} />
      <HistoricalRange
        model={model}
        metric={metric}
        onMetricChange={setMetric}
        window={window}
        onWindowChange={setWindow}
        stats={stats}
        chartPoints={chartPoints}
      />
      <PeerComparison peer={peer} taxonomy={taxonomy} onTaxonomyChange={setTaxonomy} />
      <Definitions model={model} />
    </section>
  )
}

function CurrentValuation({ model }: { model: ValuationDetailReadModel }) {
  const visibleSecondary = model.current.secondary.filter((value) => value.availability !== 'missing')
  return (
    <section className="overflow-hidden border border-[var(--color-border-default)] bg-white" aria-labelledby="current-valuation-title">
      <SectionHeading icon={CircleGauge} id="current-valuation-title" title="現在の評価" subtitle="評価の断定ではなく、同じ基準日の事実を表示" />
      <div className="grid grid-cols-2 gap-px bg-[var(--color-border-soft)] md:grid-cols-4">
        {model.current.primary.map((value, index) => (
          <article key={value.metric} className="min-h-20 bg-white px-3 py-2.5 md:min-h-24 md:px-4">
            <div>
              <div className="text-[9px] font-black text-[var(--color-text-secondary)]">{value.label}</div>
              <div className="mt-0.5 text-[8px] font-semibold text-[var(--color-text-tertiary)]">
                {index === 0 ? '会社予想ベース' : value.metric === 'fcf_yield' ? '標準FCFベース' : '現在値'}
              </div>
            </div>
            <div className="mt-1.5 text-left md:mt-2">
              <div className="font-mono text-[17px] font-black text-[var(--color-text-primary)] md:text-[18px]">{valueText(value)}</div>
              <div className="max-w-52 text-[8px] font-semibold text-[var(--color-text-tertiary)] md:max-w-none">
                {value.availability === 'available'
                  ? value.flags.includes('negative_fcf') ? '負のFCF' : value.periodEnd ?? model.priceDate ?? ''
                  : value.reason}
              </div>
            </div>
          </article>
        ))}
      </div>
      {visibleSecondary.length > 0 && (
        <div className="flex flex-wrap gap-x-5 gap-y-2 border-t border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-4 py-2.5">
          {visibleSecondary.map((value) => (
            <div key={value.metric} className="flex min-w-32 items-baseline justify-between gap-2 md:block">
              <span className="text-[8px] font-bold text-[var(--color-text-tertiary)]">{value.label}</span>
              <strong className="font-mono text-[11px] text-[var(--color-text-primary)]">{valueText(value)}</strong>
            </div>
          ))}
        </div>
      )}
      {model.current.cautions.length > 0 && (
        <div className="border-t border-[var(--color-border-default)] px-4 py-2">
          {model.current.cautions.map((caution) => (
            <p key={caution} className="flex items-start gap-1.5 text-[8px] font-semibold text-[var(--color-text-secondary)]">
              <Info size={11} className="mt-0.5 shrink-0" aria-hidden="true" />
              {caution}
            </p>
          ))}
        </div>
      )}
    </section>
  )
}

function HistoricalRange({
  model,
  metric,
  onMetricChange,
  window,
  onWindowChange,
  stats,
  chartPoints,
}: {
  model: ValuationDetailReadModel
  metric: ValuationHistoryMetric
  onMetricChange: (metric: ValuationHistoryMetric) => void
  window: ValuationHistoryWindow
  onWindowChange: (window: ValuationHistoryWindow) => void
  stats: ValuationRangeStatistics
  chartPoints: ValuationDetailReadModel['history'][ValuationHistoryMetric]['points']
}) {
  const selected = model.history[metric]
  const peerMedian = VALUATION_PEER_METRICS.includes(metric as ValuationPeerMetric)
    ? model.peers.sector33.metrics[metric as ValuationPeerMetric].median
    : null
  return (
    <section className="overflow-hidden border border-[var(--color-border-default)] bg-white" aria-labelledby="valuation-history-title">
      <SectionHeading icon={History} id="valuation-history-title" title="自社過去レンジ" subtitle="各時点で公表済みだった財務・予想だけを使用" />
      <div className="flex gap-1 overflow-x-auto border-t border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-2 py-1.5">
        {VALUATION_HISTORY_METRICS.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => onMetricChange(option)}
            className={`h-7 shrink-0 border px-2.5 text-[9px] font-black ${metric === option ? 'border-[var(--color-brand-700)] bg-white text-[var(--color-brand-900)]' : 'border-transparent text-[var(--color-text-secondary)]'}`}
          >
            {model.history[option].label}
          </button>
        ))}
      </div>
      <div className="grid lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 px-3 py-3 sm:px-4">
          <div className="mb-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="grid w-full grid-cols-3 gap-x-3 gap-y-1 sm:w-auto sm:gap-x-5">
              <CompactStat label="現在" value={metricNumber(stats.current, selected.unit)} strong />
              <CompactStat label={`${HISTORY_WINDOWS.find((item) => item.value === window)?.label}中央値`} value={metricNumber(stats.median, selected.unit)} />
              <CompactStat label="33業種中央値" value={metricNumber(peerMedian, selected.unit)} />
            </div>
            <div className="flex shrink-0 self-end border border-[var(--color-border-default)] sm:self-auto">
              {HISTORY_WINDOWS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => onWindowChange(option.value)}
                  className={`h-7 px-2 text-[8px] font-black ${window === option.value ? 'bg-[var(--color-brand-900)] text-white' : 'bg-white text-[var(--color-text-secondary)]'}`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          <div className="h-40 sm:h-52">
            {chartPoints.length > 1 ? (
              <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={160}>
                <LineChart data={chartPoints} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke="var(--color-border-soft)" vertical={false} />
                  <XAxis dataKey="date" tick={{ fontSize: 8 }} minTickGap={44} tickFormatter={(value) => String(value).slice(2, 7)} />
                  <YAxis tick={{ fontSize: 8 }} width={40} domain={['auto', 'auto']} tickFormatter={(value) => Number(value).toFixed(1)} />
                  <Tooltip
                    labelFormatter={(label) => String(label)}
                    formatter={(value) => [metricNumber(Number(value), selected.unit), selected.label]}
                    contentStyle={{ fontSize: 10, borderRadius: 0 }}
                  />
                  {stats.median != null && <ReferenceLine y={stats.median} stroke="var(--color-text-tertiary)" strokeDasharray="4 3" />}
                  <Line type="monotone" dataKey="value" stroke="var(--color-brand-700)" strokeWidth={1.8} dot={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="grid h-full place-items-center text-[9px] font-semibold text-[var(--color-text-tertiary)]">PIT履歴が不足しています。</div>
            )}
          </div>
        </div>
        <aside className="space-y-3 border-t border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-4 py-3 lg:border-l lg:border-t-0">
          <RangeBar stats={stats} unit={selected.unit} />
          <div className="grid grid-cols-2 gap-x-4 gap-y-2">
            <CompactStat label="現在Percentile" value={stats.percentile == null ? '—' : `${stats.percentile.toFixed(0)}%`} strong />
            <CompactStat label="中央値比" value={signedPercent(stats.versusMedianPercent)} />
            <CompactStat label="実際の最小値" value={metricNumber(stats.minimum, selected.unit)} />
            <CompactStat label="実際の最大値" value={metricNumber(stats.maximum, selected.unit)} />
          </div>
          <p className="text-[8px] font-semibold leading-relaxed text-[var(--color-text-tertiary)]">
            {stats.observationCount.toLocaleString()}営業日
            {stats.observationStartDate ? ` / ${stats.observationStartDate}〜${stats.observationEndDate}` : ''}
            {!stats.fullWindow ? ` / ${HISTORY_WINDOWS.find((item) => item.value === window)?.label}未満` : ''}
          </p>
          {selected.note && <p className="text-[8px] font-bold text-[var(--color-text-secondary)]">{selected.note}</p>}
        </aside>
      </div>
    </section>
  )
}

function PeerComparison({
  peer,
  taxonomy,
  onTaxonomyChange,
}: {
  peer: ValuationPeerGroup
  taxonomy: 'sector33' | 'custom60'
  onTaxonomyChange: (taxonomy: 'sector33' | 'custom60') => void
}) {
  const rows = VALUATION_PEER_METRICS.map((metric) => peer.metrics[metric]).filter((row) => row.displayable)
  const hiddenEv = !peer.metrics.ev_ebitda.displayable
  return (
    <section className="overflow-hidden border border-[var(--color-border-default)] bg-white" aria-labelledby="valuation-peers-title">
      <SectionHeading icon={Users} id="valuation-peers-title" title="同業比較" subtitle="数値の高低を割安・割高とは断定しません">
        <div className="flex border border-[var(--color-border-default)]">
          {(['sector33', 'custom60'] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => onTaxonomyChange(option)}
              className={`h-7 px-2.5 text-[8px] font-black ${taxonomy === option ? 'bg-[var(--color-brand-900)] text-white' : 'bg-white text-[var(--color-text-secondary)]'}`}
            >
              {option === 'sector33' ? '33業種' : '独自60分類'}
            </button>
          ))}
        </div>
      </SectionHeading>
      <div className="flex items-center justify-between gap-2 border-t border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-4 py-2">
        <div className="min-w-0">
          <span className="text-[8px] font-bold text-[var(--color-text-tertiary)]">{peer.label}</span>
          <strong className="ml-2 text-[10px] font-black text-[var(--color-text-primary)]">{peer.groupName ?? '未分類'}</strong>
        </div>
        <span className="shrink-0 font-mono text-[9px] font-bold text-[var(--color-text-tertiary)]">対象 {peer.peerCount}銘柄</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] border-collapse text-[9px]">
          <thead className="bg-white text-[var(--color-text-tertiary)]">
            <tr>
              <th className="border-b border-[var(--color-border-default)] px-3 py-2 text-left">指標</th>
              <th className="border-b border-[var(--color-border-default)] px-3 py-2 text-right">対象銘柄</th>
              <th className="border-b border-[var(--color-border-default)] px-3 py-2 text-right">25 percentile</th>
              <th className="border-b border-[var(--color-border-default)] px-3 py-2 text-right">中央値</th>
              <th className="border-b border-[var(--color-border-default)] px-3 py-2 text-right">75 percentile</th>
              <th className="border-b border-[var(--color-border-default)] px-3 py-2 text-right">業種内位置</th>
              <th className="border-b border-[var(--color-border-default)] px-3 py-2 text-right">中央値比</th>
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
                <td className="px-3 py-2 text-right font-mono">{row.targetPercentile == null ? '—' : `${row.targetPercentile.toFixed(0)}%`}</td>
                <td className="px-3 py-2 text-right font-mono">{signedPercent(row.versusMedianPercent)}</td>
                <td className="px-3 py-2 text-right font-mono">{row.validCount}/{row.peerCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hiddenEv && (
        <p className="border-t border-[var(--color-border-soft)] px-4 py-2 text-[8px] font-semibold text-[var(--color-text-tertiary)]">
          EV/EBITDAは有効値8銘柄以上かつカバレッジ25%以上の場合だけ比較表へ表示します。
        </p>
      )}
    </section>
  )
}

function Definitions({ model }: { model: ValuationDetailReadModel }) {
  const metrics = [...new Set([
    ...VALUATION_HISTORY_METRICS,
    'dividend_yield',
    'net_debt',
    'roe',
    'revenue_growth',
  ] as Array<keyof ValuationDetailReadModel['definitions']>)]
  return (
    <details className="border border-[var(--color-border-default)] bg-white">
      <summary className="cursor-pointer px-4 py-2.5 text-[9px] font-black text-[var(--color-text-secondary)]">指標の定義とデータソース</summary>
      <div className="grid border-t border-[var(--color-border-default)] md:grid-cols-2">
        {metrics.map((metric) => {
          const definition = model.definitions[metric]
          return (
            <div key={metric} className="border-b border-[var(--color-border-soft)] px-4 py-3 odd:md:border-r">
              <div className="text-[9px] font-black text-[var(--color-text-primary)]">{definition.displayName}</div>
              <div className="mt-1 text-[8px] leading-relaxed text-[var(--color-text-secondary)]">{definition.formula}</div>
              <div className="mt-1 font-mono text-[7px] text-[var(--color-text-tertiary)]">{definition.dataSource} / {definition.version}</div>
            </div>
          )
        })}
      </div>
    </details>
  )
}

function CompactStat({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-[7px] font-bold text-[var(--color-text-tertiary)]">{label}</div>
      <div className={`truncate font-mono font-black text-[var(--color-text-primary)] ${strong ? 'text-[13px]' : 'text-[10px]'}`}>{value}</div>
    </div>
  )
}

function SectionHeading({
  icon: Icon,
  id,
  title,
  subtitle,
  children,
}: {
  icon: typeof Scale
  id: string
  title: string
  subtitle: string
  children?: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
      <div className="flex min-w-0 items-center gap-2">
        <Icon size={14} className="shrink-0 text-[var(--color-brand-700)]" aria-hidden="true" />
        <div>
          <h3 id={id} className="text-[11px] font-black text-[var(--color-brand-900)]">{title}</h3>
          <p className="text-[8px] font-semibold text-[var(--color-text-tertiary)]">{subtitle}</p>
        </div>
      </div>
      {children}
    </div>
  )
}
