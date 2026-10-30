import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  executionPackageSha256,
  jpOhlcvStorageIdentityEnvironment,
  sha256File,
  type JpOhlcvProductionExecutionConfiguration,
  type JpOhlcvProductionExecutionPackage,
} from '@/lib/jp-ohlcv-executable-plan'
import type { JpOhlcvRepairExecutionPlan, JpOhlcvRepairStageCommand } from '@/lib/jp-ohlcv-command-adapter'
import { stableSha256 } from '@/lib/jp-ohlcv-data-quality'
import {
  repairRollbackApprovalSha256,
  type JpOhlcvRepairApproval,
  type JpOhlcvRepairRollbackApproval,
} from '@/lib/jp-ohlcv-production-repair'
import type { JpOhlcvEmergencyRecoveryPackage } from '@/scripts/orchestrate-jp-ohlcv-emergency-recovery'

type ApprovalBundle = { approval: JpOhlcvRepairApproval; approvalSha256: string }

function value(flag: string): string {
  const index = process.argv.indexOf(flag)
  const result = index >= 0 ? process.argv[index + 1] : null
  if (!result || result.startsWith('--')) throw new Error(`${flag}_required`)
  return result
}

function absolute(flag: string): string {
  const result = path.resolve(value(flag))
  if (!path.isAbsolute(result)) throw new Error(`${flag}_absolute_path_required`)
  return result
}

function readJson<T>(file: string): T {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`repair_emergency_builder_file_invalid:${file}`)
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T
}

function writeNew(file: string, value: unknown): void {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
}

function replacePath(args: string[], from: string, to: string): string[] {
  return args.map((arg) => arg === from ? to : arg)
}

function replaceConfigurationInCommand(
  command: JpOhlcvRepairStageCommand,
  originalConfigurationPath: string,
  recoveryConfigurationPath: string,
  recoveryConfigurationSha256: string,
): JpOhlcvRepairStageCommand {
  return {
    ...command,
    args: replacePath(command.args, originalConfigurationPath, recoveryConfigurationPath),
    sealedFiles: command.sealedFiles.map((file) => file.path === originalConfigurationPath
      ? { ...file, path: recoveryConfigurationPath, sha256: recoveryConfigurationSha256 }
      : file),
  }
}

