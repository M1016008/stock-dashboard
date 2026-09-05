'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { BarChart3 } from 'lucide-react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  ReferenceLine,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import {
  FINANCIAL_TIMELINE_METRICS,
  type FinancialPerformanceTimelineReadModel,
  type FinancialTimelineMetric,
  type FinancialTimelineMode,
  type FinancialTimelinePeriod,
  type FinancialTimelineValue,
} from '@/lib/financial-performance-timeline'

interface FinancialPerformanceTimelineProps {
  ticker: string
  analysisDate: string | null
}

type TimelineRange = '3' | '5' | '10' | 'all'

interface ChartDatum {
  key: string
  label: string
  period: FinancialTimelinePeriod
  actual?: number
  currentForecast?: number
  nextForecast?: number
}

const MODE_OPTIONS: Array<{ value: FinancialTimelineMode; label: string }> = [
  { value: 'FY', label: 'FY' },
  { value: 'YTD', label: '累積' },
  { value: 'STANDALONE', label: '単独' },
  { value: 'LTM', label: 'LTM' },
]

const RANGE_OPTIONS: Array<{ value: TimelineRange; label: string }> = [
  { value: '3', label: '3年' },
  { value: '5', label: '5年' },
  { value: '10', label: '10年' },
  { value: 'all', label: '全期間' },
]

const METRIC_LABELS: Record<FinancialTimelineMetric, string> = {
  revenue: '売上高',
  operating_profit: '営業利益',
  eps_basic: 'EPS',
}

function timelineUrl(ticker: string, analysisDate: string | null): string {
  const query = analysisDate ? `?as_of=${encodeURIComponent(analysisDate)}` : ''
  return `/api/financial-performance-timeline/${encodeURIComponent(ticker)}${query}`
}

function visiblePeriods(periods: FinancialTimelinePeriod[], range: TimelineRange): FinancialTimelinePeriod[] {
  if (range === 'all') return periods
  const years = Number(range)
  const actual = periods.filter((period) => period.pointType === 'actual')
  const latestYear = actual
    .map((period) => period.targetFiscalYear ?? Number(period.periodEnd.slice(0, 4)))
    .sort((a, b) => b - a)[0]
  if (!latestYear) return periods
  const minimumYear = latestYear - years + 1
  return periods.filter((period) => (
    period.pointType !== 'actual'
    || (period.targetFiscalYear ?? Number(period.periodEnd.slice(0, 4))) >= minimumYear
  ))
}

function axisLabel(period: FinancialTimelinePeriod): string {
  if (period.pointType === 'current_forecast') return `FY${String(period.targetFiscalYear ?? '').slice(-2)}予`
  if (period.pointType === 'next_forecast') return `FY${String(period.targetFiscalYear ?? '').slice(-2)}翌`
  if (period.periodKind === 'LTM') return period.periodEnd.slice(2, 7).replace('-', '/')
  const fiscal = `FY${String(period.targetFiscalYear ?? period.periodEnd.slice(0, 4)).slice(-2)}`
  return period.periodKind === 'FY' ? fiscal : `${fiscal}${period.periodKind.replace('Q', 'Q')}`
}

function chartData(periods: FinancialTimelinePeriod[], metric: FinancialTimelineMetric): ChartDatum[] {
  return periods.map((period) => {
    const value = period.metrics[metric]?.value
    return {
      key: period.key,
      label: axisLabel(period),
      period,
      actual: period.pointType === 'actual' && value != null ? value : undefined,
      currentForecast: period.pointType === 'current_forecast' && value != null ? value : undefined,
      nextForecast: period.pointType === 'next_forecast' && value != null ? value : undefined,
    }
  })
}

function compactNumber(value: number, metric: FinancialTimelineMetric): string {
  if (metric === 'eps_basic') return value.toLocaleString('ja-JP', { maximumFractionDigits: 1 })
  const absolute = Math.abs(value)
  if (absolute >= 1e12) return `${(value / 1e12).toFixed(1)}兆`
  if (absolute >= 1e8) return `${(value / 1e8).toFixed(0)}億`
  if (absolute >= 1e4) return `${(value / 1e4).toFixed(0)}万`
  return value.toLocaleString('ja-JP', { maximumFractionDigits: 1 })
}

function displayValue(value: FinancialTimelineValue | null, metric: FinancialTimelineMetric): string {
  if (!value) return '—'
  const text = compactNumber(value.value, metric)
  return metric === 'eps_basic' ? `¥${text}` : text
}

