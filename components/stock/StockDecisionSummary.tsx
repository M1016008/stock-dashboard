'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  BadgeCheck,
  ChevronDown,
  CircleDollarSign,
  HandCoins,
  Radar,
  TrendingUp,
  type LucideIcon,
} from 'lucide-react'
import { buildPhysicalMomentumView } from '@/lib/physical-momentum-view'
import {
  buildStockDecisionSummaryUrls,
  formatFinancialSummaryValue,
  summarizeMaStructure,
  type FinancialSummaryFormat,
  type FormattedFinancialSummaryValue,
} from '@/lib/stock-decision-summary'
import type {
  StockSectorContext,
  StockSectorContextResult,
} from '@/lib/queries/stock-sector-context'
import type {
  FinancialOverviewReadModel,
  FinancialOverviewValue,
} from '@/lib/server/financial-overview-read-model'
import type { StockQuote } from '@/types/stock'

interface StockDecisionSummaryProps {
  ticker: string
  analysisDate: string | null
  quote: StockQuote | null
  variant?: 'overview' | 'fundamental'
  physicalMomentum?: StockDecisionPhysicalMomentum | null
}

interface PhysicalMomentumRow {
  date: string
  ma5Angle: number | null
  ma25Angle: number | null
  ma75Angle: number | null
  ma200Angle: number | null
  physicalMomentumScore: number | null
  physicalForceScore: number | null
  physicalEnergyScore: number | null
}

export interface StockDecisionPhysicalMomentum {
  latest: PhysicalMomentumRow | null
  history: PhysicalMomentumRow[]
  trend: 'rising' | 'falling' | 'flat' | null
  rank: number | null
  totalRanked: number
  latestScoredDate?: string | null
  isScoreFresh?: boolean
  scoreSource?: 'stored' | 'runtime_raw' | null
}

interface SummaryState {
  financial: FinancialOverviewReadModel | null
  physical: StockDecisionPhysicalMomentum | null
  sector: StockSectorContext | null
  sectorAvailability: StockSectorContextResult['availability'] | 'idle' | 'loading' | 'error'
  sectorReason: string | null
}

interface MetricDisplay {
  label: string
  value: FormattedFinancialSummaryValue
  periodBasis?: string
}

interface AxisDisplay {
  title: string
  Icon: LucideIcon
  representative: MetricDisplay
  supporting: MetricDisplay[]
  context: MetricDisplay[]
}

async function getJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', signal })
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  return response.json() as Promise<T>
}

function metric(
  label: string,
  point: FinancialOverviewValue | null | undefined,
  format: FinancialSummaryFormat,
  forecast = false,
  signed = false,
): MetricDisplay {
  return { label, value: formatFinancialSummaryValue(point, format, { forecast, signed }) }
}

