import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  assessJpOhlcvConflictLineage,
  buildJpOhlcvBackfillPlan,
  buildJpOhlcvMissingOnlyRepairScope,
  stableSha256,
  type JpOfficialOhlcvValue,
  type JpOhlcvValue,
} from '@/lib/jp-ohlcv-data-quality'
import {
  runJpOhlcvProductionRepair,
  runJpOhlcvProductionRepairRollback,
  type JpOhlcvRepairAdapter,
} from '@/lib/jp-ohlcv-repair-runner'
import {
  assertNoIncompleteRepair,
  repairApprovalSha256,
  repairRollbackApprovalSha256,
  JpOhlcvProductionRepairTransaction,
  type JpOhlcvRepairApproval,
  type JpOhlcvRepairPaths,
  type JpOhlcvRepairRollbackApproval,
} from '@/lib/jp-ohlcv-production-repair'
import { jpOhlcvRepairBarrierDecision } from '@/lib/jp-ohlcv-repair-barrier'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-ohlcv-production-repair-'))
Object.assign(process.env, { NODE_ENV: 'test' })
const official: JpOfficialOhlcvValue[] = [
  { ticker: '1306', date: '2026-07-17', open: 400, high: 410, low: 399, close: 407.9, volume: 10, adjustmentFactor: 1 },
  { ticker: '7003', date: '2026-07-17', open: 4400, high: 4500, low: 4300, close: 4434, volume: 20, adjustmentFactor: 1 },
  { ticker: '1447', date: '2026-07-17', open: 273.7, high: 285.1, low: 267, close: 270.4, volume: 30, adjustmentFactor: 1 },
]
const existing: JpOhlcvValue[] = [
  { ticker: '1447', date: '2026-07-17', open: 273.5, high: 284.9, low: 266.8, close: 270.2, volume: 30 },
]
const plan = buildJpOhlcvBackfillPlan({ date: '2026-07-17', officialRows: official, existingRows: existing })
const scope = buildJpOhlcvMissingOnlyRepairScope({ plan, approvedConflictTickers: ['1447'] })
assert.equal(scope.status, 'READY')
assert.equal(scope.missingRows.length, 2)
assert.deepEqual(assessJpOhlcvConflictLineage({
  existing: existing[0],
  currentOfficial: official[2],
  laterAdjustmentFactors: [0.6675675675675675],
}), {
    classification: 'UNRESOLVED_VALUE_CONFLICT',
  disposition: 'PRESERVE_EXISTING_HOLD',
  volumeMatches: true,
  laterCorporateActionObserved: true,
    priceRevisionConsistent: false,
    requiresFullHistoryRebase: false,
})
const paths = (name: string): JpOhlcvRepairPaths => {
  const stateDirectory = path.join(root, name)
  return {
    stateDirectory,
    journal: path.join(stateDirectory, 'repair-journal.json'),
    lock: path.join(stateDirectory, 'repair.lock'),
  }
}
const approvalFor = (name: string): JpOhlcvRepairApproval => ({
  version: 1,
  executionScope: 'ISOLATED_FIXTURE',
  targetDate: scope.date,
  officialSha256: scope.officialSha256,
  planSha256: scope.planSha256,
  missingRowsSha256: scope.missingRowsSha256,
  preservedConflictsSha256: scope.preservedConflictsSha256,
  expectedOfficialRows: plan.officialRows,
  expectedExistingRows: plan.existingRows,
  expectedMatchingRows: plan.matchingRows,
  expectedMissingRows: scope.missingRows.length,
  approvedConflictTickers: ['1447'],
  conflictDisposition: 'PRESERVE_EXISTING_HOLD',
  databaseRealpath: path.join(root, `${name}.db`),
  stateDirectory: paths(name).stateDirectory,
  backupDirectory: path.join(root, `${name}-backup`),
  sourceGenerationBefore: 'jp-source-before',
  sourceGenerationAfter: 'jp-source-after',
  servingGenerationBefore: 'jp-serving-before',
  servingGenerationAfter: 'jp-serving-after',
  derivedPlanSha256: stableSha256({ commands: ['fixture-derived'] }),
})

