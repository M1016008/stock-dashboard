import fs from 'node:fs'
import path from 'node:path'
import {
  assertJpOhlcvProductionExecutionConfiguration,
  executionConfigurationSha256,
  executionPackageSha256,
  jpOhlcvStorageIdentityEnvironment,
  sha256File,
  type JpOhlcvNestedCommand,
  type JpOhlcvProductionExecutionConfiguration,
  type JpOhlcvProductionExecutionPackage,
} from '@/lib/jp-ohlcv-executable-plan'
import {
  buildJpOhlcvMissingOnlyRepairScope,
  buildJpOhlcvBackfillPlan,
  jpOhlcvApprovedRepairKeysSha256,
  stableSha256,
  type JpOhlcvBackfillPlan,
  type JpOfficialOhlcvValue,
  type JpOhlcvValue,
} from '@/lib/jp-ohlcv-data-quality'
import {
  assertJpOhlcvBackupMaintenanceBudget,
  assertJpOhlcvPlanMaintenanceBudget,
  JP_OHLCV_BACKUP_TIME_LIMITS as backupTimeLimits,
} from '@/lib/jp-ohlcv-backup-time-budget'
import {
  repairApprovalSha256,
  type JpOhlcvRepairApproval,
} from '@/lib/jp-ohlcv-production-repair'
import {
  assertJpOhlcvRepairExecutionPlan,
  type JpOhlcvRepairExecutionPlan,
  type JpOhlcvRepairStageCommand,
} from '@/lib/jp-ohlcv-command-adapter'
import {
  assertJQuantsDailyByDateSourceContract,
  assertJQuantsRejectedDailyRowEvidence,
  type JQuantsDailyByDateSourceContract,
  type JQuantsRejectedDailyRowEvidence,
} from '@/lib/jquants'

function value(flag: string): string {
  const index = process.argv.indexOf(flag)
  const result = index >= 0 ? process.argv[index + 1] : null
  if (!result || result.startsWith('--')) throw new Error(`${flag}_required`)
  return result
}

function absolute(flag: string): string {
  const result = value(flag)
  if (!path.isAbsolute(result)) throw new Error(`${flag}_absolute_path_required`)
  return path.resolve(result)
}

function readJson<T>(file: string): T {
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error('repair_package_input_symlink_forbidden')
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T
}

function writeNew(file: string, payload: unknown): void {
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
}

const dryRunFile = absolute('--dry-run-manifest')
const officialRowsFile = absolute('--official-rows')
const existingRowsFile = absolute('--existing-rows')
const configurationPath = absolute('--configuration')
const stageScript = absolute('--stage-script')
const executeScript = absolute('--execute-script')
const orchestratorScript = absolute('--orchestrator-script')
const nodeExecutable = fs.realpathSync(absolute('--node-executable'))
const tsxCli = fs.realpathSync(absolute('--tsx-executable'))
const workingDirectory = absolute('--working-directory')
const outputDirectory = absolute('--output-directory')
if (fs.existsSync(outputDirectory)) {
  if (!fs.statSync(outputDirectory).isDirectory() || fs.readdirSync(outputDirectory).length > 0) {
    throw new Error('repair_package_output_directory_must_be_new_or_empty')
  }
} else {
  fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o700 })
}

const config = readJson<JpOhlcvProductionExecutionConfiguration>(configurationPath)
assertJpOhlcvProductionExecutionConfiguration(config)
assertJpOhlcvBackupMaintenanceBudget()
if (config.mode !== 'PRODUCTION') throw new Error('repair_package_production_configuration_required')
const dryRun = readJson<{ plan?: JpOhlcvBackfillPlan }>(dryRunFile)
if (!dryRun.plan) throw new Error('repair_package_dry_run_plan_missing')
const officialInput = readJson<JpOfficialOhlcvValue[] | {
  rows: JpOfficialOhlcvValue[]
  sourceContract?: JQuantsDailyByDateSourceContract
  rejectedRows?: JQuantsRejectedDailyRowEvidence[]
}>(officialRowsFile)
const officialRows = Array.isArray(officialInput) ? officialInput : officialInput.rows
const officialSourceContract = Array.isArray(officialInput) ? null : officialInput.sourceContract ?? null
const officialRejectedRows = Array.isArray(officialInput) ? null : officialInput.rejectedRows ?? null
if (!officialSourceContract) throw new Error('repair_package_official_source_contract_missing')
if (!officialRejectedRows) throw new Error('repair_package_official_rejected_rows_missing')
const existingInput = readJson<JpOhlcvValue[] | {
  rows?: JpOhlcvValue[]
  reconstructedRows?: JpOhlcvValue[]
  reconstructedRowsSha256?: string
  evidenceKind?: string
  provenance?: unknown
}>(existingRowsFile)
const existingRows = Array.isArray(existingInput)
  ? existingInput
  : existingInput.reconstructedRows ?? existingInput.rows
