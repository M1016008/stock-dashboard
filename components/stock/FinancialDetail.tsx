'use client'

import { useEffect, useState } from 'react'
import {
  Activity,
  BarChart3,
  CircleDollarSign,
  Info,
  Landmark,
  Scale,
  Table2,
  WalletCards,
} from 'lucide-react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { MeasuredChartFrame } from '@/components/charts/MeasuredChartFrame'
import type {
  FinancialDetailBalancePeriod,
  FinancialDetailCashFlowPeriod,
  FinancialDetailDefinitionKey,
  FinancialDetailMetricPeriod,
  FinancialDetailPlPeriod,
  FinancialDetailReadModel,
  FinancialDetailValue,
} from '@/lib/financial-detail'
import type { FinancialTimelineMode } from '@/lib/financial-performance-timeline'

interface FinancialDetailProps {
  ticker: string
  analysisDate: string | null
}

type FinancialSubtab = 'summary' | 'metrics' | 'pl' | 'bs' | 'cf'
type PlMetric = keyof FinancialDetailPlPeriod['metrics']
type BsMetric = keyof FinancialDetailBalancePeriod['metrics']
type CashFlowView = 'three' | 'simple'

const SUBTABS: Array<{ id: FinancialSubtab; label: string }> = [
  { id: 'summary', label: 'まとめ' },
  { id: 'metrics', label: '指標' },
  { id: 'pl', label: 'P/L' },
  { id: 'bs', label: 'B/S' },
  { id: 'cf', label: 'C/F' },
]

const MODE_OPTIONS: Array<{ value: FinancialTimelineMode; label: string }> = [
  { value: 'FY', label: 'FY' },
  { value: 'YTD', label: '四半期累積' },
  { value: 'STANDALONE', label: '四半期単独' },
  { value: 'LTM', label: 'LTM' },
]

const PL_METRICS: Array<{ key: PlMetric; label: string }> = [
  { key: 'revenue', label: '売上高' },
  { key: 'operatingProfit', label: '営業利益' },
  { key: 'ordinaryProfit', label: '経常利益' },
  { key: 'netIncome', label: '純利益' },
  { key: 'eps', label: 'EPS' },
]

const BS_METRICS: Array<{ key: BsMetric; label: string }> = [
  { key: 'totalAssets', label: '総資産' },
  { key: 'equity', label: '自己資本' },
  { key: 'equityRatio', label: '自己資本比率' },
  { key: 'bps', label: 'BPS' },
]

const METRIC_COLUMNS: Array<{
  key: keyof FinancialDetailMetricPeriod['metrics']
  label: string
  definition: FinancialDetailDefinitionKey
}> = [
  { key: 'operatingMargin', label: '営業利益率', definition: 'operating_margin' },
  { key: 'netMargin', label: '純利益率', definition: 'net_margin' },
  { key: 'roe', label: 'ROE', definition: 'roe' },
  { key: 'roa', label: 'ROA', definition: 'roa' },
  { key: 'equityRatio', label: '自己資本比率', definition: 'equity_ratio' },
  { key: 'eps', label: 'EPS', definition: 'eps' },
  { key: 'bps', label: 'BPS', definition: 'bps' },
  { key: 'simpleFcf', label: '簡易FCF', definition: 'simple_fcf' },
]

function detailUrl(ticker: string, analysisDate: string | null): string {
  const query = analysisDate ? `?as_of=${encodeURIComponent(analysisDate)}` : ''
  return `/api/financial-detail/${encodeURIComponent(ticker)}${query}`
}

function compactNumber(value: number): string {
  const absolute = Math.abs(value)
  if (absolute >= 1e12) return `${(value / 1e12).toFixed(1)}兆`
  if (absolute >= 1e8) return `${(value / 1e8).toFixed(0)}億`
  if (absolute >= 1e4) return `${(value / 1e4).toFixed(0)}万`
  return value.toLocaleString('ja-JP', { maximumFractionDigits: 1 })
}

function valueText(value: FinancialDetailValue): string {
  if (value.value == null) {
    if (value.availability === 'not_applicable') return 'N/A'
    if (value.availability === 'not_meaningful') return 'N/M'
    return '—'
  }
  if (value.unit === 'PERCENT') return `${value.value.toFixed(1)}%`
  if (value.unit === 'JPY_PER_SHARE') return `¥${value.value.toLocaleString('ja-JP', { maximumFractionDigits: 1 })}`
  if (value.unit === 'MULTIPLE') return `${value.value.toFixed(1)}x`
  return compactNumber(value.value)
}