export function StockDecisionSummary({
  ticker,
  analysisDate,
  quote,
  variant = 'overview',
  physicalMomentum,
}: StockDecisionSummaryProps) {
  const [data, setData] = useState<SummaryState>({
    financial: null,
    physical: null,
    sector: null,
    sectorAvailability: variant === 'overview' ? 'loading' : 'idle',
    sectorReason: null,
  })
  const [loading, setLoading] = useState(true)
  const [financialError, setFinancialError] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    const universe = new URL(window.location.href).searchParams.get('universe')
    const urls = buildStockDecisionSummaryUrls(ticker, analysisDate, universe)
    setLoading(true)
    setFinancialError(false)
    setData({
      financial: null,
      physical: null,
      sector: null,
      sectorAvailability: variant === 'overview' ? 'loading' : 'idle',
      sectorReason: null,
    })
    const hasSharedPhysicalMomentum = physicalMomentum !== undefined
    let pending = 1 + (variant === 'overview' ? 1 : 0) + (variant === 'overview' && !hasSharedPhysicalMomentum ? 1 : 0)
    const done = () => {
      pending -= 1
      if (!controller.signal.aborted && pending === 0) setLoading(false)
    }
    getJson<FinancialOverviewReadModel>(urls.financial, controller.signal)
      .then((financial) => {
        if (!controller.signal.aborted) setData((current) => ({ ...current, financial }))
      })
      .catch(() => {
        if (!controller.signal.aborted) setFinancialError(true)
      })
      .finally(done)
    if (variant === 'overview' && !hasSharedPhysicalMomentum) {
      getJson<StockDecisionPhysicalMomentum>(urls.physical, controller.signal)
        .then((physical) => {
          if (!controller.signal.aborted) setData((current) => ({ ...current, physical }))
        })
        .catch(() => undefined)
        .finally(done)
    }
    if (variant === 'overview') {
      getJson<StockSectorContextResult>(urls.sector, controller.signal)
        .then((response) => {
          if (!controller.signal.aborted) {
            setData((current) => ({
              ...current,
              sector: response.context,
              sectorAvailability: response.availability,
              sectorReason: response.reason?.message ?? null,
            }))
          }
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setData((current) => ({
              ...current,
              sector: null,
              sectorAvailability: 'error',
              sectorReason: '業種構造APIを取得できませんでした',
            }))
          }
        })
        .finally(done)
    }
    return () => controller.abort()
  }, [analysisDate, physicalMomentum !== undefined, ticker, variant])

  const axes = useMemo(() => {
    const financial = data.financial
    return [
      {
        title: '業績・成長',
        Icon: TrendingUp,
        representative: metric('LTM売上成長率', financial?.performanceAndGrowth.ltmRevenueGrowth, 'percent', false, true),
        supporting: [
          metric('EPS成長率', financial?.performanceAndGrowth.epsGrowth, 'percent', false, true),
          metric('売上3年CAGR', financial?.performanceAndGrowth.revenueCagr3y, 'percent', false, true),
        ],
        context: [
          metric('LTM売上高', financial?.performanceAndGrowth.ltmRevenue, 'currency'),
          metric('LTM営業利益', financial?.performanceAndGrowth.ltmOperatingProfit, 'currency'),
        ],
      },
      {
        title: 'Quality',
        Icon: BadgeCheck,
        representative: metric('ROE', financial?.quality.roe, 'percent'),
        supporting: [
          metric('営業利益率', financial?.performanceAndGrowth.operatingMargin, 'percent'),
          metric('ROIC', financial?.quality.roic, 'percent'),
        ],
        context: [
          metric('ROA', financial?.quality.roa, 'percent'),
          metric('簡易FCF', financial?.quality.simpleFcf, 'currency'),
        ],
      },
      {
        title: 'Valuation',
        Icon: CircleDollarSign,
        representative: metric('Forward PER', financial?.valuation.forwardPer, 'multiple'),
        supporting: [
          metric('PER', financial?.valuation.per, 'multiple'),
          metric('PBR', financial?.valuation.pbr, 'multiple'),
        ],
        context: [metric('PSR', financial?.valuation.psr, 'multiple')],
      },
      {
        title: '株主還元',
        Icon: HandCoins,
        representative: metric('予想配当利回り', financial?.shareholderReturns.dividendYield, 'percent', true),
        supporting: [
          metric('予想DPS', financial?.shareholderReturns.currentForecastDps, 'per_share', true),
          metric('配当性向', financial?.shareholderReturns.payoutRatio, 'percent'),
        ],
        context: [metric('実績DPS', financial?.shareholderReturns.actualDps, 'per_share')],
      },
    ] satisfies AxisDisplay[]
  }, [data.financial])

  const effectivePhysical = physicalMomentum !== undefined ? physicalMomentum : data.physical
  const latestPhysical = effectivePhysical?.latest ?? null
  const physicalView = buildPhysicalMomentumView({
    pms: latestPhysical?.physicalMomentumScore,
    pfs: latestPhysical?.physicalForceScore,
    pes: latestPhysical?.physicalEnergyScore,
    trend: effectivePhysical?.trend ?? null,
  })
  const maSummary = summarizeMaStructure(latestPhysical)
  const financialAsOf = data.financial?.asOf ?? analysisDate ?? quote?.priceDate ?? '---'
  const physicalAsOf = effectivePhysical?.scoreSource === 'runtime_raw'
    ? latestPhysical?.date ?? '---'
    : effectivePhysical?.latestScoredDate ?? latestPhysical?.date ?? '---'
  const sectorUnavailableDetail = data.sectorAvailability === 'loading'
    ? '読込中'
    : data.sectorAvailability === 'error'
      ? 'API取得失敗'
      : data.sectorReason ?? '業種構造データ未計算'
  const sectorAsOf = data.sector?.date ?? (data.sectorAvailability === 'loading' ? '読込中' : '---')
  const sectorHref = data.sector ? (() => {
    const params = new URLSearchParams({
      view: 'structure',
      structureTaxonomy: data.sector.taxonomy,
      structureGroup: data.sector.groupKey,
    })
    if (data.sector.parentGroup) params.set('structureParent', data.sector.parentGroup)
    if (data.sector.universe) params.set('universe', data.sector.universe)
    if (analysisDate) params.set('date', data.sector.date)
    return `/sectors?${params.toString()}#sector-structure`
  })() : null

  return (
    <div className="space-y-4 md:space-y-6">
      {variant === 'overview' && (
        <section className="overflow-hidden border border-[var(--color-border-default)] bg-white shadow-[0_1px_3px_rgba(16,32,52,0.05)]" aria-labelledby="market-structure-title">
          <header className="flex flex-wrap items-start justify-between gap-2 border-b border-[var(--color-border-soft)] px-3 py-3 sm:px-4 sm:py-3.5">
            <div>
              <h2 id="market-structure-title" className="flex items-center gap-2 text-[14px] font-bold text-[var(--color-text-primary)]"><Radar size={16} className="text-[var(--color-brand-700)]" />Market Structure</h2>
              <p className="mt-0.5 text-[10px] font-medium text-[var(--color-text-tertiary)]">所属33業種の構造と、この銘柄の物理状態</p>
            </div>
            <div className="flex flex-wrap justify-end gap-x-3 gap-y-0.5 font-mono text-[9px] font-medium text-[var(--color-text-tertiary)]">
              <span>業種構造 {sectorAsOf}</span>
              <span>PMS/PFS {physicalAsOf}</span>
            </div>
          </header>
          <div className="grid grid-cols-2 gap-2 px-3 py-3 sm:px-4 sm:py-3.5 lg:grid-cols-[1.18fr_1.18fr_.82fr_.82fr]">
            <MarketMetric
              label="33業種 構造スコア"
              value={data.sector?.trendStructureScore == null ? '—' : data.sector.trendStructureScore.toFixed(1)}
              detail={data.sector ? `${data.sector.groupName} / 6軸Stage 70% + MA方向 30%` : sectorUnavailableDetail}
              emphasis="primary"
            />
            <MarketMetric
              label="33業種 構造順位"
              value={data.sector?.rank == null ? '—' : `${data.sector.rank} / ${data.sector.totalGroups}区分`}
              detail={data.sector ? '業種平均スコアの全区分順位（その他含む）' : sectorUnavailableDetail}
              emphasis="primary"
            />
            <MarketMetric label="PMS" value={scoreLabel(latestPhysical?.physicalMomentumScore)} detail={physicalView.label} />
            <MarketMetric label="PFS" value={scoreLabel(latestPhysical?.physicalForceScore)} detail="足元の力・初動/失速" />
          </div>
          <div className="flex flex-col gap-1.5 border-t border-[var(--color-border-soft)] px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:px-4 sm:py-3">
            <div className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-1.5 text-[10px] font-medium text-[var(--color-text-tertiary)]">
              <span>MA構造 <b className="text-[var(--color-text-primary)]">{maSummary}</b></span>
              <span>PMS市場順位 <b className="font-mono text-[var(--color-text-primary)]">{effectivePhysical?.rank == null ? '—' : `${effectivePhysical.rank} / ${effectivePhysical.totalRanked}銘柄`}</b></span>
              <span>33業種平均との差 <b className="font-mono text-[var(--color-text-primary)]">{data.sector?.marketDifference == null ? '—' : `${data.sector.marketDifference >= 0 ? '+' : ''}${data.sector.marketDifference.toFixed(1)}pt`}</b></span>
              <span>業種10日変化 <b className="font-mono text-[var(--color-text-primary)]">{data.sector?.momentum10d == null ? '—' : `${data.sector.momentum10d >= 0 ? '+' : ''}${data.sector.momentum10d.toFixed(1)}`}</b></span>
            </div>
            {sectorHref && <a href={sectorHref} className="inline-flex min-h-11 shrink-0 items-center justify-center gap-1 px-1 text-[10px] font-bold text-[var(--color-brand-700)] hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-brand-700)] sm:min-h-7">業種構造を見る</a>}
          </div>
        </section>
      )}

      <section
        className={variant === 'fundamental'
          ? 'overflow-hidden border-y border-[var(--color-border-soft)] bg-white'
          : 'overflow-hidden border border-[var(--color-border-default)] bg-white shadow-[0_1px_3px_rgba(16,32,52,0.05)]'}
        aria-labelledby={`fundamental-summary-title-${variant}`}
      >
        <header className="flex flex-wrap items-end justify-between gap-2 border-b border-[var(--color-border-soft)] px-4 py-3.5 sm:px-5">
          <div>
            <h2 id={`fundamental-summary-title-${variant}`} className="text-[15px] font-bold text-[var(--color-text-primary)]">Fundamental Summary</h2>
            <p className="mt-1 text-[11px] font-medium text-[var(--color-text-tertiary)]">業績、収益性、評価、株主還元を一枚で確認</p>
          </div>
          <div className="flex items-center gap-3">
            <span className="font-mono text-[9px] font-medium text-[var(--color-text-tertiary)]">財務 {financialAsOf}</span>
            {variant === 'overview' && <a href="#fundamental" className="text-[10px] font-bold text-[var(--color-brand-700)] hover:underline">詳しく見る</a>}
          </div>
        </header>
        {financialError && !loading && (
          <div className="border-b border-amber-200 bg-amber-50 px-3 py-2 text-[10px] font-bold text-amber-800">財務サマリーを取得できませんでした。</div>
        )}
        {variant === 'fundamental' ? (
          <FundamentalEditorialSummary financial={data.financial} />
        ) : (
          <>
            <div className="hidden grid-cols-4 gap-5 px-4 py-4 lg:grid">
              {axes.map((axis) => <DesktopAxis key={axis.title} {...axis} />)}
            </div>
            <div className="divide-y divide-[var(--color-border-soft)] lg:hidden">
              {axes.map((axis) => <MobileAxis key={axis.title} {...axis} />)}
            </div>
          </>
        )}
        <footer className="border-t border-[var(--color-border-soft)] px-4 py-1.5 text-[9px] font-medium text-[var(--color-text-tertiary)]">正規化済みJ-Quants財務 / missing・N/A・N/Mを区別</footer>
      </section>
    </div>
  )
}

