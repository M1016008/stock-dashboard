import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import {
  assertJpOhlcvProductionExecutionConfiguration,
  assertJpOhlcvStorageIdentityEnvironment,
  isHealthyJpOhlcvRepairResponseBody,
  sha256File,
  type JpOhlcvProductionExecutionConfiguration,
} from '@/lib/jp-ohlcv-executable-plan'
import { stableSha256 } from '@/lib/jp-ohlcv-data-quality'
import {
  JP_OHLCV_EXPECTED_DISABLED_WRITER_LABELS,
  JP_OHLCV_EXPECTED_LOADED_WRITER_LABELS,
  JP_OHLCV_EXPECTED_UNLOADED_WRITER_LABELS,
  restoreJpOhlcvMaintenanceWriters,
} from '@/lib/jp-ohlcv-maintenance-orchestrator'
import { repairRollbackApprovalSha256, type JpOhlcvRepairRollbackApproval } from '@/lib/jp-ohlcv-production-repair'
import { isProcessGroupAlive, terminateAndWaitForProcessGroup } from '@/lib/jp-ohlcv-repair-process-supervisor'
import { createLaunchdWriterHoldDriver } from '@/lib/storage/launchd-writer-hold-driver'

type SealedFile = { path: string; sha256: string }

export type JpOhlcvEmergencyRecoveryPackage = {
  version: 1
  transactionId: string
  preparedAt: string
  integrationRoot: string
  integrationHead: string
  integrationTreeId: string
  configurationPath: string
  configurationFileSha256: string
  rollbackApprovalPath: string
  rollbackApprovalSha256: string
  repairApprovalSha256: string
  recoveryExecutionPlanSha256: string
  expectedRestoredTargetRows: number
  backupRuntimeSnapshotPath: string
  backupRuntimeSnapshotSha256: string
  backupRuntimeSnapshotFileSha256: string
  activeJournalPath: string
  activeJournalCanonicalSha256: string
  activeJournalFileSha256: string
  activeLockPath: string
  activeLockFileSha256: string
  backupRealpath: string
  backupSha256: string
  sourceGenerationCurrent: string
  sourceGenerationTarget: string
  servingGenerationCurrent: string
  servingGenerationTarget: string
  runner: {
    executable: string
    executableSha256: string
    args: string[]
    workingDirectory: string
    timeoutMs: number
    environment: Record<string, string>
    sealedFiles: SealedFile[]
  }
  orchestratorScriptPath: string
  orchestratorScriptSha256: string
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
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`repair_emergency_file_identity_invalid:${file}`)
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T
}

function assertSealedFile(file: SealedFile): void {
  if (!path.isAbsolute(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256)
    || fs.realpathSync(file.path) !== file.path || sha256File(file.path) !== file.sha256) {
    throw new Error(`repair_emergency_sealed_file_mismatch:${file.path}`)
  }
}

function readGeneration(file: string): { generation: string; sourceGeneration?: string } {
  const value = readJson<{ generation?: unknown; sourceGeneration?: unknown }>(file)
  if (typeof value.generation !== 'string'
    || (value.sourceGeneration !== undefined && typeof value.sourceGeneration !== 'string')) {
    throw new Error(`repair_emergency_generation_evidence_invalid:${file}`)
  }
  return { generation: value.generation, sourceGeneration: value.sourceGeneration as string | undefined }
}

async function assertHealth(url: string, name: string): Promise<void> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000), cache: 'no-store' })
  const body = await response.text()
  if (!response.ok || !isHealthyJpOhlcvRepairResponseBody(body)) {
    throw new Error(`repair_emergency_${name}_health_failed`)
  }
}

