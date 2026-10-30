import assert from 'node:assert/strict'

import {
  assertJpOhlcvBackupMaintenanceBudget,
  assertJpOhlcvPlanMaintenanceBudget,
  boundedBackupOperationTimeout,
  JP_OHLCV_BACKUP_TIME_LIMITS as limits,
} from '@/lib/jp-ohlcv-backup-time-budget'
import {
  LAUNCHD_RESTORE_RESERVE_BASE_MS,
  LAUNCHD_RESTORE_RESERVE_PER_WRITER_MS,
} from '@/lib/storage/launchd-writer-hold-driver'

const minute = 60_000
const start = Date.parse('2026-10-30T08:28:15.936Z')
assert.doesNotThrow(() => assertJpOhlcvBackupMaintenanceBudget())
assert.equal(limits.maximumMaintenanceMs, 12 * 60 * minute)
assert.ok(
  limits.createBackupStageTimeoutMs
    + limits.parentBackupSha256MaxTimeoutMs
    + limits.prewriteRecoveryReserveMs
  < limits.maximumMaintenanceMs,
)
assert.equal(limits.createBackupStageTimeoutMs, 345 * minute)
assert.equal(limits.verifyBackupStageTimeoutMs, 315 * minute)
assert.equal(limits.quickCheckMaxTimeoutMs, 265 * minute)
assert.equal(limits.parentBackupSha256MaxTimeoutMs, 30 * minute)
assert.equal(limits.forwardDerivedAggregateTimeoutMs, 140 * minute)
assert.ok(limits.forwardDerivedAggregateTimeoutMs >= 3 * 2_766_000)
assert.equal(limits.forwardOperationTimeoutMs, 590 * minute)
assert.equal(limits.forwardNonCommandReserveMs, 34 * minute)
assert.equal(limits.writerStopSloMs, 30 * minute)
assert.equal(limits.writerRestoreSloMs, 60 * minute)
assert.equal(
  (limits.writerRestoreLoadedServices * limits.writerRestoreMaximumWaitsPerLoadedService
    + limits.writerRestoreUnloadedServices * limits.writerRestoreMaximumWaitsPerUnloadedService)
    * limits.writerRestoreMaximumWaitMs,
  42 * minute,
)
assert.equal(
  limits.writerRestoreLoadedServices * limits.writerRestoreMaximumWaitMs,
  13 * minute,
)
assert.ok(
  limits.writerRestoreLoadedServices * limits.writerRestoreMaximumWaitMs
    + LAUNCHD_RESTORE_RESERVE_BASE_MS
    + (limits.writerRestoreLoadedServices + limits.writerRestoreUnloadedServices)
      * LAUNCHD_RESTORE_RESERVE_PER_WRITER_MS
    <= limits.writerStopSloMs,
)
assert.ok(
  (limits.writerRestoreLoadedServices * limits.writerRestoreMaximumWaitsPerLoadedService
    + limits.writerRestoreUnloadedServices * limits.writerRestoreMaximumWaitsPerUnloadedService)
    * limits.writerRestoreMaximumWaitMs
    + LAUNCHD_RESTORE_RESERVE_BASE_MS
    + (limits.writerRestoreLoadedServices + limits.writerRestoreUnloadedServices)
      * LAUNCHD_RESTORE_RESERVE_PER_WRITER_MS
    <= limits.writerRestoreSloMs,
)
assert.ok(
  limits.verifyBackupStageTimeoutMs
    + limits.parentBackupSha256MaxTimeoutMs
    + limits.rollbackRestoreMaxTimeoutMs
    + limits.rollbackDerivedAggregateTimeoutMs
    + limits.rollbackFinalizationReserveMs
  < limits.maximumMaintenanceMs,
)

const copyTimeout = boundedBackupOperationTimeout({
  label: 'backup_copy',
  stageStartedAtMs: start,
  stageTimeoutMs: limits.createBackupStageTimeoutMs,
  nowMs: start,
  maxTimeoutMs: limits.backupCopyMaxTimeoutMs,
  minimumTimeoutMs: 5 * minute,
  reserveAfterMs: limits.journalModeMinimumMs
    + limits.quickCheckMinimumMs
    + limits.sha256MinimumMs
    + limits.metadataReserveMs,
})
assert.equal(copyTimeout, 30 * minute)

// Production copied 551,171,977,216 bytes in about 14m44s and full
// quick_check completed in 3h30m24.68s. The measured path keeps a separate
// 15m+ copy margin, 59m+ quick_check margin, and the full measured hash window.
const observedCopyMs = 14 * minute + 44_000
const observedQuickCheckMs = 3 * 60 * minute + 30 * minute + 24_680
const observedSha256Ms = 14 * minute + 7_790
const afterObservedCopyAndNormalize = start + observedCopyMs + minute
const quickCheckTimeout = boundedBackupOperationTimeout({
  label: 'quick_check',
  stageStartedAtMs: start,
  stageTimeoutMs: limits.createBackupStageTimeoutMs,
  nowMs: afterObservedCopyAndNormalize,
  maxTimeoutMs: limits.quickCheckMaxTimeoutMs,
  minimumTimeoutMs: limits.quickCheckMinimumMs,
  reserveAfterMs: limits.sha256MinimumMs + limits.metadataReserveMs,
})
assert.equal(quickCheckTimeout, 265 * minute)
assert.ok(observedQuickCheckMs < quickCheckTimeout)
assert.ok(54 * minute < quickCheckTimeout - observedQuickCheckMs)