function FundamentalEditorialSummary({ financial }: { financial: FinancialOverviewReadModel | null }) {
  const ltmBasis = 'LTM / 直近12か月'
  const primary = [
    { ...metric('売上高', financial?.performanceAndGrowth.ltmRevenue, 'currency'), periodBasis: ltmBasis },
    { ...metric('営業利益', financial?.performanceAndGrowth.ltmOperatingProfit, 'currency'), periodBasis: ltmBasis },
    { ...metric('EPS', financial?.performanceAndGrowth.eps, 'per_share'), periodBasis: ltmBasis },
    { ...metric('ROE', financial?.quality.roe, 'percent'), periodBasis: ltmBasis },
  ]
  const secondary = [
    metric('LTM売上成長率', financial?.performanceAndGrowth.ltmRevenueGrowth, 'percent', false, true),
    metric('営業利益率', financial?.performanceAndGrowth.operatingMargin, 'percent'),
    metric('Forward PER', financial?.valuation.forwardPer, 'multiple'),
    metric('PBR', financial?.valuation.pbr, 'multiple'),
    metric('予想配当利回り', financial?.shareholderReturns.dividendYield, 'percent', true),
  ]
  const supplemental = [
    metric('EPS成長率', financial?.performanceAndGrowth.epsGrowth, 'percent', false, true),
    metric('売上3年CAGR', financial?.performanceAndGrowth.revenueCagr3y, 'percent', false, true),
    metric('ROA', financial?.quality.roa, 'percent'),
    metric('ROIC', financial?.quality.roic, 'percent'),
    metric('簡易FCF', financial?.quality.simpleFcf, 'currency'),
    metric('PER', financial?.valuation.per, 'multiple'),
    metric('PSR', financial?.valuation.psr, 'multiple'),
    metric('予想DPS', financial?.shareholderReturns.currentForecastDps, 'per_share', true),
    metric('配当性向', financial?.shareholderReturns.payoutRatio, 'percent'),
    metric('実績DPS', financial?.shareholderReturns.actualDps, 'per_share'),
  ]

  return (
    <div>
      <div className="grid border-b border-[var(--color-border-soft)] lg:grid-cols-[minmax(0,1.4fr)_minmax(320px,1fr)]">
        <section className="px-4 py-4 sm:px-5 sm:py-5 lg:border-r lg:border-[var(--color-border-soft)]" aria-labelledby="fundamental-growth-title">
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <h3 id="fundamental-growth-title" className="text-[12px] font-bold text-[var(--color-text-secondary)]">業績・成長</h3>
            <span className="text-[9px] font-medium text-[var(--color-text-tertiary)]">規模と伸びを確認</span>
          </div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-4">
            {primary.slice(0, 2).map((item, index) => (
              <div key={item.label} className="min-w-0" title={item.value.reason ?? undefined}>
                <div className="text-[10px] font-semibold text-[var(--color-text-tertiary)]">{item.label}</div>
                <div className={`mt-1 truncate font-mono font-semibold leading-none text-[var(--color-text-primary)] ${index === 0 ? 'text-[24px] sm:text-[26px]' : 'text-[20px] sm:text-[22px]'}`}>{item.value.text}</div>
                <div className="mt-2 text-[9px] font-medium text-[var(--color-text-tertiary)]">{item.value.reason ?? item.periodBasis ?? '直近利用可能値'}</div>
              </div>
            ))}
          </div>
          <div className="mt-4 grid grid-cols-2 gap-x-6 border-t border-[var(--color-border-soft)] pt-3">
            {secondary.slice(0, 2).map((item) => <SupportingMetric key={item.label} item={item} />)}
          </div>
        </section>

        <section className="border-t border-[var(--color-border-soft)] px-4 py-4 sm:px-5 sm:py-5 lg:border-t-0" aria-labelledby="fundamental-value-title">
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <h3 id="fundamental-value-title" className="text-[12px] font-bold text-[var(--color-text-secondary)]">評価・資本効率</h3>
            <span className="text-[9px] font-medium text-[var(--color-text-tertiary)]">利益・評価・還元</span>
          </div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-4">
            {primary.slice(2).map((item, index) => (
              <div key={item.label} className="min-w-0" title={item.value.reason ?? undefined}>
                <div className="text-[10px] font-semibold text-[var(--color-text-tertiary)]">{item.label}</div>
                <div className={`mt-1 truncate font-mono font-semibold leading-none text-[var(--color-text-primary)] ${index === 0 ? 'text-[22px] sm:text-[24px]' : 'text-[20px] sm:text-[22px]'}`}>{item.value.text}</div>
                <div className="mt-2 text-[9px] font-medium text-[var(--color-text-tertiary)]">{item.value.reason ?? item.periodBasis ?? '直近利用可能値'}</div>
              </div>
            ))}
          </div>
          <div className="mt-4 space-y-0.5 border-t border-[var(--color-border-soft)] pt-2">
            {secondary.slice(2).map((item) => <SupportingMetric key={item.label} item={item} />)}
          </div>
        </section>
      </div>
      <div className="hidden border-t border-[var(--color-border-soft)] px-5 py-3 lg:block">
        <div className="grid grid-cols-5 gap-x-6 gap-y-2">
          {supplemental.map((item) => <SupportingMetric key={item.label} item={item} />)}
        </div>
      </div>
      <details className="border-t border-[var(--color-border-soft)] lg:hidden">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between px-4 text-[11px] font-bold text-[var(--color-text-secondary)] [&::-webkit-details-marker]:hidden">
          補足指標
          <ChevronDown size={14} className="text-[var(--color-text-tertiary)]" />
        </summary>
        <div className="grid grid-cols-2 gap-x-5 gap-y-1 border-t border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-4 py-3">
          {supplemental.map((item) => <SupportingMetric key={item.label} item={item} />)}
        </div>
      </details>
    </div>
  )
}

