import type { Metadata } from 'next'
import Link from 'next/link'
import { CalendarDays } from 'lucide-react'
import { PageTitle } from '@/components/layout/PageTitle'
import { Card } from '@/components/ui/Card'
import {
  addCalendarDays,
  getUsEarningsCalendar,
  isUsEarningsDate,
  todayInNewYork,
  type UsEarningsTimeBucket,
} from '@/lib/queries/us-earnings'

export const metadata: Metadata = {
  title: 'US決算カレンダー — StockBoard',
  description: '正式ソースで同期した米国株の決算予定を確認',
}

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

const BUCKET_LABELS: Record<UsEarningsTimeBucket, string> = {
  before_open: '寄付前',
  market_hours: '取引時間中',
  after_close: '引け後',
  unknown: '時刻不明',
}

function first(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null
}

function money(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

function number(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return value.toLocaleString('en-US', { maximumFractionDigits: 3 })
}

export default async function UsEarningsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = searchParams ? await searchParams : {}
  const today = todayInNewYork()
  const fromParam = first(params.from)
  const toParam = first(params.to)
  const from = isUsEarningsDate(fromParam) ? fromParam : today
  const to = isUsEarningsDate(toParam) && toParam >= from ? toParam : addCalendarDays(from, 30)
  const query = first(params.q)?.trim() ?? ''
  const bucketParam = first(params.timeBucket)
  const bucket = bucketParam && bucketParam in BUCKET_LABELS
    ? bucketParam as UsEarningsTimeBucket
    : null
  const result = await getUsEarningsCalendar({ from, to, query, timeBucket: bucket, limit: 300 })

  return (
    <div className="flex w-full flex-col gap-5">
      <PageTitle
        eyebrow="US市場・イベント"
        title="US決算カレンダー"
        subtitle="Finnhubから正式に同期された予定だけを表示します。未同期期間を推定日で補完しません。"
        meta={
          <>
            <span>{from} - {to}</span>
            <span>{result.total.toLocaleString('ja-JP')}件</span>
            <span>出典 Finnhub</span>
          </>
        }
      />

      <Card size="lg">
        <form className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1.4fr_1fr_auto]" method="get">
          <label className="grid gap-1 text-[11px] font-bold text-[var(--color-text-secondary)]">
            開始日
            <input className="h-10 rounded-[4px] border border-[var(--color-border-default)] px-3 text-[13px]" type="date" name="from" defaultValue={from} />
          </label>
          <label className="grid gap-1 text-[11px] font-bold text-[var(--color-text-secondary)]">
            終了日
            <input className="h-10 rounded-[4px] border border-[var(--color-border-default)] px-3 text-[13px]" type="date" name="to" defaultValue={to} />
          </label>
          <label className="grid gap-1 text-[11px] font-bold text-[var(--color-text-secondary)]">
            銘柄・社名
            <input className="h-10 rounded-[4px] border border-[var(--color-border-default)] px-3 text-[13px]" name="q" defaultValue={query} placeholder="AAPL / Apple" />
          </label>
          <label className="grid gap-1 text-[11px] font-bold text-[var(--color-text-secondary)]">
            発表時間
            <select className="h-10 rounded-[4px] border border-[var(--color-border-default)] px-3 text-[13px]" name="timeBucket" defaultValue={bucket ?? ''}>
              <option value="">すべて</option>
              {Object.entries(BUCKET_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <button className="h-10 self-end rounded-[4px] bg-[var(--color-brand-900)] px-4 text-[13px] font-black text-white" type="submit">表示</button>
        </form>
      </Card>

      <div className="rounded-[4px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-3 py-2 text-[11px] font-semibold text-[var(--color-text-secondary)]">
        Coverage {result.coverage.from ?? '-'} - {result.coverage.to ?? '-'} / 最終同期 {result.coverage.latestImportedAt ?? '-'} / 予想EPS・売上は提供元の値で、StockBoardによる予測ではありません。
      </div>

      {result.rows.length === 0 ? (
        <div className="empty-state" role="status">
          <CalendarDays size={24} aria-hidden="true" />
          <p className="empty-state__title">決算予定を表示できません</p>
          <p className="empty-state__desc">{result.message}</p>
        </div>
      ) : (
        <Card size="lg" className="overflow-hidden p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-[12px]">
              <thead className="bg-[var(--color-surface-subtle)] text-[11px] text-[var(--color-text-tertiary)]">
                <tr>
                  <th className="px-3 py-2 text-left">日付</th><th className="px-3 py-2 text-left">銘柄</th>
                  <th className="px-3 py-2 text-left">時間</th><th className="px-3 py-2 text-right">FY/Q</th>
                  <th className="px-3 py-2 text-right">EPS予想</th><th className="px-3 py-2 text-right">EPS実績</th>
                  <th className="px-3 py-2 text-right">売上予想</th><th className="px-3 py-2 text-right">売上実績</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row) => (
                  <tr key={`${row.ticker}-${row.reportDate}`} className="border-t border-[var(--color-border-soft)]">
                    <td className="px-3 py-2 tabular-nums">{row.reportDate}</td>
                    <td className="px-3 py-2"><Link className="font-black text-[var(--color-brand-900)]" href={`/us/stock/${encodeURIComponent(row.ticker)}`}>{row.ticker}</Link><div className="max-w-[220px] truncate text-[11px] text-[var(--color-text-tertiary)]">{row.name ?? '-'}</div></td>
                    <td className="px-3 py-2">{BUCKET_LABELS[row.timeBucket]}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{row.fiscalYear ?? '-'} / {row.fiscalQuarter ? `Q${row.fiscalQuarter}` : '-'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{number(row.epsEstimate)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{number(row.epsActual)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{money(row.revenueEstimate)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{money(row.revenueActual)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  )
}
