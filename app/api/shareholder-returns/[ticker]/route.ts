import { getShareholderReturnsReadModel } from '@/lib/server/shareholder-returns-read-model'
import { fundamentalTickerRoute } from '@/lib/server/fundamental-ticker-route'

export const dynamic = 'force-dynamic'

export const GET = fundamentalTickerRoute({
  label: 'shareholder-returns',
  load: getShareholderReturnsReadModel,
  isNotFound: (model) => model.coverage.facts === 0 && !model.priceDate,
  notFoundError: 'shareholder_returns_not_found',
  unavailableError: 'shareholder_returns_unavailable',
})
