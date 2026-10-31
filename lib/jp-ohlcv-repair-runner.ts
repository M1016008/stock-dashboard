import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type {
  JpOhlcvMissingOnlyRepairScope,
  JpOhlcvRuntimeRepairScope,
} from '@/lib/jp-ohlcv-data-quality'
import { stableSha256 } from '@/lib/jp-ohlcv-data-quality'
import {
  assertRepairApproval,
  JpOhlcvProductionRepairTransaction,
  type JpOhlcvRepairApproval,
  type JpOhlcvRepairPaths,
  type JpOhlcvRepairPrewriteCleanupApproval,
  type JpOhlcvRepairResumeServicesApproval,
  type JpOhlcvRepairRollbackApproval,
  type JpOhlcvRollbackFinalizationApproval,
  type JpOhlcvRollbackFinalizationContinuationApproval,
} from '@/lib/jp-ohlcv-production-repair'
import {
  jpOhlcvRepairOwnerEnvironment,
  withJpOhlcvRepairBarrierOwner,
} from '@/lib/jp-ohlcv-repair-barrier'
import { assertJpOhlcvRepairExecutionActive } from '@/lib/jp-ohlcv-repair-process-supervisor'

function fileSha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

export type JpOhlcvRepairExecutionContext = {
  transactionId: string
  lockPath: string
  childEnvironment: NodeJS.ProcessEnv
  recordStageProcessStarted: (input: {
    pid: number
    processGroupId: number
    commandSha256: string
    processIdentitySha256: string
  }) => void
  recordStageProcessStopped: (input: { processGroupId: number; outcome: string }) => void
  assertExecutionActive: () => void
}

export type JpOhlcvRepairAdapter = {
  acquireWriterLock: (context: JpOhlcvRepairExecutionContext) => Promise<{
    owner: string
    heartbeat: () => Promise<void>
    release: () => Promise<void>
  }>
  createAndVerifyConsistentBackup: (context: JpOhlcvRepairExecutionContext) => Promise<{
    databaseRealpath: string
    databaseIdentitySha256: string
    backupRealpath: string
    backupSha256: string
    quickCheck: 'PASS'
    sourceGeneration: string
    servingGeneration: string
  }>
  revalidatePlan: (context: JpOhlcvRepairExecutionContext) => Promise<JpOhlcvRuntimeRepairScope>
  renewRuntimeSnapshotAfterBackup: (
    context: JpOhlcvRepairExecutionContext,
  ) => Promise<{
    runtimeScope: JpOhlcvRuntimeRepairScope
    snapshotSha256: string
    capturedAt: string
    expiresAt: string
    officialSourceProofSha256: string
    officialSourceContractSha256: string
    providerRows: number
    acceptedRows: number
    rejectedRows: number
    noTradeRows: number
    unexpectedRejectedRows: number
    evidencePath: string
    evidenceFileSha256: string
  }>
  assertPreinsertRuntimeSnapshot: (context: JpOhlcvRepairExecutionContext) => Promise<{
    snapshotSha256: string
    checkedAt: string
    expiresAt: string
    remainingValidityMs: number
  }>
  holdReadServices: (context: JpOhlcvRepairExecutionContext) => Promise<{
    web: 'HELD'
    analog: 'HELD'
    snapshotSha256: string
  }>
  insertMissingRowsAtomically: (scope: JpOhlcvRuntimeRepairScope, context: JpOhlcvRepairExecutionContext) => Promise<{
    insertedRows: number
    missingRowsSha256: string
    sourceGeneration: string
  }>
  verifyData: (scope: JpOhlcvRuntimeRepairScope, context: JpOhlcvRepairExecutionContext) => Promise<{
    missingRows: 0
    preservedConflictsSha256: string
    sourceGeneration: string
  }>
  rebuildDerivedServing: (context: JpOhlcvRepairExecutionContext) => Promise<{
    derivedPlanSha256: string
    sourceGeneration: string
    servingGeneration: string
    rebuilt: string[]
  }>
  verifyServing: (context: JpOhlcvRepairExecutionContext) => Promise<{
    sourceGeneration: string
    servingGeneration: string
    health: 'PASS'
  }>
  resumeReadServices: (context: JpOhlcvRepairExecutionContext) => Promise<{
    web: 'PASS'
    analog: 'PASS'
    health: 'PASS'
  }>
}