function chartValue(value: FinancialDetailValue): number | undefined {
  return value.value == null ? undefined : value.value
}

function periodAxisLabel(label: string): string {
  return label.replace(' ', '')
}

export function FinancialDetail({ ticker, analysisDate }: FinancialDetailProps) {
  const [model, setModel] = useState<FinancialDetailReadModel | null>(null)
  const [subtab, setSubtab] = useState<FinancialSubtab>('summary')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    fetch(detailUrl(ticker, analysisDate), { cache: 'no-store', signal: controller.signal })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`)))
      .then((payload: FinancialDetailReadModel) => {
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

  if (loading) {
    return <div className="grid min-h-80 place-items-center border border-[var(--color-border-default)] bg-white text-[11px] font-bold text-[var(--color-text-tertiary)]">財務詳細を読み込んでいます...</div>
  }
  if (error || !model) {
    return <div className="grid min-h-48 place-items-center border border-[var(--color-border-default)] bg-white px-4 text-center text-[11px] font-bold text-[var(--color-text-tertiary)]">財務詳細を取得できませんでした。</div>
  }

  return (
    <section className="space-y-6 bg-white" aria-labelledby="financial-detail-title">
      <header className="overflow-hidden border-y border-[var(--color-border-soft)] bg-white">
        <div className="flex flex-wrap items-end justify-between gap-2 border-b border-[var(--color-border-soft)] px-4 py-3.5 sm:px-5">
          <div className="flex min-w-0 items-center gap-2">
            <Landmark size={17} className="shrink-0 text-[var(--color-brand-700)]" aria-hidden="true" />
            <div>
              <h2 id="financial-detail-title" className="text-[15px] font-bold text-[var(--color-text-primary)]">財務</h2>
              <p className="mt-1 text-[10px] font-medium text-[var(--color-text-tertiary)]">財務状態、キャッシュフロー、資本効率を同じ基準日で確認</p>
            </div>
          </div>
          <div className="font-mono text-[10px] font-semibold text-[var(--color-text-tertiary)]">分析基準日 {model.asOf}</div>
        </div>
        <nav className="grid grid-cols-5 bg-white px-2 sm:px-3" aria-label="財務内メニュー" role="tablist">
          {SUBTABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setSubtab(tab.id)}
              aria-current={subtab === tab.id ? 'page' : undefined}
              aria-selected={subtab === tab.id}
              role="tab"
              className={`h-11 min-w-0 border-b-2 px-1 text-[11px] font-bold sm:px-3 ${
                subtab === tab.id
                  ? 'border-[var(--color-brand-700)] text-[var(--color-brand-900)]'
                  : 'border-transparent text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-subtle)]'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </header>

      {model.isFinancialSector && (
        <div className="border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-4 py-2.5 text-[10px] font-medium text-[var(--color-text-secondary)]">
          銀行・保険・証券等では一般事業会社と定義が異なる営業利益率・純利益率・簡易FCFをN/Aとしています。原数値をゼロには置換していません。
        </div>
      )}

      {subtab === 'summary' && <FinancialSummary model={model} />}
      {subtab === 'metrics' && <FinancialMetrics model={model} />}
      {subtab === 'pl' && <ProfitAndLoss model={model} />}
      {subtab === 'bs' && <BalanceSheet model={model} />}
      {subtab === 'cf' && <CashFlow model={model} />}
    </section>
  )
}

