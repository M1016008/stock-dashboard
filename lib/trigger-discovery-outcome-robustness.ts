import type {
  TriggerOutcomeAvailability,
  TriggerOutcomeHorizon,
  TriggerOutcomeHorizonSummary,
} from '@/lib/trigger-discovery-outcome-contract'
import type {
  TriggerOutcomeSegmentationSourceMetadata,
  TriggerOutcomeSegmentDimension,
  TriggerOutcomeSegmentValue,
} from '@/lib/trigger-discovery-outcome-segmentation'

export const TRIGGER_OUTCOME_ROBUSTNESS_CONTRACT_VERSION =
  'trigger-discovery-outcome-robustness-v2' as const
export const TRIGGER_EPISODE_ALGORITHM_VERSION = 'trigger-episode-v1' as const

export interface TriggerOutcomeEpisodeMetadata {
  episodeKey: string
  ticker: string
  observedEpisodeStartDate: string | null
  observedFromDate: string
  episodeEndDate: string | null
  leftCensored: boolean
  rightCensored: boolean
  startEventType: string
  selectedEventCount: number
  selectedAnchorEventDate: string | null
  selectedAnchorEventType: string | null
  selectedAnchorSourceSequence: number | null
  excludedForSequenceIntegrity: boolean
  excludedForMappingIntegrity: boolean
}

export interface TriggerOutcomeEpisodeDiagnostics {
  observedEpisodeCount: number
  selectedEpisodeCount: number
  leftCensoredCount: number
  rightCensoredCount: number
  selectedLeftCensoredCount: number
  selectedRightCensoredCount: number
  sequenceAnomalyCount: number
  excludedForSequenceIntegrity: number
  excludedForMappingIntegrity: number
  mappedOutcomeRows: number
  unmappedOutcomeRows: number
  ambiguousOutcomeRows: number
  episodesWithOneSelectedEvent: number
  episodesWithRepeatedSelectedEvents: number
  selectedEventsPerEpisode: { mean: number | null; median: number | null; p95: number | null; max: number }
  episodeToEventObservationRatio: number | null
}

export const TRIGGER_OUTCOME_ANALYSIS_UNITS = [
  'EVENT',
  'EPISODE',
  'TICKER_EQUAL_WEIGHT',
] as const
export type TriggerOutcomeAnalysisUnit = (typeof TRIGGER_OUTCOME_ANALYSIS_UNITS)[number]

export interface TriggerOutcomeRobustnessHorizonSummary extends Omit<
  TriggerOutcomeHorizonSummary,
  'totalSelectedEvents'
> {
  totalObservationCount: number
  smallSample: boolean
}

export interface TriggerOutcomeRobustnessUnitSummary {
  unit: TriggerOutcomeAnalysisUnit
  observationCount: number
  uniqueTickerCount: number
  horizons: TriggerOutcomeRobustnessHorizonSummary[]
}

export interface TriggerOutcomeRobustnessDelta {
  horizonSessions: TriggerOutcomeHorizon
  medianReturn: number | null
  positiveReturnRatio: number | null
  p25Return: number | null
  p75Return: number | null
  medianMfe: number | null
  medianMae: number | null
}

export interface TriggerOutcomeRobustnessConcentration {
  sourceEventCount: number
  episodeObservationCount: number
  uniqueTickerCount: number
  eventsPerTicker: { median: number | null; p90: number | null; max: number }
  episodesPerTicker: { median: number | null; p90: number | null; max: number }
  top10TickerEventShare: number | null
  syntheticBaselineEpisodeCount: number
  selectedSyntheticBaselineEpisodeCount: number
}

export interface TriggerOutcomeRobustnessBlock {
  diagnostics: TriggerOutcomeRobustnessConcentration
  units: Record<TriggerOutcomeAnalysisUnit, TriggerOutcomeRobustnessUnitSummary>
  deltas: {
    eventToEpisode: TriggerOutcomeRobustnessDelta[]
    episodeToTicker: TriggerOutcomeRobustnessDelta[]
  }
  countInvariant: boolean
}

