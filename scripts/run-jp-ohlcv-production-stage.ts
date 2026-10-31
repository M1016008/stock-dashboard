import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import {
  assertJpOhlcvProductionExecutionConfiguration,
  assertJpOhlcvStorageIdentityEnvironment,
  databaseFileObjectIdentitySha256,
  databaseSchemaIdentitySha256,
  executionConfigurationSha256,
  isHealthyJpOhlcvRepairResponseBody,
  jpOhlcvStorageIdentityEnvironment,
  sha256File,
  type JpOhlcvLaunchdServiceIdentity,
  type JpOhlcvNestedCommand,
  type JpOhlcvProductionExecutionConfiguration,
  type JpOhlcvServiceSnapshot,
} from '@/lib/jp-ohlcv-executable-plan'
import { stableSha256 } from '@/lib/jp-ohlcv-data-quality'
import {
  boundedBackupOperationTimeout,
  JP_OHLCV_BACKUP_TIME_LIMITS as backupTimeLimits,
} from '@/lib/jp-ohlcv-backup-time-budget'
import {
  assertNoUnauthorizedDatabaseHandles,
  createLaunchdWriterHoldDriver,
  type LaunchdRuntimeIdentity,
} from '@/lib/storage/launchd-writer-hold-driver'

type GenerationPointer = {
  version: 1
  generation: string
  sourceGeneration: string
  transactionId: string
  publishedAt: string
  lineage: JpOhlcvProductionExecutionConfiguration['lineage'] & {
    repairStatus: 'BASELINE' | 'REPAIRED'
  }
}

type RestorePhase =
  | 'PREPARING'
  | 'BACKUP_STAGED'
  | 'PRIMARY_ARCHIVED'
  | 'BACKUP_ACTIVATED'
  | 'SOURCE_GENERATION_RESTORED'
  | 'COMPLETED'

type RestoreState = {
  version: 1
  configurationSha256: string
  transactionId: string
  databaseRealpath: string
  backupRealpath: string
  backupSha256: string
  temporaryPath: string
  failedPath: string
  phase: RestorePhase
  updatedAt: string
}

const operation = value('--operation')
const configFile = absolute('--config')
const config = readJson<JpOhlcvProductionExecutionConfiguration>(configFile)
const transactionId = process.env.STOCKBOARD_JP_OHLCV_REPAIR_TRANSACTION_ID
if (!transactionId || process.env.STOCKBOARD_JP_OHLCV_REPAIR_OWNER !== '1') {
  throw new Error('repair_stage_owner_environment_required')
}
const restoreStateForMissingDatabase = path.join(
  config.stateDirectory,
  `rollback-restore-${transactionId}.json`,
)
assertJpOhlcvProductionExecutionConfiguration(config, {
  allowMissingDatabaseForRestore: operation === 'restore-backup'
    && !fs.existsSync(config.databaseRealpath)
    && fs.existsSync(restoreStateForMissingDatabase),
})
assertJpOhlcvStorageIdentityEnvironment(config, process.env)
const configSha256 = executionConfigurationSha256(config, {
  allowMissingDatabaseForRestore: operation === 'restore-backup'
    && !fs.existsSync(config.databaseRealpath)
    && fs.existsSync(restoreStateForMissingDatabase),
})
if (process.env.STOCKBOARD_JP_OHLCV_EXECUTION_CONFIGURATION_SHA256 !== sha256File(configFile)) {
  throw new Error('repair_stage_configuration_file_identity_mismatch')
}
const stageStartedAtMs = Date.now()

type BackupOperationTiming = {
  operation: string
  startedAt: string
  completedAt: string
  durationMs: number
  timeoutMs: number
}

function value(flag: string): string {
  const index = process.argv.indexOf(flag)
  const result = index >= 0 ? process.argv[index + 1] : null
  if (!result || result.startsWith('--')) throw new Error(`${flag}_required`)
  return result
}

function optional(flag: string): string | null {
  const index = process.argv.indexOf(flag)
  const result = index >= 0 ? process.argv[index + 1] : null
  return !result || result.startsWith('--') ? null : result
}

function absolute(flag: string): string {
  const result = value(flag)
  if (!path.isAbsolute(result)) throw new Error(`${flag}_absolute_path_required`)
  return path.resolve(result)
}

function readJson<T>(file: string): T {
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error('repair_stage_json_symlink_forbidden')
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T
}

function syncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, 'r')
  try { fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
}

function atomicJson(file: string, payload: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`
  const descriptor = fs.openSync(temporary, 'wx', 0o600)
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(payload, null, 2)}\n`)
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
  fs.renameSync(temporary, file)
  syncDirectory(path.dirname(file))
}

function assertDatabaseIdentity(): void {
  if (fs.realpathSync(config.databaseRealpath) !== config.databaseRealpath
    || databaseFileObjectIdentitySha256(config.databaseRealpath) !== config.databaseObjectIdentitySha256) {
    throw new Error('repair_stage_database_identity_mismatch')
  }
  if (databaseSchemaIdentitySha256(config.databaseRealpath, config.sqliteExecutable)
      !== config.databaseIdentitySha256) {
    throw new Error('repair_stage_database_schema_identity_mismatch')
  }
}

