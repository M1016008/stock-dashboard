import Link from 'next/link'
import { ArrowUpRight } from 'lucide-react'
import { ArchiveTradeScenarioButton } from '@/components/dashboard/ArchiveTradeScenarioButton'
import { StageTag } from '@/components/ui/StageTag'
import { StockPreviewTrigger } from '@/components/stock-preview/StockPreviewTrigger'
import { getTradeScenarioOverview } from '@/lib/trade-scenarios/server'
import type { TradeScenarioDirection, TradeScenarioOverviewItem } from '@/lib/trade-scenarios/types'

function fmtPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '---'
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`
}

function fmtPrice(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '---'
  return value.toLocaleString('ja-JP', { maximumFractionDigits: 1 })
}

function toneClass(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'text-[var(--color-text-secondary)]'
  if (value > 0) return 'text-[var(--color-price-up)]'
  if (value < 0) return 'text-[var(--color-price-down)]'
  return 'text-[var(--color-text-secondary)]'
}

function directionLabel(direction: TradeScenarioDirection): string {
  if (direction === 'bullish') return '上昇'
  if (direction === 'bearish') return '下落'
  return '見送り'
}

function directionTone(direction: TradeScenarioDirection): string {
  if (direction === 'bullish') return 'text-[var(--color-price-up)] bg-[var(--color-price-up-bg)] border-[rgba(185,28,28,0.22)]'
  if (direction === 'bearish') return 'text-[var(--color-price-down)] bg-[var(--color-price-down-bg)] border-[rgba(30,64,175,0.22)]'
  return 'text-[var(--color-text-secondary)] bg-[var(--color-surface-subtle)] border-[var(--color-border-soft)]'
}

function priorityToneClass(tone: TradeScenarioOverviewItem['priorityTone']): string {
  if (tone === 'up') return 'border-[rgba(185,28,28,0.28)] bg-[var(--color-price-up-bg)] text-[var(--color-price-up)]'
  if (tone === 'down') return 'border-[rgba(30,64,175,0.28)] bg-[var(--color-price-down-bg)] text-[var(--color-price-down)]'
  if (tone === 'warning') return 'border-[rgba(217,119,6,0.28)] bg-[#fff7ed] text-[#b45309]'
  return 'border-[var(--color-border-soft)] bg-white text-[var(--color-text-secondary)]'
}

function progressColor(item: TradeScenarioOverviewItem): string {
  if (item.outcome.status === 'stop_hit') return 'var(--color-price-down)'
  if (item.outcome.status === 'target_hit') return 'var(--color-price-up)'
  if (item.direction === 'bearish') return 'var(--color-price-down)'
  if (item.direction === 'bullish') return 'var(--color-price-up)'
  return 'var(--color-brand-700)'
}

function progressWidth(item: TradeScenarioOverviewItem): string {
  const value = item.targetProgressPct
  if (value == null || !Number.isFinite(value)) return '12%'
  return `${Math.max(4, Math.min(100, value))}%`
}

function stockHref(ticker: string) {
  return `/stock/${encodeURIComponent(ticker)}`
}

const REMOVABLE_OUTCOMES = new Set<TradeScenarioOverviewItem['outcome']['status']>([
  'target_hit',
  'stop_hit',
  'direction_matched',
  'direction_missed',
  'watch_ok',
  'watch_missed',
  'expired',
])

function isRemovable(item: TradeScenarioOverviewItem): boolean {
  return item.status === 'reviewed' || REMOVABLE_OUTCOMES.has(item.outcome.status)
}

function ScenarioMiniProgress({ item }: { item: TradeScenarioOverviewItem }) {
  const progress = progressWidth(item)
  const color = progressColor(item)
  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-center justify-between gap-2 text-[10px] font-bold text-[var(--color-text-tertiary)]">
        <span>撤退 {fmtPrice(item.stopLossPrice)}</span>
        <span>基準 {fmtPrice(item.anchorClose)}</span>
        <span>目標 {fmtPrice(item.targetPrice)}</span>
      </div>
      <div className="relative h-2 overflow-hidden rounded-full border border-[var(--color-border-soft)] bg-white">
        <span className="absolute left-0 top-0 h-full rounded-full" style={{ width: progress, background: color, opacity: 0.76 }} />
        <span className="absolute left-1/2 top-[-2px] h-[12px] w-[2px] bg-[var(--color-text-tertiary)] opacity-50" />
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 text-[10px] font-semibold text-[var(--color-text-tertiary)]">
        <span>{item.currentDate ?? item.anchorDate}</span>
        <span>現在 {fmtPrice(item.currentClose)}</span>
      </div>
    </div>
  )
}

function ScenarioListRow({ item }: { item: TradeScenarioOverviewItem }) {
  const removable = isRemovable(item)
  const itemLabel = `${item.ticker} ${item.name ?? item.ticker}`
  return (
    <li className="grid min-w-0 gap-3 px-3 py-3 transition-colors hover:bg-[var(--color-surface-subtle)] sm:px-4 lg:grid-cols-[minmax(180px,0.9fr)_minmax(190px,0.95fr)_minmax(260px,1.35fr)_minmax(210px,1fr)] lg:items-center lg:gap-4">
      <div className="flex min-w-0 items-start justify-between gap-3 lg:block">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={stockHref(item.ticker)}
              prefetch={false}
              className="font-mono text-[15px] font-bold text-[var(--color-brand-800)] hover:underline"
            >
              {item.ticker}
            </Link>
            <span className="max-w-[240px] truncate text-[12px] font-bold text-[var(--color-text-primary)]">
              {item.name ?? item.ticker}
            </span>
            <StockPreviewTrigger ticker={item.ticker} analysisDate={item.currentDate ?? item.anchorDate} context="home" />
          </div>
          <div className="mt-1.5 text-[10px] font-semibold text-[var(--color-text-tertiary)]">
            {item.anchorDate}基準 / {item.horizonDays}営業日 / 残り{item.outcome.remainingDays}営業日
          </div>
        </div>
        <div className="flex shrink-0 items-center lg:hidden">
          <Link
            href={stockHref(item.ticker)}
            prefetch={false}
            className="inline-flex h-7 w-7 items-center justify-center text-[var(--color-text-tertiary)] hover:text-[var(--color-brand-800)]"
            aria-label={`${item.ticker}の個別銘柄ページを開く`}
            title="個別銘柄ページを開く"
          >
            <ArrowUpRight size={15} />
          </Link>
          {removable && <ArchiveTradeScenarioButton id={item.id} label={itemLabel} />}
        </div>
      </div>

      <div className="min-w-0">
        <div className="flex flex-wrap gap-1.5">
          <span className={`rounded-full border px-2 py-1 text-[10px] font-bold ${directionTone(item.direction)}`}>
            {directionLabel(item.direction)}
          </span>
          <span className={`rounded-full border px-2 py-1 text-[10px] font-bold ${priorityToneClass(item.priorityTone)}`}>
            {item.priorityLabel}
          </span>
        </div>
        {item.stages.length > 0 && (
          <div className="mt-2 flex items-center gap-1">
            {item.stages.map((stage, index) => (
              <StageTag key={`${item.id}-${index}-${stage ?? 'x'}`} stage={stage} size="xs" />
            ))}
          </div>
        )}
        <div className="mt-2 text-[10px] font-bold text-[var(--color-text-tertiary)]">
          {item.outcome.label}
        </div>
      </div>

      <ScenarioMiniProgress item={item} />

      <div className="min-w-0">
        <div className="grid grid-cols-3 divide-x divide-[var(--color-border-soft)]">
          <Metric label="現在変化" value={fmtPct(item.currentReturnPct)} className={toneClass(item.currentReturnPct)} />
          <Metric label="最大上昇" value={fmtPct(item.outcome.maxRisePct)} className={toneClass(item.outcome.maxRisePct)} />
          <Metric label="最大下落" value={fmtPct(item.outcome.maxDrawdownPct)} className={toneClass(item.outcome.maxDrawdownPct)} />
        </div>
        <p className="mt-2 line-clamp-2 text-[11px] font-medium leading-relaxed text-[var(--color-text-secondary)]">
          {item.outcome.note}
        </p>
        <div className="mt-1.5 hidden items-start justify-between gap-2 lg:flex">
          <Link
            href={stockHref(item.ticker)}
            prefetch={false}
            className="inline-flex items-center gap-1 text-[10px] font-bold text-[var(--color-brand-700)] hover:underline"
          >
            銘柄ページ
            <ArrowUpRight size={12} />
          </Link>
          {removable && <ArchiveTradeScenarioButton id={item.id} label={itemLabel} />}
        </div>
      </div>
    </li>
  )
}

function Metric({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className="min-w-0 px-2 first:pl-0 last:pr-0">
      <div className="text-[10px] font-bold text-[var(--color-text-tertiary)]">{label}</div>
      <div className={`mt-0.5 font-mono text-[13px] font-bold ${className ?? ''}`}>{value}</div>
    </div>
  )
}

function SummaryStat({ label, value, tone }: { label: string; value: number; tone?: 'up' | 'down' | 'warning' }) {
  const cls = tone === 'up'
    ? 'text-[var(--color-price-up)]'
    : tone === 'down'
      ? 'text-[var(--color-price-down)]'
      : tone === 'warning'
        ? 'text-[#b45309]'
        : 'text-[var(--color-text-primary)]'
  return (
    <div className="min-w-0 px-1 py-2 text-center sm:px-4 sm:text-left">
      <div className="whitespace-nowrap text-[9px] font-bold text-[var(--color-text-tertiary)] sm:text-[10px]">{label}</div>
      <div className={`mt-0.5 font-mono text-[16px] font-bold sm:text-[17px] ${cls}`}>{value.toLocaleString()}</div>
    </div>
  )
}

export async function TradeScenarioOverview({ date = null }: { date?: string | null }) {
  const overview = await getTradeScenarioOverview(6, date)
  const { summary, items } = overview

  return (
    <section className="overflow-hidden border-y border-[var(--color-border-default)] bg-white">
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-[var(--color-border-default)] px-3 py-3 sm:px-4">
        <div>
          <h3 className="text-[13px] font-black text-[var(--color-brand-900)]">売買シナリオ進捗</h3>
          <p className="mt-1 text-[11px] font-semibold text-[var(--color-text-tertiary)]">
            保存した仮説を、対応が必要な順に一覧表示
          </p>
        </div>
        <div className="font-mono text-[11px] font-bold text-[var(--color-text-tertiary)]">
          全{summary.total.toLocaleString()}件
        </div>
      </div>

      <div className="grid grid-cols-5 divide-x divide-[var(--color-border-soft)] border-b border-[var(--color-border-default)] bg-[var(--color-surface-subtle)]">
        <SummaryStat label="要確認" value={summary.attention} tone="warning" />
        <SummaryStat label="目標到達" value={summary.targetHit} tone="up" />
        <SummaryStat label="撤退条件" value={summary.stopHit} tone="down" />
        <SummaryStat label="振り返り待ち" value={summary.reviewDue} />
        <SummaryStat label="検証中" value={summary.pending} />
      </div>

      {summary.total === 0 ? (
        <div className="px-4 py-7 text-center">
          <div className="text-[13px] font-bold text-[var(--color-text-primary)]">まだ売買シナリオはありません</div>
          <p className="mt-2 text-[12px] font-medium leading-relaxed text-[var(--color-text-tertiary)]">
            個別銘柄ページで「売買シナリオノート」を保存すると、ここに今日確認すべき仮説が表示されます。
          </p>
        </div>
      ) : (
        <>
          <div className="hidden grid-cols-[minmax(180px,0.9fr)_minmax(190px,0.95fr)_minmax(260px,1.35fr)_minmax(210px,1fr)] gap-4 border-b border-[var(--color-border-soft)] bg-white px-4 py-2 text-[10px] font-black text-[var(--color-text-tertiary)] lg:grid">
            <div>銘柄・基準日</div>
            <div>判断・ステージ</div>
            <div>価格進捗</div>
            <div>期間内の変化</div>
          </div>
          <ul className="divide-y divide-[var(--color-border-soft)]">
            {items.map((item) => (
              <ScenarioListRow key={item.id} item={item} />
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
