import {
  execUsAnalyticsAll,
  execUsAnalyticsGet,
  type UsAnalyticsArgs,
} from '@/lib/db/us-analytics'
import type { StageTransitionQueryExecutor } from '@/lib/queries/stage-transition-scanner'

/** Read-only executor for the isolated US analytics database. */
export const usStageTransitionExecutor: StageTransitionQueryExecutor = {
  all: (sql, args = []) => execUsAnalyticsAll(sql, args as UsAnalyticsArgs),
  get: (sql, args = []) => execUsAnalyticsGet(sql, args as UsAnalyticsArgs),
}
