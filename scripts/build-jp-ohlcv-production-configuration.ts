import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  assertJpOhlcvProductionExecutionConfiguration,
  databaseFileIdentity,
  databaseFileObjectIdentitySha256,
  databaseSchemaIdentitySha256,
  executionConfigurationSha256,
  jpOhlcvStorageIdentitySha256,
  sha256File,
  type JpOhlcvLaunchdServiceIdentity,
  type JpOhlcvNestedCommand,
  type JpOhlcvProductionExecutionConfiguration,
} from '@/lib/jp-ohlcv-executable-plan'
import { inspectWritableTargetPath } from '@/lib/storage/external-storage-guard'
import {
  buildJpOhlcvBackfillPlan,
  buildJpOhlcvMissingOnlyRepairScope,
  stableSha256,
  type JpOhlcvBackfillPlan,
  type JpOfficialOhlcvValue,
  type JpOhlcvValue,
} from '@/lib/jp-ohlcv-data-quality'
import {
  WEEKLY_BACKUP_READER_LABELS,
  WEEKLY_BACKUP_WRITER_LABELS,
} from '@/lib/storage/weekly-backup-policy'

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
  const result = path.resolve(value(flag))
  if (!path.isAbsolute(result)) throw new Error(`${flag}_absolute_path_required`)
  return result
}

function readJson<T>(file: string): T {
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error('repair_configuration_input_symlink_forbidden')
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T
}

function writeNew(file: string, payload: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
}

function git(root: string, args: string[]): string {
  return execFileSync('/usr/bin/git', ['-C', root, ...args], {
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
  }).trim()
}

function plistValue(file: string, key: string): string {
  return execFileSync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', file], {
    encoding: 'utf8',
    timeout: 5_000,
  }).trim()
}

function serviceIdentity(label: string, role: JpOhlcvLaunchdServiceIdentity['role']): JpOhlcvLaunchdServiceIdentity {
  const plistPath = path.join(process.env.HOME!, 'Library', 'LaunchAgents', `${label}.plist`)
  if (!fs.statSync(plistPath).isFile() || plistValue(plistPath, 'Label') !== label) {
    throw new Error(`repair_configuration_service_plist_invalid:${label}`)
  }
  let program: string
  try { program = plistValue(plistPath, 'Program') } catch { program = plistValue(plistPath, 'ProgramArguments.0') }
  if (!path.isAbsolute(program)) throw new Error(`repair_configuration_service_program_invalid:${label}`)
  return { label, plistPath, definitionSha256: sha256File(plistPath), program, role }
}

function command(input: {
  id: string
  script: string
  args?: string[]
  environment?: Record<string, string>
  timeoutMs: number
  rollback?: boolean
  publishesServingGeneration?: boolean
}): JpOhlcvNestedCommand {
  const script = fs.realpathSync(path.resolve(input.script))
  return {
    id: input.id,
    executable: nodeExecutable,
    executableSha256: sha256File(nodeExecutable),
    args: [tsxCli, script, ...(input.args ?? [])],
    workingDirectory: integrationRoot,
    sealedFiles: [
      { path: tsxCli, sha256: sha256File(tsxCli) },
      { path: script, sha256: sha256File(script) },
    ],
    timeoutMs: input.timeoutMs,
    environment: input.environment ?? {},
    rollback: input.rollback ?? false,
    publishesServingGeneration: input.publishesServingGeneration ?? false,
  }
}

const officialRowsFile = absolute('--official-rows')
const existingRowsFile = absolute('--existing-rows')
const dryRunFile = absolute('--dry-run-manifest')
const databaseRealpath = fs.realpathSync(absolute('--database'))
const runtimeManifestPath = fs.realpathSync(absolute('--runtime-manifest'))
const stateDirectory = absolute('--state-directory')
const backupDirectory = absolute('--backup-directory')
const output = absolute('--output')
const evidenceDirectory = absolute('--evidence-directory')
const storageMountInput = absolute('--stock-data-mount-path')
if (!fs.existsSync(storageMountInput) || !fs.statSync(storageMountInput).isDirectory()) {
  throw new Error('repair_configuration_storage_mount_directory_required')
}
const storageMountPath = fs.realpathSync(storageMountInput)
const storageVolumeUuid = value('--stock-data-volume-uuid').trim()
if (!/^[A-Za-z0-9][A-Za-z0-9-]{7,127}$/.test(storageVolumeUuid)) {
  throw new Error('repair_configuration_storage_volume_uuid_invalid')
}
const webHealthUrl = optional('--web-health-url') ?? 'http://127.0.0.1:3000/api/health'
const analogHealthUrl = optional('--analog-health-url') ?? 'http://127.0.0.1:3001/api/health'
const integrationRoot = fs.realpathSync(process.cwd())
const nodeExecutable = fs.realpathSync(process.execPath)
const tsxCli = fs.realpathSync(path.join(integrationRoot, 'node_modules', '.bin', 'tsx'))
const sqliteExecutable = fs.realpathSync('/usr/bin/sqlite3')
if (fs.existsSync(output)) throw new Error('repair_configuration_output_exists')
if (git(integrationRoot, ['status', '--porcelain', '--untracked-files=all'])) {
  throw new Error('repair_configuration_worktree_not_clean')
}
const storageIdentity = {
  mountPath: storageMountPath,
  volumeUuid: storageVolumeUuid,
  minFreeBytes: 50 * 1024 ** 3,
  minFreePercent: 5,
}
inspectWritableTargetPath({
  dbPath: databaseRealpath,
  ...storageIdentity,
  jobType: 'jp_ohlcv_gap_repair',
})

