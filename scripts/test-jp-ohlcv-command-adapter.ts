import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildJpOhlcvBackfillPlan,
  buildJpOhlcvMissingOnlyRepairScope,
  jpOhlcvApprovedRepairKeysSha256,
  stableSha256,
  type JpOfficialOhlcvValue,
  type JpOhlcvValue,
} from '@/lib/jp-ohlcv-data-quality'
import type { JpOhlcvRepairExecutionPlan, JpOhlcvRepairStageCommand } from '@/lib/jp-ohlcv-command-adapter'
import { JP_OHLCV_BACKUP_TIME_LIMITS as limits } from '@/lib/jp-ohlcv-backup-time-budget'
import {
  repairApprovalSha256,
  type JpOhlcvRepairApproval,
  type JpOhlcvRepairRollbackApproval,
} from '@/lib/jp-ohlcv-production-repair'
import { captureJpOhlcvRuntimeSnapshot } from '@/lib/jp-ohlcv-runtime-snapshot'

function fileSha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-ohlcv-command-adapter-'))
const database = path.join(root, 'fixture.db')
const stateDirectory = path.join(root, 'state')
const backupDirectory = path.join(root, 'backup')
const backup = path.join(backupDirectory, 'fixture.db.backup')
const stageScript = path.join(root, 'stage-fixture.js')
fs.mkdirSync(backupDirectory, { recursive: true })
fs.writeFileSync(backup, 'verified-backup-fixture\n')
fs.writeFileSync(stageScript, 'console.log(process.argv[2])\n')

Object.assign(process.env, {
  NODE_ENV: 'test',
  USE_LOCAL_DB: '1',
  STOCKBOARD_DB_PATH: database,
  STOCKBOARD_JP_OHLCV_REPAIR_LOCK_PATH: path.join(stateDirectory, 'repair.lock'),
  SKIP_SCHEMA_ENSURE: '1',
  JQUANTS_API_KEY: 'fixture-command-adapter-secret-must-not-appear',
})

const officialRows: JpOfficialOhlcvValue[] = [
  { ticker: '1306', date: '2026-07-17', open: 400, high: 410, low: 399, close: 407.9, volume: 10, adjustmentFactor: 1 },
  { ticker: '7003', date: '2026-07-17', open: 4400, high: 4500, low: 4300, close: 4434, volume: 20, adjustmentFactor: 1 },
  { ticker: '1447', date: '2026-07-17', open: 273.7, high: 285.1, low: 267, close: 270.4, volume: 30, adjustmentFactor: 1 },
]
const existingRows: JpOhlcvValue[] = [
  { ticker: '1447', date: '2026-07-17', open: 273.5, high: 284.9, low: 266.8, close: 270.2, volume: 30 },
]
const noTradeRows = Array.from({ length: 224 }, (_, index) => ({
  code: `N${String(index).padStart(4, '0')}`,
  date: '2026-07-17',
  reason: 'ALL_OHLCV_FIELDS_NULL' as const,
  adjustmentFactor: 1,
  upperLimit: 0,
  lowerLimit: 0,
  open: null,
  high: null,
  low: null,
  close: null,
  volume: null,
  value: null,
  adjustedOpen: null,
  adjustedHigh: null,
  adjustedLow: null,
  adjustedClose: null,
  adjustedVolume: null,
}))
const sourceContract = {
  version: 1 as const,
  endpoint: '/v2/equities/bars/daily' as const,
  requestedDate: '2026-07-17',
  providerRows: officialRows.length + noTradeRows.length,
  acceptedRows: officialRows.length,
  rejectedRows: noTradeRows.length,
  noTradeRows: noTradeRows.length,
  unexpectedRejectedRows: 0 as const,
  contentSha256: buildJpOhlcvBackfillPlan({
    date: '2026-07-17',
    officialRows,
    existingRows: [],
  }).officialSha256,
  rejectedRowsSha256: stableSha256(noTradeRows),
  rejectionPolicy: 'ALLOW_ONLY_ALL_OHLCV_FIELDS_NULL' as const,
}
const dryRun = buildJpOhlcvBackfillPlan({ date: '2026-07-17', officialRows, existingRows })
const scope = buildJpOhlcvMissingOnlyRepairScope({ plan: dryRun, approvedConflictTickers: ['1447'] })

