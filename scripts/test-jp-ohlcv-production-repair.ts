import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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
  runJpOhlcvProductionRepairPrewriteCleanup,
  runJpOhlcvProductionRepairResumeReadServices,
  runJpOhlcvProductionRepairRollback,
  type JpOhlcvRepairAdapter,
} from '@/lib/jp-ohlcv-repair-runner'
import {
  assertNoIncompleteRepair,
  inspectJpOhlcvProductionRepair,
  repairApprovalSha256,
  repairPrewriteCleanupApprovalSha256,
  repairResumeServicesApprovalSha256,
  repairRollbackApprovalSha256,
  JpOhlcvProductionRepairTransaction,
  type JpOhlcvRepairApproval,
  type JpOhlcvRepairPaths,
  type JpOhlcvRepairPrewriteCleanupApproval,
  type JpOhlcvRepairResumeServicesApproval,
  type JpOhlcvRepairRollbackApproval,
  type JpOhlcvRepairRunnerRecovery,
} from '@/lib/jp-ohlcv-production-repair'
import {
  jpOhlcvRepairBarrierDecision,
  withJpOhlcvRepairBarrierOwner,
} from '@/lib/jp-ohlcv-repair-barrier'

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
const markOriginalRunnerStopped = (repairPaths: JpOhlcvRepairPaths): void => {
  const lock = JSON.parse(fs.readFileSync(repairPaths.lock, 'utf8'))
  fs.writeFileSync(repairPaths.lock, `${JSON.stringify({
    ...lock,
    pid: 999_998,
    processGroupId: 999_998,
    processIdentitySha256: 'c'.repeat(64),
  })}\n`)
}
const runnerRecoveryFor = (repairPaths: JpOhlcvRepairPaths): JpOhlcvRepairRunnerRecovery => {
  const lock = JSON.parse(fs.readFileSync(repairPaths.lock, 'utf8'))
  return {
    pid: Number(lock.pid),
    processGroupId: Number(lock.processGroupId),
    processIdentitySha256: String(lock.processIdentitySha256),
    observedState: 'PID_ABSENT',
    confirmedStoppedAt: new Date().toISOString(),
    reason: 'fixture confirms the exact recorded runner identity is absent',
  }
}
const fileSha256 = (file: string): string => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
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
  databaseIdentitySha256: stableSha256({ fixture: name, schema: 'ohlcv_daily-v1' }),
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
      databaseIdentitySha256: approval.databaseIdentitySha256,
      backupRealpath: path.join(approval.backupDirectory, 'jp.db'),
      quickCheck: 'PASS',
      backupSha256: stableSha256(rows),
      sourceGeneration: 'jp-source-before',
      servingGeneration: 'jp-serving-before',
    }),
    revalidatePlan: async () => scope,
    holdReadServices: async () => ({
      web: 'HELD',
      analog: 'HELD',
      snapshotSha256: stableSha256({ web: 'fixture', analog: 'fixture' }),
    }),
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
    resumeReadServices: async () => ({ web: 'PASS', analog: 'PASS', health: 'PASS' }),
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
      STOCKBOARD_JP_OHLCV_REPAIR_OWNER: '1',
      STOCKBOARD_JP_OHLCV_REPAIR_TRANSACTION_ID: 'repair-owner',
      STOCKBOARD_UPDATE_JOB_TYPE: 'jp_ohlcv_gap_repair',
    },
  }).blocked, false)
  assert.equal(jpOhlcvRepairBarrierDecision({
    jobType: 'database_write',
    environment: {
      NODE_ENV: 'test',
      STOCKBOARD_JP_OHLCV_REPAIR_LOCK_PATH: barrier.lock,
      STOCKBOARD_JP_OHLCV_REPAIR_OWNER: '1',
      STOCKBOARD_JP_OHLCV_REPAIR_TRANSACTION_ID: 'repair-owner',
      STOCKBOARD_UPDATE_JOB_TYPE: 'jp_ohlcv_gap_repair',
    },
  }).blocked, false)
  assert.equal(jpOhlcvRepairBarrierDecision({
    jobType: 'jp_ohlcv_gap_repair',
    environment: {
      NODE_ENV: 'test',
      STOCKBOARD_JP_OHLCV_REPAIR_LOCK_PATH: barrier.lock,
      STOCKBOARD_JP_OHLCV_REPAIR_OWNER: '1',
      STOCKBOARD_JP_OHLCV_REPAIR_TRANSACTION_ID: 'wrong-owner',
      STOCKBOARD_UPDATE_JOB_TYPE: 'jp_ohlcv_gap_repair',
    },
  }).blocked, true)
  assert.equal(jpOhlcvRepairBarrierDecision({
    jobType: 'update_latest',
    environment: {
      NODE_ENV: 'production',
      STOCKBOARD_JP_OHLCV_REPAIR_LOCK_PATH: barrier.lock,
    },
  }).reason, 'repair_lock_path_override_forbidden')
}
{
  const barrier = paths('database-write-barrier')
  const database = path.join(root, 'database-write-barrier.db')
  fs.mkdirSync(barrier.stateDirectory, { recursive: true })
  Object.assign(process.env, {
    USE_LOCAL_DB: '1',
    STOCKBOARD_DB_PATH: database,
    STOCKBOARD_JP_OHLCV_REPAIR_LOCK_PATH: barrier.lock,
    SKIP_SCHEMA_ENSURE: '1',
  })
  const { client, closeLocalClientBeforeExternalWriter } = await import('@/lib/db/client')
  await client.execute('CREATE TABLE barrier_fixture (value INTEGER NOT NULL)')
  fs.writeFileSync(barrier.lock, `${JSON.stringify({ transactionId: 'database-owner' })}\n`)
  assert.throws(
    () => client.execute('INSERT INTO barrier_fixture(value) VALUES (1)'),
    /JP OHLCV repair is active or requires recovery/,
  )
  assert.throws(() => client.transaction('write'), /JP OHLCV repair is active or requires recovery/)
  await withJpOhlcvRepairBarrierOwner({
    transactionId: 'database-owner',
    lockPath: barrier.lock,
  }, async () => {
    await client.execute('INSERT INTO barrier_fixture(value) VALUES (2)')
    const transaction = await client.transaction('write')
    await transaction.execute('INSERT INTO barrier_fixture(value) VALUES (3)')
    await transaction.commit()
  })
  const result = await client.execute('SELECT value FROM barrier_fixture ORDER BY value')
  assert.deepEqual(result.rows.map((row) => Number(row.value)), [2, 3])
  await closeLocalClientBeforeExternalWriter()
  const { openExistingGuardedClient } = await import('@/lib/storage/guarded-libsql-client')
  const guardedClient = openExistingGuardedClient(database, 'batch-ohlcv-direct-writer')
  assert.throws(
    () => guardedClient.execute('INSERT INTO barrier_fixture(value) VALUES (4)'),
    /JP OHLCV repair is active or requires recovery/,
  )
  await withJpOhlcvRepairBarrierOwner({
    transactionId: 'database-owner',
    lockPath: barrier.lock,
  }, async () => {
    await guardedClient.execute('INSERT INTO barrier_fixture(value) VALUES (5)')
  })
  guardedClient.close()
  delete process.env.STOCKBOARD_JP_OHLCV_REPAIR_LOCK_PATH
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
  ['service-hold-failure', { holdReadServices: async () => { throw new Error('service_hold_failed') } }, 'READ_SERVICES_HOLDING'],
  ['insert-crash', { insertMissingRowsAtomically: async () => { throw new Error('SIGKILL_fixture') } }, 'DATA_COMMITTING'],
  ['derived-failure', { rebuildDerivedServing: async () => { throw new Error('derived_failed') } }, 'DERIVED_REBUILDING'],
  ['service-resume-failure', { resumeReadServices: async () => { throw new Error('service_resume_failed') } }, 'READ_SERVICES_RESUMING'],
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
  assert.deepEqual(journal.failure.causes.map((cause: { message: string }) => cause.message), [
    'writer_release_failed',
  ])
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
  transaction.recordStageProcessStarted({
    pid: 999_999,
    processGroupId: 999_999,
    commandSha256: 'a'.repeat(64),
    processIdentitySha256: 'b'.repeat(64),
  })

  const journal = JSON.parse(fs.readFileSync(repairPaths.journal, 'utf8'))
  markOriginalRunnerStopped(repairPaths)
  const rollbackApprovalWithoutProcessRecovery: JpOhlcvRepairRollbackApproval = {
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
    originalRunnerRecovery: runnerRecoveryFor(repairPaths),
  }
  await assert.rejects(async () => {
    JpOhlcvProductionRepairTransaction.resumeForRollback({
      approval,
      approvalSha256,
      rollbackApproval: rollbackApprovalWithoutProcessRecovery,
      rollbackApprovalSha256: repairRollbackApprovalSha256(rollbackApprovalWithoutProcessRecovery),
      paths: repairPaths,
    })
  }, /stage_process_exact_recovery_approval_required/)
  const rollbackApproval: JpOhlcvRepairRollbackApproval = {
    ...rollbackApprovalWithoutProcessRecovery,
    staleStageProcessRecovery: {
      pid: 999_999,
      processGroupId: 999_999,
      commandSha256: 'a'.repeat(64),
      processIdentitySha256: 'b'.repeat(64),
      confirmedStoppedAt: new Date().toISOString(),
      reason: 'fixture process group confirmed absent after simulated parent SIGKILL',
    },
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
      holdReadServices: async () => ({
        web: 'HELD',
        analog: 'HELD',
        snapshotSha256: stableSha256({ web: 'rollback-fixture', analog: 'rollback-fixture' }),
      }),
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
      resumeReadServices: async () => ({ web: 'PASS', analog: 'PASS', health: 'PASS' }),
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
    originalRunnerRecovery: runnerRecoveryFor(repairPaths),
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
      holdReadServices: async () => { throw new Error('must_not_run') },
      restoreBackupAtomically: async () => { throw new Error('must_not_run') },
      rebuildOriginalDerivedServing: async () => { throw new Error('must_not_run') },
      verifyOriginalServing: async () => { throw new Error('must_not_run') },
      resumeReadServices: async () => { throw new Error('must_not_run') },
    },
  }), /rollback_approval_state_mismatch/)
}

