'use client'

import { useEffect, useMemo, useState } from 'react'
import { BarChart3, History, Table2, TrendingUp } from 'lucide-react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import {
  FINANCIAL_PERFORMANCE_DETAIL_METRICS,
  type FinancialForecastRevisionDirection,
  type FinancialForecastRevisionMetric,
  type FinancialPerformanceDetailMetric,
  type FinancialPerformanceDetailPeriod,
  type FinancialPerformanceDetailReadModel,
  type FinancialPerformanceSummaryValue,
} from '@/lib/financial-performance-detail'
import type { FinancialTimelineMode, FinancialTimelineValue } from '@/lib/financial-performance-timeline'

interface FinancialPerformanceDetailProps {
  ticker: string
  analysisDate: string | null
}

type TimelineRange = '3' | '5' | '10' | 'all'
type ProfitabilityView = 'margins' | 'returns'

interface ChartDatum {
  key: string
  label: string
  period: FinancialPerformanceDetailPeriod
  actual?: number
  currentForecast?: number
  nextForecast?: number
  grossMargin?: number
  operatingMargin?: number
  netMargin?: number
  roe?: number
  roa?: number
}

const MODE_OPTIONS: Array<{ value: FinancialTimelineMode; label: string }> = [
  { value: 'FY', label: 'FY' },
  { value: 'YTD', label: '四半期累積' },
  { value: 'STANDALONE', label: '四半期単独' },
  { value: 'LTM', label: 'LTM' },
]

const RANGE_OPTIONS: Array<{ value: TimelineRange; label: string }> = [
  { value: '3', label: '3年' },
  { value: '5', label: '5年' },
  { value: '10', label: '10年' },
  { value: 'all', label: '全期間' },
]

const METRIC_LABELS: Record<FinancialPerformanceDetailMetric, string> = {
  revenue: '売上高',
  operating_profit: '営業利益',
  net_income_attributable: '純利益',
  eps_basic: 'EPS',
}

function detailUrl(ticker: string, analysisDate: string | null): string {
  const query = analysisDate ? `?as_of=${encodeURIComponent(analysisDate)}` : ''
  return `/api/financial-performance-detail/${encodeURIComponent(ticker)}${query}`
}

function visiblePeriods(periods: FinancialPerformanceDetailPeriod[], range: TimelineRange) {
  if (range === 'all') return periods
  const actual = periods.filter((period) => period.pointType === 'actual')
  const latestYear = actual
    .map((period) => period.targetFiscalYear ?? Number(period.periodEnd.slice(0, 4)))
    .sort((a, b) => b - a)[0]
  if (!latestYear) return periods
  const minimumYear = latestYear - Number(range) + 1
  return periods.filter((period) => (
    period.pointType !== 'actual'
    || (period.targetFiscalYear ?? Number(period.periodEnd.slice(0, 4))) >= minimumYear
  ))
}

function axisLabel(period: FinancialPerformanceDetailPeriod): string {
  if (period.pointType === 'current_forecast') return `FY${String(period.targetFiscalYear ?? '').slice(-2)}予`
  if (period.pointType === 'next_forecast') return `FY${String(period.targetFiscalYear ?? '').slice(-2)}翌`
  if (period.periodKind === 'LTM') return period.periodEnd.slice(2, 7).replace('-', '/')
  const fiscal = `FY${String(period.targetFiscalYear ?? period.periodEnd.slice(0, 4)).slice(-2)}`
  return period.periodKind === 'FY' ? fiscal : `${fiscal}${period.periodKind}`
}

function chartData(periods: FinancialPerformanceDetailPeriod[], metric: FinancialPerformanceDetailMetric): ChartDatum[] {
  return periods.map((period) => {
    const value = period.metrics[metric]?.value
    return {
      key: period.key,
      label: axisLabel(period),
      period,
      actual: period.pointType === 'actual' && value != null ? value : undefined,
      currentForecast: period.pointType === 'current_forecast' && value != null ? value : undefined,
      nextForecast: period.pointType === 'next_forecast' && value != null ? value : undefined,
      grossMargin: period.profitability.grossMargin.value ?? undefined,
      operatingMargin: period.profitability.operatingMargin.value ?? undefined,
      netMargin: period.profitability.netMargin.value ?? undefined,
      roe: period.profitability.roe.value ?? undefined,
      roa: period.profitability.roa.value ?? undefined,
    }
  })
}