if (!existingRows) throw new Error('repair_package_existing_rows_missing')
const existingWrapper = Array.isArray(existingInput) ? null : existingInput
const existingRowsSha256 = stableSha256(existingRows)
const existingKind = !existingWrapper?.reconstructedRows
  ? 'DIRECT_PRODUCTION_SNAPSHOT'
  : existingWrapper.evidenceKind
const existingProvenanceSha256 = !existingWrapper?.reconstructedRows
  ? stableSha256({ kind: 'DIRECT_PRODUCTION_SNAPSHOT', fileSha256: sha256File(existingRowsFile) })
  : stableSha256(existingWrapper.provenance)
if (existingKind !== config.existingEvidence.kind
  || sha256File(existingRowsFile) !== config.existingEvidence.fileSha256
  || existingRowsSha256 !== config.existingEvidence.rowsSha256
  || existingProvenanceSha256 !== config.existingEvidence.provenanceSha256
  || (existingWrapper?.reconstructedRows
    && existingWrapper.reconstructedRowsSha256 !== existingRowsSha256)) {
  throw new Error('repair_package_existing_evidence_identity_mismatch')
}
const rebuiltPlan = buildJpOhlcvBackfillPlan({ date: config.targetDate, officialRows, existingRows })
if (stableSha256(rebuiltPlan) !== stableSha256(dryRun.plan)) {
  throw new Error('repair_package_evidence_rebuild_mismatch')
}
try {
  assertJQuantsDailyByDateSourceContract(officialSourceContract, {
    requestedDate: config.targetDate,
    acceptedRows: officialRows.length,
    contentSha256: rebuiltPlan.officialSha256,
  })
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error)
  throw new Error(`repair_package_official_source_contract_invalid:${reason}`)
}
try {
  assertJQuantsRejectedDailyRowEvidence(officialRejectedRows, officialSourceContract)
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error)
  throw new Error(`repair_package_official_rejected_rows_invalid:${reason}`)
}
const scope = buildJpOhlcvMissingOnlyRepairScope({
  plan: dryRun.plan,
  approvedConflictTickers: config.preservedConflictTickers,
})
if (scope.status !== 'READY' || scope.missingRows.length !== config.repairScope.missingRows) {
  throw new Error(`repair_package_scope_not_ready:expected_missing_${config.repairScope.missingRows}:actual_${scope.missingRows.length}:${scope.reasons.join(',')}`)
}
if (config.lineage.targetDate !== config.targetDate
  || config.lineage.officialSha256 !== scope.officialSha256
  || config.lineage.planSha256 !== scope.planSha256
  || config.lineage.missingRowsSha256 !== scope.missingRowsSha256
  || config.lineage.preservedConflictsSha256 !== scope.preservedConflictsSha256) {
  throw new Error('repair_package_lineage_mismatch')
}

const nodeSha256 = sha256File(nodeExecutable)
const tsxSha256 = sha256File(tsxCli)
const stageSha256 = sha256File(fs.realpathSync(stageScript))
const configFileSha256 = sha256File(configurationPath)
const stage = (operation: string, extraArgs: string[] = [], timeoutMs = 60 * 60_000): JpOhlcvRepairStageCommand => ({
  executable: nodeExecutable,
  executableSha256: nodeSha256,
  sealedFiles: [
    { path: tsxCli, sha256: tsxSha256, snapshot: false },
    { path: stageScript, sha256: stageSha256 },
    { path: configurationPath, sha256: configFileSha256 },
  ],
  args: [tsxCli, stageScript, '--operation', operation, '--config', configurationPath, ...extraArgs],
  workingDirectory,
  timeoutMs,
})

