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
  const requestedDate = Array.isArray(params.date) ? params.date.join(',') : params.date ?? null
  const asOf = await getUsDashboardAsOfState(requestedDate)

  return (
    <div className="w-full">
      <UsScreenerClient
        initialAsOf={{
          requestedDate: asOf.requestedDate,
          resolvedDate: asOf.resolvedDate,
          earliestDate: asOf.earliestDate,
          latestDate: asOf.latestDate,
          availability: asOf.availability,
          mode: asOf.mode === 'latest' ? 'LATEST' : asOf.mode === 'historical' ? 'HISTORICAL' : null,
        }}
      />
    </div>
  )
}
