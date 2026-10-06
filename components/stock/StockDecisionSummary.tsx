'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  BadgeCheck,
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
import { BoundedMeter, MetricLadder, RankStrip, ScoreRuler, type LadderRow } from '@/components/stock/StockAnalysisVisuals'
import { FundamentalSummaryBoard } from '@/components/stock/fundamentals/FundamentalSummaryBoard'
import type { FundamentalTabId } from '@/components/stock/fundamentals/format'

interface StockDecisionSummaryProps {
  ticker: string
  analysisDate: string | null
  quote: StockQuote | null
  variant?: 'overview' | 'fundamental'
  physicalMomentum?: StockDecisionPhysicalMomentum | null
  /** variant="fundamental" のときだけ使う。5軸サマリーから各サブタブへ移動する。 */
  onSelectFundamentalTab?: (tab: FundamentalTabId) => void
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
}

type ReadDirection = 'above' | 'below' | 'equal'

interface ReadLine {
  key: string
  direction: ReadDirection
  text: string
}

interface LadderGroup {
  id: string
  title: string
  role: string
  Icon: LucideIcon
  mode: 'signed' | 'value'
  ladderTitle: string
  rows: LadderRow[]
  secondary?: { title: string; mode: 'signed' | 'value'; rows: LadderRow[] }
  payout?: { value: number | null; text: string; note: string | null }
  reads: ReadLine[]
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

function ladderRow(
  key: string,
  label: string,
  point: FinancialOverviewValue | null | undefined,
  format: FinancialSummaryFormat,
  options: { forecast?: boolean; signed?: boolean; scale?: string; basis?: string } = {},
): LadderRow {
  const formatted = formatFinancialSummaryValue(point, format, { forecast: options.forecast, signed: options.signed })
  return {
    key,
    label,
    value: formatted.availability === 'available' ? point?.value ?? null : null,
    text: formatted.text,
    note: formatted.reason,
    scale: options.scale,
    basis: options.basis,
    forecast: options.forecast,
  }
}

function available(point: FinancialOverviewValue | null | undefined): number | null {
  return point?.availability === 'available' && point.value != null && Number.isFinite(point.value) ? point.value : null
}

// 同じ単位の2値だけを表示精度で丸めて比べる。表示上同じ値なら「同水準」。
function compare(a: number, b: number, precision: number): ReadDirection {
  const left = Math.round(a / precision)
  const right = Math.round(b / precision)
  if (left === right) return 'equal'
  return left > right ? 'above' : 'below'
}

function readLine(
  key: string,
  a: FinancialOverviewValue | null | undefined,
  b: FinancialOverviewValue | null | undefined,
  precision: number,
  text: (direction: ReadDirection) => string,
): ReadLine[] {
  const left = available(a)
  const right = available(b)
  if (left == null || right == null) return []
  const direction = compare(left, right, precision)
  return [{ key, direction, text: text(direction) }]
}

const DIRECTION_WORD: Record<ReadDirection, string> = { above: '上回る', below: '下回る', equal: '同水準' }

export function StockDecisionSummary({
  ticker,
  analysisDate,
  quote,
  variant = 'overview',
  physicalMomentum,
  onSelectFundamentalTab,
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

  const ladderGroups = useMemo<LadderGroup[]>(() => {
    const financial = data.financial
    const growth = financial?.performanceAndGrowth
    const currentFy = financial?.forecasts.currentFy
    const nextFy = financial?.forecasts.nextFy
    const returns = financial?.shareholderReturns
    const payout = formatFinancialSummaryValue(returns?.payoutRatio, 'percent')
    const growthReference = available(growth?.revenueCagr3y) != null ? growth?.revenueCagr3y : growth?.revenueCagr5y
    const growthReferenceLabel = available(growth?.revenueCagr3y) != null ? '3年CAGR' : '5年CAGR'
    return [
      {
        id: 'growth',
        title: '業績・成長',
        role: '長期成長率と直近の伸びを比較',
        Icon: TrendingUp,
        mode: 'signed',
        ladderTitle: '売上成長率 長期→直近(0中心・同じ%目盛り)',
        rows: [
          ladderRow('rev-5y', '売上 5年', growth?.revenueCagr5y, 'percent', { signed: true, basis: 'CAGR' }),
          ladderRow('rev-3y', '売上 3年', growth?.revenueCagr3y, 'percent', { signed: true, basis: 'CAGR' }),
          ladderRow('rev-ltm', '売上 1年', growth?.ltmRevenueGrowth, 'percent', { signed: true, basis: 'LTM' }),
          ladderRow('eps', 'EPS成長', growth?.epsGrowth, 'percent', { signed: true }),
        ],
        reads: [
          ...readLine('pace', growth?.ltmRevenueGrowth, growthReference, 0.1, (direction) =>
            direction === 'equal'
              ? `直近1年の売上成長は${growthReferenceLabel}と同水準`
              : `直近1年の売上成長は${growthReferenceLabel}を${DIRECTION_WORD[direction]}`),
          ...readLine('rev-forecast', currentFy?.revenue, growth?.ltmRevenue, 1e7, (direction) =>
            `今期会社予想の売上高はLTMを${DIRECTION_WORD[direction]}`),
        ],
        context: [
          metric('LTM売上高', growth?.ltmRevenue, 'currency'),
          metric('今期予想売上高', currentFy?.revenue, 'currency', true),
        ],
      },
      {
        id: 'quality',
        title: '収益性・効率',
        role: '売上・資本・資産に対する利益の水準',
        Icon: BadgeCheck,
        mode: 'signed',
        ladderTitle: '利益率・資本効率(0中心・同じ%目盛り)',
        rows: [
          ladderRow('margin', '営業利益率', growth?.operatingMargin, 'percent', { signed: true }),
          ladderRow('roe', 'ROE', financial?.quality.roe, 'percent', { signed: true }),
          ladderRow('roa', 'ROA', financial?.quality.roa, 'percent', { signed: true }),
          ladderRow('roic', 'ROIC', financial?.quality.roic, 'percent', { signed: true }),
        ],
        reads: readLine('op-forecast', currentFy?.operatingProfit, growth?.ltmOperatingProfit, 1e7, (direction) =>
          `今期会社予想の営業利益はLTMを${DIRECTION_WORD[direction]}`),
        context: [
          metric('LTM営業利益', growth?.ltmOperatingProfit, 'currency'),
          metric('簡易FCF', financial?.quality.simpleFcf, 'currency'),
        ],
      },
      {
        id: 'valuation',
        title: '株価の評価',
        role: '利益に対して株価がどの水準か',
        Icon: CircleDollarSign,
        mode: 'value',
        ladderTitle: 'PER 実績(LTM EPS)と予想(今期会社予想EPS)',
        rows: [
          ladderRow('per', 'PER', financial?.valuation.per, 'multiple', { scale: 'per', basis: '実績' }),
          ladderRow('fper', 'PER', financial?.valuation.forwardPer, 'multiple', { forecast: true, scale: 'per', basis: '予想' }),
        ],
        secondary: {
          title: 'EPS(円/株) PERの分母',
          mode: 'signed',
          rows: [
            ladderRow('eps-ltm', 'EPS', growth?.eps, 'per_share', { scale: 'eps', basis: 'LTM' }),
            ladderRow('eps-cur', 'EPS', currentFy?.eps, 'per_share', { forecast: true, scale: 'eps', basis: '今期予想' }),
            ladderRow('eps-next', 'EPS', nextFy?.eps, 'per_share', { forecast: true, scale: 'eps', basis: '来期予想' }),
          ],
        },
        reads: readLine('per', financial?.valuation.forwardPer, financial?.valuation.per, 0.1, (direction) =>
          direction === 'equal' ? '予想PERは実績PERと同水準' : `予想PERは実績PERを${DIRECTION_WORD[direction]}`),
        context: [
          metric('PBR', financial?.valuation.pbr, 'multiple'),
          metric('PSR', financial?.valuation.psr, 'multiple'),
        ],
      },
      {
        id: 'returns',
        title: '株主還元',
        role: '配当の推移と利益に対する割合',
        Icon: HandCoins,
        mode: 'value',
        ladderTitle: 'DPS(円/株) 実績→会社予想',
        rows: [
          ladderRow('dps-a', 'DPS', returns?.actualDps, 'per_share', { scale: 'dps', basis: '実績' }),
          ladderRow('dps-f', 'DPS', returns?.currentForecastDps, 'per_share', { forecast: true, scale: 'dps', basis: '今期予想' }),
          ladderRow('dps-n', 'DPS', nextFy?.dps, 'per_share', { forecast: true, scale: 'dps', basis: '来期予想' }),
        ],
        payout: {
          value: payout.availability === 'available' ? available(returns?.payoutRatio) : null,
          text: payout.text,
          note: payout.reason,
        },
        reads: readLine('dps', returns?.currentForecastDps, returns?.actualDps, 0.1, (direction) =>
          direction === 'equal' ? '今期予想DPSは実績と同額' : `今期予想DPSは実績を${DIRECTION_WORD[direction]}`),
        context: [
          metric('予想配当利回り', returns?.dividendYield, 'percent', true),
        ],
      },
    ]
  }, [data.financial])

  const effectivePhysical = physicalMomentum !== undefined ? physicalMomentum : data.physical
  const latestPhysical = effectivePhysical?.latest ?? null
  const physicalView = buildPhysicalMomentumView({
    pms: latestPhysical?.physicalMomentumScore,
    pfs: latestPhysical?.physicalForceScore,
    pes: latestPhysical?.physicalEnergyScore,
    trend: effectivePhysical?.trend ?? null,
  })
  const financialAsOf = data.financial?.asOf ?? analysisDate ?? quote?.priceDate ?? '---'
  const physicalAsOf = effectivePhysical?.scoreSource === 'runtime_raw'
    ? latestPhysical?.date ?? '---'
    : effectivePhysical?.latestScoredDate ?? latestPhysical?.date ?? '---'
  const sectorUnavailableDetail = data.sectorAvailability === 'loading'
    ? '読み込み中'
    : data.sectorAvailability === 'error'
      ? '取得できませんでした'
      : data.sectorReason ?? '業種構造は未算出です'
  const sectorAsOf = data.sector?.date ?? (data.sectorAvailability === 'loading' ? '読み込み中' : '---')
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

  // Fundamentals の「サマリー」サブタブ専用の5軸ボード。overview(既定)の描画は下の既存JSXのまま。
  if (variant === 'fundamental') {
    return (
      <FundamentalSummaryBoard
        ticker={ticker}
        analysisDate={analysisDate}
        financial={data.financial}
        loading={loading}
        failed={financialError}
        financialAsOf={financialAsOf}
        onSelectTab={onSelectFundamentalTab}
      />
    )
  }

  return (
    <div className="space-y-4 md:space-y-6">
      {variant === 'overview' && (
        <section className="overflow-hidden border border-[var(--color-border-default)] bg-white shadow-[0_1px_3px_rgba(16,32,52,0.05)]" aria-labelledby="market-structure-title" data-section="Market Structure">
          <header className="flex flex-wrap items-start justify-between gap-2 border-b border-[var(--color-border-soft)] px-3 py-3 sm:px-4 sm:py-3.5">
            <div>
              <h2 id="market-structure-title" className="flex items-center gap-2 text-[14px] font-bold text-[var(--color-text-primary)]"><Radar size={16} className="text-[var(--color-brand-700)]" />業種内の位置</h2>
              <p className="mt-0.5 text-[11px] font-medium text-[var(--color-text-tertiary)]">33業種の構造順位 ／ 銘柄の勢い(Zスコア)</p>
            </div>
            <div className="flex flex-wrap justify-end gap-x-3 gap-y-0.5 font-mono text-[11px] font-medium text-[var(--color-text-tertiary)]">
              <span>業種構造 {sectorAsOf}</span>
              <span>PMS/PFS {physicalAsOf}</span>
            </div>
          </header>
          <div className="grid gap-x-8 gap-y-4 px-3 py-3 sm:px-4 sm:py-3.5 lg:grid-cols-2">
            <div className="min-w-0 space-y-2" aria-label="33業種の構造">
              <div className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 truncate text-[11px] font-black text-[var(--color-text-secondary)]" title={data.sector?.groupName ?? sectorUnavailableDetail}>
                  33業種 {data.sector?.groupName ?? sectorUnavailableDetail}
                </span>
                <span className="shrink-0 text-[10px] font-semibold text-[var(--color-text-tertiary)]">
                  構造スコア <b className="font-mono text-[14px] font-black text-[var(--color-text-primary)]">{data.sector?.trendStructureScore == null ? '—' : data.sector.trendStructureScore.toFixed(1)}</b>
                </span>
              </div>
              <RankStrip
                label="業種"
                rank={data.sector?.rank}
                total={data.sector?.totalGroups}
                text={data.sector?.rank == null ? '—' : `${data.sector.rank} / ${data.sector.totalGroups}区分`}
              />
              <div className="text-[9px] font-medium text-[var(--color-text-tertiary)]">6軸Stage 70% + MA方向 30%の業種平均。順位はその他を含む全区分</div>
            </div>
            <div className="min-w-0 space-y-1.5" aria-label="この銘柄の勢い">
              <ScoreRuler code="PMS" label={physicalView.label} value={latestPhysical?.physicalMomentumScore} text={scoreLabel(latestPhysical?.physicalMomentumScore)} />
              <ScoreRuler code="PFS" label="足元の力" value={latestPhysical?.physicalForceScore} text={scoreLabel(latestPhysical?.physicalForceScore)} />
              <ScoreRuler code="PES" label="熱量" value={latestPhysical?.physicalEnergyScore} text={scoreLabel(latestPhysical?.physicalEnergyScore)} />
              <RankStrip
                label="PMS順"
                rank={effectivePhysical?.rank}
                total={effectivePhysical?.totalRanked}
                text={effectivePhysical?.rank == null ? '—' : `${effectivePhysical.rank} / ${effectivePhysical.totalRanked}銘柄`}
              />
            </div>
          </div>
          <div className="flex flex-col gap-1.5 border-t border-[var(--color-border-soft)] px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:px-4 sm:py-3">
            <div className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-1.5 text-[10px] font-medium text-[var(--color-text-tertiary)]">
              <span>PMS推移 <b className="text-[var(--color-text-primary)]">{effectivePhysical?.trend === 'rising' ? '上昇中' : effectivePhysical?.trend === 'falling' ? '低下中' : effectivePhysical?.trend === 'flat' ? '横ばい' : '—'}</b></span>
              <span>33業種平均との差 <b className="font-mono text-[var(--color-text-primary)]">{data.sector?.marketDifference == null ? '—' : `${data.sector.marketDifference >= 0 ? '+' : ''}${data.sector.marketDifference.toFixed(1)}pt`}</b></span>
              <span>業種10日変化 <b className="font-mono text-[var(--color-text-primary)]">{data.sector?.momentum10d == null ? '—' : `${data.sector.momentum10d >= 0 ? '+' : ''}${data.sector.momentum10d.toFixed(1)}`}</b></span>
            </div>
            {sectorHref && <a href={sectorHref} className="inline-flex min-h-11 shrink-0 items-center justify-center gap-1 px-1 text-[10px] font-bold text-[var(--color-brand-700)] hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-brand-700)] sm:min-h-7">業種構造を見る</a>}
          </div>
        </section>
      )}

      <section
        className="overflow-hidden border border-[var(--color-border-default)] bg-white shadow-[0_1px_3px_rgba(16,32,52,0.05)]"
        aria-labelledby={`fundamental-summary-title-${variant}`}
        data-section="Fundamental Summary"
      >
        <header className="flex flex-wrap items-end justify-between gap-2 border-b border-[var(--color-border-soft)] px-4 py-3.5 sm:px-5">
          <div>
            <h2 id={`fundamental-summary-title-${variant}`} className="text-[15px] font-bold text-[var(--color-text-primary)]">財務サマリー</h2>
            <p className="mt-1 text-[11px] font-medium text-[var(--color-text-tertiary)]">伸びの向き・利益の水準・株価の評価・還元の推移</p>
          </div>
          <div className="flex items-center gap-3">
            <span className="font-mono text-[11px] font-medium text-[var(--color-text-tertiary)]">財務 {financialAsOf}</span>
            {variant === 'overview' && <a href="#fundamental" className="text-[11px] font-bold text-[var(--color-brand-700)] hover:underline">ファンダメンタルで詳しく見る</a>}
          </div>
        </header>
        {financialError && !loading && (
          <div className="border-b border-amber-200 bg-amber-50 px-3 py-2 text-[10px] font-bold text-amber-800">財務サマリーを取得できませんでした。</div>
        )}
        <div className="grid gap-x-6 gap-y-5 px-4 py-4 sm:grid-cols-2 sm:px-5 xl:grid-cols-4">
          {ladderGroups.map((group) => (
            <section key={group.id} className="min-w-0" aria-labelledby={`fundamental-${variant}-${group.id}`}>
              <h3 id={`fundamental-${variant}-${group.id}`} className="flex items-center gap-1.5 text-[12px] font-black text-[var(--color-text-primary)]">
                <group.Icon size={14} className="text-[var(--color-brand-700)]" aria-hidden="true" />{group.title}
              </h3>
              <p className="mb-2 mt-0.5 text-[10px] font-semibold text-[var(--color-text-tertiary)]">{group.role}</p>
              <ul className="mb-2.5 min-h-[34px] space-y-0.5" aria-label={`${group.title}の比較`}>
                {group.reads.length === 0 ? (
                  <li className="text-[10px] font-semibold text-[var(--color-text-tertiary)]">{loading ? '読み込み中' : '比較できる値がありません'}</li>
                ) : group.reads.map((read) => (
                  <li key={read.key} className="grid grid-cols-[12px_minmax(0,1fr)] items-baseline gap-1 text-[11px] font-bold leading-4 text-[var(--color-text-primary)]">
                    <span
                      aria-hidden="true"
                      className="font-mono text-[10px] font-black"
                      style={{ color: read.direction === 'above' ? 'var(--price-up)' : read.direction === 'below' ? 'var(--price-down)' : 'var(--color-text-tertiary)' }}
                    >{read.direction === 'above' ? '▲' : read.direction === 'below' ? '▼' : '='}</span>
                    <span>{read.text}</span>
                  </li>
                ))}
              </ul>
              <MetricLadder title={group.ladderTitle} rows={group.rows} mode={group.mode} />
              {group.secondary && (
                <div className="mt-2.5">
                  <MetricLadder title={group.secondary.title} rows={group.secondary.rows} mode={group.secondary.mode} />
                </div>
              )}
              {group.payout && (
                <div className="mt-2.5" title={group.payout.note ?? undefined}>
                  <div className="mb-1.5 text-[11px] font-black text-[var(--color-text-secondary)]">配当性向(実績) 利益に対する配当の割合</div>
                  <div className="border-y border-[var(--color-border-soft)]">
                    <BoundedMeter label="配当性向" value={group.payout.value} text={group.payout.text} />
                  </div>
                </div>
              )}
              <div className="mt-1.5 flex min-h-4 flex-wrap gap-x-3 gap-y-0.5">
                {group.context.map((item) => (
                  <span key={item.label} className="text-[9px] font-medium text-[var(--color-text-tertiary)]" title={item.value.reason ?? undefined}>
                    {item.label} <b className="font-mono text-[10px] font-semibold text-[var(--color-text-secondary)]">{item.value.text}</b>
                  </span>
                ))}
              </div>
            </section>
          ))}
        </div>
        <footer className="border-t border-[var(--color-border-soft)] px-4 py-1.5 text-[11px] font-medium text-[var(--color-text-tertiary)]">出典:J-Quants財務　LTM=直近12か月　斜線=会社予想　▲▼=文中の前者が後者を上回る/下回る(同じ単位どうしのみ比較)　「—」はデータなし・対象外</footer>
      </section>
    </div>
  )
}

function scoreLabel(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}`
}
