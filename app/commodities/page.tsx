import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowRight, ExternalLink, Filter, ShieldAlert } from 'lucide-react'
import { PageTitle } from '@/components/layout/PageTitle'
import { CardHeader } from '@/components/ui/Card'
import { StageDots } from '@/components/ui/StageDots'
import { COMMODITY_PRODUCT_LABELS, COMMODITY_REFERENCE_LINKS, commodityGroupLabel } from '@/lib/commodities'
import { getCommodityBoard, type CommodityMetric } from '@/lib/queries/commodities'

export const metadata: Metadata = {
  title: 'コモディティ分析 — StockBoard',
  description: '国内上場ETF/ETNと米国上場ETFで主要コモディティのトレンドを確認',
}

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

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

function SummaryTile({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-[8px] border border-[var(--color-border-default)] bg-white px-4 py-3 shadow-[var(--shadow-card)]">
      <div className="text-[11px] font-bold text-[var(--color-text-tertiary)]">{label}</div>
      <div className="mt-1 font-mono text-[22px] font-bold text-[var(--color-brand-900)]">{value}</div>
      <div className="mt-1 text-[10px] font-semibold text-[var(--color-text-tertiary)]">{hint}</div>
    </div>
  )
}

function CommodityCard({ metric }: { metric: CommodityMetric }) {
  const href = `/commodities/${metric.marketSlug}/${encodeURIComponent(metric.ticker)}`
  return (
    <Link
      href={href}
      className="group block min-h-[202px] rounded-[8px] border border-[var(--color-border-default)] bg-white p-3 shadow-[var(--shadow-card)] transition hover:border-[var(--color-brand-600)] hover:shadow-md"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="inline-flex h-6 items-center rounded-[3px] bg-[var(--color-brand-700)] px-2 font-mono text-[12px] font-bold text-white">
              {metric.market}:{metric.ticker}
            </span>
            <span className="inline-flex h-6 items-center rounded-[3px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-2 text-[10px] font-bold text-[var(--color-brand-800)]">
              {commodityGroupLabel(metric.group)}
            </span>
            <span className="inline-flex h-6 items-center rounded-[3px] border border-[var(--color-border-soft)] bg-white px-2 text-[10px] font-bold text-[var(--color-text-secondary)]">
              {COMMODITY_PRODUCT_LABELS[metric.productType]}
            </span>
          </div>
          <h3 className="mt-2 line-clamp-2 text-[14px] font-bold leading-snug text-[var(--color-brand-900)] group-hover:text-[var(--color-market-red)]">
            {metric.shortName}
          </h3>
          <p className="mt-1 line-clamp-2 text-[11px] font-semibold leading-relaxed text-[var(--color-text-tertiary)]">
            {metric.description}
          </p>
        </div>
        <ArrowRight size={15} className="mt-1 shrink-0 text-[var(--color-text-tertiary)] transition group-hover:translate-x-0.5 group-hover:text-[var(--color-market-red)]" />
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2 text-[11px]">
        <div className="rounded-[6px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-2 py-1.5">
          <div className="font-bold text-[var(--color-text-tertiary)]">価格</div>
          <div className="mt-1 font-mono text-[14px] font-bold text-[var(--color-text-primary)]">
            {fmtPrice(metric.price, metric.currency)}
          </div>
        </div>
        <div className="rounded-[6px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-2 py-1.5">
          <div className="font-bold text-[var(--color-text-tertiary)]">1日</div>
          <div className={`mt-1 font-mono text-[14px] font-bold ${pctTone(metric.returns.day1)}`}>
            {fmtPct(metric.returns.day1)}
          </div>
        </div>
        <div className="rounded-[6px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-2 py-1.5">
          <div className="font-bold text-[var(--color-text-tertiary)]">20日</div>
          <div className={`mt-1 font-mono text-[14px] font-bold ${pctTone(metric.returns.day20)}`}>
            {fmtPct(metric.returns.day20)}
          </div>
        </div>
        <div className="rounded-[6px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-2 py-1.5">
          <div className="font-bold text-[var(--color-text-tertiary)]">PMS</div>
          <div className={`mt-1 font-mono text-[14px] font-bold ${pctTone(metric.physicalMomentum.pms)}`}>
            {fmtScore(metric.physicalMomentum.pms)}
          </div>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between gap-2">
        <div>
          <div className="mb-1 text-[10px] font-bold text-[var(--color-text-tertiary)]">6ステージ</div>
          <StageDots
            values={[
              metric.stages.dailyA,
              metric.stages.dailyB,
              metric.stages.weeklyA,
              metric.stages.weeklyB,
              metric.stages.monthlyA,
              metric.stages.monthlyB,
            ]}
            size={19}
          />
        </div>
        <span className="rounded-full border border-[var(--color-border-soft)] bg-white px-2 py-1 text-[10px] font-bold text-[var(--color-brand-800)]">
          {metric.maTrendLabel}
        </span>
      </div>

      <div className="mt-3 flex items-center justify-between gap-2 border-t border-[var(--color-border-soft)] pt-2 text-[10px] font-bold text-[var(--color-text-tertiary)]">
        <span>価格 {metric.priceDate ?? '---'}</span>
        <span className={metric.ml.available ? 'text-[var(--color-brand-800)]' : 'text-[var(--color-text-tertiary)]'}>
          {metric.market === 'JP' ? metric.ml.label : 'US ML未生成'}
        </span>
      </div>
    </Link>
  )
}

