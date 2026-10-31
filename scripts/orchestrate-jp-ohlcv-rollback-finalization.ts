import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  assertFriendReadonlyRuntimeManifest,
  type FriendReadonlyRuntimeManifest,
} from '@/lib/friend-readonly-runtime'
import {
  friendReadonlyDecision,
} from '@/lib/friend-readonly-gateway'
import { FRIEND_READ_ONLY_JSON_POST_PATHS } from '@/lib/friend-readonly-policy'
import { stableSha256 } from '@/lib/jp-ohlcv-data-quality'
import {
  acquireHashBoundOperationLease,
  isProcessDefinitelyAbsent,
  releaseHashBoundOperationLease,
  type HashBoundOperationLeaseOwner,
} from '@/lib/hash-bound-operation-lease'
import {
  JP_OHLCV_EXPECTED_DISABLED_WRITER_LABELS,
  JP_OHLCV_EXPECTED_LOADED_WRITER_LABELS,
  JP_OHLCV_EXPECTED_UNLOADED_WRITER_LABELS,
  restoreJpOhlcvMaintenanceWriters,
  type JpOhlcvWriterRecoveryProgress,
} from '@/lib/jp-ohlcv-maintenance-orchestrator'
import {
  completeInterruptedRollbackArchive,
  repairApprovalSha256,
  repairRollbackFinalizationApprovalSha256,
  repairRollbackFinalizationContinuationApprovalSha256,
  type JpOhlcvRepairApproval,
  type JpOhlcvRepairPaths,
  type JpOhlcvRollbackFinalizationApproval,
  type JpOhlcvRollbackFinalizationContinuationApproval,
} from '@/lib/jp-ohlcv-production-repair'
import { runJpOhlcvProductionRepairRollbackFinalization } from '@/lib/jp-ohlcv-repair-runner'
import {
  assertJpOhlcvRepairExecutionActive,
  installJpOhlcvRepairSignalHandlers,
  readProcessIdentity,
} from '@/lib/jp-ohlcv-repair-process-supervisor'
import { waitForStableServiceReadiness, type StableServiceReadiness } from '@/lib/service-readiness'
import {
  assessFreshnessMonitoring,
  assessFreshnessSchedule,
  assertCloudflareAccessChallenge,
  assertCloudflareAccessEvidence,
  type CloudflareAccessEvidence,
  type FreshnessScheduleEvidence,
} from '@/lib/rollback-finalization-monitoring'
import {
  assertJpOhlcvProductionExecutionConfiguration,
  isHealthyJpOhlcvRepairResponseBody,
  sha256File,
  type JpOhlcvLaunchdServiceIdentity,
  type JpOhlcvProductionExecutionConfiguration,
} from '@/lib/jp-ohlcv-executable-plan'
import {
  hasStorageFatalLatch,
  hasStorageUncertainMarker,
  inspectWritableTargetPath,
  storageFatalLatchPath,
  type GuardConfig,
} from '@/lib/storage/external-storage-guard'
import { createLaunchdWriterHoldDriver } from '@/lib/storage/launchd-writer-hold-driver'

type SealedFile = { path: string; sha256: string }

type ApprovalBundle = {
  version: 1
  approval: JpOhlcvRepairApproval
  approvalSha256: string
  executionStatus: 'HOLD_PENDING_EXPLICIT_APPROVAL'
}

const FINALIZATION_STAGES: JpOhlcvRollbackFinalizationPlan['orderedStages'] = [
  { id: 'READ_ONLY_IDENTITY_PREFLIGHT', productionMutation: false, failureState: 'HOLD_PRESERVE_EVIDENCE' },
  { id: 'VERIFY_EXISTING_WEB_ANALOG', productionMutation: false, failureState: 'HOLD_PRESERVE_EVIDENCE' },
  { id: 'ACQUIRE_FINALIZATION_LEASE', productionMutation: true, failureState: 'HOLD_PRESERVE_EVIDENCE' },
  { id: 'PERSIST_FINALIZATION_CONTINUATION', productionMutation: true, failureState: 'HOLD_PRESERVE_EVIDENCE' },
  { id: 'INSTALL_IMMUTABLE_GATEWAY_RUNTIME', productionMutation: true, failureState: 'HOLD_PRESERVE_EVIDENCE' },
  { id: 'MIGRATE_GATEWAY_PLIST', productionMutation: true, failureState: 'HOLD_PRESERVE_EVIDENCE' },
  { id: 'VERIFY_GATEWAY_POLICY_AND_READINESS', productionMutation: false, failureState: 'HOLD_PRESERVE_EVIDENCE' },
  { id: 'RESUME_INTERRUPTED_FINALIZATION', productionMutation: true, failureState: 'HOLD_PRESERVE_EVIDENCE' },
  { id: 'FINALIZE_ROLLBACK_JOURNAL', productionMutation: true, failureState: 'HOLD_PRESERVE_EVIDENCE' },
  { id: 'PERSIST_WRITER_RECOVERY_RECEIPT', productionMutation: true, failureState: 'HOLD_PRESERVE_EVIDENCE' },
  { id: 'RESTORE_OR_RESUME_ORIGINAL_WRITERS', productionMutation: true, failureState: 'HOLD_PRESERVE_EVIDENCE' },
  { id: 'VERIFY_FINAL_HEALTH', productionMutation: false, failureState: 'HOLD_PRESERVE_EVIDENCE' },
]

const FINALIZATION_FORBIDDEN_STAGES: JpOhlcvRollbackFinalizationPlan['forbiddenStages'] = [
  'RESTORE_DATABASE', 'VERIFY_BACKUP', 'FORWARD_BACKFILL', 'CHANGE_GENERATION',
]

export type JpOhlcvRollbackFinalizationPlan = {
  version: 1
  action: 'FINALIZE_RESTORED_ROLLBACK'
  transactionId: string
  integrationHead: string
  integrationTreeId: string
  sourceEmergencyPackageApprovalSha256: string
  runnerBundleSha256: string
  gateway: {
    oldPlistSha256: string
    newPlistSha256: string
    runtimeSha256: string
    manifestSha256: string
    listen: 'http://127.0.0.1:3136'
    origin: 'http://127.0.0.1:3000'
  }
  cloudflareAccessEvidenceSha256: string
  orderedStages: Array<{
    id: string
    productionMutation: boolean
    failureState: 'HOLD_PRESERVE_EVIDENCE'
  }>
  forbiddenStages: ['RESTORE_DATABASE', 'VERIFY_BACKUP', 'FORWARD_BACKFILL', 'CHANGE_GENERATION']
}

type JpOhlcvWriterRecoveryState = {
  version: 1
  transactionId: string
  packageApprovalSha256: string
  archivedJournalPath: string
  archivedJournalFileSha256: string | null
  gatewayPlistSha256: string
  status: 'PENDING_FINALIZATION' | 'IN_PROGRESS' | 'COMPLETED'
  restoredLabels: string[]
  alreadyLoadedLabels: string[]
  preservedUnloadedLabels: string[]
  startedAtMs: number
  completedAtMs?: number
  updatedAt: string
}

let executionProgress = {
  stage: 'NOT_STARTED',
  gatewayMigrated: false,
  journalFinalized: false,
  writerRecoveryStatePath: null as string | null,
  finalizationContinuationApprovalSha256: null as string | null,
  finalizationOperationLeasePath: null as string | null,
}
let removeSignalHandlers: (() => void) | null = null

export type JpOhlcvRollbackFinalizationPackage = {
  version: 1
  transactionId: string
  preparedAt: string
  integrationRoot: string
  integrationHead: string
  integrationTreeId: string
  sourceEmergencyPackagePath: string
  sourceEmergencyPackageFileSha256: string
  sourceEmergencyPackageApprovalSha256: string
  approvalBundlePath: string
  approvalBundleFileSha256: string
  sourceRecoveryConfigurationPath: string
  sourceRecoveryConfigurationFileSha256: string
  sourceRecoveryConfigurationSha256: string
  configurationPath: string
  configurationFileSha256: string
  configurationSha256: string
  finalizationApprovalPath: string
  finalizationApprovalFileSha256: string
  finalizationApprovalSha256: string
  finalizationPlanPath: string
  finalizationPlanFileSha256: string
  finalizationPlanSha256: string
  activeJournalPath: string
  activeJournalSha256: string
  activeJournalFileSha256: string
  activeLockPath: string
  activeLockFileSha256: string
  restoreStatePath: string
  restoreStateSha256: string
  restoreStateFileSha256: string
  readServiceSnapshotPath: string
  readServiceSnapshotFileSha256: string
  rolledBackArchivePath: string
  writerRecoveryStatePath: string
  finalizationOperationLeasePath: string
  freshnessReportPath: string
  storageFatalLatchPath: string
  restoredDatabaseSha256: string
  restoredDatabaseSize: number
  sourceGeneration: string
  servingGeneration: string
  runner: {
    executable: string
    executableSha256: string
    bundlePath: string
    bundleSha256: string
  }
  gateway: {
    bundleSourcePath: string
    bundleSha256: string
    runtimeTargetPath: string
    manifestSourcePath: string
    manifestFileSha256: string
    manifestSha256: string
    plistSourcePath: string
    plistSha256: string
    productionPlistPath: string
    oldPlistSha256: string
    oldPlistArchivePath: string
  }
  externalTunnel: {
    plistPath: string
    plistSha256: string
    executablePath: string
    executableSha256: string
  }
  externalAccess: {
    evidencePath: string
    evidenceFileSha256: string
    evidenceSha256: string
    evidence: CloudflareAccessEvidence
  }
  sourceFiles: SealedFile[]
}

