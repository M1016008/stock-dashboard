import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { stableSha256 } from '@/lib/jp-ohlcv-data-quality'
import { JP_OHLCV_BACKUP_TIME_LIMITS } from '@/lib/jp-ohlcv-backup-time-budget'
import {
  WEEKLY_BACKUP_READER_LABELS,
  WEEKLY_BACKUP_WRITER_LABELS,
} from '@/lib/storage/weekly-backup-policy'

type ReadOnlySchemaDatabase = {
  prepare(sql: string): { all(): unknown[] }
  close(): void
}
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (file: string, options: { readOnly: boolean }) => ReadOnlySchemaDatabase
}

export type JpOhlcvLaunchdServiceIdentity = {
  label: string
  plistPath: string
  definitionSha256: string
  program: string
  role: 'WRITER' | 'READ_SERVICE'
}

export type JpOhlcvNestedCommand = {
  id: string
  executable: string
  executableSha256: string
  args: string[]
  workingDirectory: string
  sealedFiles: Array<{ path: string; sha256: string }>
  timeoutMs: number
  environment: Record<string, string>
  rollback: boolean
  publishesServingGeneration: boolean
}

export type JpOhlcvProductionExecutionConfiguration = {
  version: 1
  mode: 'PRODUCTION' | 'ISOLATED_FIXTURE'
  targetDate: string
  databaseRealpath: string
  databaseIdentitySha256: string
  databaseObjectIdentitySha256: string
  stateDirectory: string
  backupDirectory: string
  minimumPostBackupFreeBytes: number
  storageIdentity: {
    mountPath: string
    volumeUuid: string
    minFreeBytes: number
    minFreePercent: number
  }
  storageIdentitySha256: string
  sqliteExecutable: string
  sqliteExecutableSha256: string
  sourceGenerationBefore: string
  sourceGenerationAfter: string
  servingGenerationBefore: string
  servingGenerationAfter: string
  sourceGenerationPointer: string
  servingGenerationPointer: string
  triggerRepairEvidencePath: string
  serviceSnapshotPath: string
  writerServices: JpOhlcvLaunchdServiceIdentity[]
  readServices: JpOhlcvLaunchdServiceIdentity[]
  healthUrls: { web: string; analog: string }
  requiredTickers: string[]
  preservedConflictTickers: string[]
  requiredTargetRows: Array<{
    ticker: '1306' | '7003'
    open: number
    high: number
    low: number
    close: number
    volume: number
  }>
  preservedConflictRows: Array<{
    ticker: '1447' | '2164'
    open: number
    high: number
    low: number
    close: number
    volume: number
  }>
  repairScope: {
    officialRows: number
    existingRows: number
    matchingRows: number
    missingRows: number
    conflicts: number
    approvedRepairKeysSha256: string
  }
  existingEvidence: {
    kind: 'DIRECT_PRODUCTION_SNAPSHOT' | 'RECONSTRUCTED_FROM_BASELINE_AND_READ_ONLY_OBSERVATION'
    fileSha256: string
    rowsSha256: string
    provenanceSha256: string
  }
  runtimeSnapshotPolicy: {
    ttlMs: 900000
    sourceJobType: 'ohlcv_fetch:jquants'
    driftPolicy: 'ALLOW_APPROVED_KEYS_TO_BECOME_EXACT_MATCH_ONLY'
  }
  nestedCommands: JpOhlcvNestedCommand[]
  maximumMaintenanceMs: number
  integrationRoot: string
  integrationCommit: string
  integrationTreeId: string
  runtimeManifestPath: string
  runtimeManifestSha256: string
  runtimeIdentitySha256: string
  lineage: {
    source: 'JQUANTS_API_V2_DAILY_QUOTES'
    priceBasis: 'JQUANTS_ADJUSTED_OHLCV_V1'
    targetDate: string
    officialSha256: string
    planSha256: string
    missingRowsSha256: string
    approvedRepairKeysSha256: string
    preservedConflictsSha256: string
  }
}