function stageMayContainDataMutation(stage: ReturnType<JpOhlcvProductionRepairTransaction['currentStage']>): boolean {
  return stage !== null && [
    'READ_SERVICES_HOLDING',
    'DATA_COMMITTING',
    'READ_SERVICES_HELD',
    'PREINSERT_SNAPSHOT_VERIFIED',
    'DATA_COMMITTED',
    'DATA_VERIFIED',
    'DERIVED_REBUILDING',
    'DERIVED_VERIFIED',
    'SERVING_VERIFIED',
    'READ_SERVICES_RESUMING',
    'READ_SERVICES_RESUMED',
    'ROLLBACK_STARTED',
    'ROLLBACK_READ_SERVICES_HOLDING',
    'ROLLBACK_READ_SERVICES_HELD',
    'ROLLBACK_DATA_RESTORED',
    'ROLLBACK_DERIVED_REBUILT',
    'ROLLBACK_SERVING_VERIFIED',
    'ROLLBACK_READ_SERVICES_RESUMING',
    'ROLLBACK_READ_SERVICES_RESUMED',
    'COMMITTED',
  ].includes(stage)
}

export type JpOhlcvRepairRollbackAdapter = {
  acquireWriterLock: (context: JpOhlcvRepairExecutionContext) => Promise<{ owner: string; release: () => Promise<void> }>
  restoreRecoveryRequired: (context: JpOhlcvRepairExecutionContext) => Promise<boolean>
  verifyBackupForRollback: (context: JpOhlcvRepairExecutionContext) => Promise<{
    backupRealpath: string
    backupSha256: string
    quickCheck: 'PASS'
    sourceGeneration: string
    servingGeneration: string
  }>
  holdReadServices: (context: JpOhlcvRepairExecutionContext) => Promise<{
    web: 'HELD'
    analog: 'HELD'
    snapshotSha256: string
  }>
  restoreBackupAtomically: (context: JpOhlcvRepairExecutionContext) => Promise<{
    databaseRealpath: string
    databaseSha256: string
    sourceGeneration: string
    parentRestoredDatabaseSha256ElapsedMs?: number
    parentRestoredDatabaseSha256TimeoutMs?: number
  }>
  rebuildOriginalDerivedServing: (context: JpOhlcvRepairExecutionContext) => Promise<{
    sourceGeneration: string
    servingGeneration: string
    rebuilt: string[]
  }>
  verifyOriginalServing: (context: JpOhlcvRepairExecutionContext) => Promise<{
    sourceGeneration: string
    servingGeneration: string
    health: 'PASS'
  }>
  resumeReadServices: (context: JpOhlcvRepairExecutionContext) => Promise<{
    web: 'PASS'
    analog: 'PASS'
    health: 'PASS'
  }>
}

export type JpOhlcvRepairResumeServicesAdapter = Pick<
  JpOhlcvRepairAdapter,
  'acquireWriterLock' | 'verifyServing' | 'resumeReadServices'
>

