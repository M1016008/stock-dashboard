import { getFinancialPerformanceTimelineReadModel } from '@/lib/server/financial-performance-timeline-read-model'
import { fundamentalTickerRoute } from '@/lib/server/fundamental-ticker-route'

export const dynamic = 'force-dynamic'

export const GET = fundamentalTickerRoute({
  label: 'financial-performance-timeline',
  load: getFinancialPerformanceTimelineReadModel,
  isNotFound: (model) => model.coverage.facts === 0,
  notFoundError: 'timeline_not_found',
  unavailableError: 'financial_performance_timeline_unavailable',
})
