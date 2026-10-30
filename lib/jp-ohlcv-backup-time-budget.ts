import {
  LAUNCHD_RESTORE_RESERVE_BASE_MS,
  LAUNCHD_RESTORE_RESERVE_PER_WRITER_MS,
} from '@/lib/storage/launchd-writer-hold-driver'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

export const JP_OHLCV_BACKUP_TIME_LIMITS = Object.freeze({
  maximumMaintenanceMs: 12 * HOUR,
  createBackupStageTimeoutMs: 5.75 * HOUR,
  verifyBackupStageTimeoutMs: 5.25 * HOUR,
  commandTerminationGraceMs: 60_000,
  parentBackupSha256MaxTimeoutMs: 30 * MINUTE,
  prewriteRecoveryReserveMs: 60 * MINUTE,
  simpleStageTimeoutMs: 10 * MINUTE,
  officialSourceFetchMaxTimeoutMs: 2 * MINUTE,
  readerHandleProbeMaxTimeoutMs: 30_000,
  forwardOperationTimeoutMs: 590 * MINUTE,
  forwardPreOperationReserveMs: 5 * MINUTE,
  forwardPostOperationReserveMs: 5 * MINUTE,
  // The 2026-10-30 Production daily rebuild completed in 2,766 seconds and
  // included the repair's snapshot, stage, trigger, screener and cache work.
  // This remains a fail-closed aggregate cap with more than 3x headroom.
  forwardDerivedAggregateTimeoutMs: 140 * MINUTE,
  rollbackDerivedAggregateTimeoutMs: 20 * MINUTE,
  forwardNonCommandReserveMs: 34 * MINUTE,
  minimumForwardMaintenanceMarginMs: 30 * MINUTE,
  minimumRollbackMaintenanceMarginMs: 90 * MINUTE,
  writerStopSloMs: 30 * MINUTE,
  writerRestoreSloMs: 60 * MINUTE,
  writerRestoreLoadedServices: 13,
  writerRestoreUnloadedServices: 3,
  writerRestoreMaximumWaitsPerLoadedService: 3,
  writerRestoreMaximumWaitsPerUnloadedService: 1,
  writerRestoreMaximumWaitMs: 60_000,
  rollbackRestoreMaxTimeoutMs: 3 * HOUR,
  rollbackFinalizationReserveMs: 30 * MINUTE,
  backupCopyMaxTimeoutMs: 30 * MINUTE,
  journalModeMaxTimeoutMs: 15 * MINUTE,
  quickCheckMaxTimeoutMs: 265 * MINUTE,
  sha256MaxTimeoutMs: 30 * MINUTE,
  metadataReserveMs: 5 * MINUTE,
  journalModeMinimumMs: 5 * MINUTE,
  quickCheckMinimumMs: 240 * MINUTE,
  sha256MinimumMs: 20 * MINUTE,
})