export type JpOhlcvProductionExecutionPackage = {
  version: 1
  targetDate: string
  preparedAt: string
  configurationPath: string
  configurationSha256: string
  approvalBundlePath: string
  approvalBundleSha256: string
  executionPlanPath: string
  executionPlanSha256: string
  orchestratorScriptPath: string
  orchestratorScriptSha256: string
  runner: JpOhlcvNestedCommand
  productionMutationAuthorized: false
  requiredApproval: 'EXACT_PACKAGE_AND_REPAIR_APPROVAL_HASHES'
}

export type JpOhlcvServiceSnapshot = {
  version: 1
  configurationSha256: string
  transactionId: string
  capturedAt: string
  services: Array<JpOhlcvLaunchdServiceIdentity & {
    loaded: boolean
    disabled: boolean
    pid: number | null
    processGroupId: number | null
  }>
}

export type JpOhlcvDatabaseFileIdentity = {
  version: 1
  realpath: string
  device: string
  inode: string
  size: number
  mtimeNs: string
  wal: null | { size: number; mtimeNs: string }
  shm: null | { size: number; mtimeNs: string }
}

const SHA256 = /^[a-f0-9]{64}$/
const GENERATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const GIT_OBJECT = /^[a-f0-9]{40,64}$/

export function jpOhlcvStorageIdentitySha256(
  storageIdentity: JpOhlcvProductionExecutionConfiguration['storageIdentity'],
): string {
  return stableSha256(storageIdentity)
}

export function jpOhlcvStorageIdentityEnvironment(
  config: JpOhlcvProductionExecutionConfiguration,
): Record<string, string> {
  if (!config.storageIdentity) throw new Error('repair_execution_configuration_storage_identity_missing_regenerate_package')
  return {
    EXTERNAL_STORAGE_REQUIRED: config.mode === 'PRODUCTION' ? 'true' : 'false',
    STOCK_DATA_MOUNT_PATH: config.storageIdentity.mountPath,
    STOCK_DATA_VOLUME_UUID: config.storageIdentity.volumeUuid,
    STOCK_DATA_MIN_FREE_BYTES: String(config.storageIdentity.minFreeBytes),
    STOCK_DATA_MIN_FREE_PERCENT: String(config.storageIdentity.minFreePercent),
  }
}

export function assertJpOhlcvStorageIdentityEnvironment(
  config: JpOhlcvProductionExecutionConfiguration,
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
): void {
  const expected = jpOhlcvStorageIdentityEnvironment(config)
  for (const [key, value] of Object.entries(expected)) {
    if (environment[key] !== value) throw new Error(`repair_storage_identity_environment_mismatch:${key}`)
  }
}

export function sha256File(file: string): string {
  const hash = crypto.createHash('sha256')
  const descriptor = fs.openSync(file, 'r')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    for (;;) {
      const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null)
      if (bytes === 0) break
      hash.update(buffer.subarray(0, bytes))
    }
  } finally {
    fs.closeSync(descriptor)
  }
  return hash.digest('hex')
}

export function isHealthyJpOhlcvRepairResponseBody(body: string): boolean {
  let status: unknown = null
  try { status = (JSON.parse(body) as { status?: unknown }).status } catch { status = null }
  return ['ok', 'healthy'].includes(String(status).toLowerCase())
    || body.trim().toLowerCase() === 'healthy'
}

function statPart(file: string): null | { size: number; mtimeNs: string } {
  if (!fs.existsSync(file)) return null
  const stat = fs.statSync(file, { bigint: true })
  if (!stat.isFile()) throw new Error(`repair_database_sidecar_not_regular:${file}`)
  return { size: Number(stat.size), mtimeNs: stat.mtimeNs.toString() }
}