function sqlite(
  sql: string,
  database = config.databaseRealpath,
  options: { timeoutMs?: number; errorCode?: string } = {},
): string {
  const startedAt = Date.now()
  const result = spawnSync(config.sqliteExecutable, [database, sql], {
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 30 * 60_000,
    env: { NODE_ENV: 'production', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
  })
  if (result.status !== 0 || result.signal || result.error) {
    const detail = result.error?.message || result.stderr.trim() || `exit_${result.status ?? 'null'}_signal_${result.signal ?? 'none'}`
    throw new Error(`${options.errorCode ?? 'repair_stage_sqlite_failed'}:elapsed_${Date.now() - startedAt}:timeout_${options.timeoutMs ?? 30 * 60_000}:${detail}`)
  }
  return result.stdout.trim()
}

function sqliteReadOnly(
  sql: string,
  database: string,
  options: { timeoutMs?: number; errorCode?: string } = {},
): string {
  const startedAt = Date.now()
  const result = spawnSync(config.sqliteExecutable, [`${pathToFileURL(database).href}?mode=ro`, sql], {
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 30 * 60_000,
    env: { NODE_ENV: 'production', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
  })
  if (result.status !== 0 || result.signal || result.error) {
    const detail = result.error?.message || result.stderr.trim() || `exit_${result.status ?? 'null'}_signal_${result.signal ?? 'none'}`
    throw new Error(`${options.errorCode ?? 'repair_stage_sqlite_readonly_failed'}:elapsed_${Date.now() - startedAt}:timeout_${options.timeoutMs ?? 30 * 60_000}:${detail}`)
  }
  return result.stdout.trim()
}

function normalizeBackupArtifact(backup: string, timeoutMs: number): void {
  if (sqlite('PRAGMA journal_mode=DELETE;', backup, {
    timeoutMs,
    errorCode: 'repair_backup_journal_mode_timeout_or_failure',
  }).trim().toLowerCase() !== 'delete') {
    throw new Error('repair_backup_journal_mode_normalization_failed')
  }
  const wal = `${backup}-wal`
  if (fs.existsSync(wal)) {
    if (fs.statSync(wal).size !== 0) throw new Error('repair_backup_wal_not_empty_after_normalization')
    fs.unlinkSync(wal)
  }
  const shm = `${backup}-shm`
  if (fs.existsSync(shm)) fs.unlinkSync(shm)
  const descriptor = fs.openSync(backup, 'r')
  try { fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
  syncDirectory(path.dirname(backup))
}

function sha256FileWithTimeout(file: string, timeoutMs: number, errorCode: string): string {
  const startedAt = Date.now()
  const hash = crypto.createHash('sha256')
  const descriptor = fs.openSync(file, 'r')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    for (;;) {
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`${errorCode}:elapsed_${Date.now() - startedAt}:timeout_${timeoutMs}`)
      }
      const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null)
      if (bytes === 0) break
      hash.update(buffer.subarray(0, bytes))
    }
  } finally {
    fs.closeSync(descriptor)
  }
  if (Date.now() - startedAt > timeoutMs) {
    throw new Error(`${errorCode}:elapsed_${Date.now() - startedAt}:timeout_${timeoutMs}`)
  }
  return hash.digest('hex')
}

function operationTimeout(input: {
  label: string
  stageTimeoutMs: number
  maxTimeoutMs: number
  minimumTimeoutMs: number
  reserveAfterMs: number
}): number {
  return boundedBackupOperationTimeout({
    ...input,
    stageStartedAtMs,
    nowMs: Date.now(),
  })
}

function measure<T>(
  operationName: string,
  timeoutMs: number,
  timings: BackupOperationTiming[],
  action: () => T,
): T {
  const startedAt = Date.now()
  try {
    return action()
  } finally {
    const completedAt = Date.now()
    timings.push({
      operation: operationName,
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date(completedAt).toISOString(),
      durationMs: completedAt - startedAt,
      timeoutMs,
    })
  }
}

function sqliteQuoted(file: string): string {
  if (file.includes('\0') || file.includes('\n') || file.includes('\r')) {
    throw new Error('repair_stage_sqlite_path_invalid')
  }
  return `'${file.replaceAll("'", "''")}'`
}

function sqlText(value: string): string {
  if (value.includes('\0') || value.includes('\n') || value.includes('\r')) {
    throw new Error('repair_stage_sql_text_invalid')
  }
  return `'${value.replaceAll("'", "''")}'`
}

function assertExactTargetRow(input: {
  ticker: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}): void {
  const encoded = sqlite(`SELECT json_array(open,high,low,close,volume) FROM ohlcv_daily
    WHERE ticker=${sqlText(input.ticker)} AND date=${sqlText(config.targetDate)};`)
  const values = JSON.parse(encoded || 'null') as unknown
  if (!Array.isArray(values) || values.length !== 5
    || values.some((value, index) => Number(value) !== [input.open, input.high, input.low, input.close, input.volume][index])) {
    throw new Error(`repair_serving_target_value_mismatch:${input.ticker}`)
  }
}

function generationPointer(file: string, expectedTransactionId?: string): GenerationPointer {
  const pointer = readJson<GenerationPointer>(file)
  const expectedStatus = pointer.sourceGeneration === config.sourceGenerationAfter ? 'REPAIRED' : 'BASELINE'
  const { repairStatus, ...pointerLineage } = pointer.lineage ?? {} as GenerationPointer['lineage']
  if (pointer.version !== 1 || !pointer.generation || !pointer.sourceGeneration
    || !pointer.transactionId
    || (expectedTransactionId !== undefined && pointer.transactionId !== expectedTransactionId)
    || repairStatus !== expectedStatus
    || stableSha256(pointerLineage) !== stableSha256(config.lineage)) {
    throw new Error('repair_stage_generation_pointer_invalid')
  }
  return pointer
}

function restoreStatePath(): string {
  return path.join(config.stateDirectory, `rollback-restore-${transactionId}.json`)
}

function expectedRestoreState(input: {
  backupRealpath: string
  backupSha256: string
}): Omit<RestoreState, 'phase' | 'updatedAt'> {
  return {
    version: 1,
    configurationSha256: configSha256,
    transactionId: transactionId!,
    databaseRealpath: config.databaseRealpath,
    backupRealpath: input.backupRealpath,
    backupSha256: input.backupSha256,
    temporaryPath: `${config.databaseRealpath}.restore-${transactionId}`,
    failedPath: `${config.databaseRealpath}.failed-${transactionId}`,
  }
}

function readRestoreState(expected: Omit<RestoreState, 'phase' | 'updatedAt'>): RestoreState | null {
  const file = restoreStatePath()
  if (!fs.existsSync(file)) return null
  const state = readJson<RestoreState>(file)
  const { phase: _phase, updatedAt: _updatedAt, ...identity } = state
  if (stableSha256(identity) !== stableSha256(expected)
    || !['PREPARING', 'BACKUP_STAGED', 'PRIMARY_ARCHIVED', 'BACKUP_ACTIVATED',
      'SOURCE_GENERATION_RESTORED', 'COMPLETED'].includes(state.phase)
    || !Number.isFinite(Date.parse(state.updatedAt))) {
    throw new Error(`repair_restore_state_invalid:${file}`)
  }
  return state
}

