import type { TriggerDiscoveryRow } from '@/lib/server/trigger-discovery-read-model'
import type { SavedTriggerEvaluationConfig } from '@/lib/trigger-definition'
import type { TriggerLifecycleSummary } from '@/lib/trigger-lifecycle'

export const TRIGGER_EVALUATION_CONTRACT_VERSION = 'trigger-evaluation-v1'
export type TriggerEvaluationStatus = 'RUNNING' | 'COMPLETED' | 'FAILED'

export interface TriggerEvaluationSummary {
  id: string
  definitionId: string
  evaluationVersion: number
  engineVersion: number
  scoreVersion: number
  runSignature: string
  evaluationConfigSignature: string
  evaluationConfigSnapshot: SavedTriggerEvaluationConfig
  requestedAsOf: string
  resolvedAsOf: string
  startedAt: string
  completedAt: string | null
  status: TriggerEvaluationStatus
  counts: {
    pitUniverse: number
    currentPrice: number
    staleAccepted: number
    triggerEvaluated: number
    triggerMatched: number
    finalMatched: number
  }
  performance: {
    totalMs: number
    discoveryMs: number
    snapshotTransformMs: number
    persistenceMs: number
    discoveryQueryCount: number
    discoveryDbQueryMs: number
  }
  attemptCount: number
  errorCategory: string | null
  createdAt: string
}

export type TriggerEvaluationMember = Omit<TriggerDiscoveryRow, 'requestedAsOf' | 'resolvedAsOf' | 'matched'>

export interface TriggerEvaluationRunResponse {
  contractVersion: typeof TRIGGER_EVALUATION_CONTRACT_VERSION
  evaluation: TriggerEvaluationSummary
  reused: boolean
  lifecycle: TriggerLifecycleSummary
}

export interface TriggerEvaluationListResponse {
  contractVersion: typeof TRIGGER_EVALUATION_CONTRACT_VERSION
  evaluations: TriggerEvaluationSummary[]
}

export interface TriggerEvaluationDetailResponse {
  contractVersion: typeof TRIGGER_EVALUATION_CONTRACT_VERSION
  evaluation: TriggerEvaluationSummary
  members: TriggerEvaluationMember[]
  totalMembers: number
  limit: number
  offset: number
  hasMore: boolean
}