export interface TriggerOutcomeRobustnessSegmentGroup extends TriggerOutcomeRobustnessBlock {
  keys: Partial<Record<TriggerOutcomeSegmentDimension, TriggerOutcomeSegmentValue>>
}

export interface TriggerOutcomeRobustnessPerformance {
  totalMs: number
  manifestLoadMs: number
  outcomeNdjsonReadMs: number
  outcomeParsingMs: number
  historicalArtifactReadMs: number
  historicalParsingMs: number
  episodeBuildMs: number
  outcomeMappingMs: number
  dedupMs: number
  tickerAggregationMs: number
  segmentationMs: number
  percentileMs: number
  serializationMs: number
  dbQueryCount: number
  ohlcvQueryCount: 0
  outcomeRowsRead: number
  historicalEventsRead: number
  artifactReadCount: number
  peakHeapBytes: number
  peakRssBytes: number
  resultBytes: number
}

export interface TriggerOutcomeRobustnessResponse {
  contractVersion: typeof TRIGGER_OUTCOME_ROBUSTNESS_CONTRACT_VERSION
  meta: {
    dimensions: TriggerOutcomeSegmentDimension[]
    episodeAlgorithmVersion: typeof TRIGGER_EPISODE_ALGORITHM_VERSION
    smallSampleThreshold: number
    source: TriggerOutcomeSegmentationSourceMetadata
    definitions: {
      event: string
      episode: string
      syntheticBaselineEpisode: string
      tickerEqualWeight: string
      tickerRepresentative: 'MEDIAN_OF_ELIGIBLE_EPISODE_REPRESENTATIVES_PER_HORIZON'
      positiveRatio: {
        EVENT: 'POSITIVE_EVENT_RETURN_RATIO'
        EPISODE: 'POSITIVE_EPISODE_REPRESENTATIVE_RETURN_RATIO'
        TICKER_EQUAL_WEIGHT: 'POSITIVE_TICKER_REPRESENTATIVE_RETURN_RATIO'
      }
      tickerUnavailableReason: 'FIRST_EPISODE_REPRESENTATIVE_AVAILABILITY_IN_CHRONOLOGICAL_ORDER'
      smallSample: 'ELIGIBLE_OBSERVATIONS_LT_30'
      outcomeSource: 'SAVED_OUTCOME_NDJSON'
      episodeSource: 'SAVED_HISTORICAL_EVENT_NDJSON'
    }
    generatedAt: string
    expiresAt: string
    performance: TriggerOutcomeRobustnessPerformance
  }
  overall: TriggerOutcomeRobustnessBlock
  episodeDiagnostics: TriggerOutcomeEpisodeDiagnostics
  episodePage: {
    offset: number
    limit: number
    totalCount: number
    episodes: TriggerOutcomeEpisodeMetadata[]
  }
  segmentation: {
    dimensions: TriggerOutcomeSegmentDimension[]
    groups: TriggerOutcomeRobustnessSegmentGroup[]
  } | null
  integrity: {
    sourceRowsMatchedToHistoricalEvents: boolean
    unmatchedOutcomeRowCount: number
    ambiguousOutcomeRowCount: number
    sequenceAnomalyCount: number
    eventSummaryMatchesSavedOutcome: boolean
    overallCountInvariant: boolean
    segmentCountInvariants: boolean
    episodeSegmentCountMatchesOverall: boolean
    episodeSegmentEligibleMatchesOverall: Record<string, boolean>
    episodeSegmentWeightedMeanMatchesOverall: Record<string, boolean>
    sourceArtifactsReadOnly: true
  }
}

export function robustnessUnavailableReason(
  reasons: readonly TriggerOutcomeAvailability[],
): TriggerOutcomeAvailability {
  return reasons[0] ?? 'INSUFFICIENT_FUTURE_DATA'
}