{
  const name = 'rollback-preflight-preserves-original-failure'
  const approval = approvalFor(name)
  const approvalSha256 = repairApprovalSha256(approval)
  const repairPaths = paths(name)
  const backup = path.join(approval.backupDirectory, 'jp.db.backup')
  fs.mkdirSync(approval.backupDirectory, { recursive: true })
  fs.writeFileSync(backup, 'verified-original-generation\n')
  const backupSha256 = stableSha256(fs.readFileSync(backup))
  const transaction = new JpOhlcvProductionRepairTransaction({
    approval,
    approvalSha256,
    paths: repairPaths,
    transactionId: name,
  })
  transaction.prepare()
  transaction.advance('PREPARED', 'WRITER_LOCKED', { owner: 'fixture-original-writer' })
  transaction.advance('WRITER_LOCKED', 'BACKUP_VERIFIED', { backupRealpath: backup, backupSha256 })
  assert.throws(() => transaction.hold(new Error('original_derived_failure')), /original_derived_failure/)
  const firstJournal = JSON.parse(fs.readFileSync(repairPaths.journal, 'utf8'))
  markOriginalRunnerStopped(repairPaths)
  const rollbackApproval: JpOhlcvRepairRollbackApproval = {
    version: 1,
    action: 'ROLLBACK',
    repairApprovalSha256: approvalSha256,
    journalSha256: stableSha256(firstJournal),
    transactionId: name,
    databaseRealpath: approval.databaseRealpath,
    backupDirectory: approval.backupDirectory,
    backupRealpath: backup,
    backupSha256,
    sourceGenerationTarget: approval.sourceGenerationBefore,
    servingGenerationTarget: approval.servingGenerationBefore,
    reason: 'fixture rollback preflight failure must preserve the original cause',
    originalRunnerRecovery: runnerRecoveryFor(repairPaths),
  }
  await assert.rejects(runJpOhlcvProductionRepairRollback({
    approval,
    approvalSha256,
    rollbackApproval,
    rollbackApprovalSha256: repairRollbackApprovalSha256(rollbackApproval),
    paths: repairPaths,
    adapter: {
      acquireWriterLock: async () => ({ owner: 'fixture-recovery-writer', release: async () => undefined }),
      verifyBackupForRollback: async () => { throw new Error('rollback_backup_probe_failed') },
      holdReadServices: async () => { throw new Error('must_not_run') },
      restoreBackupAtomically: async () => { throw new Error('must_not_run') },
      rebuildOriginalDerivedServing: async () => { throw new Error('must_not_run') },
      verifyOriginalServing: async () => { throw new Error('must_not_run') },
      resumeReadServices: async () => { throw new Error('must_not_run') },
    },
  }), /rollback_backup_probe_failed/)
  const secondJournal = JSON.parse(fs.readFileSync(repairPaths.journal, 'utf8'))
  assert.equal(secondJournal.failure.message, 'rollback_backup_probe_failed')
  assert.equal(secondJournal.failureHistory.at(-1).message, 'original_derived_failure')
  assert.equal(secondJournal.failureHistory.at(-1).originalStage, 'BACKUP_VERIFIED')
}

