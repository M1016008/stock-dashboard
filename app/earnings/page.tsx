import type { Metadata } from 'next'
import { Suspense } from 'react'
import { EarningsCalendarPanel } from '@/components/earnings/EarningsCalendarPanel'
import { EarningsDateCalendar } from '@/components/earnings/EarningsDateCalendar'
import { PageTitle } from '@/components/layout/PageTitle'
import { getEarningsDateCounts } from '@/lib/queries/earnings-calendar'
import { getLatestDate } from '@/lib/queries/dashboard'

export const metadata: Metadata = {
  title: '決算 — StockBoard',
  description: '決算発表予定・発表後の値動き・テクニカルシグナルを確認',
}

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

function EarningsFallback() {
  return (
    <div className="rounded-[8px] border border-[var(--color-border-soft)] bg-[var(--color-surface-raised)] px-4 py-10 text-center text-[13px] font-bold text-[var(--color-text-tertiary)]">
      決算データを読込中...
    </div>
  )
}

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value
}

function isIsoDate(value: string | undefined): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

function isMonth(value: string | undefined): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}$/.test(value)
}

export default async function EarningsPage({
  searchParams,
}: {
  searchParams?: Promise<{ date?: string | string[]; month?: string | string[] }>
}) {
  const sp = searchParams ? await searchParams : {}
  const requestedDate = firstParam(sp.date)
  const requestedMonth = firstParam(sp.month)
  const selectedDate = isIsoDate(requestedDate) ? requestedDate : null
  const displayMonth = isMonth(requestedMonth) ? requestedMonth : null
  const [latest, counts] = await Promise.all([
    getLatestDate(),
    getEarningsDateCounts(),
  ])
  const panelDate = selectedDate ?? latest
  const subtitle = panelDate
    ? `${panelDate} 基準 / 決算発表予定・発表後2週間の値動き`
    : 'データ未取り込み'

  return (
    <div className="mx-auto flex w-full max-w-[1420px] flex-col gap-5">
      <PageTitle
        title="決算"
        subtitle={subtitle}
        badge="JPX公式 + J-Quants"
      />
      <EarningsDateCalendar
        counts={counts}
        selectedDate={selectedDate}
        displayMonth={displayMonth}
        latestDate={latest}
      />
      <Suspense fallback={<EarningsFallback />}>
        <EarningsCalendarPanel date={panelDate} preferLatestImport={!selectedDate} />
      </Suspense>
    </div>
  )
}
