import { getValuationDetailReadModel } from '@/lib/server/valuation-detail-read-model'
import { fundamentalTickerRoute } from '@/lib/server/fundamental-ticker-route'

export const dynamic = 'force-dynamic'

export const GET = fundamentalTickerRoute({
  label: 'valuation-detail',
  load: getValuationDetailReadModel,
  isNotFound: (model) => !model.classification.name && model.coverage.priceObservations === 0,
  notFoundError: 'valuation_detail_not_found',
  unavailableError: 'valuation_detail_unavailable',
})