export function databaseFileIdentity(database: string): JpOhlcvDatabaseFileIdentity {
  const realpath = fs.realpathSync(database)
  const stat = fs.statSync(realpath, { bigint: true })
  if (!stat.isFile()) throw new Error('repair_database_not_regular')
  return {
    version: 1,
    realpath,
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    size: Number(stat.size),
    mtimeNs: stat.mtimeNs.toString(),
    wal: statPart(`${realpath}-wal`),
    shm: statPart(`${realpath}-shm`),
  }
}

export function databaseFileIdentitySha256(database: string): string {
  return stableSha256(databaseFileIdentity(database))
}

export function databaseFileObjectIdentitySha256(database: string): string {
  const realpath = fs.realpathSync(database)
  const stat = fs.statSync(realpath, { bigint: true })
  return stableSha256({
    version: 1,
    realpath,
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
  })
}

export function databaseSchemaIdentitySha256(database: string, _sqliteExecutable: string): string {
  const realpath = fs.realpathSync(database)
  const client = new DatabaseSync(realpath, { readOnly: true })
  let schema: unknown[]
  try {
    schema = client.prepare(`
      SELECT type, name, tbl_name AS tableName, COALESCE(sql, '') AS sql
      FROM sqlite_schema
      ORDER BY type, name, tbl_name, sql
    `).all()
  } finally {
    client.close()
  }
  return stableSha256({
    version: 1,
    realpath,
    objectIdentitySha256: databaseFileObjectIdentitySha256(realpath),
    schema,
  })
}

function assertAbsoluteRegular(file: string, expectedSha256: string, code: string): void {
  if (!path.isAbsolute(file) || !SHA256.test(expectedSha256)) throw new Error(`${code}_identity_invalid`)
  const realpath = fs.realpathSync(file)
  if (!fs.statSync(realpath).isFile() || sha256File(realpath) !== expectedSha256) {
    throw new Error(`${code}_identity_mismatch`)
  }
}

function assertServiceSet(services: JpOhlcvLaunchdServiceIdentity[], role: JpOhlcvLaunchdServiceIdentity['role']): void {
  if (services.length === 0) throw new Error(`repair_${role.toLowerCase()}_services_empty`)
  const labels = new Set<string>()
  for (const service of services) {
    if (service.role !== role || !service.label.startsWith('com.stockboard.') || labels.has(service.label)) {
      throw new Error('repair_service_identity_invalid')
    }
    labels.add(service.label)
    assertAbsoluteRegular(service.plistPath, service.definitionSha256, `repair_service_${service.label}`)
    if (!path.isAbsolute(service.program)) throw new Error(`repair_service_program_invalid:${service.label}`)
  }
}

function git(root: string, args: string[]): string {
  return execFileSync('/usr/bin/git', ['-C', root, ...args], {
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
  }).trim()
}

