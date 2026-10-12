export type UsScreenerPitMode = 'LATEST' | 'HISTORICAL'
export type UsScreenerPitAvailability =
  | 'POINT_IN_TIME'
  | 'AS_OF_IMPORT_CUTOFF'
  | 'CURRENT_REFERENCE'
  | 'UNAVAILABLE'

export type UsScreenerPitContract = {
  requestedDate: string | null
  resolvedDate: string
  latestDate: string
  mode: UsScreenerPitMode
  futureLeakageGuard: true
  fields: {
    price: UsScreenerPitAvailability
    stages: UsScreenerPitAvailability
    physicalMetrics: UsScreenerPitAvailability
    universe: UsScreenerPitAvailability
    earnings: UsScreenerPitAvailability
    classification: UsScreenerPitAvailability
    marketCap: UsScreenerPitAvailability
    referenceMetadata: UsScreenerPitAvailability
  }
  limitations: string[]
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export class UsScreenerPitError extends Error {
  constructor(message: string, readonly status: 400 | 422) {
    super(message)
    this.name = 'UsScreenerPitError'
  }
}

export function parseUsScreenerRequestedDate(value: string | null): string | null {
  const normalized = value?.trim() ?? ''
  if (!normalized) return null
  const parsed = new Date(`${normalized}T00:00:00Z`)
  if (
    !ISO_DATE.test(normalized)
    || Number.isNaN(parsed.getTime())
    || parsed.toISOString().slice(0, 10) !== normalized
  ) {
    throw new UsScreenerPitError('date must use YYYY-MM-DD format', 400)
  }
  return normalized
}

export function createUsScreenerPitContract(input: {
  requestedDate: string | null
  resolvedDate: string
  latestDate: string
}): UsScreenerPitContract {
  const mode: UsScreenerPitMode = input.resolvedDate < input.latestDate ? 'HISTORICAL' : 'LATEST'
  const historical = mode === 'HISTORICAL'
  return {
    requestedDate: input.requestedDate,
    resolvedDate: input.resolvedDate,
    latestDate: input.latestDate,
    mode,
    futureLeakageGuard: true,
    fields: {
      price: 'POINT_IN_TIME',
      stages: 'POINT_IN_TIME',
      physicalMetrics: 'POINT_IN_TIME',
      universe: 'POINT_IN_TIME',
      earnings: historical ? 'AS_OF_IMPORT_CUTOFF' : 'CURRENT_REFERENCE',
      classification: historical ? 'UNAVAILABLE' : 'CURRENT_REFERENCE',
      marketCap: historical ? 'UNAVAILABLE' : 'CURRENT_REFERENCE',
      referenceMetadata: 'CURRENT_REFERENCE',
    },
    limitations: historical
      ? [
          'Historical classifications are unavailable until effective-dated coverage exists.',
          'Historical market cap is unavailable until point-in-time shares outstanding exists.',
          'Names, exchanges, and asset types are current reference metadata and are not analytical signals.',
        ]
      : [],
  }
}

export function assertUsScreenerHistoricalFilters(
  contract: UsScreenerPitContract,
  input: {
    sector?: string | null
    industryGroup?: string | null
    industry?: string | null
    exchange?: string | null
    assetType?: string | null
    marketCapMin?: number | null
    marketCapMax?: number | null
    sort?: string | null
  },
): void {
  if (contract.mode !== 'HISTORICAL') return
  if (input.sector || input.industryGroup || input.industry) {
    throw new UsScreenerPitError(
      'Historical US classification filters require effective-dated classification coverage.',
      422,
    )
  }
  if (input.exchange || input.assetType || input.sort === 'exchange') {
    throw new UsScreenerPitError(
      'Historical US exchange and asset-type filters require effective-dated reference metadata.',
      422,
    )
  }
  if (input.marketCapMin != null || input.marketCapMax != null || input.sort === 'marketCap') {
    throw new UsScreenerPitError(
      'Historical US market-cap filters require point-in-time shares outstanding coverage.',
      422,
    )
  }
}
