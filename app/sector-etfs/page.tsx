import type { Metadata } from 'next'
import Link from 'next/link'
import { ChevronRight, ExternalLink } from 'lucide-react'
import { PageTitle } from '@/components/layout/PageTitle'
import { SectionHeader } from '@/components/ui/SectionHeader'
import { StatStrip } from '@/components/ui/StatStrip'
import { StageDots } from '@/components/ui/StageDots'
import { getSectorEtfBoard, type SectorEtfMetric } from '@/lib/queries/sector-etfs'

export const metadata: Metadata = {
  title: '業界ETF分析 — StockBoard',
  description: '国内上場ETFでTOPIX-17業界とテーマ別トレンドを確認',
}

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

function fmtPrice(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '---'
  return value.toLocaleString('ja-JP', { maximumFractionDigits: 1 })
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

function sourceBadge(metric: SectorEtfMetric) {
  if (metric.holdings.count > 0) {
    return `${metric.holdings.asOfDate ?? '日付不明'} · ${metric.holdings.count.toLocaleString()}件`
  }
  if (metric.holdings.lastRunStatus === 'failed') return '取得失敗'
  if (metric.holdings.lastRunStatus === 'skipped') return '未対応'
  return '未取得'
}

function EtfCard({ metric }: { metric: SectorEtfMetric }) {
  const href = `/sector-etfs/${encodeURIComponent(metric.ticker)}`
  return (
    <Link
      href={href}
      prefetch={false}
      className="group flex min-w-0 flex-col rounded-[6px] border border-[var(--color-border-default)] bg-white p-3 transition-colors hover:border-[var(--color-brand-500)]"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[13px] font-bold text-[var(--color-brand-700)]">{metric.ticker}</span>
            <span className="truncate text-[11px] text-[var(--color-text-tertiary)]">{metric.provider.toUpperCase()}</span>
          </div>
          <h3 className="mt-1 line-clamp-2 text-[14px] font-bold leading-snug text-[var(--color-text-primary)] group-hover:text-[var(--color-brand-800)]">
            {metric.shortName}
          </h3>
        </div>
        <div className="shrink-0 text-right">
          <div className="font-mono text-[15px] font-bold tabular-nums text-[var(--color-text-primary)]">{fmtPrice(metric.price)}</div>
          <div className={`font-mono text-[13px] font-bold tabular-nums ${pctTone(metric.changePct)}`}>{fmtPct(metric.changePct)}</div>
        </div>
      </div>
      <p className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-[var(--color-text-secondary)]">
        {metric.description}
      </p>

      <div className="mt-auto pt-3">
        <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-2 border-t border-[var(--color-border-soft)] pt-2.5">
          <div>
            <div className="mb-1 text-[10px] font-semibold text-[var(--color-text-tertiary)]">6ステージ</div>
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
          <dl className="grid grid-cols-3 gap-x-3 text-right font-mono text-[12px] tabular-nums">
            <div>
              <dt className="font-sans text-[10px] text-[var(--color-text-tertiary)]">PMS</dt>
              <dd className={`m-0 font-bold ${pctTone(metric.physicalMomentum.pms)}`}>{fmtScore(metric.physicalMomentum.pms)}</dd>
            </div>
            <div>
              <dt className="font-sans text-[10px] text-[var(--color-text-tertiary)]">PFS</dt>
              <dd className="m-0 text-[var(--color-text-primary)]">{fmtScore(metric.physicalMomentum.pfs)}</dd>
            </div>
            <div>
              <dt className="font-sans text-[10px] text-[var(--color-text-tertiary)]">PES</dt>
              <dd className="m-0 text-[var(--color-text-primary)]">{fmtScore(metric.physicalMomentum.pes)}</dd>
            </div>
          </dl>
        </div>
        <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-[var(--color-text-tertiary)]">
          <span className="rounded-[3px] bg-[var(--color-surface-muted)] px-1.5 py-0.5 font-semibold text-[var(--color-text-secondary)]">
            {metric.maTrendLabel}
          </span>
          <span className="inline-flex items-center gap-1 tabular-nums">
            構成銘柄
            <span className={metric.holdings.count > 0 ? 'font-semibold text-[var(--color-text-secondary)]' : ''}>{sourceBadge(metric)}</span>
            <ChevronRight size={13} className="text-[var(--color-text-tertiary)] group-hover:text-[var(--color-brand-700)]" aria-hidden />
          </span>
        </div>
      </div>
    </Link>
  )
}

export default async function SectorEtfsPage() {
  const board = await getSectorEtfBoard()

  return (
    <div className="sb-page">
      <PageTitle
        eyebrow="市場・業種"
        title="業界ETF分析"
        subtitle="国内上場ETFで、TOPIX-17業界とテーマ別の資金の向き・6ステージ・MA状態を比較します。"
        meta={<>
          <span>価格 <strong className="font-semibold text-[var(--color-text-primary)]">{board.latestPriceDate ?? '—'}</strong></span>
          <span>ステージ <strong className="font-semibold text-[var(--color-text-primary)]">{board.latestStageDate ?? '—'}</strong></span>
        </>}
        rightSlot={
          <Link
            href={board.referenceLinks.jpxTopix17}
            target="_blank"
            rel="noreferrer"
            className="btn"
          >
            JPX TOPIX-17 <ExternalLink size={13} aria-hidden />
          </Link>
        }
      />

      <StatStrip
        label="対象ETFの集計"
        items={[
          { label: '対象ETF', value: board.summary.total.toLocaleString(), sub: `価格あり ${board.summary.priced}` },
          { label: '上昇', value: board.summary.advancing.toLocaleString(), sub: '前日比プラス', tone: 'up' },
          { label: '下落', value: board.summary.declining.toLocaleString(), sub: '前日比マイナス', tone: 'down' },
          { label: 'ステージ1・6', value: board.summary.stageOneOrSix.toLocaleString(), sub: '日足Aが上向き寄り' },
          { label: 'ステージ4', value: board.summary.stageFour.toLocaleString(), sub: '日足Aが弱気配列' },
          { label: '構成銘柄あり', value: board.summary.holdingsReady.toLocaleString(), sub: '構成銘柄を取得済み' },
        ]}
      />

      <section className="min-w-0">
        <SectionHeader
          level={1}
          title="TOPIX-17代表ETF"
          description="業界分析の軸はTOPIX-17。各ETFから構成銘柄と値動きを確認できます。"
          actions={<span className="text-[12px] tabular-nums text-[var(--color-text-tertiary)]">{board.topix17.length} ETF</span>}
        />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {board.topix17.map((metric) => <EtfCard key={metric.ticker} metric={metric} />)}
        </div>
      </section>

      <section className="min-w-0 space-y-6">
        <SectionHeader
          level={1}
          title="国内上場テーマETF"
          description="投資対象が海外でも、東証上場ETFであればテーマETFとして扱います。"
        />
        {board.themeGroups.map((group) => (
          <div key={group.group} className="min-w-0">
            <SectionHeader
              as="h3"
              title={group.group}
              actions={<span className="text-[12px] tabular-nums text-[var(--color-text-tertiary)]">{group.items.length.toLocaleString()} ETF</span>}
            />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {group.items.map((metric) => <EtfCard key={metric.ticker} metric={metric} />)}
            </div>
          </div>
        ))}
      </section>
    </div>
  )
}
