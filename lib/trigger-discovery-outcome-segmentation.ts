import type { TriggerDiscoveryStageFilters } from '@/lib/trigger-discovery-contract'
import type {
  TriggerOutcomeAvailability,
  TriggerOutcomeEventSelector,
  TriggerOutcomeHorizon,
  TriggerOutcomeHorizonSummary,
} from '@/lib/trigger-discovery-outcome-contract'

export const TRIGGER_OUTCOME_SEGMENTATION_CONTRACT_VERSION =
  'trigger-discovery-outcome-segmentation-v1' as const
export const TRIGGER_OUTCOME_SEGMENT_COMPARISON_CONTRACT_VERSION =
  'trigger-discovery-outcome-segment-comparison-v1' as const

export const TRIGGER_OUTCOME_SCORE_BANDS = [
  'LOW',
  'MID_LOW',
  'MID_HIGH',
  'HIGH',
  'UNKNOWN',
] as const
export type TriggerOutcomeScoreBand = (typeof TRIGGER_OUTCOME_SCORE_BANDS)[number]

export const TRIGGER_OUTCOME_STAGE_BUCKETS = [
  'S1',
  'S2',
  'S3',
  'S4',
  'S5',
  'S6',
  'UNKNOWN',
] as const
export type TriggerOutcomeStageBucket = (typeof TRIGGER_OUTCOME_STAGE_BUCKETS)[number]

export const TRIGGER_OUTCOME_SEGMENT_DIMENSIONS = [
  'scoreBand',
  'stage:dayA',
  'stage:dayB',
  'stage:weekA',
  'stage:weekB',
  'stage:monthA',
  'stage:monthB',
] as const
export type TriggerOutcomeSegmentDimension = (typeof TRIGGER_OUTCOME_SEGMENT_DIMENSIONS)[number]
export type TriggerOutcomeSegmentValue = TriggerOutcomeScoreBand | TriggerOutcomeStageBucket

export interface TriggerOutcomeSegmentHorizonSummary {
  horizonSessions: TriggerOutcomeHorizon
  totalEventCount: number
  eligibleCount: number
  unavailableCount: number
  censoredCount: number
  unavailableByReason: Partial<Record<TriggerOutcomeAvailability, number>>
  meanReturn: number | null
  medianReturn: number | null
  positiveReturnRatio: number | null
  p25Return: number | null
  p75Return: number | null
  medianMfe: number | null
  medianMae: number | null
  smallSample: boolean
}

export interface TriggerOutcomeSegmentGroup {
  keys: Partial<Record<TriggerOutcomeSegmentDimension, TriggerOutcomeSegmentValue>>
  eventCount: number
  uniqueTickerCount: number
  horizons: TriggerOutcomeSegmentHorizonSummary[]
}

export interface TriggerOutcomeSegmentationSourceMetadata {
  historicalScanJobId: string
  outcomeJobId: string
  eventSelector: TriggerOutcomeEventSelector
  timeframe: 'MONTHLY' | 'BIWEEKLY'
  maPeriods: {
    ma1: number
    ma2: number
    unit: 'MONTHLY_BARS' | 'BIWEEKLY_BARS'
  }
  scanPeriod: {
    requestedStartDate: string
    requestedEndDate: string
    resolvedStartDate: string | null
    resolvedEndDate: string | null
  }
  filters: {
    markets: Array<string | null> | null
    price: { min: number | null; max: number | null }
    liquidity: {
      averageVolumeMin: number | null
      averageVolumeMax: number | null
      averageTradingValueMin: number | null
      averageTradingValueMax: number | null
      lookbackSessions: number
      maxPriceStalenessSessions: number
    }
    historicalStage: TriggerDiscoveryStageFilters
    outcomeStage: TriggerDiscoveryStageFilters
    outcomeScore: { min: number | null; max: number | null }
    outcomeTicker: string | null
  }
  analysisCutoffDate: string
  horizons: TriggerOutcomeHorizon[]
  historicalUniverseCaveat: string
  observationIndependenceNote: string
}

export interface TriggerOutcomeSegmentationPerformance {
  totalMs: number
  manifestLoadMs: number
  ndjsonReadMs: number
  parsingMs: number
  groupingMs: number
  percentileMs: number
  serializationMs: number
  dbQueryCount: number
  ohlcvQueryCount: 0
  rowsRead: number
  peakHeapBytes: number
  peakRssBytes: number
  resultBytes: number
}

export interface TriggerOutcomeSegmentationResponse {
  contractVersion: typeof TRIGGER_OUTCOME_SEGMENTATION_CONTRACT_VERSION
  meta: {
    dimensions: TriggerOutcomeSegmentDimension[]
    smallSampleThreshold: number
    source: TriggerOutcomeSegmentationSourceMetadata
    generatedAt: string
    performance: TriggerOutcomeSegmentationPerformance
  }
  overall: {
    selectedEventCount: number
    uniqueTickerCount: number
    horizons: TriggerOutcomeHorizonSummary[]
  }
  segmentation: {
    dimensions: TriggerOutcomeSegmentDimension[]
    groups: TriggerOutcomeSegmentGroup[]
  }
  integrity: {
    eventCountMatchesOverall: boolean
    eligibleCountsMatchOverall: Record<string, boolean>
    weightedMeanMatchesOverall: Record<string, boolean>
  }
}

export const TRIGGER_OUTCOME_COMPARISON_DIFFERENCES = [
  'timeframe',
  'maPeriods',
  'requestedScanPeriod',
  'resolvedScanPeriod',
  'marketFilters',
  'priceFilters',
  'liquidityFilters',
  'stageFilters',
  'eventSelector',
  'scoreFilters',
  'horizons',
  'analysisCutoffDate',
] as const
export type TriggerOutcomeComparisonDifference =
  (typeof TRIGGER_OUTCOME_COMPARISON_DIFFERENCES)[number]

export interface TriggerOutcomeComparisonCompatibility {
  differences: TriggerOutcomeComparisonDifference[]
  samePopulationFilters: boolean
  sameDateRange: boolean
  sameEventSelector: boolean
  sameHorizons: boolean
  sameTimeframe: boolean
  sameMaPeriods: boolean
  sameScoreFilters: boolean
  sameAnalysisCutoffDate: boolean
}

export interface TriggerOutcomeSegmentComparisonResponse {
  contractVersion: typeof TRIGGER_OUTCOME_SEGMENT_COMPARISON_CONTRACT_VERSION
  dimensions: TriggerOutcomeSegmentDimension[]
  left: TriggerOutcomeSegmentationResponse
  right: TriggerOutcomeSegmentationResponse
  compatibility: TriggerOutcomeComparisonCompatibility
  performance: {
    totalMs: number
    resultBytes: number
    peakHeapBytes: number
    peakRssBytes: number
  }
}