function value(flag: string): string {
  const index = process.argv.indexOf(flag)
  const result = index >= 0 ? process.argv[index + 1] : null
  if (!result || result.startsWith('--')) throw new Error(`${flag}_required`)
  return result
}

function readJson<T>(file: string): T {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`rollback_finalization_file_invalid:${file}`)
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T
}

function assertFile(file: string, expectedSha256: string, code: string): void {
  if (!path.isAbsolute(file) || !fs.existsSync(file) || fs.realpathSync(file) !== file
    || fs.lstatSync(file).isSymbolicLink() || sha256File(file) !== expectedSha256) {
    throw new Error(`${code}_identity_mismatch:${file}`)
  }
}

function generation(file: string): { generation: string; sourceGeneration?: string } {
  const parsed = readJson<{ generation?: unknown; sourceGeneration?: unknown }>(file)
  if (typeof parsed.generation !== 'string'
    || (parsed.sourceGeneration !== undefined && typeof parsed.sourceGeneration !== 'string')) {
    throw new Error(`rollback_finalization_generation_invalid:${file}`)
  }
  return parsed as { generation: string; sourceGeneration?: string }
}

async function health(url: string): Promise<void> {
  const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(10_000) })
  const body = await response.text()
  if (!response.ok || !isHealthyJpOhlcvRepairResponseBody(body)) {
    throw new Error(`rollback_finalization_health_failed:${url}:status_${response.status}`)
  }
}

function launchdIdentity(service: JpOhlcvLaunchdServiceIdentity) {
  return {
    label: service.label,
    plistPath: service.plistPath,
    definitionSha256: service.definitionSha256,
    program: service.program,
  }
}

async function stableReady(input: {
  service: JpOhlcvLaunchdServiceIdentity
  healthUrl: string
}): Promise<StableServiceReadiness> {
  const driver = createLaunchdWriterHoldDriver([launchdIdentity(input.service)])
  return waitForStableServiceReadiness({
    label: input.service.label,
    observe: () => driver.observe(input.service.label),
    probe: () => health(input.healthUrl),
    timeoutMs: 120_000,
    intervalMs: 2_000,
    consecutivePasses: 5,
    minimumStableMs: 30_000,
    maximumPidChanges: 2,
  })
}

function liveStorageGuardConfig(
  pkg: JpOhlcvRollbackFinalizationPackage,
  config: JpOhlcvProductionExecutionConfiguration,
): GuardConfig {
  const guard: GuardConfig = {
    dbPath: config.databaseRealpath,
    mountPath: config.storageIdentity.mountPath,
    volumeUuid: config.storageIdentity.volumeUuid,
    minFreeBytes: config.storageIdentity.minFreeBytes,
    minFreePercent: config.storageIdentity.minFreePercent,
    jobType: 'jp_ohlcv_gap_repair_finalization',
    incidentDir: path.dirname(pkg.storageFatalLatchPath),
  }
  if (storageFatalLatchPath(guard) !== pkg.storageFatalLatchPath) {
    throw new Error('rollback_finalization_storage_latch_path_mismatch')
  }
  return guard
}

function assertLiveStorageGuard(
  pkg: JpOhlcvRollbackFinalizationPackage,
  config: JpOhlcvProductionExecutionConfiguration,
): void {
  const guard = liveStorageGuardConfig(pkg, config)
  const volume = inspectWritableTargetPath(guard)
  if (volume.uuid?.toUpperCase() !== config.storageIdentity.volumeUuid.toUpperCase()
    || volume.freeBytes < config.storageIdentity.minFreeBytes
    || volume.freeBytes / Math.max(volume.totalBytes, 1) * 100
      < config.storageIdentity.minFreePercent) {
    throw new Error('rollback_finalization_live_storage_identity_invalid')
  }
  if (hasStorageFatalLatch(guard)) throw new Error('rollback_finalization_failed_safe_latch_present')
  if (hasStorageUncertainMarker(guard)) throw new Error('rollback_finalization_storage_probe_uncertain')
}

function plistValue(plistPath: string, keyPath: string): string {
  return execFileSync('/usr/bin/plutil', ['-extract', keyPath, 'raw', '-o', '-', plistPath], {
    encoding: 'utf8',
  }).trim()
}

function freshnessSchedule(plistPath: string): FreshnessScheduleEvidence {
  const plist = JSON.parse(execFileSync('/usr/bin/plutil', [
    '-convert', 'json', '-o', '-', plistPath,
  ], { encoding: 'utf8' })) as {
    RunAtLoad?: unknown
    StartInterval?: unknown
    StartCalendarInterval?: unknown
    EnvironmentVariables?: { DATA_FRESHNESS_GUARD_DRY_RUN?: unknown }
    ProgramArguments?: unknown
  }
  const startIntervalSeconds = Number.isInteger(plist.StartInterval)
    && Number(plist.StartInterval) > 0
    ? Number(plist.StartInterval)
    : null
  const startCalendarIntervalCount = Array.isArray(plist.StartCalendarInterval)
    ? plist.StartCalendarInterval.length
    : plist.StartCalendarInterval && typeof plist.StartCalendarInterval === 'object' ? 1 : 0
  const programArguments = Array.isArray(plist.ProgramArguments)
    ? plist.ProgramArguments.filter((value): value is string => typeof value === 'string')
    : []
  const argumentDryRun = programArguments.some((value) => (
    value === '--dry-run' || /(^|\s)--dry-run(?:\s|$)/.test(value)
  ))
  return assessFreshnessSchedule({
    runAtLoad: plist.RunAtLoad === true,
    startIntervalSeconds,
    startCalendarIntervalCount,
    reportPersistenceEnabled: plist.EnvironmentVariables?.DATA_FRESHNESS_GUARD_DRY_RUN !== '1'
      && !argumentDryRun,
    waitBudgetMs: 300_000,
  })
}

function assertFinalizationContracts(input: {
  pkg: JpOhlcvRollbackFinalizationPackage
  plan: JpOhlcvRollbackFinalizationPlan
  approval: JpOhlcvRollbackFinalizationApproval
  manifest: FriendReadonlyRuntimeManifest
}): void {
  const { pkg, plan, approval, manifest } = input
  const expectedGatewayApproval: JpOhlcvRollbackFinalizationApproval['gatewayMigration'] = {
    label: 'com.stockboard.friend-readonly-gateway',
    plistPath: pkg.gateway.productionPlistPath,
    oldPlistSha256: pkg.gateway.oldPlistSha256,
    newPlistSha256: pkg.gateway.plistSha256,
    runtimeSourcePath: pkg.gateway.bundleSourcePath,
    runtimeTargetPath: pkg.gateway.runtimeTargetPath,
    runtimeSha256: pkg.gateway.bundleSha256,
    manifestPath: pkg.gateway.manifestSourcePath,
    manifestSha256: pkg.gateway.manifestSha256,
    nodeExecutable: manifest.nodeExecutable,
    nodeExecutableSha256: manifest.nodeExecutableSha256,
    listen: 'http://127.0.0.1:3136',
    origin: 'http://127.0.0.1:3000',
  }
  const expectedPlanGateway: JpOhlcvRollbackFinalizationPlan['gateway'] = {
    oldPlistSha256: pkg.gateway.oldPlistSha256,
    newPlistSha256: pkg.gateway.plistSha256,
    runtimeSha256: pkg.gateway.bundleSha256,
    manifestSha256: pkg.gateway.manifestSha256,
    listen: 'http://127.0.0.1:3136',
    origin: 'http://127.0.0.1:3000',
  }
  if (approval.journalSha256 !== pkg.activeJournalSha256
    || approval.transactionId !== pkg.transactionId
    || approval.backupSha256 !== pkg.restoredDatabaseSha256
    || approval.sourceGeneration !== pkg.sourceGeneration
    || approval.servingGeneration !== pkg.servingGeneration
    || approval.journalFileSha256 !== pkg.activeJournalFileSha256
    || approval.lockFileSha256 !== pkg.activeLockFileSha256
    || approval.restoreStatePath !== pkg.restoreStatePath
    || approval.restoreStateSha256 !== pkg.restoreStateSha256
    || approval.restoreStateFileSha256 !== pkg.restoreStateFileSha256
    || approval.readServiceSnapshotPath !== pkg.readServiceSnapshotPath
    || approval.readServiceSnapshotFileSha256 !== pkg.readServiceSnapshotFileSha256
    || stableSha256(approval.gatewayMigration) !== stableSha256(expectedGatewayApproval)
    || plan.version !== 1 || plan.action !== 'FINALIZE_RESTORED_ROLLBACK'
    || stableSha256(plan.gateway) !== stableSha256(expectedPlanGateway)
    || plan.cloudflareAccessEvidenceSha256 !== pkg.externalAccess.evidenceSha256
    || stableSha256(plan.orderedStages) !== stableSha256(FINALIZATION_STAGES)
    || stableSha256(plan.forbiddenStages) !== stableSha256(FINALIZATION_FORBIDDEN_STAGES)) {
    throw new Error('rollback_finalization_contract_mismatch')
  }
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, 'r')
  try { fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
}

