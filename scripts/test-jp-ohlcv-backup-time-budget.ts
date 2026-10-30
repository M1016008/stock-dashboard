import assert from 'node:assert/strict'

import {
  assertJpOhlcvBackupMaintenanceBudget,
  assertJpOhlcvPlanMaintenanceBudget,
  boundedBackupOperationTimeout,
  JP_OHLCV_BACKUP_TIME_LIMITS as limits,
} from '@/lib/jp-ohlcv-backup-time-budget'

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
assert.equal(copyTimeout, 60 * minute)

// Production copied 551,171,977,216 bytes in about 14m44s. A full quick_check
// still receives the complete 150-minute allowance after that observed copy.
const afterObservedCopyAndNormalize = start + (14 * minute + 44_000) + minute
const quickCheckTimeout = boundedBackupOperationTimeout({
  label: 'quick_check',
  stageStartedAtMs: start,
  stageTimeoutMs: limits.createBackupStageTimeoutMs,
  nowMs: afterObservedCopyAndNormalize,
  maxTimeoutMs: limits.quickCheckMaxTimeoutMs,
  minimumTimeoutMs: limits.quickCheckMinimumMs,
  reserveAfterMs: limits.sha256MinimumMs + limits.metadataReserveMs,
})
assert.equal(quickCheckTimeout, 150 * minute)
assert.ok(31 * minute < quickCheckTimeout, 'a quick_check longer than 30 minutes must remain valid')

// Even after the full quick_check allowance, hashing retains a bounded window.
const shaTimeout = boundedBackupOperationTimeout({
  label: 'sha256',
  stageStartedAtMs: start,
  stageTimeoutMs: limits.createBackupStageTimeoutMs,
  nowMs: afterObservedCopyAndNormalize + quickCheckTimeout,
  maxTimeoutMs: limits.sha256MaxTimeoutMs,
  minimumTimeoutMs: limits.sha256MinimumMs,
  reserveAfterMs: limits.metadataReserveMs,
})
assert.ok(shaTimeout >= limits.sha256MinimumMs)

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
assert.equal(rollbackQuickCheckTimeout, 145 * minute)
assert.ok(rollbackQuickCheckTimeout > 30 * minute)

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
assert.ok(planBudget.remainingForwardMs >= 45 * minute)
assert.ok(planBudget.remainingRollbackMs >= 3 * 60 * minute)

console.log('JP OHLCV backup time-budget tests passed')

