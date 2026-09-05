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
import type { StockSectorContext } from '@/lib/queries/stock-sector-context'
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
}

interface MetricDisplay {
  label: string
  value: FormattedFinancialSummaryValue
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
  const [data, setData] = useState<SummaryState>({ financial: null, physical: null, sector: null })
  const [loading, setLoading] = useState(true)
  const [financialError, setFinancialError] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    const universe = new URL(window.location.href).searchParams.get('universe')
    const urls = buildStockDecisionSummaryUrls(ticker, analysisDate, universe)
    setLoading(true)
    setFinancialError(false)
    setData({ financial: null, physical: null, sector: null })
    const hasSharedPhysicalMomentum = physicalMomentum !== undefined
    let pending = variant === 'overview' ? (hasSharedPhysicalMomentum ? 2 : 3) : 1
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
      getJson<{ context?: StockSectorContext | null }>(urls.sector, controller.signal)
        .then((response) => {
          if (!controller.signal.aborted) setData((current) => ({ ...current, sector: response.context ?? null }))
        })
        .catch(() => undefined)
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
  const sectorAsOf = data.sector?.date ?? '---'
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
    <div className="space-y-3">
      {variant === 'overview' && (
        <section className="overflow-hidden border border-[var(--color-border-default)] bg-white" aria-labelledby="market-structure-title">
          <header className="flex flex-wrap items-start justify-between gap-2 border-b border-[var(--color-border-default)] bg-[var(--color-brand-50)] px-4 py-2.5">
            <div>
              <h2 id="market-structure-title" className="flex items-center gap-1.5 text-[12px] font-black text-[var(--color-brand-900)]"><Radar size={15} />Market Structure</h2>
              <p className="mt-0.5 text-[8px] font-semibold text-[var(--color-text-tertiary)]">所属33業種の構造と、この銘柄の物理状態を分けて確認</p>
            </div>
            <div className="flex flex-wrap justify-end gap-x-3 gap-y-0.5 font-mono text-[8px] font-bold text-[var(--color-text-tertiary)]">
              <span>業種構造 {sectorAsOf}</span>
              <span>PMS/PFS {physicalAsOf}</span>
            </div>
          </header>
          <div className="grid bg-[var(--color-border-soft)] sm:grid-cols-2 lg:grid-cols-4 lg:gap-px">
            <MarketMetric label="33業種 構造スコア" value={data.sector?.trendStructureScore == null ? '—' : data.sector.trendStructureScore.toFixed(1)} detail={data.sector ? `${data.sector.groupName} / 6軸Stage構成` : '業種未取得'} />
            <MarketMetric label="33業種 構造順位" value={data.sector?.rank == null ? '—' : `${data.sector.rank} / ${data.sector.totalGroups}業種`} detail="構造スコアによる業種間順位" />
            <MarketMetric label="PMS" value={scoreLabel(latestPhysical?.physicalMomentumScore)} detail={physicalView.label} />
            <MarketMetric label="PFS" value={scoreLabel(latestPhysical?.physicalForceScore)} detail="足元の力・初動/失速" />
          </div>
          <div className="flex flex-col gap-2 border-t border-[var(--color-border-default)] px-4 py-2.5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-[9px] font-bold text-[var(--color-text-tertiary)]">
              <span>MA構造 <b className="text-[var(--color-text-primary)]">{maSummary}</b></span>
              <span>PMS市場順位 <b className="font-mono text-[var(--color-text-primary)]">{effectivePhysical?.rank == null ? '—' : `${effectivePhysical.rank} / ${effectivePhysical.totalRanked}銘柄`}</b></span>
              <span>33業種平均との差 <b className="font-mono text-[var(--color-text-primary)]">{data.sector?.marketDifference == null ? '—' : `${data.sector.marketDifference >= 0 ? '+' : ''}${data.sector.marketDifference.toFixed(1)}pt`}</b></span>
              <span>業種10日変化 <b className="font-mono text-[var(--color-text-primary)]">{data.sector?.momentum10d == null ? '—' : `${data.sector.momentum10d >= 0 ? '+' : ''}${data.sector.momentum10d.toFixed(1)}`}</b></span>
            </div>
            {sectorHref && <a href={sectorHref} className="inline-flex h-7 shrink-0 items-center justify-center gap-1 border border-[var(--color-border-default)] bg-white px-2.5 text-[9px] font-black text-[var(--color-brand-700)] hover:bg-[var(--color-surface-raised)]">業種構造を見る</a>}
          </div>
        </section>
      )}