function writeNew(file: string, bytes: Buffer | string, mode: number): void {
  const descriptor = fs.openSync(file, 'wx', mode)
  try {
    fs.writeFileSync(descriptor, bytes)
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`
  writeNew(temporary, `${JSON.stringify(value, null, 2)}\n`, 0o600)
  fs.renameSync(temporary, file)
  fsyncDirectory(path.dirname(file))
}

function finalizationLeaseScope(pkg: JpOhlcvRollbackFinalizationPackage): string {
  return stableSha256({
    version: 1,
    operation: 'JP_OHLCV_ROLLBACK_FINALIZATION',
    transactionId: pkg.transactionId,
  })
}

function replaceFileAtomically(file: string, bytes: Buffer, mode: number): void {
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`
  writeNew(temporary, bytes, mode)
  fs.renameSync(temporary, file)
  fsyncDirectory(path.dirname(file))
}

function installImmutableGatewayRuntime(pkg: JpOhlcvRollbackFinalizationPackage): void {
  const runtimeDirectory = path.dirname(pkg.gateway.runtimeTargetPath)
  const manifestTargetPath = path.join(runtimeDirectory, path.basename(pkg.gateway.manifestSourcePath))
  if (fs.existsSync(runtimeDirectory)) {
    assertFile(pkg.gateway.runtimeTargetPath, pkg.gateway.bundleSha256, 'rollback_finalization_installed_gateway')
    assertFile(manifestTargetPath, pkg.gateway.manifestFileSha256, 'rollback_finalization_installed_manifest')
    return
  }
  fs.mkdirSync(path.dirname(runtimeDirectory), { recursive: true, mode: 0o700 })
  const temporary = `${runtimeDirectory}.tmp-${process.pid}-${crypto.randomUUID()}`
  fs.mkdirSync(temporary, { mode: 0o700 })
  try {
    writeNew(path.join(temporary, path.basename(pkg.gateway.runtimeTargetPath)),
      fs.readFileSync(pkg.gateway.bundleSourcePath), 0o500)
    writeNew(path.join(temporary, path.basename(pkg.gateway.manifestSourcePath)),
      fs.readFileSync(pkg.gateway.manifestSourcePath), 0o400)
    fsyncDirectory(temporary)
    fs.renameSync(temporary, runtimeDirectory)
    fsyncDirectory(path.dirname(runtimeDirectory))
  } catch (error) {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { recursive: true })
    throw error
  }
  assertFile(pkg.gateway.runtimeTargetPath, pkg.gateway.bundleSha256, 'rollback_finalization_installed_gateway')
  assertFile(manifestTargetPath, pkg.gateway.manifestFileSha256, 'rollback_finalization_installed_manifest')
}

async function restoreOriginalGatewayDefinition(input: {
  pkg: JpOhlcvRollbackFinalizationPackage
  newService: JpOhlcvLaunchdServiceIdentity
}): Promise<void> {
  const currentPlistSha256 = sha256File(input.pkg.gateway.productionPlistPath)
  if (currentPlistSha256 === input.pkg.gateway.oldPlistSha256) return
  if (currentPlistSha256 !== input.pkg.gateway.plistSha256) {
    throw new Error('rollback_finalization_gateway_compensation_definition_unknown')
  }
  const driver = createLaunchdWriterHoldDriver([launchdIdentity(input.newService)])
  const observed = await driver.observe(input.newService.label)
  if (observed.loaded) await driver.bootout(input.newService.label)
  replaceFileAtomically(
    input.pkg.gateway.productionPlistPath,
    fs.readFileSync(input.pkg.gateway.oldPlistArchivePath),
    0o600,
  )
  assertFile(input.pkg.gateway.productionPlistPath, input.pkg.gateway.oldPlistSha256,
    'rollback_finalization_gateway_compensated_plist')
}

async function ensureMigratedGatewayReady(input: {
  pkg: JpOhlcvRollbackFinalizationPackage
  newService: JpOhlcvLaunchdServiceIdentity
}): Promise<StableServiceReadiness> {
  const driver = createLaunchdWriterHoldDriver([launchdIdentity(input.newService)])
  const observed = await driver.observe(input.newService.label)
  if (observed.disabled || observed.instances > 1) {
    throw new Error('rollback_finalization_gateway_migrated_state_invalid')
  }
  if (!observed.loaded) await driver.bootstrap(input.newService.label)
  return stableReady({
    service: input.newService,
    healthUrl: 'http://127.0.0.1:3136/api/health',
  })
}

async function migrateGateway(input: {
  pkg: JpOhlcvRollbackFinalizationPackage
  oldService: JpOhlcvLaunchdServiceIdentity
  manifest: FriendReadonlyRuntimeManifest
}): Promise<StableServiceReadiness> {
  const { pkg } = input
  installImmutableGatewayRuntime(pkg)
  const oldIdentity = launchdIdentity(input.oldService)
  const oldDriver = createLaunchdWriterHoldDriver([oldIdentity])
  if (!fs.existsSync(pkg.gateway.oldPlistArchivePath)) {
    fs.mkdirSync(path.dirname(pkg.gateway.oldPlistArchivePath), { recursive: true, mode: 0o700 })
    writeNew(pkg.gateway.oldPlistArchivePath, fs.readFileSync(pkg.gateway.productionPlistPath), 0o400)
    fsyncDirectory(path.dirname(pkg.gateway.oldPlistArchivePath))
  }
  assertFile(pkg.gateway.oldPlistArchivePath, pkg.gateway.oldPlistSha256,
    'rollback_finalization_gateway_old_plist_archive')
  const current = await oldDriver.observe(oldIdentity.label)
  if (current.loaded) await oldDriver.bootout(oldIdentity.label)
  const temporaryPlist = `${pkg.gateway.productionPlistPath}.tmp-${process.pid}-${crypto.randomUUID()}`
  writeNew(temporaryPlist, fs.readFileSync(pkg.gateway.plistSourcePath), 0o600)
  fs.renameSync(temporaryPlist, pkg.gateway.productionPlistPath)
  fsyncDirectory(path.dirname(pkg.gateway.productionPlistPath))
  assertFile(pkg.gateway.productionPlistPath, pkg.gateway.plistSha256,
    'rollback_finalization_gateway_new_plist')
  const newService: JpOhlcvLaunchdServiceIdentity = {
    label: 'com.stockboard.friend-readonly-gateway',
    plistPath: pkg.gateway.productionPlistPath,
    definitionSha256: pkg.gateway.plistSha256,
    program: input.manifest.nodeExecutable,
    role: 'READ_SERVICE',
  }
  const newDriver = createLaunchdWriterHoldDriver([launchdIdentity(newService)])
  await newDriver.bootstrap(newService.label)
  return stableReady({ service: newService, healthUrl: 'http://127.0.0.1:3136/api/health' })
}

async function assertGatewayReadOnlyPolicy(pid: number): Promise<void> {
  const listeners = execFileSync('/usr/sbin/lsof', [
    '-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-Fn',
  ], { encoding: 'utf8', timeout: 10_000 })
    .split('\n')
    .filter((line) => line.startsWith('n'))
    .map((line) => line.slice(1))
  if (listeners.length !== 1 || !listeners[0]?.endsWith('127.0.0.1:3136')) {
    throw new Error(`rollback_finalization_gateway_listener_not_loopback:${listeners.join(',')}`)
  }
  const head = await fetch('http://127.0.0.1:3136/api/health', {
    method: 'HEAD', cache: 'no-store', signal: AbortSignal.timeout(10_000),
  })
  if (!head.ok) throw new Error('rollback_finalization_gateway_head_failed')
  const mutation = await fetch('http://127.0.0.1:3136/api/health', {
    method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(10_000),
  })
  if (mutation.status !== 405) throw new Error('rollback_finalization_gateway_mutation_not_blocked')
  const privatePath = await fetch('http://127.0.0.1:3136/api/admin/update-latest', {
    cache: 'no-store', signal: AbortSignal.timeout(10_000),
  })
  if (privatePath.status !== 404) throw new Error('rollback_finalization_gateway_private_path_not_blocked')
  for (const allowedPostPath of FRIEND_READ_ONLY_JSON_POST_PATHS) {
    if (!friendReadonlyDecision('POST', allowedPostPath).allowed) {
      throw new Error(`rollback_finalization_gateway_read_post_missing:${allowedPostPath}`)
    }
  }
  if (friendReadonlyDecision('POST', '/api/health').allowed
    || friendReadonlyDecision('POST', '/api/trigger-discovery/saved').allowed
    || friendReadonlyDecision('PUT', '/api/trigger-discovery/search').allowed
    || friendReadonlyDecision('PATCH', '/api/trigger-discovery/search').allowed
    || friendReadonlyDecision('DELETE', '/api/trigger-discovery/search').allowed
    || friendReadonlyDecision('GET', '/api/admin/update-latest').allowed
    || friendReadonlyDecision('GET', '/%2561dmin/db').allowed) {
    throw new Error('rollback_finalization_gateway_policy_contract_invalid')
  }
}

async function assertGatewayPolicyOrStop(
  service: JpOhlcvLaunchdServiceIdentity,
  pid: number,
): Promise<void> {
  try {
    await assertGatewayReadOnlyPolicy(pid)
  } catch (error) {
    const driver = createLaunchdWriterHoldDriver([launchdIdentity(service)])
    const observed = await driver.observe(service.label)
    if (observed.loaded) await driver.bootout(service.label)
    throw error
  }
}