const forwardCommands = config.nestedCommands.filter((command) => !command.rollback)
const rollbackCommands = config.nestedCommands.filter((command) => command.rollback)
const plan: JpOhlcvRepairExecutionPlan = {
  version: 1,
  officialRows,
  approvalScope: scope,
  timeBudget: {
    maximumMaintenanceMs: config.maximumMaintenanceMs,
    forwardDerivedAggregateMs: backupTimeLimits.forwardDerivedAggregateTimeoutMs,
    rollbackDerivedAggregateMs: backupTimeLimits.rollbackDerivedAggregateTimeoutMs,
  },
  commands: {
    createBackup: stage(
      'create-backup',
      [],
      backupTimeLimits.createBackupStageTimeoutMs + backupTimeLimits.commandTerminationGraceMs,
    ),
    holdReadServices: stage('hold-read-services', [], 5 * 60_000),
    publishSourceGeneration: stage('publish-source-generation', [], backupTimeLimits.simpleStageTimeoutMs),
    verifyDataGeneration: stage('verify-data-generation', [], backupTimeLimits.simpleStageTimeoutMs),
    rebuildDerivedServing: forwardCommands.map((command) => stage(
      'run-derived',
      ['--command-id', command.id],
      command.timeoutMs + 60_000,
    )),
    verifyServing: stage('verify-serving', [], backupTimeLimits.simpleStageTimeoutMs),
    resumeReadServices: stage('resume-read-services', [], 5 * 60_000),
    verifyBackupForRollback: stage(
      'verify-backup',
      [],
      backupTimeLimits.verifyBackupStageTimeoutMs + backupTimeLimits.commandTerminationGraceMs,
    ),
    restoreBackup: stage('restore-backup', [], backupTimeLimits.rollbackRestoreMaxTimeoutMs),
    rebuildOriginalDerivedServing: rollbackCommands.map((command) => stage(
      'run-derived',
      ['--command-id', command.id, '--rollback'],
      command.timeoutMs + 60_000,
    )),
    verifyOriginalServing: stage('verify-original-serving', [], backupTimeLimits.simpleStageTimeoutMs),
  },
}
assertJpOhlcvRepairExecutionPlan({ plan, targetDate: config.targetDate })
const maintenanceTimeBudget = assertJpOhlcvPlanMaintenanceBudget({
  maximumMaintenanceMs: config.maximumMaintenanceMs,
  timeouts: {
    createBackupMs: plan.commands.createBackup.timeoutMs,
    holdReadServicesMs: plan.commands.holdReadServices.timeoutMs,
    publishSourceGenerationMs: plan.commands.publishSourceGeneration.timeoutMs,
    verifyDataGenerationMs: plan.commands.verifyDataGeneration.timeoutMs,
    verifyServingMs: plan.commands.verifyServing.timeoutMs,
    resumeReadServicesMs: plan.commands.resumeReadServices.timeoutMs,
    verifyBackupForRollbackMs: plan.commands.verifyBackupForRollback.timeoutMs,
    restoreBackupMs: plan.commands.restoreBackup.timeoutMs,
    verifyOriginalServingMs: plan.commands.verifyOriginalServing.timeoutMs,
    forwardDerivedAggregateMs: plan.timeBudget.forwardDerivedAggregateMs,
    rollbackDerivedAggregateMs: plan.timeBudget.rollbackDerivedAggregateMs,
  },
})
const executionPlanPath = path.join(outputDirectory, 'execution-plan.json')
writeNew(executionPlanPath, plan)

const approval: JpOhlcvRepairApproval = {
  version: 1,
  executionScope: 'PRODUCTION',
  targetDate: config.targetDate,
  officialSha256: scope.officialSha256,
  planSha256: scope.planSha256,
  missingRowsSha256: scope.missingRowsSha256,
  approvedRepairKeysSha256: jpOhlcvApprovedRepairKeysSha256(scope.missingRows),
  runtimeDriftPolicy: 'ALLOW_APPROVED_KEYS_TO_BECOME_EXACT_MATCH_ONLY',
  runtimeSnapshotTtlMs: 900000,
  officialSourceContract,
  preservedConflictsSha256: scope.preservedConflictsSha256,
  expectedOfficialRows: dryRun.plan.officialRows,
  expectedExistingRows: dryRun.plan.existingRows,
  expectedMatchingRows: dryRun.plan.matchingRows,
  expectedMissingRows: scope.missingRows.length,
  approvedConflictTickers: [...config.preservedConflictTickers].sort(),
  conflictDisposition: 'PRESERVE_EXISTING_HOLD',
  databaseRealpath: config.databaseRealpath,
  databaseIdentitySha256: config.databaseIdentitySha256,
  stateDirectory: config.stateDirectory,
  backupDirectory: config.backupDirectory,
  sourceGenerationBefore: config.sourceGenerationBefore,
  sourceGenerationAfter: config.sourceGenerationAfter,
  servingGenerationBefore: config.servingGenerationBefore,
  servingGenerationAfter: config.servingGenerationAfter,
  derivedPlanSha256: stableSha256(plan),
}
const approvalBundle = {
  version: 1 as const,
  generatedAt: new Date().toISOString(),
  approval,
  approvalSha256: repairApprovalSha256(approval),
  scope,
  officialSourceEvidence: {
    sourceContract: officialSourceContract,
    rejectedRows: officialRejectedRows,
  },
  officialSourceEvidenceSha256: stableSha256({
    sourceContract: officialSourceContract,
    rejectedRows: officialRejectedRows,
  }),
  maintenanceTimeBudget,
  productionMutationAuthorized: false,
  executionStatus: 'HOLD_PENDING_EXPLICIT_APPROVAL' as const,
}
const approvalBundlePath = path.join(outputDirectory, 'approval-bundle.json')
writeNew(approvalBundlePath, approvalBundle)