function main(): void {
  const sourcePackagePath = absolute('--source-package')
  const sourcePackageApprovalSha256 = value('--source-package-approval-sha256')
  const pendingRollbackApprovalPath = absolute('--pending-rollback-approval')
  const outputDirectory = absolute('--output-directory')
  const expectedRestoredTargetRows = Number(value('--expected-restored-target-rows'))
  if (!Number.isSafeInteger(expectedRestoredTargetRows) || expectedRestoredTargetRows <= 0) {
    throw new Error('--expected-restored-target-rows_positive_integer_required')
  }
  fs.mkdirSync(outputDirectory, { recursive: false, mode: 0o700 })

  const sourcePackage = readJson<JpOhlcvProductionExecutionPackage>(sourcePackagePath)
  if (sourcePackage.version !== 1
    || executionPackageSha256(sourcePackage) !== sourcePackageApprovalSha256) {
    throw new Error('repair_emergency_builder_source_package_identity_mismatch')
  }
  const originalConfigurationPath = sourcePackage.configurationPath
  const originalConfig = readJson<JpOhlcvProductionExecutionConfiguration>(originalConfigurationPath)
  const originalPlan = readJson<JpOhlcvRepairExecutionPlan>(sourcePackage.executionPlanPath)
  const approvalBundle = readJson<ApprovalBundle>(sourcePackage.approvalBundlePath)
  if (stableSha256(originalPlan) !== approvalBundle.approval.derivedPlanSha256) {
    throw new Error('repair_emergency_builder_original_plan_mismatch')
  }
  const pendingRollback = readJson<JpOhlcvRepairRollbackApproval>(pendingRollbackApprovalPath)
  if (pendingRollback.version !== 1 || pendingRollback.action !== 'ROLLBACK'
    || pendingRollback.repairApprovalSha256 !== approvalBundle.approvalSha256) {
    throw new Error('repair_emergency_builder_pending_approval_invalid')
  }
  const journalPath = path.join(originalConfig.stateDirectory, 'repair-journal.json')
  const lockPath = path.join(originalConfig.stateDirectory, 'repair.lock')
  const activeJournal = readJson<{
    transactionId?: unknown
    evidence?: {
      RUNTIME_SNAPSHOT_RENEWED?: {
        snapshotSha256?: unknown
        evidencePath?: unknown
        evidenceFileSha256?: unknown
      }
    }
  }>(journalPath)
  const renewedEvidence = activeJournal.evidence?.RUNTIME_SNAPSHOT_RENEWED
  if (activeJournal.transactionId !== pendingRollback.transactionId
    || typeof renewedEvidence?.evidencePath !== 'string'
    || typeof renewedEvidence.snapshotSha256 !== 'string'
    || typeof renewedEvidence.evidenceFileSha256 !== 'string') {
    throw new Error('repair_emergency_builder_runtime_snapshot_evidence_missing')
  }
  const backupRuntimeSnapshotPath = fs.realpathSync(renewedEvidence.evidencePath)
  const backupRuntimeSnapshot = readJson<{
    transactionId?: unknown
    snapshot?: {
      snapshotSha256?: unknown
      officialRows?: unknown
      runtimeScope?: { missingRows?: unknown[] }
    }
  }>(backupRuntimeSnapshotPath)
  const derivedRestoredTargetRows = Number(backupRuntimeSnapshot.snapshot?.officialRows)
    - (backupRuntimeSnapshot.snapshot?.runtimeScope?.missingRows?.length ?? Number.NaN)
  if (sha256File(backupRuntimeSnapshotPath) !== renewedEvidence.evidenceFileSha256
    || backupRuntimeSnapshot.transactionId !== pendingRollback.transactionId
    || backupRuntimeSnapshot.snapshot?.snapshotSha256 !== renewedEvidence.snapshotSha256
    || derivedRestoredTargetRows !== expectedRestoredTargetRows) {
    throw new Error('repair_emergency_builder_runtime_snapshot_evidence_mismatch')
  }
  const integrationRoot = fs.realpathSync(process.cwd())
  const trackedStatus = execFileSync('/usr/bin/git', ['status', '--porcelain', '--untracked-files=no'], {
    cwd: integrationRoot,
    encoding: 'utf8',
  }).trim()
  if (trackedStatus) throw new Error('repair_emergency_builder_clean_worktree_required')
  const integrationHead = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], {
    cwd: integrationRoot,
    encoding: 'utf8',
  }).trim()
  const integrationTreeId = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD^{tree}'], {
    cwd: integrationRoot,
    encoding: 'utf8',
  }).trim()

  const verifierScript = path.resolve('scripts/verify-jp-ohlcv-repair-derived-state.ts')
  const executeScript = path.resolve('scripts/execute-jp-ohlcv-production-repair.ts')
  const orchestratorScript = path.resolve('scripts/orchestrate-jp-ohlcv-emergency-recovery.ts')
  const recoveryConfigurationPath = path.join(outputDirectory, 'recovery-execution-configuration.json')
  const recoveryPlanPath = path.join(outputDirectory, 'recovery-execution-plan.json')
  const recoveryApprovalPath = path.join(outputDirectory, 'emergency-rollback-approval.json')
  const recoveryPackagePath = path.join(outputDirectory, 'emergency-recovery-package.json')

  const recoveryConfig: JpOhlcvProductionExecutionConfiguration = {
    ...originalConfig,
    integrationRoot,
    integrationCommit: integrationHead,
    integrationTreeId,
    repairScope: {
      ...originalConfig.repairScope,
      existingRows: expectedRestoredTargetRows,
      matchingRows: expectedRestoredTargetRows - originalConfig.repairScope.conflicts,
      missingRows: originalConfig.repairScope.officialRows - expectedRestoredTargetRows,
    },
    nestedCommands: originalConfig.nestedCommands.map((command) => {
      const args = replacePath(command.args, originalConfigurationPath, recoveryConfigurationPath)
      const verifierScriptIndex = args.findIndex((arg) => arg.endsWith('/verify-jp-ohlcv-repair-derived-state.ts'))
      const sealedFiles = command.sealedFiles.map((file) => (
        file.path.endsWith('/verify-jp-ohlcv-repair-derived-state.ts')
          ? { ...file, path: verifierScript, sha256: sha256File(verifierScript) }
          : file
      ))
      if (verifierScriptIndex >= 0) args[verifierScriptIndex] = verifierScript
      if (command.id !== 'verify-restored-derived-state') return { ...command, args, sealedFiles }
      if (verifierScriptIndex < 0 || !command.rollback) {
        throw new Error('repair_emergency_builder_rollback_verifier_missing')
      }
      const targetRowsFlagIndex = args.indexOf('--rollback-expected-target-rows')
      if (targetRowsFlagIndex >= 0) {
        args[targetRowsFlagIndex + 1] = String(expectedRestoredTargetRows)
      } else {
        args.push('--rollback-expected-target-rows', String(expectedRestoredTargetRows))
      }
      return {
        ...command,
        args,
        sealedFiles,
      }
    }),
  }
  writeNew(recoveryConfigurationPath, recoveryConfig)
  const recoveryConfigurationSha256 = sha256File(recoveryConfigurationPath)
  const replace = (command: JpOhlcvRepairStageCommand) => replaceConfigurationInCommand(
    command,
    originalConfigurationPath,
    recoveryConfigurationPath,
    recoveryConfigurationSha256,
  )
  const recoveryPlan: JpOhlcvRepairExecutionPlan = {
    ...originalPlan,
    commands: {
      createBackup: replace(originalPlan.commands.createBackup),
      holdReadServices: replace(originalPlan.commands.holdReadServices),
      publishSourceGeneration: replace(originalPlan.commands.publishSourceGeneration),
      verifyDataGeneration: replace(originalPlan.commands.verifyDataGeneration),
      rebuildDerivedServing: originalPlan.commands.rebuildDerivedServing.map(replace),
      verifyServing: replace(originalPlan.commands.verifyServing),
      resumeReadServices: replace(originalPlan.commands.resumeReadServices),
      verifyBackupForRollback: replace(originalPlan.commands.verifyBackupForRollback),
      restoreBackup: replace(originalPlan.commands.restoreBackup),
      rebuildOriginalDerivedServing: originalPlan.commands.rebuildOriginalDerivedServing.map(replace),
      verifyOriginalServing: replace(originalPlan.commands.verifyOriginalServing),
    },
  }
  writeNew(recoveryPlanPath, recoveryPlan)
  const recoveryPlanSha256 = stableSha256(recoveryPlan)
  const recoveryApproval: JpOhlcvRepairRollbackApproval = {
    ...pendingRollback,
    version: 2,
    emergencyRecovery: {
      originalExecutionPlanSha256: approvalBundle.approval.derivedPlanSha256,
      recoveryExecutionPlanSha256: recoveryPlanSha256,
      recoveryConfigurationFileSha256: recoveryConfigurationSha256,
      expectedRestoredTargetRows,
      backupRuntimeSnapshotSha256: renewedEvidence.snapshotSha256,
      backupRuntimeSnapshotFileSha256: renewedEvidence.evidenceFileSha256,
    },
    reason: `${pendingRollback.reason} Emergency recovery uses a separately sealed plan that removes only the redundant post-restore full quick_check and verifies the backup-time row count.`,
  }
  writeNew(recoveryApprovalPath, recoveryApproval)
  const recoveryApprovalSha256 = repairRollbackApprovalSha256(recoveryApproval)

  const runner = {
    executable: sourcePackage.runner.executable,
    executableSha256: sourcePackage.runner.executableSha256,
    args: [
      sourcePackage.runner.args[0],
      executeScript,
      '--execute',
      '--approval-bundle', sourcePackage.approvalBundlePath,
      '--execution-plan', recoveryPlanPath,
      '--execution-configuration', recoveryConfigurationPath,
      '--rollback-approval', recoveryApprovalPath,
      '--rollback-approval-sha256', recoveryApprovalSha256,
    ],
    workingDirectory: sourcePackage.runner.workingDirectory,
    timeoutMs: 8 * 60 * 60_000,
    environment: {
      NODE_ENV: 'production',
      USE_LOCAL_DB: '1',
      STOCKBOARD_DB_PATH: originalConfig.databaseRealpath,
      ...jpOhlcvStorageIdentityEnvironment(recoveryConfig),
      STOCKBOARD_JP_OHLCV_EXECUTION_CONFIGURATION_SHA256: recoveryConfigurationSha256,
      STOCKBOARD_JP_OHLCV_PRODUCTION_REPAIR_APPROVED: approvalBundle.approvalSha256,
    },
    sealedFiles: [
      { path: sourcePackage.runner.args[0], sha256: sha256File(sourcePackage.runner.args[0]) },
      { path: executeScript, sha256: sha256File(executeScript) },
      { path: sourcePackage.approvalBundlePath, sha256: sha256File(sourcePackage.approvalBundlePath) },
      { path: recoveryPlanPath, sha256: sha256File(recoveryPlanPath) },
      { path: recoveryConfigurationPath, sha256: recoveryConfigurationSha256 },
      { path: recoveryApprovalPath, sha256: sha256File(recoveryApprovalPath) },
    ],
  }
  const sourceFiles = [
    'lib/jp-ohlcv-production-repair.ts',
    'lib/jp-ohlcv-command-adapter.ts',
    'lib/jp-ohlcv-maintenance-orchestrator.ts',
    'lib/jp-ohlcv-repair-runner.ts',
    'lib/jp-ohlcv-executable-plan.ts',
    'lib/storage/weekly-writer-hold.ts',
    'lib/storage/launchd-writer-hold-driver.ts',
    'scripts/verify-jp-ohlcv-repair-derived-state.ts',
    'scripts/execute-jp-ohlcv-production-repair.ts',
    'scripts/run-jp-ohlcv-production-stage.ts',
    'scripts/orchestrate-jp-ohlcv-emergency-recovery.ts',
  ].map((file) => {
    const resolved = path.resolve(file)
    return { path: resolved, sha256: sha256File(resolved) }
  })
  const recoveryPackage: JpOhlcvEmergencyRecoveryPackage = {
    version: 1,
    transactionId: recoveryApproval.transactionId,
    preparedAt: new Date().toISOString(),
    integrationRoot,
    integrationHead,
    integrationTreeId,
    configurationPath: recoveryConfigurationPath,
    configurationFileSha256: recoveryConfigurationSha256,
    rollbackApprovalPath: recoveryApprovalPath,
    rollbackApprovalSha256: recoveryApprovalSha256,
    repairApprovalSha256: approvalBundle.approvalSha256,
    recoveryExecutionPlanSha256: recoveryPlanSha256,
    expectedRestoredTargetRows,
    backupRuntimeSnapshotPath,
    backupRuntimeSnapshotSha256: renewedEvidence.snapshotSha256,
    backupRuntimeSnapshotFileSha256: renewedEvidence.evidenceFileSha256,
    activeJournalPath: journalPath,
    activeJournalCanonicalSha256: stableSha256(activeJournal),
    activeJournalFileSha256: sha256File(journalPath),
    activeLockPath: lockPath,
    activeLockFileSha256: sha256File(lockPath),
    backupRealpath: recoveryApproval.backupRealpath,
    backupSha256: recoveryApproval.backupSha256,
    sourceGenerationCurrent: originalConfig.sourceGenerationAfter,
    sourceGenerationTarget: recoveryApproval.sourceGenerationTarget,
    servingGenerationCurrent: originalConfig.servingGenerationBefore,
    servingGenerationTarget: recoveryApproval.servingGenerationTarget,
    runner,
    orchestratorScriptPath: orchestratorScript,
    orchestratorScriptSha256: sha256File(orchestratorScript),
    sourceFiles,
  }
  writeNew(recoveryPackagePath, recoveryPackage)
  console.log(JSON.stringify({
    status: 'PASS',
    productionMutationAuthorized: false,
    transactionId: recoveryPackage.transactionId,
    expectedRestoredTargetRows,
    recoveryPackagePath,
    recoveryPackageApprovalSha256: stableSha256(recoveryPackage),
    recoveryPackageFileSha256: sha256File(recoveryPackagePath),
    rollbackApprovalPath: recoveryApprovalPath,
    rollbackApprovalSha256: recoveryApprovalSha256,
    recoveryConfigurationFileSha256: recoveryConfigurationSha256,
    recoveryExecutionPlanSha256: recoveryPlanSha256,
    activeJournalCanonicalSha256: recoveryPackage.activeJournalCanonicalSha256,
    activeJournalFileSha256: recoveryPackage.activeJournalFileSha256,
    activeLockFileSha256: recoveryPackage.activeLockFileSha256,
    backupSha256: recoveryPackage.backupSha256,
  }))
}

main()
