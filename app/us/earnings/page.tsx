import type { Metadata } from 'next'
import Link from 'next/link'
import { CalendarDays } from 'lucide-react'
import { PageTitle } from '@/components/layout/PageTitle'
import { Card } from '@/components/ui/Card'
import { Notice } from '@/components/ui/EmptyState'
import {
  addCalendarDays,
  getUsEarningsCalendar,
  isUsEarningsDate,
  todayInNewYork,
  type UsEarningsScheduleStatus,
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

const SCHEDULE_STATUS: Record<UsEarningsScheduleStatus, { label: string; title: string; className: string }> = {
  reported: {
    label: '実績あり',
    title: '提供元に報告済みのEPS・売上実績があります。',
    className: 'border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] text-[var(--color-text-secondary)]',
  },
  provider_scheduled_unverified: {
    label: '予定日（未確認）',
    title: '提供元の予定日です。企業発表による確認状態は不明で、実績は未報告です。',
    className: 'border-amber-300 bg-amber-50 text-amber-900',
  },
}

function single(value: string | string[] | undefined): { valid: boolean; value: string | null } {
  return Array.isArray(value)
    ? { valid: false, value: null }
    : { valid: true, value: value ?? null }
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
  const fromParam = single(params.from)
  const toParam = single(params.to)
  const queryParam = single(params.q)
  const bucketParam = single(params.timeBucket)
  const normalizedBucket = bucketParam.value === '' ? null : bucketParam.value
  const from = isUsEarningsDate(fromParam.value) ? fromParam.value : today
  const to = isUsEarningsDate(toParam.value) ? toParam.value : addCalendarDays(from, 30)
  const query = queryParam.value?.trim() ?? ''
  const bucket = normalizedBucket && normalizedBucket in BUCKET_LABELS
    ? normalizedBucket as UsEarningsTimeBucket
    : null
  const invalidQuery = !fromParam.valid
    || !toParam.valid
    || !queryParam.valid
    || !bucketParam.valid
    || (fromParam.value != null && !isUsEarningsDate(fromParam.value))
    || (toParam.value != null && !isUsEarningsDate(toParam.value))
    || (normalizedBucket != null && !(normalizedBucket in BUCKET_LABELS))
    || from > to
  const result = invalidQuery
    ? null
    : await getUsEarningsCalendar({ from, to, query, timeBucket: bucket, limit: 300 })

  return (
    <div className="flex w-full flex-col gap-5">
      <PageTitle
        eyebrow="US市場・イベント"
        title="US決算カレンダー"
        subtitle="Finnhubから正式に同期された予定だけを表示します。未同期期間を推定日で補完しません。"
        meta={
          <>
            <span>{from} - {to}</span>
            <span>{result ? `${result.total.toLocaleString('ja-JP')}件` : '入力エラー'}</span>
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
          <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-1">
            <button className="btn h-10" data-variant="primary" type="submit">表示</button>
            {(invalidQuery || fromParam.value || toParam.value || query || bucket) && <Link className="btn h-10" href="/us/earnings" prefetch={false}>条件をクリア</Link>}
          </div>
        </form>
      </Card>

      {invalidQuery && (
        <Notice role="alert" tone="error" title="クエリを読み取れません">
          開始日・終了日は実在する日付を1つずつ指定し、開始日を終了日以前にしてください。発表時間も一覧の値だけを受け付けます。
        </Notice>
      )}

      {result && (
        <div className="rounded-[4px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-3 py-2 text-[11px] font-semibold text-[var(--color-text-secondary)]">
          Coverage {result.coverage.from ?? '-'} - {result.coverage.to ?? '-'} / 最終同期 {result.coverage.latestImportedAt ?? '-'} / 予想EPS・売上は提供元の値で、StockBoardによる予測ではありません。「予定日（未確認）」は提供元の予定日で、企業発表による確認状態は不明です。実績は報告済みの行のみ表示します。
        </div>
      )}

      {result?.status === 'unavailable' ? (
        <Notice role="alert" tone="error" title="決算予定を利用できません">
          {result.message}
        </Notice>
      ) : result && result.rows.length === 0 ? (
        <div className="empty-state" role="status">
          <CalendarDays size={24} aria-hidden="true" />
          <p className="empty-state__title">決算予定を表示できません（該当なし）</p>
          <p className="empty-state__desc">{result.message}</p>
        </div>
      ) : result?.status === 'ok' ? (
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
                    <td className="px-3 py-2 tabular-nums">
                      {row.reportDate}
                      <div>
                        <span
                          className={`mt-0.5 inline-block whitespace-nowrap rounded-[4px] border px-1.5 py-px text-[10px] font-bold ${SCHEDULE_STATUS[row.scheduleStatus].className}`}
                          title={SCHEDULE_STATUS[row.scheduleStatus].title}
                          data-schedule-status={row.scheduleStatus}
                        >
                          {SCHEDULE_STATUS[row.scheduleStatus].label}
                        </span>
                      </div>
                    </td>
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
      ) : null}
    </div>
  )
}
