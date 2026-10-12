import type { Metadata } from 'next'
import { getUsDashboardAsOfState } from '@/lib/queries/dashboard-as-of'
import { UsScreenerClient } from './UsScreenerClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export const metadata: Metadata = {
  title: 'USスクリーナー — StockBoard',
  description: '米国株のステージ、移動平均、価格変化を条件で絞り込みます。',
}

export default async function UsScreenerPage({
  searchParams,
}: {
  searchParams?: Promise<{ date?: string | string[] }>
}) {
  const params = searchParams ? await searchParams : {}
  const requestedDate = typeof params.date === 'string' ? params.date : null
  const asOf = await getUsDashboardAsOfState(requestedDate)

  return (
    <div className="w-full">
      <UsScreenerClient
        initialAsOf={{
          requestedDate: asOf.requestedDate,
          resolvedDate: asOf.resolvedDate,
          latestDate: asOf.latestDate,
          mode: asOf.mode === 'latest' ? 'LATEST' : asOf.mode === 'historical' ? 'HISTORICAL' : null,
        }}
      />
    </div>
  )
}