async function assertExternalAccessBoundary(pkg: JpOhlcvRollbackFinalizationPackage): Promise<void> {
  assertFile(pkg.externalAccess.evidencePath, pkg.externalAccess.evidenceFileSha256,
    'rollback_finalization_cloudflare_access_evidence')
  const evidence = readJson<CloudflareAccessEvidence>(pkg.externalAccess.evidencePath)
  if (stableSha256(evidence) !== pkg.externalAccess.evidenceSha256
    || stableSha256(evidence) !== stableSha256(pkg.externalAccess.evidence)) {
    throw new Error('rollback_finalization_cloudflare_access_evidence_mismatch')
  }
  assertCloudflareAccessEvidence(evidence)
  const assertRedirect = async (requestPath: string, init: RequestInit = {}) => {
    const response = await fetch(`https://${evidence.hostname}${requestPath}`, {
      ...init,
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    })
    const location = response.headers.get('location')
    let loginUrl: URL
    try {
      loginUrl = new URL(location ?? '')
    } catch {
      throw new Error('rollback_finalization_cloudflare_access_location_invalid')
    }
    if (response.status !== 302
      || loginUrl.protocol !== 'https:'
      || loginUrl.hostname !== evidence.teamDomain
      || !loginUrl.pathname.startsWith(`/cdn-cgi/access/login/${evidence.hostname}`)
      || loginUrl.searchParams.get('kid') !== evidence.applicationAudience
      || !response.headers.get('www-authenticate')?.includes('Cloudflare-Access')) {
      throw new Error('rollback_finalization_cloudflare_access_boundary_invalid')
    }
    return { response, loginUrl }
  }
  const homepage = await assertRedirect('/')
  await assertRedirect('/api/health')
  await assertRedirect('/api/trigger-discovery/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  const login = await fetch(homepage.loginUrl, {
    redirect: 'manual',
    cache: 'no-store',
    signal: AbortSignal.timeout(15_000),
  })
  const loginBody = await login.text()
  if (!login.ok) throw new Error(`rollback_finalization_cloudflare_access_login_failed:${login.status}`)
  assertCloudflareAccessChallenge({
    evidence,
    status: homepage.response.status,
    location: homepage.loginUrl.href,
    wwwAuthenticate: homepage.response.headers.get('www-authenticate'),
    loginBody,
  })
}

