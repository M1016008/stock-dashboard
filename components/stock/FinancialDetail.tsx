'use client'

import { useEffect, useState } from 'react'
import {
  ArrowDown,
  ArrowRight,
  BarChart3,
  CircleDollarSign,
  Landmark,
  Scale,
  ShieldCheck,
  Table2,
  TrendingUp,
  WalletCards,
  type LucideIcon,
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
import {
  compactNumberJa,
  formatUnitValue,
  UNAVAILABLE_LEGEND,
} from '@/components/stock/fundamentals/format'
import {
  BarLadder,
  DefinitionTip,
  ErrorBlock,
  Fact,
  LoadingBlock,
  PanelSection,
  ReadingLine,
  Segmented,
  ShareMeter,
  TabBanner,
  TabSwitch,
  UnavailableNote,
  type BarRow,
} from '@/components/stock/fundamentals/primitives'

interface FinancialDetailProps {
  ticker: string
  analysisDate: string | null
}

type FinancialSubtab = 'summary' | 'metrics' | 'pl' | 'bs' | 'cf'
type PlMetric = keyof FinancialDetailPlPeriod['metrics']
type BsMetric = keyof FinancialDetailBalancePeriod['metrics']
type CashFlowView = 'three' | 'simple'
type Definition = FinancialDetailReadModel['definitions'][FinancialDetailDefinitionKey]

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

const PL_METRICS: Array<{ value: PlMetric; label: string }> = [
  { value: 'revenue', label: '売上高' },
  { value: 'operatingProfit', label: '営業利益' },
  { value: 'ordinaryProfit', label: '経常利益' },
  { value: 'netIncome', label: '純利益' },
  { value: 'eps', label: 'EPS' },
]

const BS_METRICS: Array<{ value: BsMetric; label: string }> = [
  { value: 'totalAssets', label: '総資産' },
  { value: 'equity', label: '自己資本' },
  { value: 'equityRatio', label: '自己資本比率' },
  { value: 'bps', label: 'BPS' },
]

type MetricKey = keyof FinancialDetailMetricPeriod['metrics']

/** 指標表は「観点」ごとにまとめる(安全性・収益性・資本効率・キャッシュ創出)。 */
const METRIC_GROUPS: Array<{
  id: string
  label: string
  columns: Array<{ key: MetricKey; label: string; definition: FinancialDetailDefinitionKey }>
}> = [
  {
    id: 'safety',
    label: '安全性',
    columns: [{ key: 'equityRatio', label: '自己資本比率', definition: 'equity_ratio' }],
  },
  {
    id: 'profitability',
    label: '収益性',
    columns: [
      { key: 'operatingMargin', label: '営業利益率', definition: 'operating_margin' },
      { key: 'netMargin', label: '純利益率', definition: 'net_margin' },
    ],
  },
  {
    id: 'efficiency',
    label: '資本効率',
    columns: [
      { key: 'roe', label: 'ROE', definition: 'roe' },
      { key: 'roa', label: 'ROA', definition: 'roa' },
      { key: 'eps', label: 'EPS', definition: 'eps' },
      { key: 'bps', label: 'BPS', definition: 'bps' },
    ],
  },
  {
    id: 'cash',
    label: 'キャッシュ創出',
    columns: [{ key: 'simpleFcf', label: '簡易FCF', definition: 'simple_fcf' }],
  },
]
const METRIC_COLUMNS = METRIC_GROUPS.flatMap((group) => group.columns)

function detailUrl(ticker: string, analysisDate: string | null): string {
  const query = analysisDate ? `?as_of=${encodeURIComponent(analysisDate)}` : ''
  return `/api/financial-detail/${encodeURIComponent(ticker)}${query}`
}

function valueText(value: FinancialDetailValue): string {
  return formatUnitValue(value.value, value.unit, value.availability).text
}

function isUnavailable(value: FinancialDetailValue): boolean {
  return value.value == null
}

function chartValue(value: FinancialDetailValue): number | undefined {
  return value.value == null ? undefined : value.value
}

function periodAxisLabel(label: string): string {
  return label.replace(' ', '')
}

function firstPeriodLabel(...values: FinancialDetailValue[]): string | null {
  return values.find((value) => value.periodLabel)?.periodLabel ?? null
}

export function FinancialDetail({ ticker, analysisDate }: FinancialDetailProps) {
  const [model, setModel] = useState<FinancialDetailReadModel | null>(null)
  const [subtab, setSubtab] = useState<FinancialSubtab>('summary')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [reloadKey, setReloadKey] = useState(0)

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
  }, [analysisDate, ticker, reloadKey])

  if (loading) return <LoadingBlock label="財務詳細を読み込んでいます..." />
  if (error || !model) {
    return <ErrorBlock label="財務詳細を取得できませんでした。" onRetry={() => setReloadKey((value) => value + 1)} />
  }

  return (
    <section className="space-y-5 bg-white" aria-labelledby="financial-detail-title">
      <div className="overflow-hidden bg-white">
        <TabBanner
          icon={Landmark}
          id="financial-detail-title"
          title="財務"
          lead="安全性・収益性・資本効率・キャッシュ創出の4観点で見て、P/L・B/S・C/Fの原データへ進みます。"
          meta={<span>分析基準日 {model.asOf}</span>}
          flow={['4観点のまとめ', '指標の推移', 'P/L・B/S・C/F', '定義']}
        />
        <nav className="grid grid-cols-5 border-b border-[var(--color-border-soft)] bg-white px-2 sm:px-3" aria-label="財務内メニュー" role="tablist">
          {SUBTABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setSubtab(tab.id)}
              aria-current={subtab === tab.id ? 'page' : undefined}
              aria-selected={subtab === tab.id}
              role="tab"
              className={`h-11 min-w-0 border-b-2 px-1 text-[12px] font-bold focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--color-brand-700)] sm:px-3 ${
                subtab === tab.id
                  ? 'border-[var(--color-brand-700)] text-[var(--color-brand-900)]'
                  : 'border-transparent text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-subtle)]'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {model.isFinancialSector && (
        <div className="px-4 sm:px-5">
          <UnavailableNote>
            銀行・保険・証券等では一般事業会社と定義が異なる営業利益率・純利益率・簡易FCFを「対象外」としています。原数値をゼロには置換していません。
          </UnavailableNote>
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

/* ------------------------------------------------------------------ */
/* まとめ: 4観点 + B/S・P/L・C/Fのつながり                               */
/* ------------------------------------------------------------------ */

function tip(model: FinancialDetailReadModel, key: FinancialDetailDefinitionKey) {
  const definition = model.definitions[key]
  return <DefinitionTip term={definition.displayName}><DefinitionBody definition={definition} /></DefinitionTip>
}

function DefinitionBody({ definition }: { definition: Definition }) {
  return (
    <>
      <span className="block">{definition.formula}</span>
      <span className="mt-1 block text-[var(--color-text-tertiary)]">期間: {definition.periodBasis} / 出典: {definition.dataSource}</span>
      <span className="block font-mono text-[11px] text-[var(--color-text-tertiary)]">{definition.version}</span>
    </>
  )
}

function ratioBar(key: string, label: string, value: FinancialDetailValue, tipNode?: React.ReactNode): BarRow {
  return { key, label, value: value.value, text: valueText(value), note: value.reason, tip: tipNode }
}

function FinancialSummary({ model }: { model: FinancialDetailReadModel }) {
  const summary = model.summary
  const health = summary.financialHealth
  const profitability = summary.profitability
  const efficiency = summary.capitalEfficiency
  const cash = summary.cashFlow
  return (
    <>
      <PanelSection
        icon={Scale}
        id="financial-summary-title"
        title="4つの観点"
        lead="それぞれの指標を1か所にだけ表示(ROE・EPS・BPSの重複なし)。出所の財務諸表も明記"
        bleed
      >
        <div className="grid gap-px bg-[var(--color-border-soft)] md:grid-cols-2">
          <ViewPanel icon={ShieldCheck} title="安全性" source="B/S" role="自己資本の厚み(時点値)" basis={firstPeriodLabel(health.equityRatio) ?? '最新開示時点'}>
            <ShareMeter label="自己資本比率" value={health.equityRatio.value} text={valueText(health.equityRatio)} max={100} />
            <div className="mt-1 text-[11px] font-medium text-[var(--color-text-tertiary)]">{tipLabel(model, 'equity_ratio')}</div>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <Fact label="総資産" value={valueText(health.totalAssets)} unavailable={isUnavailable(health.totalAssets)} sub={health.totalAssets.periodLabel} />
              <Fact label="自己資本" value={valueText(health.equity)} unavailable={isUnavailable(health.equity)} sub={health.equity.periodLabel} />
            </div>
          </ViewPanel>

          <ViewPanel icon={TrendingUp} title="収益性" source="P/L" role="売上に対する利益の割合" basis={firstPeriodLabel(profitability.operatingMargin, profitability.netMargin) ?? 'LTM優先'}>
            <BarLadder
              mode="signed"
              rows={[
                ratioBar('om', '営業利益率', profitability.operatingMargin, tip(model, 'operating_margin')),
                ratioBar('nm', '純利益率', profitability.netMargin, tip(model, 'net_margin')),
              ]}
            />
          </ViewPanel>

          <ViewPanel icon={CircleDollarSign} title="資本効率" source="P/L × B/S" role="自己資本・総資産(平均残高)に対する利益と、1株あたりの水準" basis={firstPeriodLabel(efficiency.roe, efficiency.roa) ?? '平均残高を使用'}>
            <BarLadder
              mode="signed"
              rows={[
                ratioBar('roe', 'ROE', efficiency.roe, tip(model, 'roe')),
                ratioBar('roa', 'ROA', efficiency.roa, tip(model, 'roa')),
              ]}
            />
            <div className="mt-3 grid grid-cols-2 gap-3">
              <Fact label="EPS(P/L由来)" value={valueText(efficiency.eps)} unavailable={isUnavailable(efficiency.eps)} sub={efficiency.eps.periodLabel} tip={tip(model, 'eps')} />
              <Fact label="BPS(B/S由来)" value={valueText(efficiency.bps)} unavailable={isUnavailable(efficiency.bps)} sub={efficiency.bps.periodLabel} tip={tip(model, 'bps')} />
            </div>
          </ViewPanel>

          <ViewPanel icon={WalletCards} title="キャッシュ創出" source="C/F" role="営業・投資・財務キャッシュフローの向きと規模(同じ円目盛り)" basis={firstPeriodLabel(cash.operatingCashFlow, cash.simpleFcf) ?? 'LTM優先・FY補完'}>
            <BarLadder
              mode="signed"
              rows={[
                ratioBar('ocf', '営業CF', cash.operatingCashFlow),
                ratioBar('icf', '投資CF', cash.investingCashFlow),
                ratioBar('fin', '財務CF', cash.financingCashFlow),
                ratioBar('sfcf', '簡易FCF', cash.simpleFcf, tip(model, 'simple_fcf')),
              ]}
            />
          </ViewPanel>
        </div>
      </PanelSection>

      <StatementLinks model={model} />

      <DefinitionPanel model={model} keys={['equity_ratio', 'operating_margin', 'net_margin', 'roe', 'roa', 'eps', 'bps', 'simple_fcf']} />
    </>
  )
}

// Presentation-only Japanese supplemental line for the summary meter. The canonical
// definition object (formula/version/source) is untouched and still feeds the definition panel.
const EQUITY_RATIO_SUMMARY_NOTE = '最新開示値(親会社帰属ベース)'

function tipLabel(model: FinancialDetailReadModel, key: FinancialDetailDefinitionKey): string {
  if (key === 'equity_ratio') return EQUITY_RATIO_SUMMARY_NOTE
  return model.definitions[key].formula
}

function ViewPanel({
  icon: Icon,
  title,
  source,
  role,
  basis,
  children,
}: {
  icon: LucideIcon
  title: string
  source: string
  role: string
  basis: string
  children: React.ReactNode
}) {
  return (
    <article className="min-w-0 bg-white px-4 py-4 sm:px-5" data-financial-view={title}>
      <header className="mb-2.5 flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div className="min-w-0">
          <h4 className="flex items-center gap-1.5 text-[14px] font-bold text-[var(--color-text-primary)]">
            <Icon size={15} className="text-[var(--color-brand-700)]" aria-hidden="true" />{title}
          </h4>
          <p className="mt-0.5 text-[11px] font-medium leading-4 text-[var(--color-text-tertiary)]">{role}</p>
        </div>
        <div className="flex flex-col items-end gap-0.5 text-right">
          <span className="border border-[var(--color-brand-100)] bg-[var(--color-brand-50)] px-1.5 py-0.5 font-mono text-[11px] font-bold leading-4 text-[var(--color-brand-900)]" style={{ borderRadius: 'var(--radius-tag)' }}>{source}</span>
          <span className="font-mono text-[11px] font-medium leading-4 text-[var(--color-text-tertiary)]">{basis}</span>
        </div>
      </header>
      {children}
    </article>
  )
}

/** P/L(期間の成果) → C/F(現金の動き) → B/S(期末の蓄積) のつながり。既存の同一期間の値だけを並べる。 */
function StatementLinks({ model }: { model: FinancialDetailReadModel }) {
  const pl = model.profitAndLoss.FY.at(-1) ?? null
  const cf = pl ? model.cashFlow.FY.find((period) => period.periodEnd === pl.periodEnd) ?? null : null
  const bs = pl ? model.balanceSheet.FY.find((period) => period.periodEnd === pl.periodEnd) ?? null : null
  const net = pl?.metrics.netIncome ?? null
  const ocf = cf?.metrics.operatingCashFlow ?? null
  const reading = net?.value != null && ocf?.value != null
    ? net.value === ocf.value ? 'same' : ocf.value > net.value ? 'higher' : 'lower'
    : null
  const steps: Array<{ key: string; source: string; role: string; label: string; value: FinancialDetailValue | null; period: string | null }> = [
    { key: 'pl', source: 'P/L', role: '期間の成果', label: '純利益', value: net, period: pl?.label ?? null },
    { key: 'cf', source: 'C/F', role: '現金の動き', label: '営業CF', value: ocf, period: cf?.label ?? null },
    { key: 'bs', source: 'B/S', role: '期末の状態', label: '自己資本', value: bs?.metrics.equity ?? null, period: bs ? `${bs.label}末` : null },
  ]
  return (
    <PanelSection
      icon={BarChart3}
      id="financial-statement-links-title"
      title="B/S・P/L・C/Fのつながり"
      lead="同じ最新FYの値を、損益(期間) → 現金(期間) → 純資産(時点)の順に並べます"
    >
      {!pl ? (
        <UnavailableNote>FYのP/Lがないため、3表のつながりは表示できません。</UnavailableNote>
      ) : (
        <>
          <ol className="m-0 grid list-none grid-cols-1 items-stretch gap-2 p-0 md:grid-cols-[1fr_auto_1fr_auto_1fr]" aria-label="P/L、C/F、B/Sの順">
            {steps.flatMap((step, index) => {
              const cell = (
                <li key={step.key} className="min-w-0 border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-3 py-2.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-mono text-[12px] font-bold text-[var(--color-brand-900)]">{step.source}</span>
                    <span className="text-[11px] font-medium text-[var(--color-text-tertiary)]">{step.role}</span>
                  </div>
                  <Fact
                    label={step.label}
                    value={step.value ? valueText(step.value) : 'データなし'}
                    unavailable={!step.value || isUnavailable(step.value)}
                    sub={step.period}
                    emphasis
                  />
                </li>
              )
              if (index === steps.length - 1) return [cell]
              return [
                cell,
                <li key={`${step.key}-arrow`} aria-hidden="true" className="flex items-center justify-center text-[var(--color-text-tertiary)]">
                  <ArrowRight size={16} className="hidden md:block" />
                  <ArrowDown size={16} className="md:hidden" />
                </li>,
              ]
            })}
          </ol>
          <ul className="m-0 mt-3 list-none space-y-1 p-0">
            {reading && net && ocf && (
              <ReadingLine direction={reading}>
                {pl.label}の営業CFは純利益{reading === 'same' ? 'と同額' : reading === 'higher' ? 'を上回る' : 'を下回る'}
                <span className="ml-1 font-medium text-[var(--color-text-tertiary)]">(同一期間・同じ円単位の2値の比較)</span>
              </ReadingLine>
            )}
            <li className="text-[12px] font-medium leading-5 text-[var(--color-text-secondary)]">
              ROE・ROAは P/L の利益 ÷ B/S の平均残高、簡易FCFは C/F の営業CF + 投資CF で定義しています(下の定義で式を確認)。
            </li>
          </ul>
        </>
      )}
    </PanelSection>
  )
}

/* ------------------------------------------------------------------ */
/* 指標                                                                 */
/* ------------------------------------------------------------------ */

function FinancialMetrics({ model }: { model: FinancialDetailReadModel }) {
  const [basis, setBasis] = useState<'FY' | 'LTM'>('FY')
  const periods = model.metricPeriods[basis]
  return (
    <>
      <PanelSection
        icon={Table2}
        id="financial-metrics-title"
        title="財務・収益性指標"
        lead="安全性 → 収益性 → 資本効率 → キャッシュ創出の順。FYとLTMは混同せず切り替え"
        bleed
        aside={(
          <Segmented
            label="期間"
            options={[{ value: 'FY' as const, label: 'FY' }, { value: 'LTM' as const, label: 'LTM' }]}
            value={basis}
            onChange={setBasis}
          />
        )}
      >
        {periods.length === 0 ? <EmptyState /> : (
          <>
            <PeriodCards
              periods={periods}
              groups={METRIC_GROUPS.map((group) => ({
                label: group.label,
                items: group.columns.map((column) => ({ label: column.label, value: (period) => (period as FinancialDetailMetricPeriod).metrics[column.key] })),
              }))}
            />
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full min-w-[920px] border-collapse text-right text-[12px]">
                <thead className="bg-[var(--color-surface-subtle)] text-[var(--color-text-tertiary)]">
                  <tr>
                    <th rowSpan={2} className="sticky left-0 z-10 min-w-24 border-b border-r border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-3 py-2 text-left">期間</th>
                    {METRIC_GROUPS.map((group) => (
                      <th key={group.id} colSpan={group.columns.length} className="border-b border-l border-[var(--color-border-soft)] px-3 py-1.5 text-center text-[11px] font-bold text-[var(--color-brand-900)]">{group.label}</th>
                    ))}
                  </tr>
                  <tr>
                    {METRIC_COLUMNS.map((column) => (
                      <th key={column.key} className="min-w-24 border-b border-[var(--color-border-default)] px-3 py-2" title={model.definitions[column.definition].formula}>{column.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {periods.map((period) => (
                    <tr key={period.key} className="border-b border-[var(--color-border-soft)] last:border-b-0">
                      <td className="sticky left-0 z-10 border-r border-[var(--color-border-default)] bg-white px-3 py-2 text-left">
                        <div className="font-black text-[var(--color-brand-900)]">{period.label}</div>
                        <div className="font-mono text-[11px] text-[var(--color-text-tertiary)]">{period.accountingStandard}</div>
                      </td>
                      {METRIC_COLUMNS.map((column) => <ValueCell key={column.key} value={period.metrics[column.key]} />)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </PanelSection>
      <DefinitionPanel model={model} keys={METRIC_COLUMNS.map((column) => column.definition)} />
    </>
  )
}

/* ------------------------------------------------------------------ */
/* P/L・B/S・C/F                                                        */
/* ------------------------------------------------------------------ */

function StatementFlow({ current }: { current: 'pl' | 'bs' | 'cf' }) {
  const items: Array<{ id: 'pl' | 'cf' | 'bs'; label: string; role: string }> = [
    { id: 'pl', label: 'P/L', role: '期間の成果' },
    { id: 'cf', label: 'C/F', role: '現金の動き' },
    { id: 'bs', label: 'B/S', role: '期末の状態' },
  ]
  return (
    <ol className="m-0 flex list-none flex-wrap items-center gap-x-1.5 gap-y-1 p-0 text-[11px]" aria-label="3表の関係">
      {items.map((item, index) => (
        <li key={item.id} className="inline-flex items-center gap-1.5" aria-current={item.id === current ? 'true' : undefined}>
          <span className={`inline-flex items-center gap-1 border px-1.5 py-0.5 font-bold ${item.id === current ? 'border-[var(--color-brand-900)] bg-[var(--color-brand-900)] text-white' : 'border-[var(--color-border-default)] text-[var(--color-text-secondary)]'}`} style={{ borderRadius: 'var(--radius-tag)' }}>
            <span className="font-mono">{item.label}</span>
            <span className="font-medium">{item.role}</span>
          </span>
          {index < items.length - 1 && <ArrowRight size={12} aria-hidden="true" className="text-[var(--color-text-tertiary)]" />}
        </li>
      ))}
    </ol>
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
    <>
      <PanelSection
        icon={BarChart3}
        id="financial-pl-title"
        title="P/L(損益計算書)"
        lead="期間の成果。IFRSの経常利益は別概念で代用しません"
        bleed
        aside={<Segmented label="期間" options={MODE_OPTIONS} value={mode} onChange={setMode} />}
      >
        <div className="border-b border-[var(--color-border-soft)] px-4 py-2 sm:px-5"><StatementFlow current="pl" /></div>
        <TabSwitch label="P/Lのグラフ指標" options={PL_METRICS} value={metric} onChange={setMetric} />
        {periods.length === 0 ? <EmptyState /> : (
          <>
            <SingleSeriesChart data={chartData} label={PL_METRICS.find((item) => item.value === metric)?.label ?? ''} />
            <StatementTable
              periods={periods}
              columns={PL_METRICS.map((item) => ({ label: item.label, value: (period) => (period as FinancialDetailPlPeriod).metrics[item.value] }))}
            />
          </>
        )}
      </PanelSection>
      <DefinitionPanel model={model} keys={['eps']} />
    </>
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
    <>
      <PanelSection
        icon={Landmark}
        id="financial-bs-title"
        title="B/S(貸借対照表)"
        lead="期末の状態(時点値)。時点値のためLTM化しません"
        bleed
        aside={(
          <Segmented
            label="時点"
            options={[{ value: 'FY' as const, label: 'FY末' }, { value: 'QUARTER' as const, label: '四半期末' }]}
            value={basis}
            onChange={setBasis}
          />
        )}
      >
        <div className="border-b border-[var(--color-border-soft)] px-4 py-2 sm:px-5"><StatementFlow current="bs" /></div>
        <TabSwitch label="B/Sのグラフ指標" options={BS_METRICS} value={metric} onChange={setMetric} />
        {periods.length === 0 ? <EmptyState /> : (
          <>
            <SingleSeriesChart data={chartData} label={BS_METRICS.find((item) => item.value === metric)?.label ?? ''} />
            <StatementTable
              periods={periods}
              firstHeader="時点"
              columns={BS_METRICS.map((item) => ({ label: item.label, value: (period) => (period as FinancialDetailBalancePeriod).metrics[item.value] }))}
            />
          </>
        )}
      </PanelSection>
      <DefinitionPanel model={model} keys={['equity_ratio', 'bps']} />
    </>
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
    <>
      <PanelSection
        icon={WalletCards}
        id="financial-cf-title"
        title="C/F(キャッシュフロー計算書)"
        lead="期間の現金の動き。簡易FCFは営業CF + 投資CFで、標準FCF(営業CF − Capex)とは区別しています"
        bleed
        aside={<Segmented label="期間" options={MODE_OPTIONS} value={mode} onChange={setMode} />}
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border-soft)] px-4 py-2 sm:px-5">
          <StatementFlow current="cf" />
          <Segmented
            label="グラフ"
            options={[{ value: 'three' as const, label: '3本CF' }, { value: 'simple' as const, label: '簡易FCF' }]}
            value={view}
            onChange={setView}
          />
        </div>
        {periods.length === 0 ? <EmptyState /> : (
          <>
            <CashFlowChart data={data} view={view} />
            <StatementTable
              periods={periods}
              columns={[
                { label: '営業CF', value: (period) => (period as FinancialDetailCashFlowPeriod).metrics.operatingCashFlow },
                { label: '投資CF', value: (period) => (period as FinancialDetailCashFlowPeriod).metrics.investingCashFlow },
                { label: '財務CF', value: (period) => (period as FinancialDetailCashFlowPeriod).metrics.financingCashFlow },
                { label: '簡易FCF', value: (period) => (period as FinancialDetailCashFlowPeriod).metrics.simpleFcf },
              ]}
            />
          </>
        )}
      </PanelSection>
      <DefinitionPanel model={model} keys={['simple_fcf']} />
    </>
  )
}

/* ------------------------------------------------------------------ */
/* 共通: 表(デスクトップ) + カード(モバイル)                             */
/* ------------------------------------------------------------------ */

type AnyPeriod = FinancialDetailPlPeriod | FinancialDetailBalancePeriod | FinancialDetailCashFlowPeriod | FinancialDetailMetricPeriod

interface PeriodColumn {
  label: string
  value: (period: AnyPeriod) => FinancialDetailValue
}

function StatementTable({
  periods,
  columns,
  firstHeader = '期間',
}: {
  periods: AnyPeriod[]
  columns: PeriodColumn[]
  firstHeader?: string
}) {
  return (
    <div className="border-t border-[var(--color-border-soft)]">
      <PeriodCards periods={periods} groups={[{ label: null, items: columns }]} />
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full min-w-[640px] border-collapse text-right text-[12px]">
          <thead className="bg-[var(--color-surface-subtle)] text-[var(--color-text-tertiary)]">
            <tr>
              <th className="sticky left-0 z-10 min-w-24 border-b border-r border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-3 py-2 text-left">{firstHeader}</th>
              {columns.map((column) => <th key={column.label} className="min-w-28 border-b border-[var(--color-border-default)] px-3 py-2">{column.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {periods.map((period) => (
              <tr key={period.key} className="border-b border-[var(--color-border-soft)] last:border-b-0">
                <td className="sticky left-0 z-10 border-r border-[var(--color-border-default)] bg-white px-3 py-2 text-left">
                  <div className="font-black text-[var(--color-brand-900)]">{period.label}</div>
                  <div className="font-mono text-[11px] text-[var(--color-text-tertiary)]">{period.accountingStandard}</div>
                </td>
                {columns.map((column) => <ValueCell key={column.label} value={column.value(period)} />)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** モバイル用: 横スクロールを避け、期間ごとのカードにする(新しい期間が上)。 */
function PeriodCards({
  periods,
  groups,
}: {
  periods: AnyPeriod[]
  groups: Array<{ label: string | null; items: PeriodColumn[] }>
}) {
  const [expanded, setExpanded] = useState(false)
  const ordered = [...periods].reverse()
  const visible = expanded ? ordered : ordered.slice(0, 6)
  return (
    <div className="md:hidden">
      <ul className="m-0 list-none divide-y divide-[var(--color-border-soft)] p-0" aria-label="期間別の値(カード表示)">
        {visible.map((period) => (
          <li key={period.key} className="px-4 py-2.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[13px] font-black text-[var(--color-brand-900)]">{period.label}</span>
              <span className="font-mono text-[11px] text-[var(--color-text-tertiary)]">{period.accountingStandard}</span>
            </div>
            {groups.map((group) => (
              <div key={group.label ?? 'all'} className="mt-1.5">
                {group.label && <div className="text-[11px] font-bold text-[var(--color-text-tertiary)]">{group.label}</div>}
                <dl className="m-0 grid grid-cols-2 gap-x-4 gap-y-1">
                  {group.items.map((item) => {
                    const value = item.value(period)
                    return (
                      <div key={item.label} className="min-w-0" title={value.reason ?? undefined}>
                        <dt className="text-[11px] font-medium text-[var(--color-text-tertiary)]">{item.label}</dt>
                        <dd className={`m-0 font-mono ${isUnavailable(value) ? 'text-[12px] font-semibold text-[var(--color-text-tertiary)]' : 'text-[14px] font-bold text-[var(--color-text-primary)]'}`}>{valueText(value)}</dd>
                      </div>
                    )
                  })}
                </dl>
              </div>
            ))}
          </li>
        ))}
      </ul>
      {ordered.length > 6 && (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          className="min-h-11 w-full border-t border-[var(--color-border-default)] text-[12px] font-bold text-[var(--color-brand-700)]"
        >
          {expanded ? '直近6期に戻す' : `全${ordered.length}期を表示`}
        </button>
      )}
    </div>
  )
}

function SingleSeriesChart({ data, label }: { data: Array<{ label: string; value?: number }>; label: string }) {
  return (
    <MeasuredChartFrame className="h-56 px-2 py-3 sm:h-64 sm:px-4">
      {({ width, height }) => (
        <BarChart width={width} height={height} data={data} margin={{ top: 6, right: 8, bottom: 0, left: 4 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border-soft)" />
          <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--color-text-tertiary)' }} interval="preserveStartEnd" />
          <YAxis tick={{ fontSize: 11, fill: 'var(--color-text-tertiary)' }} tickFormatter={(value) => compactNumberJa(Number(value))} width={48} />
          <Tooltip formatter={(value) => [compactNumberJa(Number(value)), label]} contentStyle={{ fontSize: 11, borderRadius: 0 }} />
          <ReferenceLine y={0} stroke="var(--color-border-strong)" />
          <Bar dataKey="value" name={label} fill="var(--color-brand-700)" radius={[2, 2, 0, 0]} maxBarSize={40} />
        </BarChart>
      )}
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
      {({ width, height }) => (
        <ComposedChart width={width} height={height} data={data} margin={{ top: 6, right: 8, bottom: 0, left: 4 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border-soft)" />
          <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--color-text-tertiary)' }} interval="preserveStartEnd" />
          <YAxis tick={{ fontSize: 11, fill: 'var(--color-text-tertiary)' }} tickFormatter={(value) => compactNumberJa(Number(value))} width={48} />
          <Tooltip formatter={(value, name) => [compactNumberJa(Number(value)), String(name)]} contentStyle={{ fontSize: 11, borderRadius: 0 }} />
          <ReferenceLine y={0} stroke="var(--color-border-strong)" />
          {view === 'three' ? (
            <>
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="operating" name="営業CF" fill="var(--color-brand-700)" maxBarSize={22} />
              <Bar dataKey="investing" name="投資CF" fill="var(--color-pattern-600)" maxBarSize={22} />
              <Bar dataKey="financing" name="財務CF" fill="var(--color-text-secondary)" maxBarSize={22} />
            </>
          ) : (
            <Line dataKey="simple" name="簡易FCF" stroke="var(--color-brand-700)" strokeWidth={2} strokeDasharray="5 3" dot={{ r: 3 }} connectNulls={false} />
          )}
        </ComposedChart>
      )}
    </MeasuredChartFrame>
  )
}

function ValueCell({ value }: { value: FinancialDetailValue }) {
  return (
    <td
      className={`px-3 py-2 font-mono ${isUnavailable(value) ? 'text-[11px] font-semibold text-[var(--color-text-tertiary)]' : 'font-bold text-[var(--color-text-primary)]'}`}
      title={value.reason ?? undefined}
    >
      {valueText(value)}
    </td>
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
    <details className="border-y border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)]">
      <summary className="flex min-h-11 cursor-pointer items-center px-4 text-[12px] font-bold text-[var(--color-brand-800)] sm:px-5">指標の定義・使用期間・データソース</summary>
      <div className="grid gap-3 border-t border-[var(--color-border-soft)] px-4 py-3 sm:px-5 md:grid-cols-2">
        {uniqueKeys.map((key) => {
          const definition = model.definitions[key]
          return (
            <div key={key} className="border-l-2 border-[var(--color-border-strong)] pl-2.5 text-[12px] leading-5 text-[var(--color-text-secondary)]">
              <div className="font-bold text-[var(--color-text-primary)]">{definition.displayName} <span className="font-mono text-[11px] font-semibold text-[var(--color-text-tertiary)]">{definition.version}</span></div>
              <div>{definition.formula}</div>
              <div className="text-[11px] text-[var(--color-text-tertiary)]">期間 {definition.periodBasis} / 出典 {definition.dataSource}</div>
            </div>
          )
        })}
        <p className="text-[11px] font-medium leading-5 text-[var(--color-text-tertiary)] md:col-span-2">{UNAVAILABLE_LEGEND}。</p>
      </div>
    </details>
  )
}

function EmptyState() {
  return (
    <div className="px-4 py-4 sm:px-5">
      <UnavailableNote>この期間種別で表示できるデータがありません。</UnavailableNote>
    </div>
  )
}
