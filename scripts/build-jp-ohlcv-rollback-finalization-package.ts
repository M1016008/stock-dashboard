import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { stableSha256 } from '@/lib/jp-ohlcv-data-quality'
import { isProcessDefinitelyAbsent } from '@/lib/hash-bound-operation-lease'
import {
  repairApprovalSha256,
  repairRollbackFinalizationApprovalSha256,
  type JpOhlcvRepairApproval,
  type JpOhlcvRepairJournal,
  type JpOhlcvRollbackFinalizationApproval,
} from '@/lib/jp-ohlcv-production-repair'
import { readProcessIdentity } from '@/lib/jp-ohlcv-repair-process-supervisor'
import {
  assertJpOhlcvProductionExecutionConfiguration,
  sha256File,
  type JpOhlcvProductionExecutionConfiguration,
  type JpOhlcvProductionExecutionPackage,
  type JpOhlcvServiceSnapshot,
} from '@/lib/jp-ohlcv-executable-plan'
import {
  FRIEND_READONLY_GATEWAY_DEFAULT_PRODUCTION_RUNTIME_ROOT,
  buildFriendReadonlyGatewayRuntime,
} from '@/scripts/build-friend-readonly-gateway-runtime'
import { resealEmergencyRecoveryCommand } from '@/scripts/build-jp-ohlcv-emergency-recovery-package'
import type {
  JpOhlcvEmergencyRecoveryPackage,
} from '@/scripts/orchestrate-jp-ohlcv-emergency-recovery'
import type {
  JpOhlcvRollbackFinalizationPackage,
  JpOhlcvRollbackFinalizationPlan,
} from '@/scripts/orchestrate-jp-ohlcv-rollback-finalization'

type ApprovalBundle = {
  version: 1
  approval: JpOhlcvRepairApproval
  approvalSha256: string
  executionStatus: 'HOLD_PENDING_EXPLICIT_APPROVAL'
}

function value(flag: string): string {
  const index = process.argv.indexOf(flag)
  const result = index >= 0 ? process.argv[index + 1] : null
  if (!result || result.startsWith('--')) throw new Error(`${flag}_required`)
  if (!path.isAbsolute(result)) throw new Error(`${flag}_absolute_path_required`)
  return path.resolve(result)
}

function optional(flag: string): string | null {
  const index = process.argv.indexOf(flag)
  const result = index >= 0 ? process.argv[index + 1] : null
  if (!result || result.startsWith('--')) return null
  if (!path.isAbsolute(result)) throw new Error(`${flag}_absolute_path_required`)
  return path.resolve(result)
}

function readJson<T>(file: string): T {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`rollback_finalization_builder_file_invalid:${file}`)
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T
}

