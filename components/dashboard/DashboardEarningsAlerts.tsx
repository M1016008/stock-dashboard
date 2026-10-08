import Link from 'next/link'
import { cache } from 'react'
import { ArrowUpRight } from 'lucide-react'
import { MarginBadges } from '@/components/ui/MarginBadges'
import { StageTag } from '@/components/ui/StageTag'
import { StockPreviewTrigger } from '@/components/stock-preview/StockPreviewTrigger'
import { GroupLabel, signedTextClass } from '@/components/dashboard/DashboardPrimitives'
import { type EarningsRow } from '@/lib/queries/dashboard'
import { getDashboardEarningsAlertsCached } from '@/lib/queries/dashboard-earnings-alerts-cache'
import type { UniverseFilterValue } from '@/lib/market-universe'

/** Hero と決算セクションで同じ結果を共有する。取得条件は従来どおり */
export const loadDashboardEarningsAlerts = cache((date: string | null, universe: UniverseFilterValue) =>
  getDashboardEarningsAlertsCached(date, universe),
)

function fmtPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '---'
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
}

function fmtVolume(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '---'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${Math.round(value / 1_000).toLocaleString('ja-JP')}K`
  return value.toLocaleString('ja-JP')
}

function monthOf(date: string | null | undefined): string {
  return date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date.slice(0, 7) : ''
}

export function earningsHref(date: string | null | undefined, universe: UniverseFilterValue): string {
  const sp = new URLSearchParams()
  if (date) {
    sp.set('date', date)
    sp.set('month', monthOf(date))
  }
  sp.set('sort', 'signalCount')
  sp.set('dir', 'desc')
  if (universe) sp.set('universe', universe)
  return `/earnings?${sp.toString()}`
}

function stockHref(ticker: string): string {
  return `/stock/${encodeURIComponent(ticker)}`
}

function alertScore(row: EarningsRow): number {
  const signalCount = row.signalLabels?.length ?? 0
  const daysScore = row.daysLeft <= 1 ? 4 : row.daysLeft <= 3 ? 3 : row.daysLeft <= 7 ? 2 : 1
  const volumeScore = (row.avgVolume30 ?? 0) >= 1_000_000 ? 1.5 : (row.avgVolume30 ?? 0) >= 300_000 ? 0.8 : 0
  const moveScore = Math.abs(row.changePct ?? 0) >= 3 ? 1 : 0
  const marginScore = row.marginType?.includes('貸借') ? 0.5 : 0
  return signalCount * 2 + daysScore + volumeScore + moveScore + marginScore
}

function completedScore(row: EarningsRow): number {
  return Math.abs(row.postEarningsChangePct ?? 0) + (row.signalLabels?.length ?? 0) * 2
}

/** 従来の並び (注意スコア順 上位8件 / 発表後 上位5件) をそのまま返す */
export function rankEarningsAlerts(rows: EarningsRow[], completedRows: EarningsRow[]) {
  const upcoming = [...rows].sort((a, b) => alertScore(b) - alertScore(a)).slice(0, 8)
  const completed = [...completedRows].sort((a, b) => completedScore(b) - completedScore(a)).slice(0, 5)
  const signalCount = upcoming.filter((row) => (row.signalLabels?.length ?? 0) > 0).length
  return { upcoming, completed, signalCount }
}

export function daysLeftText(daysLeft: number): string {
  return daysLeft <= 0 ? '当日' : `${daysLeft}日後`
}

function StageStrip({ row }: { row: EarningsRow }) {
  const stages = [
    row.daily_a_stage,
    row.daily_b_stage,
    row.weekly_a_stage,
    row.weekly_b_stage,
    row.monthly_a_stage,
    row.monthly_b_stage,
  ]
  return (
    <span className="inline-flex shrink-0 items-center gap-px whitespace-nowrap">
      {stages.map((stage, index) => (
        <span key={`${row.ticker}-${index}-${stage ?? 'x'}`} className={`inline-flex ${index === 2 || index === 4 ? 'ml-1' : ''}`}>
          <StageTag stage={stage} size="xs" />
        </span>
      ))}
    </span>
  )
}

function SignalLabels({ row }: { row: EarningsRow }) {
  const labels = row.signalLabels?.slice(0, 3) ?? []
  if (labels.length === 0) {
    return <span className="text-[10px] font-semibold text-[var(--color-text-tertiary)]">通常監視</span>
  }
  return (
    <span className="inline-flex min-w-0 flex-wrap gap-x-2 gap-y-0.5">
      {labels.map((label) => (
        <span key={`${row.ticker}-${label}`} className="text-[10px] font-bold text-[#b45309]">
          {label}
        </span>
      ))}
    </span>
  )
}

function UpcomingRow({ row, analysisDate }: { row: EarningsRow; analysisDate: string | null }) {
  const imminent = row.daysLeft <= 1
  return (
    <li className="grid grid-cols-[3.25rem_minmax(0,1fr)_4.5rem] items-start gap-x-3 py-2 transition-colors hover:bg-[var(--color-surface-subtle)]">
      <div className="pt-px">
        <div className={`font-mono text-[12px] font-bold tabular-nums ${imminent ? 'text-[#b45309]' : 'text-[var(--color-text-primary)]'}`}>
          {daysLeftText(row.daysLeft)}
        </div>
        <div className="font-mono text-[9px] font-semibold tabular-nums text-[var(--color-text-tertiary)]">{row.announce_date.slice(5)}</div>
      </div>
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-1.5">
          <Link href={stockHref(row.ticker)} prefetch={false} className="shrink-0 font-mono text-[12px] font-bold text-[var(--color-brand-800)] hover:underline">
            {row.ticker}
          </Link>
          <Link href={stockHref(row.ticker)} prefetch={false} className="min-w-0 truncate text-[12px] font-semibold text-[var(--color-text-primary)] hover:text-[var(--color-brand-700)]">
            {row.name ?? row.ticker}
          </Link>
          <StockPreviewTrigger ticker={row.ticker} analysisDate={analysisDate} context="home" />
        </div>
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <StageStrip row={row} />
          <SignalLabels row={row} />
        </div>
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] font-semibold text-[var(--color-text-tertiary)]">
          <span>{row.sector17Name ?? '業種未分類'}</span>
          <MarginBadges marginType={row.marginType} creditRatio={row.creditRatio} shortRatio={row.shortRatio} compact />
        </div>
      </div>
      <div className="text-right">
        <div className={`font-mono text-[12px] font-bold tabular-nums ${signedTextClass(row.changePct)}`}>{fmtPct(row.changePct)}</div>
        <div className="mt-0.5 font-mono text-[9px] font-semibold tabular-nums text-[var(--color-text-tertiary)]">出来高 {fmtVolume(row.avgVolume30)}</div>
      </div>
    </li>
  )
}

function CompletedRow({ row, analysisDate }: { row: EarningsRow; analysisDate: string | null }) {
  return (
    <li className="grid grid-cols-[3.25rem_minmax(0,1fr)_4.5rem] items-center gap-x-3 py-2 transition-colors hover:bg-[var(--color-surface-subtle)]">
      <div className="font-mono text-[10px] font-semibold tabular-nums text-[var(--color-text-tertiary)]">
        {row.postEarningsTradingDays == null ? '発表後' : `+${row.postEarningsTradingDays}営業日`}
      </div>
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-1.5">
          <Link href={stockHref(row.ticker)} prefetch={false} className="shrink-0 font-mono text-[12px] font-bold text-[var(--color-brand-800)] hover:underline">
            {row.ticker}
          </Link>
          <Link href={stockHref(row.ticker)} prefetch={false} className="min-w-0 truncate text-[12px] font-semibold text-[var(--color-text-primary)] hover:text-[var(--color-brand-700)]">
            {row.name ?? row.ticker}
          </Link>
          <StockPreviewTrigger ticker={row.ticker} analysisDate={analysisDate} context="home" />
        </div>
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-mono text-[10px] font-semibold tabular-nums text-[var(--color-text-tertiary)]">{row.announce_date} 発表</span>
          <StageStrip row={row} />
        </div>
      </div>
      <div className="text-right">
        <div className={`font-mono text-[12px] font-bold tabular-nums ${signedTextClass(row.postEarningsChangePct)}`}>{fmtPct(row.postEarningsChangePct)}</div>
        <div className="mt-0.5 text-[9px] font-semibold text-[var(--color-text-tertiary)]">発表後</div>
      </div>
    </li>
  )
}

export async function DashboardEarningsAlerts({
  date = null,
  universe = null,
}: {
  date?: string | null
  universe?: UniverseFilterValue
}) {
  const data = await loadDashboardEarningsAlerts(date ?? null, universe ?? null)
  const { upcoming, completed, signalCount } = rankEarningsAlerts(data.rows, data.completedRows)
  const href = earningsHref(data.windowStart ?? date, universe ?? null)

  return (
    <section aria-labelledby="dashboard-earnings-heading" className="min-w-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b-2 border-[var(--color-brand-900)] pb-1.5">
        <h3 id="dashboard-earnings-heading" className="text-[13px] font-bold text-[var(--color-brand-900)]">決算・イベント注意</h3>
        <Link href={href} prefetch={false} className="inline-flex items-center gap-0.5 text-[11px] font-bold text-[var(--color-brand-700)] hover:underline">
          決算ページ
          <ArrowUpRight size={12} aria-hidden="true" />
        </Link>
      </div>
      <dl className="flex flex-wrap gap-x-5 gap-y-1 py-2 text-[10px] font-semibold text-[var(--color-text-tertiary)]">
        <div className="flex items-baseline gap-1.5">
          <dt>表示期間</dt>
          <dd className="font-mono font-bold tabular-nums text-[var(--color-text-primary)]">
            {data.windowStart && data.windowEnd ? `${data.windowStart}〜${data.windowEnd}` : '---'}
          </dd>
        </div>
        <div className="flex items-baseline gap-1.5">
          <dt>注意ラベルあり</dt>
          <dd className={`font-mono font-bold tabular-nums ${signalCount > 0 ? 'text-[#b45309]' : 'text-[var(--color-text-primary)]'}`}>{signalCount.toLocaleString('ja-JP')}件</dd>
        </div>
        <div className="flex items-baseline gap-1.5">
          <dt>予定候補</dt>
          <dd className="font-mono font-bold tabular-nums text-[var(--color-text-primary)]">{upcoming.length.toLocaleString('ja-JP')}件</dd>
        </div>
        <div className="flex items-baseline gap-1.5">
          <dt>発表後フォロー</dt>
          <dd className="font-mono font-bold tabular-nums text-[var(--color-text-primary)]">{completed.length.toLocaleString('ja-JP')}件</dd>
        </div>
      </dl>

      {data.message && (
        <p className="mb-2 border-l-2 border-[var(--color-border-strong)] pl-2 text-[11px] font-semibold leading-relaxed text-[var(--color-text-secondary)]">
          {data.message}
        </p>
      )}

      <div className="grid gap-x-8 gap-y-5 md:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] xl:grid-cols-1 2xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="min-w-0">
          <GroupLabel meta="近い日付 + 注意ラベル + 出来高" className="mb-1">これから注意</GroupLabel>
          <ol className="divide-y divide-[var(--color-border-soft)] border-y border-[var(--color-border-soft)]">
            {upcoming.map((row) => <UpcomingRow key={`upcoming-${row.ticker}-${row.announce_date}`} row={row} analysisDate={date} />)}
            {upcoming.length === 0 && (
              <li className="py-6 text-center text-[12px] font-semibold text-[var(--color-text-tertiary)]">表示対象の決算予定はありません</li>
            )}
          </ol>
        </div>
        <div className="min-w-0">
          <GroupLabel meta="発表後の値動き" className="mb-1">発表後フォロー</GroupLabel>
          <ol className="divide-y divide-[var(--color-border-soft)] border-y border-[var(--color-border-soft)]">
            {completed.map((row) => <CompletedRow key={`completed-${row.ticker}-${row.announce_date}`} row={row} analysisDate={date} />)}
            {completed.length === 0 && (
              <li className="py-6 text-center text-[12px] font-semibold text-[var(--color-text-tertiary)]">発表後フォロー対象はありません</li>
            )}
          </ol>
        </div>
      </div>
    </section>
  )
}