const runner: JpOhlcvNestedCommand = {
  id: 'production-repair-runner',
  executable: nodeExecutable,
  executableSha256: nodeSha256,
  args: [
    tsxCli,
    executeScript,
    '--execute',
    '--approval-bundle', approvalBundlePath,
    '--execution-plan', executionPlanPath,
    '--execution-configuration', configurationPath,
  ],
  workingDirectory,
  sealedFiles: [
    { path: tsxCli, sha256: tsxSha256 },
    { path: executeScript, sha256: sha256File(executeScript) },
    { path: approvalBundlePath, sha256: sha256File(approvalBundlePath) },
    { path: executionPlanPath, sha256: sha256File(executionPlanPath) },
    { path: configurationPath, sha256: configFileSha256 },
  ],
  timeoutMs: backupTimeLimits.forwardOperationTimeoutMs,
  environment: {
    NODE_ENV: 'production',
    USE_LOCAL_DB: '1',
    STOCKBOARD_DB_PATH: config.databaseRealpath,
    ...jpOhlcvStorageIdentityEnvironment(config),
    STOCKBOARD_JP_OHLCV_EXECUTION_CONFIGURATION_SHA256: configFileSha256,
  },
  rollback: false,
  publishesServingGeneration: false,
}
const executionPackage: JpOhlcvProductionExecutionPackage = {
  version: 1,
  targetDate: config.targetDate,
  preparedAt: new Date().toISOString(),
  configurationPath,
  configurationSha256: configFileSha256,
  approvalBundlePath,
  approvalBundleSha256: sha256File(approvalBundlePath),
  executionPlanPath,
  executionPlanSha256: sha256File(executionPlanPath),
  orchestratorScriptPath: orchestratorScript,
  orchestratorScriptSha256: sha256File(orchestratorScript),
  runner,
  productionMutationAuthorized: false,
  requiredApproval: 'EXACT_PACKAGE_AND_REPAIR_APPROVAL_HASHES',
}
const executionPackagePath = path.join(outputDirectory, 'execution-package.json')
writeNew(executionPackagePath, executionPackage)
console.log(JSON.stringify({
  status: 'PASS',
  executionStatus: 'HOLD_PENDING_EXPLICIT_APPROVAL',
  productionMutationAuthorized: false,
  dayFullyRepaired: false,
  executionPackagePath,
  executionPackageSha256: executionPackageSha256(executionPackage),
  approvalSha256: approvalBundle.approvalSha256,
  configurationFileSha256: configFileSha256,
  configurationCanonicalSha256: executionConfigurationSha256(config),
  officialSha256: scope.officialSha256,
  planSha256: scope.planSha256,
  executionPlanSha256: stableSha256(plan),
  maintenanceTimeBudget,
  missingRows: scope.missingRows.length,
  preservedConflicts: scope.preservedConflicts.map((row) => row.ticker),
  unresolvedConflictCount: scope.preservedConflicts.length,
  requiredApprovalEnvironment: {
    STOCKBOARD_JP_OHLCV_EXECUTION_PACKAGE_APPROVED: executionPackageSha256(executionPackage),
    STOCKBOARD_JP_OHLCV_PRODUCTION_REPAIR_APPROVED: approvalBundle.approvalSha256,
  },
}))
