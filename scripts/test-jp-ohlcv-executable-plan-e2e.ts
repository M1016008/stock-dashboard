import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import {
  buildJpOhlcvBackfillPlan,
  buildJpOhlcvMissingOnlyRepairScope,
  stableSha256,
  type JpOfficialOhlcvValue,
  type JpOhlcvValue,
} from '@/lib/jp-ohlcv-data-quality'
import {
  assertJpOhlcvProductionExecutionConfiguration,
  assertJpOhlcvProductionExecutionPackage,
  databaseFileObjectIdentitySha256,
  databaseSchemaIdentitySha256,
  executionConfigurationSha256,
  isHealthyJpOhlcvRepairResponseBody,
  assertJpOhlcvStorageIdentityEnvironment,
  jpOhlcvStorageIdentityEnvironment,
  jpOhlcvStorageIdentitySha256,
  sha256File,
  type JpOhlcvProductionExecutionConfiguration,
  type JpOhlcvProductionExecutionPackage,
} from '@/lib/jp-ohlcv-executable-plan'
import type { JpOhlcvRepairExecutionPlan } from '@/lib/jp-ohlcv-command-adapter'
import { runJpOhlcvMaintenanceOrchestrator } from '@/lib/jp-ohlcv-maintenance-orchestrator'
import { repairApprovalSha256, type JpOhlcvRepairApproval } from '@/lib/jp-ohlcv-production-repair'
import { assertIncompleteJpOhlcvRestoreState } from '@/lib/jp-ohlcv-restore-state'
import { runJpOhlcvProductionRepair } from '@/lib/jp-ohlcv-repair-runner'
import { computeSmaLab } from '@/lib/sma-dynamics-lab'
import { sessionsBetween, smaLabCalendar } from '@/lib/sma-dynamics-timeframes'
import type { WriterHoldDriver, WriterRuntimeIdentity } from '@/lib/storage/weekly-writer-hold'

type SqliteRow = Record<string, string | number | bigint | null>
type SqliteStatement = {
  run(...args: Array<string | number | bigint | null>): unknown
  get(...args: Array<string | number | bigint | null>): SqliteRow
  all(...args: Array<string | number | bigint | null>): SqliteRow[]
}
type SqliteDatabase = {
  exec(sql: string): void
  prepare(sql: string): SqliteStatement
  close(): void
}
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (file: string, options?: { readOnly?: boolean }) => SqliteDatabase
}

const TARGET_DATE = '2026-07-17'
const auditTestRoot = process.env.STOCKBOARD_TEST_AUDIT_ROOT
  ? path.resolve(process.env.STOCKBOARD_TEST_AUDIT_ROOT)
  : os.tmpdir()
fs.mkdirSync(auditTestRoot, { recursive: true, mode: 0o700 })
const root = fs.realpathSync(fs.mkdtempSync(path.join(auditTestRoot, 'jp-ohlcv-executable-e2e-')))
const databasePath = path.join(root, 'fixture.sqlite')
const stateDirectory = path.join(root, 'state')
const backupDirectory = path.join(root, 'backup')
const serviceSnapshotPath = path.join(root, 'read-services.json')
const sourcePointer = path.join(root, 'source-generation.json')
const servingPointer = path.join(root, 'serving-generation.json')
const triggerRepairEvidencePath = path.join(root, 'fixture-trigger-repair-evidence.json')
const stageScript = path.resolve('scripts/run-jp-ohlcv-production-stage.ts')
const derivedVerifierScript = path.resolve('scripts/verify-jp-ohlcv-repair-derived-state.ts')
const tsxExecutable = fs.realpathSync(path.resolve('node_modules/.bin/tsx'))
const sqliteExecutable = fs.realpathSync('/usr/bin/sqlite3')

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

function service(label: string, role: 'WRITER' | 'READ_SERVICE') {
  const plistPath = path.join(root, `${label}.plist`)
  const program = path.join(root, `${label}.program`)
  fs.writeFileSync(program, `${label}\n`, { mode: 0o700 })
  fs.writeFileSync(plistPath, `<?xml version="1.0"?><plist><dict><key>Label</key><string>${label}</string></dict></plist>\n`)
  return { label, plistPath, definitionSha256: sha256File(plistPath), program, role }
}