export async function runJpOhlcvProductionRepair(input: {
  approval: JpOhlcvRepairApproval
  approvalSha256: string
  scope: JpOhlcvMissingOnlyRepairScope
  paths: JpOhlcvRepairPaths
  adapter: JpOhlcvRepairAdapter
  transactionId?: string
}): Promise<{
  status: 'COMMITTED'
  archivedJournal: string
  dayFullyRepaired: false
  conflictsStillHold: string[]
  approvedRepairKeys: number
  alreadySatisfiedExact: number
  insertedRows: number
}> {
  assertRepairApproval({
    approval: input.approval,
    expectedSha256: input.approvalSha256,
    scope: input.scope,
  })
  const transaction = new JpOhlcvProductionRepairTransaction({
    approval: input.approval,
    approvalSha256: input.approvalSha256,
    paths: input.paths,
    transactionId: input.transactionId,
  })
  transaction.prepare()
  const context: JpOhlcvRepairExecutionContext = {
    transactionId: transaction.transactionId,
    lockPath: input.paths.lock,
    childEnvironment: jpOhlcvRepairOwnerEnvironment({
      transactionId: transaction.transactionId,
      lockPath: input.paths.lock,
    }),
    recordStageProcessStarted: (stageProcess) => transaction.recordStageProcessStarted(stageProcess),
    recordStageProcessStopped: (stageProcess) => transaction.recordStageProcessStopped(stageProcess),
    assertExecutionActive: assertJpOhlcvRepairExecutionActive,
  }
  return withJpOhlcvRepairBarrierOwner(context, async () => {
    let writer: Awaited<ReturnType<JpOhlcvRepairAdapter['acquireWriterLock']>> | null = null
    try {
      context.assertExecutionActive()
      writer = await input.adapter.acquireWriterLock(context)
      context.assertExecutionActive()
      transaction.advance('PREPARED', 'WRITER_LOCKED', { owner: writer.owner })
      const revalidated = await input.adapter.revalidatePlan(context)
      context.assertExecutionActive()
      assertRepairApproval({
        approval: input.approval,
        expectedSha256: input.approvalSha256,
        scope: revalidated,
      })
      const backup = await input.adapter.createAndVerifyConsistentBackup(context)
      context.assertExecutionActive()
      const backupRelative = path.relative(input.approval.backupDirectory, backup.backupRealpath)
      if (backup.databaseRealpath !== input.approval.databaseRealpath
        || backup.databaseIdentitySha256 !== input.approval.databaseIdentitySha256
        || !backupRelative
        || backupRelative === '..'
        || backupRelative.startsWith(`..${path.sep}`)
        || path.isAbsolute(backupRelative)
        || !/^[a-f0-9]{64}$/.test(backup.backupSha256)
        || backup.quickCheck !== 'PASS'
        || backup.sourceGeneration !== input.approval.sourceGenerationBefore
        || backup.servingGeneration !== input.approval.servingGenerationBefore) {
        throw new Error('repair_backup_evidence_mismatch')
      }
      transaction.advance('WRITER_LOCKED', 'BACKUP_VERIFIED', backup)
      await writer.heartbeat()
      context.assertExecutionActive()
      const renewed = await input.adapter.renewRuntimeSnapshotAfterBackup(context)
      context.assertExecutionActive()
      await writer.heartbeat()
      context.assertExecutionActive()
      const evidencePath = path.resolve(renewed.evidencePath)
      const stateDirectory = fs.realpathSync(input.approval.stateDirectory)
      const evidenceStat = fs.lstatSync(evidencePath)
      if (stableSha256(renewed.runtimeScope) !== stableSha256(revalidated)
        || !/^[a-f0-9]{64}$/.test(renewed.snapshotSha256)
        || !/^[a-f0-9]{64}$/.test(renewed.officialSourceProofSha256)
        || !/^[a-f0-9]{64}$/.test(renewed.officialSourceContractSha256)
        || !/^[a-f0-9]{64}$/.test(renewed.evidenceFileSha256)
        || evidenceStat.isSymbolicLink()
        || !evidenceStat.isFile()
        || path.dirname(fs.realpathSync(evidencePath)) !== stateDirectory
        || fileSha256(evidencePath) !== renewed.evidenceFileSha256
        || renewed.providerRows !== renewed.acceptedRows + renewed.rejectedRows
        || renewed.rejectedRows !== renewed.noTradeRows
        || renewed.unexpectedRejectedRows !== 0) {
        throw new Error('repair_runtime_snapshot_renewal_evidence_mismatch')
      }
      transaction.advance('BACKUP_VERIFIED', 'RUNTIME_SNAPSHOT_RENEWED', {
        writerLockOwner: writer.owner,
        backupSha256: backup.backupSha256,
        snapshotSha256: renewed.snapshotSha256,
        capturedAt: renewed.capturedAt,
        expiresAt: renewed.expiresAt,
        officialSourceProofSha256: renewed.officialSourceProofSha256,
        officialSourceContractSha256: renewed.officialSourceContractSha256,
        providerRows: renewed.providerRows,
        acceptedRows: renewed.acceptedRows,
        rejectedRows: renewed.rejectedRows,
        noTradeRows: renewed.noTradeRows,
        unexpectedRejectedRows: renewed.unexpectedRejectedRows,
        evidencePath: renewed.evidencePath,
        evidenceFileSha256: renewed.evidenceFileSha256,
      })
      transaction.advance('RUNTIME_SNAPSHOT_RENEWED', 'READ_SERVICES_HOLDING', {
        requestedAt: new Date().toISOString(),
      })
      const held = await input.adapter.holdReadServices(context)
      context.assertExecutionActive()
      if (held.web !== 'HELD' || held.analog !== 'HELD' || !/^[a-f0-9]{64}$/.test(held.snapshotSha256)) {
        throw new Error('repair_read_service_hold_evidence_mismatch')
      }
      transaction.advance('READ_SERVICES_HOLDING', 'READ_SERVICES_HELD', held)
      const preinsert = await input.adapter.assertPreinsertRuntimeSnapshot(context)
      context.assertExecutionActive()
      if (preinsert.snapshotSha256 !== renewed.snapshotSha256
        || preinsert.expiresAt !== renewed.expiresAt
        || preinsert.remainingValidityMs <= 0) {
        throw new Error('repair_preinsert_runtime_snapshot_evidence_mismatch')
      }
      transaction.advance('READ_SERVICES_HELD', 'PREINSERT_SNAPSHOT_VERIFIED', preinsert)
      transaction.advance('PREINSERT_SNAPSHOT_VERIFIED', 'DATA_COMMITTING', {
        approvedMissingRows: input.approval.expectedMissingRows,
        alreadySatisfiedExactRows: renewed.runtimeScope.alreadySatisfiedRows.length,
        residualMissingRows: renewed.runtimeScope.missingRows.length,
        missingRows: renewed.runtimeScope.missingRows.length,
        missingRowsSha256: renewed.runtimeScope.missingRowsSha256,
      })
      const dataCommit = await input.adapter.insertMissingRowsAtomically(renewed.runtimeScope, context)
      context.assertExecutionActive()
      if (dataCommit.insertedRows !== renewed.runtimeScope.missingRows.length
        || dataCommit.missingRowsSha256 !== renewed.runtimeScope.missingRowsSha256
        || dataCommit.sourceGeneration !== input.approval.sourceGenerationAfter) {
        throw new Error('repair_data_commit_evidence_mismatch')
      }
      transaction.advance('DATA_COMMITTING', 'DATA_COMMITTED', dataCommit)
      const dataVerification = await input.adapter.verifyData(renewed.runtimeScope, context)
      context.assertExecutionActive()
      if (dataVerification.missingRows !== 0
        || dataVerification.preservedConflictsSha256 !== renewed.runtimeScope.preservedConflictsSha256
        || dataVerification.sourceGeneration !== input.approval.sourceGenerationAfter) {
        throw new Error('repair_data_verification_evidence_mismatch')
      }
      transaction.advance('DATA_COMMITTED', 'DATA_VERIFIED', dataVerification)
      transaction.advance('DATA_VERIFIED', 'DERIVED_REBUILDING', {
        derivedPlanSha256: input.approval.derivedPlanSha256,
      })
      const derived = await input.adapter.rebuildDerivedServing(context)
      context.assertExecutionActive()
      if (derived.derivedPlanSha256 !== input.approval.derivedPlanSha256
        || derived.sourceGeneration !== input.approval.sourceGenerationAfter
        || derived.servingGeneration !== input.approval.servingGenerationAfter
        || derived.rebuilt.length === 0) throw new Error('repair_derived_evidence_mismatch')
      transaction.advance('DERIVED_REBUILDING', 'DERIVED_VERIFIED', derived)
      const serving = await input.adapter.verifyServing(context)
      context.assertExecutionActive()
      if (serving.sourceGeneration !== input.approval.sourceGenerationAfter
        || serving.servingGeneration !== input.approval.servingGenerationAfter
        || serving.health !== 'PASS') throw new Error('repair_serving_evidence_mismatch')
      transaction.advance('DERIVED_VERIFIED', 'SERVING_VERIFIED', serving)
      transaction.advance('SERVING_VERIFIED', 'READ_SERVICES_RESUMING', {
        requestedAt: new Date().toISOString(),
      })
      const resumed = await input.adapter.resumeReadServices(context)
      context.assertExecutionActive()
      if (resumed.web !== 'PASS' || resumed.analog !== 'PASS' || resumed.health !== 'PASS') {
        throw new Error('repair_read_service_resume_evidence_mismatch')
      }
      transaction.advance('READ_SERVICES_RESUMING', 'READ_SERVICES_RESUMED', resumed)
      transaction.markCommitted()
      context.assertExecutionActive()
      await writer.release()
      writer = null
      const archivedJournal = transaction.finalizeCommit()
      return {
        status: 'COMMITTED',
        archivedJournal,
        dayFullyRepaired: false,
        conflictsStillHold: [...input.approval.approvedConflictTickers],
        approvedRepairKeys: input.approval.expectedMissingRows,
        alreadySatisfiedExact: renewed.runtimeScope.alreadySatisfiedRows.length,
        insertedRows: dataCommit.insertedRows,
      }
    } catch (error) {
      if (stageMayContainDataMutation(transaction.currentStage())) {
        return transaction.hold(error)
      }
      let failure = error
      if (writer) {
        try {
          await writer.release()
          writer = null
        } catch (releaseError) {
          failure = new AggregateError([error, releaseError], 'repair_failed_and_writer_lock_release_failed')
        }
      }
      return transaction.hold(failure)
    }
  })
}