async function waitForGenerationConsistency(
  config: JpOhlcvProductionExecutionConfiguration,
): Promise<{ sourceGeneration: string; servingGeneration: string }> {
  const deadline = Date.now() + 120_000
  let passes = 0
  let stablePair: string | null = null
  let last = 'not_checked'
  while (Date.now() <= deadline) {
    assertJpOhlcvRepairExecutionActive()
    const source = generation(config.sourceGenerationPointer)
    const serving = generation(config.servingGenerationPointer)
    last = `${source.generation}:${serving.generation}:${serving.sourceGeneration ?? 'missing'}`
    if (serving.sourceGeneration === source.generation) {
      const pair = `${source.generation}:${serving.generation}`
      passes = pair === stablePair ? passes + 1 : 1
      stablePair = pair
      if (passes >= 3) return {
        sourceGeneration: source.generation,
        servingGeneration: serving.generation,
      }
    } else {
      passes = 0
      stablePair = null
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  }
  throw new Error(`rollback_finalization_generation_consistency_timeout:${last}`)
}

function assessFreshnessReport(
  reportPath: string,
  notBeforeMs: number,
): ReturnType<typeof assessFreshnessMonitoring> {
  try {
    const stat = fs.statSync(reportPath)
    return assessFreshnessMonitoring({
      report: readJson<unknown>(reportPath),
      reportMtimeMs: stat.mtimeMs,
      recoveryCompletedAtMs: notBeforeMs,
    })
  } catch {
    return assessFreshnessMonitoring({
      report: null,
      reportMtimeMs: null,
      recoveryCompletedAtMs: notBeforeMs,
    })
  }
}

async function restoreWritersWithReceipt(input: {
  pkg: JpOhlcvRollbackFinalizationPackage
  config: JpOhlcvProductionExecutionConfiguration
  packageApprovalSha256: string
  state: JpOhlcvWriterRecoveryState
}): Promise<Record<string, unknown>> {
  const archive = readJson<{
    stage?: unknown
    transactionId?: unknown
    evidence?: { ROLLBACK_VERIFIED?: { finalizationApprovalSha256?: unknown } }
  }>(input.pkg.rolledBackArchivePath)
  if (archive.stage !== 'ROLLED_BACK' || archive.transactionId !== input.pkg.transactionId
    || archive.evidence?.ROLLBACK_VERIFIED?.finalizationApprovalSha256
      !== input.pkg.finalizationApprovalSha256
    || input.state.version !== 1 || !['IN_PROGRESS', 'COMPLETED'].includes(input.state.status)
    || input.state.transactionId !== input.pkg.transactionId
    || input.state.packageApprovalSha256 !== input.packageApprovalSha256
    || input.state.archivedJournalPath !== input.pkg.rolledBackArchivePath
    || input.state.archivedJournalFileSha256 !== sha256File(input.pkg.rolledBackArchivePath)
    || input.state.gatewayPlistSha256 !== input.pkg.gateway.plistSha256
    || fs.existsSync(input.pkg.activeJournalPath) || fs.existsSync(input.pkg.activeLockPath)) {
    throw new Error('rollback_finalization_writer_recovery_state_mismatch')
  }
  assertFile(input.pkg.gateway.productionPlistPath, input.pkg.gateway.plistSha256,
    'rollback_finalization_writer_gateway_plist')
  assertFile(input.pkg.gateway.runtimeTargetPath, input.pkg.gateway.bundleSha256,
    'rollback_finalization_writer_gateway_runtime')
  const incidentConfig = liveStorageGuardConfig(input.pkg, input.config)
  const gatewayService: JpOhlcvLaunchdServiceIdentity = {
    label: 'com.stockboard.friend-readonly-gateway',
    plistPath: input.pkg.gateway.productionPlistPath,
    definitionSha256: input.pkg.gateway.plistSha256,
    program: plistValue(input.pkg.gateway.plistSourcePath, 'ProgramArguments.0'),
    role: 'READ_SERVICE',
  }
  const web = input.config.readServices.find((entry) => entry.label === 'com.stockboard.web')
  const analog = input.config.readServices.find((entry) => entry.label === 'com.stockboard.analog-search')
  const webHealth = input.config.readServices.find((entry) => entry.label === 'com.stockboard.web-health')
  if (!web || !analog || !webHealth) throw new Error('rollback_finalization_writer_read_inventory_invalid')
  const assertWriterBootstrapSafe = async () => {
    assertJpOhlcvRepairExecutionActive()
    assertLiveStorageGuard(input.pkg, input.config)
    if (fs.existsSync(input.pkg.activeJournalPath) || fs.existsSync(input.pkg.activeLockPath)
      || !fs.existsSync(input.pkg.rolledBackArchivePath)
      || hasStorageFatalLatch(incidentConfig)) {
      throw new Error('rollback_finalization_writer_bootstrap_safety_changed')
    }
    await Promise.all([
      health(input.config.healthUrls.web),
      health(input.config.healthUrls.analog),
      health('http://127.0.0.1:3136/api/health'),
    ])
  }
  assertLiveStorageGuard(input.pkg, input.config)
  await stableReady({ service: web, healthUrl: input.config.healthUrls.web })
  await stableReady({ service: analog, healthUrl: input.config.healthUrls.analog })
  const gatewayReady = await stableReady({
    service: gatewayService,
    healthUrl: 'http://127.0.0.1:3136/api/health',
  })
  await assertGatewayPolicyOrStop(gatewayService, gatewayReady.pid)
  await assertWriterBootstrapSafe()
  const writerDriver = createLaunchdWriterHoldDriver(input.config.writerServices.map(launchdIdentity))
  const onProgress = async (progress: JpOhlcvWriterRecoveryProgress) => {
    const restoredLabels = [...new Set([...input.state.restoredLabels, ...progress.restoredLabels])]
    const alreadyLoadedLabels = [...new Set([
      ...input.state.alreadyLoadedLabels,
      ...progress.alreadyLoadedLabels.filter((label) => !restoredLabels.includes(label)),
    ])]
    const next: JpOhlcvWriterRecoveryState = {
      ...input.state,
      ...progress,
      restoredLabels,
      alreadyLoadedLabels,
      startedAtMs: input.state.startedAtMs,
      updatedAt: new Date().toISOString(),
    }
    writeJsonAtomic(input.pkg.writerRecoveryStatePath, next)
    input.state = next
  }
  const writerRecovery = await restoreJpOhlcvMaintenanceWriters({
    config: input.config,
    driver: writerDriver,
    assertRecoverySafe: assertWriterBootstrapSafe,
    onProgress,
  })
  const freshnessService = input.config.writerServices.find(
    (service) => service.label === 'com.stockboard.data-freshness-guard',
  )
  if (!freshnessService) throw new Error('rollback_finalization_freshness_service_missing')
  const freshnessGuardState = await writerDriver.observe(freshnessService.label)
  if (!freshnessGuardState.loaded || freshnessGuardState.disabled
    || freshnessGuardState.instances > 1) {
    throw new Error('rollback_finalization_freshness_service_state_invalid')
  }
  const freshnessGuardSchedule = freshnessSchedule(freshnessService.plistPath)
  const generations = await waitForGenerationConsistency(input.config)
  await stableReady({ service: web, healthUrl: input.config.healthUrls.web })
  await stableReady({ service: analog, healthUrl: input.config.healthUrls.analog })
  const finalGatewayReady = await stableReady({
    service: gatewayService,
    healthUrl: 'http://127.0.0.1:3136/api/health',
  })
  await assertGatewayPolicyOrStop(gatewayService, finalGatewayReady.pid)
  const freshness = assessFreshnessReport(
    input.pkg.freshnessReportPath,
    writerRecovery.completedAtMs,
  )
  const finalGenerations = await waitForGenerationConsistency(input.config)
  await stableReady({ service: web, healthUrl: input.config.healthUrls.web })
  await stableReady({ service: analog, healthUrl: input.config.healthUrls.analog })
  const postFreshnessGateway = await stableReady({
    service: gatewayService,
    healthUrl: 'http://127.0.0.1:3136/api/health',
  })
  await assertGatewayPolicyOrStop(gatewayService, postFreshnessGateway.pid)
  const webHealthState = await createLaunchdWriterHoldDriver([launchdIdentity(webHealth)])
    .observe(webHealth.label)
  if (!webHealthState.loaded || webHealthState.disabled || webHealthState.instances !== 1) {
    throw new Error('rollback_finalization_post_writer_web_health_service_invalid')
  }
  assertLiveStorageGuard(input.pkg, input.config)
  const completed: JpOhlcvWriterRecoveryState = {
    ...input.state,
    status: 'COMPLETED',
    restoredLabels: input.state.restoredLabels,
    alreadyLoadedLabels: input.state.alreadyLoadedLabels,
    preservedUnloadedLabels: writerRecovery.preservedUnloadedLabels,
    completedAtMs: writerRecovery.completedAtMs,
    updatedAt: new Date().toISOString(),
  }
  writeJsonAtomic(input.pkg.writerRecoveryStatePath, completed)
  return {
    recoverySafetyStatus: 'PASS',
    operationalMonitoringStatus: freshness.status,
    operationalMonitoringFollowUpRequired: freshness.operatorFollowUpRequired,
    writerRecovery,
    generations,
    finalGenerations,
    freshness,
    freshnessGuardState,
    freshnessGuardSchedule,
    webHealthState,
    writerRecoveryStateSha256: stableSha256(completed),
  }
}

async function resumeWriterRecovery(input: {
  pkg: JpOhlcvRollbackFinalizationPackage
  config: JpOhlcvProductionExecutionConfiguration
  packageApprovalSha256: string
  plan: JpOhlcvRollbackFinalizationPlan
  approval: JpOhlcvRollbackFinalizationApproval
}): Promise<void> {
  assertFile(input.pkg.gateway.bundleSourcePath, input.pkg.gateway.bundleSha256,
    'rollback_finalization_gateway_bundle')
  assertFile(input.pkg.gateway.manifestSourcePath, input.pkg.gateway.manifestFileSha256,
    'rollback_finalization_gateway_manifest')
  assertFile(input.pkg.gateway.plistSourcePath, input.pkg.gateway.plistSha256,
    'rollback_finalization_gateway_plist')
  const manifest = readJson<FriendReadonlyRuntimeManifest>(input.pkg.gateway.manifestSourcePath)
  assertFriendReadonlyRuntimeManifest(manifest)
  if (stableSha256(manifest) !== input.pkg.gateway.manifestSha256
    || manifest.runtimePath !== input.pkg.gateway.runtimeTargetPath
    || manifest.runtimeSha256 !== input.pkg.gateway.bundleSha256) {
    throw new Error('rollback_finalization_writer_gateway_manifest_mismatch')
  }
  assertFile(manifest.nodeExecutable, manifest.nodeExecutableSha256,
    'rollback_finalization_writer_gateway_node')
  if (plistValue(input.pkg.gateway.plistSourcePath, 'ProgramArguments.0') !== manifest.nodeExecutable
    || plistValue(input.pkg.gateway.plistSourcePath, 'ProgramArguments.1') !== manifest.runtimePath
    || plistValue(input.pkg.gateway.plistSourcePath, 'EnvironmentVariables.STOCKBOARD_FRIEND_GATEWAY_HOST')
      !== '127.0.0.1'
    || plistValue(input.pkg.gateway.plistSourcePath, 'EnvironmentVariables.STOCKBOARD_FRIEND_GATEWAY_PORT')
      !== '3136'
    || plistValue(input.pkg.gateway.plistSourcePath, 'EnvironmentVariables.STOCKBOARD_FRIEND_ORIGIN')
      !== manifest.origin) {
    throw new Error('rollback_finalization_writer_gateway_plist_contract_mismatch')
  }
  assertFinalizationContracts({ pkg: input.pkg, plan: input.plan, approval: input.approval, manifest })
  assertFile(input.pkg.gateway.productionPlistPath, input.pkg.gateway.plistSha256,
    'rollback_finalization_installed_gateway_plist')
  assertFile(input.pkg.gateway.runtimeTargetPath, input.pkg.gateway.bundleSha256,
    'rollback_finalization_installed_gateway_runtime')
  assertFile(input.pkg.externalTunnel.plistPath, input.pkg.externalTunnel.plistSha256,
    'rollback_finalization_writer_tunnel_plist')
  assertFile(input.pkg.externalTunnel.executablePath, input.pkg.externalTunnel.executableSha256,
    'rollback_finalization_writer_tunnel_executable')
  let state = readJson<JpOhlcvWriterRecoveryState>(input.pkg.writerRecoveryStatePath)
  const resumeApproval = process.env.STOCKBOARD_JP_OHLCV_WRITER_RECOVERY_APPROVED
  if (!resumeApproval || resumeApproval !== stableSha256(state)) {
    throw new Error('rollback_finalization_writer_recovery_exact_approval_required')
  }
  if (fs.existsSync(input.pkg.activeJournalPath) || fs.existsSync(input.pkg.activeLockPath)) {
    completeInterruptedRollbackArchive({
      paths: {
        stateDirectory: input.config.stateDirectory,
        journal: input.pkg.activeJournalPath,
        lock: input.pkg.activeLockPath,
      },
      transactionId: input.pkg.transactionId,
      repairApprovalSha256: input.approval.repairApprovalSha256,
      finalizationApprovalSha256: input.pkg.finalizationApprovalSha256,
      expectedLockFileSha256: input.pkg.activeLockFileSha256,
    })
  }
  if (fs.existsSync(input.pkg.activeJournalPath) || fs.existsSync(input.pkg.activeLockPath)
    || !fs.existsSync(input.pkg.rolledBackArchivePath)) {
    throw new Error('rollback_finalization_writer_recovery_terminal_archive_required')
  }
  if (state.status === 'PENDING_FINALIZATION') {
    state = {
      ...state,
      status: 'IN_PROGRESS',
      archivedJournalFileSha256: sha256File(input.pkg.rolledBackArchivePath),
      updatedAt: new Date().toISOString(),
    }
    writeJsonAtomic(input.pkg.writerRecoveryStatePath, state)
  } else if (state.status === 'COMPLETED') {
    state = {
      ...state,
      status: 'IN_PROGRESS',
      completedAtMs: undefined,
      updatedAt: new Date().toISOString(),
    }
    writeJsonAtomic(input.pkg.writerRecoveryStatePath, state)
  }
  if (!state.archivedJournalFileSha256) {
    throw new Error('rollback_finalization_writer_recovery_archive_hash_missing')
  }
  assertFile(input.pkg.rolledBackArchivePath, state.archivedJournalFileSha256,
    'rollback_finalization_archived_journal')
  executionProgress = {
    stage: 'RESUMING_WRITERS',
    gatewayMigrated: true,
    journalFinalized: true,
    writerRecoveryStatePath: input.pkg.writerRecoveryStatePath,
    finalizationContinuationApprovalSha256: null,
    finalizationOperationLeasePath: input.pkg.finalizationOperationLeasePath,
  }
  const gatewayService: JpOhlcvLaunchdServiceIdentity = {
    label: 'com.stockboard.friend-readonly-gateway',
    plistPath: input.pkg.gateway.productionPlistPath,
    definitionSha256: input.pkg.gateway.plistSha256,
    program: manifest.nodeExecutable,
    role: 'READ_SERVICE',
  }
  await ensureMigratedGatewayReady({ pkg: input.pkg, newService: gatewayService })
  const result = await restoreWritersWithReceipt({ ...input, state })
  console.log(JSON.stringify({ status: 'RECOVERED', transactionId: input.pkg.transactionId, ...result }))
}

async function main(): Promise<void> {
  const execute = process.argv.includes('--execute')
  const preflightOnly = process.argv.includes('--preflight-only')
  const resumeFinalization = process.argv.includes('--resume-finalization')
  const resumeWriters = process.argv.includes('--resume-writers')
  if (Number(execute) + Number(preflightOnly) + Number(resumeFinalization) + Number(resumeWriters) !== 1) {
    throw new Error('--execute_or_preflight_only_or_resume_finalization_or_resume_writers_required')
  }
  if (!preflightOnly) removeSignalHandlers = installJpOhlcvRepairSignalHandlers()
  const packagePath = path.resolve(value('--package'))
  const pkg = readJson<JpOhlcvRollbackFinalizationPackage>(packagePath)
  const expectedPackageSha256 = process.env.STOCKBOARD_JP_OHLCV_ROLLBACK_FINALIZATION_APPROVED
  if (!expectedPackageSha256 || stableSha256(pkg) !== expectedPackageSha256 || pkg.version !== 1) {
    throw new Error('rollback_finalization_exact_package_approval_required')
  }
  const integrationRoot = fs.realpathSync(pkg.integrationRoot)
  const head = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: integrationRoot, encoding: 'utf8' }).trim()
  const tree = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD^{tree}'], { cwd: integrationRoot, encoding: 'utf8' }).trim()
  const dirty = execFileSync('/usr/bin/git', ['status', '--porcelain'], {
    cwd: integrationRoot, encoding: 'utf8',
  }).trim()
  if (head !== pkg.integrationHead || tree !== pkg.integrationTreeId || dirty) {
    throw new Error('rollback_finalization_integration_identity_mismatch')
  }
  for (const file of pkg.sourceFiles) assertFile(file.path, file.sha256, 'rollback_finalization_source')
  assertFile(pkg.runner.executable, pkg.runner.executableSha256, 'rollback_finalization_runner_executable')
  assertFile(pkg.runner.bundlePath, pkg.runner.bundleSha256, 'rollback_finalization_runner_bundle')
  if (fs.realpathSync(process.execPath) !== fs.realpathSync(pkg.runner.executable)
    || fs.realpathSync(path.resolve(process.argv[1] ?? '')) !== fs.realpathSync(pkg.runner.bundlePath)) {
    throw new Error('rollback_finalization_runner_entry_identity_mismatch')
  }
  if (process.execArgv.length > 0 || process.env.NODE_OPTIONS?.trim()) {
    throw new Error('rollback_finalization_unsealed_node_options_forbidden')
  }
  assertFile(pkg.sourceEmergencyPackagePath, pkg.sourceEmergencyPackageFileSha256,
    'rollback_finalization_source_recovery_package')
  if (stableSha256(readJson(pkg.sourceEmergencyPackagePath)) !== pkg.sourceEmergencyPackageApprovalSha256) {
    throw new Error('rollback_finalization_source_recovery_approval_mismatch')
  }
  assertFile(pkg.approvalBundlePath, pkg.approvalBundleFileSha256, 'rollback_finalization_approval_bundle')
  assertFile(pkg.sourceRecoveryConfigurationPath, pkg.sourceRecoveryConfigurationFileSha256,
    'rollback_finalization_source_recovery_configuration')
  if (stableSha256(readJson(pkg.sourceRecoveryConfigurationPath))
      !== pkg.sourceRecoveryConfigurationSha256) {
    throw new Error('rollback_finalization_source_recovery_configuration_canonical_mismatch')
  }
  assertFile(pkg.configurationPath, pkg.configurationFileSha256, 'rollback_finalization_configuration')
  assertFile(pkg.finalizationApprovalPath, pkg.finalizationApprovalFileSha256,
    'rollback_finalization_approval_file')
  assertFile(pkg.finalizationPlanPath, pkg.finalizationPlanFileSha256,
    'rollback_finalization_plan_file')
  const bundle = readJson<ApprovalBundle>(pkg.approvalBundlePath)
  const config = readJson<JpOhlcvProductionExecutionConfiguration>(pkg.configurationPath)
  const finalization = readJson<JpOhlcvRollbackFinalizationApproval>(pkg.finalizationApprovalPath)
  const finalizationPlan = readJson<JpOhlcvRollbackFinalizationPlan>(pkg.finalizationPlanPath)
  if (bundle.version !== 1 || bundle.executionStatus !== 'HOLD_PENDING_EXPLICIT_APPROVAL'
    || repairApprovalSha256(bundle.approval) !== bundle.approvalSha256
    || stableSha256(config) !== pkg.configurationSha256
    || repairRollbackFinalizationApprovalSha256(finalization) !== pkg.finalizationApprovalSha256
    || stableSha256(finalizationPlan) !== pkg.finalizationPlanSha256
    || finalization.finalizationPlanSha256 !== pkg.finalizationPlanSha256
    || finalizationPlan.transactionId !== pkg.transactionId
    || finalizationPlan.integrationHead !== pkg.integrationHead
    || finalizationPlan.integrationTreeId !== pkg.integrationTreeId
    || finalizationPlan.runnerBundleSha256 !== pkg.runner.bundleSha256
    || finalizationPlan.sourceEmergencyPackageApprovalSha256
      !== pkg.sourceEmergencyPackageApprovalSha256) {
    throw new Error('rollback_finalization_nested_approval_mismatch')
  }
  assertJpOhlcvProductionExecutionConfiguration(config)
  if (path.resolve(pkg.finalizationOperationLeasePath) !== pkg.finalizationOperationLeasePath
    || path.resolve(pkg.storageFatalLatchPath) !== pkg.storageFatalLatchPath) {
    throw new Error('rollback_finalization_runtime_path_contract_invalid')
  }
  assertLiveStorageGuard(pkg, config)
  if (preflightOnly || execute) await assertExternalAccessBoundary(pkg)
  if (resumeWriters) {
    const operationLeaseOwner = acquireHashBoundOperationLease({
      leasePath: pkg.finalizationOperationLeasePath,
      scopeSha256: finalizationLeaseScope(pkg),
      readProcessIdentity,
    })
    executionProgress.finalizationOperationLeasePath = pkg.finalizationOperationLeasePath
    assertLiveStorageGuard(pkg, config)
    await resumeWriterRecovery({ pkg, config, packageApprovalSha256: expectedPackageSha256,
      plan: finalizationPlan, approval: finalization })
    releaseHashBoundOperationLease({
      leasePath: pkg.finalizationOperationLeasePath,
      owner: operationLeaseOwner,
    })
    return
  }
  const operationLeaseOwner: HashBoundOperationLeaseOwner | null = preflightOnly
    ? null
    : acquireHashBoundOperationLease({
        leasePath: pkg.finalizationOperationLeasePath,
        scopeSha256: finalizationLeaseScope(pkg),
        readProcessIdentity,
      })
  if (operationLeaseOwner) {
    executionProgress.finalizationOperationLeasePath = pkg.finalizationOperationLeasePath
    assertLiveStorageGuard(pkg, config)
  }
  let pendingFinalizationState: JpOhlcvWriterRecoveryState | null = null
  if (resumeFinalization) {
    pendingFinalizationState = readJson<JpOhlcvWriterRecoveryState>(pkg.writerRecoveryStatePath)
    const resumeApproval = process.env.STOCKBOARD_JP_OHLCV_FINALIZATION_RESUME_APPROVED
    if (!resumeApproval || resumeApproval !== stableSha256(pendingFinalizationState)
      || pendingFinalizationState.status !== 'PENDING_FINALIZATION'
      || pendingFinalizationState.transactionId !== pkg.transactionId
      || pendingFinalizationState.packageApprovalSha256 !== expectedPackageSha256
      || pendingFinalizationState.archivedJournalFileSha256 !== null) {
      throw new Error('rollback_finalization_exact_resume_approval_required')
    }
  } else if (fs.existsSync(pkg.writerRecoveryStatePath)) {
    throw new Error('rollback_finalization_unexpected_writer_recovery_state')
  }
  if (!resumeFinalization) {
    assertFile(pkg.activeJournalPath, pkg.activeJournalFileSha256, 'rollback_finalization_journal')
  } else if (!path.isAbsolute(pkg.activeJournalPath) || !fs.existsSync(pkg.activeJournalPath)
    || fs.lstatSync(pkg.activeJournalPath).isSymbolicLink()) {
    throw new Error('rollback_finalization_resume_journal_invalid')
  }
  assertFile(pkg.activeLockPath, pkg.activeLockFileSha256, 'rollback_finalization_lock')
  assertFile(pkg.restoreStatePath, pkg.restoreStateFileSha256, 'rollback_finalization_restore_state')
  assertFile(pkg.readServiceSnapshotPath, pkg.readServiceSnapshotFileSha256,
    'rollback_finalization_read_snapshot')
  const journal = readJson<Record<string, unknown>>(pkg.activeJournalPath)
  let continuationApproval: JpOhlcvRollbackFinalizationContinuationApproval | undefined
  let continuationApprovalSha256: string | undefined
  const journalMatchesInitial = stableSha256(journal) === pkg.activeJournalSha256
    && sha256File(pkg.activeJournalPath) === pkg.activeJournalFileSha256
  if (resumeFinalization && !journalMatchesInitial) {
    const stage = journal.stage
    if (![
      'ROLLBACK_READ_SERVICES_RESUMING',
      'ROLLBACK_READ_SERVICES_RESUMED',
      'ROLLBACK_VERIFIED',
      'ROLLED_BACK',
    ].includes(String(stage))) {
      throw new Error('rollback_finalization_resume_stage_invalid')
    }
    continuationApproval = {
      version: 1,
      action: 'CONTINUE_ROLLBACK_FINALIZATION',
      repairApprovalSha256: bundle.approvalSha256,
      finalizationApprovalSha256: pkg.finalizationApprovalSha256,
      transactionId: pkg.transactionId,
      journalSha256: stableSha256(journal),
      journalFileSha256: sha256File(pkg.activeJournalPath),
      lockFileSha256: sha256File(pkg.activeLockPath),
      writerRecoveryStateSha256: stableSha256(pendingFinalizationState),
      stage: stage as JpOhlcvRollbackFinalizationContinuationApproval['stage'],
    }
    continuationApprovalSha256 = repairRollbackFinalizationContinuationApprovalSha256(
      continuationApproval,
    )
    if (process.env.STOCKBOARD_JP_OHLCV_FINALIZATION_CONTINUATION_APPROVED
        !== continuationApprovalSha256) {
      throw new Error(`rollback_finalization_continuation_exact_approval_required:${continuationApprovalSha256}`)
    }
  }
  const restoreState = readJson<Record<string, unknown>>(pkg.restoreStatePath)
  const readSnapshot = readJson<{
    transactionId?: unknown
    configurationSha256?: unknown
    services?: Array<{
      label?: unknown
      plistPath?: unknown
      definitionSha256?: unknown
      program?: unknown
      loaded?: unknown
      disabled?: unknown
    }>
  }>(pkg.readServiceSnapshotPath)
  if ((!resumeFinalization && stableSha256(journal) !== pkg.activeJournalSha256)
    || stableSha256(restoreState) !== pkg.restoreStateSha256
    || (!resumeFinalization && journal.stage !== 'HOLD')
    || (!resumeFinalization
      && (journal.failure as { originalStage?: unknown } | undefined)?.originalStage
        !== 'ROLLBACK_READ_SERVICES_RESUMING')
    || restoreState.phase !== 'COMPLETED') {
    throw new Error('rollback_finalization_active_state_mismatch')
  }
  if (readSnapshot.transactionId !== pkg.transactionId
    || readSnapshot.configurationSha256 !== finalization.originalReadServiceConfigurationSha256
    || readSnapshot.services?.length !== config.readServices.length) {
    throw new Error('rollback_finalization_read_snapshot_contract_mismatch')
  }
  for (const expected of config.readServices) {
    const captured = readSnapshot.services.find((service) => service.label === expected.label)
    if (!captured || captured.plistPath !== expected.plistPath
      || captured.definitionSha256 !== expected.definitionSha256
      || captured.program !== expected.program
      || captured.loaded !== true || captured.disabled !== false) {
      throw new Error(`rollback_finalization_read_snapshot_service_mismatch:${expected.label}`)
    }
  }
  const lock = readJson<{
    pid?: unknown
    processGroupId?: unknown
    processIdentitySha256?: unknown
  }>(pkg.activeLockPath)
  const currentOwner = typeof lock.pid === 'number' ? readProcessIdentity(lock.pid) : null
  if (typeof lock.pid === 'number' && !currentOwner && !isProcessDefinitelyAbsent(lock.pid)) {
    throw new Error('rollback_finalization_original_runner_identity_unknown')
  }
  const observedOwnerState = currentOwner ? 'PID_REUSED_OR_IDENTITY_MISMATCH' : 'PID_ABSENT'
  if (typeof lock.pid !== 'number' || typeof lock.processGroupId !== 'number'
    || typeof lock.processIdentitySha256 !== 'string'
    || currentOwner?.identitySha256 === lock.processIdentitySha256
    || finalization.originalRunnerRecovery.observedState !== observedOwnerState) {
    throw new Error('rollback_finalization_original_runner_not_proven_stopped')
  }
  const source = generation(config.sourceGenerationPointer)
  const serving = generation(config.servingGenerationPointer)
  if (source.generation !== pkg.sourceGeneration
    || serving.generation !== pkg.servingGeneration
    || serving.sourceGeneration !== pkg.sourceGeneration) {
    throw new Error('rollback_finalization_generation_mismatch')
  }
  assertFile(pkg.gateway.bundleSourcePath, pkg.gateway.bundleSha256, 'rollback_finalization_gateway_bundle')
  assertFile(pkg.gateway.manifestSourcePath, pkg.gateway.manifestFileSha256,
    'rollback_finalization_gateway_manifest')
  assertFile(pkg.gateway.plistSourcePath, pkg.gateway.plistSha256, 'rollback_finalization_gateway_plist')
  const manifest = readJson<FriendReadonlyRuntimeManifest>(pkg.gateway.manifestSourcePath)
  assertFriendReadonlyRuntimeManifest(manifest)
  if (stableSha256(manifest) !== pkg.gateway.manifestSha256
    || manifest.runtimePath !== pkg.gateway.runtimeTargetPath
    || manifest.runtimeSha256 !== pkg.gateway.bundleSha256) {
    throw new Error('rollback_finalization_gateway_manifest_mismatch')
  }
  assertFinalizationContracts({ pkg, plan: finalizationPlan, approval: finalization, manifest })
  const configuredGateway = config.readServices.find(
    (entry) => entry.label === 'com.stockboard.friend-readonly-gateway',
  )
  if (!configuredGateway
    || configuredGateway.plistPath !== pkg.gateway.productionPlistPath
    || configuredGateway.definitionSha256 !== pkg.gateway.oldPlistSha256) {
    throw new Error('rollback_finalization_gateway_original_configuration_mismatch')
  }
  assertFile(manifest.nodeExecutable, manifest.nodeExecutableSha256,
    'rollback_finalization_gateway_node')
  if (plistValue(pkg.gateway.plistSourcePath, 'ProgramArguments.0') !== manifest.nodeExecutable
    || plistValue(pkg.gateway.plistSourcePath, 'ProgramArguments.1') !== manifest.runtimePath
    || plistValue(pkg.gateway.plistSourcePath, 'EnvironmentVariables.STOCKBOARD_FRIEND_GATEWAY_HOST')
      !== '127.0.0.1'
    || plistValue(pkg.gateway.plistSourcePath, 'EnvironmentVariables.STOCKBOARD_FRIEND_GATEWAY_PORT')
      !== '3136'
    || plistValue(pkg.gateway.plistSourcePath, 'EnvironmentVariables.STOCKBOARD_FRIEND_ORIGIN')
      !== manifest.origin) {
    throw new Error('rollback_finalization_gateway_plist_contract_mismatch')
  }
  const productionGatewaySha256 = sha256File(pkg.gateway.productionPlistPath)
  const gatewayAlreadyMigrated = productionGatewaySha256 === pkg.gateway.plistSha256
  if ((!resumeFinalization && productionGatewaySha256 !== pkg.gateway.oldPlistSha256)
    || (resumeFinalization
      && productionGatewaySha256 !== pkg.gateway.oldPlistSha256
      && !gatewayAlreadyMigrated)) {
    throw new Error('rollback_finalization_gateway_production_plist_mismatch')
  }
  assertFile(pkg.externalTunnel.plistPath, pkg.externalTunnel.plistSha256,
    'rollback_finalization_tunnel_plist')
  assertFile(pkg.externalTunnel.executablePath, pkg.externalTunnel.executableSha256,
    'rollback_finalization_tunnel_executable')
  const tunnelProcesses = execFileSync('/bin/ps', ['-axo', 'command='], { encoding: 'utf8' })
    .split('\n')
    .filter((command) => command.startsWith(`${pkg.externalTunnel.executablePath} tunnel run `))
  if (tunnelProcesses.length !== 1) throw new Error('rollback_finalization_tunnel_runtime_mismatch')
  const writerDriverBefore = createLaunchdWriterHoldDriver(config.writerServices.map(launchdIdentity))
  const expectedDisabledWriters = new Set<string>(JP_OHLCV_EXPECTED_DISABLED_WRITER_LABELS)
  for (const writer of config.writerServices) {
    const observed = await writerDriverBefore.observe(writer.label)
    if (observed.loaded || observed.instances !== 0
      || observed.disabled !== expectedDisabledWriters.has(writer.label)) {
      throw new Error(`rollback_finalization_writer_preflight_state_mismatch:${writer.label}`)
    }
  }
  const preflightReadServices = config.readServices.map((service) => (
    service.label === 'com.stockboard.friend-readonly-gateway' && gatewayAlreadyMigrated
      ? {
          ...service,
          definitionSha256: pkg.gateway.plistSha256,
          program: manifest.nodeExecutable,
        }
      : service
  ))
  const readDriverBefore = createLaunchdWriterHoldDriver(preflightReadServices.map(launchdIdentity))
  for (const readService of preflightReadServices) {
    const observed = await readDriverBefore.observe(readService.label)
    if (observed.disabled || observed.instances > 1) {
      throw new Error(`rollback_finalization_read_preflight_state_mismatch:${readService.label}`)
    }
  }
  const incidentConfig = liveStorageGuardConfig(pkg, config)
  if (hasStorageFatalLatch(incidentConfig)) throw new Error('rollback_finalization_failed_safe_latch_present')
  if (fs.existsSync(pkg.rolledBackArchivePath)
    || (!resumeFinalization && fs.existsSync(pkg.writerRecoveryStatePath))) {
    throw new Error('rollback_finalization_unexpected_continuation_artifact')
  }
  const restoredDbStat = fs.statSync(config.databaseRealpath)
  if (!restoredDbStat.isFile() || restoredDbStat.size !== pkg.restoredDatabaseSize
    || sha256File(config.databaseRealpath) !== pkg.restoredDatabaseSha256
    || pkg.restoredDatabaseSha256 !== finalization.backupSha256) {
    throw new Error('rollback_finalization_restored_database_identity_invalid')
  }
  if (preflightOnly) {
    console.log(JSON.stringify({
      status: 'PASS',
      productionMutationAuthorized: false,
      transactionId: pkg.transactionId,
      sourceFileCount: pkg.sourceFiles.length,
      sealedFileCount: pkg.sourceFiles.length + 12,
      mismatchCount: 0,
    }))
    return
  }
  assertJpOhlcvRepairExecutionActive()
  if (!operationLeaseOwner) throw new Error('rollback_finalization_operation_lease_missing')

  const web = config.readServices.find((entry) => entry.label === 'com.stockboard.web')
  const analog = config.readServices.find((entry) => entry.label === 'com.stockboard.analog-search')
  const webHealth = config.readServices.find((entry) => entry.label === 'com.stockboard.web-health')
  if (!web || !analog || !webHealth) throw new Error('rollback_finalization_read_service_inventory_invalid')
  const webReady = await stableReady({ service: web, healthUrl: config.healthUrls.web })
  const analogReady = await stableReady({ service: analog, healthUrl: config.healthUrls.analog })
  const webHealthDriver = createLaunchdWriterHoldDriver([launchdIdentity(webHealth)])
  const webHealthState = await webHealthDriver.observe(webHealth.label)
  if (!webHealthState.loaded || webHealthState.disabled || webHealthState.instances !== 1) {
    throw new Error('rollback_finalization_web_health_service_not_loaded')
  }
  assertJpOhlcvRepairExecutionActive()
  const newGatewayService: JpOhlcvLaunchdServiceIdentity = {
    label: 'com.stockboard.friend-readonly-gateway',
    plistPath: pkg.gateway.productionPlistPath,
    definitionSha256: pkg.gateway.plistSha256,
    program: manifest.nodeExecutable,
    role: 'READ_SERVICE',
  }
  let writerState: JpOhlcvWriterRecoveryState = pendingFinalizationState ?? {
    version: 1,
    transactionId: pkg.transactionId,
    packageApprovalSha256: expectedPackageSha256,
    archivedJournalPath: pkg.rolledBackArchivePath,
    archivedJournalFileSha256: null,
    gatewayPlistSha256: pkg.gateway.plistSha256,
    status: 'PENDING_FINALIZATION',
    restoredLabels: [],
    alreadyLoadedLabels: [],
    preservedUnloadedLabels: [...JP_OHLCV_EXPECTED_UNLOADED_WRITER_LABELS],
    startedAtMs: Date.now(),
    updatedAt: new Date().toISOString(),
  }
  if (!pendingFinalizationState) {
    writeNew(pkg.writerRecoveryStatePath, `${JSON.stringify(writerState, null, 2)}\n`, 0o600)
    fsyncDirectory(path.dirname(pkg.writerRecoveryStatePath))
  }
  executionProgress.writerRecoveryStatePath = pkg.writerRecoveryStatePath
  executionProgress.stage = 'MIGRATING_GATEWAY'
  let gatewayReady: StableServiceReadiness
  let finalized: Awaited<ReturnType<typeof runJpOhlcvProductionRepairRollbackFinalization>>
  try {
    gatewayReady = gatewayAlreadyMigrated
      ? await ensureMigratedGatewayReady({ pkg, newService: newGatewayService })
      : await migrateGateway({ pkg, oldService: configuredGateway, manifest })
    executionProgress.gatewayMigrated = true
    executionProgress.stage = 'VERIFYING_GATEWAY_POLICY'
    await assertGatewayPolicyOrStop(newGatewayService, gatewayReady.pid)
    const paths: JpOhlcvRepairPaths = {
      stateDirectory: bundle.approval.stateDirectory,
      journal: pkg.activeJournalPath,
      lock: pkg.activeLockPath,
    }
    executionProgress.stage = 'FINALIZING_ROLLBACK_JOURNAL'
    finalized = await runJpOhlcvProductionRepairRollbackFinalization({
      approval: bundle.approval,
      approvalSha256: bundle.approvalSha256,
      finalizationApproval: finalization,
      finalizationApprovalSha256: pkg.finalizationApprovalSha256,
      continuationApproval,
      continuationApprovalSha256,
      continuationWriterRecoveryStateSha256: stableSha256(writerState),
      paths,
      readServicesEvidence: { webReady, analogReady, gatewayReady, webHealth: webHealthState },
    })
    executionProgress.journalFinalized = true
  } catch (error) {
    const activeStage = fs.existsSync(pkg.activeJournalPath)
      ? (readJson<{ stage?: unknown }>(pkg.activeJournalPath).stage ?? null)
      : null
    if ([
      'ROLLBACK_READ_SERVICES_RESUMING',
      'ROLLBACK_READ_SERVICES_RESUMED',
      'ROLLBACK_VERIFIED',
      'ROLLED_BACK',
    ].includes(String(activeStage)) && fs.existsSync(pkg.activeLockPath)) {
      const currentJournal = readJson<Record<string, unknown>>(pkg.activeJournalPath)
      const candidate: JpOhlcvRollbackFinalizationContinuationApproval = {
        version: 1,
        action: 'CONTINUE_ROLLBACK_FINALIZATION',
        repairApprovalSha256: bundle.approvalSha256,
        finalizationApprovalSha256: pkg.finalizationApprovalSha256,
        transactionId: pkg.transactionId,
        journalSha256: stableSha256(currentJournal),
        journalFileSha256: sha256File(pkg.activeJournalPath),
        lockFileSha256: sha256File(pkg.activeLockPath),
        writerRecoveryStateSha256: stableSha256(writerState),
        stage: activeStage as JpOhlcvRollbackFinalizationContinuationApproval['stage'],
      }
      executionProgress.finalizationContinuationApprovalSha256
        = repairRollbackFinalizationContinuationApprovalSha256(candidate)
    }
    if (activeStage === 'ROLLED_BACK' || fs.existsSync(pkg.rolledBackArchivePath)) {
      executionProgress.journalFinalized = true
      throw error
    }
    try {
      await restoreOriginalGatewayDefinition({ pkg, newService: newGatewayService })
      executionProgress.gatewayMigrated = false
    } catch (compensationError) {
      throw new Error(
        `rollback_finalization_failed_and_gateway_compensation_failed:`
        + `${error instanceof Error ? error.message : String(error)}:`
        + `${compensationError instanceof Error ? compensationError.message : String(compensationError)}`,
      )
    }
    throw error
  }
  if (finalized.status !== 'ROLLED_BACK'
    || path.resolve(finalized.archivedJournal) !== pkg.rolledBackArchivePath
    || fs.existsSync(pkg.activeJournalPath) || fs.existsSync(pkg.activeLockPath)
    || !fs.existsSync(pkg.rolledBackArchivePath)) {
    throw new Error('rollback_finalization_terminal_state_missing')
  }
  writerState = {
    ...writerState!,
    archivedJournalFileSha256: sha256File(pkg.rolledBackArchivePath),
    status: 'IN_PROGRESS',
    updatedAt: new Date().toISOString(),
  }
  writeJsonAtomic(pkg.writerRecoveryStatePath, writerState)
  executionProgress = {
    stage: 'RESTORING_WRITERS',
    gatewayMigrated: true,
    journalFinalized: true,
    writerRecoveryStatePath: pkg.writerRecoveryStatePath,
    finalizationContinuationApprovalSha256: null,
    finalizationOperationLeasePath: pkg.finalizationOperationLeasePath,
  }
  const writerResult = await restoreWritersWithReceipt({
    pkg,
    config,
    packageApprovalSha256: expectedPackageSha256,
    state: writerState,
  })
  releaseHashBoundOperationLease({
    leasePath: pkg.finalizationOperationLeasePath,
    owner: operationLeaseOwner,
  })
  executionProgress.stage = 'RECOVERED'
  console.log(JSON.stringify({
    status: 'RECOVERED',
    transactionId: pkg.transactionId,
    archivedJournal: pkg.rolledBackArchivePath,
    readServices: { webReady, analogReady, gatewayReady, webHealth: webHealthState },
    ...writerResult,
  }))
}

