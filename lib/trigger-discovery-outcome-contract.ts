import type {
  TriggerDiscoveryStageAxis,
  TriggerDiscoveryStageFilters,
} from '@/lib/trigger-discovery-contract'
import type {
  TriggerHistoricalScanEventType,
} from '@/lib/trigger-discovery-historical-scan-contract'
import type { TriggerStatus } from '@/lib/trigger-discovery-engine'

export const TRIGGER_DISCOVERY_OUTCOME_CONTRACT_VERSION =
  'trigger-discovery-outcome-v1' as const
export const TRIGGER_DISCOVERY_OUTCOME_JOB_CONTRACT_VERSION =
  'trigger-discovery-outcome-job-v1' as const

export const TRIGGER_OUTCOME_HORIZONS = [20, 60, 120, 245] as const
export type TriggerOutcomeHorizon = (typeof TRIGGER_OUTCOME_HORIZONS)[number]

export const TRIGGER_OUTCOME_EVENT_SELECTORS = [
  'ALL',
  'ENTERED',
  'RE_ENTRY',
  'STATUS_CHANGED',
  'EXITED',
  'NEAR_ENTERED',
  'IN_ZONE_ENTERED',
] as const
export type TriggerOutcomeEventSelector = (typeof TRIGGER_OUTCOME_EVENT_SELECTORS)[number]

export type TriggerOutcomeAvailability =
  | 'AVAILABLE'
  | 'NOT_REQUESTED'
  | 'INSUFFICIENT_FUTURE_DATA'
  | 'ANCHOR_SESSION_NOT_FOUND'
  | 'INVALID_ANCHOR_PRICE'

export interface TriggerOutcomeRequest {
  historicalScanJobId: string
  eventFilter: TriggerOutcomeEventSelector
  horizons: TriggerOutcomeHorizon[]
  ticker: string | null
  triggerScoreMin: number | null
  triggerScoreMax: number | null
  stageFilters: TriggerDiscoveryStageFilters
}

export interface TriggerOutcomeRow {
  eventDate: string
  ticker: string
  companyName: string
  eventType: TriggerHistoricalScanEventType
  previousStatus: TriggerStatus | null
  currentStatus: TriggerStatus | null
  anchorPrice: number
  triggerScore: number
  dayAStage: number | null
  dayBStage: number | null
  weekAStage: number | null
  weekBStage: number | null
  monthAStage: number | null
  monthBStage: number | null
  return20: number | null
  return60: number | null
  return120: number | null
  return245: number | null
  mfe20: number | null
  mfe60: number | null
  mfe120: number | null
  mfe245: number | null
  mae20: number | null
  mae60: number | null
  mae120: number | null
  mae245: number | null
  availability20: TriggerOutcomeAvailability
  availability60: TriggerOutcomeAvailability
  availability120: TriggerOutcomeAvailability
  availability245: TriggerOutcomeAvailability
}

export interface TriggerOutcomeHorizonSummary {
  horizonSessions: TriggerOutcomeHorizon
  totalSelectedEvents: number
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
}

export interface TriggerOutcomePerformance {
  totalMs: number
  sqlMs: number
  calculationMs: number
  aggregationMs: number
  serializationMs: number
  saveMs: number
  queryCount: number
  selectedEventCount: number
  uniqueTickerCount: number
  ohlcvRowCount: number
  peakHeapBytes: number
  peakRssBytes: number
}

export interface TriggerOutcomeManifest {
  contractVersion: typeof TRIGGER_DISCOVERY_OUTCOME_CONTRACT_VERSION
  outcomeJobId: string
  historicalScanJobId: string
  sourceFingerprint: string
  request: TriggerOutcomeRequest
  metadata: {
    analysisCutoffDate: string
    sourceTimeframe: 'MONTHLY' | 'BIWEEKLY'
    adjustmentBasis: 'JQUANTS_ADJUSTED_OHLCV'
    anchorPriceBasis: 'HISTORICAL_EVENT_CLOSE'
    excursionWindow: 'NEXT_SESSION_THROUGH_HORIZON'
    observationIndependenceNote: string
  }
  summary: {
    selectedEventCount: number
    uniqueTickerCount: number
    horizons: TriggerOutcomeHorizonSummary[]
  }
  performance: TriggerOutcomePerformance
  generatedAt: string
}

export const TRIGGER_OUTCOME_JOB_STATUSES = [
  'QUEUED',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'CANCEL_REQUESTED',
  'CANCELLED',
] as const
export type TriggerOutcomeJobStatus = (typeof TRIGGER_OUTCOME_JOB_STATUSES)[number]

export interface TriggerOutcomeJobSummary {
  contractVersion: typeof TRIGGER_DISCOVERY_OUTCOME_JOB_CONTRACT_VERSION
  jobId: string
  status: TriggerOutcomeJobStatus
  request: TriggerOutcomeRequest
  historicalScanJobId: string
  analysisCutoffDate: string | null
  progress: {
    processedEvents: number
    totalEvents: number
    processedTickers: number
    totalTickers: number
  }
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  expiresAt: string
  durationMs: number
  resultSizeBytes: number
  resultAvailable: boolean
  errorCategory: string | null
}

export interface TriggerOutcomeJobStartResponse {
  contractVersion: typeof TRIGGER_DISCOVERY_OUTCOME_JOB_CONTRACT_VERSION
  jobId: string
  status: TriggerOutcomeJobStatus
  reused: boolean
}

export interface TriggerOutcomeResultResponse extends TriggerOutcomeManifest {
  rows: TriggerOutcomeRow[]
  rowPage: {
    offset: number
    limit: number
    returnedCount: number
    totalCount: number
    hasMore: boolean
    sortBy: 'eventDate' | 'ticker'
    sortOrder: 'asc' | 'desc'
  }
}

export const TRIGGER_OUTCOME_STAGE_AXES: readonly TriggerDiscoveryStageAxis[] = [
  'dayAStage',
  'dayBStage',
  'weekAStage',
  'weekBStage',
  'monthAStage',
  'monthBStage',
]
