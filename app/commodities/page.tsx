import type { Metadata } from 'next'
import Link from 'next/link'
import { ChevronRight, ExternalLink } from 'lucide-react'
import { PageTitle } from '@/components/layout/PageTitle'
import { SectionHeader } from '@/components/ui/SectionHeader'
import { StatStrip } from '@/components/ui/StatStrip'
import { StageDots } from '@/components/ui/StageDots'
import { EmptyState, Notice } from '@/components/ui/EmptyState'
import { CommodityNav } from '@/components/commodities/CommodityNav'
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

function CommodityCard({ metric }: { metric: CommodityMetric }) {
  const href = `/commodities/${metric.marketSlug}/${encodeURIComponent(metric.ticker)}`
  const figures = [
    { label: '価格', value: fmtPrice(metric.price, metric.currency), tone: 'text-[var(--color-text-primary)]' },
    { label: '1日', value: fmtPct(metric.returns.day1), tone: pctTone(metric.returns.day1) },
    { label: '20日', value: fmtPct(metric.returns.day20), tone: pctTone(metric.returns.day20) },
    { label: 'PMS', value: fmtScore(metric.physicalMomentum.pms), tone: pctTone(metric.physicalMomentum.pms) },
  ]
  return (
    <Link
      href={href}
      prefetch={false}
      className="group flex min-w-0 flex-col rounded-[var(--radius-card)] border border-[var(--color-border-default)] bg-white transition-colors hover:border-[var(--color-brand-400)]"
    >
      <div className="flex min-w-0 items-start justify-between gap-3 px-3 pt-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-[12px] font-bold text-[var(--color-brand-800)]">{metric.market}:{metric.ticker}</span>
            <span className="text-[11px] text-[var(--color-text-tertiary)]">{commodityGroupLabel(metric.group)} ・ {COMMODITY_PRODUCT_LABELS[metric.productType]}</span>
          </div>
          <h3 className="mt-1 line-clamp-2 text-[14px] font-bold leading-snug text-[var(--color-text-primary)] group-hover:text-[var(--color-brand-800)] group-hover:underline">
            {metric.shortName}
          </h3>
          <p className="mt-0.5 line-clamp-2 text-[12px] leading-relaxed text-[var(--color-text-tertiary)]">
            {metric.description}
          </p>
        </div>
        <ChevronRight size={15} aria-hidden className="mt-0.5 shrink-0 text-[var(--color-text-tertiary)] group-hover:text-[var(--color-brand-700)]" />
      </div>

      <dl className="mx-3 mt-3 grid grid-cols-4 divide-x divide-[var(--color-border-soft)] border-y border-[var(--color-border-soft)]">
        {figures.map((figure) => (
          <div key={figure.label} className="min-w-0 px-2 py-1.5 first:pl-0">
            <dt className="text-[11px] text-[var(--color-text-tertiary)]">{figure.label}</dt>
            <dd className={`m-0 mt-0.5 truncate font-mono text-[13px] font-semibold tabular-nums ${figure.tone}`}>{figure.value}</dd>
          </div>
        ))}
      </dl>

      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-[11px] text-[var(--color-text-tertiary)]">6ステージ</span>
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
        </div>
        <span className="status-tag">{metric.maTrendLabel}</span>
      </div>

      <div className="mt-auto flex items-center justify-between gap-2 border-t border-[var(--color-border-soft)] px-3 py-1.5 text-[11px] text-[var(--color-text-tertiary)]">
        <span className="font-mono tabular-nums">価格 {metric.priceDate ?? '---'}</span>
        <span className={metric.ml.available ? 'font-semibold text-[var(--color-brand-800)]' : undefined}>
          {metric.market === 'JP' ? metric.ml.label : 'US ML未生成'}
        </span>
      </div>
    </Link>
  )
}

function CardGrid({ items, className }: { items: CommodityMetric[]; className: string }) {
  if (items.length === 0) {
    return <EmptyState title="該当する銘柄はありません" className="min-h-[120px] rounded-[var(--radius-card)] border border-dashed border-[var(--color-border-default)]" />
  }
  return (
    <div className={`grid min-w-0 grid-cols-1 gap-3 ${className}`}>
      {items.map((metric) => <CommodityCard key={`${metric.market}-${metric.ticker}`} metric={metric} />)}
    </div>
  )
}

