const MINUTE = 60_000
const HOUR = 60 * MINUTE

export const JP_OHLCV_BACKUP_TIME_LIMITS = Object.freeze({
  maximumMaintenanceMs: 12 * HOUR,
  createBackupStageTimeoutMs: 3.5 * HOUR,
  verifyBackupStageTimeoutMs: 3.5 * HOUR,
  commandTerminationGraceMs: 60_000,
  parentBackupSha256MaxTimeoutMs: 60 * MINUTE,
  prewriteRecoveryReserveMs: 60 * MINUTE,
  simpleStageTimeoutMs: 10 * MINUTE,
  forwardDerivedAggregateTimeoutMs: 5.5 * HOUR,
  rollbackDerivedAggregateTimeoutMs: 20 * MINUTE,
  forwardNonCommandReserveMs: 30 * MINUTE,
  rollbackRestoreMaxTimeoutMs: 3 * HOUR,
  rollbackFinalizationReserveMs: 30 * MINUTE,
  backupCopyMaxTimeoutMs: 60 * MINUTE,
  journalModeMaxTimeoutMs: 15 * MINUTE,
  quickCheckMaxTimeoutMs: 150 * MINUTE,
  sha256MaxTimeoutMs: 60 * MINUTE,
  metadataReserveMs: 5 * MINUTE,
  journalModeMinimumMs: 5 * MINUTE,
  quickCheckMinimumMs: 45 * MINUTE,
  sha256MinimumMs: 30 * MINUTE,
})

export function assertJpOhlcvBackupMaintenanceBudget(): void {
  const limits = JP_OHLCV_BACKUP_TIME_LIMITS
  const prewriteMaximumMs = limits.createBackupStageTimeoutMs
    + limits.parentBackupSha256MaxTimeoutMs
    + limits.prewriteRecoveryReserveMs
  if (prewriteMaximumMs >= limits.maximumMaintenanceMs) {
    throw new Error(`repair_backup_prewrite_maintenance_budget_invalid:${prewriteMaximumMs}`)
  }

  // Rollback is a separately approved transaction. Its complete worst-case
  // path must nevertheless fit one writer-hold maintenance window.
  const rollbackMaximumMs = limits.verifyBackupStageTimeoutMs
    + limits.parentBackupSha256MaxTimeoutMs
    + limits.rollbackRestoreMaxTimeoutMs
    + limits.rollbackDerivedAggregateTimeoutMs
    + limits.rollbackFinalizationReserveMs
  if (rollbackMaximumMs >= limits.maximumMaintenanceMs) {
    throw new Error(`repair_backup_rollback_maintenance_budget_invalid:${rollbackMaximumMs}`)
  }
}

type MaintenancePlanTimeouts = {
  createBackupMs: number
  holdReadServicesMs: number
  publishSourceGenerationMs: number
  verifyDataGenerationMs: number
  verifyServingMs: number
  resumeReadServicesMs: number
  verifyBackupForRollbackMs: number
  restoreBackupMs: number
  verifyOriginalServingMs: number
  forwardDerivedAggregateMs: number
  rollbackDerivedAggregateMs: number
}

export function assertJpOhlcvPlanMaintenanceBudget(input: {
  maximumMaintenanceMs: number
  timeouts: MaintenancePlanTimeouts
}): { forwardMaximumMs: number; rollbackMaximumMs: number; remainingForwardMs: number; remainingRollbackMs: number } {
  assertJpOhlcvBackupMaintenanceBudget()
  const { maximumMaintenanceMs, timeouts } = input
  const values = [maximumMaintenanceMs, ...Object.values(timeouts)]
  if (!values.every((value) => Number.isSafeInteger(value) && value > 0)
    || maximumMaintenanceMs !== JP_OHLCV_BACKUP_TIME_LIMITS.maximumMaintenanceMs
    || timeouts.forwardDerivedAggregateMs !== JP_OHLCV_BACKUP_TIME_LIMITS.forwardDerivedAggregateTimeoutMs
    || timeouts.rollbackDerivedAggregateMs !== JP_OHLCV_BACKUP_TIME_LIMITS.rollbackDerivedAggregateTimeoutMs) {
    throw new Error('repair_plan_maintenance_budget_contract_invalid')
  }
  const forwardMaximumMs = timeouts.createBackupMs
    + JP_OHLCV_BACKUP_TIME_LIMITS.parentBackupSha256MaxTimeoutMs
    + timeouts.holdReadServicesMs
    + timeouts.publishSourceGenerationMs
    + timeouts.verifyDataGenerationMs
    + timeouts.forwardDerivedAggregateMs
    + timeouts.verifyServingMs
    + timeouts.resumeReadServicesMs
    + JP_OHLCV_BACKUP_TIME_LIMITS.forwardNonCommandReserveMs
  const rollbackMaximumMs = timeouts.verifyBackupForRollbackMs
    + JP_OHLCV_BACKUP_TIME_LIMITS.parentBackupSha256MaxTimeoutMs
    + timeouts.holdReadServicesMs
    + timeouts.restoreBackupMs
    + timeouts.rollbackDerivedAggregateMs
    + timeouts.verifyOriginalServingMs
    + timeouts.resumeReadServicesMs
    + JP_OHLCV_BACKUP_TIME_LIMITS.rollbackFinalizationReserveMs
  if (forwardMaximumMs >= maximumMaintenanceMs) {
    throw new Error(`repair_forward_plan_maintenance_budget_exceeded:${forwardMaximumMs}:${maximumMaintenanceMs}`)
  }
  if (rollbackMaximumMs >= maximumMaintenanceMs) {
    throw new Error(`repair_rollback_plan_maintenance_budget_exceeded:${rollbackMaximumMs}:${maximumMaintenanceMs}`)
  }
  return {
    forwardMaximumMs,
    rollbackMaximumMs,
    remainingForwardMs: maximumMaintenanceMs - forwardMaximumMs,
    remainingRollbackMs: maximumMaintenanceMs - rollbackMaximumMs,
  }
}

export function boundedBackupOperationTimeout(input: {
  label: string
  stageStartedAtMs: number
  stageTimeoutMs: number
  nowMs: number
  maxTimeoutMs: number
  minimumTimeoutMs: number
  reserveAfterMs: number
}): number {
  const values = [
    input.stageStartedAtMs,
    input.stageTimeoutMs,
    input.nowMs,
    input.maxTimeoutMs,
    input.minimumTimeoutMs,
    input.reserveAfterMs,
  ]
  if (!input.label || !values.every(Number.isFinite)
    || input.stageTimeoutMs <= 0
    || input.maxTimeoutMs <= 0
    || input.minimumTimeoutMs <= 0
    || input.minimumTimeoutMs > input.maxTimeoutMs
    || input.reserveAfterMs < 0
    || input.nowMs < input.stageStartedAtMs) {
    throw new Error(`repair_backup_time_budget_invalid:${input.label || 'unknown'}`)
  }
  const remainingForOperation = input.stageStartedAtMs
    + input.stageTimeoutMs
    - input.nowMs
    - input.reserveAfterMs
  if (remainingForOperation < input.minimumTimeoutMs) {
    throw new Error(`repair_backup_time_budget_insufficient:${input.label}:${remainingForOperation}`)
  }
  return Math.floor(Math.min(input.maxTimeoutMs, remainingForOperation))
}