function writeRestoreState(
  expected: Omit<RestoreState, 'phase' | 'updatedAt'>,
  phase: RestorePhase,
): RestoreState {
  const state: RestoreState = { ...expected, phase, updatedAt: new Date().toISOString() }
  atomicJson(restoreStatePath(), state)
  return state
}

function fixtureRestoreCrash(point: string): void {
  if (config.mode === 'ISOLATED_FIXTURE'
    && process.env.STOCKBOARD_JP_OHLCV_REPAIR_TEST_RESTORE_CRASH_AT === point) {
    throw new Error(`repair_fixture_restore_crash:${point}`)
  }
}

function pointerMatchesRestoredSource(): boolean {
  try {
    const pointer = generationPointer(config.sourceGenerationPointer, transactionId)
    return pointer.generation === config.sourceGenerationBefore
      && pointer.sourceGeneration === config.sourceGenerationBefore
  } catch {
    return false
  }
}

function assertRestoredDatabase(input: Omit<RestoreState, 'phase' | 'updatedAt'>): void {
  if (!fs.existsSync(input.databaseRealpath)
    || sha256File(input.databaseRealpath) !== input.backupSha256
    || !fs.existsSync(input.failedPath)
    || fs.existsSync(input.temporaryPath)
    || fs.existsSync(`${input.databaseRealpath}-wal`)
    || fs.existsSync(`${input.databaseRealpath}-shm`)) {
    throw new Error(`repair_restore_activated_state_invalid:${restoreStatePath()}`)
  }
}

async function assertRestoreExecutionBarrier(input: Omit<RestoreState, 'phase' | 'updatedAt'>): Promise<void> {
  if (!fs.existsSync(config.serviceSnapshotPath)) {
    throw new Error(`repair_restore_read_service_snapshot_missing:${config.serviceSnapshotPath}`)
  }
  const snapshot = readJson<JpOhlcvServiceSnapshot>(config.serviceSnapshotPath)
  assertSnapshot(snapshot, config.serviceSnapshotPath, 'READ_SERVICE')
  assertSnapshotServices(snapshot, config.readServices)
  const services = config.mode === 'PRODUCTION'
    ? [...config.writerServices, ...config.readServices]
    : config.readServices
  const driver = config.mode === 'PRODUCTION'
    ? createLaunchdWriterHoldDriver(services.map(launchdIdentity))
    : null
  for (const service of services) {
    const observed = driver ? await driver.observe(service.label) : await observeFixture(service)
    if (observed.loaded || observed.pid !== null || observed.processGroupId !== null) {
      throw new Error(`repair_restore_service_not_held:${service.label}`)
    }
  }
  if (config.mode === 'PRODUCTION') {
    const files = [
      input.databaseRealpath,
      `${input.databaseRealpath}-wal`,
      `${input.databaseRealpath}-shm`,
      input.temporaryPath,
      input.failedPath,
      `${input.failedPath}-wal`,
      `${input.failedPath}-shm`,
    ].filter((file) => fs.existsSync(file))
    if (fs.existsSync(input.databaseRealpath)) {
      assertNoUnauthorizedDatabaseHandles({
        databasePath: input.databaseRealpath,
        approvedReaders: [],
        timeoutMs: 30_000,
      })
    } else if (files.length > 0) {
      const result = spawnSync('/usr/sbin/lsof', ['-nP', '-Fpcn', ...files], {
        encoding: 'utf8',
        timeout: 30_000,
      })
      if (result.status === 0 && result.stdout.trim()) {
        throw new Error('repair_restore_database_handle_present')
      }
      if (result.status !== 0 && !(result.status === 1 && !result.stdout.trim() && !result.stderr.trim())) {
        throw new Error('repair_restore_database_handle_probe_ambiguous')
      }
    }
  }
}

