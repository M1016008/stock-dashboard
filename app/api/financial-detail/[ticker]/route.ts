import { getFinancialDetailReadModel } from '@/lib/server/financial-detail-read-model'
import { fundamentalTickerRoute } from '@/lib/server/fundamental-ticker-route'

export const dynamic = 'force-dynamic'

export const GET = fundamentalTickerRoute({
  label: 'financial-detail',
  load: getFinancialDetailReadModel,
  isNotFound: (model) => model.coverage.facts === 0,
  notFoundError: 'financial_detail_not_found',
  unavailableError: 'financial_detail_unavailable',
})