function createIntegrationIdentity(): Pick<JpOhlcvProductionExecutionConfiguration,
  'integrationRoot' | 'integrationCommit' | 'integrationTreeId' | 'runtimeManifestPath'
  | 'runtimeManifestSha256' | 'runtimeIdentitySha256'> {
  fs.mkdirSync(path.join(root, 'integration'), { recursive: true })
  fs.mkdirSync(path.join(root, 'runtime'), { recursive: true })
  const integrationRoot = fs.realpathSync(path.join(root, 'integration'))
  const runtimeRoot = fs.realpathSync(path.join(root, 'runtime'))
  fs.mkdirSync(path.join(integrationRoot, 'node_modules'), { recursive: true })
  fs.mkdirSync(path.join(runtimeRoot, 'node_modules'), { recursive: true })
  fs.rmdirSync(path.join(integrationRoot, 'node_modules'))
  fs.symlinkSync(path.join(runtimeRoot, 'node_modules'), path.join(integrationRoot, 'node_modules'))
  fs.writeFileSync(path.join(integrationRoot, 'fixture.txt'), 'sealed fixture integration\n')
  fs.writeFileSync(path.join(integrationRoot, '.gitignore'), 'node_modules\n')
  execFileSync('/usr/bin/git', ['init', '-q'], { cwd: integrationRoot })
  execFileSync('/usr/bin/git', ['add', 'fixture.txt', '.gitignore'], { cwd: integrationRoot })
  execFileSync('/usr/bin/git', ['-c', 'user.name=StockBoard Fixture', '-c', 'user.email=fixture@stockboard.invalid', 'commit', '-qm', 'fixture'], { cwd: integrationRoot })
  const integrationCommit = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: integrationRoot, encoding: 'utf8' }).trim()
  const integrationTreeId = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD^{tree}'], { cwd: integrationRoot, encoding: 'utf8' }).trim()
  const runtimeIdentitySha256 = crypto.createHash('sha256').update('fixture-runtime-v1').digest('hex')
  const runtimeManifestPath = path.join(runtimeRoot, 'runtime-manifest.json')
  writeJson(runtimeManifestPath, {
    runtimeRealpath: runtimeRoot,
    hashes: { runtimeIdentitySha256 },
    install: { includesDevDependencies: true, nodeModulesPhysicalDirectory: true },
  })
  return {
    integrationRoot,
    integrationCommit,
    integrationTreeId,
    runtimeManifestPath,
    runtimeManifestSha256: sha256File(runtimeManifestPath),
    runtimeIdentitySha256,
  }
}

function officialRows(): JpOfficialOhlcvValue[] {
  const required = new Map<string, JpOfficialOhlcvValue>([
    ['1306', { ticker: '1306', date: TARGET_DATE, open: 405, high: 410, low: 401, close: 407.9, volume: 1_300_600, adjustmentFactor: 1 }],
    ['1447', { ticker: '1447', date: TARGET_DATE, open: 273.7, high: 285.1, low: 267, close: 270.4, volume: 1_049_400, adjustmentFactor: 1 }],
    ['2164', { ticker: '2164', date: TARGET_DATE, open: 590, high: 610, low: 580, close: 600, volume: 216_400, adjustmentFactor: 1 }],
    ['7003', { ticker: '7003', date: TARGET_DATE, open: 4400, high: 4490, low: 4380, close: 4434, volume: 7_003_000, adjustmentFactor: 1 }],
  ])
  for (let value = 1000; required.size < 4_218; value += 1) {
    const ticker = String(value).padStart(4, '0')
    if (required.has(ticker)) continue
    const close = 100 + (value % 900)
    required.set(ticker, {
      ticker,
      date: TARGET_DATE,
      open: close,
      high: close + 2,
      low: close - 2,
      close,
      volume: value * 100,
      adjustmentFactor: 1,
    })
  }
  return [...required.values()].sort((left, right) => left.ticker.localeCompare(right.ticker))
}

function existingRows(official: JpOfficialOhlcvValue[]): JpOhlcvValue[] {
  const excluded = new Set(['1306', '1447', '2164', '7003'])
  const matching = official.filter((row) => !excluded.has(row.ticker)).slice(0, 149).map(({ adjustmentFactor: _factor, ...row }) => row)
  return [
    ...matching,
    { ticker: '1447', date: TARGET_DATE, open: 273.5, high: 284.9, low: 266.8, close: 270.2, volume: 1_049_400 },
    { ticker: '2164', date: TARGET_DATE, open: 588, high: 608, low: 578, close: 598, volume: 216_400 },
  ].sort((left, right) => left.ticker.localeCompare(right.ticker))
}

function initializeDatabase(existing: JpOhlcvValue[]): void {
  const db = new DatabaseSync(databasePath)
  db.exec(`
    PRAGMA journal_mode=DELETE;
    CREATE TABLE ohlcv_daily (
      ticker TEXT NOT NULL, date TEXT NOT NULL, open REAL NOT NULL, high REAL NOT NULL,
      low REAL NOT NULL, close REAL NOT NULL, volume INTEGER NOT NULL,
      PRIMARY KEY(ticker,date)
    );
    CREATE TABLE update_locks (
      job_type TEXT PRIMARY KEY, status TEXT NOT NULL, owner TEXT,
      started_at INTEGER NOT NULL, heartbeat_at INTEGER NOT NULL, lease_expires_at INTEGER NOT NULL
    );
  `)
  const insert = db.prepare('INSERT INTO ohlcv_daily(ticker,date,open,high,low,close,volume) VALUES(?,?,?,?,?,?,?)')
  for (const row of existing) insert.run(row.ticker, row.date, row.open, row.high, row.low, row.close, row.volume)
  const history = sessionsBetween(smaLabCalendar('JP'), '2026-01-05', '2026-10-28')
  for (const [index, date] of history.entries()) {
    if (date === TARGET_DATE) continue
    const close = 3000 + index
    insert.run('7003', date, close - 3, close + 5, close - 5, close, 100_000 + index)
  }
  db.close()
}

function exactDateRows(db: SqliteDatabase): JpOhlcvValue[] {
  return db.prepare('SELECT ticker,date,open,high,low,close,volume FROM ohlcv_daily WHERE date=? ORDER BY ticker')
    .all(TARGET_DATE).map((row) => ({
      ticker: String(row.ticker), date: String(row.date), open: Number(row.open), high: Number(row.high),
      low: Number(row.low), close: Number(row.close), volume: Number(row.volume),
    }))
}