export function runJpOhlcvProductionRepairPrewriteCleanup(input: {
  approval: JpOhlcvRepairApproval
  approvalSha256: string
  cleanupApproval: JpOhlcvRepairPrewriteCleanupApproval
  cleanupApprovalSha256: string
  paths: JpOhlcvRepairPaths
}): { status: 'ABORTED_PREWRITE'; archivedJournal: string; productionDataMutation: false } {
  const transaction = JpOhlcvProductionRepairTransaction.resumeForPrewriteCleanup(input)
  const archivedJournal = transaction.archivePrewriteHold({
    cleanupApprovalSha256: input.cleanupApprovalSha256,
    writerLockEvidence: input.cleanupApproval.writerLockEvidence,
    writerLockEvidenceSha256: input.cleanupApproval.writerLockEvidenceSha256,
    originalRunnerRecovery: input.cleanupApproval.originalRunnerRecovery,
    reason: input.cleanupApproval.reason,
  })
  return { status: 'ABORTED_PREWRITE', archivedJournal, productionDataMutation: false }
}

export async function runJpOhlcvProductionRepairResumeReadServices(input: {
  approval: JpOhlcvRepairApproval
  approvalSha256: string
  resumeApproval: JpOhlcvRepairResumeServicesApproval
  resumeApprovalSha256: string
  paths: JpOhlcvRepairPaths
  adapter: JpOhlcvRepairResumeServicesAdapter
}): Promise<{ status: 'COMMITTED'; archivedJournal: string; recoveredReadServices: true }> {
  const transaction = JpOhlcvProductionRepairTransaction.resumeForReadServices(input)
  const context: JpOhlcvRepairExecutionContext = {
    transactionId: transaction.transactionId,
    lockPath: input.paths.lock,
    childEnvironment: jpOhlcvRepairOwnerEnvironment({
      transactionId: transaction.transactionId,
      lockPath: input.paths.lock,
    }),
    recordStageProcessStarted: (stageProcess) => transaction.recordStageProcessStarted(stageProcess),
    recordStageProcessStopped: (stageProcess) => transaction.recordStageProcessStopped(stageProcess),
    assertExecutionActive: assertJpOhlcvRepairExecutionActive,
  }
  return withJpOhlcvRepairBarrierOwner(context, async () => {
    let writer: Awaited<ReturnType<JpOhlcvRepairResumeServicesAdapter['acquireWriterLock']>> | null = null
    try {
      context.assertExecutionActive()
      writer = await input.adapter.acquireWriterLock(context)
      context.assertExecutionActive()
      const serving = await input.adapter.verifyServing(context)
      context.assertExecutionActive()
      if (serving.sourceGeneration !== input.resumeApproval.sourceGeneration
        || serving.servingGeneration !== input.resumeApproval.servingGeneration
        || serving.health !== 'PASS') {
        throw new Error('repair_resume_services_serving_revalidation_mismatch')
      }
      transaction.beginReadServicesRecovery({
        resumeApprovalSha256: input.resumeApprovalSha256,
        writerOwner: writer.owner,
        serving,
      })
      transaction.advance('SERVING_VERIFIED', 'READ_SERVICES_RESUMING', {
        requestedAt: new Date().toISOString(),
        recovery: true,
      })
      const resumed = await input.adapter.resumeReadServices(context)
      context.assertExecutionActive()
      if (resumed.web !== 'PASS' || resumed.analog !== 'PASS' || resumed.health !== 'PASS') {
        throw new Error('repair_resume_services_health_mismatch')
      }
      transaction.advance('READ_SERVICES_RESUMING', 'READ_SERVICES_RESUMED', resumed)
      transaction.markCommitted()
      await writer.release()
      writer = null
      const archivedJournal = transaction.finalizeCommit()
      return { status: 'COMMITTED', archivedJournal, recoveredReadServices: true }
    } catch (error) {
      return transaction.hold(error)
    }
  })
}