export function assertJpOhlcvBackupMaintenanceBudget(): void {
  const limits = JP_OHLCV_BACKUP_TIME_LIMITS
  const createBackupOperationMaximumMs = limits.backupCopyMaxTimeoutMs
    + limits.journalModeMaxTimeoutMs
    + limits.quickCheckMaxTimeoutMs
    + limits.sha256MaxTimeoutMs
    + limits.metadataReserveMs
  if (createBackupOperationMaximumMs > limits.createBackupStageTimeoutMs) {
    throw new Error(`repair_backup_create_stage_budget_invalid:${createBackupOperationMaximumMs}`)
  }
  const verifyBackupOperationMaximumMs = limits.sha256MaxTimeoutMs
    + limits.quickCheckMaxTimeoutMs
    + limits.metadataReserveMs
  if (verifyBackupOperationMaximumMs > limits.verifyBackupStageTimeoutMs) {
    throw new Error(`repair_backup_verify_stage_budget_invalid:${verifyBackupOperationMaximumMs}`)
  }
  const writerRestoreWaitMaximumMs = (
    limits.writerRestoreLoadedServices * limits.writerRestoreMaximumWaitsPerLoadedService
    + limits.writerRestoreUnloadedServices * limits.writerRestoreMaximumWaitsPerUnloadedService
  ) * limits.writerRestoreMaximumWaitMs
  const writerStopWaitMaximumMs = limits.writerRestoreLoadedServices * limits.writerRestoreMaximumWaitMs
  const launchdCommandReserveMs = LAUNCHD_RESTORE_RESERVE_BASE_MS
    + (limits.writerRestoreLoadedServices + limits.writerRestoreUnloadedServices)
      * LAUNCHD_RESTORE_RESERVE_PER_WRITER_MS
  if (writerStopWaitMaximumMs + launchdCommandReserveMs > limits.writerStopSloMs) {
    throw new Error(`repair_writer_stop_slo_invalid:${writerStopWaitMaximumMs + launchdCommandReserveMs}`)
  }
  if (writerRestoreWaitMaximumMs + launchdCommandReserveMs > limits.writerRestoreSloMs) {
    throw new Error(`repair_writer_restore_slo_invalid:${writerRestoreWaitMaximumMs + launchdCommandReserveMs}`)
  }
  if (limits.readerHandleProbeMaxTimeoutMs + limits.officialSourceFetchMaxTimeoutMs
    > limits.forwardPreOperationReserveMs) {
    throw new Error('repair_forward_preoperation_budget_invalid')
  }
  const prewriteMaximumMs = limits.createBackupStageTimeoutMs
    + limits.commandTerminationGraceMs
    + limits.parentBackupSha256MaxTimeoutMs
    + limits.prewriteRecoveryReserveMs
  if (prewriteMaximumMs >= limits.maximumMaintenanceMs) {
    throw new Error(`repair_backup_prewrite_maintenance_budget_invalid:${prewriteMaximumMs}`)
  }

  // Rollback is a separately approved transaction. Its complete worst-case
  // path must nevertheless fit one writer-hold maintenance window.
  const rollbackMaximumMs = limits.verifyBackupStageTimeoutMs
    + limits.commandTerminationGraceMs
    + limits.parentBackupSha256MaxTimeoutMs
    + limits.rollbackRestoreMaxTimeoutMs
    + limits.parentBackupSha256MaxTimeoutMs
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
}): {
  forwardMaximumMs: number
  forwardMaintenanceMaximumMs: number
  rollbackMaximumMs: number
  remainingForwardMs: number
  remainingRollbackMs: number
} {
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
    + JP_OHLCV_BACKUP_TIME_LIMITS.parentBackupSha256MaxTimeoutMs
    + timeouts.rollbackDerivedAggregateMs
    + timeouts.verifyOriginalServingMs
    + timeouts.resumeReadServicesMs
    + JP_OHLCV_BACKUP_TIME_LIMITS.rollbackFinalizationReserveMs
  if (forwardMaximumMs > JP_OHLCV_BACKUP_TIME_LIMITS.forwardOperationTimeoutMs) {
    throw new Error(`repair_forward_plan_maintenance_budget_exceeded:${forwardMaximumMs}:${maximumMaintenanceMs}`)
  }
  const forwardMaintenanceMaximumMs = JP_OHLCV_BACKUP_TIME_LIMITS.writerStopSloMs
    + JP_OHLCV_BACKUP_TIME_LIMITS.forwardPreOperationReserveMs
    + JP_OHLCV_BACKUP_TIME_LIMITS.forwardOperationTimeoutMs
    + JP_OHLCV_BACKUP_TIME_LIMITS.forwardPostOperationReserveMs
    + JP_OHLCV_BACKUP_TIME_LIMITS.writerRestoreSloMs
  if (forwardMaintenanceMaximumMs
    > maximumMaintenanceMs - JP_OHLCV_BACKUP_TIME_LIMITS.minimumForwardMaintenanceMarginMs) {
    throw new Error(
      `repair_forward_maintenance_envelope_exceeded:${forwardMaintenanceMaximumMs}:${maximumMaintenanceMs}`,
    )
  }
  if (rollbackMaximumMs > maximumMaintenanceMs - JP_OHLCV_BACKUP_TIME_LIMITS.minimumRollbackMaintenanceMarginMs) {
    throw new Error(`repair_rollback_plan_maintenance_budget_exceeded:${rollbackMaximumMs}:${maximumMaintenanceMs}`)
  }
  return {
    forwardMaximumMs,
    forwardMaintenanceMaximumMs,
    rollbackMaximumMs,
    remainingForwardMs: maximumMaintenanceMs - forwardMaintenanceMaximumMs,
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

