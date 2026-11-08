import { NextRequest } from 'next/server'
import {
  StageTransitionInputError,
  getStageTransitionFilterOptions,
  searchStageTransitions,
} from '@/lib/queries/stage-transition-scanner'
import { stageTransitionRouteResponse } from '@/lib/server/stage-transition-route'
import { usStageTransitionExecutor } from '@/lib/server/us-stage-transition-scanner'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function GET(request: NextRequest) {
  return stageTransitionRouteResponse(request, {
    universeFilter: () => null,
    load: async (input) => {
      if (input.period !== 'today' && (input.industry33 || input.marketSegment)) {
        throw new StageTransitionInputError(
          'historical_classification_filter_unavailable',
          'Industry / Exchange は現在情報のため、本日以外の遷移検索には使用できません。',
        )
      }
      return Promise.all([
        searchStageTransitions(input, usStageTransitionExecutor, { requireActiveTicker: false }),
        getStageTransitionFilterOptions(usStageTransitionExecutor),
      ])
    },
    meta: {
      source: 'US daily_snapshots + ohlcv_daily + ticker_universe',
      market: 'US',
      pit: true,
      classificationBasis: 'CURRENT_US_TICKER_UNIVERSE',
      classificationFilterAvailability: 'CURRENT_DATE_ONLY',
    },
    logLabel: 'US stage transition scanner',
    failure: { error: 'us_stage_transition_search_failed', message: 'US遷移銘柄の検索に失敗しました。' },
  })
}
