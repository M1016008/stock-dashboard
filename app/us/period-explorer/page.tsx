import type { Metadata } from 'next'
import { Suspense } from 'react'
import { PeriodExplorerClient } from '@/app/period-explorer/PeriodExplorerClient'
import { PageLoadingSkeleton } from '@/components/ui/PageLoadingSkeleton'
import { getPeriodExplorerCalendar } from '@/lib/server/period-explorer-read-model'

export const metadata: Metadata = {
  title: 'US期間ランキング | StockBoard',
  description: '任意期間の値動き、6ステージ、MA、流動性、SEC分類を横断して米国株を探索します。',
}

export const dynamic = 'force-dynamic'

export default async function UsPeriodExplorerPage() {
  const dates = await getPeriodExplorerCalendar('US')
  const defaultTo = dates.at(-1) ?? ''
  const defaultFrom = dates[Math.max(0, dates.length - 20)] ?? defaultTo
  return (
    <Suspense fallback={<PageLoadingSkeleton title="US期間ランキングを読み込んでいます" sections={2} />}>
      <PeriodExplorerClient market="US" calendarDates={dates} defaultFrom={defaultFrom} defaultTo={defaultTo} />
    </Suspense>
  )
}