async function restoreBackupWithJournal(metadata: {
  backupRealpath: string
  backupSha256: string
}): Promise<RestoreState> {
  const expected = expectedRestoreState(metadata)
  await assertRestoreExecutionBarrier(expected)
  let state = readRestoreState(expected)
  if (!state) {
    if (!fs.existsSync(expected.databaseRealpath)
      || fs.existsSync(expected.temporaryPath)
      || fs.existsSync(expected.failedPath)) {
      throw new Error(`repair_restore_unjournaled_artifact_present:${restoreStatePath()}`)
    }
    state = writeRestoreState(expected, 'PREPARING')
  }

  if (state.phase === 'PREPARING') {
    if (fs.existsSync(expected.failedPath)) {
      throw new Error(`repair_restore_primary_archived_without_journal_phase:${restoreStatePath()}`)
    }
    if (fs.existsSync(expected.temporaryPath)
      && sha256File(expected.temporaryPath) !== expected.backupSha256) {
      fs.unlinkSync(expected.temporaryPath)
      syncDirectory(path.dirname(expected.temporaryPath))
    }
    if (!fs.existsSync(expected.temporaryPath)) {
      fs.copyFileSync(expected.backupRealpath, expected.temporaryPath, fs.constants.COPYFILE_EXCL)
    }
    if (sha256File(expected.temporaryPath) !== expected.backupSha256) {
      throw new Error(`repair_restore_copy_hash_mismatch:${restoreStatePath()}`)
    }
    const temporaryDescriptor = fs.openSync(expected.temporaryPath, 'r')
    try { fs.fsyncSync(temporaryDescriptor) } finally { fs.closeSync(temporaryDescriptor) }
    syncDirectory(path.dirname(expected.temporaryPath))
    state = writeRestoreState(expected, 'BACKUP_STAGED')
    fixtureRestoreCrash('after-backup-staged')
  }

  if (state.phase === 'BACKUP_STAGED') {
    const databaseExists = fs.existsSync(expected.databaseRealpath)
    const temporaryExists = fs.existsSync(expected.temporaryPath)
    const failedExists = fs.existsSync(expected.failedPath)
    if (databaseExists && failedExists && !temporaryExists
      && sha256File(expected.databaseRealpath) === expected.backupSha256) {
      state = writeRestoreState(expected, 'BACKUP_ACTIVATED')
    } else {
      if (databaseExists && !failedExists && temporaryExists) {
        fs.renameSync(expected.databaseRealpath, expected.failedPath)
        fixtureRestoreCrash('after-primary-rename')
      } else if (databaseExists || !failedExists || !temporaryExists) {
        throw new Error(`repair_restore_archive_state_ambiguous:${restoreStatePath()}`)
      }
      for (const suffix of ['-wal', '-shm']) {
        const source = `${expected.databaseRealpath}${suffix}`
        const destination = `${expected.failedPath}${suffix}`
        if (fs.existsSync(source) && fs.existsSync(destination)) {
          throw new Error(`repair_restore_sidecar_state_ambiguous:${destination}`)
        }
        if (fs.existsSync(source)) fs.renameSync(source, destination)
      }
      syncDirectory(path.dirname(expected.databaseRealpath))
      state = writeRestoreState(expected, 'PRIMARY_ARCHIVED')
      fixtureRestoreCrash('after-primary-archived')
    }
  }

  if (state.phase === 'PRIMARY_ARCHIVED') {
    if (fs.existsSync(expected.databaseRealpath) && !fs.existsSync(expected.temporaryPath)
      && fs.existsSync(expected.failedPath)
      && sha256File(expected.databaseRealpath) === expected.backupSha256) {
      state = writeRestoreState(expected, 'BACKUP_ACTIVATED')
    } else {
      if (fs.existsSync(expected.databaseRealpath)
        || !fs.existsSync(expected.temporaryPath)
        || !fs.existsSync(expected.failedPath)) {
        throw new Error(`repair_restore_activation_state_ambiguous:${restoreStatePath()}`)
      }
      if (sha256File(expected.temporaryPath) !== expected.backupSha256) {
        throw new Error(`repair_restore_staged_hash_mismatch:${restoreStatePath()}`)
      }
      fs.renameSync(expected.temporaryPath, expected.databaseRealpath)
      syncDirectory(path.dirname(expected.databaseRealpath))
      fixtureRestoreCrash('after-backup-activated')
      assertRestoredDatabase(expected)
      state = writeRestoreState(expected, 'BACKUP_ACTIVATED')
    }
  }

  if (state.phase === 'BACKUP_ACTIVATED') {
    assertRestoredDatabase(expected)
    if (!pointerMatchesRestoredSource()) {
      publishGeneration(config.sourceGenerationPointer, config.sourceGenerationBefore, config.sourceGenerationBefore)
    }
    fixtureRestoreCrash('after-source-generation-restored')
    if (!pointerMatchesRestoredSource()) {
      throw new Error(`repair_restore_source_generation_mismatch:${restoreStatePath()}`)
    }
    state = writeRestoreState(expected, 'SOURCE_GENERATION_RESTORED')
  }

  if (state.phase === 'SOURCE_GENERATION_RESTORED') {
    assertRestoredDatabase(expected)
    if (!pointerMatchesRestoredSource()) {
      throw new Error(`repair_restore_source_generation_mismatch:${restoreStatePath()}`)
    }
    state = writeRestoreState(expected, 'COMPLETED')
  }

  if (state.phase !== 'COMPLETED') {
    throw new Error(`repair_restore_incomplete:${restoreStatePath()}`)
  }
  assertRestoredDatabase(expected)
  if (!pointerMatchesRestoredSource()) {
    throw new Error(`repair_restore_completed_generation_mismatch:${restoreStatePath()}`)
  }
  return state
}

function publishGeneration(file: string, generation: string, sourceGeneration: string): GenerationPointer {
  const pointer: GenerationPointer = {
    version: 1,
    generation,
    sourceGeneration,
    transactionId: transactionId!,
    publishedAt: new Date().toISOString(),
    lineage: {
      ...config.lineage,
      repairStatus: sourceGeneration === config.sourceGenerationAfter ? 'REPAIRED' : 'BASELINE',
    },
  }
  atomicJson(file, pointer)
  return pointer
}

function launchdIdentity(service: JpOhlcvLaunchdServiceIdentity): LaunchdRuntimeIdentity {
  return {
    label: service.label,
    plistPath: service.plistPath,
    definitionSha256: service.definitionSha256,
    program: service.program,
  }
}

function fixtureRuntimeFile(): string {
  return `${config.serviceSnapshotPath}.fixture-runtime.json`
}

async function observeFixture(service: JpOhlcvLaunchdServiceIdentity): Promise<{
  loaded: boolean
  disabled: boolean
  pid: number | null
  processGroupId: number | null
}> {
  const runtime = readJson<Record<string, { loaded: boolean; disabled: boolean }>>(fixtureRuntimeFile())
  const state = runtime[service.label]
  if (!state) throw new Error(`repair_fixture_service_missing:${service.label}`)
  return { ...state, pid: state.loaded ? process.pid : null, processGroupId: state.loaded ? process.pid : null }
}

function setFixtureLoaded(services: JpOhlcvLaunchdServiceIdentity[], loaded: boolean): void {
  const file = fixtureRuntimeFile()
  const runtime = readJson<Record<string, { loaded: boolean; disabled: boolean }>>(file)
  for (const service of services) {
    const state = runtime[service.label]
    if (!state) throw new Error(`repair_fixture_service_missing:${service.label}`)
    if (!state.disabled) state.loaded = loaded
  }
  atomicJson(file, runtime)
}

async function captureServices(services: JpOhlcvLaunchdServiceIdentity[]): Promise<JpOhlcvServiceSnapshot> {
  const driver = config.mode === 'PRODUCTION'
    ? createLaunchdWriterHoldDriver(services.map(launchdIdentity))
    : null
  const observed: JpOhlcvServiceSnapshot['services'] = []
  for (const service of services) {
    const state = driver ? await driver.observe(service.label) : await observeFixture(service)
    observed.push({
      ...service,
      loaded: state.loaded,
      disabled: state.disabled,
      pid: state.pid ?? null,
      processGroupId: state.processGroupId ?? null,
    })
  }
  return {
    version: 1,
    configurationSha256: configSha256,
    transactionId: transactionId!,
    capturedAt: new Date().toISOString(),
    services: observed,
  }
}