function adapter(approval: JpOhlcvRepairApproval, overrides: Partial<JpOhlcvRepairAdapter> = {}): JpOhlcvRepairAdapter {
  let rows = existing.map((row) => ({ ...row }))
  return {
    acquireWriterLock: async () => ({ owner: 'fixture-owner', release: async () => undefined }),
    createAndVerifyConsistentBackup: async () => ({
      databaseRealpath: approval.databaseRealpath,
      backupRealpath: path.join(approval.backupDirectory, 'jp.db'),
      quickCheck: 'PASS',
      backupSha256: stableSha256(rows),
      sourceGeneration: 'jp-source-before',
      servingGeneration: 'jp-serving-before',
    }),
    revalidatePlan: async () => scope,
    insertMissingRowsAtomically: async (current) => {
      rows = [...rows, ...current.missingRows.map(({ adjustmentFactor: _factor, ...row }) => row)]
      return {
        insertedRows: current.missingRows.length,
        missingRowsSha256: current.missingRowsSha256,
        sourceGeneration: 'jp-source-after',
      }
    },
    verifyData: async () => {
      const after = buildJpOhlcvBackfillPlan({ date: scope.date, officialRows: official, existingRows: rows })
      assert.equal(after.missingRows.length, 0)
      assert.equal(after.conflicts.length, 1)
      assert.deepEqual(after.conflicts[0].existing, existing[0])
      return {
        missingRows: 0 as const,
        preservedConflictsSha256: scope.preservedConflictsSha256,
        sourceGeneration: 'jp-source-after',
      }
    },
    rebuildDerivedServing: async () => ({
      derivedPlanSha256: approval.derivedPlanSha256,
      sourceGeneration: 'jp-source-after',
      servingGeneration: 'jp-serving-after',
      rebuilt: ['fixture-derived'],
    }),
    verifyServing: async () => ({
      sourceGeneration: 'jp-source-after',
      servingGeneration: 'jp-serving-after',
      health: 'PASS',
    }),
    ...overrides,
  }
}

