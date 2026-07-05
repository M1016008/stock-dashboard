import Link from 'next/link'
import { Card, CardHeader } from '@/components/ui/Card'
import { MarginBadges } from '@/components/ui/MarginBadges'
import { StageTag } from '@/components/ui/StageTag'
import { type EarningsRow } from '@/lib/queries/dashboard'
import { getDashboardEarningsAlertsCached } from '@/lib/queries/dashboard-earnings-alerts-cache'
import type { UniverseFilterValue } from '@/lib/market-universe'

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

function earningsHref(date: string | null | undefined, universe: UniverseFilterValue): string {
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
    <div className="flex items-center gap-0.5 whitespace-nowrap">
      {stages.map((stage, index) => (
        <StageTag key={`${row.ticker}-${index}-${stage ?? 'x'}`} stage={stage} size="xs" />
      ))}
    </div>
  )
}

function SignalChips({ row }: { row: EarningsRow }) {
  const labels = row.signalLabels?.slice(0, 3) ?? []
  if (labels.length === 0) {
    return <span className="text-[10px] font-bold text-[var(--color-text-tertiary)]">通常監視</span>
  }
  return (
    <div className="flex flex-wrap gap-1">
      {labels.map((label) => (
        <span
          key={`${row.ticker}-${label}`}
          className="rounded-full border border-[rgba(217,119,6,0.24)] bg-[#fff7ed] px-1.5 py-0.5 text-[9px] font-black text-[#b45309]"
        >
          {label}
        </span>
      ))}
    </div>
  )
}

function UpcomingRow({ row }: { row: EarningsRow }) {
  const daysText = row.daysLeft <= 0 ? '当日' : `${row.daysLeft}日後`
  return (
    <Link
      href={stockHref(row.ticker)}
      prefetch={false}
      className="grid grid-cols-[54px_minmax(0,1fr)_auto] items-center gap-2 px-3 py-2.5 hover:bg-[var(--color-surface-subtle)]"
    >
      <div>
        <div className="font-mono text-[12px] font-black text-[var(--color-brand-800)]">{row.ticker}</div>
        <div className="mt-0.5 rounded-full bg-[var(--color-surface-subtle)] px-1.5 py-0.5 text-center text-[9px] font-black text-[var(--color-text-secondary)]">
          {daysText}
        </div>
      </div>
      <div className="min-w-0">
        <div className="truncate text-[12px] font-black text-[var(--color-text-primary)]">{row.name ?? row.ticker}</div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] font-bold text-[var(--color-text-tertiary)]">
          <span>{row.announce_date}</span>
          <span>{row.sector17Name ?? '業種未分類'}</span>
          <MarginBadges marginType={row.marginType} creditRatio={row.creditRatio} shortRatio={row.shortRatio} compact />
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <SignalChips row={row} />
          <StageStrip row={row} />
        </div>
      </div>
      <div className="text-right">
        <div className={`font-mono text-[12px] font-black ${(row.changePct ?? 0) >= 0 ? 'text-[var(--color-price-up)]' : 'text-[var(--color-price-down)]'}`}>
          {fmtPct(row.changePct)}
        </div>
        <div className="mt-0.5 text-[9px] font-bold text-[var(--color-text-tertiary)]">出来高 {fmtVolume(row.avgVolume30)}</div>
      </div>
    </Link>
  )
}

function CompletedRow({ row }: { row: EarningsRow }) {
  return (
    <Link
      href={stockHref(row.ticker)}
      prefetch={false}
      className="grid grid-cols-[54px_minmax(0,1fr)_auto] items-center gap-2 px-3 py-2.5 hover:bg-[var(--color-surface-subtle)]"
    >
      <div className="font-mono text-[12px] font-black text-[var(--color-brand-800)]">{row.ticker}</div>
      <div className="min-w-0">
        <div className="truncate text-[12px] font-black text-[var(--color-text-primary)]">{row.name ?? row.ticker}</div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] font-bold text-[var(--color-text-tertiary)]">
          <span>{row.announce_date}</span>
          <span>{row.postEarningsTradingDays == null ? '発表後' : `発表後${row.postEarningsTradingDays}営業日`}</span>
          <StageStrip row={row} />
        </div>
      </div>
      <div className="text-right">
        <div className={`font-mono text-[12px] font-black ${(row.postEarningsChangePct ?? 0) >= 0 ? 'text-[var(--color-price-up)]' : 'text-[var(--color-price-down)]'}`}>
          {fmtPct(row.postEarningsChangePct)}
        </div>
        <div className="mt-0.5 text-[9px] font-bold text-[var(--color-text-tertiary)]">発表後</div>
      </div>
    </Link>
  )
}