export async function runJpOhlcvProductionRepairRollback(input: {
  approval: JpOhlcvRepairApproval
  approvalSha256: string
  rollbackApproval: JpOhlcvRepairRollbackApproval
  rollbackApprovalSha256: string
  paths: JpOhlcvRepairPaths
  adapter: JpOhlcvRepairRollbackAdapter
}): Promise<{ status: 'ROLLED_BACK'; archivedJournal: string }> {
  const transaction = JpOhlcvProductionRepairTransaction.resumeForRollback({
    approval: input.approval,
    approvalSha256: input.approvalSha256,
    rollbackApproval: input.rollbackApproval,
    rollbackApprovalSha256: input.rollbackApprovalSha256,
    paths: input.paths,
  })
  const context: JpOhlcvRepairExecutionContext = {
    transactionId: transaction.transactionId,
    lockPath: input.paths.lock,
    childEnvironment: jpOhlcvRepairOwnerEnvironment({
      transactionId: transaction.transactionId,
      lockPath: input.paths.lock,
    }),
    recordStageProcessStarted: (stageProcess) => transaction.recordStageProcessStarted(stageProcess),
    recordStageProcessStopped: (stageProcess) => transaction.recordStageProcessStopped(stageProcess),
    assertExecutionActive: assertJpOhlcvRepairExecutionActive,
  }
  return withJpOhlcvRepairBarrierOwner(context, async () => {
    let writer: Awaited<ReturnType<JpOhlcvRepairRollbackAdapter['acquireWriterLock']>> | null = null
    try {
      context.assertExecutionActive()
      let durableRestoreEvidence = transaction.rollbackDataRestoreEvidence()
      if (await input.adapter.restoreRecoveryRequired(context)) {
        const recovered = await input.adapter.restoreBackupAtomically(context)
        context.assertExecutionActive()
        if (recovered.databaseRealpath !== input.approval.databaseRealpath
          || recovered.databaseSha256 !== input.rollbackApproval.backupSha256
          || recovered.sourceGeneration !== input.rollbackApproval.sourceGenerationTarget) {
          throw new Error('repair_rollback_interrupted_restore_recovery_mismatch')
        }
        durableRestoreEvidence = recovered
      }
      writer = await input.adapter.acquireWriterLock(context)
      context.assertExecutionActive()
      const backup = await input.adapter.verifyBackupForRollback(context)
      context.assertExecutionActive()
      const backupRelative = path.relative(input.approval.backupDirectory, backup.backupRealpath)
      if (!backupRelative
        || backupRelative === '..'
        || backupRelative.startsWith(`..${path.sep}`)
        || path.isAbsolute(backupRelative)
        || !/^[a-f0-9]{64}$/.test(backup.backupSha256)
        || backup.quickCheck !== 'PASS'
        || backup.backupRealpath !== input.rollbackApproval.backupRealpath
        || backup.backupSha256 !== input.rollbackApproval.backupSha256
        || backup.sourceGeneration !== input.rollbackApproval.sourceGenerationTarget
        || backup.servingGeneration !== input.rollbackApproval.servingGenerationTarget) {
        throw new Error('repair_rollback_backup_evidence_mismatch')
      }
      transaction.beginRollback({
        rollbackApprovalSha256: input.rollbackApprovalSha256,
        writerOwner: writer.owner,
        backup,
      })
      transaction.advance('ROLLBACK_STARTED', 'ROLLBACK_READ_SERVICES_HOLDING', {
        requestedAt: new Date().toISOString(),
      })
      const held = await input.adapter.holdReadServices(context)
      context.assertExecutionActive()
      if (held.web !== 'HELD' || held.analog !== 'HELD' || !/^[a-f0-9]{64}$/.test(held.snapshotSha256)) {
        throw new Error('repair_rollback_read_service_hold_evidence_mismatch')
      }
      transaction.advance('ROLLBACK_READ_SERVICES_HOLDING', 'ROLLBACK_READ_SERVICES_HELD', held)
      const restored = durableRestoreEvidence
        ?? await input.adapter.restoreBackupAtomically(context)
      context.assertExecutionActive()
      if (restored.databaseRealpath !== input.approval.databaseRealpath
        || !/^[a-f0-9]{64}$/.test(restored.databaseSha256)
        || restored.databaseSha256 !== backup.backupSha256
        || restored.sourceGeneration !== input.rollbackApproval.sourceGenerationTarget) {
        throw new Error('repair_rollback_restore_evidence_mismatch')
      }
      transaction.advance('ROLLBACK_READ_SERVICES_HELD', 'ROLLBACK_DATA_RESTORED', restored)
      const derived = await input.adapter.rebuildOriginalDerivedServing(context)
      context.assertExecutionActive()
      if (derived.sourceGeneration !== input.rollbackApproval.sourceGenerationTarget
        || derived.servingGeneration !== input.rollbackApproval.servingGenerationTarget
        || derived.rebuilt.length === 0) throw new Error('repair_rollback_derived_evidence_mismatch')
      transaction.advance('ROLLBACK_DATA_RESTORED', 'ROLLBACK_DERIVED_REBUILT', derived)
      const serving = await input.adapter.verifyOriginalServing(context)
      context.assertExecutionActive()
      if (serving.sourceGeneration !== input.rollbackApproval.sourceGenerationTarget
        || serving.servingGeneration !== input.rollbackApproval.servingGenerationTarget
        || serving.health !== 'PASS') throw new Error('repair_rollback_serving_evidence_mismatch')
      transaction.advance('ROLLBACK_DERIVED_REBUILT', 'ROLLBACK_SERVING_VERIFIED', serving)
      transaction.advance('ROLLBACK_SERVING_VERIFIED', 'ROLLBACK_READ_SERVICES_RESUMING', {
        requestedAt: new Date().toISOString(),
      })
      const resumed = await input.adapter.resumeReadServices(context)
      context.assertExecutionActive()
      if (resumed.web !== 'PASS' || resumed.analog !== 'PASS' || resumed.health !== 'PASS') {
        throw new Error('repair_rollback_read_service_resume_evidence_mismatch')
      }
      transaction.advance('ROLLBACK_READ_SERVICES_RESUMING', 'ROLLBACK_READ_SERVICES_RESUMED', resumed)
      await writer.release()
      writer = null
      const archivedJournal = transaction.markRollbackVerified({
        restored,
        derived,
        serving,
        readServices: resumed,
        sourceGeneration: input.rollbackApproval.sourceGenerationTarget,
        servingGeneration: input.rollbackApproval.servingGenerationTarget,
      })
      return { status: 'ROLLED_BACK', archivedJournal }
    } catch (error) {
      // The pre-existing repair state is already uncertain. Retain any acquired
      // writer lock so no subsequent job can observe or extend a partial restore.
      return transaction.hold(error)
    }
  })
}