const inheritedBackupEvidenceOperations = new Set(['verify-backup', 'restore-backup'])
const inheritedReadSnapshotOperations = new Set(['hold-read-services', 'restore-backup', 'resume-read-services'])

function assertEvidenceConfiguration(input: {
  recordedConfigurationSha256: string
  evidenceFile: string
  evidenceKind: 'BACKUP_METADATA' | 'READ_SERVICE_SNAPSHOT'
}): void {
  if (input.recordedConfigurationSha256 === configSha256) return
  const inherited = config.emergencyRecoveryEvidence
  const allowed = input.evidenceKind === 'BACKUP_METADATA'
    ? inheritedBackupEvidenceOperations.has(operation)
    : inheritedReadSnapshotOperations.has(operation)
  const expectedFileSha256 = input.evidenceKind === 'BACKUP_METADATA'
    ? inherited?.backupMetadataFileSha256
    : inherited?.readServiceSnapshotFileSha256
  if (!allowed || !inherited
    || input.recordedConfigurationSha256 !== inherited.originalConfigurationSha256
    || sha256File(input.evidenceFile) !== expectedFileSha256) {
    throw new Error(`repair_inherited_${input.evidenceKind.toLowerCase()}_identity_mismatch`)
  }
}

function assertSnapshot(
  snapshot: JpOhlcvServiceSnapshot,
  snapshotFile: string,
  expectedRole?: JpOhlcvLaunchdServiceIdentity['role'],
): void {
  assertEvidenceConfiguration({
    recordedConfigurationSha256: snapshot.configurationSha256,
    evidenceFile: snapshotFile,
    evidenceKind: 'READ_SERVICE_SNAPSHOT',
  })
  if (snapshot.version !== 1
    || snapshot.transactionId !== transactionId || snapshot.services.length === 0) {
    throw new Error('repair_service_snapshot_identity_mismatch')
  }
  if (expectedRole && snapshot.services.some((service) => service.role !== expectedRole)) {
    throw new Error('repair_service_snapshot_role_mismatch')
  }
}

function assertSnapshotServices(
  snapshot: JpOhlcvServiceSnapshot,
  services: JpOhlcvLaunchdServiceIdentity[],
): void {
  if (snapshot.services.length !== services.length) throw new Error('repair_service_snapshot_set_mismatch')
  for (const service of services) {
    const captured = snapshot.services.find((candidate) => candidate.label === service.label)
    if (!captured
      || captured.plistPath !== service.plistPath
      || captured.definitionSha256 !== service.definitionSha256
      || captured.program !== service.program
      || captured.role !== service.role) {
      throw new Error(`repair_service_snapshot_service_mismatch:${service.label}`)
    }
  }
}

async function holdServices(services: JpOhlcvLaunchdServiceIdentity[], snapshotFile: string): Promise<JpOhlcvServiceSnapshot> {
  let snapshot: JpOhlcvServiceSnapshot
  if (fs.existsSync(snapshotFile)) {
    snapshot = readJson<JpOhlcvServiceSnapshot>(snapshotFile)
    assertSnapshot(snapshot, snapshotFile, services[0]?.role)
    assertSnapshotServices(snapshot, services)
  } else {
    snapshot = await captureServices(services)
    assertSnapshotServices(snapshot, services)
    atomicJson(snapshotFile, snapshot)
  }
  if (config.mode === 'ISOLATED_FIXTURE') {
    setFixtureLoaded(services, false)
  } else {
    const driver = createLaunchdWriterHoldDriver(services.map(launchdIdentity))
    for (const service of services) {
      const state = await driver.observe(service.label)
      if (state.loaded) await driver.bootout(service.label)
    }
    for (const service of services) {
      const state = await driver.observe(service.label)
      if (state.loaded || state.instances !== 0) throw new Error(`repair_service_hold_failed:${service.label}`)
      const before = snapshot.services.find((entry) => entry.label === service.label)!
      if (before.processGroupId && await driver.processGroupAlive(before.processGroupId)) {
        throw new Error(`repair_service_process_group_remains:${service.label}`)
      }
    }
  }
  return snapshot
}

async function restoreServices(
  snapshotFile: string,
  archiveAfterRestore = true,
): Promise<JpOhlcvServiceSnapshot> {
  const snapshot = readJson<JpOhlcvServiceSnapshot>(snapshotFile)
  assertSnapshot(snapshot, snapshotFile, 'READ_SERVICE')
  assertSnapshotServices(snapshot, config.readServices)
  const services = snapshot.services.map(({ loaded: _loaded, disabled: _disabled, pid: _pid, processGroupId: _pgid, ...service }) => service)
  if (config.mode === 'ISOLATED_FIXTURE') {
    const file = fixtureRuntimeFile()
    const runtime = readJson<Record<string, { loaded: boolean; disabled: boolean }>>(file)
    for (const before of snapshot.services) runtime[before.label] = { loaded: before.loaded, disabled: before.disabled }
    atomicJson(file, runtime)
  } else {
    const driver = createLaunchdWriterHoldDriver(services.map(launchdIdentity))
    for (const before of [...snapshot.services].reverse()) {
      const current = await driver.observe(before.label)
      if (current.disabled !== before.disabled) throw new Error(`repair_service_disabled_state_changed:${before.label}`)
      if (before.loaded && !current.loaded) await driver.bootstrap(before.label)
      if (!before.loaded && current.loaded) await driver.bootout(before.label)
      const restored = await driver.observe(before.label)
      if (restored.loaded !== before.loaded || restored.disabled !== before.disabled) {
        throw new Error(`repair_service_restore_failed:${before.label}`)
      }
    }
  }
  if (archiveAfterRestore) fs.renameSync(snapshotFile, `${snapshotFile}.restored-${transactionId}`)
  return snapshot
}

