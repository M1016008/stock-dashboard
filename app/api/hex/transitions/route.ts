import { NextRequest } from 'next/server'
import { parseUniverseFilter } from '@/lib/market-universe'
import {
  getStageTransitionFilterOptions,
  searchStageTransitions,
} from '@/lib/queries/stage-transition-scanner'
import { stageTransitionRouteResponse } from '@/lib/server/stage-transition-route'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function GET(request: NextRequest) {
  return stageTransitionRouteResponse(request, {
    universeFilter: (params) => parseUniverseFilter(params.get('universe')),
    load: (input) => Promise.all([
      searchStageTransitions(input),
      getStageTransitionFilterOptions(),
    ]),
    meta: {
      source: 'daily_snapshots + ohlcv_daily + ticker_universe',
      pit: true,
      classificationBasis: 'CURRENT_TICKER_UNIVERSE',
    },
    logLabel: 'Stage transition scanner',
    failure: { error: 'stage_transition_search_failed', message: '遷移銘柄の検索に失敗しました。' },
  })
}
