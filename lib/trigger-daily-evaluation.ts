export const TRIGGER_DAILY_EVALUATION_SOURCE = 'DAILY'
// Same-day re-evaluation after an approved data repair. It never composes
// notifications; its evaluations supersede the original DAILY evaluations.
export const TRIGGER_DAILY_REPAIR_EVALUATION_SOURCE = 'DAILY_REPAIR'

export type TriggerEvaluationBatchStatus =
  | 'RUNNING'
  | 'COMPLETED'
  | 'COMPLETED_WITH_ERRORS'
  | 'FAILED'

export type TriggerEvaluationBatchItemStatus =
  | 'PENDING'
  | 'COMPLETED'
  | 'REUSED'
  | 'FAILED'
  | 'SKIPPED_ARCHIVED'
  | 'SKIPPED_CHANGED'
  | 'SKIPPED_UNSUPPORTED_TIMEFRAME'

export interface TriggerEvaluationBatchSummary {
  id: string
  source: typeof TRIGGER_DAILY_EVALUATION_SOURCE | typeof TRIGGER_DAILY_REPAIR_EVALUATION_SOURCE
  repairKey: string | null
  supersedesBatchId: string | null
  requestedAsOf: string
  resolvedAsOf: string
  startedAt: string
  completedAt: string | null
  status: TriggerEvaluationBatchStatus
  definitionCount: number
  attemptedCount: number
  completedCount: number
  reusedCount: number
  failedCount: number
  skippedCount: number
  evaluationCount: number
  lifecycleEventCount: number
  durationMs: number
  errorCategory: string | null
}

export interface TriggerEvaluationBatchItem {
  batchId: string
  definitionId: string
  evaluationVersion: number
  evaluationConfigSignature: string
  engineVersion: number
  scoreVersion: number
  evaluationId: string | null
  status: TriggerEvaluationBatchItemStatus
  lifecycleEventCount: number
  durationMs: number
  errorCategory: string | null
}

export interface TriggerDailyEvaluationResult {
  dryRun: boolean
  reusedBatch: boolean
  requestedAsOf: string
  resolvedAsOf: string
  batch: TriggerEvaluationBatchSummary | null
  items: TriggerEvaluationBatchItem[]
}
