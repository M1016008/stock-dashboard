import { getFinancialOverviewReadModel } from '@/lib/server/financial-overview-read-model'
import { fundamentalTickerRoute } from '@/lib/server/fundamental-ticker-route'

export const dynamic = 'force-dynamic'

export const GET = fundamentalTickerRoute({
  label: 'financial-overview',
  load: getFinancialOverviewReadModel,
  isNotFound: (model) => !model.classification.name && model.coverage.facts === 0,
  notFoundError: 'ticker_not_found',
  unavailableError: 'financial_overview_unavailable',
})
