import { stableSha256 } from '@/lib/jp-ohlcv-data-quality'
import {
  assertSqliteIntegrityReceipt,
  type SqliteArtifactIdentity,
  type SqliteIntegrityReceipt,
} from '@/lib/storage/sqlite-integrity-contract'

const MINUTE = 60_000
const SHA256 = /^[a-f0-9]{64}$/

export const JP_OHLCV_PRODUCTION_MEASUREMENTS = Object.freeze({
  backupBytes: 551_171_977_216,
  backupCopyMs: 14 * MINUTE + 44_000,
  wholeFileQuickCheckMs: 210 * MINUTE + 24_680,
  sha256Ms: 14 * MINUTE + 7_790,
  derivedRebuildMs: 2_766_000,
})

export const JP_OHLCV_CANDIDATE_TIME_LIMITS = Object.freeze({
  maximumMaintenanceMs: 720 * MINUTE,
  minimumMaintenanceMarginMs: 30 * MINUTE,
  snapshotCloneWriterBarrierMs: 5 * MINUTE,
  prevalidatedSnapshotPreparationMs: 350 * MINUTE,
  writerStopMs: 30 * MINUTE,
  liveSnapshotIdentityMs: 20 * MINUTE,
  cloneAndInitialIdentityMs: 20 * MINUTE,
  residualReproofMs: 5 * MINUTE,
  insertAndDerivedRebuildMs: 100 * MINUTE,
  postWriteWholeFileQuickCheckMs: 265 * MINUTE,
  postWriteSha256Ms: 20 * MINUTE,
  readServiceHoldMs: 5 * MINUTE,
  atomicActivationMs: 5 * MINUTE,
  generationAndSemanticVerificationMs: 30 * MINUTE,
  readServiceResumeMs: 5 * MINUTE,
  rollbackReadServiceHoldMs: 5 * MINUTE,
  postActivationRollbackReserveMs: 30 * MINUTE,
  writerRestoreMs: 60 * MINUTE,
  orchestrationReserveMs: 15 * MINUTE,
  minimumPostActivationRecoveryMarginMs: 90 * MINUTE,
})

export type JpOhlcvSnapshotReuseProof = {
  version: 1
  transactionId: string
  preparedSnapshotReceipt: SqliteIntegrityReceipt
  preparedSnapshotReceiptSha256: string
  liveArtifactAtWriterHold: SqliteArtifactIdentity
  liveIdentityMeasuredAt: string
  writerBarrier: {
    receiptSha256: string
    transactionId: string
    observedAt: string
    sourceGeneration: string
    servingGeneration: string
    heldWriterLabels: string[]
    databaseHandleCount: 0
  }
  sourceSidecarEntries: []
}

export type JpOhlcvCandidateMaintenanceBudget = {
  snapshotPreparationMaximumMs: number
  normalMaintenanceMaximumMs: number
  preActivationFailureMaximumMs: number
  postActivationFailureMaximumMs: number
  remainingNormalMs: number
  remainingPreActivationFailureMs: number
  remainingPostActivationFailureMs: number
}

function sum(values: number[]): number {
  if (!values.every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw new Error('repair_candidate_time_budget_value_invalid')
  }
  const result = values.reduce((total, value) => total + value, 0)
  if (!Number.isSafeInteger(result)) throw new Error('repair_candidate_time_budget_sum_unsafe')
  return result
}

export function assertJpOhlcvSnapshotReuseProof(proof: JpOhlcvSnapshotReuseProof): void {
  assertSqliteIntegrityReceipt(proof.preparedSnapshotReceipt)
  const snapshot = proof.preparedSnapshotReceipt.artifact
  const live = proof.liveArtifactAtWriterHold
  if (proof.version !== 1
    || !proof.transactionId
    || proof.preparedSnapshotReceipt.kind !== 'BACKUP_COMPLETE'
    || proof.preparedSnapshotReceipt.transactionId !== proof.transactionId
    || stableSha256(proof.preparedSnapshotReceipt) !== proof.preparedSnapshotReceiptSha256
    || !SHA256.test(proof.writerBarrier.receiptSha256)
    || proof.writerBarrier.transactionId !== proof.transactionId
    || !Number.isFinite(Date.parse(proof.writerBarrier.observedAt))
    || !Number.isFinite(Date.parse(proof.liveIdentityMeasuredAt))
    || Date.parse(proof.liveIdentityMeasuredAt) < Date.parse(proof.preparedSnapshotReceipt.createdAt)
    || Date.parse(proof.liveIdentityMeasuredAt) < Date.parse(proof.writerBarrier.observedAt)
    || proof.writerBarrier.heldWriterLabels.length === 0
    || new Set(proof.writerBarrier.heldWriterLabels).size !== proof.writerBarrier.heldWriterLabels.length
    || proof.writerBarrier.databaseHandleCount !== 0
    || proof.sourceSidecarEntries.length !== 0
    || proof.writerBarrier.sourceGeneration !== proof.preparedSnapshotReceipt.sourceGeneration
    || proof.writerBarrier.servingGeneration !== proof.preparedSnapshotReceipt.servingGeneration
    || live.sha256 !== snapshot.sha256
    || live.sizeBytes !== snapshot.sizeBytes
    || live.device !== snapshot.device
    || live.inode === snapshot.inode
    || live.realpath === snapshot.realpath) {
    throw new Error('repair_candidate_snapshot_reuse_proof_invalid')
  }
}