function compactNumber(value: number, metric: FinancialPerformanceDetailMetric): string {
  if (metric === 'eps_basic') return value.toLocaleString('ja-JP', { maximumFractionDigits: 1 })
  const absolute = Math.abs(value)
  if (absolute >= 1e12) return `${(value / 1e12).toFixed(1)}兆`
  if (absolute >= 1e8) return `${(value / 1e8).toFixed(0)}億`
  if (absolute >= 1e4) return `${(value / 1e4).toFixed(0)}万`
  return value.toLocaleString('ja-JP', { maximumFractionDigits: 1 })
}

function displayTimelineValue(value: FinancialTimelineValue | null, metric: FinancialPerformanceDetailMetric): string {
  if (!value) return '—'
  const text = compactNumber(value.value, metric)
  return metric === 'eps_basic' ? `¥${text}` : text
}

function displaySummaryValue(value: FinancialPerformanceSummaryValue, kind: 'amount' | 'eps' | 'percent'): string {
  if (value.value == null) return value.availability === 'not_meaningful' ? 'N/M' : '—'
  if (kind === 'percent') return `${value.value.toFixed(1)}%`
  if (kind === 'eps') return `¥${value.value.toLocaleString('ja-JP', { maximumFractionDigits: 1 })}`
  return compactNumber(value.value, 'revenue')
}

function signedPercent(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`
}

function pointTypeLabel(period: FinancialPerformanceDetailPeriod): string {
  if (period.pointType === 'current_forecast') return '当期予想'
  if (period.pointType === 'next_forecast') return '翌期予想'
  return '実績'
}

export function FinancialPerformanceDetail({ ticker, analysisDate }: FinancialPerformanceDetailProps) {
  const [model, setModel] = useState<FinancialPerformanceDetailReadModel | null>(null)
  const [mode, setMode] = useState<FinancialTimelineMode>('FY')
  const [range, setRange] = useState<TimelineRange>('5')
  const [mobileMetric, setMobileMetric] = useState<FinancialPerformanceDetailMetric>('revenue')
  const [profitabilityView, setProfitabilityView] = useState<ProfitabilityView>('margins')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    fetch(detailUrl(ticker, analysisDate), { cache: 'no-store', signal: controller.signal })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`)))
      .then((payload: FinancialPerformanceDetailReadModel) => {
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

  const series = model?.modes[mode]
  const periods = useMemo(() => visiblePeriods(series?.periods ?? [], range), [range, series?.periods])

  if (loading) {
    return <div className="grid min-h-80 place-items-center border border-[var(--color-border-default)] bg-white text-[11px] font-bold text-[var(--color-text-tertiary)]">業績詳細を読み込んでいます...</div>
  }
  if (error || !model || !series) {
    return <div className="grid min-h-48 place-items-center border border-[var(--color-border-default)] bg-white px-4 text-center text-[11px] font-bold text-[var(--color-text-tertiary)]">業績詳細を取得できませんでした。</div>
  }

  return (
    <section className="space-y-3" aria-labelledby="performance-detail-title">
      <header className="border border-[var(--color-border-default)] bg-white">
        <div className="flex flex-wrap items-start justify-between gap-2 bg-[var(--color-brand-50)] px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <TrendingUp size={17} className="shrink-0 text-[var(--color-brand-700)]" aria-hidden="true" />
            <div>
              <h2 id="performance-detail-title" className="text-[13px] font-black text-[var(--color-brand-900)]">業績</h2>
              <p className="text-[9px] font-semibold text-[var(--color-text-tertiary)]">実績・会社予想・収益性を同じ基準日で確認</p>
            </div>
          </div>
          <div className="font-mono text-[9px] font-bold text-[var(--color-text-tertiary)]">分析基準日 {model.asOf}</div>
        </div>
        <PerformanceSummary model={model} />
      </header>

      <section className="overflow-hidden border border-[var(--color-border-default)] bg-white" aria-labelledby="performance-chart-title">
        <div className="border-b border-[var(--color-border-default)] bg-[var(--color-brand-50)] px-3 py-2.5 sm:px-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <BarChart3 size={15} className="text-[var(--color-brand-700)]" aria-hidden="true" />
              <h3 id="performance-chart-title" className="text-[11px] font-black text-[var(--color-brand-900)]">業績グラフ</h3>
            </div>
            <span className="text-[8px] font-semibold text-[var(--color-text-tertiary)]">実績と会社予想を線種・塗り・ラベルで区別</span>
          </div>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <SegmentedControl label="期間種別" options={MODE_OPTIONS} value={mode} onChange={setMode} />
            <SegmentedControl label="表示年数" options={RANGE_OPTIONS} value={range} onChange={setRange} />
          </div>
        </div>
        <ForecastLegend note={series.note} />
        {periods.length === 0 ? (
          <EmptyState>この期間種別で表示できるデータがありません。</EmptyState>
        ) : (
          <>
            <div className="hidden grid-cols-2 lg:grid">
              {FINANCIAL_PERFORMANCE_DETAIL_METRICS.map((metric) => (
                <PerformanceChart key={metric} metric={metric} periods={periods} />
              ))}
            </div>
            <div className="lg:hidden">
              <MetricSwitch value={mobileMetric} onChange={setMobileMetric} />
              <PerformanceChart metric={mobileMetric} periods={periods} mobile />
            </div>
            <PerformanceRawTable periods={periods} />
          </>
        )}
      </section>

      <section className="overflow-hidden border border-[var(--color-border-default)] bg-white" aria-labelledby="profitability-title">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border-default)] bg-[var(--color-brand-50)] px-3 py-2.5 sm:px-4">
          <div className="flex items-center gap-2">
            <TrendingUp size={15} className="text-[var(--color-brand-700)]" aria-hidden="true" />
            <div>
              <h3 id="profitability-title" className="text-[11px] font-black text-[var(--color-brand-900)]">収益性</h3>
              <p className="text-[8px] font-semibold text-[var(--color-text-tertiary)]">同一期間・会計基準・連結区分の値だけで算定</p>
            </div>
          </div>
          <div className="lg:hidden">
            <SegmentedControl
              label="表示"
              options={[{ value: 'margins', label: '利益率' }, { value: 'returns', label: '資本効率' }]}
              value={profitabilityView}
              onChange={setProfitabilityView}
            />
          </div>
        </div>
        <div className="hidden grid-cols-2 lg:grid">
          <ProfitabilityChart periods={periods} view="margins" />
          <ProfitabilityChart periods={periods} view="returns" />
        </div>
        <div className="lg:hidden">
          <ProfitabilityChart periods={periods} view={profitabilityView} />
        </div>
      </section>

      <ForecastHistoryTable rows={model.forecastHistory} />
    </section>
  )
}

