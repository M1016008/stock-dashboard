'use client'

import { useEffect, useMemo, useState } from 'react'
import { BarChart3, GitCompareArrows, History, Table2, TrendingUp } from 'lucide-react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { MeasuredChartFrame } from '@/components/charts/MeasuredChartFrame'
import {
  FINANCIAL_PERFORMANCE_DETAIL_METRICS,
  type FinancialForecastRevisionDirection,
  type FinancialForecastRevisionMetric,
  type FinancialForecastRevisionRow,
  type FinancialPerformanceDetailMetric,
  type FinancialPerformanceDetailPeriod,
  type FinancialPerformanceDetailReadModel,
  type FinancialPerformanceSummaryValue,
} from '@/lib/financial-performance-detail'
import type { FinancialTimelineMode, FinancialTimelineValue } from '@/lib/financial-performance-timeline'
import {
  directionOfSigned,
  signedPercentText,
  UNAVAILABLE_LABEL,
  unavailableLabel,
  type Direction,
} from '@/components/stock/fundamentals/format'
import {
  DirectionMark,
  ErrorBlock,
  Fact,
  LoadingBlock,
  PanelSection,
  Pill,
  Segmented,
  TabBanner,
  TabSwitch,
  UnavailableNote,
} from '@/components/stock/fundamentals/primitives'

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
  value?: number
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

const METRIC_OPTIONS = FINANCIAL_PERFORMANCE_DETAIL_METRICS.map((metric) => ({ value: metric, label: METRIC_LABELS[metric] }))

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
      value: value ?? undefined,
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
  if (!value) return UNAVAILABLE_LABEL.missing
  const text = compactNumber(value.value, metric)
  return metric === 'eps_basic' ? `¥${text}` : text
}

function amountText(value: number, metric: FinancialPerformanceDetailMetric): string {
  const text = compactNumber(value, metric)
  return metric === 'eps_basic' ? `¥${text}` : text
}

function displaySummaryValue(value: FinancialPerformanceSummaryValue, kind: 'amount' | 'eps' | 'percent'): { text: string; unavailable: boolean } {
  if (value.value == null) return { text: unavailableLabel(value.availability), unavailable: true }
  if (kind === 'percent') return { text: `${value.value.toFixed(1)}%`, unavailable: false }
  if (kind === 'eps') return { text: `¥${value.value.toLocaleString('ja-JP', { maximumFractionDigits: 1 })}`, unavailable: false }
  return { text: compactNumber(value.value, 'revenue'), unavailable: false }
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
  const [selectedMetric, setSelectedMetric] = useState<FinancialPerformanceDetailMetric>('revenue')
  const [profitabilityView, setProfitabilityView] = useState<ProfitabilityView>('margins')
  const [isDesktopLayout, setIsDesktopLayout] = useState<boolean | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    const media = window.matchMedia('(min-width: 1024px)')
    const update = () => setIsDesktopLayout(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

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
  }, [analysisDate, ticker, reloadKey])

  const series = model?.modes[mode]
  const periods = useMemo(() => visiblePeriods(series?.periods ?? [], range), [range, series?.periods])

  if (loading) return <LoadingBlock label="業績詳細を読み込んでいます..." />
  if (error || !model || !series) {
    return <ErrorBlock label="業績詳細を取得できませんでした。" onRetry={() => setReloadKey((value) => value + 1)} />
  }

  return (
    <section className="space-y-5 bg-white" aria-labelledby="performance-detail-title">
      <TabBanner
        icon={TrendingUp}
        id="performance-detail-title"
        title="業績"
        lead="実績と会社予想を同じ尺度で並べ、伸びの向き・予想の修正・推移を確認します。"
        meta={<span>分析基準日 {model.asOf}</span>}
        flow={['実績と会社予想', '直近の水準', '推移グラフ', '原表・修正履歴']}
      />

      <ActualVersusForecast model={model} />
      <RecentLevel model={model} />

      <PanelSection
        icon={BarChart3}
        id="performance-chart-title"
        title="業績グラフ"
        lead="実績は塗り、当期予想は白抜き、翌期予想は破線で区別。各期の前年比は下に常時表示"
        bleed
        aside={(
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Segmented label="期間種別" options={MODE_OPTIONS} value={mode} onChange={setMode} />
            <Segmented label="表示年数" options={RANGE_OPTIONS} value={range} onChange={setRange} />
          </div>
        )}
      >
        <ForecastLegend note={series.note} />
        {periods.length === 0 ? (
          <EmptyState>この期間種別で表示できるデータがありません。</EmptyState>
        ) : (
          <>
            <TabSwitch label="業績グラフの表示指標" options={METRIC_OPTIONS} value={selectedMetric} onChange={setSelectedMetric} />
            <PerformanceChart metric={selectedMetric} periods={periods} />
            <YoyStrip metric={selectedMetric} periods={periods} />
            <PerformanceRawTable periods={periods} />
          </>
        )}
      </PanelSection>

      <PanelSection
        icon={TrendingUp}
        id="profitability-title"
        title="収益性の推移"
        lead="同一期間・会計基準・連結区分の値だけで算定した利益率と資本効率(実績のみ)"
        bleed
        aside={(
          <div className="lg:hidden">
            <Segmented
              label="表示"
              options={[{ value: 'margins' as const, label: '利益率' }, { value: 'returns' as const, label: '資本効率' }]}
              value={profitabilityView}
              onChange={setProfitabilityView}
            />
          </div>
        )}
      >
        {isDesktopLayout == null ? (
          <div className="grid h-[235px] place-items-center text-[12px] font-bold text-[var(--color-text-tertiary)]">グラフを準備中...</div>
        ) : isDesktopLayout ? (
          <div className="grid grid-cols-2">
            <ProfitabilityChart periods={periods} view="margins" />
            <ProfitabilityChart periods={periods} view="returns" />
          </div>
        ) : (
          <ProfitabilityChart periods={periods} view={profitabilityView} />
        )}
      </PanelSection>

      <ForecastHistory rows={model.forecastHistory} />
    </section>
  )
}

