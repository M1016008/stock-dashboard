import type { Metadata } from 'next'
import Link from 'next/link'
import { ExternalLink } from 'lucide-react'
import { PageTitle } from '@/components/layout/PageTitle'
import { CardHeader } from '@/components/ui/Card'
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
      className="group block min-h-[184px] rounded-[8px] border border-[var(--color-border-default)] bg-white p-3 shadow-[var(--shadow-card)] transition hover:border-[var(--color-brand-600)] hover:shadow-md"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-6 items-center rounded-[3px] bg-[var(--color-brand-700)] px-2 font-mono text-[12px] font-bold text-white">
              {metric.ticker}
            </span>
            <span className="truncate text-[11px] font-bold text-[var(--color-text-tertiary)]">
              {metric.provider.toUpperCase()}
            </span>
          </div>
          <h3 className="mt-2 line-clamp-2 text-[14px] font-bold leading-snug text-[var(--color-brand-900)] group-hover:text-[var(--color-market-red)]">
            {metric.shortName}
          </h3>
          <p className="mt-1 line-clamp-2 text-[11px] font-semibold leading-relaxed text-[var(--color-text-tertiary)]">
            {metric.description}
          </p>
        </div>
        <ExternalLink size={15} className="mt-0.5 shrink-0 text-[var(--color-text-tertiary)]" />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-[11px]">
        <div className="rounded-[6px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-2 py-1.5">
          <div className="font-bold text-[var(--color-text-tertiary)]">価格</div>
          <div className="mt-1 font-mono text-[15px] font-bold text-[var(--color-text-primary)]">
            {fmtPrice(metric.price)}
          </div>
        </div>
        <div className="rounded-[6px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-2 py-1.5">
          <div className="font-bold text-[var(--color-text-tertiary)]">前日比</div>
          <div className={`mt-1 font-mono text-[15px] font-bold ${pctTone(metric.changePct)}`}>
            {fmtPct(metric.changePct)}
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
        <span>構成銘柄</span>
        <span className={metric.holdings.count > 0 ? 'text-[var(--color-brand-800)]' : 'text-[var(--color-text-tertiary)]'}>
          {sourceBadge(metric)}
        </span>
      </div>
    </Link>
  )
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

export default async function SectorEtfsPage() {
  const board = await getSectorEtfBoard()

  return (
    <div className="sb-page">
      <PageTitle
        title="業界ETF分析"
        subtitle="国内上場ETFで、TOPIX-17業界とテーマ別の資金流入・流出、6ステージ、MA状態を確認します。"
        badge={`価格 ${board.latestPriceDate ?? '---'} / ステージ ${board.latestStageDate ?? '---'}`}
        rightSlot={
          <Link
            href={board.referenceLinks.jpxTopix17}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-7 items-center gap-1 rounded-[3px] border border-[var(--color-border-default)] bg-white px-2 text-[11px] font-bold text-[var(--color-brand-800)]"
          >
            JPX TOPIX-17 <ExternalLink size={12} />
          </Link>
        }
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <SummaryTile label="対象ETF" value={`${board.summary.total}`} hint={`価格あり ${board.summary.priced}`} />
        <SummaryTile label="上昇優勢" value={`${board.summary.advancing}`} hint="前日比プラス" />
        <SummaryTile label="下落優勢" value={`${board.summary.declining}`} hint="前日比マイナス" />
        <SummaryTile label="ステージ1/6" value={`${board.summary.stageOneOrSix}`} hint="日足Aが上向き寄り" />
        <SummaryTile label="ステージ4" value={`${board.summary.stageFour}`} hint="日足Aが弱気配列" />
        <SummaryTile label="構成取得済み" value={`${board.summary.holdingsReady}`} hint="holding table populated" />
      </div>

      <section className="space-y-3">
        <CardHeader
          title="TOPIX-17代表ETF"
          hint="33業種ではなく、今回はTOPIX-17を業界分析の軸として表示します。"
        />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {board.topix17.map((metric) => <EtfCard key={metric.ticker} metric={metric} />)}
        </div>
      </section>

      <section className="space-y-4">
        <CardHeader
          title="国内上場テーマETF"
          hint="投資対象が海外でも、東証上場ETFであればテーマETFとして採用しています。"
        />
        {board.themeGroups.map((group) => (
          <div key={group.group} className="space-y-3">
            <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-3 py-2">
              <h2 className="text-[15px] font-bold text-[var(--color-brand-900)]">{group.group}</h2>
              <span className="text-[11px] font-bold text-[var(--color-text-tertiary)]">
                {group.items.length.toLocaleString()} ETF
              </span>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {group.items.map((metric) => <EtfCard key={metric.ticker} metric={metric} />)}
            </div>
          </div>
        ))}
      </section>
    </div>
  )
}