const officialInput = readJson<JpOfficialOhlcvValue[] | { rows: JpOfficialOhlcvValue[]; officialSha256?: string }>(officialRowsFile)
const officialRows = Array.isArray(officialInput) ? officialInput : officialInput.rows
const existingInput = readJson<JpOhlcvValue[] | { rows: JpOhlcvValue[] }>(existingRowsFile)
const existingRows = Array.isArray(existingInput) ? existingInput : existingInput.rows
const dryRun = readJson<{ plan?: JpOhlcvBackfillPlan }>(dryRunFile)
if (!dryRun.plan) throw new Error('repair_configuration_dry_run_plan_missing')
const rebuilt = buildJpOhlcvBackfillPlan({ date: '2026-07-17', officialRows, existingRows })
if (stableSha256(rebuilt) !== stableSha256(dryRun.plan)) throw new Error('repair_configuration_evidence_mismatch')
const scope = buildJpOhlcvMissingOnlyRepairScope({ plan: rebuilt, approvedConflictTickers: ['1447', '2164'] })
if (scope.status !== 'READY' || officialRows.length !== 4_218 || existingRows.length !== 151
  || scope.missingRows.length !== 4_067 || rebuilt.matchingRows !== 149) {
  throw new Error(`repair_configuration_scope_invalid:${scope.reasons.join(',')}`)
}
if (!Array.isArray(officialInput) && officialInput.officialSha256
  && officialInput.officialSha256 !== scope.officialSha256) {
  throw new Error('repair_configuration_official_wrapper_hash_mismatch')
}

const runtimeManifest = readJson<{
  runtimeRealpath: string
  hashes: { runtimeIdentitySha256: string }
  install: { includesDevDependencies: boolean; nodeModulesPhysicalDirectory: boolean }
}>(runtimeManifestPath)
const databaseIdentitySha256 = databaseSchemaIdentitySha256(databaseRealpath, sqliteExecutable)
const databaseObjectIdentitySha256 = databaseFileObjectIdentitySha256(databaseRealpath)
const existingRowsSha256 = stableSha256(existingRows)
const sourceGenerationBefore = `jp-source-pre-${stableSha256({ databaseIdentitySha256, existingRowsSha256 }).slice(0, 20)}`
const sourceGenerationAfter = `jp-source-repair-${scope.missingRowsSha256.slice(0, 20)}`
const servingGenerationBefore = `jp-serving-pre-${stableSha256({ databaseIdentitySha256, existingRowsSha256 }).slice(0, 20)}`
const servingGenerationAfter = `jp-serving-repair-${scope.planSha256.slice(0, 20)}`
const lineage: JpOhlcvProductionExecutionConfiguration['lineage'] = {
  source: 'JQUANTS_API_V2_DAILY_QUOTES',
  priceBasis: 'JQUANTS_ADJUSTED_OHLCV_V1',
  targetDate: '2026-07-17',
  officialSha256: scope.officialSha256,
  planSha256: scope.planSha256,
  missingRowsSha256: scope.missingRowsSha256,
  preservedConflictsSha256: scope.preservedConflictsSha256,
}
const pointerLineage = { ...lineage, repairStatus: 'BASELINE' as const }
const sourceGenerationPointer = path.join(evidenceDirectory, 'source-generation.json')
const servingGenerationPointer = path.join(evidenceDirectory, 'serving-generation.json')
const triggerRepairEvidencePath = path.join(evidenceDirectory, 'trigger-repair-evidence.json')
writeNew(sourceGenerationPointer, {
  version: 1, generation: sourceGenerationBefore, sourceGeneration: sourceGenerationBefore,
  transactionId: 'pre-repair-baseline', publishedAt: new Date().toISOString(), lineage: pointerLineage,
})
writeNew(servingGenerationPointer, {
  version: 1, generation: servingGenerationBefore, sourceGeneration: sourceGenerationBefore,
  transactionId: 'pre-repair-baseline', publishedAt: new Date().toISOString(), lineage: pointerLineage,
})

const missingTickers = scope.missingRows.map((row) => row.ticker).sort()
const requiredTargetRows = ['1306', '7003'].map((ticker) => {
  const row = officialRows.find((candidate) => candidate.ticker === ticker)!
  return { ticker, open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume }
}) as JpOhlcvProductionExecutionConfiguration['requiredTargetRows']
const preservedConflictRows = ['1447', '2164'].map((ticker) => {
  const row = existingRows.find((candidate) => candidate.ticker === ticker)!
  return { ticker, open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume }
}) as JpOhlcvProductionExecutionConfiguration['preservedConflictRows']