export function assertJpOhlcvCandidateMaintenanceBudget(
  limits = JP_OHLCV_CANDIDATE_TIME_LIMITS,
): JpOhlcvCandidateMaintenanceBudget {
  if (!Object.values(limits).every((value) => Number.isSafeInteger(value) && value > 0)
    || limits.minimumMaintenanceMarginMs >= limits.maximumMaintenanceMs
    || limits.minimumPostActivationRecoveryMarginMs >= limits.maximumMaintenanceMs) {
    throw new Error('repair_candidate_time_budget_contract_invalid')
  }
  const beforeActivation = [
    limits.writerStopMs,
    limits.liveSnapshotIdentityMs,
    limits.cloneAndInitialIdentityMs,
    limits.residualReproofMs,
    limits.insertAndDerivedRebuildMs,
    limits.postWriteWholeFileQuickCheckMs,
    limits.postWriteSha256Ms,
  ]
  const publication = [
    limits.readServiceHoldMs,
    limits.atomicActivationMs,
    limits.generationAndSemanticVerificationMs,
    limits.readServiceResumeMs,
  ]
  const finalization = [limits.writerRestoreMs, limits.orchestrationReserveMs]
  const normalMaintenanceMaximumMs = sum([...beforeActivation, ...publication, ...finalization])
  const preActivationFailureMaximumMs = sum([...beforeActivation, ...finalization])
  const postActivationFailureMaximumMs = sum([
    ...beforeActivation,
    limits.readServiceHoldMs,
    limits.atomicActivationMs,
    limits.generationAndSemanticVerificationMs,
    limits.readServiceResumeMs,
    limits.rollbackReadServiceHoldMs,
    limits.postActivationRollbackReserveMs,
    limits.readServiceResumeMs,
    ...finalization,
  ])
  const maximumAllowed = limits.maximumMaintenanceMs - limits.minimumMaintenanceMarginMs
  const paths = {
    normal: normalMaintenanceMaximumMs,
    pre_activation_failure: preActivationFailureMaximumMs,
  }
  for (const [label, value] of Object.entries(paths)) {
    if (value > maximumAllowed) {
      throw new Error(`repair_candidate_maintenance_budget_exceeded:${label}:${value}:${maximumAllowed}`)
    }
  }
  if (postActivationFailureMaximumMs
    > limits.maximumMaintenanceMs - limits.minimumPostActivationRecoveryMarginMs) {
    throw new Error(
      `repair_candidate_maintenance_budget_exceeded:post_activation_failure:${postActivationFailureMaximumMs}:${limits.maximumMaintenanceMs - limits.minimumPostActivationRecoveryMarginMs}`,
    )
  }
  if (JP_OHLCV_PRODUCTION_MEASUREMENTS.backupCopyMs
      + JP_OHLCV_PRODUCTION_MEASUREMENTS.wholeFileQuickCheckMs
      + JP_OHLCV_PRODUCTION_MEASUREMENTS.sha256Ms
    >= limits.prevalidatedSnapshotPreparationMs) {
    throw new Error('repair_candidate_snapshot_preparation_measurement_exceeds_limit')
  }
  if (JP_OHLCV_PRODUCTION_MEASUREMENTS.wholeFileQuickCheckMs
      >= limits.postWriteWholeFileQuickCheckMs
    || JP_OHLCV_PRODUCTION_MEASUREMENTS.sha256Ms >= limits.postWriteSha256Ms
    || JP_OHLCV_PRODUCTION_MEASUREMENTS.sha256Ms >= limits.liveSnapshotIdentityMs
    || JP_OHLCV_PRODUCTION_MEASUREMENTS.sha256Ms >= limits.cloneAndInitialIdentityMs
    || JP_OHLCV_PRODUCTION_MEASUREMENTS.derivedRebuildMs >= limits.insertAndDerivedRebuildMs) {
    throw new Error('repair_candidate_production_measurement_exceeds_stage_limit')
  }
  return {
    snapshotPreparationMaximumMs: limits.prevalidatedSnapshotPreparationMs,
    normalMaintenanceMaximumMs,
    preActivationFailureMaximumMs,
    postActivationFailureMaximumMs,
    remainingNormalMs: limits.maximumMaintenanceMs - normalMaintenanceMaximumMs,
    remainingPreActivationFailureMs: limits.maximumMaintenanceMs - preActivationFailureMaximumMs,
    remainingPostActivationFailureMs: limits.maximumMaintenanceMs - postActivationFailureMaximumMs,
  }
}

