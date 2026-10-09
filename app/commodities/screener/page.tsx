import type { Metadata } from 'next'
import Link from 'next/link'
import { RotateCcw, Search } from 'lucide-react'
import { PageTitle } from '@/components/layout/PageTitle'
import { StageDots } from '@/components/ui/StageDots'
import { CommodityNav } from '@/components/commodities/CommodityNav'
import {
  COMMODITY_PRODUCT_LABELS,
  commodityGroupLabel,
  type CommodityGroupId,
} from '@/lib/commodities'
import {
  COMMODITY_SCREENER_GROUP_OPTIONS,
  commodityGroupFromSearchParam,
  commodityLeverageFromSearchParam,
  commodityMarketFromSearchParam,
  commodityProductFromSearchParam,
  getCommodityScreener,
  type CommodityMetric,
} from '@/lib/queries/commodities'

export const metadata: Metadata = {
  title: 'コモディティスクリーナー — StockBoard',
  description: 'コモディティETF/ETNを分類、ステージ、騰落率、MA方向で絞り込み',
}

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

type PageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}

function paramValue(params: Record<string, string | string[] | undefined>, key: string): string | null {
  const value = params[key]
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

function fmtPrice(value: number | null | undefined, currency: 'JPY' | 'USD') {
  if (value == null || !Number.isFinite(value)) return '---'
  return value.toLocaleString(currency === 'USD' ? 'en-US' : 'ja-JP', {
    maximumFractionDigits: currency === 'USD' ? 2 : 1,
  })
}

function fmtPct(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '---'
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
}

function pctTone(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return 'text-[var(--color-text-secondary)]'
  if (value > 0) return 'text-[var(--color-price-up)]'
  if (value < 0) return 'text-[var(--color-price-down)]'
  return 'text-[var(--color-text-secondary)]'
}

function fmtScore(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '---'
  return value.toFixed(2)
}

function metricHref(metric: CommodityMetric) {
  return `/commodities/${metric.marketSlug}/${encodeURIComponent(metric.ticker)}`
}

function StageCode({ metric }: { metric: CommodityMetric }) {
  return (
    <StageDots
      values={[
        metric.stages.dailyA,
        metric.stages.dailyB,
        metric.stages.weeklyA,
        metric.stages.weeklyB,
        metric.stages.monthlyA,
        metric.stages.monthlyB,
      ]}
      size={18}
    />
  )
}

const FIELD = 'flex min-w-0 flex-col gap-1 text-[12px] font-semibold text-[var(--color-text-tertiary)]'
const SELECT = 'h-9 w-full min-w-0 px-2 text-[13px] font-semibold text-[var(--color-text-primary)]'
const TH_NUM = 'px-3 py-2 text-right font-semibold'

export default async function CommodityScreenerPage({ searchParams }: PageProps) {
  const params = await (searchParams ?? Promise.resolve({}))
  const market = commodityMarketFromSearchParam(paramValue(params, 'market'))
  const group = commodityGroupFromSearchParam(paramValue(params, 'group'))
  const productType = commodityProductFromSearchParam(paramValue(params, 'productType'))
  const leverage = commodityLeverageFromSearchParam(paramValue(params, 'leverage'))
  const stage = paramValue(params, 'stage') ?? 'all'
  const q = paramValue(params, 'q') ?? ''
  const sort = paramValue(params, 'sort') ?? 'return20'
  const dir = paramValue(params, 'dir') === 'asc' ? 'asc' : 'desc'
  const result = await getCommodityScreener({
    market,
    group,
    productType,
    leverage,
    stage,
    q,
    sort,
    dir,
    limit: 250,
  })

  return (
    <div className="flex w-full min-w-0 flex-col gap-5">
      <PageTitle
        eyebrow="コモディティ"
        title="コモディティスクリーナー"
        subtitle="分類、商品タイプ、通常/レバ別、ステージ、騰落率、MA方向で商品ETF/ETNを絞り込みます。"
        meta={<span>基準価格 {result.date ?? '---'}</span>}
      >
        <CommodityNav current="screener" />
      </PageTitle>

      <form className="panel" action="/commodities/screener" aria-label="絞り込み条件">
        <div className="grid grid-cols-2 gap-3 p-3 sm:p-4 md:grid-cols-4 xl:grid-cols-[repeat(7,minmax(0,1fr))_minmax(220px,1.4fr)]">
          <label className={FIELD}>
            市場
            <select name="market" defaultValue={result.params.market} className={SELECT}>
              <option value="ALL">全て</option>
              <option value="JP">国内上場</option>
              <option value="US">米国上場</option>
            </select>
          </label>
          <label className={FIELD}>
            分類
            <select name="group" defaultValue={result.params.group} className={SELECT}>
              <option value="all">全て</option>
              {COMMODITY_SCREENER_GROUP_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
            </select>
          </label>
          <label className={FIELD}>
            商品タイプ
            <select name="productType" defaultValue={result.params.productType} className={SELECT}>
              <option value="all">全て</option>
              {Object.entries(COMMODITY_PRODUCT_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <label className={FIELD}>
            枠
            <select name="leverage" defaultValue={result.params.leverage} className={SELECT}>
              <option value="core">通常のみ</option>
              <option value="leveraged">レバ/インバース</option>
              <option value="all">全て</option>
            </select>
          </label>
          <label className={FIELD}>
            ステージ
            <select name="stage" defaultValue={result.params.stage} className={SELECT}>
              <option value="all">全て</option>
              {[1, 2, 3, 4, 5, 6].map((stageValue) => (
                <option key={stageValue} value={stageValue}>Stage {stageValue}</option>
              ))}
            </select>
          </label>
          <label className={FIELD}>
            並び替え
            <select name="sort" defaultValue={result.params.sort} className={SELECT}>
              <option value="return20">20日騰落率</option>
              <option value="return60">60日騰落率</option>
              <option value="changePct">1日騰落率</option>
              <option value="ytd">YTD</option>
              <option value="price">価格</option>
              <option value="pms">PMS</option>
              <option value="pfs">PFS</option>
              <option value="pes">PES</option>
              <option value="stageCode">6桁ステージ</option>
              <option value="ticker">コード</option>
            </select>
          </label>
          <label className={FIELD}>
            順序
            <select name="dir" defaultValue={result.params.dir} className={SELECT}>
              <option value="desc">降順</option>
              <option value="asc">昇順</option>
            </select>
          </label>
          <label className={`${FIELD} col-span-2 md:col-span-4 xl:col-span-1`}>
            検索
            <span className="flex gap-2">
              <input
                name="q"
                defaultValue={result.params.q}
                placeholder="1540 / GLD / 金"
                className="h-9 min-w-0 flex-1 px-2 text-[13px]"
              />
              <button type="submit" className="btn h-9" data-variant="primary">
                <Search size={14} aria-hidden />
                絞り込む
              </button>
            </span>
          </label>
        </div>
      </form>

      <section className="panel" aria-labelledby="commodity-results-title">
        <div className="panel-head">
          <div className="min-w-0">
            <h2 id="commodity-results-title">
              結果 <span className="font-mono tabular-nums">{result.count.toLocaleString('ja-JP')}</span>件
            </h2>
            <p>最大250件 ・ 6ステージは 日A 日B 週A 週B 月A 月B の順</p>
          </div>
          <Link href="/commodities/screener" prefetch={false} className="btn" data-size="sm" data-variant="ghost">
            <RotateCcw size={13} aria-hidden /> 条件をリセット
          </Link>
        </div>
        <div className="table-scroll">
          <table className="w-full min-w-[1180px] border-collapse text-left text-[12px]">
            <thead>
              <tr className="border-b border-[var(--color-border-default)] text-[11px] text-[var(--color-text-tertiary)]">
                <th className="sticky left-0 z-[2] min-w-[240px] bg-white px-4 py-2 font-semibold">銘柄</th>
                <th className="px-3 py-2 font-semibold">分類</th>
                <th className="px-3 py-2 font-semibold">タイプ</th>
                <th className="px-3 py-2 font-semibold">6ステージ</th>
                <th className="px-3 py-2 font-semibold">MA状態</th>
                <th className={TH_NUM}>価格</th>
                <th className={TH_NUM}>1日</th>
                <th className={TH_NUM}>5日</th>
                <th className={TH_NUM}>20日</th>
                <th className={TH_NUM}>60日</th>
                <th className={TH_NUM}>YTD</th>
                <th className={TH_NUM}>PMS</th>
                <th className="px-4 py-2 font-semibold">ML</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border-soft)]">
              {result.rows.map((metric) => (
                <tr key={`${metric.market}-${metric.ticker}`} className="group hover:bg-[var(--color-surface-subtle)]">
                  <td className="sticky left-0 z-[1] bg-white px-4 py-2 group-hover:bg-[var(--color-surface-subtle)]">
                    <Link href={metricHref(metric)} prefetch={false} className="flex min-w-0 items-baseline gap-2 hover:underline">
                      <span className="shrink-0 font-mono font-bold text-[var(--color-brand-800)]">{metric.market}:{metric.ticker}</span>
                      <span className="truncate font-semibold text-[var(--color-text-primary)]">{metric.shortName}</span>
                    </Link>
                    <div className="mt-0.5 font-mono text-[11px] tabular-nums text-[var(--color-text-tertiary)]">{metric.priceDate ?? '価格日なし'}</div>
                  </td>
                  <td className="px-3 py-2 text-[var(--color-text-secondary)]">
                    <span className="font-semibold">{commodityGroupLabel(metric.group as CommodityGroupId)}</span>
                    <div className="mt-0.5 text-[11px] text-[var(--color-text-tertiary)]">{metric.commodity}</div>
                  </td>
                  <td className="px-3 py-2 text-[var(--color-text-secondary)]">{COMMODITY_PRODUCT_LABELS[metric.productType]}</td>
                  <td className="px-3 py-2"><StageCode metric={metric} /></td>
                  <td className="px-3 py-2 font-semibold text-[var(--color-text-primary)]">{metric.maTrendLabel}</td>
                  <td className="px-3 py-2 text-right font-mono font-semibold tabular-nums">{fmtPrice(metric.price, metric.currency)}</td>
                  <td className={`px-3 py-2 text-right font-mono font-semibold tabular-nums ${pctTone(metric.returns.day1)}`}>{fmtPct(metric.returns.day1)}</td>
                  <td className={`px-3 py-2 text-right font-mono tabular-nums ${pctTone(metric.returns.day5)}`}>{fmtPct(metric.returns.day5)}</td>
                  <td className={`px-3 py-2 text-right font-mono font-semibold tabular-nums ${pctTone(metric.returns.day20)}`}>{fmtPct(metric.returns.day20)}</td>
                  <td className={`px-3 py-2 text-right font-mono tabular-nums ${pctTone(metric.returns.day60)}`}>{fmtPct(metric.returns.day60)}</td>
                  <td className={`px-3 py-2 text-right font-mono tabular-nums ${pctTone(metric.returns.ytd)}`}>{fmtPct(metric.returns.ytd)}</td>
                  <td className={`px-3 py-2 text-right font-mono tabular-nums ${pctTone(metric.physicalMomentum.pms)}`}>{fmtScore(metric.physicalMomentum.pms)}</td>
                  <td className="px-4 py-2 text-[12px] text-[var(--color-text-secondary)]">{metric.ml.label}</td>
                </tr>
              ))}
              {result.rows.length === 0 && (
                <tr>
                  <td colSpan={13} className="px-4 py-12 text-center text-[13px] text-[var(--color-text-secondary)]">
                    条件に合うコモディティETF/ETNがありません。分類や枠を「全て」に広げてください。
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