// The measured path leaves enough time for hashing and metadata without using
// the quick_check maximum as an expected duration.
const shaTimeout = boundedBackupOperationTimeout({
  label: 'sha256',
  stageStartedAtMs: start,
  stageTimeoutMs: limits.createBackupStageTimeoutMs,
  nowMs: afterObservedCopyAndNormalize + observedQuickCheckMs,
  maxTimeoutMs: limits.sha256MaxTimeoutMs,
  minimumTimeoutMs: limits.sha256MinimumMs,
  reserveAfterMs: limits.metadataReserveMs,
})
assert.equal(shaTimeout, limits.sha256MaxTimeoutMs)
assert.ok(observedSha256Ms < shaTimeout)

// A slow preceding operation may reduce a later allowance, but never below the
// declared safety minimum. It fails before starting the next I/O operation.
assert.throws(() => boundedBackupOperationTimeout({
  label: 'quick_check',
  stageStartedAtMs: start,
  stageTimeoutMs: limits.createBackupStageTimeoutMs,
  nowMs: start + limits.createBackupStageTimeoutMs
    - limits.sha256MinimumMs
    - limits.metadataReserveMs
    - limits.quickCheckMinimumMs
    + 1,
  maxTimeoutMs: limits.quickCheckMaxTimeoutMs,
  minimumTimeoutMs: limits.quickCheckMinimumMs,
  reserveAfterMs: limits.sha256MinimumMs + limits.metadataReserveMs,
}), /repair_backup_time_budget_insufficient:quick_check/)

// Rollback verification retains time for both full-file hashing and full DB
// quick_check instead of inheriting the old common 30-minute timeout.
const rollbackHashTimeout = boundedBackupOperationTimeout({
  label: 'rollback_sha256',
  stageStartedAtMs: start,
  stageTimeoutMs: limits.verifyBackupStageTimeoutMs,
  nowMs: start,
  maxTimeoutMs: limits.sha256MaxTimeoutMs,
  minimumTimeoutMs: limits.sha256MinimumMs,
  reserveAfterMs: limits.quickCheckMinimumMs + limits.metadataReserveMs,
})
assert.equal(rollbackHashTimeout, limits.sha256MaxTimeoutMs)
const rollbackQuickCheckTimeout = boundedBackupOperationTimeout({
  label: 'rollback_quick_check',
  stageStartedAtMs: start,
  stageTimeoutMs: limits.verifyBackupStageTimeoutMs,
  nowMs: start + rollbackHashTimeout,
  maxTimeoutMs: limits.quickCheckMaxTimeoutMs,
  minimumTimeoutMs: limits.quickCheckMinimumMs,
  reserveAfterMs: limits.metadataReserveMs,
})
assert.equal(rollbackQuickCheckTimeout, limits.quickCheckMaxTimeoutMs)
assert.ok(observedQuickCheckMs < rollbackQuickCheckTimeout)

const planBudget = assertJpOhlcvPlanMaintenanceBudget({
  maximumMaintenanceMs: limits.maximumMaintenanceMs,
  timeouts: {
    createBackupMs: limits.createBackupStageTimeoutMs + limits.commandTerminationGraceMs,
    holdReadServicesMs: 5 * minute,
    publishSourceGenerationMs: limits.simpleStageTimeoutMs,
    verifyDataGenerationMs: limits.simpleStageTimeoutMs,
    verifyServingMs: limits.simpleStageTimeoutMs,
    resumeReadServicesMs: 5 * minute,
    verifyBackupForRollbackMs: limits.verifyBackupStageTimeoutMs + limits.commandTerminationGraceMs,
    restoreBackupMs: limits.rollbackRestoreMaxTimeoutMs,
    verifyOriginalServingMs: limits.simpleStageTimeoutMs,
    forwardDerivedAggregateMs: limits.forwardDerivedAggregateTimeoutMs,
    rollbackDerivedAggregateMs: limits.rollbackDerivedAggregateTimeoutMs,
  },
})
assert.ok(planBudget.forwardMaximumMs < limits.maximumMaintenanceMs)
assert.ok(planBudget.rollbackMaximumMs < limits.maximumMaintenanceMs)
assert.equal(planBudget.forwardMaximumMs, 590 * minute)
assert.equal(planBudget.forwardMaintenanceMaximumMs, 690 * minute)
assert.equal(planBudget.rollbackMaximumMs, 626 * minute)
assert.equal(planBudget.remainingForwardMs, 30 * minute)
assert.equal(planBudget.remainingRollbackMs, 94 * minute)
assert.ok(planBudget.remainingForwardMs >= limits.minimumForwardMaintenanceMarginMs)
assert.ok(planBudget.remainingRollbackMs >= limits.minimumRollbackMaintenanceMarginMs)

console.log('JP OHLCV backup time-budget tests passed')