function writeDerivedFixtureScript(): string {
  const file = path.join(root, 'derived-fixture.mjs')
  fs.writeFileSync(file, `
    import { DatabaseSync } from 'node:sqlite'
    import fs from 'node:fs'
    const [database, targetDate, mode, triggerEvidence, sourceGeneration] = process.argv.slice(2)
    const db = new DatabaseSync(database)
    const expected = mode === 'forward' ? 4218 : 151
    const count = Number(db.prepare('SELECT COUNT(*) AS count FROM ohlcv_daily WHERE date=?').get(targetDate).count)
    if (count !== expected) throw new Error('fixture-derived-coverage:' + count)
    db.exec(\`
      CREATE TABLE IF NOT EXISTS repair_derived_fixture (id INTEGER PRIMARY KEY, mode TEXT NOT NULL, rows INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS daily_snapshots (
        ticker TEXT NOT NULL, date TEXT NOT NULL, ma_75 REAL, computed_at INTEGER NOT NULL,
        PRIMARY KEY(ticker,date)
      );
      CREATE TABLE IF NOT EXISTS stage_transitions (
        axis TEXT NOT NULL, from_stage INTEGER NOT NULL, to_stage INTEGER NOT NULL,
        count INTEGER NOT NULL, computed_at INTEGER NOT NULL,
        PRIMARY KEY(axis,from_stage,to_stage)
      );
      CREATE TABLE IF NOT EXISTS stock_screening_serving (
        ticker TEXT NOT NULL, as_of TEXT NOT NULL, PRIMARY KEY(ticker,as_of)
      );
      CREATE TABLE IF NOT EXISTS stock_screening_serving_dates (
        as_of TEXT PRIMARY KEY, snapshot_date TEXT NOT NULL, row_count INTEGER NOT NULL,
        source_version TEXT NOT NULL, status TEXT NOT NULL, calculated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dashboard_cache (
        date TEXT PRIMARY KEY, payload_json TEXT NOT NULL, computed_at INTEGER NOT NULL
      );
    \`)
    db.prepare('INSERT OR REPLACE INTO repair_derived_fixture(id,mode,rows) VALUES(1,?,?)').run(mode,count)
    if (mode === 'forward') {
      const snapshot = db.prepare('INSERT OR REPLACE INTO daily_snapshots(ticker,date,ma_75,computed_at) VALUES(?,?,?,?)')
      snapshot.run('1306', targetDate, 400.1, 1000)
      snapshot.run('7003', targetDate, 3178.3733333333334, 1000)
      const transition = db.prepare('INSERT OR REPLACE INTO stage_transitions(axis,from_stage,to_stage,count,computed_at) VALUES(?,?,?,?,?)')
      for (const axis of ['daily_a','daily_b','weekly_a','weekly_b','monthly_a','monthly_b']) transition.run(axis,1,2,1,1000)
      db.prepare('INSERT OR REPLACE INTO stock_screening_serving(ticker,as_of) VALUES(?,?)').run('1306',targetDate)
      db.prepare('INSERT OR REPLACE INTO stock_screening_serving(ticker,as_of) VALUES(?,?)').run('7003',targetDate)
      db.prepare("INSERT OR REPLACE INTO stock_screening_serving_dates(as_of,snapshot_date,row_count,source_version,status,calculated_at) VALUES(?,?,?,?,\'completed\',?)")
        .run(targetDate,targetDate,2,'fixture-source-v1',1000)
      db.prepare('INSERT OR REPLACE INTO dashboard_cache(date,payload_json,computed_at) VALUES(?,?,?)')
        .run(targetDate,JSON.stringify({ latestDate: targetDate }),1000)
      fs.writeFileSync(triggerEvidence, JSON.stringify({
        version: 1, sourceGeneration, batchId: 'fixture-trigger-batch', status: 'COMPLETED',
        resolvedAsOf: targetDate, failedCount: 0, notificationsSuppressed: true,
        definitionCount: 1, evaluationIds: ['fixture-evaluation'],
      }))
    }
    db.close()
  `, { mode: 0o500 })
  return file
}

function fakeWriterDriver(writer: ReturnType<typeof service>): WriterHoldDriver {
  let loaded = true
  let now = Date.now()
  const observed = (): WriterRuntimeIdentity => ({
    label: writer.label,
    definitionSha256: writer.definitionSha256,
    program: writer.program,
    loaded,
    disabled: false,
    instances: loaded ? 1 : 0,
    pid: null,
    processGroupId: null,
  })
  return {
    observe: async () => observed(),
    bootout: async () => { loaded = false },
    bootstrap: async () => { loaded = true },
    processGroupAlive: async () => false,
    sleep: async (milliseconds) => { now += milliseconds },
    now: () => now,
  }
}

async function healthServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"status":"healthy"}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture-health-address-unavailable')
  return {
    url: `http://127.0.0.1:${address.port}/health`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  }
}