{
  const name = 'prewrite-cleanup'
  const approval = approvalFor(name)
  const approvalSha256 = repairApprovalSha256(approval)
  const repairPaths = paths(name)
  await assert.rejects(runJpOhlcvProductionRepair({
    approval,
    approvalSha256,
    scope,
    paths: repairPaths,
    adapter: adapter(approval, {
      createAndVerifyConsistentBackup: async () => { throw new Error('fixture_backup_failed_before_mutation') },
    }),
    transactionId: name,
  }), /fixture_backup_failed_before_mutation/)
  const journal = JSON.parse(fs.readFileSync(repairPaths.journal, 'utf8'))
  const checkedAt = new Date().toISOString()
  const checkedWriterJobTypes = [
    'calendar_stage_backfill_jp', 'calendar_stage_backfill_us', 'db_maintenance', 'earnings_refresh',
    'jp_ohlcv_gap_repair', 'kabutan_material_news', 'kabutan_themes', 'large_holder_daily',
    'ml_freshness_guard', 'ml_learning', 'post_ohlcv_refresh', 'sector_structure', 'stage_transitions',
    'update_latest', 'us_adjusted_foundation', 'us_adjusted_source_snapshots', 'us_update_latest',
  ]
  const updateLockSnapshotPath = path.join(repairPaths.stateDirectory, 'update-lock-snapshot.json')
  const processSnapshotPath = path.join(repairPaths.stateDirectory, 'writer-process-snapshot.json')
  fs.writeFileSync(updateLockSnapshotPath, `${JSON.stringify({
    version: 1,
    checkedAt,
    databaseRealpath: approval.databaseRealpath,
    databaseIdentitySha256: approval.databaseIdentitySha256,
    repairTransactionId: name,
    locks: checkedWriterJobTypes.map((jobType) => ({ jobType, state: 'ABSENT', leaseExpiresAt: null })),
  })}\n`)
  fs.writeFileSync(processSnapshotPath, `${JSON.stringify({
    version: 1,
    checkedAt,
    scanStatus: 'CLEAR',
    matchingWriterProcesses: [],
  })}\n`)
  const writerLockEvidence = {
    version: 1 as const,
    checkedAt,
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    databaseRealpath: approval.databaseRealpath,
    databaseIdentitySha256: approval.databaseIdentitySha256,
    repairTransactionId: name,
    updateLockSnapshotPath,
    updateLockSnapshotSha256: fileSha256(updateLockSnapshotPath),
    processSnapshotPath,
    processSnapshotSha256: fileSha256(processSnapshotPath),
  }
  const cleanupApproval: JpOhlcvRepairPrewriteCleanupApproval = {
    version: 1,
    action: 'ARCHIVE_PREWRITE_HOLD',
    repairApprovalSha256: approvalSha256,
    journalSha256: stableSha256(journal),
    transactionId: name,
    writerLockEvidence,
    writerLockEvidenceSha256: stableSha256(writerLockEvidence),
    reason: 'fixture confirms no Production mutation and no writer lock remains',
    originalRunnerRecovery: runnerRecoveryFor(repairPaths),
  }
  const expiredWriterEvidence = {
    ...writerLockEvidence,
    checkedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
    expiresAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  }
  const expiredCleanupApproval: JpOhlcvRepairPrewriteCleanupApproval = {
    ...cleanupApproval,
    writerLockEvidence: expiredWriterEvidence,
    writerLockEvidenceSha256: stableSha256(expiredWriterEvidence),
  }
  assert.throws(() => runJpOhlcvProductionRepairPrewriteCleanup({
    approval,
    approvalSha256,
    cleanupApproval: expiredCleanupApproval,
    cleanupApprovalSha256: repairPrewriteCleanupApprovalSha256(expiredCleanupApproval),
    paths: repairPaths,
  }), /prewrite_cleanup_approval_state_mismatch/)
  const originalProcessSnapshot = fs.readFileSync(processSnapshotPath)
  fs.appendFileSync(processSnapshotPath, 'tampered\n')
  assert.throws(() => runJpOhlcvProductionRepairPrewriteCleanup({
    approval,
    approvalSha256,
    cleanupApproval,
    cleanupApprovalSha256: repairPrewriteCleanupApprovalSha256(cleanupApproval),
    paths: repairPaths,
  }), /evidence_snapshot_hash_mismatch/)
  fs.writeFileSync(processSnapshotPath, originalProcessSnapshot)
  assert.throws(() => runJpOhlcvProductionRepairPrewriteCleanup({
    approval,
    approvalSha256,
    cleanupApproval,
    cleanupApprovalSha256: repairPrewriteCleanupApprovalSha256(cleanupApproval),
    paths: repairPaths,
  }), /original_runner_still_active/)
  const mismatchedLock = JSON.parse(fs.readFileSync(repairPaths.lock, 'utf8'))
  fs.writeFileSync(repairPaths.lock, `${JSON.stringify({
    ...mismatchedLock,
    processIdentitySha256: 'd'.repeat(64),
  })}\n`)
  assert.throws(() => runJpOhlcvProductionRepairPrewriteCleanup({
    approval,
    approvalSha256,
    cleanupApproval,
    cleanupApprovalSha256: repairPrewriteCleanupApprovalSha256(cleanupApproval),
    paths: repairPaths,
  }), /original_runner_exact_approval_required/)
  const stoppedCleanupApproval: JpOhlcvRepairPrewriteCleanupApproval = {
    ...cleanupApproval,
    originalRunnerRecovery: {
      pid: Number(mismatchedLock.pid),
      processGroupId: Number(mismatchedLock.processGroupId),
      processIdentitySha256: 'd'.repeat(64),
      observedState: 'PID_REUSED_OR_IDENTITY_MISMATCH',
      confirmedStoppedAt: new Date().toISOString(),
      reason: 'fixture explicitly binds the mismatched recorded owner identity',
    },
  }
  const result = runJpOhlcvProductionRepairPrewriteCleanup({
    approval,
    approvalSha256,
    cleanupApproval: stoppedCleanupApproval,
    cleanupApprovalSha256: repairPrewriteCleanupApprovalSha256(stoppedCleanupApproval),
    paths: repairPaths,
  })
  assert.equal(result.status, 'ABORTED_PREWRITE')
  assert.equal(result.productionDataMutation, false)
  assert.ok(fs.existsSync(result.archivedJournal))
  assert.doesNotThrow(() => assertNoIncompleteRepair(repairPaths))
}