const nestedCommands: JpOhlcvNestedCommand[] = [
  command({
    id: 'rebuild-daily-snapshots', script: 'scripts/batch-snapshots.ts', timeoutMs: 4 * 60 * 60_000,
    environment: {
      TICKERS: missingTickers.join(','), SNAPSHOT_FORCE_REBUILD: '1',
      SNAPSHOT_REBUILD_FROM_DATE: '2026-07-17', SNAPSHOT_CONCURRENCY: '2',
      SNAPSHOT_PROGRESS_EVERY: '100',
    },
  }),
  command({ id: 'rebuild-stage-transitions', script: 'scripts/batch-stage-transitions.ts', timeoutMs: 2 * 60 * 60_000 }),
  command({
    id: 'rebuild-integrated-screener', script: 'scripts/backfill-integrated-screener.ts',
    args: ['--force'], timeoutMs: 2 * 60 * 60_000,
  }),
  command({
    id: 'reevaluate-current-triggers', script: 'scripts/run-trigger-daily-evaluations.ts',
    args: [
      '--repair-source-generation', sourceGenerationAfter,
      '--evidence-output', triggerRepairEvidencePath,
    ],
    timeoutMs: 2 * 60 * 60_000,
  }),
  command({
    id: 'rebuild-dashboard-cache', script: 'scripts/build-dashboard-cache.ts',
    timeoutMs: 2 * 60 * 60_000,
  }),
  command({
    id: 'verify-rebuilt-derived-state', script: 'scripts/verify-jp-ohlcv-repair-derived-state.ts',
    args: ['--config', output, '--mode', 'forward'], timeoutMs: 10 * 60_000,
    publishesServingGeneration: true,
  }),
  command({
    id: 'verify-restored-derived-state', script: 'scripts/verify-jp-ohlcv-repair-derived-state.ts',
    args: ['--config', output, '--mode', 'rollback'], timeoutMs: 10 * 60_000,
    rollback: true, publishesServingGeneration: true,
  }),
]

const config: JpOhlcvProductionExecutionConfiguration = {
  version: 1,
  mode: 'PRODUCTION',
  targetDate: '2026-07-17',
  databaseRealpath,
  databaseIdentitySha256,
  databaseObjectIdentitySha256,
  stateDirectory,
  backupDirectory,
  minimumPostBackupFreeBytes: 150_000_000_000,
  storageIdentity,
  storageIdentitySha256: jpOhlcvStorageIdentitySha256(storageIdentity),
  sqliteExecutable,
  sqliteExecutableSha256: sha256File(sqliteExecutable),
  sourceGenerationBefore,
  sourceGenerationAfter,
  servingGenerationBefore,
  servingGenerationAfter,
  sourceGenerationPointer,
  servingGenerationPointer,
  triggerRepairEvidencePath,
  serviceSnapshotPath: path.join(stateDirectory, 'read-services.json'),
  writerServices: WEEKLY_BACKUP_WRITER_LABELS.map((label) => serviceIdentity(label, 'WRITER')),
  readServices: WEEKLY_BACKUP_READER_LABELS.map((label) => serviceIdentity(label, 'READ_SERVICE')),
  healthUrls: { web: webHealthUrl, analog: analogHealthUrl },
  requiredTickers: ['1306', '7003'],
  preservedConflictTickers: ['1447', '2164'],
  requiredTargetRows,
  preservedConflictRows,
  repairScope: {
    officialRows: 4218,
    existingRows: 151,
    matchingRows: 149,
    missingRows: 4067,
    conflicts: 2,
  },
  nestedCommands,
  maximumMaintenanceMs: 12 * 60 * 60_000,
  integrationRoot,
  integrationCommit: git(integrationRoot, ['rev-parse', 'HEAD']),
  integrationTreeId: git(integrationRoot, ['rev-parse', 'HEAD^{tree}']),
  runtimeManifestPath,
  runtimeManifestSha256: sha256File(runtimeManifestPath),
  runtimeIdentitySha256: runtimeManifest.hashes.runtimeIdentitySha256,
  lineage,
}
assertJpOhlcvProductionExecutionConfiguration(config)
writeNew(output, config)
console.log(JSON.stringify({
  status: 'PASS',
  configurationPath: output,
  configurationFileSha256: sha256File(output),
  configurationCanonicalSha256: executionConfigurationSha256(config),
  databaseIdentitySha256,
  databaseObjectIdentitySha256,
  databaseFileObservation: databaseFileIdentity(databaseRealpath),
  sourceGenerationBefore,
  sourceGenerationAfter,
  servingGenerationBefore,
  servingGenerationAfter,
  officialRows: officialRows.length,
  existingRows: existingRows.length,
  missingRows: scope.missingRows.length,
  preservedConflicts: scope.preservedConflicts.map((row) => row.ticker),
  writerServices: config.writerServices.map((service) => service.label),
  readServices: config.readServices.map((service) => service.label),
}))