/* ------------------------------------------------------------------ */
/* 1. 実績 vs 会社予想 (結論)                                          */
/* ------------------------------------------------------------------ */

function ActualVersusForecast({ model }: { model: FinancialPerformanceDetailReadModel }) {
  const periods = model.modes.FY.periods
  const actual = [...periods].filter((period) => period.pointType === 'actual').sort((a, b) => a.periodEnd.localeCompare(b.periodEnd)).at(-1) ?? null
  const current = periods.find((period) => period.pointType === 'current_forecast') ?? null
  const next = periods.find((period) => period.pointType === 'next_forecast') ?? null
  const actualLabel = actual ? axisLabel(actual) : '実績'
  const currentLabel = current ? axisLabel(current) : '当期予想'

  return (
    <PanelSection
      icon={GitCompareArrows}
      id="performance-vs-forecast-title"
      title="実績と会社予想"
      lead={`直近FY実績(${actualLabel})と当期会社予想(${currentLabel})を同じ尺度で比較。矢印は前年比などの向き`}
      aside={(
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] font-semibold text-[var(--color-text-tertiary)]">
          <LegendSwatch kind="actual" label="実績" />
          <LegendSwatch kind="current" label="当期会社予想" />
        </div>
      )}
    >
      {!actual && !current ? (
        <UnavailableNote>FYの実績・会社予想が指定日時点でないため、比較は表示できません。</UnavailableNote>
      ) : (
        <ul className="m-0 grid list-none gap-x-8 gap-y-4 p-0 md:grid-cols-2" aria-label="実績と会社予想の比較">
          {FINANCIAL_PERFORMANCE_DETAIL_METRICS.map((metric) => {
            const a = actual?.metrics[metric] ?? null
            const c = current?.metrics[metric] ?? null
            const n = next?.metrics[metric] ?? null
            const scale = Math.max(a ? Math.abs(a.value) : 0, c ? Math.abs(c.value) : 0)
            return (
              <li key={metric} className="min-w-0 border-t border-[var(--color-border-soft)] pt-2.5 first:border-t-0 first:pt-0 md:[&:nth-child(2)]:border-t-0 md:[&:nth-child(2)]:pt-0">
                <div className="mb-1 text-[13px] font-bold text-[var(--color-text-primary)]">{METRIC_LABELS[metric]}</div>
                <ForecastBarRow label={`${actualLabel} 実績`} value={a} metric={metric} scale={scale} kind="actual" />
                <ForecastBarRow label={`${currentLabel} 会社予想`} value={c} metric={metric} scale={scale} kind="current" />
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {a && <YoyPill prefix={`${actualLabel}の前年比`} value={a.yoyPercent} />}
                  {c && <YoyPill prefix={`${currentLabel}の前年比`} value={c.yoyPercent} />}
                  {c?.revision && (
                    <Pill tone="brand" title={`前回予想 ${compactNumber(c.revision.previousValue, metric)} (${c.revision.previousPublishedAt.slice(0, 10)})`}>
                      <DirectionMark direction={directionOfSigned(c.revision.ratePercent)} size={12} />
                      修正 {signedPercentText(c.revision.ratePercent)}
                    </Pill>
                  )}
                  {n && (
                    <Pill title="翌期の会社予想">
                      翌期予想 {displayTimelineValue(n, metric)}
                      {n.yoyPercent != null && <> ({signedPercentText(n.yoyPercent)})</>}
                    </Pill>
                  )}
                  {!c && <Pill>当期予想なし</Pill>}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </PanelSection>
  )
}

function ForecastBarRow({
  label,
  value,
  metric,
  scale,
  kind,
}: {
  label: string
  value: FinancialTimelineValue | null
  metric: FinancialPerformanceDetailMetric
  scale: number
  kind: 'actual' | 'current'
}) {
  const width = value && scale > 0 ? Math.max(2, (Math.abs(value.value) / scale) * 100) : 0
  const negative = value != null && value.value < 0
  const color = negative ? 'var(--color-text-secondary)' : 'var(--color-brand-700)'
  return (
    <div className="grid min-h-8 grid-cols-[minmax(92px,128px)_minmax(0,1fr)_minmax(68px,auto)] items-center gap-2">
      <span className="min-w-0 text-[11px] font-semibold leading-4 text-[var(--color-text-secondary)]">{label}</span>
      <span className="relative block h-3 bg-[var(--color-surface-subtle)]" aria-hidden="true">
        {width > 0 && (
          <span
            className="absolute inset-y-0 left-0"
            style={{
              width: `${width}%`,
              ...(kind === 'actual'
                ? { background: color }
                : { background: 'white', boxShadow: `inset 0 0 0 1.5px ${color}` }),
            }}
          />
        )}
      </span>
      <strong className={`text-right font-mono text-[13px] font-bold leading-4 ${value ? 'text-[var(--color-text-primary)]' : 'text-[var(--color-text-tertiary)]'}`}>
        {displayTimelineValue(value, metric)}
      </strong>
    </div>
  )
}

function YoyPill({ prefix, value }: { prefix: string; value: number | null }) {
  if (value == null) return null
  return (
    <Pill title={prefix}>
      <DirectionMark direction={directionOfSigned(value)} size={12} />
      <span className="font-medium">{prefix}</span>
      <span className="font-mono">{signedPercentText(value)}</span>
    </Pill>
  )
}

/* ------------------------------------------------------------------ */
/* 2. 直近の水準 (LTM優先)                                              */
/* ------------------------------------------------------------------ */

function RecentLevel({ model }: { model: FinancialPerformanceDetailReadModel }) {
  const summary = model.summary
  return (
    <PanelSection
      icon={BarChart3}
      id="performance-level-title"
      title="直近の水準"
      lead="規模=LTM優先・FY補完 / 収益性=LTM基準 / 成長=実績FYの端点比較(CAGR)"
    >
      <div className="grid gap-x-8 gap-y-4 lg:grid-cols-[1.3fr_1fr_1.1fr]">
        <Block title="規模" note="直近12か月">
          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            <SummaryMetric label="売上高" value={summary.scale.revenue} kind="amount" primary />
            <SummaryMetric label="営業利益" value={summary.scale.operatingProfit} kind="amount" />
            <SummaryMetric label="純利益" value={summary.scale.netIncome} kind="amount" />
            <SummaryMetric label="EPS" value={summary.scale.eps} kind="eps" />
          </div>
        </Block>
        <Block title="収益性" note={model.isFinancialSector ? '金融業は一部が対象外' : 'LTM基準'}>
          <div className="grid grid-cols-3 gap-x-3 gap-y-3">
            <SummaryMetric label="営業利益率" value={summary.profitability.operatingMargin} kind="percent" primary />
            <SummaryMetric label="ROE" value={summary.profitability.roe} kind="percent" />
            <SummaryMetric label="ROA" value={summary.profitability.roa} kind="percent" />
          </div>
        </Block>
        <Block title="成長(CAGR)" note="実績FYの端点比較">
          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            <SummaryMetric label="売上 3年" value={summary.growth.revenueCagr3y} kind="percent" primary />
            <SummaryMetric label="売上 5年" value={summary.growth.revenueCagr5y} kind="percent" />
            <SummaryMetric label="EPS 3年" value={summary.growth.epsCagr3y} kind="percent" />
            <SummaryMetric label="EPS 5年" value={summary.growth.epsCagr5y} kind="percent" />
          </div>
        </Block>
      </div>
    </PanelSection>
  )
}

function Block({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <article className="min-w-0">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-2 border-b border-[var(--color-border-soft)] pb-1">
        <h4 className="text-[12px] font-bold text-[var(--color-text-secondary)]">{title}</h4>
        <span className="text-[11px] font-medium text-[var(--color-text-tertiary)]">{note}</span>
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
  const display = displaySummaryValue(value, kind)
  return (
    <Fact
      label={label}
      value={display.text}
      unavailable={display.unavailable}
      emphasis={primary}
      sub={value.availability === 'available' ? value.periodLabel : value.reason ?? value.periodLabel}
      title={value.reason ?? value.periodLabel ?? undefined}
    />
  )
}

/* ------------------------------------------------------------------ */
/* 3. グラフ                                                            */
/* ------------------------------------------------------------------ */

function ForecastLegend({ note }: { note: string | null }) {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b border-[var(--color-border-soft)] px-4 py-2 text-[11px] font-semibold text-[var(--color-text-tertiary)] sm:px-5">
      <LegendSwatch kind="actual" label="実績" />
      <LegendSwatch kind="current" label="当期会社予想" />
      <LegendSwatch kind="next" label="翌期会社予想" />
      {note && <span className="sm:ml-auto">{note}</span>}
    </div>
  )
}

function LegendSwatch({ kind, label }: { kind: 'actual' | 'current' | 'next'; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={`h-2.5 w-4 border border-[var(--color-brand-700)] ${kind === 'actual' ? 'bg-[var(--color-brand-700)]' : kind === 'next' ? 'bg-[var(--color-brand-50)]' : 'bg-white'}`}
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
}: {
  metric: FinancialPerformanceDetailMetric
  periods: FinancialPerformanceDetailPeriod[]
}) {
  const data = chartData(periods, metric)
  const hasData = data.some((datum) => datum.value != null)
  const latestValue = displayTimelineValue([...periods].reverse().find((period) => period.metrics[metric])?.metrics[metric] ?? null, metric)
  if (!hasData) {
    return (
      <div className="px-4 py-4 sm:px-5" aria-label={`${METRIC_LABELS[metric]} データなし`}>
        <UnavailableNote>{METRIC_LABELS[metric]}はこの基準では取得できません。</UnavailableNote>
      </div>
    )
  }
  // 実績・当期予想・翌期予想は期ごとに1つだけ値を持つ。以前は系列を3本に分けていたため
  // 各カテゴリに3本分の幅が確保され、棒が左右にずれていた。1系列にして塗り分けだけ Cell で行い、
  // 各期の棒をカテゴリ中央に揃える(値は変えない)。
  return (
    <article className="min-w-0 px-3 pb-1 pt-3 sm:px-5 sm:pt-4">
      <div className="flex items-end justify-between gap-3 px-1">
        <div>
          <h4 className="text-[13px] font-bold text-[var(--color-text-secondary)]">{METRIC_LABELS[metric]}</h4>
          <p className="mt-0.5 text-[11px] font-medium text-[var(--color-text-tertiary)]">最新の値(右端)</p>
        </div>
        <span className="font-mono text-[22px] font-semibold leading-none text-[var(--color-text-primary)] sm:text-[26px]">{latestValue}</span>
      </div>
      <div className="h-[250px] py-3 sm:h-[330px] sm:py-4">
        <MeasuredChartFrame className="h-full">
          {({ width, height }) => (
            <BarChart width={width} height={height} data={data} margin={{ top: 8, right: 10, left: 0, bottom: 3 }} barCategoryGap="28%">
              <CartesianGrid vertical={false} stroke="var(--color-border-soft)" strokeOpacity={0.7} />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--color-text-tertiary)' }} tickLine={false} axisLine={false} minTickGap={24} interval="preserveStartEnd" />
              <YAxis tick={{ fontSize: 11, fill: 'var(--color-text-tertiary)' }} tickFormatter={(value) => compactNumber(Number(value), metric)} axisLine={false} tickLine={false} width={54} />
              <ReferenceLine y={0} stroke="var(--color-border-strong)" />
              <Tooltip cursor={{ fill: 'var(--color-surface-subtle)' }} content={<PerformanceTooltip metric={metric} />} />
              <Bar dataKey="value" name="値" maxBarSize={30} isAnimationActive={false}>
                {data.map((datum) => {
                  const type = datum.period.pointType
                  return (
                    <Cell
                      key={datum.key}
                      fill={type === 'actual' ? 'var(--color-brand-700)' : type === 'current_forecast' ? 'white' : 'var(--color-brand-50)'}
                      stroke="var(--color-brand-700)"
                      strokeWidth={type === 'actual' ? 0 : 1.6}
                      strokeDasharray={type === 'next_forecast' ? '3 2' : undefined}
                    />
                  )
                })}
              </Bar>
            </BarChart>
          )}
        </MeasuredChartFrame>
      </div>
    </article>
  )
}

/** 前年比をツールチップに頼らず常時表示する。形(矢印)で向きを示す。 */
function YoyStrip({ metric, periods }: { metric: FinancialPerformanceDetailMetric; periods: FinancialPerformanceDetailPeriod[] }) {
  const cells = periods.filter((period) => period.metrics[metric])
  if (cells.length === 0) return null
  return (
    <div className="border-t border-[var(--color-border-soft)] px-4 py-2.5 sm:px-5">
      <div className="mb-1.5 text-[11px] font-bold text-[var(--color-text-secondary)]">{METRIC_LABELS[metric]} 前年比</div>
      <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(76px,1fr))] gap-px bg-[var(--color-border-soft)] p-0" aria-label={`${METRIC_LABELS[metric]}の前年比`}>
        {cells.map((period) => {
          const yoy = period.metrics[metric]?.yoyPercent ?? null
          const forecast = period.pointType !== 'actual'
          return (
            <li key={period.key} className="bg-white px-2 py-1.5">
              <div className="flex items-center gap-1 text-[11px] font-semibold leading-4 text-[var(--color-text-tertiary)]">
                {axisLabel(period)}{forecast && <span className="font-medium">(予)</span>}
              </div>
              <div className={`flex items-center gap-0.5 font-mono text-[12px] font-bold leading-4 ${yoy == null ? 'text-[var(--color-text-tertiary)]' : 'text-[var(--color-text-primary)]'}`}>
                <DirectionMark direction={directionOfSigned(yoy)} size={12} />
                {yoy == null ? UNAVAILABLE_LABEL.missing : signedPercentText(yoy)}
              </div>
            </li>
          )
        })}
      </ul>
    </div>
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
    <div className="border border-[var(--color-border-default)] bg-white px-2.5 py-2 text-[11px] shadow-lg">
      <div className="font-black text-[var(--color-brand-900)]">{datum.period.label}</div>
      <div className="mt-1 flex items-baseline justify-between gap-4">
        <span className="text-[var(--color-text-tertiary)]">{pointTypeLabel(datum.period)}</span>
        <b className="font-mono text-[12px]">{displayTimelineValue(value, metric)}</b>
      </div>
      {value?.yoyPercent != null && <div className="mt-1">前年同期比 <b className="font-mono">{signedPercentText(value.yoyPercent)}</b></div>}
      {value?.revision && <div className="mt-1 border-t border-[var(--color-border-soft)] pt-1">前回 {compactNumber(value.revision.previousValue, metric)} / 修正 <b>{signedPercentText(value.revision.ratePercent)}</b></div>}
      <div className="mt-1 font-mono text-[11px] text-[var(--color-text-tertiary)]">公表 {value?.publishedAt.slice(0, 10) ?? '---'}</div>
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
        { key: 'netMargin', label: '純利益率', stroke: 'var(--color-pattern-600)' },
      ]
    : [
        { key: 'roe', label: 'ROE', stroke: 'var(--color-brand-700)' },
        { key: 'roa', label: 'ROA', stroke: 'var(--color-text-secondary)', dash: '4 3' },
      ]
  const activeKeys = keys.filter(({ key }) => data.some((datum) => datum[key as keyof ChartDatum] != null))
  const hasData = activeKeys.length > 0
  return (
    <article className="min-w-0 border-b border-[var(--color-border-soft)] last:border-b-0 lg:border-b-0 lg:border-r lg:last:border-r-0">
      <div className="px-3 pb-1 pt-3 text-[12px] font-bold text-[var(--color-brand-900)] sm:px-4">
        {view === 'margins' ? '利益率' : '資本効率'}
      </div>
      <div className="h-[235px] px-2 py-2">
        {!hasData ? <EmptyState>{view === 'margins' ? '利益率を算定できるデータがありません。' : 'FYまたはLTMで算定可能なROE・ROAがありません。'}</EmptyState> : (
          <MeasuredChartFrame className="h-full">
            {({ width, height }) => (
              <LineChart width={width} height={height} data={data} margin={{ top: 8, right: 12, left: 0, bottom: 3 }}>
                <CartesianGrid vertical={false} stroke="var(--color-border-soft)" />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--color-text-tertiary)' }} tickLine={false} axisLine={false} minTickGap={16} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 11, fill: 'var(--color-text-tertiary)' }} tickFormatter={(value) => `${Number(value).toFixed(0)}%`} axisLine={false} tickLine={false} width={42} />
                <ReferenceLine y={0} stroke="var(--color-border-strong)" />
                <Tooltip formatter={(value) => [`${Number(value).toFixed(1)}%`]} labelFormatter={(label) => String(label)} contentStyle={{ fontSize: 11, borderRadius: 0 }} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {activeKeys.map(({ key, label, stroke, dash }) => (
                  <Line key={key} type="monotone" dataKey={key} name={label} stroke={stroke} strokeWidth={1.8} strokeDasharray={dash} dot={{ r: 2.5 }} connectNulls={false} isAnimationActive={false} />
                ))}
              </LineChart>
            )}
          </MeasuredChartFrame>
        )}
      </div>
    </article>
  )
}

/* ------------------------------------------------------------------ */
/* 4. 原表                                                              */
/* ------------------------------------------------------------------ */

function PerformanceRawTable({ periods }: { periods: FinancialPerformanceDetailPeriod[] }) {
  return (
    <details className="group border-t border-[var(--color-border-soft)]">
      <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center justify-between gap-x-3 px-4 py-2 sm:px-5 [&::-webkit-details-marker]:hidden">
        <span className="inline-flex items-center gap-1.5 text-[12px] font-bold text-[var(--color-brand-900)]"><Table2 size={13} aria-hidden="true" />原表</span>
        <span className="text-[11px] font-medium text-[var(--color-text-tertiary)]">グラフと同じ期間・基準日 / 開いて確認</span>
      </summary>
      <ul className="m-0 list-none divide-y divide-[var(--color-border-soft)] border-t border-[var(--color-border-soft)] p-0 md:hidden" aria-label="業績の原表(カード表示)">
        {periods.map((period) => (
          <li key={period.key} className={`px-4 py-2.5 ${period.pointType === 'actual' ? 'bg-white' : 'bg-[var(--color-brand-50)]'}`}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-mono text-[13px] font-black text-[var(--color-text-primary)]">{period.label.replace(' 会社予想', '').replace(' 翌期予想', '')}</span>
              <span className="text-[11px] font-bold text-[var(--color-text-secondary)]">{pointTypeLabel(period)} ・ 公表 {period.publishedAt.slice(0, 10)}</span>
            </div>
            <dl className="m-0 mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1.5">
              <RawCell label="売上高" value={displayTimelineValue(period.metrics.revenue, 'revenue')} />
              <RawCell label="売上 前年比" value={signedPercentText(period.metrics.revenue?.yoyPercent ?? null)} />
              <RawCell label="営業利益" value={displayTimelineValue(period.metrics.operating_profit, 'operating_profit')} />
              <RawCell label="営業利益率" value={displaySummaryValue(period.profitability.operatingMargin, 'percent').text} />
              <RawCell label="純利益" value={displayTimelineValue(period.metrics.net_income_attributable, 'net_income_attributable')} />
              <RawCell label="EPS" value={displayTimelineValue(period.metrics.eps_basic, 'eps_basic')} />
            </dl>
          </li>
        ))}
      </ul>
      <div className="hidden overflow-x-auto border-t border-[var(--color-border-soft)] md:block">
        <table className="w-full min-w-[860px] border-collapse text-right text-[12px]">
          <thead>
            <tr className="border-y border-[var(--color-border-default)] bg-white text-[var(--color-text-tertiary)]">
              <th className="px-3 py-2 text-left">期間</th>
              <th className="px-2 py-2 text-left">区分</th>
              <th className="px-2 py-2">売上高</th>
              <th className="px-2 py-2">前年比</th>
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
                <td className="px-2 py-2 font-mono text-[var(--color-text-secondary)]">{signedPercentText(period.metrics.revenue?.yoyPercent ?? null)}</td>
                <td className="px-2 py-2 font-mono font-bold">{displayTimelineValue(period.metrics.operating_profit, 'operating_profit')}</td>
                <td className="px-2 py-2 font-mono font-bold">{displayTimelineValue(period.metrics.net_income_attributable, 'net_income_attributable')}</td>
                <td className="px-2 py-2 font-mono font-bold">{displayTimelineValue(period.metrics.eps_basic, 'eps_basic')}</td>
                <td className="px-2 py-2 font-mono">{displaySummaryValue(period.profitability.operatingMargin, 'percent').text}</td>
                <td className="whitespace-nowrap px-3 py-2 font-mono text-[var(--color-text-tertiary)]">{period.publishedAt.slice(0, 10)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  )
}

function RawCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium text-[var(--color-text-tertiary)]">{label}</dt>
      <dd className="m-0 font-mono text-[13px] font-bold text-[var(--color-text-primary)]">{value}</dd>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 5. 会社予想修正履歴                                                  */
/* ------------------------------------------------------------------ */

const REVISION_DIRECTION: Record<FinancialForecastRevisionDirection, { label: string; direction: Direction | null }> = {
  initial: { label: '初回', direction: null },
  up: { label: '上方修正', direction: 'higher' },
  down: { label: '下方修正', direction: 'lower' },
  unchanged: { label: '据え置き', direction: 'same' },
  mixed: { label: '項目により異なる', direction: null },
}

function ForecastHistory({ rows }: { rows: FinancialPerformanceDetailReadModel['forecastHistory'] }) {
  const sorted = useMemo(() => [...rows].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)), [rows])
  const latest = sorted.slice(0, 3)
  return (
    <section className="overflow-hidden border-y border-[var(--color-border-soft)] bg-white" aria-labelledby="forecast-history-title">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border-soft)] px-4 py-3 sm:px-5">
        <div className="flex items-start gap-2">
          <History size={15} className="mt-0.5 text-[var(--color-brand-700)]" aria-hidden="true" />
          <div>
            <h3 id="forecast-history-title" className="text-[14px] font-bold text-[var(--color-text-primary)]">会社予想修正履歴</h3>
            <p className="mt-0.5 text-[11px] font-medium text-[var(--color-text-tertiary)]">直近の修正を先に表示。全件は下の表で確認(PIT基準日以前のみ)</p>
          </div>
        </div>
        <span className="font-mono text-[11px] font-semibold text-[var(--color-text-tertiary)]">{rows.length}件</span>
      </div>
      {rows.length === 0 ? (
        <div className="px-4 py-3 sm:px-5"><UnavailableNote>指定日時点で会社予想履歴がありません。</UnavailableNote></div>
      ) : (
        <>
          <ul className="m-0 list-none divide-y divide-[var(--color-border-soft)] p-0" aria-label="直近の会社予想修正">
            {latest.map((row) => <LatestRevision key={row.key} row={row} />)}
          </ul>
          <details className="group border-t border-[var(--color-border-soft)]">
            <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center justify-between gap-2 px-4 py-2 sm:px-5 [&::-webkit-details-marker]:hidden">
              <span className="inline-flex items-center gap-1.5 text-[12px] font-bold text-[var(--color-brand-900)]"><Table2 size={13} aria-hidden="true" />修正履歴の全件</span>
              <span className="text-[11px] font-medium text-[var(--color-text-tertiary)]">開いて確認</span>
            </summary>
            <ul className="m-0 list-none divide-y divide-[var(--color-border-soft)] border-t border-[var(--color-border-soft)] p-0 md:hidden" aria-label="修正履歴(カード表示)">
              {sorted.map((row) => <LatestRevision key={row.key} row={row} />)}
            </ul>
            <div className="hidden overflow-x-auto border-t border-[var(--color-border-soft)] md:block">
              <table className="w-full min-w-[980px] border-collapse text-right text-[12px]">
                <thead>
                  <tr className="border-b border-[var(--color-border-default)] text-[var(--color-text-tertiary)]">
                    <th className="px-3 py-2 text-left">公表日</th>
                    <th className="px-2 py-2 text-left">対象</th>
                    <th className="px-2 py-2 text-left">判定</th>
                    {FINANCIAL_PERFORMANCE_DETAIL_METRICS.map((metric) => <th key={metric} className="px-2 py-2">{METRIC_LABELS[metric]}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((row) => (
                    <tr key={row.key} className="border-b border-[var(--color-border-soft)] align-top">
                      <td className="whitespace-nowrap px-3 py-2 text-left font-mono">{row.publishedAt.slice(0, 10)}</td>
                      <td className="whitespace-nowrap px-2 py-2 text-left font-black">FY{row.targetFiscalYear} {row.forecastScope === 'next_fy' ? '翌期' : '当期'}</td>
                      <td className="whitespace-nowrap px-2 py-2 text-left"><RevisionDirection direction={row.direction} /></td>
                      {FINANCIAL_PERFORMANCE_DETAIL_METRICS.map((metric) => (
                        <td key={metric} className="min-w-[150px] px-2 py-2">
                          <RevisionMetricCell metric={metric} value={row.metrics[metric]} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </section>
  )
}

function LatestRevision({ row }: { row: FinancialForecastRevisionRow }) {
  return (
    <li className="px-4 py-2.5 sm:px-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-mono text-[12px] font-semibold text-[var(--color-text-tertiary)]">{row.publishedAt.slice(0, 10)}</span>
        <span className="text-[13px] font-bold text-[var(--color-text-primary)]">FY{row.targetFiscalYear} {row.forecastScope === 'next_fy' ? '翌期' : '当期'}予想</span>
        <RevisionDirection direction={row.direction} />
      </div>
      <ul className="m-0 mt-1.5 grid list-none grid-cols-1 gap-x-6 gap-y-1 p-0 sm:grid-cols-2 xl:grid-cols-4">
        {FINANCIAL_PERFORMANCE_DETAIL_METRICS.map((metric) => (
          <li key={metric} className="flex items-baseline justify-between gap-2 text-[12px]">
            <span className="font-semibold text-[var(--color-text-secondary)]">{METRIC_LABELS[metric]}</span>
            <RevisionMetricInline metric={metric} value={row.metrics[metric]} />
          </li>
        ))}
      </ul>
    </li>
  )
}

function RevisionDirection({ direction }: { direction: FinancialForecastRevisionDirection }) {
  const item = REVISION_DIRECTION[direction]
  return (
    <span className="inline-flex items-center gap-1 text-[12px] font-bold text-[var(--color-text-secondary)]">
      <DirectionMark direction={item.direction} size={13} />{item.label}
    </span>
  )
}

function RevisionMetricInline({ metric, value }: { metric: FinancialPerformanceDetailMetric; value: FinancialForecastRevisionMetric | null }) {
  if (!value) return <span className="text-[var(--color-text-tertiary)]">{UNAVAILABLE_LABEL.missing}</span>
  return (
    <span className="flex items-baseline gap-1.5 font-mono">
      <b className="text-[var(--color-text-primary)]">{amountText(value.value, metric)}</b>
      <span className="inline-flex items-center gap-0.5 text-[11px] font-medium text-[var(--color-text-tertiary)]">
        {value.previousValue == null ? '前回なし' : <><DirectionMark direction={directionOfSigned(value.revisionPercent)} size={11} />{signedPercentText(value.revisionPercent)}</>}
      </span>
    </span>
  )
}

function RevisionMetricCell({ metric, value }: { metric: FinancialPerformanceDetailMetric; value: FinancialForecastRevisionMetric | null }) {
  if (!value) return <span className="text-[var(--color-text-tertiary)]">{UNAVAILABLE_LABEL.missing}</span>
  return (
    <div>
      <div className="font-mono font-black text-[var(--color-text-primary)]">{amountText(value.value, metric)}</div>
      <div className="mt-0.5 whitespace-nowrap text-[11px] font-medium text-[var(--color-text-tertiary)]">
        {value.previousValue == null
          ? '前回予想なし'
          : `前回 ${amountText(value.previousValue, metric)} / ${signedPercentText(value.revisionPercent)}`}
      </div>
    </div>
  )
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return <div className="grid min-h-24 place-items-center px-4 text-center text-[12px] font-bold text-[var(--color-text-tertiary)]">{children}</div>
}