function PerformanceSummary({ model }: { model: FinancialPerformanceDetailReadModel }) {
  const summary = model.summary
  return (
    <div className="grid divide-y divide-[var(--color-border-soft)] lg:grid-cols-[1.15fr_0.85fr_1fr] lg:divide-x lg:divide-y-0">
      <SummaryBlock title="直近業績" subtitle="LTM優先・FY補完">
        <div className="grid grid-cols-2 gap-x-4 gap-y-2">
          <SummaryMetric label="売上高" value={summary.scale.revenue} kind="amount" primary />
          <SummaryMetric label="営業利益" value={summary.scale.operatingProfit} kind="amount" />
          <SummaryMetric label="純利益" value={summary.scale.netIncome} kind="amount" />
          <SummaryMetric label="EPS" value={summary.scale.eps} kind="eps" />
        </div>
      </SummaryBlock>
      <SummaryBlock title="収益性" subtitle={model.isFinancialSector ? '金融業の適用外を明示' : 'LTM基準'}>
        <div className="grid grid-cols-3 gap-3">
          <SummaryMetric label="営業利益率" value={summary.profitability.operatingMargin} kind="percent" primary />
          <SummaryMetric label="ROE" value={summary.profitability.roe} kind="percent" />
          <SummaryMetric label="ROA" value={summary.profitability.roa} kind="percent" />
        </div>
      </SummaryBlock>
      <SummaryBlock title="成長" subtitle="実績FYの端点比較">
        <div className="grid grid-cols-2 gap-x-4 gap-y-2">
          <SummaryMetric label="売上3年CAGR" value={summary.growth.revenueCagr3y} kind="percent" primary />
          <SummaryMetric label="売上5年CAGR" value={summary.growth.revenueCagr5y} kind="percent" />
          <SummaryMetric label="EPS 3年CAGR" value={summary.growth.epsCagr3y} kind="percent" />
          <SummaryMetric label="EPS 5年CAGR" value={summary.growth.epsCagr5y} kind="percent" />
        </div>
      </SummaryBlock>
    </div>
  )
}

