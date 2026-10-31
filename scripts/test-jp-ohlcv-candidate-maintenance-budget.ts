import assert from 'node:assert/strict'
import { stableSha256 } from '@/lib/jp-ohlcv-data-quality'
import {
  assertJpOhlcvCandidateMaintenanceBudget,
  assertJpOhlcvSnapshotReuseProof,
  JP_OHLCV_CANDIDATE_TIME_LIMITS as limits,
  JP_OHLCV_PRODUCTION_MEASUREMENTS as measured,
} from '@/lib/jp-ohlcv-candidate-maintenance-budget'

const minute = 60_000
const budget = assertJpOhlcvCandidateMaintenanceBudget()

assert.equal(limits.maximumMaintenanceMs, 720 * minute)
assert.equal(budget.snapshotPreparationMaximumMs, 350 * minute)
assert.equal(budget.normalMaintenanceMaximumMs, 580 * minute)
assert.equal(budget.preActivationFailureMaximumMs, 535 * minute)
assert.equal(budget.postActivationFailureMaximumMs, 620 * minute)
assert.equal(budget.remainingNormalMs, 140 * minute)
assert.equal(budget.remainingPreActivationFailureMs, 185 * minute)
assert.equal(budget.remainingPostActivationFailureMs, 100 * minute)
assert.ok(budget.remainingNormalMs >= limits.minimumMaintenanceMarginMs)
assert.ok(budget.remainingPostActivationFailureMs >= limits.minimumMaintenanceMarginMs)

assert.ok(measured.backupCopyMs < 30 * minute)
assert.ok(measured.wholeFileQuickCheckMs < limits.postWriteWholeFileQuickCheckMs)
assert.ok(measured.sha256Ms < limits.postWriteSha256Ms)
assert.ok(measured.derivedRebuildMs < limits.insertAndDerivedRebuildMs)

assert.throws(() => assertJpOhlcvCandidateMaintenanceBudget({
  ...limits,
  postWriteWholeFileQuickCheckMs: 310 * minute,
}), /repair_candidate_maintenance_budget_exceeded/)

assert.throws(() => assertJpOhlcvCandidateMaintenanceBudget({
  ...limits,
  minimumPostActivationRecoveryMarginMs: 105 * minute,
}), /repair_candidate_maintenance_budget_exceeded:post_activation_failure/)

assert.throws(() => assertJpOhlcvCandidateMaintenanceBudget({
  ...limits,
  postWriteWholeFileQuickCheckMs: 210 * minute,
}), /repair_candidate_production_measurement_exceeds_stage_limit/)

assert.throws(() => assertJpOhlcvCandidateMaintenanceBudget({
  ...limits,
  maximumMaintenanceMs: Number.NaN,
}), /repair_candidate_time_budget_contract_invalid/)

const snapshotReceipt = {
  version: 1 as const,
  kind: 'BACKUP_COMPLETE' as const,
  transactionId: 'fixture-maintenance',
  createdAt: '2026-10-31T00:00:00.000Z',
  artifact: {
    realpath: '/tmp/snapshot.sqlite',
    device: '42',
    inode: '100',
    sizeBytes: 551_171_977_216,
    mtimeNs: '1',
    ctimeNs: '1',
    sha256: 'a'.repeat(64),
  },
  measurementEvidenceSha256: 'b'.repeat(64),
  parentReceiptSha256: null,
  sqliteCheck: {
    command: 'PRAGMA quick_check;' as const,
    result: 'ok' as const,
    scope: 'WHOLE_FILE_QUICK_CHECK' as const,
    elapsedMs: measured.wholeFileQuickCheckMs,
  },
  sourceGeneration: 'source-fixture',
  servingGeneration: 'serving-fixture',
  guarantees: ['fixture full check'],
  limitations: ['fixture semantic lineage checked separately'],
}
const proof = {
  version: 1 as const,
  transactionId: 'fixture-maintenance',
  preparedSnapshotReceipt: snapshotReceipt,
  preparedSnapshotReceiptSha256: stableSha256(snapshotReceipt),
  liveArtifactAtWriterHold: {
    ...snapshotReceipt.artifact,
    realpath: '/tmp/live.sqlite',
    inode: '101',
  },
  liveIdentityMeasuredAt: '2026-10-31T00:01:00.000Z',
  writerBarrier: {
    receiptSha256: 'c'.repeat(64),
    transactionId: 'fixture-maintenance',
    observedAt: '2026-10-31T00:00:30.000Z',
    sourceGeneration: 'source-fixture',
    servingGeneration: 'serving-fixture',
    heldWriterLabels: ['fixture-writer'],
    databaseHandleCount: 0 as const,
  },
  sourceSidecarEntries: [] as [],
}
assert.doesNotThrow(() => assertJpOhlcvSnapshotReuseProof(proof))
assert.throws(() => assertJpOhlcvSnapshotReuseProof({
  ...proof,
  liveArtifactAtWriterHold: { ...proof.liveArtifactAtWriterHold, sha256: 'd'.repeat(64) },
}), /repair_candidate_snapshot_reuse_proof_invalid/)

console.log('JP OHLCV candidate maintenance budget tests passed')