async function runRollback(
  pkg: JpOhlcvEmergencyRecoveryPackage,
): Promise<{ status: 'ROLLED_BACK'; archivedJournal: string }> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(pkg.runner.executable, pkg.runner.args, {
      cwd: pkg.runner.workingDirectory,
      env: {
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        HOME: process.env.HOME,
        USER: process.env.USER,
        LOGNAME: process.env.LOGNAME,
        TMPDIR: process.env.TMPDIR,
        LANG: process.env.LANG,
        LC_ALL: process.env.LC_ALL,
        TZ: process.env.TZ,
        ...pkg.runner.environment,
        NODE_ENV: 'production',
      },
      detached: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    let stderr = Buffer.alloc(0)
    let timedOut = false
    let interruptedBy: NodeJS.Signals | null = null
    const interrupt = (signal: NodeJS.Signals) => {
      interruptedBy = signal
      if (child.pid) void terminateAndWaitForProcessGroup(child.pid).catch(() => undefined)
    }
    const onSigterm = () => interrupt('SIGTERM')
    const onSigint = () => interrupt('SIGINT')
    process.once('SIGTERM', onSigterm)
    process.once('SIGINT', onSigint)
    const timer = setTimeout(() => {
      timedOut = true
      if (child.pid) void terminateAndWaitForProcessGroup(child.pid).catch(() => undefined)
    }, pkg.runner.timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = Buffer.concat([stderr, chunk])
      if (stderr.length > 64 * 1024) stderr = stderr.subarray(stderr.length - 64 * 1024)
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      process.off('SIGTERM', onSigterm)
      process.off('SIGINT', onSigint)
      reject(error)
    })
    child.once('close', async (code, signal) => {
      clearTimeout(timer)
      process.off('SIGTERM', onSigterm)
      process.off('SIGINT', onSigint)
      try {
        if (child.pid && isProcessGroupAlive(child.pid)) {
          await terminateAndWaitForProcessGroup(child.pid)
        }
      } catch (error) {
        reject(error)
        return
      }
      if (timedOut) {
        reject(new Error('repair_emergency_rollback_timeout'))
        return
      }
      if (interruptedBy) {
        reject(new Error(`repair_emergency_interrupted:${interruptedBy}`))
        return
      }
      if (code !== 0 || signal) {
        reject(new Error(`repair_emergency_rollback_failed:exit_${code}:signal_${signal}:${stderr.toString('utf8')}`))
        return
      }
      try {
        const line = Buffer.concat(stdout).toString('utf8').split('\n').map((entry) => entry.trim()).filter(Boolean).at(-1)
        const result = JSON.parse(line ?? '{}') as { status?: unknown; archivedJournal?: unknown }
        if (result.status !== 'ROLLED_BACK' || typeof result.archivedJournal !== 'string') {
          throw new Error('repair_emergency_rollback_result_invalid')
        }
        resolve(result as { status: 'ROLLED_BACK'; archivedJournal: string })
      } catch (error) {
        reject(error)
      }
    })
  })
}

