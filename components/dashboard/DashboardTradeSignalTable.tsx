import { cache } from 'react'
import { DashboardTradeSignalTableClient } from '@/components/dashboard/DashboardTradeSignalTableClient'
import { getDashboardTradeSignals } from '@/lib/queries/dashboard-trade-signals'
import type { DashboardTradeSignalMarket } from '@/lib/queries/dashboard-trade-signals'
import type { UniverseFilterValue } from '@/lib/market-universe'

/**
 * 売買候補の取得を 1 リクエスト内で共有する (Hero の件数表示と一覧が同じ結果を使う)。
 * 引数をプリミティブに分けて React cache のキーを安定させる。取得内容は従来どおり。
 */
export const loadDashboardTradeSignals = cache(
  (
    date: string | null,
    universe: UniverseFilterValue,
    scenarioInterval: string | null,
    market: DashboardTradeSignalMarket | 'ALL' = 'ALL',
  ) => getDashboardTradeSignals({ date, universe, scenarioInterval, market }),
)

export async function DashboardTradeSignalTable({
  date = null,
  universe = null,
  scenarioInterval = null,
  market = 'ALL',
}: {
  date?: string | null
  universe?: UniverseFilterValue
  scenarioInterval?: string | null
  market?: DashboardTradeSignalMarket | 'ALL'
}) {
  const data = await loadDashboardTradeSignals(date ?? null, universe ?? null, scenarioInterval ?? null, market)
  return (
    <DashboardTradeSignalTableClient
      data={data}
      usHistorical={market === 'US' && date != null}
      previewAnalysisDate={market === 'US' ? date : undefined}
    />
  )
}
