import path from 'node:path'
import type { JpOhlcvMissingOnlyRepairScope } from '@/lib/jp-ohlcv-data-quality'
import {
  assertRepairApproval,
  JpOhlcvProductionRepairTransaction,
  type JpOhlcvRepairApproval,
  type JpOhlcvRepairPaths,
  type JpOhlcvRepairRollbackApproval,
} from '@/lib/jp-ohlcv-production-repair'

export type JpOhlcvRepairAdapter = {
  acquireWriterLock: () => Promise<{ owner: string; release: () => Promise<void> }>
  createAndVerifyConsistentBackup: () => Promise<{
    databaseRealpath: string
    backupRealpath: string
    backupSha256: string
    quickCheck: 'PASS'
    sourceGeneration: string
    servingGeneration: string
  }>
  revalidatePlan: () => Promise<JpOhlcvMissingOnlyRepairScope>
  insertMissingRowsAtomically: (scope: JpOhlcvMissingOnlyRepairScope) => Promise<{
    insertedRows: number
    missingRowsSha256: string
    sourceGeneration: string
  }>
  verifyData: (scope: JpOhlcvMissingOnlyRepairScope) => Promise<{
    missingRows: 0
    preservedConflictsSha256: string
    sourceGeneration: string
  }>
  rebuildDerivedServing: () => Promise<{
    derivedPlanSha256: string
    sourceGeneration: string
    servingGeneration: string
    rebuilt: string[]
  }>
  verifyServing: () => Promise<{
    sourceGeneration: string
    servingGeneration: string
    health: 'PASS'
  }>
}

function stageMayContainDataMutation(stage: ReturnType<JpOhlcvProductionRepairTransaction['currentStage']>): boolean {
  return stage !== null && [
    'DATA_COMMITTING',
    'DATA_COMMITTED',
    'DATA_VERIFIED',
    'DERIVED_REBUILDING',
    'DERIVED_VERIFIED',
    'SERVING_VERIFIED',
    'ROLLBACK_STARTED',
    'COMMITTED',
  ].includes(stage)
}

