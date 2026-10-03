import type {
  TriggerHistoricalScanRequest,
  TriggerHistoricalScanResponse,
} from '@/lib/trigger-discovery-historical-scan-contract'

export const TRIGGER_HISTORICAL_SCAN_JOB_CONTRACT_VERSION =
  'trigger-discovery-historical-scan-job-v1' as const

export const TRIGGER_HISTORICAL_SCAN_JOB_STATUSES = [
  'QUEUED',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'CANCEL_REQUESTED',
  'CANCELLED',
] as const

export type TriggerHistoricalScanJobStatus =
  (typeof TRIGGER_HISTORICAL_SCAN_JOB_STATUSES)[number]

export interface TriggerHistoricalScanJobSummary {
  contractVersion: typeof TRIGGER_HISTORICAL_SCAN_JOB_CONTRACT_VERSION
  jobId: string
  status: TriggerHistoricalScanJobStatus
  request: Omit<TriggerHistoricalScanRequest, 'eventOffset' | 'eventLimit'>
  requestedStartDate: string
  requestedEndDate: string
  resolvedStartDate: string | null
  resolvedEndDate: string | null
  timeframe: TriggerHistoricalScanRequest['timeframe']
  progress: {
    processedTradingDays: number
    totalTradingDays: number
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

export interface TriggerHistoricalScanJobStartResponse {
  contractVersion: typeof TRIGGER_HISTORICAL_SCAN_JOB_CONTRACT_VERSION
  jobId: string
  status: TriggerHistoricalScanJobStatus
  reused: boolean
}

export interface TriggerHistoricalScanJobListResponse {
  contractVersion: typeof TRIGGER_HISTORICAL_SCAN_JOB_CONTRACT_VERSION
  jobs: TriggerHistoricalScanJobSummary[]
}

export type TriggerHistoricalScanJobResult = TriggerHistoricalScanResponse
