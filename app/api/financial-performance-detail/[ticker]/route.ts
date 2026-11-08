import { getFinancialPerformanceDetailReadModel } from '@/lib/server/financial-performance-detail-read-model'
import { fundamentalTickerRoute } from '@/lib/server/fundamental-ticker-route'

export const dynamic = 'force-dynamic'

export const GET = fundamentalTickerRoute({
  label: 'financial-performance-detail',
  load: getFinancialPerformanceDetailReadModel,
  isNotFound: (model) => model.coverage.facts === 0,
  notFoundError: 'performance_detail_not_found',
  unavailableError: 'financial_performance_detail_unavailable',
})