async function health(url: string): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const response = await fetch(url, { cache: 'no-store', signal: controller.signal })
    if (!response.ok) throw new Error(`status_${response.status}`)
    const body = await response.text()
    if (!isHealthyJpOhlcvRepairResponseBody(body)) {
      throw new Error('body_not_healthy')
    }
  } finally {
    clearTimeout(timer)
  }
}

async function runNested(command: JpOhlcvNestedCommand): Promise<void> {
  if (sha256File(fs.realpathSync(command.executable)) !== command.executableSha256) {
    throw new Error(`repair_nested_executable_changed:${command.id}`)
  }
  for (const sealed of command.sealedFiles) {
    if (sha256File(fs.realpathSync(sealed.path)) !== sealed.sha256) {
      throw new Error(`repair_nested_sealed_file_changed:${command.id}`)
    }
  }
  await new Promise<void>((resolve, reject) => {
    const updateLockOwner = process.env.STOCKBOARD_JP_OHLCV_REPAIR_UPDATE_LOCK_OWNER
    if (!updateLockOwner) throw new Error('repair_nested_update_lock_owner_missing')
    const environment = Object.fromEntries(Object.entries(command.environment).map(([key, value]) => [
      key,
      value === '__REPAIR_UPDATE_LOCK_OWNER__'
        ? updateLockOwner ?? (() => { throw new Error('repair_nested_update_lock_owner_missing') })()
        : value,
    ]))
    const args = command.args.map((arg, index) => (
      index > 0 && command.args[index - 1] === '--config' ? configFile : arg
    ))
    const child: ChildProcess = spawn(command.executable, args, {
      cwd: command.workingDirectory,
      env: {
        HOME: process.env.HOME,
        USER: process.env.USER,
        LOGNAME: process.env.LOGNAME,
        TMPDIR: process.env.TMPDIR,
        LANG: process.env.LANG,
        LC_ALL: process.env.LC_ALL,
        TZ: process.env.TZ,
        NODE_ENV: config.mode === 'PRODUCTION' ? 'production' : 'test',
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        USE_LOCAL_DB: process.env.USE_LOCAL_DB,
        STOCKBOARD_DB_PATH: process.env.STOCKBOARD_DB_PATH,
        SKIP_SCHEMA_ENSURE: '1',
        ...environment,
        ...jpOhlcvStorageIdentityEnvironment(config),
        STOCKBOARD_JP_OHLCV_REPAIR_OWNER: '1',
        STOCKBOARD_JP_OHLCV_REPAIR_TRANSACTION_ID: transactionId!,
        STOCKBOARD_JP_OHLCV_REPAIR_LOCK_PATH: process.env.STOCKBOARD_JP_OHLCV_REPAIR_LOCK_PATH!,
        STOCKBOARD_JP_OHLCV_REPAIR_UPDATE_LOCK_OWNER: updateLockOwner,
        STOCKBOARD_UPDATE_JOB_TYPE: 'jp_ohlcv_gap_repair',
      },
      shell: false,
      // Stay in the stage runner's process group so the outer supervisor always
      // terminates this command and every descendant before rollback can begin.
      detached: false,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    let settled = false
    let timedOut = false
    let killTimer: NodeJS.Timeout | null = null
    const terminationTimer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5_000)
    }, command.timeoutMs)
    child.stderr?.on('data', (chunk: Buffer | string) => { stderr = `${stderr}${String(chunk)}`.slice(-4000) })
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(terminationTimer)
      if (killTimer) clearTimeout(killTimer)
      reject(error)
    })
    child.once('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(terminationTimer)
      if (killTimer) clearTimeout(killTimer)
      if (timedOut) reject(new Error(`repair_nested_command_timeout:${command.id}`))
      else if (code !== 0 || signal !== null) {
        reject(new Error(`repair_nested_command_failed:${command.id}:exit_${code}:signal_${signal}:${stderr}`))
      } else resolve()
    })
  })
}

function backupPath(): string {
  return path.join(config.backupDirectory, `${transactionId}.sqlite`)
}

function backupMetadataPath(): string {
  return `${backupPath()}.json`
}

function nearestExistingDirectory(requested: string): string {
  let current = path.resolve(requested)
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current)
    if (parent === current) throw new Error('repair_storage_parent_unavailable')
    current = parent
  }
  return current
}

function assertBackupCapacity(): { availableBytes: number; projectedPostBackupFreeBytes: number } {
  const databaseStat = fs.statSync(config.databaseRealpath, { bigint: true })
  const backupParent = nearestExistingDirectory(config.backupDirectory)
  const backupParentStat = fs.statSync(backupParent, { bigint: true })
  if (databaseStat.dev !== backupParentStat.dev) throw new Error('repair_backup_must_share_database_filesystem')
  const storage = fs.statfsSync(backupParent, { bigint: true })
  const availableBytes = Number(storage.bavail * storage.bsize)
  const projectedPostBackupFreeBytes = availableBytes - Number(databaseStat.size)
  if (!Number.isSafeInteger(availableBytes) || !Number.isSafeInteger(projectedPostBackupFreeBytes)
    || projectedPostBackupFreeBytes < config.minimumPostBackupFreeBytes) {
    throw new Error(`repair_backup_capacity_insufficient:${availableBytes}:${projectedPostBackupFreeBytes}`)
  }
  return { availableBytes, projectedPostBackupFreeBytes }
}

function requireBackupMetadata(options: {
  sha256TimeoutMs?: number
  timings?: BackupOperationTiming[]
} = {}): {
  backupRealpath: string
  backupSha256: string
  sourceGeneration: string
  servingGeneration: string
} {
  const metadata = readJson<{
    configSha256: string
    transactionId: string
    backupRealpath: string
    backupSha256: string
    sourceGeneration: string
    servingGeneration: string
  }>(backupMetadataPath())
  assertEvidenceConfiguration({
    recordedConfigurationSha256: metadata.configSha256,
    evidenceFile: backupMetadataPath(),
    evidenceKind: 'BACKUP_METADATA',
  })
  const actualBackupSha256 = options.sha256TimeoutMs && options.timings
    ? measure('rollback_backup_sha256', options.sha256TimeoutMs, options.timings, () => (
        sha256FileWithTimeout(
          metadata.backupRealpath,
          options.sha256TimeoutMs!,
          'repair_rollback_backup_sha256_timeout_or_failure',
        )
      ))
    : sha256File(metadata.backupRealpath)
  if (metadata.transactionId !== transactionId
    || fs.realpathSync(metadata.backupRealpath) !== metadata.backupRealpath
    || actualBackupSha256 !== metadata.backupSha256) {
    throw new Error('repair_backup_metadata_mismatch')
  }
  return metadata
}

