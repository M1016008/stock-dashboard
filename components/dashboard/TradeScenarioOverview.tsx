import Link from 'next/link'
import { cache } from 'react'
import { ArrowUpRight } from 'lucide-react'
import { ArchiveTradeScenarioButton } from '@/components/dashboard/ArchiveTradeScenarioButton'
import { TONE_TEXT, type DashboardTone } from '@/components/dashboard/DashboardPrimitives'
import { StageTag } from '@/components/ui/StageTag'
import { StockPreviewTrigger } from '@/components/stock-preview/StockPreviewTrigger'
import { getTradeScenarioOverview } from '@/lib/trade-scenarios/server'
import type { TradeScenarioDirection, TradeScenarioOverviewItem } from '@/lib/trade-scenarios/types'

/** Hero の「今日の予定」と一覧で同じ結果を共有する。件数 6・日付の扱いは従来どおり */
export const loadTradeScenarioOverview = cache((date: string | null) => getTradeScenarioOverview(6, date))

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

function directionTone(direction: TradeScenarioDirection): DashboardTone {
  if (direction === 'bullish') return 'up'
  if (direction === 'bearish') return 'down'
  return 'neutral'
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

const ROW_GRID = 'lg:grid-cols-[minmax(200px,0.95fr)_minmax(150px,0.7fr)_minmax(240px,1.25fr)_minmax(230px,1.1fr)_32px]'

function ScenarioProgress({ item }: { item: TradeScenarioOverviewItem }) {
  return (
    <div className="min-w-0">
      <div className="relative h-[6px] overflow-hidden rounded-[2px] bg-[var(--color-surface-muted)]" aria-hidden="true">
        <span className="absolute inset-y-0 left-0 rounded-[2px]" style={{ width: progressWidth(item), background: progressColor(item), opacity: 0.78 }} />
        <span className="absolute inset-y-[-1px] left-1/2 w-px bg-[var(--color-text-tertiary)] opacity-60" />
      </div>
      <div className="mt-1 grid grid-cols-3 font-mono text-[10px] font-semibold tabular-nums text-[var(--color-text-tertiary)]">
        <span>撤退 {fmtPrice(item.stopLossPrice)}</span>
        <span className="text-center">基準 {fmtPrice(item.anchorClose)}</span>
        <span className="text-right">目標 {fmtPrice(item.targetPrice)}</span>
      </div>
      <div className="mt-0.5 flex items-baseline justify-between gap-2 text-[10px] font-semibold tabular-nums text-[var(--color-text-tertiary)]">
        <span className="font-mono">{item.currentDate ?? item.anchorDate}</span>
        <span>
          現在 <span className="font-mono font-bold text-[var(--color-text-primary)]">{fmtPrice(item.currentClose)}</span>
        </span>
      </div>
    </div>
  )
}

function ScenarioListRow({ item }: { item: TradeScenarioOverviewItem }) {
  const removable = isRemovable(item)
  const itemLabel = `${item.ticker} ${item.name ?? item.ticker}`
  const priorityTone: DashboardTone = item.priorityTone
  return (
    <li className={`grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-2.5 py-3 transition-colors hover:bg-[var(--color-surface-subtle)] lg:items-center ${ROW_GRID}`}>
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <Link
            href={stockHref(item.ticker)}
            prefetch={false}
            className="shrink-0 font-mono text-[14px] font-bold text-[var(--color-brand-800)] hover:underline"
          >
            {item.ticker}
          </Link>
          <span className="min-w-0 truncate text-[12px] font-semibold text-[var(--color-text-primary)]">{item.name ?? item.ticker}</span>
          <StockPreviewTrigger ticker={item.ticker} analysisDate={item.currentDate ?? item.anchorDate} context="home" />
        </div>
        <div className="mt-1 text-[10px] font-semibold tabular-nums text-[var(--color-text-tertiary)]">
          <span className="font-mono">{item.anchorDate}</span>基準 · {item.horizonDays}営業日 · 残り{item.outcome.remainingDays}営業日
        </div>
      </div>

      <div className="flex items-start justify-end gap-1 lg:order-last">
        <Link
          href={stockHref(item.ticker)}
          prefetch={false}
          className="inline-flex h-7 w-7 items-center justify-center text-[var(--color-text-tertiary)] hover:text-[var(--color-brand-800)] lg:hidden"
          aria-label={`${item.ticker}の個別銘柄ページを開く`}
          title="個別銘柄ページを開く"
        >
          <ArrowUpRight size={15} />
        </Link>
        {removable && <ArchiveTradeScenarioButton id={item.id} label={itemLabel} />}
      </div>

      <div className="col-span-2 min-w-0 lg:col-span-1">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className={`text-[12px] font-bold ${TONE_TEXT[directionTone(item.direction)]}`}>{directionLabel(item.direction)}</span>
          <span className={`text-[11px] font-bold ${TONE_TEXT[priorityTone]}`}>{item.priorityLabel}</span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
          {item.stages.length > 0 && (
            <span className="inline-flex items-center gap-px">
              {item.stages.map((stage, index) => (
                <StageTag key={`${item.id}-${index}-${stage ?? 'x'}`} stage={stage} size="xs" />
              ))}
            </span>
          )}
          <span className="text-[10px] font-semibold text-[var(--color-text-tertiary)]">{item.outcome.label}</span>
        </div>
      </div>

      <div className="col-span-2 lg:col-span-1">
        <ScenarioProgress item={item} />
      </div>

      <div className="col-span-2 min-w-0 lg:col-span-1">
        <dl className="grid grid-cols-3 gap-x-3">
          {[
            { label: '現在変化', value: item.currentReturnPct },
            { label: '最大上昇', value: item.outcome.maxRisePct },
            { label: '最大下落', value: item.outcome.maxDrawdownPct },
          ].map((metric) => (
            <div key={metric.label} className="min-w-0">
              <dt className="text-[10px] font-semibold text-[var(--color-text-tertiary)]">{metric.label}</dt>
              <dd className={`font-mono text-[13px] font-bold tabular-nums ${toneClass(metric.value)}`}>{fmtPct(metric.value)}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-1 line-clamp-2 text-[11px] font-medium leading-relaxed text-[var(--color-text-secondary)]">
          {item.outcome.note}
        </p>
      </div>
    </li>
  )
}

export async function TradeScenarioOverview({ date = null }: { date?: string | null }) {
  const overview = await loadTradeScenarioOverview(date ?? null)
  const { summary, items } = overview
  const stats: Array<{ label: string; value: number; tone: DashboardTone }> = [
    { label: '要確認', value: summary.attention, tone: 'warning' },
    { label: '目標到達', value: summary.targetHit, tone: 'up' },
    { label: '撤退条件', value: summary.stopHit, tone: 'down' },
    { label: '振り返り待ち', value: summary.reviewDue, tone: 'neutral' },
    { label: '検証中', value: summary.pending, tone: 'neutral' },
  ]

  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 pb-3">
        <dl className="grid w-full grid-cols-5 gap-x-2 sm:flex sm:w-auto sm:gap-x-7">
          {stats.map((stat) => (
            <div key={stat.label} className="min-w-0">
              <dt className="text-[10px] font-semibold leading-tight text-[var(--color-text-tertiary)] sm:whitespace-nowrap">{stat.label}</dt>
              <dd className={`font-mono text-[18px] font-bold leading-tight tabular-nums ${stat.value > 0 ? TONE_TEXT[stat.tone] : 'text-[var(--color-text-tertiary)]'}`}>
                {stat.value.toLocaleString('ja-JP')}
              </dd>
            </div>
          ))}
        </dl>
        <div className="text-[11px] font-semibold text-[var(--color-text-tertiary)]">
          保存した仮説を対応が必要な順に表示 · 全<span className="font-mono font-bold tabular-nums">{summary.total.toLocaleString('ja-JP')}</span>件
        </div>
      </div>

      {summary.total === 0 ? (
        <div className="border-y border-[var(--color-border-soft)] py-6 text-center">
          <div className="text-[13px] font-bold text-[var(--color-text-primary)]">まだ売買シナリオはありません</div>
          <p className="mt-1.5 text-[12px] font-medium leading-relaxed text-[var(--color-text-tertiary)]">
            個別銘柄ページで「売買シナリオノート」を保存すると、ここに今日確認すべき仮説が表示されます。
          </p>
        </div>
      ) : (
        <>
          <div className={`hidden gap-x-4 border-y border-[var(--color-border-default)] py-1.5 text-[10px] font-bold text-[var(--color-text-tertiary)] lg:grid ${ROW_GRID}`}>
            <div>銘柄・基準日</div>
            <div>判断・ステージ</div>
            <div>価格進捗 (撤退 — 基準 — 目標)</div>
            <div>期間内の変化</div>
            <div className="sr-only">操作</div>
          </div>
          <ul className="divide-y divide-[var(--color-border-soft)] border-b border-[var(--color-border-soft)] max-lg:border-t">
            {items.map((item) => (
              <ScenarioListRow key={item.id} item={item} />
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
