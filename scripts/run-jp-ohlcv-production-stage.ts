import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import {
  assertJpOhlcvProductionExecutionConfiguration,
  databaseFileObjectIdentitySha256,
  databaseSchemaIdentitySha256,
  executionConfigurationSha256,
  isHealthyJpOhlcvRepairResponseBody,
  sha256File,
  type JpOhlcvLaunchdServiceIdentity,
  type JpOhlcvNestedCommand,
  type JpOhlcvProductionExecutionConfiguration,
  type JpOhlcvServiceSnapshot,
} from '@/lib/jp-ohlcv-executable-plan'
import { stableSha256 } from '@/lib/jp-ohlcv-data-quality'
import {
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

const operation = value('--operation')
const configFile = absolute('--config')
const config = readJson<JpOhlcvProductionExecutionConfiguration>(configFile)
assertJpOhlcvProductionExecutionConfiguration(config)
const configSha256 = executionConfigurationSha256(config)
const transactionId = process.env.STOCKBOARD_JP_OHLCV_REPAIR_TRANSACTION_ID
if (!transactionId || process.env.STOCKBOARD_JP_OHLCV_REPAIR_OWNER !== '1') {
  throw new Error('repair_stage_owner_environment_required')
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

function sqlite(sql: string, database = config.databaseRealpath): string {
  const result = spawnSync(config.sqliteExecutable, [database, sql], {
    encoding: 'utf8',
    timeout: 30 * 60_000,
    env: { NODE_ENV: 'production', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
  })
  if (result.status !== 0 || result.signal || result.error) {
    throw new Error(`repair_stage_sqlite_failed:${result.error?.message ?? result.stderr.trim() ?? result.status}`)
  }
  return result.stdout.trim()
}

function sqliteReadOnly(sql: string, database: string): string {
  const result = spawnSync(config.sqliteExecutable, [`${pathToFileURL(database).href}?mode=ro`, sql], {
    encoding: 'utf8',
    timeout: 30 * 60_000,
    env: { NODE_ENV: 'production', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
  })
  if (result.status !== 0 || result.signal || result.error) {
    throw new Error(`repair_stage_sqlite_readonly_failed:${result.error?.message ?? result.stderr.trim() ?? result.status}`)
  }
  return result.stdout.trim()
}

function normalizeBackupArtifact(backup: string): void {
  if (sqlite('PRAGMA journal_mode=DELETE;', backup).trim().toLowerCase() !== 'delete') {
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

function generationPointer(file: string): GenerationPointer {
  const pointer = readJson<GenerationPointer>(file)
  const expectedStatus = pointer.sourceGeneration === config.sourceGenerationAfter ? 'REPAIRED' : 'BASELINE'
  const { repairStatus, ...pointerLineage } = pointer.lineage ?? {} as GenerationPointer['lineage']
  if (pointer.version !== 1 || !pointer.generation || !pointer.sourceGeneration
    || repairStatus !== expectedStatus
    || stableSha256(pointerLineage) !== stableSha256(config.lineage)) {
    throw new Error('repair_stage_generation_pointer_invalid')
  }
  return pointer
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

function assertSnapshot(snapshot: JpOhlcvServiceSnapshot, expectedRole?: JpOhlcvLaunchdServiceIdentity['role']): void {
  if (snapshot.version !== 1 || snapshot.configurationSha256 !== configSha256
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
    assertSnapshot(snapshot, services[0]?.role)
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
  assertSnapshot(snapshot, 'READ_SERVICE')
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

function requireBackupMetadata(): {
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
  if (metadata.configSha256 !== configSha256 || metadata.transactionId !== transactionId
    || fs.realpathSync(metadata.backupRealpath) !== metadata.backupRealpath
    || sha256File(metadata.backupRealpath) !== metadata.backupSha256) {
    throw new Error('repair_backup_metadata_mismatch')
  }
  return metadata
}

async function main(): Promise<Record<string, unknown>> {
  if (operation === 'create-backup') {
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
    sqlite(`.backup ${sqliteQuoted(backup)}`)
    normalizeBackupArtifact(backup)
    if (sqliteReadOnly('PRAGMA quick_check;', backup) !== 'ok') throw new Error('repair_backup_quick_check_failed')
    if (fs.existsSync(`${backup}-wal`) || fs.existsSync(`${backup}-shm`)) {
      throw new Error('repair_backup_sidecar_unexpected')
    }
    const backupRealpath = fs.realpathSync(backup)
    const backupSha256 = sha256File(backupRealpath)
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
    const pointer = generationPointer(config.sourceGenerationPointer)
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
    const source = generationPointer(config.sourceGenerationPointer)
    const serving = generationPointer(config.servingGenerationPointer)
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
    const metadata = requireBackupMetadata()
    if (sqliteReadOnly('PRAGMA quick_check;', metadata.backupRealpath) !== 'ok') {
      throw new Error('repair_rollback_backup_quick_check_failed')
    }
    if (fs.existsSync(`${metadata.backupRealpath}-wal`) || fs.existsSync(`${metadata.backupRealpath}-shm`)) {
      throw new Error('repair_rollback_backup_sidecar_unexpected')
    }
    return { ...metadata, quickCheck: 'PASS' }
  }
  if (operation === 'restore-backup') {
    const metadata = requireBackupMetadata()
    const temporary = `${config.databaseRealpath}.restore-${transactionId}`
    const failed = `${config.databaseRealpath}.failed-${transactionId}`
    if (fs.existsSync(temporary) || fs.existsSync(failed)) throw new Error('repair_restore_destination_exists')
    fs.copyFileSync(metadata.backupRealpath, temporary, fs.constants.COPYFILE_EXCL)
    if (sha256File(temporary) !== metadata.backupSha256) throw new Error('repair_restore_copy_hash_mismatch')
    fs.renameSync(config.databaseRealpath, failed)
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = `${config.databaseRealpath}${suffix}`
      if (fs.existsSync(sidecar)) fs.renameSync(sidecar, `${failed}${suffix}`)
    }
    fs.renameSync(temporary, config.databaseRealpath)
    syncDirectory(path.dirname(config.databaseRealpath))
    publishGeneration(config.sourceGenerationPointer, config.sourceGenerationBefore, config.sourceGenerationBefore)
    return {
      databaseRealpath: config.databaseRealpath,
      databaseSha256: sha256File(config.databaseRealpath),
      sourceGeneration: config.sourceGenerationBefore,
    }
  }
  throw new Error(`repair_stage_operation_unsupported:${operation}`)
}

main()
  .then((result) => console.log(JSON.stringify(result)))
  .catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error))
    process.exitCode = 1
  })