export function assertJpOhlcvExecutionSourceIdentity(
  config: JpOhlcvProductionExecutionConfiguration,
): void {
  if (!path.isAbsolute(config.integrationRoot)
    || fs.realpathSync(config.integrationRoot) !== config.integrationRoot
    || !GIT_OBJECT.test(config.integrationCommit)
    || !GIT_OBJECT.test(config.integrationTreeId)) {
    throw new Error('repair_execution_source_identity_invalid')
  }
  if (git(config.integrationRoot, ['rev-parse', 'HEAD']) !== config.integrationCommit
    || git(config.integrationRoot, ['rev-parse', 'HEAD^{tree}']) !== config.integrationTreeId) {
    throw new Error('repair_execution_source_revision_mismatch')
  }
  if (git(config.integrationRoot, ['status', '--porcelain', '--untracked-files=all'])) {
    throw new Error('repair_execution_source_changes_present')
  }
  assertAbsoluteRegular(
    config.runtimeManifestPath,
    config.runtimeManifestSha256,
    'repair_runtime_manifest',
  )
  const manifest = JSON.parse(fs.readFileSync(config.runtimeManifestPath, 'utf8')) as {
    runtimeRealpath?: unknown
    hashes?: { runtimeIdentitySha256?: unknown }
    install?: { includesDevDependencies?: unknown; nodeModulesPhysicalDirectory?: unknown }
  }
  if (manifest.hashes?.runtimeIdentitySha256 !== config.runtimeIdentitySha256
    || !SHA256.test(config.runtimeIdentitySha256)
    || typeof manifest.runtimeRealpath !== 'string'
    || fs.realpathSync(manifest.runtimeRealpath) !== manifest.runtimeRealpath
    || !fs.statSync(path.join(manifest.runtimeRealpath, 'node_modules')).isDirectory()
    || manifest.install?.includesDevDependencies !== true
    || manifest.install?.nodeModulesPhysicalDirectory !== true) {
    throw new Error('repair_runtime_identity_mismatch')
  }
  const integrationNodeModules = fs.realpathSync(path.join(config.integrationRoot, 'node_modules'))
  if (integrationNodeModules !== fs.realpathSync(path.join(manifest.runtimeRealpath, 'node_modules'))) {
    throw new Error('repair_runtime_node_modules_mismatch')
  }
}