export async function DashboardEarningsAlerts({
  date = null,
  universe = null,
}: {
  date?: string | null
  universe?: UniverseFilterValue
}) {
  const data = await getDashboardEarningsAlertsCached(date, universe)
  const upcoming = [...data.rows].sort((a, b) => alertScore(b) - alertScore(a)).slice(0, 8)
  const completed = [...data.completedRows].sort((a, b) => completedScore(b) - completedScore(a)).slice(0, 5)
  const signalCount = upcoming.filter((row) => (row.signalLabels?.length ?? 0) > 0).length
  const href = earningsHref(data.windowStart ?? date, universe)

  return (
    <Card size="lg" className="p-0">
      <CardHeader
        title="決算・イベント注意銘柄"
        hint="決算予定、出来高、6ステージ、ML/シグナルラベルをまとめて確認します。"
        action={
          <Link href={href} prefetch={false} className="rounded-full border border-current/25 bg-white px-2.5 py-1 text-[10px] font-black hover:bg-[var(--color-surface-subtle)]">
            決算ページ
          </Link>
        }
      />
      <div className="px-4 pb-4">
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <MetricTile label="表示期間" value={data.windowStart && data.windowEnd ? `${data.windowStart}〜${data.windowEnd}` : '---'} />
          <MetricTile label="注意ラベルあり" value={`${signalCount.toLocaleString('ja-JP')}件`} />
          <MetricTile label="予定候補" value={`${upcoming.length.toLocaleString('ja-JP')}件`} />
          <MetricTile label="発表後フォロー" value={`${completed.length.toLocaleString('ja-JP')}件`} />
        </div>

        {data.message && (
          <p className="mt-3 rounded-[6px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-3 py-2 text-[11px] font-semibold leading-relaxed text-[var(--color-text-secondary)]">
            {data.message}
          </p>
        )}

        <div className="mt-3 grid gap-3 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)]">
          <div className="overflow-hidden rounded-[8px] border border-[var(--color-border-soft)] bg-white">
            <div className="flex items-baseline justify-between border-b border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-3 py-2">
              <div className="text-[12px] font-black text-[var(--color-brand-900)]">これから注意</div>
              <div className="text-[10px] font-bold text-[var(--color-text-tertiary)]">近い日付 + 注意ラベル + 出来高</div>
            </div>
            <div className="divide-y divide-[var(--color-border-soft)]">
              {upcoming.map((row) => <UpcomingRow key={`upcoming-${row.ticker}-${row.announce_date}`} row={row} />)}
              {upcoming.length === 0 && (
                <div className="px-3 py-8 text-center text-[12px] font-bold text-[var(--color-text-tertiary)]">表示対象の決算予定はありません</div>
              )}
            </div>
          </div>
          <div className="overflow-hidden rounded-[8px] border border-[var(--color-border-soft)] bg-white">
            <div className="flex items-baseline justify-between border-b border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-3 py-2">
              <div className="text-[12px] font-black text-[var(--color-brand-900)]">発表後フォロー</div>
              <div className="text-[10px] font-bold text-[var(--color-text-tertiary)]">発表後の値動き</div>
            </div>
            <div className="divide-y divide-[var(--color-border-soft)]">
              {completed.map((row) => <CompletedRow key={`completed-${row.ticker}-${row.announce_date}`} row={row} />)}
              {completed.length === 0 && (
                <div className="px-3 py-8 text-center text-[12px] font-bold text-[var(--color-text-tertiary)]">発表後フォロー対象はありません</div>
              )}
            </div>
          </div>
        </div>
      </div>
    </Card>
  )
}

function MetricTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[8px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-3 py-2">
      <div className="text-[10px] font-black text-[var(--color-text-tertiary)]">{label}</div>
      <div className="mt-1 truncate font-mono text-[13px] font-black text-[var(--color-text-primary)]">{value}</div>
    </div>
  )
}
