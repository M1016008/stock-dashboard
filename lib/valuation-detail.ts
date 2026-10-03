import type { MetricDefinition, FinancialMetricKey } from '@/lib/financial-metrics'

export const VALUATION_HISTORY_METRICS = [
  'forward_per',
  'per',
  'pbr',
  'psr',
  'fcf_yield',
  'ev_ebitda',
] as const satisfies readonly FinancialMetricKey[]

export const VALUATION_PEER_METRICS = [
  'forward_per',
  'pbr',
  'fcf_yield',
  'roe',
  'revenue_growth',
  'ev_ebitda',
] as const satisfies readonly FinancialMetricKey[]

export const VALUATION_CURRENT_METRICS = [
  'forward_per',
  'pbr',
  'fcf_yield',
  'dividend_yield',
  'per',
  'psr',
  'ev_ebitda',
  'net_debt',
] as const satisfies readonly FinancialMetricKey[]

export type ValuationHistoryMetric = typeof VALUATION_HISTORY_METRICS[number]
export type ValuationPeerMetric = typeof VALUATION_PEER_METRICS[number]
export type ValuationCurrentMetric = typeof VALUATION_CURRENT_METRICS[number]
export type ValuationAvailability = 'available' | 'missing' | 'not_applicable' | 'not_meaningful'
export type ValuationHistoryWindow = '3y' | '5y' | '10y'

export interface ValuationValue {
  metric: FinancialMetricKey
  label: string
  value: number | null
  unit: string | null
  availability: ValuationAvailability
  reason: string | null
  periodEnd: string | null
  definitionVersion: string
  inputFactIds: string[]
  forecastSnapshotId: string | null
  flags: Array<'negative_fcf' | 'financial_sector' | 'non_positive_ev' | 'non_positive_ebitda' | 'financial_composite_caution'>
}

export interface ValuationHistoryPoint {
  date: string
  price: number
  metric: ValuationHistoryMetric
  value: number
  inputFactIds: string[]
  forecastSnapshotId: string | null
  definitionVersion: string
}

export interface ValuationRangeStatistics {
  window: ValuationHistoryWindow
  observationCount: number
  observationStartDate: string | null
  observationEndDate: string | null
  fullWindow: boolean
  current: number | null
  median: number | null
  minimum: number | null
  maximum: number | null
  displayMinimum: number | null
  displayMaximum: number | null
  percentile: number | null
  versusMedianPercent: number | null
}

export interface ValuationMetricHistory {
  metric: ValuationHistoryMetric
  label: string
  unit: string
  current: ValuationValue
  points: ValuationHistoryPoint[]
  statistics: Record<ValuationHistoryWindow, ValuationRangeStatistics>
  sampling: 'month_end_and_latest'
  note: string | null
}

export interface ValuationPeerMetricComparison {
  metric: ValuationPeerMetric
  label: string
  unit: string
  target: ValuationValue
  median: number | null
  percentile25: number | null
  percentile75: number | null
  targetPercentile: number | null
  versusMedianPercent: number | null
  validCount: number
  peerCount: number
  coveragePercent: number
  displayable: boolean
  reason: string | null
}

export interface ValuationPeerGroup {
  taxonomy: 'sector33' | 'custom60'
  label: string
  groupName: string | null
  peerCount: number
  metrics: Record<ValuationPeerMetric, ValuationPeerMetricComparison>
}

export interface ValuationDetailReadModel {
  contractVersion: 'valuation-detail-v1'
  ticker: string
  asOf: string
  priceDate: string | null
  price: number | null
  isFinancialSector: boolean
  classification: {
    name: string | null
    sector33: string | null
    custom60: string | null
  }
  current: {
    primary: ValuationValue[]
    secondary: ValuationValue[]
    qualityContext: {
      roe: ValuationValue
      revenueGrowth: ValuationValue
    }
    cautions: string[]
  }
  history: Record<ValuationHistoryMetric, ValuationMetricHistory>
  peers: {
    sector33: ValuationPeerGroup
    custom60: ValuationPeerGroup
  }
  definitions: Record<ValuationCurrentMetric | ValuationHistoryMetric | ValuationPeerMetric, MetricDefinition>
  coverage: {
    priceObservations: number
    facts: number
    forecastSnapshots: number
    detailedFacts: number
    historyStartDate: string | null
    historyEndDate: string | null
    peerCalculationMode: 'stored_latest' | 'pit_recalculated'
    quoteAsOf: string | null
    servingAsOf: string | null
    freshnessStatus: 'current' | 'stale' | 'missing'
    cacheHit: boolean
  }
}