export function assertJpOhlcvProductionExecutionConfiguration(
  config: JpOhlcvProductionExecutionConfiguration,
  options: { allowMissingDatabaseForRestore?: boolean } = {},
): void {
  if (config.version !== 1 || !DATE.test(config.targetDate)) throw new Error('repair_execution_configuration_invalid')
  assertJpOhlcvExecutionSourceIdentity(config)
  const databaseExists = fs.existsSync(config.databaseRealpath)
  if (!path.isAbsolute(config.databaseRealpath)
    || (!databaseExists && !options.allowMissingDatabaseForRestore)
    || (databaseExists && fs.realpathSync(config.databaseRealpath) !== config.databaseRealpath)
    || !SHA256.test(config.databaseIdentitySha256)
    || !SHA256.test(config.databaseObjectIdentitySha256)) {
    throw new Error('repair_execution_configuration_database_invalid')
  }
  for (const directory of [config.stateDirectory, config.backupDirectory]) {
    if (!path.isAbsolute(directory)) throw new Error('repair_execution_configuration_directory_invalid')
  }
  if (!Number.isSafeInteger(config.minimumPostBackupFreeBytes)
    || config.minimumPostBackupFreeBytes < (config.mode === 'PRODUCTION' ? 150_000_000_000 : 1_000_000)) {
    throw new Error('repair_execution_configuration_storage_reserve_invalid')
  }
  const storageMount = path.resolve(config.storageIdentity?.mountPath ?? '')
  const storageRelative = path.relative(storageMount, config.databaseRealpath)
  if (!config.storageIdentity
    || !path.isAbsolute(config.storageIdentity.mountPath)
    || !fs.existsSync(config.storageIdentity.mountPath)
    || fs.realpathSync(config.storageIdentity.mountPath) !== config.storageIdentity.mountPath
    || !/^[A-Za-z0-9][A-Za-z0-9-]{7,127}$/.test(config.storageIdentity.volumeUuid)
    || !Number.isSafeInteger(config.storageIdentity.minFreeBytes)
    || config.storageIdentity.minFreeBytes < (config.mode === 'PRODUCTION' ? 50 * 1024 ** 3 : 0)
    || !Number.isFinite(config.storageIdentity.minFreePercent)
    || config.storageIdentity.minFreePercent < (config.mode === 'PRODUCTION' ? 5 : 0)
    || config.storageIdentity.minFreePercent > 100
    || !storageRelative
    || storageRelative === '..'
    || storageRelative.startsWith(`..${path.sep}`)
    || path.isAbsolute(storageRelative)
    || config.storageIdentitySha256 !== jpOhlcvStorageIdentitySha256(config.storageIdentity)
    || !SHA256.test(config.storageIdentitySha256)) {
    throw new Error('repair_execution_configuration_storage_identity_invalid')
  }
  for (const file of [
    config.sourceGenerationPointer,
    config.servingGenerationPointer,
    config.triggerRepairEvidencePath,
    config.serviceSnapshotPath,
  ]) {
    if (!path.isAbsolute(file)) throw new Error('repair_execution_configuration_state_path_invalid')
  }
  assertAbsoluteRegular(config.sqliteExecutable, config.sqliteExecutableSha256, 'repair_sqlite')
  for (const generation of [
    config.sourceGenerationBefore,
    config.sourceGenerationAfter,
    config.servingGenerationBefore,
    config.servingGenerationAfter,
  ]) {
    if (!GENERATION.test(generation)) throw new Error('repair_execution_configuration_generation_invalid')
  }
  if (config.sourceGenerationBefore === config.sourceGenerationAfter
    || config.servingGenerationBefore === config.servingGenerationAfter) {
    throw new Error('repair_execution_configuration_generation_not_advanced')
  }
  if (config.lineage.source !== 'JQUANTS_API_V2_DAILY_QUOTES'
    || config.lineage.priceBasis !== 'JQUANTS_ADJUSTED_OHLCV_V1'
    || config.lineage.targetDate !== config.targetDate
    || !SHA256.test(config.lineage.officialSha256)
    || !SHA256.test(config.lineage.planSha256)
    || !SHA256.test(config.lineage.missingRowsSha256)
    || !SHA256.test(config.lineage.approvedRepairKeysSha256)
    || !SHA256.test(config.lineage.preservedConflictsSha256)) {
    throw new Error('repair_execution_configuration_lineage_invalid')
  }
  assertServiceSet(config.writerServices, 'WRITER')
  assertServiceSet(config.readServices, 'READ_SERVICE')
  if (config.mode === 'PRODUCTION') {
    const writerLabels = config.writerServices.map((service) => service.label).sort()
    const readerLabels = config.readServices.map((service) => service.label).sort()
    if (JSON.stringify(writerLabels) !== JSON.stringify([...WEEKLY_BACKUP_WRITER_LABELS].sort())) {
      throw new Error('repair_execution_configuration_writer_set_invalid')
    }
    if (JSON.stringify(readerLabels) !== JSON.stringify([...WEEKLY_BACKUP_READER_LABELS].sort())) {
      throw new Error('repair_execution_configuration_reader_set_invalid')
    }
  }
  const allLabels = [...config.writerServices, ...config.readServices].map((service) => service.label)
  if (new Set(allLabels).size !== allLabels.length) throw new Error('repair_execution_configuration_duplicate_service')
  if (!config.requiredTickers.includes('1306') || !config.requiredTickers.includes('7003')) {
    throw new Error('repair_execution_configuration_required_tickers_missing')
  }
  if (config.preservedConflictTickers.join(',') !== '1447,2164') {
    throw new Error('repair_execution_configuration_conflicts_invalid')
  }
  const assertExpectedRows = (
    rows: JpOhlcvProductionExecutionConfiguration['requiredTargetRows']
      | JpOhlcvProductionExecutionConfiguration['preservedConflictRows'],
    tickers: string,
  ) => {
    if (rows.map((row) => row.ticker).sort().join(',') !== tickers) {
      throw new Error('repair_execution_configuration_expected_rows_invalid')
    }
    for (const row of rows) {
      if (![row.open, row.high, row.low, row.close, row.volume].every(Number.isFinite)
        || row.open <= 0 || row.high <= 0 || row.low <= 0 || row.close <= 0
        || !Number.isSafeInteger(row.volume) || row.volume < 0
        || row.high < Math.max(row.open, row.low, row.close)
        || row.low > Math.min(row.open, row.high, row.close)) {
        throw new Error(`repair_execution_configuration_expected_row_value_invalid:${row.ticker}`)
      }
    }
  }
  assertExpectedRows(config.requiredTargetRows, '1306,7003')
  assertExpectedRows(config.preservedConflictRows, '1447,2164')
  if (![config.repairScope.officialRows, config.repairScope.existingRows, config.repairScope.matchingRows,
    config.repairScope.missingRows, config.repairScope.conflicts].every(Number.isSafeInteger)
    || config.repairScope.officialRows <= 0
    || config.repairScope.existingRows < 0
    || config.repairScope.matchingRows < 0
    || config.repairScope.missingRows <= 0
    || config.repairScope.conflicts !== config.preservedConflictTickers.length
    || config.repairScope.matchingRows + config.repairScope.missingRows + config.repairScope.conflicts
      !== config.repairScope.officialRows
    || config.repairScope.matchingRows + config.repairScope.conflicts !== config.repairScope.existingRows
    || !SHA256.test(config.repairScope.approvedRepairKeysSha256)
    || config.repairScope.approvedRepairKeysSha256 !== config.lineage.approvedRepairKeysSha256) {
    throw new Error('repair_execution_configuration_scope_counts_invalid')
  }
  if (config.runtimeSnapshotPolicy?.ttlMs !== 900000
    || config.runtimeSnapshotPolicy.sourceJobType !== 'ohlcv_fetch:jquants'
    || config.runtimeSnapshotPolicy.driftPolicy !== 'ALLOW_APPROVED_KEYS_TO_BECOME_EXACT_MATCH_ONLY') {
    throw new Error('repair_execution_configuration_runtime_snapshot_policy_invalid')
  }
  if (!['DIRECT_PRODUCTION_SNAPSHOT', 'RECONSTRUCTED_FROM_BASELINE_AND_READ_ONLY_OBSERVATION']
      .includes(config.existingEvidence?.kind)
    || !SHA256.test(config.existingEvidence.fileSha256)
    || !SHA256.test(config.existingEvidence.rowsSha256)
    || !SHA256.test(config.existingEvidence.provenanceSha256)) {
    throw new Error('repair_execution_configuration_existing_evidence_invalid')
  }
  if (!Number.isSafeInteger(config.maximumMaintenanceMs)
    || config.maximumMaintenanceMs < 60_000
    || config.maximumMaintenanceMs > 12 * 60 * 60_000) {
    throw new Error('repair_execution_configuration_maintenance_limit_invalid')
  }
  if (!/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\//.test(config.healthUrls.web)
    || !/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\//.test(config.healthUrls.analog)) {
    throw new Error('repair_execution_configuration_health_url_invalid')
  }
  if (config.nestedCommands.length === 0) throw new Error('repair_execution_configuration_nested_commands_empty')
  const commandIds = new Set<string>()
  for (const command of config.nestedCommands) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(command.id) || commandIds.has(command.id)) {
      throw new Error('repair_nested_command_id_invalid')
    }
    commandIds.add(command.id)
    assertAbsoluteRegular(command.executable, command.executableSha256, `repair_nested_command_${command.id}`)
    if (!path.isAbsolute(command.workingDirectory)
      || !fs.statSync(fs.realpathSync(command.workingDirectory)).isDirectory()
      || !Number.isSafeInteger(command.timeoutMs)
      || command.timeoutMs < 1_000
      || command.timeoutMs > 12 * 60 * 60_000) {
      throw new Error(`repair_nested_command_contract_invalid:${command.id}`)
    }
    for (const sealed of command.sealedFiles) {
      assertAbsoluteRegular(sealed.path, sealed.sha256, `repair_nested_command_${command.id}_sealed`)
    }
    if (Object.keys(command.environment).some((key) => /TOKEN|SECRET|PASSWORD|AUTH|COOKIE/i.test(key))) {
      throw new Error(`repair_nested_command_secret_environment_forbidden:${command.id}`)
    }
    if (Object.keys(command.environment).some((key) => [
      'EXTERNAL_STORAGE_REQUIRED',
      'STOCK_DATA_MOUNT_PATH',
      'STOCK_DATA_VOLUME_UUID',
      'STOCK_DATA_MIN_FREE_BYTES',
      'STOCK_DATA_MIN_FREE_PERCENT',
    ].includes(key))) {
      throw new Error(`repair_nested_command_storage_environment_forbidden:${command.id}`)
    }
  }
  if (!config.nestedCommands.some((command) => command.publishesServingGeneration && !command.rollback)
    || !config.nestedCommands.some((command) => command.publishesServingGeneration && command.rollback)) {
    throw new Error('repair_execution_configuration_serving_publication_missing')
  }
}