export type JpOhlcvRepairRollbackAdapter = {
  acquireWriterLock: () => Promise<{ owner: string; release: () => Promise<void> }>
  verifyBackupForRollback: () => Promise<{
    backupRealpath: string
    backupSha256: string
    quickCheck: 'PASS'
    sourceGeneration: string
    servingGeneration: string
  }>
  restoreBackupAtomically: () => Promise<{
    databaseRealpath: string
    databaseSha256: string
    sourceGeneration: string
  }>
  rebuildOriginalDerivedServing: () => Promise<{
    sourceGeneration: string
    servingGeneration: string
    rebuilt: string[]
  }>
  verifyOriginalServing: () => Promise<{
    sourceGeneration: string
    servingGeneration: string
    health: 'PASS'
  }>
}

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
  let writer: Awaited<ReturnType<JpOhlcvRepairAdapter['acquireWriterLock']>> | null = null
  try {
    writer = await input.adapter.acquireWriterLock()
    transaction.advance('PREPARED', 'WRITER_LOCKED', { owner: writer.owner })
    const backup = await input.adapter.createAndVerifyConsistentBackup()
    const backupRelative = path.relative(input.approval.backupDirectory, backup.backupRealpath)
    if (backup.databaseRealpath !== input.approval.databaseRealpath
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
    const revalidated = await input.adapter.revalidatePlan()
    assertRepairApproval({
      approval: input.approval,
      expectedSha256: input.approvalSha256,
      scope: revalidated,
    })
    transaction.advance('BACKUP_VERIFIED', 'DATA_COMMITTING', {
      missingRows: revalidated.missingRows.length,
      missingRowsSha256: revalidated.missingRowsSha256,
    })
    const dataCommit = await input.adapter.insertMissingRowsAtomically(revalidated)
    if (dataCommit.insertedRows !== input.approval.expectedMissingRows
      || dataCommit.missingRowsSha256 !== revalidated.missingRowsSha256
      || dataCommit.sourceGeneration !== input.approval.sourceGenerationAfter) {
      throw new Error('repair_data_commit_evidence_mismatch')
    }
    transaction.advance('DATA_COMMITTING', 'DATA_COMMITTED', dataCommit)
    const dataVerification = await input.adapter.verifyData(revalidated)
    if (dataVerification.missingRows !== 0
      || dataVerification.preservedConflictsSha256 !== revalidated.preservedConflictsSha256
      || dataVerification.sourceGeneration !== input.approval.sourceGenerationAfter) {
      throw new Error('repair_data_verification_evidence_mismatch')
    }
    transaction.advance('DATA_COMMITTED', 'DATA_VERIFIED', dataVerification)
    transaction.advance('DATA_VERIFIED', 'DERIVED_REBUILDING', {
      derivedPlanSha256: input.approval.derivedPlanSha256,
    })
    const derived = await input.adapter.rebuildDerivedServing()
    if (derived.derivedPlanSha256 !== input.approval.derivedPlanSha256
      || derived.sourceGeneration !== input.approval.sourceGenerationAfter
      || derived.servingGeneration !== input.approval.servingGenerationAfter
      || derived.rebuilt.length === 0) throw new Error('repair_derived_evidence_mismatch')
    transaction.advance('DERIVED_REBUILDING', 'DERIVED_VERIFIED', derived)
    const serving = await input.adapter.verifyServing()
    if (serving.sourceGeneration !== input.approval.sourceGenerationAfter
      || serving.servingGeneration !== input.approval.servingGenerationAfter
      || serving.health !== 'PASS') throw new Error('repair_serving_evidence_mismatch')
    transaction.advance('DERIVED_VERIFIED', 'SERVING_VERIFIED', serving)
    transaction.markCommitted()
    await writer.release()
    writer = null
    const archivedJournal = transaction.finalizeCommit()
    return {
      status: 'COMMITTED',
      archivedJournal,
      dayFullyRepaired: false,
      conflictsStillHold: [...input.approval.approvedConflictTickers],
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
  let writer: Awaited<ReturnType<JpOhlcvRepairRollbackAdapter['acquireWriterLock']>> | null = null
  try {
    writer = await input.adapter.acquireWriterLock()
    const backup = await input.adapter.verifyBackupForRollback()
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
    const restored = await input.adapter.restoreBackupAtomically()
    if (restored.databaseRealpath !== input.approval.databaseRealpath
      || !/^[a-f0-9]{64}$/.test(restored.databaseSha256)
      || restored.databaseSha256 !== backup.backupSha256
      || restored.sourceGeneration !== input.rollbackApproval.sourceGenerationTarget) {
      throw new Error('repair_rollback_restore_evidence_mismatch')
    }
    const derived = await input.adapter.rebuildOriginalDerivedServing()
    if (derived.sourceGeneration !== input.rollbackApproval.sourceGenerationTarget
      || derived.servingGeneration !== input.rollbackApproval.servingGenerationTarget
      || derived.rebuilt.length === 0) throw new Error('repair_rollback_derived_evidence_mismatch')
    const serving = await input.adapter.verifyOriginalServing()
    if (serving.sourceGeneration !== input.rollbackApproval.sourceGenerationTarget
      || serving.servingGeneration !== input.rollbackApproval.servingGenerationTarget
      || serving.health !== 'PASS') throw new Error('repair_rollback_serving_evidence_mismatch')
    await writer.release()
    writer = null
    const archivedJournal = transaction.markRollbackVerified({
      restored,
      derived,
      serving,
      sourceGeneration: input.rollbackApproval.sourceGenerationTarget,
      servingGeneration: input.rollbackApproval.servingGenerationTarget,
    })
    return { status: 'ROLLED_BACK', archivedJournal }
  } catch (error) {
    // The pre-existing repair state is already uncertain. Retain any acquired
    // writer lock so no subsequent job can observe or extend a partial restore.
    return transaction.hold(error)
  }
}