async function main(): Promise<void> {
{
  const barrier = paths('barrier')
  fs.mkdirSync(barrier.stateDirectory, { recursive: true })
  fs.writeFileSync(barrier.lock, `${JSON.stringify({ transactionId: 'repair-owner' })}\n`)
  assert.equal(jpOhlcvRepairBarrierDecision({
    jobType: 'update_latest',
    environment: { NODE_ENV: 'test', STOCKBOARD_JP_OHLCV_REPAIR_LOCK_PATH: barrier.lock },
  }).blocked, true)
  assert.equal(jpOhlcvRepairBarrierDecision({
    jobType: 'jp_ohlcv_gap_repair',
    environment: {
      NODE_ENV: 'test',
      STOCKBOARD_JP_OHLCV_REPAIR_LOCK_PATH: barrier.lock,
      STOCKBOARD_JP_OHLCV_REPAIR_TRANSACTION_ID: 'repair-owner',
    },
  }).blocked, false)
  assert.equal(jpOhlcvRepairBarrierDecision({
    jobType: 'jp_ohlcv_gap_repair',
    environment: {
      NODE_ENV: 'test',
      STOCKBOARD_JP_OHLCV_REPAIR_LOCK_PATH: barrier.lock,
      STOCKBOARD_JP_OHLCV_REPAIR_TRANSACTION_ID: 'wrong-owner',
    },
  }).blocked, true)
}
{
  const approval = approvalFor('success')
  const result = await runJpOhlcvProductionRepair({
    approval,
    approvalSha256: repairApprovalSha256(approval),
    scope,
    paths: paths('success'),
    adapter: adapter(approval),
    transactionId: 'success',
  })
  assert.equal(result.status, 'COMMITTED')
  assert.ok(fs.existsSync(result.archivedJournal))
  assert.doesNotThrow(() => assertNoIncompleteRepair(paths('success')))
}

for (const [name, override, expectedStage] of [
  ['backup-failure', { createAndVerifyConsistentBackup: async () => { throw new Error('backup_failed') } }, 'WRITER_LOCKED'],
  ['insert-crash', { insertMissingRowsAtomically: async () => { throw new Error('SIGKILL_fixture') } }, 'DATA_COMMITTING'],
  ['derived-failure', { rebuildDerivedServing: async () => { throw new Error('derived_failed') } }, 'DERIVED_REBUILDING'],
] as const) {
  const approval = approvalFor(name)
  await assert.rejects(runJpOhlcvProductionRepair({
    approval,
    approvalSha256: repairApprovalSha256(approval),
    scope,
    paths: paths(name),
    adapter: adapter(approval, override),
    transactionId: name,
  }))
  const journal = JSON.parse(fs.readFileSync(paths(name).journal, 'utf8'))
  assert.equal(journal.stage, 'HOLD')
  assert.equal(journal.failure.originalStage, expectedStage)
  assert.throws(() => assertNoIncompleteRepair(paths(name)), /manual_recovery/)
}

{
  const approval = approvalFor('release-failure')
  await assert.rejects(runJpOhlcvProductionRepair({
    approval,
    approvalSha256: repairApprovalSha256(approval),
    scope,
    paths: paths('release-failure'),
    adapter: adapter(approval, {
      acquireWriterLock: async () => ({
        owner: 'fixture-owner',
        release: async () => { throw new Error('writer_release_failed') },
      }),
    }),
    transactionId: 'release-failure',
  }), /writer_release_failed/)
  const journal = JSON.parse(fs.readFileSync(paths('release-failure').journal, 'utf8'))
  assert.equal(journal.stage, 'HOLD')
  assert.equal(journal.failure.originalStage, 'COMMITTED')
}

{
  const approval = approvalFor('duplicate')
  const first = runJpOhlcvProductionRepair({
    approval,
    approvalSha256: repairApprovalSha256(approval),
    scope,
    paths: paths('duplicate'),
    adapter: adapter(approval, { createAndVerifyConsistentBackup: async () => { throw new Error('keep_hold') } }),
    transactionId: 'duplicate-first',
  })
  await assert.rejects(first)
  await assert.rejects(runJpOhlcvProductionRepair({
    approval,
    approvalSha256: repairApprovalSha256(approval),
    scope,
    paths: paths('duplicate'),
    adapter: adapter(approval),
    transactionId: 'duplicate-second',
  }), /manual_recovery/)
}

{
  const approval = approvalFor('hash-mismatch')
  await assert.rejects(runJpOhlcvProductionRepair({
    approval,
    approvalSha256: '0'.repeat(64),
    scope,
    paths: paths('hash-mismatch'),
    adapter: adapter(approval),
  }), /approval_hash_mismatch/)
  assert.equal(fs.existsSync(paths('hash-mismatch').journal), false)
  assert.equal(fs.existsSync(paths('hash-mismatch').lock), false)
}

{
  const approval = approvalFor('tampered-scope')
  const tampered = {
    ...scope,
    missingRows: scope.missingRows.map((row, index) => index === 0 ? { ...row, close: row.close + 1 } : row),
  }
  await assert.rejects(runJpOhlcvProductionRepair({
    approval,
    approvalSha256: repairApprovalSha256(approval),
    scope: tampered,
    paths: paths('tampered-scope'),
    adapter: adapter(approval),
  }), /scope_content_hash_mismatch/)
  assert.equal(fs.existsSync(paths('tampered-scope').journal), false)
}

{
  const approval = approvalFor('post-write-lock-retained')
  let releases = 0
  await assert.rejects(runJpOhlcvProductionRepair({
    approval,
    approvalSha256: repairApprovalSha256(approval),
    scope,
    paths: paths('post-write-lock-retained'),
    adapter: adapter(approval, {
      acquireWriterLock: async () => ({
        owner: 'fixture-retained-writer',
        release: async () => { releases += 1 },
      }),
      insertMissingRowsAtomically: async () => { throw new Error('SIGKILL_after_sqlite_commit_unknown') },
    }),
  }), /SIGKILL_after_sqlite_commit_unknown/)
  assert.equal(releases, 0)
  const journal = JSON.parse(fs.readFileSync(paths('post-write-lock-retained').journal, 'utf8'))
  assert.equal(journal.stage, 'HOLD')
  assert.equal(journal.failure.originalStage, 'DATA_COMMITTING')
}

{
  const approval = approvalFor('conflict-mismatch')
  approval.approvedConflictTickers = ['2164']
  await assert.rejects(runJpOhlcvProductionRepair({
    approval,
    approvalSha256: repairApprovalSha256(approval),
    scope,
    paths: paths('conflict-mismatch'),
    adapter: adapter(approval),
  }), /conflict_set_mismatch/)
}

{
  const name = 'sigkill-after-data-commit'
  const approval = approvalFor(name)
  const approvalSha256 = repairApprovalSha256(approval)
  const repairPaths = paths(name)
  const database = approval.databaseRealpath
  const backup = path.join(approval.backupDirectory, 'jp.db.backup')
  fs.mkdirSync(approval.backupDirectory, { recursive: true })
  fs.writeFileSync(database, 'before-generation\n')
  fs.copyFileSync(database, backup)
  const beforeHash = stableSha256(fs.readFileSync(database))
  const transaction = new JpOhlcvProductionRepairTransaction({
    approval,
    approvalSha256,
    paths: repairPaths,
    transactionId: name,
  })
  transaction.prepare()
  transaction.advance('PREPARED', 'WRITER_LOCKED', { owner: 'fixture-crashed-writer' })
  transaction.advance('WRITER_LOCKED', 'BACKUP_VERIFIED', {
    backupRealpath: backup,
    backupSha256: beforeHash,
  })
  fs.writeFileSync(database, 'partially-promoted-generation\n')
  transaction.advance('BACKUP_VERIFIED', 'DATA_COMMITTED', {
    afterHash: stableSha256(fs.readFileSync(database)),
  })

  const journal = JSON.parse(fs.readFileSync(repairPaths.journal, 'utf8'))
  const rollbackApproval: JpOhlcvRepairRollbackApproval = {
    version: 1,
    action: 'ROLLBACK',
    repairApprovalSha256: approvalSha256,
    journalSha256: stableSha256(journal),
    transactionId: name,
    databaseRealpath: database,
    backupDirectory: approval.backupDirectory,
    backupRealpath: backup,
    backupSha256: beforeHash,
    sourceGenerationTarget: approval.sourceGenerationBefore,
    servingGenerationTarget: approval.servingGenerationBefore,
    reason: 'fixture operator approval after simulated SIGKILL',
  }
  const rollbackApprovalSha256 = repairRollbackApprovalSha256(rollbackApproval)
  const rollback = await runJpOhlcvProductionRepairRollback({
    approval,
    approvalSha256,
    rollbackApproval,
    rollbackApprovalSha256,
    paths: repairPaths,
    adapter: {
      acquireWriterLock: async () => ({ owner: 'fixture-recovery-writer', release: async () => undefined }),
      verifyBackupForRollback: async () => {
        assert.equal(stableSha256(fs.readFileSync(backup)), beforeHash)
        return {
          backupRealpath: backup,
          backupSha256: beforeHash,
          quickCheck: 'PASS',
          sourceGeneration: approval.sourceGenerationBefore,
          servingGeneration: approval.servingGenerationBefore,
        }
      },
      restoreBackupAtomically: async () => {
        fs.copyFileSync(backup, database)
        return {
          databaseRealpath: database,
          databaseSha256: stableSha256(fs.readFileSync(database)),
          sourceGeneration: approval.sourceGenerationBefore,
        }
      },
      rebuildOriginalDerivedServing: async () => ({
        sourceGeneration: approval.sourceGenerationBefore,
        servingGeneration: approval.servingGenerationBefore,
        rebuilt: ['fixture-derived'],
      }),
      verifyOriginalServing: async () => ({
        sourceGeneration: approval.sourceGenerationBefore,
        servingGeneration: approval.servingGenerationBefore,
        health: 'PASS',
      }),
    },
  })
  assert.equal(rollback.status, 'ROLLED_BACK')
  assert.equal(stableSha256(fs.readFileSync(database)), beforeHash)
  assert.doesNotThrow(() => assertNoIncompleteRepair(repairPaths))
}

{
  const name = 'rollback-journal-mismatch'
  const approval = approvalFor(name)
  const approvalSha256 = repairApprovalSha256(approval)
  const repairPaths = paths(name)
  const transaction = new JpOhlcvProductionRepairTransaction({ approval, approvalSha256, paths: repairPaths, transactionId: name })
  transaction.prepare()
  const rollbackApproval: JpOhlcvRepairRollbackApproval = {
    version: 1,
    action: 'ROLLBACK',
    repairApprovalSha256: approvalSha256,
    journalSha256: '0'.repeat(64),
    transactionId: name,
    databaseRealpath: approval.databaseRealpath,
    backupDirectory: approval.backupDirectory,
    backupRealpath: path.join(approval.backupDirectory, 'unknown.db'),
    backupSha256: '0'.repeat(64),
    sourceGenerationTarget: approval.sourceGenerationBefore,
    servingGenerationTarget: approval.servingGenerationBefore,
    reason: 'fixture mismatch must fail closed',
  }
  await assert.rejects(runJpOhlcvProductionRepairRollback({
    approval,
    approvalSha256,
    rollbackApproval,
    rollbackApprovalSha256: repairRollbackApprovalSha256(rollbackApproval),
    paths: repairPaths,
    adapter: {
      acquireWriterLock: async () => { throw new Error('must_not_run') },
      verifyBackupForRollback: async () => { throw new Error('must_not_run') },
      restoreBackupAtomically: async () => { throw new Error('must_not_run') },
      rebuildOriginalDerivedServing: async () => { throw new Error('must_not_run') },
      verifyOriginalServing: async () => { throw new Error('must_not_run') },
    },
  }), /rollback_approval_state_mismatch/)
}

console.log('JP OHLCV Production repair transaction tests: PASS')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