export function executionConfigurationSha256(
  config: JpOhlcvProductionExecutionConfiguration,
  options: { allowMissingDatabaseForRestore?: boolean } = {},
): string {
  assertJpOhlcvProductionExecutionConfiguration(config, options)
  return stableSha256(config)
}

export function assertJpOhlcvProductionExecutionPackage(
  bundle: JpOhlcvProductionExecutionPackage,
): void {
  if (bundle.version !== 1 || !DATE.test(bundle.targetDate)
    || !Number.isFinite(Date.parse(bundle.preparedAt))
    || bundle.productionMutationAuthorized !== false
    || bundle.requiredApproval !== 'EXACT_PACKAGE_AND_REPAIR_APPROVAL_HASHES') {
    throw new Error('repair_execution_package_invalid')
  }
  for (const [file, expected, code] of [
    [bundle.configurationPath, bundle.configurationSha256, 'configuration'],
    [bundle.approvalBundlePath, bundle.approvalBundleSha256, 'approval'],
    [bundle.executionPlanPath, bundle.executionPlanSha256, 'plan'],
    [bundle.orchestratorScriptPath, bundle.orchestratorScriptSha256, 'orchestrator'],
  ] as const) {
    assertAbsoluteRegular(file, expected, `repair_execution_package_${code}`)
  }
  assertAbsoluteRegular(bundle.runner.executable, bundle.runner.executableSha256, 'repair_execution_package_runner')
  if (bundle.runner.id !== 'production-repair-runner'
    || bundle.runner.rollback
    || bundle.runner.publishesServingGeneration
    || bundle.runner.timeoutMs !== JP_OHLCV_BACKUP_TIME_LIMITS.forwardOperationTimeoutMs
    || !path.isAbsolute(bundle.runner.workingDirectory)) {
    throw new Error('repair_execution_package_runner_contract_invalid')
  }
  for (const sealed of bundle.runner.sealedFiles) {
    assertAbsoluteRegular(sealed.path, sealed.sha256, 'repair_execution_package_runner_sealed')
  }
  const config = JSON.parse(fs.readFileSync(bundle.configurationPath, 'utf8')) as JpOhlcvProductionExecutionConfiguration
  if (!config.storageIdentity || !config.storageIdentitySha256) {
    throw new Error('repair_execution_package_stale_storage_identity_regenerate_required')
  }
  assertJpOhlcvStorageIdentityEnvironment(config, bundle.runner.environment)
  if (bundle.runner.environment.STOCKBOARD_JP_OHLCV_EXECUTION_CONFIGURATION_SHA256
    !== bundle.configurationSha256) {
    throw new Error('repair_execution_package_runner_configuration_hash_contract_invalid')
  }
  const configurationFlag = bundle.runner.args.indexOf('--execution-configuration')
  if (configurationFlag < 0 || bundle.runner.args[configurationFlag + 1] !== bundle.configurationPath) {
    throw new Error('repair_execution_package_runner_configuration_contract_invalid')
  }
}

export function executionPackageSha256(bundle: JpOhlcvProductionExecutionPackage): string {
  assertJpOhlcvProductionExecutionPackage(bundle)
  return stableSha256(bundle)
}
