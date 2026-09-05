import type { Metadata } from 'next'
import { Suspense } from 'react'
import { PeriodExplorerClient } from './PeriodExplorerClient'
import { getPeriodExplorerCalendar } from '@/lib/server/period-explorer-read-model'

export const metadata: Metadata = {
  title: '期間分析 | StockBoard',
  description: '任意期間の値動き、6ステージ、MA、流動性、業種を横断して銘柄を探索します。',
}

export const dynamic = 'force-dynamic'

export default async function PeriodExplorerPage() {
  const dates = await getPeriodExplorerCalendar()
  const defaultTo = dates.at(-1) ?? ''
  const defaultFrom = dates[Math.max(0, dates.length - 20)] ?? defaultTo
  return (
    <Suspense fallback={<div className="h-72 animate-pulse border border-[var(--color-border-default)] bg-white" />}>
      <PeriodExplorerClient calendarDates={dates} defaultFrom={defaultFrom} defaultTo={defaultTo} />
    </Suspense>
  )
}