async function main(): Promise<void> {
  if (!process.argv.includes('--execute')) throw new Error('--execute_required')
  const packagePath = path.resolve(value('--package'))
  if (!path.isAbsolute(packagePath)) throw new Error('--package_absolute_path_required')
  const pkg = readJson<JpOhlcvEmergencyRecoveryPackage>(packagePath)
  const expectedPackageSha256 = process.env.STOCKBOARD_JP_OHLCV_EMERGENCY_RECOVERY_APPROVED
  if (!expectedPackageSha256 || stableSha256(pkg) !== expectedPackageSha256) {
    throw new Error('repair_emergency_exact_package_approval_required')
  }
  if (pkg.version !== 1 || !/^[a-f0-9]{64}$/.test(pkg.backupSha256)
    || !Number.isSafeInteger(pkg.expectedRestoredTargetRows) || pkg.expectedRestoredTargetRows <= 0) {
    throw new Error('repair_emergency_package_invalid')
  }
  const integrationRoot = fs.realpathSync(pkg.integrationRoot)
  const integrationHead = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], {
    cwd: integrationRoot,
    encoding: 'utf8',
  }).trim()
  const integrationTreeId = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD^{tree}'], {
    cwd: integrationRoot,
    encoding: 'utf8',
  }).trim()
  const trackedStatus = execFileSync('/usr/bin/git', ['status', '--porcelain', '--untracked-files=no'], {
    cwd: integrationRoot,
    encoding: 'utf8',
  }).trim()
  if (integrationHead !== pkg.integrationHead || integrationTreeId !== pkg.integrationTreeId || trackedStatus) {
    throw new Error('repair_emergency_integration_identity_mismatch')
  }
  if (sha256File(pkg.orchestratorScriptPath) !== pkg.orchestratorScriptSha256) {
    throw new Error('repair_emergency_orchestrator_identity_mismatch')
  }
  for (const sealed of [...pkg.runner.sealedFiles, ...pkg.sourceFiles]) assertSealedFile(sealed)
  if (sha256File(pkg.runner.executable) !== pkg.runner.executableSha256) {
    throw new Error('repair_emergency_runner_executable_mismatch')
  }
  const config = readJson<JpOhlcvProductionExecutionConfiguration>(pkg.configurationPath)
  assertJpOhlcvProductionExecutionConfiguration(config)
  assertJpOhlcvStorageIdentityEnvironment(config, pkg.runner.environment)
  if (sha256File(pkg.configurationPath) !== pkg.configurationFileSha256
    || config.stateDirectory !== path.dirname(pkg.activeJournalPath)) {
    throw new Error('repair_emergency_configuration_identity_mismatch')
  }
  const rollbackApproval = readJson<JpOhlcvRepairRollbackApproval>(pkg.rollbackApprovalPath)
  const planFlag = '--execution-plan'
  const configFlag = '--execution-configuration'
  const approvalFlag = '--rollback-approval'
  const approvalHashFlag = '--rollback-approval-sha256'
  const argumentValue = (flag: string): string | null => {
    const index = pkg.runner.args.indexOf(flag)
    return index >= 0 ? pkg.runner.args[index + 1] ?? null : null
  }
  const recoveryPlanPath = argumentValue(planFlag)
  if (!recoveryPlanPath || stableSha256(readJson(recoveryPlanPath)) !== pkg.recoveryExecutionPlanSha256
    || argumentValue(configFlag) !== pkg.configurationPath
    || argumentValue(approvalFlag) !== pkg.rollbackApprovalPath
    || argumentValue(approvalHashFlag) !== pkg.rollbackApprovalSha256) {
    throw new Error('repair_emergency_runner_contract_mismatch')
  }
  if (repairRollbackApprovalSha256(rollbackApproval) !== pkg.rollbackApprovalSha256
    || rollbackApproval.version !== 2
    || rollbackApproval.transactionId !== pkg.transactionId
    || rollbackApproval.repairApprovalSha256 !== pkg.repairApprovalSha256
    || rollbackApproval.backupRealpath !== pkg.backupRealpath
    || rollbackApproval.backupSha256 !== pkg.backupSha256
    || rollbackApproval.emergencyRecovery?.recoveryExecutionPlanSha256 !== pkg.recoveryExecutionPlanSha256
    || rollbackApproval.emergencyRecovery.expectedRestoredTargetRows !== pkg.expectedRestoredTargetRows
    || rollbackApproval.emergencyRecovery.backupRuntimeSnapshotSha256 !== pkg.backupRuntimeSnapshotSha256
    || rollbackApproval.emergencyRecovery.backupRuntimeSnapshotFileSha256
      !== pkg.backupRuntimeSnapshotFileSha256) {
    throw new Error('repair_emergency_rollback_approval_mismatch')
  }
  if (config.repairScope.existingRows !== pkg.expectedRestoredTargetRows
    || rollbackApproval.journalSha256 !== pkg.activeJournalCanonicalSha256) {
    throw new Error('repair_emergency_pre_restore_contract_mismatch')
  }
  const backupRuntimeSnapshotEvidence = readJson<{
    transactionId?: unknown
    snapshot?: {
      snapshotSha256?: unknown
      officialRows?: unknown
      runtimeScope?: { missingRows?: unknown[] }
    }
  }>(pkg.backupRuntimeSnapshotPath)
  const derivedRestoredTargetRows = Number(backupRuntimeSnapshotEvidence.snapshot?.officialRows)
    - (backupRuntimeSnapshotEvidence.snapshot?.runtimeScope?.missingRows?.length ?? Number.NaN)
  if (sha256File(pkg.backupRuntimeSnapshotPath) !== pkg.backupRuntimeSnapshotFileSha256
    || backupRuntimeSnapshotEvidence.transactionId !== pkg.transactionId
    || backupRuntimeSnapshotEvidence.snapshot?.snapshotSha256 !== pkg.backupRuntimeSnapshotSha256
    || derivedRestoredTargetRows !== pkg.expectedRestoredTargetRows) {
    throw new Error('repair_emergency_backup_runtime_snapshot_mismatch')
  }

  const archivePath = `${pkg.activeJournalPath}.rolled-back-${pkg.transactionId}`
  let archivedJournal = archivePath
  if (fs.existsSync(pkg.activeJournalPath)) {
    const activeJournal = readJson<Record<string, unknown>>(pkg.activeJournalPath)
    if (stableSha256(activeJournal) !== pkg.activeJournalCanonicalSha256
      || sha256File(pkg.activeJournalPath) !== pkg.activeJournalFileSha256
      || sha256File(pkg.activeLockPath) !== pkg.activeLockFileSha256) {
      throw new Error(
        `repair_emergency_active_state_changed_new_hash_bound_approval_required:`
        + `stage_${String(activeJournal.stage ?? 'unknown')}`,
      )
    }
    const source = readGeneration(config.sourceGenerationPointer)
    const serving = readGeneration(config.servingGenerationPointer)
    if (source.generation !== pkg.sourceGenerationCurrent
      || serving.generation !== pkg.servingGenerationCurrent
      || serving.sourceGeneration !== pkg.sourceGenerationTarget) {
      throw new Error('repair_emergency_pre_rollback_generation_mismatch')
    }
    const rollbackResult = await runRollback(pkg)
    archivedJournal = rollbackResult.archivedJournal
  }

  const assertRecoverySafe = async () => {
    if (fs.existsSync(pkg.activeJournalPath) || fs.existsSync(pkg.activeLockPath)
      || !fs.existsSync(archivePath) || path.resolve(archivedJournal) !== path.resolve(archivePath)) {
      throw new Error('repair_emergency_rollback_terminal_state_missing')
    }
    const journal = readJson<{ stage?: unknown; transactionId?: unknown; approvalSha256?: unknown }>(archivePath)
    if (journal.stage !== 'ROLLED_BACK' || journal.transactionId !== pkg.transactionId
      || journal.approvalSha256 !== pkg.repairApprovalSha256) {
      throw new Error('repair_emergency_rollback_archive_invalid')
    }
    const source = readGeneration(config.sourceGenerationPointer)
    const serving = readGeneration(config.servingGenerationPointer)
    if (source.generation !== pkg.sourceGenerationTarget
      || serving.generation !== pkg.servingGenerationTarget
      || serving.sourceGeneration !== pkg.sourceGenerationTarget) {
      throw new Error('repair_emergency_restored_generation_mismatch')
    }
    await assertHealth(config.healthUrls.web, 'web')
    await assertHealth(config.healthUrls.analog, 'analog')
    const readDriver = createLaunchdWriterHoldDriver(config.readServices.map((service) => ({
      label: service.label,
      plistPath: service.plistPath,
      definitionSha256: service.definitionSha256,
      program: service.program,
    })))
    for (const service of config.readServices) {
      const observed = await readDriver.observe(service.label)
      if (!observed.loaded || observed.instances !== 1 || observed.disabled) {
        throw new Error(`repair_emergency_read_service_not_restored:${service.label}`)
      }
    }
  }

  await assertRecoverySafe()
  const writerDriver = createLaunchdWriterHoldDriver(config.writerServices.map((service) => ({
    label: service.label,
    plistPath: service.plistPath,
    definitionSha256: service.definitionSha256,
    program: service.program,
  })))
  const writerRecovery = await restoreJpOhlcvMaintenanceWriters({
    config,
    driver: writerDriver,
    assertRecoverySafe,
  })
  await assertRecoverySafe()
  if (writerRecovery.restoredLabels.length + writerRecovery.alreadyLoadedLabels.length
      !== JP_OHLCV_EXPECTED_LOADED_WRITER_LABELS.length
    || writerRecovery.preservedUnloadedLabels.length !== JP_OHLCV_EXPECTED_UNLOADED_WRITER_LABELS.length
    || JP_OHLCV_EXPECTED_DISABLED_WRITER_LABELS.some(
      (label) => !writerRecovery.preservedUnloadedLabels.includes(label),
    )) {
    throw new Error('repair_emergency_writer_recovery_evidence_mismatch')
  }
  console.log(JSON.stringify({
    status: 'RECOVERED',
    transactionId: pkg.transactionId,
    archivedJournal: archivePath,
    sourceGeneration: pkg.sourceGenerationTarget,
    servingGeneration: pkg.servingGenerationTarget,
    writerRecovery,
  }))
}

main().catch((error) => {
  console.error(JSON.stringify({
    status: 'HOLD',
    error: error instanceof Error ? error.message : String(error),
    operatorAction: 'Keep every writer and read service in its observed state. Preserve the journal, lock, backup and generation pointers. Do not retry or restore without a new exact hash-bound approval when state identity changed.',
  }))
  process.exitCode = 1
})