{
  const name = 'resume-read-services'
  const approval = approvalFor(name)
  const approvalSha256 = repairApprovalSha256(approval)
  const repairPaths = paths(name)
  await assert.rejects(runJpOhlcvProductionRepair({
    approval,
    approvalSha256,
    scope,
    paths: repairPaths,
    adapter: adapter(approval, {
      resumeReadServices: async () => { throw new Error('fixture_resume_command_lost_evidence') },
    }),
    transactionId: name,
  }), /fixture_resume_command_lost_evidence/)
  const journal = JSON.parse(fs.readFileSync(repairPaths.journal, 'utf8'))
  markOriginalRunnerStopped(repairPaths)
  const resumeApproval: JpOhlcvRepairResumeServicesApproval = {
    version: 1,
    action: 'RESUME_READ_SERVICES',
    repairApprovalSha256: approvalSha256,
    journalSha256: stableSha256(journal),
    transactionId: name,
    sourceGeneration: approval.sourceGenerationAfter,
    servingGeneration: approval.servingGenerationAfter,
    reason: 'fixture revalidates the promoted serving generation before idempotent service resume',
    originalRunnerRecovery: runnerRecoveryFor(repairPaths),
  }
  const result = await runJpOhlcvProductionRepairResumeReadServices({
    approval,
    approvalSha256,
    resumeApproval,
    resumeApprovalSha256: repairResumeServicesApprovalSha256(resumeApproval),
    paths: repairPaths,
    adapter: adapter(approval),
  })
  assert.equal(result.status, 'COMMITTED')
  assert.equal(result.recoveredReadServices, true)
  const inspection = inspectJpOhlcvProductionRepair(repairPaths)
  assert.equal(inspection.status, 'CLEAR')
  assert.equal(inspection.dataQualityStatus, 'PARTIAL_REPAIR_UNRESOLVED_CONFLICTS_HOLD')
  assert.deepEqual(
    (inspection.lastTerminalTransaction as { preservedConflicts: { tickers: string[] } }).preservedConflicts.tickers,
    ['1447'],
  )
}

