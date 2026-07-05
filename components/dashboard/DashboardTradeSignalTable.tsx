import { DashboardTradeSignalTableClient } from '@/components/dashboard/DashboardTradeSignalTableClient'
import { getDashboardTradeSignals } from '@/lib/queries/dashboard-trade-signals'
import type { UniverseFilterValue } from '@/lib/market-universe'

export async function DashboardTradeSignalTable({
  date = null,
  universe = null,
}: {
  date?: string | null
  universe?: UniverseFilterValue
}) {
  const data = await getDashboardTradeSignals({ date, universe })
  return <DashboardTradeSignalTableClient data={data} />
}