export default async function CommoditiesPage() {
  const board = await getCommodityBoard()

  return (
    <div className="sb-page">
      <PageTitle
        title="コモディティ分析"
        subtitle="国内上場ETF/ETNと米国上場ETFで、金・原油・銅・農産物などの商品トレンドを6ステージ/MA/物理特徴量で確認します。"
        badge={`価格 ${board.latestPriceDate ?? '---'} / ステージ ${board.latestStageDate ?? '---'}`}
        rightSlot={
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href="/commodities/screener"
              className="inline-flex h-7 items-center gap-1 rounded-[3px] border border-[var(--color-border-default)] bg-white px-2 text-[11px] font-bold text-[var(--color-brand-800)]"
            >
              <Filter size={12} /> スクリーナー
            </Link>
            <Link
              href={COMMODITY_REFERENCE_LINKS.jpxEtf}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-7 items-center gap-1 rounded-[3px] border border-[var(--color-border-default)] bg-white px-2 text-[11px] font-bold text-[var(--color-brand-800)]"
            >
              JPX ETF <ExternalLink size={12} />
            </Link>
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <SummaryTile label="対象" value={`${board.summary.total}`} hint={`通常 ${board.summary.core} / JP ${board.summary.jp} / US ${board.summary.us}`} />
        <SummaryTile label="価格あり" value={`${board.summary.priced}`} hint="既存DBで確認可能" />
        <SummaryTile label="上昇優勢" value={`${board.summary.advancing}`} hint="通常枠の前日比プラス" />
        <SummaryTile label="下落優勢" value={`${board.summary.declining}`} hint="通常枠の前日比マイナス" />
        <SummaryTile label="ステージ1/6" value={`${board.summary.stageOneOrSix}`} hint="日足Aが上向き寄り" />
        <SummaryTile label="ML参考あり" value={`${board.summary.mlReady}`} hint="JP既存株式MLの参考表示" />
      </div>

      <section className="space-y-3">
        <CardHeader title="分類別ヒートマップ" hint="レバ/インバースと関連株テーマを除いた通常枠だけで分類別の強弱を見ます。" />
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-5">
          {board.groups.map((group) => (
            <Link
              key={group.id}
              href={`/commodities/screener?group=${group.id}`}
              className="rounded-[8px] border border-[var(--color-border-default)] bg-white p-3 shadow-[var(--shadow-card)] hover:border-[var(--color-brand-600)]"
            >
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-[14px] font-bold text-[var(--color-brand-900)]">{group.label}</h2>
                <span className="font-mono text-[12px] font-bold text-[var(--color-text-tertiary)]">{group.items.length}</span>
              </div>
              <p className="mt-2 line-clamp-2 text-[11px] font-semibold leading-relaxed text-[var(--color-text-tertiary)]">{group.description}</p>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <div className="rounded-[6px] bg-red-50 px-2 py-1.5 text-center text-[11px] font-bold text-[var(--color-price-up)]">
                  上昇 {group.advancing}
                </div>
                <div className="rounded-[6px] bg-blue-50 px-2 py-1.5 text-center text-[11px] font-bold text-[var(--color-price-down)]">
                  下落 {group.declining}
                </div>
              </div>
            </Link>
          ))}
        </div>
      </section>

      {board.groups.map((group) => (
        <section key={group.id} className="space-y-3">
          <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-3 py-2">
            <h2 className="text-[15px] font-bold text-[var(--color-brand-900)]">{group.label}</h2>
            <Link href={`/commodities/screener?group=${group.id}`} className="text-[11px] font-bold text-[var(--color-brand-800)] hover:text-[var(--color-market-red)]">
              全て見る
            </Link>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {group.items.map((metric) => <CommodityCard key={`${metric.market}-${metric.ticker}`} metric={metric} />)}
          </div>
        </section>
      ))}

      <section className="space-y-3">
        <CardHeader
          title="レバ・インバース別枠"
          hint="通常ランキングには混ぜず、短期売買向けの商品として分離表示します。"
        />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {board.leveraged.map((metric) => <CommodityCard key={`${metric.market}-${metric.ticker}`} metric={metric} />)}
        </div>
        <div className="flex items-start gap-2 rounded-[8px] border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] font-semibold text-amber-800">
          <ShieldAlert size={14} className="mt-0.5 shrink-0" />
          レバレッジ/インバース型は日次リバランスの影響が大きく、長期の値動きは原資産の単純倍率になりません。
        </div>
      </section>

      <section className="space-y-3">
        <CardHeader
          title="関連株テーマ"
          hint="商品連動ETFではないため、主ランキングには混ぜず参考枠として表示します。"
        />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {board.relatedThemes.map((metric) => <CommodityCard key={`${metric.market}-${metric.ticker}`} metric={metric} />)}
        </div>
      </section>
    </div>
  )
}