export async function runJpOhlcvProductionRepairRollbackFinalization(input: {
  approval: JpOhlcvRepairApproval
  approvalSha256: string
  finalizationApproval: JpOhlcvRollbackFinalizationApproval
  finalizationApprovalSha256: string
  continuationApproval?: JpOhlcvRollbackFinalizationContinuationApproval
  continuationApprovalSha256?: string
  continuationWriterRecoveryStateSha256?: string
  paths: JpOhlcvRepairPaths
  readServicesEvidence: Record<string, unknown>
}): Promise<{ status: 'ROLLED_BACK'; archivedJournal: string }> {
  const transaction = JpOhlcvProductionRepairTransaction.resumeForRollbackFinalization({
    approval: input.approval,
    approvalSha256: input.approvalSha256,
    finalizationApproval: input.finalizationApproval,
    finalizationApprovalSha256: input.finalizationApprovalSha256,
    continuationApproval: input.continuationApproval,
    continuationApprovalSha256: input.continuationApprovalSha256,
    continuationWriterRecoveryStateSha256: input.continuationWriterRecoveryStateSha256,
    paths: input.paths,
  })
  const context: JpOhlcvRepairExecutionContext = {
    transactionId: transaction.transactionId,
    lockPath: input.paths.lock,
    childEnvironment: jpOhlcvRepairOwnerEnvironment({
      transactionId: transaction.transactionId,
      lockPath: input.paths.lock,
    }),
    recordStageProcessStarted: (stageProcess) => transaction.recordStageProcessStarted(stageProcess),
    recordStageProcessStopped: (stageProcess) => transaction.recordStageProcessStopped(stageProcess),
    assertExecutionActive: assertJpOhlcvRepairExecutionActive,
  }
  return withJpOhlcvRepairBarrierOwner(context, async () => {
    try {
      context.assertExecutionActive()
      transaction.beginRollbackFinalization({
        finalizationApprovalSha256: input.finalizationApprovalSha256,
        restoredDatabaseSha256: input.finalizationApproval.backupSha256,
        sourceGeneration: input.finalizationApproval.sourceGeneration,
        servingGeneration: input.finalizationApproval.servingGeneration,
      })
      if (transaction.currentStage() === 'ROLLBACK_READ_SERVICES_RESUMING') {
        transaction.advance(
          'ROLLBACK_READ_SERVICES_RESUMING',
          'ROLLBACK_READ_SERVICES_RESUMED',
          input.readServicesEvidence,
        )
      }
      const archivedJournal = transaction.markRollbackVerified({
        finalizationApprovalSha256: input.finalizationApprovalSha256,
        restoredDatabaseSha256: input.finalizationApproval.backupSha256,
        sourceGeneration: input.finalizationApproval.sourceGeneration,
        servingGeneration: input.finalizationApproval.servingGeneration,
        readServices: input.readServicesEvidence,
      })
      return { status: 'ROLLED_BACK', archivedJournal }
    } catch (error) {
      // Finalization begins from an already-restored HOLD. Preserve the exact
      // journal stage for hash-bound continuation; never rewrite it as a new HOLD.
      throw error
    }
  })
}
