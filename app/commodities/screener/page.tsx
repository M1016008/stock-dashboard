import type { Metadata } from 'next'
import Link from 'next/link'
import { Search } from 'lucide-react'
import { PageTitle } from '@/components/layout/PageTitle'
import { StageDots } from '@/components/ui/StageDots'
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
    <div className="sb-page">
      <PageTitle
        title="コモディティスクリーナー"
        subtitle="分類、商品タイプ、通常/レバ別、ステージ、騰落率、MA方向で商品ETF/ETNを絞り込みます。"
        badge={`基準価格 ${result.date ?? '---'} / ${result.count}件`}
        rightSlot={
          <Link
            href="/commodities"
            className="inline-flex h-7 items-center rounded-[3px] border border-[var(--color-border-default)] bg-white px-2 text-[11px] font-bold text-[var(--color-brand-800)]"
          >
            一覧へ
          </Link>
        }
      />

      <form className="rounded-[8px] border border-[var(--color-border-default)] bg-white p-3 shadow-[var(--shadow-card)]" action="/commodities/screener">
        <div className="grid grid-cols-1 gap-2 md:grid-cols-3 xl:grid-cols-8">
          <label className="flex flex-col gap-1 text-[11px] font-bold text-[var(--color-text-tertiary)]">
            市場
            <select name="market" defaultValue={result.params.market} className="h-9 rounded-[4px] border border-[var(--color-border-default)] bg-white px-2 text-[12px] font-bold text-[var(--color-text-primary)]">
              <option value="ALL">全て</option>
              <option value="JP">国内上場</option>
              <option value="US">米国上場</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[11px] font-bold text-[var(--color-text-tertiary)]">
            分類
            <select name="group" defaultValue={result.params.group} className="h-9 rounded-[4px] border border-[var(--color-border-default)] bg-white px-2 text-[12px] font-bold text-[var(--color-text-primary)]">
              <option value="all">全て</option>
              {COMMODITY_SCREENER_GROUP_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[11px] font-bold text-[var(--color-text-tertiary)]">
            商品タイプ
            <select name="productType" defaultValue={result.params.productType} className="h-9 rounded-[4px] border border-[var(--color-border-default)] bg-white px-2 text-[12px] font-bold text-[var(--color-text-primary)]">
              <option value="all">全て</option>
              {Object.entries(COMMODITY_PRODUCT_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[11px] font-bold text-[var(--color-text-tertiary)]">
            枠
            <select name="leverage" defaultValue={result.params.leverage} className="h-9 rounded-[4px] border border-[var(--color-border-default)] bg-white px-2 text-[12px] font-bold text-[var(--color-text-primary)]">
              <option value="core">通常のみ</option>
              <option value="leveraged">レバ/インバース</option>
              <option value="all">全て</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[11px] font-bold text-[var(--color-text-tertiary)]">
            ステージ
            <select name="stage" defaultValue={result.params.stage} className="h-9 rounded-[4px] border border-[var(--color-border-default)] bg-white px-2 text-[12px] font-bold text-[var(--color-text-primary)]">
              <option value="all">全て</option>
              {[1, 2, 3, 4, 5, 6].map((stageValue) => (
                <option key={stageValue} value={stageValue}>Stage {stageValue}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[11px] font-bold text-[var(--color-text-tertiary)]">
            並び替え
            <select name="sort" defaultValue={result.params.sort} className="h-9 rounded-[4px] border border-[var(--color-border-default)] bg-white px-2 text-[12px] font-bold text-[var(--color-text-primary)]">
              <option value="return20">20日騰落率</option>
              <option value="return60">60日騰落率</option>
              <option value="changePct">1日騰落率</option>
              <option value="ytd">YTD</option>
              <option value="price">価格</option>
              <option value="stageCode">6桁ステージ</option>
              <option value="ticker">コード</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[11px] font-bold text-[var(--color-text-tertiary)]">
            順序
            <select name="dir" defaultValue={result.params.dir} className="h-9 rounded-[4px] border border-[var(--color-border-default)] bg-white px-2 text-[12px] font-bold text-[var(--color-text-primary)]">
              <option value="desc">降順</option>
              <option value="asc">昇順</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[11px] font-bold text-[var(--color-text-tertiary)] md:col-span-3 xl:col-span-1">
            検索
            <div className="flex gap-2">
              <input
                name="q"
                defaultValue={result.params.q}
                placeholder="1540 / GLD / 金"
                className="h-9 min-w-0 flex-1 rounded-[4px] border border-[var(--color-border-default)] px-2 text-[12px] font-semibold"
              />
              <button type="submit" className="inline-flex h-9 w-10 items-center justify-center rounded-[4px] bg-[var(--color-brand-800)] text-white">
                <Search size={15} />
              </button>
            </div>
          </label>
        </div>
      </form>

      <div className="overflow-x-auto rounded-[8px] border border-[var(--color-border-default)] bg-white shadow-[var(--shadow-card)]">
        <table className="w-full min-w-[1180px] border-collapse text-left text-[12px]">
          <thead>
            <tr className="border-b border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] text-[11px] font-bold text-[var(--color-text-secondary)]">
              <th className="px-3 py-2">銘柄</th>
              <th className="px-3 py-2">分類</th>
              <th className="px-3 py-2">タイプ</th>
              <th className="px-3 py-2">6桁</th>
              <th className="px-3 py-2">MA状態</th>
              <th className="px-3 py-2 text-right">価格</th>
              <th className="px-3 py-2 text-right">1日</th>
              <th className="px-3 py-2 text-right">5日</th>
              <th className="px-3 py-2 text-right">20日</th>
              <th className="px-3 py-2 text-right">60日</th>
              <th className="px-3 py-2 text-right">YTD</th>
              <th className="px-3 py-2">ML</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border-soft)]">
            {result.rows.map((metric) => (
              <tr key={`${metric.market}-${metric.ticker}`} className="hover:bg-[var(--color-surface-subtle)]">
                <td className="px-3 py-2">
                  <Link href={metricHref(metric)} className="font-bold text-[var(--color-brand-900)] hover:text-[var(--color-market-red)]">
                    <span className="font-mono">{metric.market}:{metric.ticker}</span>
                    <span className="ml-2">{metric.shortName}</span>
                  </Link>
                  <div className="mt-0.5 text-[10px] font-semibold text-[var(--color-text-tertiary)]">{metric.priceDate ?? '価格日なし'}</div>
                </td>
                <td className="px-3 py-2 font-bold text-[var(--color-text-secondary)]">
                  {commodityGroupLabel(metric.group as CommodityGroupId)}
                  <div className="mt-0.5 text-[10px] font-semibold text-[var(--color-text-tertiary)]">{metric.commodity}</div>
                </td>
                <td className="px-3 py-2 font-bold text-[var(--color-text-secondary)]">{COMMODITY_PRODUCT_LABELS[metric.productType]}</td>
                <td className="px-3 py-2"><StageCode metric={metric} /></td>
                <td className="px-3 py-2 font-bold text-[var(--color-brand-800)]">{metric.maTrendLabel}</td>
                <td className="px-3 py-2 text-right font-mono font-bold">{fmtPrice(metric.price, metric.currency)}</td>
                <td className={`px-3 py-2 text-right font-mono font-bold ${pctTone(metric.returns.day1)}`}>{fmtPct(metric.returns.day1)}</td>
                <td className={`px-3 py-2 text-right font-mono font-bold ${pctTone(metric.returns.day5)}`}>{fmtPct(metric.returns.day5)}</td>
                <td className={`px-3 py-2 text-right font-mono font-bold ${pctTone(metric.returns.day20)}`}>{fmtPct(metric.returns.day20)}</td>
                <td className={`px-3 py-2 text-right font-mono font-bold ${pctTone(metric.returns.day60)}`}>{fmtPct(metric.returns.day60)}</td>
                <td className={`px-3 py-2 text-right font-mono font-bold ${pctTone(metric.returns.ytd)}`}>{fmtPct(metric.returns.ytd)}</td>
                <td className="px-3 py-2 text-[11px] font-bold text-[var(--color-text-secondary)]">{metric.ml.label}</td>
              </tr>
            ))}
            {result.rows.length === 0 && (
              <tr>
                <td colSpan={12} className="px-3 py-10 text-center text-[12px] font-bold text-[var(--color-text-tertiary)]">
                  条件に合うコモディティETF/ETNがありません。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
