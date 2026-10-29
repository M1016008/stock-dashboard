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
import { repairApprovalSha256, type JpOhlcvRepairApproval } from '@/lib/jp-ohlcv-production-repair'
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
})

const officialRows: JpOfficialOhlcvValue[] = [
  { ticker: '1306', date: '2026-07-17', open: 400, high: 410, low: 399, close: 407.9, volume: 10, adjustmentFactor: 1 },
  { ticker: '7003', date: '2026-07-17', open: 4400, high: 4500, low: 4300, close: 4434, volume: 20, adjustmentFactor: 1 },
  { ticker: '1447', date: '2026-07-17', open: 273.7, high: 285.1, low: 267, close: 270.4, volume: 30, adjustmentFactor: 1 },
]
const existingRows: JpOhlcvValue[] = [
  { ticker: '1447', date: '2026-07-17', open: 273.5, high: 284.9, low: 266.8, close: 270.2, volume: 30 },
]
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
      restoreBackup: command({ databaseRealpath: database, databaseSha256: fileSha256(backup), sourceGeneration: 'jp-source-before' }),
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
    officialSourceContract: {
      version: 1,
      endpoint: '/v2/equities/bars/daily',
      requestedDate: '2026-07-17',
      providerRows: officialRows.length,
      acceptedRows: officialRows.length,
      rejectedRows: 0,
      noTradeRows: 0,
      unexpectedRejectedRows: 0,
      contentSha256: scope.officialSha256,
      rejectedRowsSha256: stableSha256([]),
      rejectionPolicy: 'ALLOW_ONLY_ALL_OHLCV_FIELDS_NULL',
    },
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
  const runtimeSnapshot = captureJpOhlcvRuntimeSnapshot({
    databasePath: database,
    configurationSha256: stableSha256({ fixture: 'configuration' }),
    approvalScope: scope,
    officialRows,
    officialSourceProof: {
      requestedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      providerRows: officialRows.length,
      acceptedRows: officialRows.length,
      rejectedRows: 0,
      noTradeRows: 0,
      unexpectedRejectedRows: 0,
      contentSha256: scope.officialSha256,
      rejectedRowsSha256: stableSha256([]),
    },
    officialSourceContract: approval.officialSourceContract,
  })
  const adapters = createJpOhlcvCommandAdapters({ approval, plan, runtimeSnapshot })
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
    evidence: { DATA_COMMITTING: Record<string, unknown>; DATA_COMMITTED: Record<string, unknown> }
  }
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
  console.log('JP OHLCV command adapter tests: PASS')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