function MarketMetric({
  label,
  value,
  detail,
  emphasis = 'secondary',
}: {
  label: string
  value: string
  detail: string
  emphasis?: 'primary' | 'secondary'
}) {
  return (
    <div className={`min-w-0 rounded-[6px] bg-[var(--color-surface-subtle)] px-2.5 py-2.5 ${emphasis === 'primary' ? 'sm:px-4 sm:py-3' : ''}`}>
      <div className="text-[10px] font-semibold text-[var(--color-text-tertiary)]">{label}</div>
      <div className={`mt-1 break-words font-mono font-black text-[var(--color-text-primary)] ${emphasis === 'primary' ? 'text-[18px] sm:text-[20px]' : 'text-[16px] sm:text-[17px]'}`} title={value}>{value}</div>
      <div className="mt-1 break-words text-[9px] font-medium leading-[1.35] text-[var(--color-text-tertiary)]" title={detail}>{detail}</div>
    </div>
  )
}

function DesktopAxis({
  title,
  Icon,
  representative,
  supporting,
  context,
}: AxisDisplay) {
  return (
    <article className="min-w-0">
      <div className="mb-2 flex items-center gap-1.5 text-[12px] font-bold text-[var(--color-text-secondary)]"><Icon size={14} className="text-[var(--color-brand-700)]" />{title}</div>
      <div className="grid grid-cols-[minmax(88px,.82fr)_minmax(0,1.18fr)] items-stretch gap-3">
        <div className="flex min-w-0 flex-col justify-center rounded-[6px] bg-[var(--color-surface-subtle)] px-2.5 py-2" title={representative.value.reason ?? undefined}>
          <div className="truncate text-[9px] font-medium text-[var(--color-text-tertiary)]">{representative.label}</div>
          <div className="mt-0.5 truncate font-mono text-[18px] font-black leading-5 text-[var(--color-text-primary)]">{representative.value.text}</div>
        </div>
        <div className="grid min-w-0 grid-rows-2 gap-1">
          {supporting.map((item) => <SupportingMetric key={item.label} item={item} />)}
        </div>
      </div>
      <div className="mt-2 flex min-h-4 flex-wrap gap-x-3 gap-y-1">
        {context.map((item) => (
          <span key={item.label} className="text-[9px] font-medium text-[var(--color-text-tertiary)]" title={item.value.reason ?? undefined}>
            {item.label} <b className="font-mono text-[10px] font-semibold text-[var(--color-text-secondary)]">{item.value.text}</b>
          </span>
        ))}
      </div>
    </article>
  )
}