function signedPercent(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`
}

function pointTypeLabel(period: FinancialTimelinePeriod): string {
  if (period.pointType === 'current_forecast') return '当期予想'
  if (period.pointType === 'next_forecast') return '翌期予想'
  return '実績'
}

export function FinancialPerformanceTimeline({ ticker, analysisDate }: FinancialPerformanceTimelineProps) {
  const [model, setModel] = useState<FinancialPerformanceTimelineReadModel | null>(null)
  const [mode, setMode] = useState<FinancialTimelineMode>('FY')
  const [range, setRange] = useState<TimelineRange>('5')
  const [mobileMetric, setMobileMetric] = useState<FinancialTimelineMetric>('revenue')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    fetch(timelineUrl(ticker, analysisDate), { cache: 'no-store', signal: controller.signal })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`)))
      .then((payload: FinancialPerformanceTimelineReadModel) => {
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

  const series = model?.modes[mode] ?? null
  const periods = useMemo(() => visiblePeriods(series?.periods ?? [], range), [range, series?.periods])
  const revisions = useMemo(() => periods
    .filter((period) => period.pointType !== 'actual')
    .flatMap((period) => FINANCIAL_TIMELINE_METRICS.flatMap((metric) => {
      const revision = period.metrics[metric]?.revision
      return revision ? [{ period, metric, revision }] : []
    })), [periods])

  return (
    <section className="overflow-hidden border border-[var(--color-border-default)] bg-white" aria-labelledby="financial-timeline-title">
      <header className="border-b border-[var(--color-border-default)] bg-[var(--color-brand-50)] px-3 py-2.5 sm:px-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <BarChart3 size={16} className="shrink-0 text-[var(--color-brand-700)]" aria-hidden="true" />
            <div className="min-w-0">
              <h2 id="financial-timeline-title" className="text-[12px] font-black text-[var(--color-brand-900)]">業績タイムライン</h2>
              <p className="truncate text-[9px] font-semibold text-[var(--color-text-tertiary)]">実績 → 当期会社予想 → 翌期会社予想</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="font-mono text-[9px] font-bold text-[var(--color-text-tertiary)]">基準日 {model?.asOf ?? analysisDate ?? '---'}</div>
            <a href="#performance" className="text-[9px] font-black text-[var(--color-brand-700)] hover:underline">
              業績を詳しく見る →
            </a>
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <SegmentedControl
            label="期間種別"
            options={MODE_OPTIONS}
            value={mode}
            onChange={setMode}
          />
          <SegmentedControl
            label="表示年数"
            options={RANGE_OPTIONS}
            value={range}
            onChange={setRange}
          />
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-[var(--color-border-soft)] px-3 py-1.5 text-[8px] font-bold text-[var(--color-text-tertiary)] sm:px-4">
        <LegendSwatch kind="actual" label="実績" />
        <LegendSwatch kind="current" label="当期会社予想" />
        <LegendSwatch kind="next" label="翌期会社予想" />
        {series?.note && <span className="ml-auto">{series.note}</span>}
      </div>

      {loading ? (
        <div className="grid min-h-64 place-items-center text-[11px] font-bold text-[var(--color-text-tertiary)]">業績時系列を確認中...</div>
      ) : error || !series ? (
        <div className="grid min-h-32 place-items-center px-4 text-center text-[11px] font-bold text-[var(--color-text-tertiary)]">
          業績タイムラインを取得できませんでした。既存のOverview情報は引き続き利用できます。
        </div>
      ) : periods.length === 0 ? (
        <div className="grid min-h-32 place-items-center px-4 text-center text-[11px] font-bold text-[var(--color-text-tertiary)]">
          この期間種別で表示できるデータがありません。
        </div>
      ) : (
        <>
          <div className="hidden lg:block">
            {FINANCIAL_TIMELINE_METRICS.map((metric, index) => (
              <MetricChart
                key={metric}
                metric={metric}
                periods={periods}
                showXAxis={index === FINANCIAL_TIMELINE_METRICS.length - 1}
                compact
              />
            ))}
          </div>

          <div className="lg:hidden">
            <div className="border-b border-[var(--color-border-soft)] px-3 py-2">
              <div className="grid grid-cols-3 border border-[var(--color-border-default)] bg-white">
                {FINANCIAL_TIMELINE_METRICS.map((metric) => (
                  <button
                    key={metric}
                    type="button"
                    onClick={() => setMobileMetric(metric)}
                    aria-pressed={mobileMetric === metric}
                    className={`h-8 border-r border-[var(--color-border-default)] text-[10px] font-black last:border-r-0 ${
                      mobileMetric === metric
                        ? 'bg-[var(--color-brand-900)] text-white'
                        : 'text-[var(--color-text-secondary)]'
                    }`}
                  >
                    {METRIC_LABELS[metric]}
                  </button>
                ))}
              </div>
            </div>
            <MetricChart metric={mobileMetric} periods={periods} showXAxis />
          </div>

          {revisions.length > 0 && mode === 'FY' && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-3 py-2 text-[9px] sm:px-4">
              <span className="font-black text-[var(--color-brand-900)]">直近の予想修正</span>
              {revisions.slice(-3).map(({ period, metric, revision }) => (
                <span key={`${period.key}:${metric}`} className="font-semibold text-[var(--color-text-secondary)]" title={`前回 ${revision.previousValue.toLocaleString('ja-JP')} / ${revision.previousPublishedAt.slice(0, 10)}`}>
                  {period.label.replace(' 会社予想', '').replace(' 翌期予想', '')} {METRIC_LABELS[metric]}
                  {' '}<b className="font-mono text-[var(--color-text-primary)]">{signedPercent(revision.ratePercent)}</b>
                </span>
              ))}
            </div>
          )}

          <TimelineTable periods={periods} />
        </>
      )}
    </section>
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

function MetricChart({
  metric,
  periods,
  showXAxis,
  compact = false,
}: {
  metric: FinancialTimelineMetric
  periods: FinancialTimelinePeriod[]
  showXAxis: boolean
  compact?: boolean
}) {
  const chartFrameRef = useRef<HTMLDivElement>(null)
  const [chartWidth, setChartWidth] = useState(0)
  const data = chartData(periods, metric)
  const available = data.filter((point) => (
    point.actual != null || point.currentForecast != null || point.nextForecast != null
  ))
  const latest = [...periods].reverse().find((period) => period.metrics[metric])?.metrics[metric] ?? null
  const height = compact ? (showXAxis ? 118 : 101) : 178

  useEffect(() => {
    const target = chartFrameRef.current
    if (!target) return
    const update = (width: number) => setChartWidth(Math.max(0, Math.floor(width)))
    update(target.getBoundingClientRect().width)
    const observer = new ResizeObserver((entries) => update(entries[0]?.contentRect.width ?? 0))
    observer.observe(target)
    return () => observer.disconnect()
  }, [])

  return (
    <div className="grid grid-cols-[78px_minmax(0,1fr)] border-b border-[var(--color-border-soft)] last:border-b-0 sm:grid-cols-[92px_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col justify-center border-r border-[var(--color-border-soft)] px-3 py-2 sm:px-4">
        <div className="text-[9px] font-black text-[var(--color-brand-900)]">{METRIC_LABELS[metric]}</div>
        <div className="mt-1 truncate font-mono text-[12px] font-black text-[var(--color-text-primary)]" title={displayValue(latest, metric)}>{displayValue(latest, metric)}</div>
        <div className="mt-0.5 text-[8px] font-semibold text-[var(--color-text-tertiary)]">直近値</div>
      </div>
      <div ref={chartFrameRef} className="min-w-0 px-1 py-1 sm:px-2" style={{ height }}>
        {available.length === 0 ? (
          <div className="grid h-full place-items-center text-[10px] font-bold text-[var(--color-text-tertiary)]">データなし</div>
        ) : chartWidth <= 0 ? (
          <div className="grid h-full place-items-center text-[9px] font-bold text-[var(--color-text-tertiary)]">グラフを準備中...</div>
        ) : (
            <BarChart width={chartWidth} height={height - 8} data={data} margin={{ top: 6, right: 8, left: 0, bottom: showXAxis ? 4 : 0 }} barCategoryGap="22%">
              <CartesianGrid vertical={false} stroke="var(--color-border-soft)" strokeDasharray="2 2" />
              <XAxis
                dataKey="label"
                hide={!showXAxis}
                tick={{ fontSize: 8, fill: 'var(--color-text-tertiary)' }}
                axisLine={{ stroke: 'var(--color-border-default)' }}
                tickLine={false}
                interval="preserveStartEnd"
                minTickGap={14}
              />
              <YAxis
                tick={{ fontSize: 8, fill: 'var(--color-text-tertiary)' }}
                tickFormatter={(value) => compactNumber(Number(value), metric)}
                axisLine={false}
                tickLine={false}
                width={48}
              />
              <ReferenceLine y={0} stroke="var(--color-border-strong)" />
              <Tooltip cursor={{ fill: 'var(--color-surface-subtle)' }} content={<TimelineTooltip metric={metric} />} />
              <Bar dataKey="actual" name="実績" fill="var(--color-brand-700)" maxBarSize={18} isAnimationActive={false} />
              <Bar dataKey="currentForecast" name="当期会社予想" fill="white" stroke="var(--color-brand-700)" strokeWidth={1.5} maxBarSize={18} isAnimationActive={false} />
              <Bar dataKey="nextForecast" name="翌期会社予想" fill="var(--color-brand-50)" stroke="var(--color-brand-700)" strokeWidth={1.5} strokeDasharray="3 2" maxBarSize={18} isAnimationActive={false} />
            </BarChart>
        )}
      </div>
    </div>
  )
}

function TimelineTooltip({
  active,
  payload,
  metric,
}: {
  active?: boolean
  payload?: Array<{ payload?: ChartDatum }>
  metric: FinancialTimelineMetric
}) {
  const datum = payload?.[0]?.payload
  if (!active || !datum) return null
  const value = datum.period.metrics[metric]
  return (
    <div className="border border-[var(--color-border-default)] bg-white px-2.5 py-2 text-[9px] shadow-lg">
      <div className="font-black text-[var(--color-brand-900)]">{datum.period.label}</div>
      <div className="mt-1 flex items-baseline justify-between gap-4">
        <span className="text-[var(--color-text-tertiary)]">{pointTypeLabel(datum.period)}</span>
        <b className="font-mono text-[11px] text-[var(--color-text-primary)]">{displayValue(value, metric)}</b>
      </div>
      {value?.yoyPercent != null && (
        <div className="mt-1 text-[var(--color-text-secondary)]">前年同期比 <b className="font-mono">{signedPercent(value.yoyPercent)}</b></div>
      )}
      {value?.revision && (
        <div className="mt-1 border-t border-[var(--color-border-soft)] pt-1 text-[var(--color-text-secondary)]">
          前回予想 {compactNumber(value.revision.previousValue, metric)} → 修正率 <b className="font-mono">{signedPercent(value.revision.ratePercent)}</b>
        </div>
      )}
      <div className="mt-1 font-mono text-[8px] text-[var(--color-text-tertiary)]">公表 {value?.publishedAt.slice(0, 10) ?? '---'}</div>
    </div>
  )
}

function TimelineTable({ periods }: { periods: FinancialTimelinePeriod[] }) {
  return (
    <div className="border-t border-[var(--color-border-default)]">
      <div className="flex items-center justify-between gap-2 bg-[var(--color-surface-subtle)] px-3 py-1.5 sm:px-4">
        <span className="text-[10px] font-black text-[var(--color-brand-900)]">数値表</span>
        <span className="text-[8px] font-semibold text-[var(--color-text-tertiary)]">予想値は公表日時点のPITスナップショット</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] border-collapse text-right text-[9px]">
          <thead>
            <tr className="border-y border-[var(--color-border-default)] bg-white text-[var(--color-text-tertiary)]">
              <th className="px-3 py-2 text-left font-black">期間</th>
              <th className="px-2 py-2 text-left font-black">区分</th>
              <th className="px-2 py-2 font-black">売上高</th>
              <th className="px-2 py-2 font-black">YoY</th>
              <th className="px-2 py-2 font-black">営業利益</th>
              <th className="px-2 py-2 font-black">YoY</th>
              <th className="px-2 py-2 font-black">EPS</th>
              <th className="px-3 py-2 font-black">公表日</th>
            </tr>
          </thead>
          <tbody>
            {periods.map((period) => {
              const revenue = period.metrics.revenue
              const operatingProfit = period.metrics.operating_profit
              const eps = period.metrics.eps_basic
              return (
                <tr key={period.key} className={`border-b border-[var(--color-border-soft)] ${period.pointType === 'actual' ? 'bg-white' : 'bg-[var(--color-brand-50)]'}`}>
                  <td className="whitespace-nowrap px-3 py-2 text-left font-mono font-black text-[var(--color-text-primary)]">{period.label.replace(' 会社予想', '').replace(' 翌期予想', '')}</td>
                  <td className="px-2 py-2 text-left">
                    <span className={`inline-flex items-center gap-1 whitespace-nowrap font-black ${period.pointType === 'actual' ? 'text-[var(--color-text-secondary)]' : 'text-[var(--color-brand-900)]'}`}>
                      <span className={`h-2 w-3 border border-[var(--color-brand-700)] ${period.pointType === 'actual' ? 'bg-[var(--color-brand-700)]' : 'bg-white'}`} style={{ borderStyle: period.pointType === 'next_forecast' ? 'dashed' : 'solid' }} />
                      {pointTypeLabel(period)}
                    </span>
                  </td>
                  <td className="px-2 py-2 font-mono font-bold">{displayValue(revenue, 'revenue')}</td>
                  <td className="px-2 py-2 font-mono text-[var(--color-text-secondary)]">{signedPercent(revenue?.yoyPercent ?? null)}</td>
                  <td className="px-2 py-2 font-mono font-bold">{displayValue(operatingProfit, 'operating_profit')}</td>
                  <td className="px-2 py-2 font-mono text-[var(--color-text-secondary)]">{signedPercent(operatingProfit?.yoyPercent ?? null)}</td>
                  <td className="px-2 py-2 font-mono font-bold">{displayValue(eps, 'eps_basic')}</td>
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-[var(--color-text-tertiary)]">{period.publishedAt.slice(0, 10) || '---'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