function SummaryBlock({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <article className="min-w-0 px-4 py-3">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="text-[10px] font-black text-[var(--color-brand-900)]">{title}</h3>
        <span className="text-[8px] font-semibold text-[var(--color-text-tertiary)]">{subtitle}</span>
      </div>
      {children}
    </article>
  )
}

function SummaryMetric({
  label,
  value,
  kind,
  primary = false,
}: {
  label: string
  value: FinancialPerformanceSummaryValue
  kind: 'amount' | 'eps' | 'percent'
  primary?: boolean
}) {
  return (
    <div className="min-w-0" title={value.reason ?? value.periodLabel ?? undefined}>
      <div className="truncate text-[8px] font-bold text-[var(--color-text-tertiary)]">{label}</div>
      <div className={`truncate font-mono font-black text-[var(--color-text-primary)] ${primary ? 'text-[15px]' : 'text-[12px]'}`}>
        {displaySummaryValue(value, kind)}
      </div>
      <div className="truncate text-[7px] font-semibold text-[var(--color-text-tertiary)]">
        {value.availability === 'not_applicable' ? 'N/A' : value.periodLabel ?? value.reason ?? 'データなし'}
      </div>
    </div>
  )
}

function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: Array<{ value: T; label: string }>
  value: T
  onChange: (value: T) => void
}) {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <span className="shrink-0 text-[8px] font-black text-[var(--color-text-tertiary)]">{label}</span>
      <div className="flex min-w-0 overflow-x-auto border border-[var(--color-border-default)] bg-white">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            aria-pressed={value === option.value}
            className={`h-7 shrink-0 border-r border-[var(--color-border-default)] px-2 text-[9px] font-black last:border-r-0 sm:px-2.5 ${
              value === option.value
                ? 'bg-[var(--color-brand-900)] text-white'
                : 'text-[var(--color-text-secondary)]'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function MetricSwitch({
  value,
  onChange,
}: {
  value: FinancialPerformanceDetailMetric
  onChange: (metric: FinancialPerformanceDetailMetric) => void
}) {
  return (
    <div className="grid grid-cols-4 border-b border-[var(--color-border-soft)] px-3 py-2">
      {FINANCIAL_PERFORMANCE_DETAIL_METRICS.map((metric) => (
        <button
          key={metric}
          type="button"
          onClick={() => onChange(metric)}
          aria-pressed={value === metric}
          className={`h-8 border border-r-0 border-[var(--color-border-default)] text-[9px] font-black last:border-r ${
            value === metric ? 'bg-[var(--color-brand-900)] text-white' : 'bg-white text-[var(--color-text-secondary)]'
          }`}
        >
          {METRIC_LABELS[metric]}
        </button>
      ))}
    </div>
  )
}

function ForecastLegend({ note }: { note: string | null }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-[var(--color-border-soft)] px-3 py-1.5 text-[8px] font-bold text-[var(--color-text-tertiary)] sm:px-4">
      <LegendSwatch kind="actual" label="実績" />
      <LegendSwatch kind="current" label="当期会社予想" />
      <LegendSwatch kind="next" label="翌期会社予想" />
      {note && <span className="ml-auto">{note}</span>}
    </div>
  )
}

function LegendSwatch({ kind, label }: { kind: 'actual' | 'current' | 'next'; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={`h-2.5 w-4 border border-[var(--color-brand-700)] ${kind === 'actual' ? 'bg-[var(--color-brand-700)]' : 'bg-white'}`}
        style={{ borderStyle: kind === 'next' ? 'dashed' : 'solid' }}
        aria-hidden="true"
      />
      {label}
    </span>
  )
}

function PerformanceChart({
  metric,
  periods,
  mobile = false,
}: {
  metric: FinancialPerformanceDetailMetric
  periods: FinancialPerformanceDetailPeriod[]
  mobile?: boolean
}) {
  const data = chartData(periods, metric)
  const hasData = data.some((datum) => datum.actual != null || datum.currentForecast != null || datum.nextForecast != null)
  return (
    <article className="min-w-0 border-b border-[var(--color-border-soft)] lg:border-r lg:[&:nth-child(2n)]:border-r-0">
      <div className="flex items-center justify-between border-b border-[var(--color-border-soft)] px-3 py-2 sm:px-4">
        <h4 className="text-[10px] font-black text-[var(--color-brand-900)]">{METRIC_LABELS[metric]}</h4>
        <span className="font-mono text-[10px] font-black text-[var(--color-text-primary)]">
          {displayTimelineValue([...periods].reverse().find((period) => period.metrics[metric])?.metrics[metric] ?? null, metric)}
        </span>
      </div>
      <div className={mobile ? 'h-[210px] px-1 py-2' : 'h-[225px] px-2 py-2'}>
        {!hasData ? <EmptyState>データなし</EmptyState> : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 3 }} barCategoryGap="22%">
              <CartesianGrid vertical={false} stroke="var(--color-border-soft)" strokeDasharray="2 2" />
              <XAxis dataKey="label" tick={{ fontSize: 8, fill: 'var(--color-text-tertiary)' }} tickLine={false} minTickGap={12} interval="preserveStartEnd" />
              <YAxis tick={{ fontSize: 8, fill: 'var(--color-text-tertiary)' }} tickFormatter={(value) => compactNumber(Number(value), metric)} axisLine={false} tickLine={false} width={49} />
              <ReferenceLine y={0} stroke="var(--color-border-strong)" />
              <Tooltip cursor={{ fill: 'var(--color-surface-subtle)' }} content={<PerformanceTooltip metric={metric} />} />
              <Bar dataKey="actual" name="実績" fill="var(--color-brand-700)" maxBarSize={22} isAnimationActive={false} />
              <Bar dataKey="currentForecast" name="当期会社予想" fill="white" stroke="var(--color-brand-700)" strokeWidth={1.6} maxBarSize={22} isAnimationActive={false} />
              <Bar dataKey="nextForecast" name="翌期会社予想" fill="var(--color-brand-50)" stroke="var(--color-brand-700)" strokeWidth={1.6} strokeDasharray="3 2" maxBarSize={22} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </article>
  )
}

function PerformanceTooltip({
  active,
  payload,
  metric,
}: {
  active?: boolean
  payload?: Array<{ payload?: ChartDatum }>
  metric: FinancialPerformanceDetailMetric
}) {
  const datum = payload?.[0]?.payload
  if (!active || !datum) return null
  const value = datum.period.metrics[metric]
  return (
    <div className="border border-[var(--color-border-default)] bg-white px-2.5 py-2 text-[9px] shadow-lg">
      <div className="font-black text-[var(--color-brand-900)]">{datum.period.label}</div>
      <div className="mt-1 flex items-baseline justify-between gap-4">
        <span className="text-[var(--color-text-tertiary)]">{pointTypeLabel(datum.period)}</span>
        <b className="font-mono text-[11px]">{displayTimelineValue(value, metric)}</b>
      </div>
      {value?.yoyPercent != null && <div className="mt-1">前年同期比 <b className="font-mono">{signedPercent(value.yoyPercent)}</b></div>}
      {value?.revision && <div className="mt-1 border-t border-[var(--color-border-soft)] pt-1">前回 {compactNumber(value.revision.previousValue, metric)} / 修正 <b>{signedPercent(value.revision.ratePercent)}</b></div>}
      <div className="mt-1 font-mono text-[8px] text-[var(--color-text-tertiary)]">公表 {value?.publishedAt.slice(0, 10) ?? '---'}</div>
    </div>
  )
}

function ProfitabilityChart({
  periods,
  view,
}: {
  periods: FinancialPerformanceDetailPeriod[]
  view: ProfitabilityView
}) {
  const data = chartData(periods, 'revenue').filter((datum) => datum.period.pointType === 'actual')
  const keys = view === 'margins'
    ? [
        { key: 'grossMargin', label: '粗利率', stroke: 'var(--color-text-tertiary)', dash: '4 3' },
        { key: 'operatingMargin', label: '営業利益率', stroke: 'var(--color-brand-700)' },
        { key: 'netMargin', label: '純利益率', stroke: 'var(--color-market-red)' },
      ]
    : [
        { key: 'roe', label: 'ROE', stroke: 'var(--color-brand-700)' },
        { key: 'roa', label: 'ROA', stroke: 'var(--color-text-secondary)', dash: '4 3' },
      ]
  const activeKeys = keys.filter(({ key }) => data.some((datum) => datum[key as keyof ChartDatum] != null))
  const hasData = activeKeys.length > 0
  return (
    <article className="min-w-0 border-b border-[var(--color-border-soft)] lg:border-r lg:last:border-r-0">
      <div className="border-b border-[var(--color-border-soft)] px-3 py-2 text-[10px] font-black text-[var(--color-brand-900)] sm:px-4">
        {view === 'margins' ? '利益率' : '資本効率'}
      </div>
      <div className="h-[235px] px-2 py-2">
        {!hasData ? <EmptyState>{view === 'margins' ? '利益率を算定できるデータがありません。' : 'FYまたはLTMで算定可能なROE・ROAがありません。'}</EmptyState> : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 3 }}>
              <CartesianGrid vertical={false} stroke="var(--color-border-soft)" strokeDasharray="2 2" />
              <XAxis dataKey="label" tick={{ fontSize: 8, fill: 'var(--color-text-tertiary)' }} tickLine={false} minTickGap={12} interval="preserveStartEnd" />
              <YAxis tick={{ fontSize: 8, fill: 'var(--color-text-tertiary)' }} tickFormatter={(value) => `${Number(value).toFixed(0)}%`} axisLine={false} tickLine={false} width={38} />
              <ReferenceLine y={0} stroke="var(--color-border-strong)" />
              <Tooltip formatter={(value) => [`${Number(value).toFixed(1)}%`]} labelFormatter={(label) => String(label)} />
              <Legend wrapperStyle={{ fontSize: 9 }} />
              {activeKeys.map(({ key, label, stroke, dash }) => (
                <Line key={key} type="monotone" dataKey={key} name={label} stroke={stroke} strokeWidth={1.8} strokeDasharray={dash} dot={{ r: 2.5 }} connectNulls={false} isAnimationActive={false} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </article>
  )
}

function PerformanceRawTable({ periods }: { periods: FinancialPerformanceDetailPeriod[] }) {
  return (
    <div className="border-t border-[var(--color-border-default)]">
      <div className="flex items-center justify-between bg-[var(--color-surface-subtle)] px-3 py-2 sm:px-4">
        <span className="inline-flex items-center gap-1.5 text-[10px] font-black text-[var(--color-brand-900)]"><Table2 size={13} />原表</span>
        <span className="text-[8px] font-semibold text-[var(--color-text-tertiary)]">グラフと同じ期間・基準日</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[920px] border-collapse text-right text-[9px]">
          <thead>
            <tr className="border-y border-[var(--color-border-default)] bg-white text-[var(--color-text-tertiary)]">
              <th className="px-3 py-2 text-left">期間</th>
              <th className="px-2 py-2 text-left">区分</th>
              <th className="px-2 py-2">売上高</th>
              <th className="px-2 py-2">YoY</th>
              <th className="px-2 py-2">営業利益</th>
              <th className="px-2 py-2">純利益</th>
              <th className="px-2 py-2">EPS</th>
              <th className="px-2 py-2">営業利益率</th>
              <th className="px-3 py-2">公表日</th>
            </tr>
          </thead>
          <tbody>
            {periods.map((period) => (
              <tr key={period.key} className={`border-b border-[var(--color-border-soft)] ${period.pointType === 'actual' ? 'bg-white' : 'bg-[var(--color-brand-50)]'}`}>
                <td className="whitespace-nowrap px-3 py-2 text-left font-mono font-black">{period.label.replace(' 会社予想', '').replace(' 翌期予想', '')}</td>
                <td className="whitespace-nowrap px-2 py-2 text-left font-black">{pointTypeLabel(period)}</td>
                <td className="px-2 py-2 font-mono font-bold">{displayTimelineValue(period.metrics.revenue, 'revenue')}</td>
                <td className="px-2 py-2 font-mono text-[var(--color-text-secondary)]">{signedPercent(period.metrics.revenue?.yoyPercent ?? null)}</td>
                <td className="px-2 py-2 font-mono font-bold">{displayTimelineValue(period.metrics.operating_profit, 'operating_profit')}</td>
                <td className="px-2 py-2 font-mono font-bold">{displayTimelineValue(period.metrics.net_income_attributable, 'net_income_attributable')}</td>
                <td className="px-2 py-2 font-mono font-bold">{displayTimelineValue(period.metrics.eps_basic, 'eps_basic')}</td>
                <td className="px-2 py-2 font-mono">{displaySummaryValue(period.profitability.operatingMargin, 'percent')}</td>
                <td className="whitespace-nowrap px-3 py-2 font-mono text-[var(--color-text-tertiary)]">{period.publishedAt.slice(0, 10)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function ForecastHistoryTable({ rows }: { rows: FinancialPerformanceDetailReadModel['forecastHistory'] }) {
  return (
    <section className="overflow-hidden border border-[var(--color-border-default)] bg-white" aria-labelledby="forecast-history-title">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border-default)] bg-[var(--color-brand-50)] px-3 py-2.5 sm:px-4">
        <div className="flex items-center gap-2">
          <History size={15} className="text-[var(--color-brand-700)]" aria-hidden="true" />
          <div>
            <h3 id="forecast-history-title" className="text-[11px] font-black text-[var(--color-brand-900)]">会社予想修正履歴</h3>
            <p className="text-[8px] font-semibold text-[var(--color-text-tertiary)]">対象年度ごとの前回予想と修正率</p>
          </div>
        </div>
        <span className="text-[8px] font-semibold text-[var(--color-text-tertiary)]">{rows.length}件 / PIT基準日以前のみ</span>
      </div>
      {rows.length === 0 ? <EmptyState>指定日時点で会社予想履歴がありません。</EmptyState> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1060px] border-collapse text-right text-[9px]">
            <thead>
              <tr className="border-b border-[var(--color-border-default)] text-[var(--color-text-tertiary)]">
                <th className="px-3 py-2 text-left">公表日</th>
                <th className="px-2 py-2 text-left">対象</th>
                <th className="px-2 py-2 text-left">判定</th>
                {FINANCIAL_PERFORMANCE_DETAIL_METRICS.map((metric) => <th key={metric} className="px-2 py-2">{METRIC_LABELS[metric]}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} className="border-b border-[var(--color-border-soft)] align-top">
                  <td className="whitespace-nowrap px-3 py-2 text-left font-mono">{row.publishedAt.slice(0, 10)}</td>
                  <td className="whitespace-nowrap px-2 py-2 text-left font-black">FY{row.targetFiscalYear} {row.forecastScope === 'next_fy' ? '翌期' : '当期'}</td>
                  <td className="whitespace-nowrap px-2 py-2 text-left"><RevisionDirection direction={row.direction} /></td>
                  {FINANCIAL_PERFORMANCE_DETAIL_METRICS.map((metric) => (
                    <td key={metric} className="min-w-[155px] px-2 py-2">
                      <RevisionMetricCell metric={metric} value={row.metrics[metric]} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function RevisionDirection({ direction }: { direction: FinancialForecastRevisionDirection }) {
  const labels: Record<FinancialForecastRevisionDirection, string> = {
    initial: '初回',
    up: '▲ 上方',
    down: '▼ 下方',
    unchanged: '± 据え置き',
    mixed: '↕ 混在',
  }
  return <span className="font-black text-[var(--color-text-secondary)]">{labels[direction]}</span>
}

function RevisionMetricCell({ metric, value }: { metric: FinancialPerformanceDetailMetric; value: FinancialForecastRevisionMetric | null }) {
  if (!value) return <span className="text-[var(--color-text-tertiary)]">—</span>
  return (
    <div>
      <div className="font-mono font-black text-[var(--color-text-primary)]">{displayTimelineValue({ value: value.value, unit: value.unit, publishedAt: '', source: 'jquants', inputIds: [], definitionVersion: null, yoyPercent: null, revision: null }, metric)}</div>
      <div className="mt-0.5 whitespace-nowrap text-[7px] font-semibold text-[var(--color-text-tertiary)]">
        {value.previousValue == null
          ? '前回予想なし'
          : `前回 ${compactNumber(value.previousValue, metric)} / ${signedPercent(value.revisionPercent)}`}
      </div>
    </div>
  )
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return <div className="grid min-h-28 place-items-center px-4 text-center text-[10px] font-bold text-[var(--color-text-tertiary)]">{children}</div>
}