function SupportingMetric({ item }: { item: MetricDisplay }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-2 py-1" title={item.value.reason ?? undefined}>
      <span className="truncate text-[9px] font-medium text-[var(--color-text-tertiary)]">{item.label}</span>
      <strong className="shrink-0 font-mono text-[11px] font-bold text-[var(--color-text-primary)]">{item.value.text}</strong>
    </div>
  )
}

function MobileAxis({
  title,
  Icon,
  representative,
  supporting,
  context,
}: AxisDisplay) {
  return (
    <details className="group bg-white">
      <summary className="grid min-h-11 cursor-pointer list-none grid-cols-[minmax(0,1fr)_auto_18px] items-center gap-2 px-4 py-2 [&::-webkit-details-marker]:hidden">
        <span className="flex min-w-0 items-center gap-2 text-[11px] font-bold text-[var(--color-text-secondary)]"><Icon size={13} className="text-[var(--color-brand-700)]" />{title}</span>
        <span className="flex items-baseline gap-1.5">
          <small className="text-[9px] font-medium text-[var(--color-text-tertiary)]">{representative.label}</small>
          <strong className="font-mono text-[13px] font-black text-[var(--color-text-primary)]">{representative.value.text}</strong>
        </span>
        <ChevronDown size={14} className="text-[var(--color-text-tertiary)] transition-transform group-open:rotate-180" />
      </summary>
      <div className="border-t border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-4 py-2.5">
        <div className="grid grid-cols-2 gap-x-4">
          {supporting.map((item) => <SupportingMetric key={item.label} item={item} />)}
        </div>
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
          {context.map((item) => (
            <span key={item.label} className="text-[9px] font-semibold text-[var(--color-text-tertiary)]" title={item.value.reason ?? undefined}>
              {item.label} <b className="font-mono text-[10px] text-[var(--color-text-secondary)]">{item.value.text}</b>
            </span>
          ))}
        </div>
      </div>
    </details>
  )
}

function scoreLabel(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}`
}
