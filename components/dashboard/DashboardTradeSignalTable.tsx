import { cache } from 'react'
import { DashboardTradeSignalTableClient } from '@/components/dashboard/DashboardTradeSignalTableClient'
import { getDashboardTradeSignals } from '@/lib/queries/dashboard-trade-signals'
import type { UniverseFilterValue } from '@/lib/market-universe'

/**
 * 売買候補の取得を 1 リクエスト内で共有する (Hero の件数表示と一覧が同じ結果を使う)。
 * 引数をプリミティブに分けて React cache のキーを安定させる。取得内容は従来どおり。
 */
export const loadDashboardTradeSignals = cache(
  (date: string | null, universe: UniverseFilterValue, scenarioInterval: string | null) =>
    getDashboardTradeSignals({ date, universe, scenarioInterval }),
)

export async function DashboardTradeSignalTable({
  date = null,
  universe = null,
  scenarioInterval = null,
}: {
  date?: string | null
  universe?: UniverseFilterValue
  scenarioInterval?: string | null
}) {
  const data = await loadDashboardTradeSignals(date ?? null, universe ?? null, scenarioInterval ?? null)
  return <DashboardTradeSignalTableClient data={data} />
}