main().catch((error) => {
  let writerRecoveryApprovalSha256: string | null = null
  if (executionProgress.writerRecoveryStatePath
    && fs.existsSync(executionProgress.writerRecoveryStatePath)) {
    try {
      writerRecoveryApprovalSha256 = stableSha256(readJson(executionProgress.writerRecoveryStatePath))
    } catch {
      writerRecoveryApprovalSha256 = null
    }
  }
  console.error(JSON.stringify({
    status: 'HOLD',
    error: error instanceof Error ? error.message : String(error),
    progress: executionProgress,
    writerRecoveryApprovalSha256,
    operatorAction: executionProgress.journalFinalized
      ? `Preserve the rolled-back archive, writer recovery state, restored database and current service definitions. Do not rerun restore or backfill. Resume only with the exact hash of the current writer recovery state and the sealed package.`
      : `Preserve the restored database, generations, active journal, lock and restore state. The original Gateway definition is restored but intentionally left unloaded when compensation succeeds because its old runtime is broken; external Gateway access remains unavailable. Do not rerun restore or backfill. Use the printed continuation hash with the sealed package, or obtain a new exact package approval if any sealed identity changed.`,
  }))
  process.exitCode = 1
}).finally(() => {
  removeSignalHandlers?.()
  removeSignalHandlers = null
})
