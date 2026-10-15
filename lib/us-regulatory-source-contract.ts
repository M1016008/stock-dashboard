export const US_REGULATORY_SOURCE_CONTRACT_VERSION = 'us-regulatory-source-v1' as const

export type UsRegulatorySourceStatus =
  | 'READY'
  | 'BLOCKED_OPERATOR_CONTACT'
  | 'BLOCKED_IDENTIFIER_MAPPING'
  | 'BLOCKED_LICENSE'

export const US_OWNERSHIP_SOURCE_CONTRACT = {
  institutionalManagerPositions: {
    source: 'SEC_FORM_13F',
    cadence: 'QUARTERLY',
    ownershipMeaning: 'MANAGER_REPORTED_POSITIONS',
    pointInTimeBoundary: 'SEC_ACCEPTANCE_TIMESTAMP',
    issuerIdentifier: 'CUSIP',
    status: 'BLOCKED_IDENTIFIER_MAPPING',
  },
  significantBeneficialOwners: {
    source: 'SEC_SCHEDULE_13D_G_XML',
    cadence: 'EVENT_DRIVEN',
    ownershipMeaning: 'BENEFICIAL_OWNERSHIP_OVER_REPORTING_THRESHOLD',
    pointInTimeBoundary: 'SEC_ACCEPTANCE_TIMESTAMP',
    issuerIdentifier: 'CIK',
    status: 'BLOCKED_OPERATOR_CONTACT',
  },
} as const satisfies Record<string, {
  source: string
  cadence: string
  ownershipMeaning: string
  pointInTimeBoundary: string
  issuerIdentifier: string
  status: UsRegulatorySourceStatus
}>

export const US_SHORT_INTEREST_SOURCE_CONTRACT = {
  metric: 'EXCHANGE_REPORTED_SHORT_INTEREST',
  cadence: 'TWICE_MONTHLY',
  pointInTimeBoundary: 'PUBLICATION_TIMESTAMP',
  acceptedSources: ['NASDAQ_CONSOLIDATED_SHORT_INTEREST', 'NYSE_SHORT_INTEREST'] as const,
  status: 'BLOCKED_LICENSE',
  exclusions: {
    finraPublicApi: 'OTC_ONLY_NOT_CURRENT_UNIVERSE',
    dailyShortSaleVolume: 'DIFFERENT_METRIC_NOT_SHORT_INTEREST',
  },
} as const

function sourceIsReady(status: UsRegulatorySourceStatus): boolean {
  return status === 'READY'
}

export function canPublishUsInstitutionalOwnership(): boolean {
  return Object.values(US_OWNERSHIP_SOURCE_CONTRACT).every((source) => sourceIsReady(source.status))
}

export function canPublishUsShortInterest(): boolean {
  return sourceIsReady(US_SHORT_INTEREST_SOURCE_CONTRACT.status)
}
