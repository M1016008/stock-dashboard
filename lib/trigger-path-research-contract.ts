import type { TriggerOutcomeHorizon, TriggerOutcomeHorizonSummary, TriggerOutcomeJobStatus, TriggerOutcomeRow } from '@/lib/trigger-discovery-outcome-contract'
import type { TriggerOutcomeSegmentDimension } from '@/lib/trigger-discovery-outcome-segmentation'
import type { TriggerPathProfile } from '@/lib/trigger-path-contract'

export const PATH_RESEARCH_CONTRACT_VERSION = 'trigger-path-research-v1' as const
export const PATH_SEGMENTATION_VERSION = 'trigger-path-segments-v1' as const

export const PATH_DIMENSIONS = [
  'pathDepthLow', 'pathDepthClose', 'timeToDeepest', 'belowZoneDuration',
  'longestBelowStreak', 'reclaimSpeed', 'reclaimStatus', 'zoneWidthDepth', 'atrDepth',
] as const
export type PathDimension = typeof PATH_DIMENSIONS[number]
export type PathResearchDimension = PathDimension | TriggerOutcomeSegmentDimension
export type PathResearchUnit = 'EVENT' | 'EPISODE'
export type PathAnchorSemantics = 'EVENT_SAVED_PRICE' | 'PREVIOUS_CANDIDATE_SAVED_PRICE'
export type PathResearchMetric = 'return' | 'mfe' | 'mae'

export interface PathResearchCohort {
  metric: PathResearchMetric
  horizon: TriggerOutcomeHorizon
  min: number | null
  max: number | null
}

export interface PathResearchRow {
  eventKey: string
  episodeKey: string | null
  ticker: string
  eventDate: string
  eventSelector: string
  anchorSemantics: PathAnchorSemantics
  timeframe: 'MONTHLY' | 'BIWEEKLY'
  ma1Period: number
  ma2Period: number
  anchorPrice: number
  analysisCutoffDate: string
  pathStatus: 'AVAILABLE' | 'INVALID_ANCHOR' | 'MISSING_MARKET_DATA'
  pathProfile: TriggerPathProfile | null
  // Return/MFE/MAE and their availability are copied from the saved Outcome artifact.
  outcome: TriggerOutcomeRow
}

export interface PathResearchManifest {
  contractVersion: typeof PATH_RESEARCH_CONTRACT_VERSION
  pathSegmentationVersion: typeof PATH_SEGMENTATION_VERSION
  jobId: string
  outcomeJobId: string
  historicalScanJobId: string
  sourceFingerprint: string
  analysisCutoffDate: string
  eventSelector: string
  timeframe: 'MONTHLY' | 'BIWEEKLY'
  ma1Period: number
  ma2Period: number
  sourceObservationCount: number
  generatedRowCount: number
  episodeMappedCount: number
  episodeExcludedCount: number
  pathUnavailableCount: number
  artifactFormat: 'NDJSON'
  fixedWindows: readonly [20, 60, 120, 245]
  definitions: {
    path: 'POST_EVENT_REALIZED_PATH'
    outcome: 'SAVED_OUTCOME_ARTIFACT'
    episodeAnchor: 'FIRST_SELECTED_EVENT_IN_EPISODE'
    zoneBasis: 'MOVING_MA_ZONE'
  }
  performance: {
    totalMs: number
    sourceOutcomeReadMs: number
    eventMappingMs: number
    ohlcvMaLoadMs: number
    pathCalculationMs: number
    atrMs: number
    serializationMs: number
    aggregationMs: number
    sqlQueryCount: number
    peakHeapBytes: number
    peakRssBytes: number
    artifactBytes: number
  }
  generatedAt: string
}

export interface PathResearchJobSummary {
  jobId: string
  outcomeJobId: string
  historicalScanJobId: string
  status: TriggerOutcomeJobStatus
  progress: { processedEvents: number; totalEvents: number; processedTickers: number; totalTickers: number }
  createdAt: string
  completedAt: string | null
  expiresAt: string
  resultAvailable: boolean
  resultSizeBytes: number
  errorCategory: string | null
}

export interface PathResearchSegmentGroup {
  keys: Record<string, string>
  eventCount: number
  uniqueTickerCount: number
  horizon: TriggerOutcomeHorizonSummary
  smallSample: boolean
}

export interface PathResearchSegmentsResponse {
  contractVersion: typeof PATH_RESEARCH_CONTRACT_VERSION
  meta: {
    pathSegmentationVersion: typeof PATH_SEGMENTATION_VERSION
    outcomeJobId: string
    jobId: string
    analysisCutoffDate: string
    eventSelector: string
    timeframe: 'MONTHLY' | 'BIWEEKLY'
    ma1Period: number
    ma2Period: number
    horizon: TriggerOutcomeHorizon
    dimensions: PathResearchDimension[]
    unit: PathResearchUnit
    outcomeConditioned: boolean
    cohort: PathResearchCohort | null
    sourceObservationCount: number
    selectedObservationCount: number
    anchorSemanticsCounts: Record<PathAnchorSemantics, number>
    excludedForMissingFixedPath: number
    excludedForEpisodeMapping: number
    postEventDescriptiveOnly: true
    smallSampleThreshold: 30
    bandOrder: Record<string, string[]>
  }
  overall: { eventCount: number; uniqueTickerCount: number; horizon: TriggerOutcomeHorizonSummary }
  groups: PathResearchSegmentGroup[]
  integrity: {
    groupCountMatchesOverall: boolean
    eligibleCountsMatchOverall: boolean
    sourceRowsComplete: boolean
  }
}