async function main(): Promise<Record<string, unknown>> {
  if (operation === 'create-backup') {
    const timings: BackupOperationTiming[] = []
    activeBackupTimings = timings
    assertDatabaseIdentity()
    const capacity = assertBackupCapacity()
    const source = generationPointer(config.sourceGenerationPointer)
    const serving = generationPointer(config.servingGenerationPointer)
    if (source.generation !== config.sourceGenerationBefore
      || serving.generation !== config.servingGenerationBefore
      || serving.sourceGeneration !== config.sourceGenerationBefore) {
      throw new Error('repair_prebackup_generation_mismatch')
    }
    fs.mkdirSync(config.backupDirectory, { recursive: true, mode: 0o700 })
    const backup = backupPath()
    if (fs.existsSync(backup) || fs.existsSync(backupMetadataPath())) throw new Error('repair_backup_destination_exists')
    const backupCopyTimeoutMs = operationTimeout({
      label: 'backup_copy',
      stageTimeoutMs: backupTimeLimits.createBackupStageTimeoutMs,
      maxTimeoutMs: backupTimeLimits.backupCopyMaxTimeoutMs,
      minimumTimeoutMs: 5 * 60_000,
      reserveAfterMs: backupTimeLimits.journalModeMinimumMs
        + backupTimeLimits.quickCheckMinimumMs
        + backupTimeLimits.sha256MinimumMs
        + backupTimeLimits.metadataReserveMs,
    })
    measure('backup_copy', backupCopyTimeoutMs, timings, () => sqlite(
      `.backup ${sqliteQuoted(backup)}`,
      config.databaseRealpath,
      { timeoutMs: backupCopyTimeoutMs, errorCode: 'repair_backup_copy_timeout_or_failure' },
    ))
    const journalModeTimeoutMs = operationTimeout({
      label: 'journal_mode',
      stageTimeoutMs: backupTimeLimits.createBackupStageTimeoutMs,
      maxTimeoutMs: backupTimeLimits.journalModeMaxTimeoutMs,
      minimumTimeoutMs: backupTimeLimits.journalModeMinimumMs,
      reserveAfterMs: backupTimeLimits.quickCheckMinimumMs
        + backupTimeLimits.sha256MinimumMs
        + backupTimeLimits.metadataReserveMs,
    })
    measure('journal_mode_normalization', journalModeTimeoutMs, timings, () => (
      normalizeBackupArtifact(backup, journalModeTimeoutMs)
    ))
    const quickCheckTimeoutMs = operationTimeout({
      label: 'quick_check',
      stageTimeoutMs: backupTimeLimits.createBackupStageTimeoutMs,
      maxTimeoutMs: backupTimeLimits.quickCheckMaxTimeoutMs,
      minimumTimeoutMs: backupTimeLimits.quickCheckMinimumMs,
      reserveAfterMs: backupTimeLimits.sha256MinimumMs + backupTimeLimits.metadataReserveMs,
    })
    const quickCheck = measure('quick_check', quickCheckTimeoutMs, timings, () => sqliteReadOnly(
      'PRAGMA quick_check;',
      backup,
      { timeoutMs: quickCheckTimeoutMs, errorCode: 'repair_backup_quick_check_timeout_or_failure' },
    ))
    if (quickCheck !== 'ok') throw new Error('repair_backup_quick_check_failed')
    if (fs.existsSync(`${backup}-wal`) || fs.existsSync(`${backup}-shm`)) {
      throw new Error('repair_backup_sidecar_unexpected')
    }
    const backupRealpath = fs.realpathSync(backup)
    const sha256TimeoutMs = operationTimeout({
      label: 'sha256',
      stageTimeoutMs: backupTimeLimits.createBackupStageTimeoutMs,
      maxTimeoutMs: backupTimeLimits.sha256MaxTimeoutMs,
      minimumTimeoutMs: backupTimeLimits.sha256MinimumMs,
      reserveAfterMs: backupTimeLimits.metadataReserveMs,
    })
    const backupSha256 = measure('sha256', sha256TimeoutMs, timings, () => sha256FileWithTimeout(
      backupRealpath,
      sha256TimeoutMs,
      'repair_backup_sha256_timeout_or_failure',
    ))
    atomicJson(backupMetadataPath(), {
      version: 1,
      configSha256,
      transactionId,
      backupRealpath,
      backupSha256,
      sourceGeneration: source.generation,
      servingGeneration: serving.generation,
    })
    return {
      databaseRealpath: config.databaseRealpath,
      databaseIdentitySha256: config.databaseIdentitySha256,
      backupRealpath,
      backupSha256,
      quickCheck: 'PASS',
      ...capacity,
      sourceGeneration: source.generation,
      servingGeneration: serving.generation,
      timings,
    }
  }
  if (operation === 'hold-read-services') {
    const snapshot = await holdServices(config.readServices, config.serviceSnapshotPath)
    return {
      status: 'HELD',
      web: 'HELD',
      analog: 'HELD',
      services: snapshot.services.map((service) => service.label),
      snapshotSha256: stableSha256(snapshot),
    }
  }
  if (operation === 'publish-source-generation') {
    const pointer = publishGeneration(
      config.sourceGenerationPointer,
      config.sourceGenerationAfter,
      config.sourceGenerationAfter,
    )
    return { status: 'PASS', sourceGeneration: pointer.generation }
  }
  if (operation === 'verify-data-generation') {
    const pointer = generationPointer(config.sourceGenerationPointer, transactionId)
    if (pointer.generation !== config.sourceGenerationAfter) throw new Error('repair_source_generation_not_published')
    return { status: 'PASS', sourceGeneration: pointer.generation }
  }
  if (operation === 'run-derived') {
    const id = value('--command-id')
    const rollback = process.argv.includes('--rollback')
    const command = config.nestedCommands.find((candidate) => candidate.id === id && candidate.rollback === rollback)
    if (!command) throw new Error(`repair_nested_command_not_approved:${id}`)
    await runNested(command)
    if (command.publishesServingGeneration) {
      const sourceGeneration = rollback ? config.sourceGenerationBefore : config.sourceGenerationAfter
      const servingGeneration = rollback ? config.servingGenerationBefore : config.servingGenerationAfter
      publishGeneration(config.servingGenerationPointer, servingGeneration, sourceGeneration)
    }
    return { status: 'PASS', rebuilt: [id] }
  }
  if (operation === 'verify-serving' || operation === 'verify-original-serving') {
    const rollback = operation === 'verify-original-serving'
    const expectedSource = rollback ? config.sourceGenerationBefore : config.sourceGenerationAfter
    const expectedServing = rollback ? config.servingGenerationBefore : config.servingGenerationAfter
    const source = generationPointer(config.sourceGenerationPointer, transactionId)
    const serving = generationPointer(config.servingGenerationPointer, transactionId)
    if (source.generation !== expectedSource || serving.generation !== expectedServing
      || serving.sourceGeneration !== expectedSource) throw new Error('repair_serving_generation_mismatch')
    const expectedRows = rollback ? config.repairScope.existingRows : config.repairScope.officialRows
    const targetRows = Number(sqlite(`SELECT COUNT(*) FROM ohlcv_daily WHERE date='${config.targetDate}';`))
    if (targetRows !== expectedRows) {
      throw new Error(`repair_serving_target_coverage_mismatch:expected_${expectedRows}:actual_${targetRows}`)
    }
    for (const ticker of config.requiredTickers) {
      const count = Number(sqlite(`SELECT COUNT(*) FROM ohlcv_daily WHERE ticker='${ticker}' AND date='${config.targetDate}';`))
      if (rollback ? count > 1 : count !== 1) throw new Error(`repair_serving_required_ticker_mismatch:${ticker}:${count}`)
    }
    for (const row of config.preservedConflictRows) assertExactTargetRow(row)
    if (!rollback) for (const row of config.requiredTargetRows) assertExactTargetRow(row)
    return { sourceGeneration: source.generation, servingGeneration: serving.generation, health: 'PASS' }
  }
  if (operation === 'resume-read-services') {
    const snapshot = await restoreServices(config.serviceSnapshotPath, false)
    try {
      await health(config.healthUrls.web)
      await health(config.healthUrls.analog)
    } catch (error) {
      throw new Error(`repair_read_services_restored_but_health_failed:${error instanceof Error ? error.message : String(error)}`)
    }
    fs.renameSync(config.serviceSnapshotPath, `${config.serviceSnapshotPath}.restored-${transactionId}`)
    return {
      status: 'PASS',
      services: snapshot.services.map((service) => service.label),
      web: 'PASS',
      analog: 'PASS',
      health: 'PASS',
    }
  }
  if (operation === 'verify-backup') {
    const timings: BackupOperationTiming[] = []
    activeBackupTimings = timings
    const sha256TimeoutMs = operationTimeout({
      label: 'rollback_sha256',
      stageTimeoutMs: backupTimeLimits.verifyBackupStageTimeoutMs,
      maxTimeoutMs: backupTimeLimits.sha256MaxTimeoutMs,
      minimumTimeoutMs: backupTimeLimits.sha256MinimumMs,
      reserveAfterMs: backupTimeLimits.quickCheckMinimumMs + backupTimeLimits.metadataReserveMs,
    })
    const metadata = requireBackupMetadata({ sha256TimeoutMs, timings })
    const quickCheckTimeoutMs = operationTimeout({
      label: 'rollback_quick_check',
      stageTimeoutMs: backupTimeLimits.verifyBackupStageTimeoutMs,
      maxTimeoutMs: backupTimeLimits.quickCheckMaxTimeoutMs,
      minimumTimeoutMs: backupTimeLimits.quickCheckMinimumMs,
      reserveAfterMs: backupTimeLimits.metadataReserveMs,
    })
    const quickCheck = measure('rollback_quick_check', quickCheckTimeoutMs, timings, () => sqliteReadOnly(
      'PRAGMA quick_check;',
      metadata.backupRealpath,
      { timeoutMs: quickCheckTimeoutMs, errorCode: 'repair_rollback_backup_quick_check_timeout_or_failure' },
    ))
    if (quickCheck !== 'ok') {
      throw new Error('repair_rollback_backup_quick_check_failed')
    }
    if (fs.existsSync(`${metadata.backupRealpath}-wal`) || fs.existsSync(`${metadata.backupRealpath}-shm`)) {
      throw new Error('repair_rollback_backup_sidecar_unexpected')
    }
    return { ...metadata, quickCheck: 'PASS', timings }
  }
  if (operation === 'restore-backup') {
    const metadata = requireBackupMetadata()
    const restoreState = await restoreBackupWithJournal(metadata)
    return {
      databaseRealpath: config.databaseRealpath,
      databaseSha256: sha256File(config.databaseRealpath),
      sourceGeneration: config.sourceGenerationBefore,
      restoreStatePath: restoreStatePath(),
      restorePhase: restoreState.phase,
    }
  }
  throw new Error(`repair_stage_operation_unsupported:${operation}`)
}

let activeBackupTimings: BackupOperationTiming[] | null = null

main()
  .then((result) => console.log(JSON.stringify(result)))
  .catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error))
    if (activeBackupTimings) {
      console.error(JSON.stringify({
        status: 'FAILED',
        operation,
        error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
        timings: activeBackupTimings.map((timing) => ({
          operation: timing.operation,
          durationMs: timing.durationMs,
          timeoutMs: timing.timeoutMs,
        })),
      }))
    }
    process.exitCode = 1
  })