function command(output: unknown): JpOhlcvRepairStageCommand {
  return {
    executable: process.execPath,
    executableSha256: fileSha256(process.execPath),
    sealedFiles: [{ path: stageScript, sha256: fileSha256(stageScript) }],
    args: [stageScript, JSON.stringify(output)],
    workingDirectory: root,
    timeoutMs: 10_000,
  }
}

async function main(): Promise<void> {
  const { client } = await import('@/lib/db/client')
  await client.execute(`CREATE TABLE ohlcv_daily (
    ticker TEXT NOT NULL,
    date TEXT NOT NULL,
    open REAL NOT NULL,
    high REAL NOT NULL,
    low REAL NOT NULL,
    close REAL NOT NULL,
    volume INTEGER NOT NULL,
    PRIMARY KEY (ticker, date)
  )`)
  await client.execute(`CREATE TABLE update_locks (
    job_type TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    owner TEXT,
    started_at INTEGER NOT NULL,
    heartbeat_at INTEGER NOT NULL,
    lease_expires_at INTEGER NOT NULL
  )`)
  await client.execute(`CREATE TABLE batch_runs (
    id INTEGER PRIMARY KEY, job_type TEXT NOT NULL, status TEXT NOT NULL,
    started_at INTEGER, finished_at INTEGER
  )`)
  await client.execute("INSERT INTO batch_runs(id,job_type,status,started_at,finished_at) VALUES(1,'ohlcv_fetch:jquants','success',1,2)")
  await client.execute('CREATE TABLE daily_snapshots(date TEXT, computed_at INTEGER)')
  await client.execute('CREATE TABLE stock_screening_serving_dates(as_of TEXT, calculated_at INTEGER)')
  await client.execute('CREATE TABLE dashboard_cache(date TEXT, computed_at INTEGER)')
  await client.execute({
    sql: 'INSERT INTO ohlcv_daily(ticker,date,open,high,low,close,volume) VALUES(?,?,?,?,?,?,?)',
    args: ['1447', '2026-07-17', 273.5, 284.9, 266.8, 270.2, 30],
  })
  // Simulate the normal updater satisfying one approved key after approval.
  await client.execute({
    sql: 'INSERT INTO ohlcv_daily(ticker,date,open,high,low,close,volume) VALUES(?,?,?,?,?,?,?)',
    args: ['1306', '2026-07-17', 400, 410, 399, 407.9, 10],
  })

  const plan: JpOhlcvRepairExecutionPlan = {
    version: 1,
    officialRows,
    approvalScope: scope,
    timeBudget: {
      maximumMaintenanceMs: limits.maximumMaintenanceMs,
      forwardDerivedAggregateMs: limits.forwardDerivedAggregateTimeoutMs,
      rollbackDerivedAggregateMs: limits.rollbackDerivedAggregateTimeoutMs,
    },
    commands: {
      createBackup: command({
        databaseRealpath: fs.realpathSync(database),
        databaseIdentitySha256: stableSha256({ fixture: 'command-adapter-db' }),
        backupRealpath: fs.realpathSync(backup),
        backupSha256: fileSha256(backup),
        quickCheck: 'PASS',
        sourceGeneration: 'jp-source-before',
        servingGeneration: 'jp-serving-before',
      }),
      holdReadServices: command({ web: 'HELD', analog: 'HELD', snapshotSha256: '1'.repeat(64) }),
      publishSourceGeneration: command({ status: 'PASS', sourceGeneration: 'jp-source-after' }),
      verifyDataGeneration: command({ status: 'PASS', sourceGeneration: 'jp-source-after' }),
      rebuildDerivedServing: [command({ status: 'PASS', rebuilt: ['fixture-derived'] })],
      verifyServing: command({ sourceGeneration: 'jp-source-after', servingGeneration: 'jp-serving-after', health: 'PASS' }),
      resumeReadServices: command({ web: 'PASS', analog: 'PASS', health: 'PASS' }),
      verifyBackupForRollback: command({
        backupRealpath: fs.realpathSync(backup),
        backupSha256: fileSha256(backup),
        quickCheck: 'PASS',
        sourceGeneration: 'jp-source-before',
        servingGeneration: 'jp-serving-before',
      }),
      restoreBackup: command({
        databaseRealpath: database,
        databaseSha256: fileSha256(backup),
        sourceGeneration: 'jp-source-before',
        restoreStatePath: path.join(stateDirectory, 'rollback-restore-command-adapter-fixture.json'),
        restorePhase: 'COMPLETED',
      }),
      rebuildOriginalDerivedServing: [command({ status: 'PASS', rebuilt: ['fixture-derived'] })],
      verifyOriginalServing: command({ sourceGeneration: 'jp-source-before', servingGeneration: 'jp-serving-before', health: 'PASS' }),
    },
  }
  const approval: JpOhlcvRepairApproval = {
    version: 1,
    executionScope: 'ISOLATED_FIXTURE',
    targetDate: '2026-07-17',
    officialSha256: scope.officialSha256,
    planSha256: scope.planSha256,
    missingRowsSha256: scope.missingRowsSha256,
    approvedRepairKeysSha256: jpOhlcvApprovedRepairKeysSha256(scope.missingRows),
    runtimeDriftPolicy: 'ALLOW_APPROVED_KEYS_TO_BECOME_EXACT_MATCH_ONLY',
    runtimeSnapshotTtlMs: 900000,
    officialSourceContract: sourceContract,
    preservedConflictsSha256: scope.preservedConflictsSha256,
    expectedOfficialRows: 3,
    expectedExistingRows: 1,
    expectedMatchingRows: 0,
    expectedMissingRows: 2,
    approvedConflictTickers: ['1447'],
    conflictDisposition: 'PRESERVE_EXISTING_HOLD',
    databaseRealpath: fs.realpathSync(database),
    databaseIdentitySha256: stableSha256({ fixture: 'command-adapter-db' }),
    stateDirectory,
    backupDirectory: fs.realpathSync(backupDirectory),
    sourceGenerationBefore: 'jp-source-before',
    sourceGenerationAfter: 'jp-source-after',
    servingGenerationBefore: 'jp-serving-before',
    servingGenerationAfter: 'jp-serving-after',
    derivedPlanSha256: stableSha256(plan),
  }
  const { createJpOhlcvCommandAdapters } = await import('@/lib/jp-ohlcv-command-adapter')
  const { runJpOhlcvProductionRepair } = await import('@/lib/jp-ohlcv-repair-runner')
  const initialNow = new Date('2026-10-29T00:00:00.000Z')
  let logicalNow = initialNow
  const sourceProof = (at: Date) => ({
    requestedAt: at.toISOString(),
    completedAt: at.toISOString(),
    providerRows: sourceContract.providerRows,
    acceptedRows: sourceContract.acceptedRows,
    rejectedRows: sourceContract.rejectedRows,
    noTradeRows: sourceContract.noTradeRows,
    unexpectedRejectedRows: 0,
    contentSha256: scope.officialSha256,
    rejectedRowsSha256: sourceContract.rejectedRowsSha256,
  })
  const runtimeSnapshot = captureJpOhlcvRuntimeSnapshot({
    databasePath: database,
    configurationSha256: stableSha256({ fixture: 'configuration' }),
    approvalScope: scope,
    officialRows,
    officialSourceProof: sourceProof(initialNow),
    officialSourceContract: approval.officialSourceContract,
    now: initialNow,
  })
  const adapters = createJpOhlcvCommandAdapters({
    approval,
    plan,
    runtimeSnapshot,
    now: () => new Date(logicalNow),
    refreshOfficialSource: async () => {
      logicalNow = new Date(initialNow.getTime() + 16 * 60_000)
      return {
        rows: officialRows,
        rejectedRows: noTradeRows,
        proof: sourceProof(logicalNow),
        contract: sourceContract,
      }
    },
  })
  const result = await runJpOhlcvProductionRepair({
    approval,
    approvalSha256: repairApprovalSha256(approval),
    scope,
    paths: {
      stateDirectory,
      journal: path.join(stateDirectory, 'repair-journal.json'),
      lock: path.join(stateDirectory, 'repair.lock'),
    },
    adapter: adapters.forward,
    transactionId: 'command-adapter-fixture',
  })
  assert.equal(result.status, 'COMMITTED')
  const rows = await client.execute('SELECT ticker, close FROM ohlcv_daily ORDER BY ticker')
  assert.deepEqual(rows.rows.map((row) => [String(row.ticker), Number(row.close)]), [
    ['1306', 407.9],
    ['1447', 270.2],
    ['7003', 4434],
  ])
  assert.deepEqual(result.conflictsStillHold, ['1447'])
  const committedJournal = JSON.parse(fs.readFileSync(result.archivedJournal, 'utf8')) as {
    evidence: {
      RUNTIME_SNAPSHOT_RENEWED: Record<string, unknown>
      DATA_COMMITTING: Record<string, unknown>
      DATA_COMMITTED: Record<string, unknown>
    }
  }
  assert.equal(committedJournal.evidence.RUNTIME_SNAPSHOT_RENEWED.officialSourceContractSha256, stableSha256(sourceContract))
  const renewedEvidencePath = String(committedJournal.evidence.RUNTIME_SNAPSHOT_RENEWED.evidencePath)
  assert.doesNotMatch(fs.readFileSync(result.archivedJournal, 'utf8'), /fixture-command-adapter-secret-must-not-appear/)
  assert.doesNotMatch(fs.readFileSync(renewedEvidencePath, 'utf8'), /fixture-command-adapter-secret-must-not-appear/)
  const renewedEvidence = JSON.parse(fs.readFileSync(renewedEvidencePath, 'utf8')) as {
    rejectedRows: unknown[]
    snapshot: { capturedAt: string }
  }
  assert.equal(renewedEvidence.rejectedRows.length, 224)
  assert.equal(renewedEvidence.snapshot.capturedAt, logicalNow.toISOString())
  assert.deepEqual(committedJournal.evidence.DATA_COMMITTING, {
    approvedMissingRows: 2,
    alreadySatisfiedExactRows: 1,
    residualMissingRows: 1,
    missingRows: 1,
    missingRowsSha256: stableSha256([officialRows[1]]),
  })
  assert.equal(committedJournal.evidence.DATA_COMMITTED.insertedRows, 1)

  const context = {
    transactionId: 'command-identity-negative-fixture',
    lockPath: path.join(root, 'negative-state', 'repair.lock'),
    childEnvironment: {
      ...process.env,
      STOCKBOARD_JP_OHLCV_REPAIR_OWNER: '1',
      STOCKBOARD_JP_OHLCV_REPAIR_TRANSACTION_ID: 'command-identity-negative-fixture',
      STOCKBOARD_JP_OHLCV_REPAIR_LOCK_PATH: path.join(root, 'negative-state', 'repair.lock'),
      STOCKBOARD_UPDATE_JOB_TYPE: 'jp_ohlcv_gap_repair',
    },
    recordStageProcessStarted: () => {},
    recordStageProcessStopped: () => {},
    assertExecutionActive: () => {},
  }
  const postCommitNow = new Date(logicalNow)
  const postCommitSnapshot = captureJpOhlcvRuntimeSnapshot({
    databasePath: database,
    configurationSha256: runtimeSnapshot.configurationSha256,
    approvalScope: scope,
    officialRows,
    officialSourceProof: sourceProof(postCommitNow),
    officialSourceContract: sourceContract,
    now: postCommitNow,
  })
  const changedOfficialRows = officialRows.map((row) => (
    row.ticker === '7003' ? { ...row, close: row.close + 1 } : row
  ))
  const changedOfficialHash = buildJpOhlcvBackfillPlan({
    date: '2026-07-17',
    officialRows: changedOfficialRows,
    existingRows: [],
  }).officialSha256
  const revisedSourceAdapter = createJpOhlcvCommandAdapters({
    approval,
    plan,
    runtimeSnapshot: postCommitSnapshot,
    now: () => postCommitNow,
    refreshOfficialSource: async () => ({
      rows: changedOfficialRows,
      rejectedRows: noTradeRows,
      contract: { ...sourceContract, contentSha256: changedOfficialHash },
      proof: { ...sourceProof(postCommitNow), contentSha256: changedOfficialHash },
    }),
  }).forward
  await revisedSourceAdapter.revalidatePlan(context)
  await assert.rejects(
    revisedSourceAdapter.renewRuntimeSnapshotAfterBackup(context),
    /provider_envelope_changed:expectedProvider=.*:observedContent=/,
  )
  assert.equal(fs.existsSync(path.join(stateDirectory, `runtime-snapshot-renewed-${context.transactionId}.json`)), false)

  const expandedNoTradeRows = [
    ...noTradeRows,
    { ...noTradeRows[0], code: 'N9999' },
  ]
  const expandedEnvelope = {
    ...sourceContract,
    providerRows: sourceContract.providerRows + 1,
    rejectedRows: sourceContract.rejectedRows + 1,
    noTradeRows: sourceContract.noTradeRows + 1,
    rejectedRowsSha256: stableSha256(expandedNoTradeRows),
  }
  const envelopeDriftAdapter = createJpOhlcvCommandAdapters({
    approval,
    plan,
    runtimeSnapshot: postCommitSnapshot,
    now: () => postCommitNow,
    refreshOfficialSource: async () => ({
      rows: officialRows,
      rejectedRows: expandedNoTradeRows,
      contract: expandedEnvelope,
      proof: {
        ...sourceProof(postCommitNow),
        providerRows: expandedEnvelope.providerRows,
        rejectedRows: expandedEnvelope.rejectedRows,
        noTradeRows: expandedEnvelope.noTradeRows,
        rejectedRowsSha256: expandedEnvelope.rejectedRowsSha256,
      },
    }),
  }).forward
  await envelopeDriftAdapter.revalidatePlan(context)
  await assert.rejects(
    envelopeDriftAdapter.renewRuntimeSnapshotAfterBackup(context),
    /provider_envelope_changed:expectedProvider=.*:observedProvider=/,
  )

  const expectCreateBackupFailure = async (mutate: (candidate: JpOhlcvRepairExecutionPlan) => void, pattern: RegExp) => {
    const candidate = structuredClone(plan)
    mutate(candidate)
    const candidateApproval = { ...approval, derivedPlanSha256: stableSha256(candidate) }
    await assert.rejects(async () => {
      const candidateAdapters = createJpOhlcvCommandAdapters({ approval: candidateApproval, plan: candidate })
      await candidateAdapters.forward.createAndVerifyConsistentBackup(context)
    }, pattern)
  }
  await expectCreateBackupFailure((candidate) => {
    candidate.commands.createBackup.executableSha256 = '0'.repeat(64)
  }, /command_identity_mismatch/)
  await expectCreateBackupFailure((candidate) => {
    candidate.commands.createBackup.sealedFiles[0].sha256 = '0'.repeat(64)
  }, /sealed_file_identity_mismatch/)
  await expectCreateBackupFailure((candidate) => {
    candidate.commands.createBackup.environment = { STOCKBOARD_DB_PATH: database }
  }, /reserved_environment_forbidden/)
  await expectCreateBackupFailure((candidate) => {
    candidate.commands.createBackup.args = ['-e', 'console.log("{}")']
  }, /inline_interpreter_forbidden/)

  const hangingScript = path.join(root, 'hanging-stage-fixture.js')
  fs.writeFileSync(hangingScript, 'setInterval(() => {}, 1000)\n')
  const interruptedPlan = structuredClone(plan)
  interruptedPlan.commands.createBackup = {
    executable: process.execPath,
    executableSha256: fileSha256(process.execPath),
    sealedFiles: [{ path: hangingScript, sha256: fileSha256(hangingScript) }],
    args: [hangingScript],
    workingDirectory: root,
    timeoutMs: 10_000,
  }
  const interruptedApproval = { ...approval, derivedPlanSha256: stableSha256(interruptedPlan) }
  let interruptedProcessGroup = 0
  const interruptedContext = {
    ...context,
    recordStageProcessStarted: (stageProcess: { processGroupId: number }) => {
      interruptedProcessGroup = stageProcess.processGroupId
    },
  }
  const { installJpOhlcvRepairSignalHandlers, isProcessGroupAlive } = await import('@/lib/jp-ohlcv-repair-process-supervisor')
  const uninstallSignalHandlers = installJpOhlcvRepairSignalHandlers()
  try {
    const interruptedAdapters = createJpOhlcvCommandAdapters({
      approval: interruptedApproval,
      plan: interruptedPlan,
    })
    const interrupted = interruptedAdapters.forward.createAndVerifyConsistentBackup(interruptedContext)
    await new Promise((resolve) => setTimeout(resolve, 100))
    process.emit('SIGTERM')
    await assert.rejects(interrupted, /repair_execution_interrupted:SIGTERM/)
    assert.ok(interruptedProcessGroup > 1)
    assert.equal(isProcessGroupAlive(interruptedProcessGroup), false)
  } finally {
    uninstallSignalHandlers()
  }
  const { closeLocalClientBeforeExternalWriter } = await import('@/lib/db/client')
  await closeLocalClientBeforeExternalWriter()
  fs.copyFileSync(backup, database)
  const restoreStatePath = path.join(stateDirectory, 'rollback-restore-command-adapter-fixture.json')
  fs.writeFileSync(restoreStatePath, '{}\n')
  const rollbackEvidence = await adapters.rollback.restoreBackupAtomically(context)
  assert.ok((rollbackEvidence.parentRestoredDatabaseSha256ElapsedMs ?? -1) >= 0)
  assert.equal(
    rollbackEvidence.parentRestoredDatabaseSha256TimeoutMs,
    limits.parentBackupSha256MaxTimeoutMs,
  )
  const recoveryPlan = structuredClone(plan)
  recoveryPlan.commands.rebuildOriginalDerivedServing[0].args.push(
    '--rollback-expected-target-rows',
    '2',
  )
  const emergencyRollbackApproval: JpOhlcvRepairRollbackApproval = {
    version: 2,
    action: 'ROLLBACK',
    repairApprovalSha256: repairApprovalSha256(approval),
    journalSha256: '1'.repeat(64),
    transactionId: 'fixture-emergency-recovery',
    databaseRealpath: approval.databaseRealpath,
    backupDirectory: approval.backupDirectory,
    backupRealpath: fs.realpathSync(backup),
    backupSha256: fileSha256(backup),
    sourceGenerationTarget: approval.sourceGenerationBefore,
    servingGenerationTarget: approval.servingGenerationBefore,
    reason: 'fixture emergency recovery approval',
    originalRunnerRecovery: {
      pid: 1,
      processGroupId: 1,
      processIdentitySha256: '2'.repeat(64),
      observedState: 'PID_ABSENT',
      confirmedStoppedAt: new Date().toISOString(),
      reason: 'fixture',
    },
    emergencyRecovery: {
      originalExecutionPlanSha256: approval.derivedPlanSha256,
      recoveryExecutionPlanSha256: stableSha256(recoveryPlan),
      recoveryConfigurationFileSha256: '3'.repeat(64),
      expectedRestoredTargetRows: 2,
      backupRuntimeSnapshotSha256: '4'.repeat(64),
      backupRuntimeSnapshotFileSha256: '5'.repeat(64),
      sourcePackageApprovalSha256: '6'.repeat(64),
      originalConfigurationSha256: '7'.repeat(64),
      originalConfigurationFileSha256: '8'.repeat(64),
      backupMetadataFileSha256: '9'.repeat(64),
      readServiceSnapshotFileSha256: 'a'.repeat(64),
    },
  }
  assert.doesNotThrow(() => createJpOhlcvCommandAdapters({
    approval,
    plan: recoveryPlan,
    rollbackApproval: emergencyRollbackApproval,
  }))
  assert.throws(() => createJpOhlcvCommandAdapters({
    approval,
    plan,
    rollbackApproval: emergencyRollbackApproval,
  }), /repair_execution_plan_hash_mismatch/)
  const largeFile = path.join(root, 'large-file.bin')
  fs.writeFileSync(largeFile, Buffer.alloc(2 * 1024 * 1024))
  const { sha256LargeFileWithTimeout } = await import('@/lib/jp-ohlcv-command-adapter')
  let timeoutClock = 0
  assert.throws(() => sha256LargeFileWithTimeout(largeFile, () => {
    const value = timeoutClock
    timeoutClock += limits.parentBackupSha256MaxTimeoutMs + 1
    return value
  }), /repair_parent_large_file_sha256_timeout/)
  console.log('JP OHLCV command adapter tests: PASS')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