export default async function CommoditiesPage() {
  const board = await getCommodityBoard()
  const s = board.summary

  return (
    <div className="flex w-full min-w-0 flex-col gap-6">
      <PageTitle
        eyebrow="コモディティ"
        title="コモディティ分析"
        subtitle="国内上場ETF/ETNと米国上場ETFで、金・原油・銅・農産物などの商品トレンドを6ステージ・MA・物理特徴量で確認します。"
        meta={<>
          <span>価格 {board.latestPriceDate ?? '---'}</span>
          <span>ステージ {board.latestStageDate ?? '---'}</span>
        </>}
        rightSlot={(
          <a href={COMMODITY_REFERENCE_LINKS.jpxEtf} target="_blank" rel="noreferrer" className="btn" data-variant="ghost">
            JPX ETF一覧 <ExternalLink size={13} aria-hidden />
          </a>
        )}
      >
        <CommodityNav current="board" />
      </PageTitle>

      <StatStrip
        label="コモディティ全体の要約"
        items={[
          { label: '対象', value: s.total, sub: `通常 ${s.core} / JP ${s.jp} / US ${s.us}` },
          { label: '価格あり', value: s.priced, sub: '既存DBで確認可能' },
          { label: '上昇優勢', value: s.advancing, sub: '通常枠の前日比プラス', tone: 'up' },
          { label: '下落優勢', value: s.declining, sub: '通常枠の前日比マイナス', tone: 'down' },
          { label: 'ステージ1/6', value: s.stageOneOrSix, sub: '日足Aが上向き寄り' },
          { label: 'ML参考あり', value: s.mlReady, sub: 'JP既存株式MLの参考表示' },
        ]}
      />

      <section aria-labelledby="commodity-groups-title" className="flex min-w-0 flex-col gap-3">
        <SectionHeader
          id="commodity-groups-title"
          level={1}
          title="分類別の強弱"
          description="レバ/インバースと関連株テーマを除いた通常枠の前日比。行を選ぶとスクリーナーで絞り込みます"
        />
        {board.groups.length === 0 ? (
          <EmptyState title="分類データがありません" description="コモディティのユニバースが未登録です。" />
        ) : (
          <ul className="grid min-w-0 gap-px overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border-soft)] bg-[var(--color-border-soft)] md:grid-cols-2 xl:grid-cols-5">
            {board.groups.map((group) => {
              const counted = group.advancing + group.declining
              const upShare = counted > 0 ? (group.advancing / counted) * 100 : 0
              return (
                <li key={group.id} className="min-w-0 bg-white">
                  <Link
                    href={`/commodities/screener?group=${group.id}`}
                    prefetch={false}
                    className="flex h-full min-w-0 flex-col gap-2 px-3 py-3 hover:bg-[var(--color-surface-subtle)]"
                  >
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-[14px] font-bold text-[var(--color-text-primary)]">{group.label}</span>
                      <span className="shrink-0 font-mono text-[12px] tabular-nums text-[var(--color-text-tertiary)]">{group.items.length}銘柄</span>
                    </span>
                    <span className="line-clamp-2 text-[12px] leading-relaxed text-[var(--color-text-tertiary)]">{group.description}</span>
                    <span className="mt-auto flex h-1.5 overflow-hidden rounded-[2px] bg-[var(--color-surface-muted)]" aria-hidden>
                      {counted > 0 && <>
                        <span style={{ width: `${upShare}%`, background: 'var(--color-price-up)' }} />
                        <span style={{ width: `${100 - upShare}%`, background: 'var(--color-price-down)' }} />
                      </>}
                    </span>
                    <span className="flex justify-between font-mono text-[12px] font-semibold tabular-nums">
                      <span className="text-[var(--color-price-up)]">上昇 {group.advancing}</span>
                      <span className="text-[var(--color-price-down)]">下落 {group.declining}</span>
                    </span>
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {board.groups.map((group) => (
        <section key={group.id} aria-labelledby={`commodity-group-${group.id}`} className="flex min-w-0 flex-col gap-3">
          <SectionHeader
            id={`commodity-group-${group.id}`}
            title={group.label}
            description={`${group.items.length}銘柄`}
            actions={(
              <Link href={`/commodities/screener?group=${group.id}`} prefetch={false} className="btn" data-variant="ghost" data-size="sm">
                スクリーナーで見る <ChevronRight size={13} aria-hidden />
              </Link>
            )}
          />
          <CardGrid items={group.items} className="sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4" />
        </section>
      ))}

      <section aria-labelledby="commodity-leveraged-title" className="flex min-w-0 flex-col gap-3">
        <SectionHeader
          id="commodity-leveraged-title"
          level={1}
          title="レバ・インバース別枠"
          description="通常ランキングには混ぜず、短期売買向けの商品として分離表示します"
        />
        <Notice tone="warning">
          レバレッジ/インバース型は日次リバランスの影響が大きく、長期の値動きは原資産の単純倍率になりません。
        </Notice>
        <CardGrid items={board.leveraged} className="sm:grid-cols-2 xl:grid-cols-4" />
      </section>

      <section aria-labelledby="commodity-related-title" className="flex min-w-0 flex-col gap-3">
        <SectionHeader
          id="commodity-related-title"
          level={1}
          title="関連株テーマ"
          description="商品連動ETFではないため、主ランキングには混ぜず参考枠として表示します"
        />
        <CardGrid items={board.relatedThemes} className="sm:grid-cols-2 xl:grid-cols-3" />
      </section>
    </div>
  )
}