      <section className="overflow-hidden border border-[var(--color-border-default)] bg-white" aria-labelledby={`fundamental-summary-title-${variant}`}>
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-4 py-2.5">
          <div>
            <h2 id={`fundamental-summary-title-${variant}`} className="text-[12px] font-black text-[var(--color-brand-900)]">Fundamental Summary</h2>
            <p className="mt-0.5 text-[8px] font-semibold text-[var(--color-text-tertiary)]">成長・収益性・評価・還元の主要指標</p>
          </div>
          <div className="flex items-center gap-3">
            <span className="font-mono text-[8px] font-bold text-[var(--color-text-tertiary)]">財務 {financialAsOf}</span>
            {variant === 'overview' && <a href="#fundamental" className="text-[9px] font-black text-[var(--color-brand-700)] hover:underline">詳しく見る</a>}
          </div>
        </header>
        {financialError && !loading && (
          <div className="border-b border-amber-200 bg-amber-50 px-3 py-2 text-[10px] font-bold text-amber-800">財務サマリーを取得できませんでした。</div>
        )}
        <div className="hidden grid-cols-4 lg:grid">
          {axes.map((axis) => <DesktopAxis key={axis.title} {...axis} />)}
        </div>
        <div className="divide-y divide-[var(--color-border-soft)] lg:hidden">
          {axes.map((axis) => <MobileAxis key={axis.title} {...axis} />)}
        </div>
        <footer className="border-t border-[var(--color-border-soft)] px-4 py-1 text-[8px] font-semibold text-[var(--color-text-tertiary)]">正規化済みJ-Quants財務 / missing・N/A・N/Mを区別</footer>
      </section>
    </div>
  )
}

function MarketMetric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="min-w-0 border-b border-[var(--color-border-soft)] bg-white px-4 py-2.5 sm:border-r lg:border-b-0">
      <div className="text-[8px] font-black text-[var(--color-text-tertiary)]">{label}</div>
      <div className="mt-0.5 truncate font-mono text-[17px] font-black text-[var(--color-text-primary)]" title={value}>{value}</div>
      <div className="mt-0.5 truncate text-[8px] font-semibold text-[var(--color-text-tertiary)]" title={detail}>{detail}</div>
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
    <article className="min-w-0 border-r border-[var(--color-border-default)] px-3 py-2.5 last:border-r-0">
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-black text-[var(--color-brand-900)]"><Icon size={14} />{title}</div>
      <div className="grid grid-cols-[minmax(86px,.82fr)_minmax(0,1.18fr)] items-stretch border-y border-[var(--color-border-soft)]">
        <div className="flex min-w-0 flex-col justify-center border-r border-[var(--color-border-soft)] px-2 py-1.5" title={representative.value.reason ?? undefined}>
          <div className="truncate text-[8px] font-bold text-[var(--color-text-tertiary)]">{representative.label}</div>
          <div className="mt-0.5 truncate font-mono text-[17px] font-black leading-5 text-[var(--color-text-primary)]">{representative.value.text}</div>
        </div>
        <div className="grid min-w-0 grid-rows-2 divide-y divide-[var(--color-border-soft)]">
          {supporting.map((item) => <SupportingMetric key={item.label} item={item} />)}
        </div>
      </div>
      <div className="mt-1.5 flex min-h-4 flex-wrap gap-x-3 gap-y-0.5">
        {context.map((item) => (
          <span key={item.label} className="text-[9px] font-semibold text-[var(--color-text-tertiary)]" title={item.value.reason ?? undefined}>
            {item.label} <b className="font-mono text-[10px] text-[var(--color-text-secondary)]">{item.value.text}</b>
          </span>
        ))}
      </div>
    </article>
  )
}

function SupportingMetric({ item }: { item: MetricDisplay }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-2 px-2 py-1" title={item.value.reason ?? undefined}>
      <span className="truncate text-[8px] font-bold text-[var(--color-text-tertiary)]">{item.label}</span>
      <strong className="shrink-0 font-mono text-[11px] font-black text-[var(--color-text-primary)]">{item.value.text}</strong>
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
      <summary className="grid min-h-10 cursor-pointer list-none grid-cols-[minmax(0,1fr)_auto_18px] items-center gap-2 px-3 py-1.5 [&::-webkit-details-marker]:hidden">
        <span className="flex min-w-0 items-center gap-2 text-[10px] font-black text-[var(--color-brand-900)]"><Icon size={13} />{title}</span>
        <span className="flex items-baseline gap-1.5">
          <small className="text-[8px] font-bold text-[var(--color-text-tertiary)]">{representative.label}</small>
          <strong className="font-mono text-[12px] font-black text-[var(--color-text-primary)]">{representative.value.text}</strong>
        </span>
        <ChevronDown size={14} className="text-[var(--color-text-tertiary)] transition-transform group-open:rotate-180" />
      </summary>
      <div className="border-t border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-3 py-2">
        <div className="grid grid-cols-2 border border-[var(--color-border-soft)] bg-white">
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