function writeNew(file: string, value: unknown): void {
  const descriptor = fs.openSync(file, 'wx', 0o600)
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`)
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
}

function writeNewBytes(file: string, value: Uint8Array, mode: number): void {
  const descriptor = fs.openSync(file, 'wx', mode)
  try {
    fs.writeFileSync(descriptor, value)
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
}

function argumentValue(args: string[], flag: string): string {
  const index = args.indexOf(flag)
  const result = index >= 0 ? args[index + 1] : null
  if (!result || !path.isAbsolute(result)) throw new Error(`rollback_finalization_builder_runner_${flag}_invalid`)
  return path.resolve(result)
}

async function main(): Promise<void> {
  const sourceEmergencyPackagePath = value('--source-emergency-package')
  const outputDirectory = value('--output-directory')
  const productionRuntimeRoot = optional('--production-runtime-root')
    ?? FRIEND_READONLY_GATEWAY_DEFAULT_PRODUCTION_RUNTIME_ROOT
  if (fs.existsSync(outputDirectory)) throw new Error('rollback_finalization_builder_output_exists')
  const integrationRoot = fs.realpathSync(process.cwd())
  const trackedStatus = execFileSync('/usr/bin/git', ['status', '--porcelain'], {
    cwd: integrationRoot,
    encoding: 'utf8',
  }).trim()
  if (trackedStatus) throw new Error('rollback_finalization_builder_clean_worktree_required')
  const integrationHead = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], {
    cwd: integrationRoot,
    encoding: 'utf8',
  }).trim()
  const integrationTreeId = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD^{tree}'], {
    cwd: integrationRoot,
    encoding: 'utf8',
  }).trim()
  const sourceEmergencyPackage = readJson<JpOhlcvEmergencyRecoveryPackage>(sourceEmergencyPackagePath)
  const sourceExecutionPackage = readJson<JpOhlcvProductionExecutionPackage>(
    sourceEmergencyPackage.sourcePackagePath,
  )
  const approvalBundlePath = sourceExecutionPackage.approvalBundlePath
  const approvalBundle = readJson<ApprovalBundle>(approvalBundlePath)
  const sourceRecoveryConfig = readJson<JpOhlcvProductionExecutionConfiguration>(
    sourceEmergencyPackage.configurationPath,
  )
  if (sha256File(sourceEmergencyPackage.configurationPath)
      !== sourceEmergencyPackage.configurationFileSha256) {
    throw new Error('rollback_finalization_builder_source_configuration_identity_mismatch')
  }
  let config = sourceRecoveryConfig
  if (repairApprovalSha256(approvalBundle.approval) !== approvalBundle.approvalSha256
    || approvalBundle.approvalSha256 !== sourceEmergencyPackage.repairApprovalSha256) {
    throw new Error('rollback_finalization_builder_repair_approval_mismatch')
  }
  const journal = readJson<JpOhlcvRepairJournal>(sourceEmergencyPackage.activeJournalPath)
  const lock = readJson<{
    transactionId?: unknown
    pid?: unknown
    processGroupId?: unknown
    processIdentitySha256?: unknown
    startedAt?: unknown
  }>(sourceEmergencyPackage.activeLockPath)
  const restoreStatePath = path.join(config.stateDirectory, `rollback-restore-${journal.transactionId}.json`)
  const restoreState = readJson<{ phase?: unknown; backupSha256?: unknown; transactionId?: unknown }>(restoreStatePath)
  const readSnapshot = readJson<JpOhlcvServiceSnapshot>(config.serviceSnapshotPath)
  if (journal.stage !== 'HOLD'
    || journal.failure?.originalStage !== 'ROLLBACK_READ_SERVICES_RESUMING'
    || journal.transactionId !== sourceEmergencyPackage.transactionId
    || restoreState.phase !== 'COMPLETED'
    || restoreState.transactionId !== journal.transactionId
    || restoreState.backupSha256 !== sourceEmergencyPackage.backupSha256
    || readSnapshot.transactionId !== journal.transactionId
    || lock.transactionId !== journal.transactionId
    || typeof lock.pid !== 'number'
    || typeof lock.processGroupId !== 'number'
    || typeof lock.processIdentitySha256 !== 'string') {
    throw new Error('rollback_finalization_builder_active_state_invalid')
  }
  const currentOwner = readProcessIdentity(lock.pid)
  if (!currentOwner && !isProcessDefinitelyAbsent(lock.pid)) {
    throw new Error('rollback_finalization_builder_original_runner_identity_unknown')
  }
  const observedState = currentOwner ? 'PID_REUSED_OR_IDENTITY_MISMATCH' : 'PID_ABSENT'
  if (currentOwner?.identitySha256 === lock.processIdentitySha256) {
    throw new Error('rollback_finalization_builder_original_runner_still_active')
  }
  const sourceGeneration = readJson<{ generation?: unknown }>(config.sourceGenerationPointer).generation
  const servingGeneration = readJson<{ generation?: unknown; sourceGeneration?: unknown }>(
    config.servingGenerationPointer,
  )
  if (sourceGeneration !== approvalBundle.approval.sourceGenerationBefore
    || servingGeneration.generation !== approvalBundle.approval.servingGenerationBefore
    || servingGeneration.sourceGeneration !== approvalBundle.approval.sourceGenerationBefore) {
    throw new Error('rollback_finalization_builder_generation_mismatch')
  }
  const gatewayService = config.readServices.find(
    (service) => service.label === 'com.stockboard.friend-readonly-gateway',
  )
  if (!gatewayService || sha256File(gatewayService.plistPath) !== gatewayService.definitionSha256) {
    throw new Error('rollback_finalization_builder_gateway_original_identity_mismatch')
  }
  const tunnelPlistPath = '/Library/LaunchDaemons/com.cloudflare.cloudflared.plist'
  const tunnelExecutable = execFileSync('/usr/bin/plutil', [
    '-extract', 'ProgramArguments.0', 'raw', '-o', '-', tunnelPlistPath,
  ], { encoding: 'utf8' }).trim()
  if (!path.isAbsolute(tunnelExecutable) || !fs.existsSync(tunnelExecutable)) {
    throw new Error('rollback_finalization_builder_tunnel_executable_invalid')
  }
  fs.mkdirSync(outputDirectory, { mode: 0o700 })
  const trackedSourceFiles = new Set(execFileSync('/usr/bin/git', ['ls-files', '-z'], {
    cwd: integrationRoot,
    encoding: 'utf8',
  }).split('\0').filter(Boolean))
  const finalizationConfigurationPath = path.join(
    outputDirectory,
    'rollback-finalization-configuration.json',
  )
  config = {
    ...sourceRecoveryConfig,
    integrationRoot,
    integrationCommit: integrationHead,
    integrationTreeId,
    nestedCommands: sourceRecoveryConfig.nestedCommands.map((command) => resealEmergencyRecoveryCommand(
      command,
      sourceRecoveryConfig.integrationRoot,
      integrationRoot,
      sourceEmergencyPackage.configurationPath,
      finalizationConfigurationPath,
      trackedSourceFiles,
    )),
  }
  assertJpOhlcvProductionExecutionConfiguration(config)
  writeNew(finalizationConfigurationPath, config)
  const gatewayDirectory = path.join(outputDirectory, 'friend-readonly-gateway')
  const gateway = await buildFriendReadonlyGatewayRuntime({
    outputDirectory: gatewayDirectory,
    productionRuntimeRoot,
    productionPlistPath: gatewayService.plistPath,
    nodeExecutable: '/usr/local/bin/node',
    logDirectory: path.join(os.homedir(), 'Library', 'Logs', 'StockBoard'),
  })
  const finalizationRuntimeResult = await build({
    entryPoints: [path.resolve('scripts/orchestrate-jp-ohlcv-rollback-finalization.ts')],
    absWorkingDir: integrationRoot,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    packages: 'bundle',
    sourcemap: false,
    minify: false,
    legalComments: 'none',
    charset: 'utf8',
    write: false,
    outfile: 'rollback-finalization-orchestrator.mjs',
    tsconfig: path.resolve('tsconfig.json'),
  })
  if (finalizationRuntimeResult.outputFiles.length !== 1) {
    throw new Error('rollback_finalization_builder_runtime_output_invalid')
  }
  const finalizationRuntimePath = path.join(outputDirectory, 'rollback-finalization-orchestrator.mjs')
  writeNewBytes(finalizationRuntimePath, finalizationRuntimeResult.outputFiles[0]!.contents, 0o500)
  const postBuildStatus = execFileSync('/usr/bin/git', ['status', '--porcelain'], {
    cwd: integrationRoot,
    encoding: 'utf8',
  }).trim()
  const postBuildHead = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], {
    cwd: integrationRoot,
    encoding: 'utf8',
  }).trim()
  const postBuildTree = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD^{tree}'], {
    cwd: integrationRoot,
    encoding: 'utf8',
  }).trim()
  if (postBuildStatus || postBuildHead !== integrationHead || postBuildTree !== integrationTreeId) {
    throw new Error('rollback_finalization_builder_source_changed_during_build')
  }
  const finalizationPlanPath = path.join(outputDirectory, 'rollback-finalization-plan.json')
  const finalizationPlan: JpOhlcvRollbackFinalizationPlan = {
    version: 1,
    action: 'FINALIZE_RESTORED_ROLLBACK',
    transactionId: journal.transactionId,
    integrationHead,
    integrationTreeId,
    sourceEmergencyPackageApprovalSha256: stableSha256(sourceEmergencyPackage),
    runnerBundleSha256: sha256File(finalizationRuntimePath),
    gateway: {
      oldPlistSha256: gatewayService.definitionSha256,
      newPlistSha256: gateway.plistSha256,
      runtimeSha256: gateway.bundleSha256,
      manifestSha256: gateway.manifestSha256,
      listen: 'http://127.0.0.1:3136',
      origin: 'http://127.0.0.1:3000',
    },
    orderedStages: [
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
    ],
    forbiddenStages: ['RESTORE_DATABASE', 'VERIFY_BACKUP', 'FORWARD_BACKFILL', 'CHANGE_GENERATION'],
  }
  writeNew(finalizationPlanPath, finalizationPlan)
  const finalizationPlanSha256 = stableSha256(finalizationPlan)
  const finalizationApprovalPath = path.join(outputDirectory, 'rollback-finalization-approval.json')
  const finalizationApproval: JpOhlcvRollbackFinalizationApproval = {
    version: 1,
    action: 'FINALIZE_RESTORED_ROLLBACK',
    repairApprovalSha256: approvalBundle.approvalSha256,
    transactionId: journal.transactionId,
    journalSha256: stableSha256(journal),
    journalFileSha256: sha256File(sourceEmergencyPackage.activeJournalPath),
    lockFileSha256: sha256File(sourceEmergencyPackage.activeLockPath),
    restoreStatePath,
    restoreStateSha256: stableSha256(restoreState),
    restoreStateFileSha256: sha256File(restoreStatePath),
    backupSha256: sourceEmergencyPackage.backupSha256,
    sourceGeneration,
    servingGeneration: servingGeneration.generation as string,
    expectedRestoredTargetRows: sourceEmergencyPackage.expectedRestoredTargetRows,
    preservedConflictsSha256: approvalBundle.approval.preservedConflictsSha256,
    readServiceSnapshotPath: config.serviceSnapshotPath,
    readServiceSnapshotFileSha256: sha256File(config.serviceSnapshotPath),
    originalReadServiceConfigurationSha256: readSnapshot.configurationSha256,
    finalizationPlanSha256,
    gatewayMigration: {
      label: 'com.stockboard.friend-readonly-gateway',
      plistPath: gatewayService.plistPath,
      oldPlistSha256: gatewayService.definitionSha256,
      newPlistSha256: gateway.plistSha256,
      runtimeSourcePath: gateway.bundlePath,
      runtimeTargetPath: gateway.runtimeTargetPath,
      runtimeSha256: gateway.bundleSha256,
      manifestPath: gateway.manifestPath,
      manifestSha256: gateway.manifestSha256,
      nodeExecutable: fs.realpathSync('/usr/local/bin/node'),
      nodeExecutableSha256: sha256File(fs.realpathSync('/usr/local/bin/node')),
      listen: 'http://127.0.0.1:3136',
      origin: 'http://127.0.0.1:3000',
    },
    originalRunnerRecovery: {
      pid: lock.pid,
      processGroupId: lock.processGroupId,
      processIdentitySha256: lock.processIdentitySha256,
      observedState,
      confirmedStoppedAt: new Date().toISOString(),
      reason: 'The original Production repair runner is stopped; rollback finalization is separately hash-bound.',
    },
  }
  writeNew(finalizationApprovalPath, finalizationApproval)
  const finalizationApprovalSha256 = repairRollbackFinalizationApprovalSha256(finalizationApproval)
  const sourceFiles = [
    'lib/friend-readonly-gateway.ts',
    'lib/friend-readonly-policy.ts',
    'lib/friend-readonly-runtime.ts',
    'lib/hash-bound-operation-lease.ts',
    'lib/jp-ohlcv-maintenance-orchestrator.ts',
    'lib/jp-ohlcv-production-repair.ts',
    'lib/jp-ohlcv-repair-runner.ts',
    'lib/service-readiness.ts',
    'lib/storage/external-storage-guard.ts',
    'lib/storage/launchd-writer-hold-driver.ts',
    'scripts/build-friend-readonly-gateway-runtime.ts',
    'scripts/build-jp-ohlcv-emergency-recovery-package.ts',
    'scripts/build-jp-ohlcv-rollback-finalization-package.ts',
    'scripts/orchestrate-jp-ohlcv-rollback-finalization.ts',
    'scripts/run-friend-readonly-gateway.ts',
  ].map((file) => {
    const resolved = path.resolve(file)
    return { path: resolved, sha256: sha256File(resolved) }
  })
  const packagePath = path.join(outputDirectory, 'rollback-finalization-package.json')
  const pkg: JpOhlcvRollbackFinalizationPackage = {
    version: 1,
    transactionId: journal.transactionId,
    preparedAt: new Date().toISOString(),
    integrationRoot,
    integrationHead,
    integrationTreeId,
    sourceEmergencyPackagePath,
    sourceEmergencyPackageFileSha256: sha256File(sourceEmergencyPackagePath),
    sourceEmergencyPackageApprovalSha256: stableSha256(sourceEmergencyPackage),
    approvalBundlePath,
    approvalBundleFileSha256: sha256File(approvalBundlePath),
    sourceRecoveryConfigurationPath: sourceEmergencyPackage.configurationPath,
    sourceRecoveryConfigurationFileSha256: sha256File(sourceEmergencyPackage.configurationPath),
    sourceRecoveryConfigurationSha256: stableSha256(sourceRecoveryConfig),
    configurationPath: finalizationConfigurationPath,
    configurationFileSha256: sha256File(finalizationConfigurationPath),
    configurationSha256: stableSha256(config),
    finalizationApprovalPath,
    finalizationApprovalFileSha256: sha256File(finalizationApprovalPath),
    finalizationApprovalSha256,
    finalizationPlanPath,
    finalizationPlanFileSha256: sha256File(finalizationPlanPath),
    finalizationPlanSha256,
    activeJournalPath: sourceEmergencyPackage.activeJournalPath,
    activeJournalSha256: stableSha256(journal),
    activeJournalFileSha256: sha256File(sourceEmergencyPackage.activeJournalPath),
    activeLockPath: sourceEmergencyPackage.activeLockPath,
    activeLockFileSha256: sha256File(sourceEmergencyPackage.activeLockPath),
    restoreStatePath,
    restoreStateSha256: stableSha256(restoreState),
    restoreStateFileSha256: sha256File(restoreStatePath),
    readServiceSnapshotPath: config.serviceSnapshotPath,
    readServiceSnapshotFileSha256: sha256File(config.serviceSnapshotPath),
    rolledBackArchivePath: `${sourceEmergencyPackage.activeJournalPath}.rolled-back-${journal.transactionId}`,
    writerRecoveryStatePath: path.join(
      config.stateDirectory,
      `rollback-writer-recovery-${journal.transactionId}-${crypto.randomUUID()}.json`,
    ),
    finalizationOperationLeasePath: path.join(
      config.stateDirectory,
      `rollback-finalization-${journal.transactionId}.lease`,
    ),
    freshnessReportPath: path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'StockBoard',
      'data-freshness-latest.json',
    ),
    storageFatalLatchPath: path.join(
      process.env.STOCK_DATA_INCIDENT_DIR?.trim()
        || path.join(os.homedir(), 'Library', 'Application Support', 'StockBoard', 'storage-incidents'),
      'FAILED_SAFE',
    ),
    restoredDatabaseSha256: sourceEmergencyPackage.backupSha256,
    restoredDatabaseSize: fs.statSync(config.databaseRealpath).size,
    sourceGeneration,
    servingGeneration: servingGeneration.generation as string,
    runner: {
      executable: fs.realpathSync('/usr/local/bin/node'),
      executableSha256: sha256File(fs.realpathSync('/usr/local/bin/node')),
      bundlePath: finalizationRuntimePath,
      bundleSha256: sha256File(finalizationRuntimePath),
    },
    gateway: {
      bundleSourcePath: gateway.bundlePath,
      bundleSha256: gateway.bundleSha256,
      runtimeTargetPath: gateway.runtimeTargetPath,
      manifestSourcePath: gateway.manifestPath,
      manifestFileSha256: sha256File(gateway.manifestPath),
      manifestSha256: gateway.manifestSha256,
      plistSourcePath: gateway.plistPath,
      plistSha256: gateway.plistSha256,
      productionPlistPath: gatewayService.plistPath,
      oldPlistSha256: gatewayService.definitionSha256,
      oldPlistArchivePath: path.join(
        productionRuntimeRoot,
        'recovery-evidence',
        journal.transactionId,
        path.basename(gatewayService.plistPath),
      ),
    },
    externalTunnel: {
      plistPath: tunnelPlistPath,
      plistSha256: sha256File(tunnelPlistPath),
      executablePath: fs.realpathSync(tunnelExecutable),
      executableSha256: sha256File(fs.realpathSync(tunnelExecutable)),
    },
    sourceFiles,
  }
  writeNew(packagePath, pkg)
  const packageApprovalSha256 = stableSha256(pkg)
  const preflight = execFileSync(pkg.runner.executable, [
    pkg.runner.bundlePath,
    '--preflight-only',
    '--package', packagePath,
  ], {
    cwd: integrationRoot,
    encoding: 'utf8',
    timeout: 30 * 60_000,
    env: {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: process.env.HOME,
      USER: process.env.USER,
      LOGNAME: process.env.LOGNAME,
      TMPDIR: process.env.TMPDIR,
      LANG: process.env.LANG,
      LC_ALL: process.env.LC_ALL,
      TZ: process.env.TZ,
      NODE_ENV: 'production',
      STOCKBOARD_JP_OHLCV_ROLLBACK_FINALIZATION_APPROVED: packageApprovalSha256,
    },
  }).trim()
  const preflightResult = JSON.parse(preflight.split('\n').filter(Boolean).at(-1) ?? '{}') as {
    status?: unknown
    mismatchCount?: unknown
  }
  if (preflightResult.status !== 'PASS' || preflightResult.mismatchCount !== 0) {
    throw new Error('rollback_finalization_builder_preflight_failed')
  }
  console.log(JSON.stringify({
    status: 'PASS',
    productionMutationAuthorized: false,
    transactionId: pkg.transactionId,
    integrationHead,
    packagePath,
    packageApprovalSha256,
    packageFileSha256: sha256File(packagePath),
    finalizationApprovalPath,
    finalizationApprovalSha256,
    finalizationApprovalFileSha256: sha256File(finalizationApprovalPath),
    finalizationPlanPath,
    finalizationPlanSha256,
    finalizationPlanFileSha256: sha256File(finalizationPlanPath),
    gatewayRuntimeSha256: gateway.bundleSha256,
    gatewayManifestSha256: gateway.manifestSha256,
    gatewayPlistSha256: gateway.plistSha256,
    preflight: preflightResult,
  }))
}

const invokedPath = process.argv[1] && fs.existsSync(process.argv[1])
  ? pathToFileURL(fs.realpathSync(process.argv[1])).href
  : null
if (invokedPath === import.meta.url) void main()