async function main(): Promise<void> {
  assert.equal(isHealthyJpOhlcvRepairResponseBody('{"status":"healthy"}'), true)
  assert.equal(isHealthyJpOhlcvRepairResponseBody('{"status":"unhealthy"}'), false)
  assert.equal(isHealthyJpOhlcvRepairResponseBody('not healthy'), false)
  const official = officialRows()
  const existing = existingRows(official)
  assert.equal(official.length, 4_218)
  assert.equal(existing.length, 151)
  const dryRun = buildJpOhlcvBackfillPlan({ date: TARGET_DATE, officialRows: official, existingRows: existing })
  const scope = buildJpOhlcvMissingOnlyRepairScope({ plan: dryRun, approvedConflictTickers: ['1447', '2164'] })
  assert.equal(scope.status, 'READY')
  assert.equal(scope.missingRows.length, 4_067)
  initializeDatabase(existing)
  const beforeDb = new DatabaseSync(databasePath, { readOnly: true })
  const beforeRows = exactDateRows(beforeDb)
  const beforeRowsSha256 = stableSha256(beforeRows)
  const beforeHistory = beforeDb.prepare('SELECT date,open,high,low,close,volume FROM ohlcv_daily WHERE ticker=? ORDER BY date')
    .all('7003') as Array<Record<string, string | number>>
  beforeDb.close()
  const beforeLab = computeSmaLab({ market: 'JP', timeframe: '1D', rows: beforeHistory as never, analysisDate: '2026-10-28' })
  assert.equal(beforeLab.status, 'available')
  assert.equal(beforeLab.status === 'available' ? beforeLab.periods.find((period) => period.period === 75)?.status : null, 'invalid_window')

  const lineage: JpOhlcvProductionExecutionConfiguration['lineage'] = {
    source: 'JQUANTS_API_V2_DAILY_QUOTES',
    priceBasis: 'JQUANTS_ADJUSTED_OHLCV_V1',
    targetDate: TARGET_DATE,
    officialSha256: scope.officialSha256,
    planSha256: scope.planSha256,
    missingRowsSha256: scope.missingRowsSha256,
    preservedConflictsSha256: scope.preservedConflictsSha256,
  }
  const baselineLineage = { ...lineage, repairStatus: 'BASELINE' as const }
  writeJson(sourcePointer, { version: 1, generation: 'jp-source-before', sourceGeneration: 'jp-source-before', transactionId: 'baseline', publishedAt: new Date().toISOString(), lineage: baselineLineage })
  writeJson(servingPointer, { version: 1, generation: 'jp-serving-before', sourceGeneration: 'jp-source-before', transactionId: 'baseline', publishedAt: new Date().toISOString(), lineage: baselineLineage })
  const writer = service('com.stockboard.fixture-writer', 'WRITER')
  const web = service('com.stockboard.fixture-web', 'READ_SERVICE')
  const analog = service('com.stockboard.fixture-analog', 'READ_SERVICE')
  writeJson(`${serviceSnapshotPath}.fixture-runtime.json`, {
    [web.label]: { loaded: true, disabled: false },
    [analog.label]: { loaded: true, disabled: false },
  })
  const webHealth = await healthServer()
  const analogHealth = await healthServer()
  try {
    const derivedScript = writeDerivedFixtureScript()
    const configPath = path.join(root, 'execution-config.json')
    const nested = (id: string, mode: 'forward' | 'rollback') => ({
      id,
      executable: process.execPath,
      executableSha256: sha256File(process.execPath),
      args: [derivedScript, databasePath, TARGET_DATE, mode, triggerRepairEvidencePath,
        `jp-source-${scope.missingRowsSha256.slice(0, 16)}`],
      workingDirectory: root,
      sealedFiles: [{ path: derivedScript, sha256: sha256File(derivedScript) }],
      timeoutMs: 30_000,
      environment: {},
      rollback: mode === 'rollback',
      publishesServingGeneration: false,
    })
    const verifier = (id: string, mode: 'forward' | 'rollback') => ({
      id,
      executable: process.execPath,
      executableSha256: sha256File(process.execPath),
      args: [tsxExecutable, derivedVerifierScript, '--config', configPath, '--mode', mode],
      workingDirectory: process.cwd(),
      sealedFiles: [
        { path: tsxExecutable, sha256: sha256File(tsxExecutable) },
        { path: derivedVerifierScript, sha256: sha256File(derivedVerifierScript) },
      ],
      timeoutMs: 30_000,
      environment: {},
      rollback: mode === 'rollback',
      publishesServingGeneration: true,
    })
    const config: JpOhlcvProductionExecutionConfiguration = {
      version: 1,
      mode: 'ISOLATED_FIXTURE',
      targetDate: TARGET_DATE,
      databaseRealpath: fs.realpathSync(databasePath),
      databaseIdentitySha256: databaseSchemaIdentitySha256(databasePath, sqliteExecutable),
      databaseObjectIdentitySha256: databaseFileObjectIdentitySha256(databasePath),
      stateDirectory,
      backupDirectory,
      minimumPostBackupFreeBytes: 1_000_000,
      storageIdentity: {
        mountPath: fs.realpathSync(root),
        volumeUuid: 'fixture-volume-identity',
        minFreeBytes: 0,
        minFreePercent: 0,
      },
      storageIdentitySha256: '',
      sqliteExecutable,
      sqliteExecutableSha256: sha256File(sqliteExecutable),
      sourceGenerationBefore: 'jp-source-before',
      sourceGenerationAfter: `jp-source-${scope.missingRowsSha256.slice(0, 16)}`,
      servingGenerationBefore: 'jp-serving-before',
      servingGenerationAfter: `jp-serving-${scope.planSha256.slice(0, 16)}`,
      sourceGenerationPointer: sourcePointer,
      servingGenerationPointer: servingPointer,
      triggerRepairEvidencePath,
      serviceSnapshotPath,
      writerServices: [writer],
      readServices: [web, analog],
      healthUrls: { web: webHealth.url, analog: analogHealth.url },
      requiredTickers: ['1306', '7003'],
      preservedConflictTickers: ['1447', '2164'],
      requiredTargetRows: [
        { ticker: '1306', open: 405, high: 410, low: 401, close: 407.9, volume: 1_300_600 },
        { ticker: '7003', open: 4400, high: 4490, low: 4380, close: 4434, volume: 7_003_000 },
      ],
      preservedConflictRows: [
        { ticker: '1447', open: 273.5, high: 284.9, low: 266.8, close: 270.2, volume: 1_049_400 },
        { ticker: '2164', open: 588, high: 608, low: 578, close: 598, volume: 216_400 },
      ],
      repairScope: {
        officialRows: 4218,
        existingRows: 151,
        matchingRows: 149,
        missingRows: 4067,
        conflicts: 2,
      },
      nestedCommands: [
        nested('fixture-derived-forward', 'forward'),
        verifier('fixture-verify-forward', 'forward'),
        nested('fixture-derived-rollback', 'rollback'),
        verifier('fixture-verify-rollback', 'rollback'),
      ],
      maximumMaintenanceMs: 5 * 60_000,
      lineage,
      ...createIntegrationIdentity(),
    }
    config.storageIdentitySha256 = jpOhlcvStorageIdentitySha256(config.storageIdentity)
    fs.mkdirSync(stateDirectory, { recursive: true })
    writeJson(configPath, config)
    const storageEnvironment = jpOhlcvStorageIdentityEnvironment(config)
    assert.doesNotThrow(() => assertJpOhlcvStorageIdentityEnvironment(config, storageEnvironment))
    assert.throws(
      () => assertJpOhlcvStorageIdentityEnvironment(config, { ...storageEnvironment, STOCK_DATA_VOLUME_UUID: 'tampered-volume' }),
      /repair_storage_identity_environment_mismatch:STOCK_DATA_VOLUME_UUID/,
    )
    assert.throws(
      () => assertJpOhlcvStorageIdentityEnvironment(config, { ...storageEnvironment, STOCK_DATA_MOUNT_PATH: undefined }),
      /repair_storage_identity_environment_mismatch:STOCK_DATA_MOUNT_PATH/,
    )
    assert.throws(
      () => assertJpOhlcvProductionExecutionConfiguration({ ...config, storageIdentity: undefined as never }),
      /repair_execution_configuration_storage_identity_invalid/,
    )
    assert.throws(
      () => assertJpOhlcvProductionExecutionConfiguration({
        ...config,
        nestedCommands: config.nestedCommands.map((command, index) => index === 0
          ? { ...command, environment: { ...command.environment, STOCK_DATA_VOLUME_UUID: 'override' } }
          : command),
      }),
      /repair_nested_command_storage_environment_forbidden/,
    )
    assert.throws(
      () => assertJpOhlcvProductionExecutionConfiguration({ ...config, storageIdentitySha256: '0'.repeat(64) }),
      /repair_execution_configuration_storage_identity_invalid/,
    )
    const unrelatedMount = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jp-ohlcv-unrelated-mount-')))
    const unrelatedIdentity = { ...config.storageIdentity, mountPath: unrelatedMount }
    assert.throws(
      () => assertJpOhlcvProductionExecutionConfiguration({
        ...config,
        storageIdentity: unrelatedIdentity,
        storageIdentitySha256: jpOhlcvStorageIdentitySha256(unrelatedIdentity),
      }),
      /repair_execution_configuration_storage_identity_invalid/,
    )
    const productionThresholdConfig = {
      ...config,
      mode: 'PRODUCTION' as const,
      minimumPostBackupFreeBytes: 150_000_000_000,
    }
    assert.throws(
      () => assertJpOhlcvProductionExecutionConfiguration({
        ...productionThresholdConfig,
        storageIdentity: { ...config.storageIdentity, minFreeBytes: 50 * 1024 ** 3 - 1 },
        storageIdentitySha256: jpOhlcvStorageIdentitySha256({
          ...config.storageIdentity,
          minFreeBytes: 50 * 1024 ** 3 - 1,
        }),
      }),
      /repair_execution_configuration_storage_identity_invalid/,
    )
    assert.throws(
      () => assertJpOhlcvProductionExecutionConfiguration({
        ...productionThresholdConfig,
        storageIdentity: { ...config.storageIdentity, minFreeBytes: 50 * 1024 ** 3, minFreePercent: 4 },
        storageIdentitySha256: jpOhlcvStorageIdentitySha256({
          ...config.storageIdentity,
          minFreeBytes: 50 * 1024 ** 3,
          minFreePercent: 4,
        }),
      }),
      /repair_execution_configuration_storage_identity_invalid/,
    )
    const packageApprovalPath = path.join(root, 'package-approval.json')
    const packagePlanPath = path.join(root, 'package-plan.json')
    const packageOrchestratorPath = path.join(root, 'package-orchestrator.mjs')
    writeJson(packageApprovalPath, { fixture: 'approval' })
    writeJson(packagePlanPath, { fixture: 'plan' })
    fs.writeFileSync(packageOrchestratorPath, 'export {}\n')
    const fixturePackage: JpOhlcvProductionExecutionPackage = {
      version: 1,
      targetDate: TARGET_DATE,
      preparedAt: new Date().toISOString(),
      configurationPath: configPath,
      configurationSha256: sha256File(configPath),
      approvalBundlePath: packageApprovalPath,
      approvalBundleSha256: sha256File(packageApprovalPath),
      executionPlanPath: packagePlanPath,
      executionPlanSha256: sha256File(packagePlanPath),
      orchestratorScriptPath: packageOrchestratorPath,
      orchestratorScriptSha256: sha256File(packageOrchestratorPath),
      runner: {
        id: 'production-repair-runner',
        executable: process.execPath,
        executableSha256: sha256File(process.execPath),
        args: ['fixture-runner', '--execution-configuration', configPath],
        workingDirectory: root,
        sealedFiles: [{ path: configPath, sha256: sha256File(configPath) }],
        timeoutMs: 60_000,
        environment: {
          ...storageEnvironment,
          STOCKBOARD_JP_OHLCV_EXECUTION_CONFIGURATION_SHA256: sha256File(configPath),
        },
        rollback: false,
        publishesServingGeneration: false,
      },
      productionMutationAuthorized: false,
      requiredApproval: 'EXACT_PACKAGE_AND_REPAIR_APPROVAL_HASHES',
    }
    assert.doesNotThrow(() => assertJpOhlcvProductionExecutionPackage(fixturePackage))
    assert.throws(
      () => assertJpOhlcvProductionExecutionPackage({
        ...fixturePackage,
        runner: {
          ...fixturePackage.runner,
          environment: { ...fixturePackage.runner.environment, STOCK_DATA_VOLUME_UUID: 'tampered' },
        },
      }),
      /repair_storage_identity_environment_mismatch:STOCK_DATA_VOLUME_UUID/,
    )
    assert.throws(
      () => assertJpOhlcvProductionExecutionPackage({
        ...fixturePackage,
        runner: {
          ...fixturePackage.runner,
          environment: {
            ...fixturePackage.runner.environment,
            STOCKBOARD_JP_OHLCV_EXECUTION_CONFIGURATION_SHA256: '0'.repeat(64),
          },
        },
      }),
      /repair_execution_package_runner_configuration_hash_contract_invalid/,
    )
    assert.throws(
      () => assertJpOhlcvProductionExecutionPackage({
        ...fixturePackage,
        runner: { ...fixturePackage.runner, args: ['fixture-runner'] },
      }),
      /repair_execution_package_runner_configuration_contract_invalid/,
    )
    const staleConfigPath = path.join(root, 'stale-execution-config.json')
    const { storageIdentity: _storageIdentity, storageIdentitySha256: _storageIdentitySha256, ...staleConfig } = config
    writeJson(staleConfigPath, staleConfig)
    assert.throws(
      () => assertJpOhlcvProductionExecutionPackage({
        ...fixturePackage,
        configurationPath: staleConfigPath,
        configurationSha256: sha256File(staleConfigPath),
        runner: {
          ...fixturePackage.runner,
          args: ['fixture-runner', '--execution-configuration', staleConfigPath],
          sealedFiles: [{ path: staleConfigPath, sha256: sha256File(staleConfigPath) }],
          environment: {
            ...fixturePackage.runner.environment,
            STOCKBOARD_JP_OHLCV_EXECUTION_CONFIGURATION_SHA256: sha256File(staleConfigPath),
          },
        },
      }),
      /repair_execution_package_stale_storage_identity_regenerate_required/,
    )
    const restoreIdentity = {
      version: 1 as const,
      configurationSha256: stableSha256(config),
      transactionId: 'fixture-rollback',
      databaseRealpath: config.databaseRealpath,
      backupRealpath: path.join(root, 'backup.sqlite'),
      backupSha256: 'a'.repeat(64),
      temporaryPath: `${config.databaseRealpath}.restore-fixture-rollback`,
      failedPath: `${config.databaseRealpath}.failed-fixture-rollback`,
    }
    assert.doesNotThrow(() => assertIncompleteJpOhlcvRestoreState({
      ...restoreIdentity,
      phase: 'PRIMARY_ARCHIVED',
      updatedAt: new Date().toISOString(),
    }, restoreIdentity))
    assert.throws(() => assertIncompleteJpOhlcvRestoreState({
      ...restoreIdentity,
      phase: 'COMPLETED',
      updatedAt: new Date().toISOString(),
    }, restoreIdentity), /repair_incomplete_restore_state_exact_identity_required/)
    assert.throws(() => assertIncompleteJpOhlcvRestoreState({
      ...restoreIdentity,
      transactionId: 'different-transaction',
      phase: 'PRIMARY_ARCHIVED',
      updatedAt: new Date().toISOString(),
    }, restoreIdentity), /repair_incomplete_restore_state_exact_identity_required/)
    execFileSync(process.execPath, [
      tsxExecutable,
      stageScript,
      '--operation', 'hold-read-services',
      '--config', configPath,
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'test',
        USE_LOCAL_DB: '1',
        STOCKBOARD_DB_PATH: databasePath,
        STOCKBOARD_JP_OHLCV_REPAIR_OWNER: '1',
        STOCKBOARD_JP_OHLCV_REPAIR_TRANSACTION_ID: 'fixture-e2e-success',
        STOCKBOARD_JP_OHLCV_REPAIR_LOCK_PATH: path.join(stateDirectory, 'repair.lock'),
        ...storageEnvironment,
      },
    })
    assert.equal(fs.existsSync(serviceSnapshotPath), true, 'pre-existing service snapshot is retained for idempotent hold')
    const stageCommand = (operation: string, extra: string[] = []) => ({
      executable: process.execPath,
      executableSha256: sha256File(process.execPath),
      sealedFiles: [
        { path: tsxExecutable, sha256: sha256File(tsxExecutable), snapshot: false },
        { path: stageScript, sha256: sha256File(stageScript) },
        { path: configPath, sha256: sha256File(configPath) },
      ],
      args: [tsxExecutable, stageScript, '--operation', operation, '--config', configPath, ...extra],
      workingDirectory: process.cwd(),
      timeoutMs: 60_000,
    })
    const plan: JpOhlcvRepairExecutionPlan = {
      version: 1,
      officialRows: official,
      commands: {
        createBackup: stageCommand('create-backup'),
        holdReadServices: stageCommand('hold-read-services'),
        publishSourceGeneration: stageCommand('publish-source-generation'),
        verifyDataGeneration: stageCommand('verify-data-generation'),
        rebuildDerivedServing: [
          stageCommand('run-derived', ['--command-id', 'fixture-derived-forward']),
          stageCommand('run-derived', ['--command-id', 'fixture-verify-forward']),
        ],
        verifyServing: stageCommand('verify-serving'),
        resumeReadServices: stageCommand('resume-read-services'),
        verifyBackupForRollback: stageCommand('verify-backup'),
        restoreBackup: stageCommand('restore-backup'),
        rebuildOriginalDerivedServing: [
          stageCommand('run-derived', ['--command-id', 'fixture-derived-rollback', '--rollback']),
          stageCommand('run-derived', ['--command-id', 'fixture-verify-rollback', '--rollback']),
        ],
        verifyOriginalServing: stageCommand('verify-original-serving'),
      },
    }
    const approval: JpOhlcvRepairApproval = {
      version: 1,
      executionScope: 'ISOLATED_FIXTURE',
      targetDate: TARGET_DATE,
      officialSha256: scope.officialSha256,
      planSha256: scope.planSha256,
      missingRowsSha256: scope.missingRowsSha256,
      preservedConflictsSha256: scope.preservedConflictsSha256,
      expectedOfficialRows: 4_218,
      expectedExistingRows: 151,
      expectedMatchingRows: 149,
      expectedMissingRows: 4_067,
      approvedConflictTickers: ['1447', '2164'],
      conflictDisposition: 'PRESERVE_EXISTING_HOLD',
      databaseRealpath: config.databaseRealpath,
      databaseIdentitySha256: config.databaseIdentitySha256,
      stateDirectory,
      backupDirectory,
      sourceGenerationBefore: config.sourceGenerationBefore,
      sourceGenerationAfter: config.sourceGenerationAfter,
      servingGenerationBefore: config.servingGenerationBefore,
      servingGenerationAfter: config.servingGenerationAfter,
      derivedPlanSha256: stableSha256(plan),
    }
    Object.assign(process.env, {
      NODE_ENV: 'test',
      USE_LOCAL_DB: '1',
      EXTERNAL_STORAGE_REQUIRED: 'false',
      STOCKBOARD_DB_PATH: databasePath,
      STOCKBOARD_JP_OHLCV_REPAIR_LOCK_PATH: path.join(stateDirectory, 'repair.lock'),
      SKIP_SCHEMA_ENSURE: '1',
      ...storageEnvironment,
    })
    delete process.env.STOCK_DATA_FAILED_SAFE_PATH
    const { createJpOhlcvCommandAdapters } = await import('@/lib/jp-ohlcv-command-adapter')
    const adapters = createJpOhlcvCommandAdapters({ approval, plan })
    const paths = { stateDirectory, journal: path.join(stateDirectory, 'repair-journal.json'), lock: path.join(stateDirectory, 'repair.lock') }
    const orchestration = await runJpOhlcvMaintenanceOrchestrator({
      config,
      driver: fakeWriterDriver(writer),
      assertOnlyApprovedReaderHandles: async () => undefined,
      runTransaction: async (assertWriterHoldValid) => {
        await assertWriterHoldValid()
        const result = await runJpOhlcvProductionRepair({
          approval,
          approvalSha256: repairApprovalSha256(approval),
          scope,
          paths,
          adapter: adapters.forward,
          transactionId: 'fixture-e2e-success',
        })
        return { status: result.status, archivedJournal: result.archivedJournal, transactionId: 'fixture-e2e-success' }
      },
      assertCommittedState: async () => {
        assert.equal(fs.existsSync(paths.lock), false)
        assert.equal(fs.existsSync(paths.journal), false)
        assert.equal(JSON.parse(fs.readFileSync(sourcePointer, 'utf8')).generation, config.sourceGenerationAfter)
        assert.equal(JSON.parse(fs.readFileSync(servingPointer, 'utf8')).generation, config.servingGenerationAfter)
      },
    })
    assert.equal(orchestration.result.status, 'COMMITTED')
    assert.deepEqual(orchestration.writerHold.restoredLabels, [writer.label])
    assert.equal(fs.existsSync(path.join(backupDirectory, 'fixture-e2e-success.sqlite-wal')), false)
    assert.equal(fs.existsSync(path.join(backupDirectory, 'fixture-e2e-success.sqlite-shm')), false)

    const afterDb = new DatabaseSync(databasePath, { readOnly: true })
    const afterRows = exactDateRows(afterDb)
    assert.equal(afterRows.length, 4_218)
    assert.deepEqual(afterRows.filter((row) => beforeRows.some((before) => before.ticker === row.ticker)), beforeRows)
    assert.notEqual(stableSha256(afterRows), beforeRowsSha256)
    const afterHistory = afterDb.prepare('SELECT date,open,high,low,close,volume FROM ohlcv_daily WHERE ticker=? ORDER BY date')
      .all('7003') as Array<Record<string, string | number>>
    const derived = afterDb.prepare('SELECT mode,rows FROM repair_derived_fixture WHERE id=1').get() as { mode: string; rows: number }
    afterDb.close()
    assert.equal(derived.mode, 'forward')
    assert.equal(derived.rows, 4_218)
    const afterLab = computeSmaLab({ market: 'JP', timeframe: '1D', rows: afterHistory as never, analysisDate: '2026-10-28' })
    assert.equal(afterLab.status, 'available')
    const sma75 = afterLab.status === 'available' ? afterLab.periods.find((period) => period.period === 75) : null
    assert.equal(sma75?.status, 'ok')
    assert.ok(sma75?.anchorValue != null)
    assert.deepEqual(sma75?.invalidBarsInWindow, [])
    const runtime = JSON.parse(fs.readFileSync(`${serviceSnapshotPath}.fixture-runtime.json`, 'utf8'))
    assert.equal(runtime[web.label].loaded, true)
    assert.equal(runtime[analog.label].loaded, true)
    await assert.rejects(async () => runJpOhlcvProductionRepair({
      approval,
      approvalSha256: repairApprovalSha256(approval),
      scope,
      paths,
      adapter: adapters.forward,
      transactionId: 'fixture-e2e-success',
    }), /repair_.*(?:terminal|committed|exists|state)/i)

    const restoreArgs = [
      tsxExecutable,
      stageScript,
      '--operation', 'restore-backup',
      '--config', configPath,
    ]
    const restoreEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: 'test',
      USE_LOCAL_DB: '1',
      STOCKBOARD_DB_PATH: databasePath,
      STOCKBOARD_JP_OHLCV_REPAIR_OWNER: '1',
      STOCKBOARD_JP_OHLCV_REPAIR_TRANSACTION_ID: 'fixture-e2e-success',
      STOCKBOARD_JP_OHLCV_REPAIR_LOCK_PATH: path.join(stateDirectory, 'repair.lock'),
    }
    execFileSync(process.execPath, [
      tsxExecutable,
      stageScript,
      '--operation', 'hold-read-services',
      '--config', configPath,
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: restoreEnvironment,
    })
    assert.throws(() => execFileSync(process.execPath, restoreArgs, {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...restoreEnvironment,
        STOCKBOARD_JP_OHLCV_REPAIR_TEST_RESTORE_CRASH_AT: 'after-primary-archived',
      },
    }), /Command failed/)
    const restoreStatePath = path.join(stateDirectory, 'rollback-restore-fixture-e2e-success.json')
    assert.equal(JSON.parse(fs.readFileSync(restoreStatePath, 'utf8')).phase, 'PRIMARY_ARCHIVED')
    assert.equal(fs.existsSync(databasePath), false)
    assert.equal(fs.existsSync(`${databasePath}.restore-fixture-e2e-success`), true)
    assert.equal(fs.existsSync(`${databasePath}.failed-fixture-e2e-success`), true)
    const restoredOutput = execFileSync(process.execPath, restoreArgs, {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: restoreEnvironment,
    }).trim().split('\n').at(-1)
    const restored = JSON.parse(restoredOutput ?? '{}') as { restorePhase?: unknown; sourceGeneration?: unknown }
    assert.equal(restored.restorePhase, 'COMPLETED')
    assert.equal(restored.sourceGeneration, config.sourceGenerationBefore)
    const restoredDb = new DatabaseSync(databasePath, { readOnly: true })
    const restoredRows = exactDateRows(restoredDb)
    restoredDb.close()
    assert.deepEqual(restoredRows, beforeRows)
    const restoredSource = JSON.parse(fs.readFileSync(sourcePointer, 'utf8'))
    assert.equal(restoredSource.generation, config.sourceGenerationBefore)
    assert.equal(restoredSource.transactionId, 'fixture-e2e-success')
    console.log(JSON.stringify({
      status: 'PASS',
      officialRows: 4_218,
      insertedRows: 4_067,
      preservedExistingRows: 151,
      preservedConflicts: ['1447', '2164'],
      sourceGeneration: config.sourceGenerationAfter,
      servingGeneration: config.servingGenerationAfter,
      sma75: sma75?.anchorValue,
      executionConfigurationSha256: executionConfigurationSha256(config),
      backupFiles: fs.readdirSync(backupDirectory).sort(),
      duplicateExecution: 'REJECTED',
      rollbackCrashRecovery: 'PASS',
    }))
  } finally {
    await webHealth.close()
    await analogHealth.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