function FinancialSummary({ model }: { model: FinancialDetailReadModel }) {
  const summary = model.summary
  return (
    <section className="overflow-hidden border-y border-[var(--color-border-soft)] bg-white" aria-labelledby="financial-summary-title">
      <SectionHeader icon={Scale} title="財務まとめ" subtitle="正規化factの最新LTM・FY・時点値を使い分け" id="financial-summary-title" />
      <div className="grid gap-x-6 gap-y-2 px-1 py-1 sm:grid-cols-2 lg:grid-cols-[0.95fr_1.05fr_1.2fr_0.8fr]">
        <SummaryBlock title="収益性" note={model.isFinancialSector ? '業種特性を反映' : 'LTM優先'} icon={Activity}>
          <SummaryGrid values={[
            ['営業利益率', summary.profitability.operatingMargin, 'operating_margin'],
            ['純利益率', summary.profitability.netMargin, 'net_margin'],
            ['ROE', summary.profitability.roe, 'roe'],
            ['ROA', summary.profitability.roa, 'roa'],
          ]} primaryLabels={['営業利益率']} model={model} />
        </SummaryBlock>
        <SummaryBlock title="財務健全性" note="最新開示時点" icon={Landmark}>
          <SummaryGrid values={[
            ['自己資本比率', summary.financialHealth.equityRatio, 'equity_ratio'],
            ['総資産', summary.financialHealth.totalAssets, null],
            ['自己資本', summary.financialHealth.equity, null],
            ['BPS', summary.financialHealth.bps, 'bps'],
          ]} primaryLabels={['自己資本比率']} model={model} />
        </SummaryBlock>
        <SummaryBlock title="キャッシュフロー" note="LTM優先・FY補完" icon={WalletCards}>
          <SummaryGrid values={[
            ['営業CF', summary.cashFlow.operatingCashFlow, null],
            ['投資CF', summary.cashFlow.investingCashFlow, null],
            ['財務CF', summary.cashFlow.financingCashFlow, null],
            ['簡易FCF', summary.cashFlow.simpleFcf, 'simple_fcf'],
          ]} primaryLabels={['営業CF', '簡易FCF']} model={model} />
        </SummaryBlock>
        <SummaryBlock title="資本効率" note="平均残高を使用" icon={CircleDollarSign}>
          <SummaryGrid values={[
            ['ROE', summary.capitalEfficiency.roe, 'roe'],
            ['ROA', summary.capitalEfficiency.roa, 'roa'],
            ['EPS', summary.capitalEfficiency.eps, 'eps'],
            ['BPS', summary.capitalEfficiency.bps, 'bps'],
          ]} primaryLabels={['ROE']} model={model} />
        </SummaryBlock>
      </div>
      <DefinitionPanel model={model} keys={['operating_margin', 'net_margin', 'roe', 'roa', 'equity_ratio', 'eps', 'bps', 'simple_fcf']} />
    </section>
  )
}

function SummaryBlock({
  title,
  note,
  icon: Icon,
  children,
}: {
  title: string
  note: string
  icon: typeof Activity
  children: React.ReactNode
}) {
  return (
    <article className="min-w-0 px-4 py-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Icon size={13} className="text-[var(--color-brand-700)]" aria-hidden="true" />
          <h3 className="text-[11px] font-bold text-[var(--color-text-secondary)]">{title}</h3>
        </div>
        <span className="text-[9px] font-medium text-[var(--color-text-tertiary)]">{note}</span>
      </div>
      {children}
    </article>
  )
}

function SummaryGrid({
  values,
  primaryLabels,
  model,
}: {
  values: Array<[string, FinancialDetailValue, FinancialDetailDefinitionKey | null]>
  primaryLabels: string[]
  model: FinancialDetailReadModel
}) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-2">
      {values.map(([label, value, definition]) => (
        <div key={label} className="min-w-0" title={value.reason ?? value.periodLabel ?? undefined}>
          <div className="flex items-center gap-1 text-[10px] font-semibold text-[var(--color-text-tertiary)]">
            <span className="truncate">{label}</span>
            {definition && <DefinitionInfo definition={model.definitions[definition]} />}
          </div>
          <div className={`truncate font-mono text-[var(--color-text-primary)] ${primaryLabels.includes(label) ? 'text-[19px] font-semibold' : 'text-[14px] font-medium'}`}>
            {valueText(value)}
          </div>
          <div className="truncate text-[9px] font-medium text-[var(--color-text-tertiary)]">
            {value.availability === 'not_applicable' ? '業種特性上、対象外' : value.periodLabel ?? value.reason ?? 'データなし'}
          </div>
        </div>
      ))}
    </div>
  )
}