{
  const name = 'independent-status-parse'
  const approval = approvalFor(name)
  const repairPaths = paths(name)
  await assert.rejects(runJpOhlcvProductionRepair({
    approval,
    approvalSha256: repairApprovalSha256(approval),
    scope,
    paths: repairPaths,
    adapter: adapter(approval, {
      createAndVerifyConsistentBackup: async () => { throw new Error('fixture_status_hold') },
    }),
    transactionId: name,
  }))
  fs.writeFileSync(repairPaths.lock, '{broken-lock-json\n')
  const inspection = inspectJpOhlcvProductionRepair(repairPaths)
  assert.equal(inspection.status, 'HOLD_UNCERTAIN')
  assert.equal((inspection.journal as { transactionId: string }).transactionId, name)
  assert.ok((inspection.reasons as string[]).some((reason) => reason.startsWith('LOCK_PARSE_FAILED:')))
  fs.writeFileSync(repairPaths.journal, '{broken-journal-json\n')
  const bothCorrupt = inspectJpOhlcvProductionRepair(repairPaths)
  assert.equal(bothCorrupt.status, 'HOLD_UNCERTAIN')
  assert.match(String(bothCorrupt.fallbackOperatorAction), /Preserve the entire repair state directory/)
  assert.equal(
    (bothCorrupt.protectedResourcesFallback as { journal: string }).journal,
    repairPaths.journal,
  )
}

{
  const name = 'crashed-parent-without-stage-child'
  const approval = approvalFor(name)
  const repairPaths = paths(name)
  const transaction = new JpOhlcvProductionRepairTransaction({
    approval,
    approvalSha256: repairApprovalSha256(approval),
    paths: repairPaths,
    transactionId: name,
  })
  transaction.prepare()
  markOriginalRunnerStopped(repairPaths)
  const inspection = inspectJpOhlcvProductionRepair(repairPaths)
  assert.equal(inspection.status, 'HOLD_UNCERTAIN')
  assert.ok((inspection.reasons as string[]).includes('LOCK_OWNER_PROCESS:PID_ABSENT'))
}

console.log('JP OHLCV Production repair transaction tests: PASS')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