function FinancialMetrics({ model }: { model: FinancialDetailReadModel }) {
  const [basis, setBasis] = useState<'FY' | 'LTM'>('FY')
  const periods = model.metricPeriods[basis]
  return (
    <section className="overflow-hidden border-y border-[var(--color-border-soft)] bg-white" aria-labelledby="financial-metrics-title">
      <SectionHeader icon={Table2} title="財務・収益性指標" subtitle="FYとLTMを混同せず表示" id="financial-metrics-title">
        <SegmentedControl
          label="期間"
          options={[{ value: 'FY', label: 'FY' }, { value: 'LTM', label: 'LTM' }]}
          value={basis}
          onChange={setBasis}
        />
      </SectionHeader>
      <div className="overflow-x-auto">
        <table className="min-w-[1040px] w-full border-collapse text-right text-[10px]">
          <thead className="bg-[var(--color-surface-subtle)] text-[var(--color-text-tertiary)]">
            <tr>
              <th className="sticky left-0 z-10 min-w-24 border-b border-r border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-3 py-2 text-left">期間</th>
              {METRIC_COLUMNS.map((column) => (
                <th key={column.key} className="min-w-28 border-b border-[var(--color-border-default)] px-3 py-2">
                  <span className="inline-flex items-center gap-1">
                    {column.label}
                    <DefinitionInfo definition={model.definitions[column.definition]} />
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {periods.length === 0 ? (
              <tr><td colSpan={9} className="px-4 py-10 text-center text-[var(--color-text-tertiary)]">この期間種別で表示できるデータがありません。</td></tr>
            ) : periods.map((period) => (
              <tr key={period.key} className="border-b border-[var(--color-border-soft)] last:border-b-0">
                <td className="sticky left-0 z-10 border-r border-[var(--color-border-default)] bg-white px-3 py-2 text-left">
                  <div className="font-black text-[var(--color-brand-900)]">{period.label}</div>
                  <div className="font-mono text-[9px] text-[var(--color-text-tertiary)]">{period.accountingStandard}</div>
                </td>
                {METRIC_COLUMNS.map((column) => (
                  <td key={column.key} className="px-3 py-2 font-mono font-bold text-[var(--color-text-primary)]" title={period.metrics[column.key].reason ?? undefined}>
                    {valueText(period.metrics[column.key])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <DefinitionPanel model={model} keys={METRIC_COLUMNS.map((column) => column.definition)} />
    </section>
  )
}

function ProfitAndLoss({ model }: { model: FinancialDetailReadModel }) {
  const [mode, setMode] = useState<FinancialTimelineMode>('FY')
  const [metric, setMetric] = useState<PlMetric>('revenue')
  const periods = model.profitAndLoss[mode]
  const chartData = periods.slice(-10).map((period) => ({
    label: periodAxisLabel(period.label),
    value: chartValue(period.metrics[metric]),
  }))
  return (
    <section className="overflow-hidden border-y border-[var(--color-border-soft)] bg-white" aria-labelledby="financial-pl-title">
      <SectionHeader icon={BarChart3} title="P/L" subtitle="IFRSの経常利益は別概念で代用しません" id="financial-pl-title">
        <SegmentedControl label="期間" options={MODE_OPTIONS} value={mode} onChange={setMode} />
      </SectionHeader>
      <MetricButtons options={PL_METRICS} value={metric} onChange={setMetric} />
      {periods.length === 0 ? <EmptyState /> : (
        <>
          <SingleSeriesChart data={chartData} label={PL_METRICS.find((item) => item.key === metric)?.label ?? ''} />
          <div className="overflow-x-auto border-t border-[var(--color-border-soft)]">
            <table className="min-w-[760px] w-full border-collapse text-right text-[10px]">
              <thead className="bg-[var(--color-surface-subtle)] text-[var(--color-text-tertiary)]">
                <tr>
                  <th className="sticky left-0 z-10 min-w-24 border-b border-r border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-3 py-2 text-left">期間</th>
                  {PL_METRICS.map((item) => <th key={item.key} className="min-w-28 border-b border-[var(--color-border-default)] px-3 py-2">{item.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {periods.map((period) => (
                  <tr key={period.key} className="border-b border-[var(--color-border-soft)] last:border-b-0">
                    <PeriodCell period={period} />
                    {PL_METRICS.map((item) => (
                      <td key={item.key} className="px-3 py-2 font-mono font-bold text-[var(--color-text-primary)]" title={period.metrics[item.key].reason ?? undefined}>
                        {valueText(period.metrics[item.key])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <DefinitionPanel model={model} keys={['eps']} />
    </section>
  )
}

function BalanceSheet({ model }: { model: FinancialDetailReadModel }) {
  const [basis, setBasis] = useState<'FY' | 'QUARTER'>('FY')
  const [metric, setMetric] = useState<BsMetric>('totalAssets')
  const periods = model.balanceSheet[basis]
  const chartData = periods.slice(-10).map((period) => ({
    label: periodAxisLabel(period.label),
    value: chartValue(period.metrics[metric]),
  }))
  return (
    <section className="overflow-hidden border-y border-[var(--color-border-soft)] bg-white" aria-labelledby="financial-bs-title">
      <SectionHeader icon={Landmark} title="B/S" subtitle="時点値のためLTM化しません" id="financial-bs-title">
        <SegmentedControl
          label="時点"
          options={[{ value: 'FY', label: 'FY末' }, { value: 'QUARTER', label: '四半期末' }]}
          value={basis}
          onChange={setBasis}
        />
      </SectionHeader>
      <MetricButtons options={BS_METRICS} value={metric} onChange={setMetric} />
      {periods.length === 0 ? <EmptyState /> : (
        <>
          <SingleSeriesChart data={chartData} label={BS_METRICS.find((item) => item.key === metric)?.label ?? ''} />
          <div className="overflow-x-auto border-t border-[var(--color-border-soft)]">
            <table className="min-w-[660px] w-full border-collapse text-right text-[10px]">
              <thead className="bg-[var(--color-surface-subtle)] text-[var(--color-text-tertiary)]">
                <tr>
                  <th className="sticky left-0 z-10 min-w-24 border-b border-r border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-3 py-2 text-left">時点</th>
                  {BS_METRICS.map((item) => (
                    <th key={item.key} className="min-w-28 border-b border-[var(--color-border-default)] px-3 py-2">
                      <span className="inline-flex items-center gap-1">
                        {item.label}
                        {item.key === 'equityRatio' && <DefinitionInfo definition={model.definitions.equity_ratio} />}
                        {item.key === 'bps' && <DefinitionInfo definition={model.definitions.bps} />}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {periods.map((period) => (
                  <tr key={period.key} className="border-b border-[var(--color-border-soft)] last:border-b-0">
                    <PeriodCell period={period} />
                    {BS_METRICS.map((item) => (
                      <td key={item.key} className="px-3 py-2 font-mono font-bold text-[var(--color-text-primary)]" title={period.metrics[item.key].reason ?? undefined}>
                        {valueText(period.metrics[item.key])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <DefinitionPanel model={model} keys={['equity_ratio', 'bps']} />
    </section>
  )
}

function CashFlow({ model }: { model: FinancialDetailReadModel }) {
  const [mode, setMode] = useState<FinancialTimelineMode>('FY')
  const [view, setView] = useState<CashFlowView>('three')
  const periods = model.cashFlow[mode]
  const data = periods.slice(-10).map((period) => ({
    label: periodAxisLabel(period.label),
    operating: chartValue(period.metrics.operatingCashFlow),
    investing: chartValue(period.metrics.investingCashFlow),
    financing: chartValue(period.metrics.financingCashFlow),
    simple: chartValue(period.metrics.simpleFcf),
  }))
  return (
    <section className="overflow-hidden border-y border-[var(--color-border-soft)] bg-white" aria-labelledby="financial-cf-title">
      <SectionHeader icon={WalletCards} title="C/F" subtitle="簡易FCFは営業CF + 投資CF" id="financial-cf-title">
        <SegmentedControl label="期間" options={MODE_OPTIONS} value={mode} onChange={setMode} />
      </SectionHeader>
      <div className="flex items-center justify-between gap-2 border-b border-[var(--color-border-soft)] px-3 py-2">
        <SegmentedControl
          label="グラフ"
          options={[{ value: 'three', label: '3本CF' }, { value: 'simple', label: '簡易FCF' }]}
          value={view}
          onChange={setView}
        />
        <span className="hidden text-[10px] font-medium text-[var(--color-text-tertiary)] sm:block">標準FCF（営業CF − Capex）とは区別しています</span>
      </div>
      {periods.length === 0 ? <EmptyState /> : (
        <>
          <CashFlowChart data={data} view={view} />
          <div className="overflow-x-auto border-t border-[var(--color-border-soft)]">
            <table className="min-w-[680px] w-full border-collapse text-right text-[10px]">
              <thead className="bg-[var(--color-surface-subtle)] text-[var(--color-text-tertiary)]">
                <tr>
                  <th className="sticky left-0 z-10 min-w-24 border-b border-r border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-3 py-2 text-left">期間</th>
                  <th className="min-w-28 border-b border-[var(--color-border-default)] px-3 py-2">営業CF</th>
                  <th className="min-w-28 border-b border-[var(--color-border-default)] px-3 py-2">投資CF</th>
                  <th className="min-w-28 border-b border-[var(--color-border-default)] px-3 py-2">財務CF</th>
                  <th className="min-w-28 border-b border-[var(--color-border-default)] px-3 py-2">
                    <span className="inline-flex items-center gap-1">簡易FCF <DefinitionInfo definition={model.definitions.simple_fcf} /></span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {periods.map((period) => (
                  <tr key={period.key} className="border-b border-[var(--color-border-soft)] last:border-b-0">
                    <PeriodCell period={period} />
                    <ValueCell value={period.metrics.operatingCashFlow} />
                    <ValueCell value={period.metrics.investingCashFlow} />
                    <ValueCell value={period.metrics.financingCashFlow} />
                    <ValueCell value={period.metrics.simpleFcf} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <DefinitionPanel model={model} keys={['simple_fcf']} />
    </section>
  )
}

function SectionHeader({
  icon: Icon,
  title,
  subtitle,
  id,
  children,
}: {
  icon: typeof Landmark
  title: string
  subtitle: string
  id: string
  children?: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border-soft)] px-4 py-3 sm:px-5">
      <div className="flex items-center gap-2">
        <Icon size={15} className="text-[var(--color-brand-700)]" aria-hidden="true" />
        <div>
          <h3 id={id} className="text-[13px] font-bold text-[var(--color-text-primary)]">{title}</h3>
          <p className="mt-1 text-[10px] font-medium text-[var(--color-text-tertiary)]">{subtitle}</p>
        </div>
      </div>
      {children}
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
      <span className="shrink-0 text-[10px] font-bold text-[var(--color-text-tertiary)]">{label}</span>
      <div className="flex min-w-0 overflow-x-auto border border-[var(--color-border-default)] bg-white">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            aria-pressed={value === option.value}
            className={`h-8 shrink-0 border-r border-[var(--color-border-default)] px-2.5 text-[10px] font-bold last:border-r-0 ${
              value === option.value ? 'bg-[var(--color-brand-900)] text-white' : 'text-[var(--color-text-secondary)]'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function MetricButtons<T extends string>({
  options,
  value,
  onChange,
}: {
  options: Array<{ key: T; label: string }>
  value: T
  onChange: (value: T) => void
}) {
  return (
    <div className="flex overflow-x-auto border-b border-[var(--color-border-soft)] px-3 py-2">
      {options.map((option) => (
        <button
          key={option.key}
          type="button"
          onClick={() => onChange(option.key)}
          aria-pressed={value === option.key}
          className={`h-8 shrink-0 border border-r-0 border-[var(--color-border-default)] px-2.5 text-[10px] font-bold last:border-r ${
            value === option.key ? 'bg-[var(--color-brand-900)] text-white' : 'bg-white text-[var(--color-text-secondary)]'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

function SingleSeriesChart({ data, label }: { data: Array<{ label: string; value?: number }>; label: string }) {
  return (
    <MeasuredChartFrame className="h-56 px-2 py-3 sm:h-64 sm:px-4">
      {({ width, height }) => <BarChart width={width} height={height} data={data} margin={{ top: 6, right: 8, bottom: 0, left: 4 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border-soft)" />
          <XAxis dataKey="label" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
          <YAxis tick={{ fontSize: 10 }} tickFormatter={(value) => compactNumber(Number(value))} width={48} />
          <Tooltip formatter={(value) => [compactNumber(Number(value)), label]} />
          <ReferenceLine y={0} stroke="var(--color-border-strong)" />
          <Bar dataKey="value" name={label} fill="var(--color-brand-700)" radius={[2, 2, 0, 0]} maxBarSize={40} />
      </BarChart>}
    </MeasuredChartFrame>
  )
}

function CashFlowChart({
  data,
  view,
}: {
  data: Array<{ label: string; operating?: number; investing?: number; financing?: number; simple?: number }>
  view: CashFlowView
}) {
  return (
    <MeasuredChartFrame className="h-64 px-2 py-3 sm:h-72 sm:px-4">
      {({ width, height }) => <ComposedChart width={width} height={height} data={data} margin={{ top: 6, right: 8, bottom: 0, left: 4 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border-soft)" />
          <XAxis dataKey="label" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
          <YAxis tick={{ fontSize: 10 }} tickFormatter={(value) => compactNumber(Number(value))} width={48} />
          <Tooltip formatter={(value, name) => [compactNumber(Number(value)), String(name)]} />
          <ReferenceLine y={0} stroke="var(--color-border-strong)" />
          {view === 'three' ? (
            <>
              <Legend wrapperStyle={{ fontSize: 9 }} />
              <Bar dataKey="operating" name="営業CF" fill="#1d4ed8" maxBarSize={22} />
              <Bar dataKey="investing" name="投資CF" fill="#0f766e" maxBarSize={22} />
              <Bar dataKey="financing" name="財務CF" fill="#7c3aed" maxBarSize={22} />
            </>
          ) : (
            <Line dataKey="simple" name="簡易FCF" stroke="var(--color-brand-700)" strokeWidth={2} strokeDasharray="5 3" dot={{ r: 3 }} connectNulls={false} />
          )}
      </ComposedChart>}
    </MeasuredChartFrame>
  )
}

function PeriodCell({
  period,
}: {
  period: FinancialDetailPlPeriod | FinancialDetailBalancePeriod | FinancialDetailCashFlowPeriod
}) {
  return (
    <td className="sticky left-0 z-10 border-r border-[var(--color-border-default)] bg-white px-3 py-2 text-left">
      <div className="font-black text-[var(--color-brand-900)]">{period.label}</div>
      <div className="font-mono text-[9px] text-[var(--color-text-tertiary)]">{period.accountingStandard}</div>
    </td>
  )
}

function ValueCell({ value }: { value: FinancialDetailValue }) {
  return (
    <td className="px-3 py-2 font-mono font-bold text-[var(--color-text-primary)]" title={value.reason ?? undefined}>
      {valueText(value)}
    </td>
  )
}

function DefinitionInfo({ definition }: { definition: FinancialDetailReadModel['definitions'][FinancialDetailDefinitionKey] }) {
  const title = [
    definition.formula,
    `期間: ${definition.periodBasis}`,
    `データ: ${definition.dataSource}`,
    `定義: ${definition.version}`,
  ].join('\n')
  return (
    <span className="inline-flex shrink-0" title={title} aria-label={`${definition.displayName}の定義: ${title}`}>
      <Info size={10} aria-hidden="true" />
    </span>
  )
}

function DefinitionPanel({
  model,
  keys,
}: {
  model: FinancialDetailReadModel
  keys: FinancialDetailDefinitionKey[]
}) {
  const uniqueKeys = [...new Set(keys)]
  return (
    <details className="border-t border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-3 py-2 sm:px-4">
      <summary className="cursor-pointer text-[9px] font-black text-[var(--color-brand-800)]">指標定義・使用期間・データソース</summary>
      <div className="mt-2 grid gap-2 md:grid-cols-2">
        {uniqueKeys.map((key) => {
          const definition = model.definitions[key]
          return (
            <div key={key} className="border-l-2 border-[var(--color-border-strong)] pl-2 text-[10px] leading-5 text-[var(--color-text-secondary)]">
              <div className="font-black text-[var(--color-text-primary)]">{definition.displayName} <span className="font-mono font-semibold text-[var(--color-text-tertiary)]">{definition.version}</span></div>
              <div>{definition.formula}</div>
              <div>期間 {definition.periodBasis} / 出典 {definition.dataSource}</div>
            </div>
          )
        })}
      </div>
    </details>
  )
}

function EmptyState() {
  return <div className="grid min-h-48 place-items-center px-4 text-center text-[10px] font-bold text-[var(--color-text-tertiary)]">この期間種別で表示できるデータがありません。</div>
}
