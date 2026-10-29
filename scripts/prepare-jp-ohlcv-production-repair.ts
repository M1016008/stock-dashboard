import fs from 'node:fs'
import path from 'node:path'
import {
  buildJpOhlcvMissingOnlyRepairScope,
  stableSha256,
  type JpOhlcvBackfillPlan,
} from '@/lib/jp-ohlcv-data-quality'
import { repairApprovalSha256, type JpOhlcvRepairApproval } from '@/lib/jp-ohlcv-production-repair'
import { DEFAULT_JP_OHLCV_REPAIR_LOCK } from '@/lib/jp-ohlcv-repair-barrier'
import {
  assertJpOhlcvRepairExecutionPlan,
  type JpOhlcvRepairExecutionPlan,
} from '@/lib/jp-ohlcv-command-adapter'

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

const dryRunFile = absolute('--dry-run-manifest')
const outputFile = absolute('--output')
const parsed = JSON.parse(fs.readFileSync(dryRunFile, 'utf8')) as { plan?: JpOhlcvBackfillPlan }
if (!parsed.plan) throw new Error('dry_run_plan_missing')
const conflictTickers = value('--preserve-conflicts').split(',').map((entry) => entry.trim()).filter(Boolean)
const scope = buildJpOhlcvMissingOnlyRepairScope({ plan: parsed.plan, approvedConflictTickers: conflictTickers })
if (scope.status !== 'READY') throw new Error(`missing_only_scope_hold:${scope.reasons.join(',')}`)

const derivedPlanFile = absolute('--derived-plan')
const derivedPlan = JSON.parse(fs.readFileSync(derivedPlanFile, 'utf8')) as JpOhlcvRepairExecutionPlan
if (derivedPlan.version !== 1
  || !Array.isArray(derivedPlan.officialRows)
  || derivedPlan.officialRows.length !== parsed.plan.officialRows
  || !derivedPlan.commands
  || derivedPlan.commands.rebuildDerivedServing.length === 0
  || derivedPlan.commands.rebuildOriginalDerivedServing.length === 0) {
  throw new Error('repair_executable_plan_incomplete')
}
assertJpOhlcvRepairExecutionPlan({ plan: derivedPlan, targetDate: scope.date })
const derivedPlanSha256 = stableSha256(derivedPlan)
const approval: JpOhlcvRepairApproval = {
  version: 1,
  executionScope: 'PRODUCTION',
  targetDate: scope.date,
  officialSha256: scope.officialSha256,
  planSha256: scope.planSha256,
  missingRowsSha256: scope.missingRowsSha256,
  preservedConflictsSha256: scope.preservedConflictsSha256,
  expectedOfficialRows: parsed.plan.officialRows,
  expectedExistingRows: parsed.plan.existingRows,
  expectedMatchingRows: parsed.plan.matchingRows,
  expectedMissingRows: scope.missingRows.length,
  approvedConflictTickers: conflictTickers.sort(),
  conflictDisposition: 'PRESERVE_EXISTING_HOLD',
  databaseRealpath: fs.realpathSync(absolute('--database')),
  databaseIdentitySha256: value('--database-identity-sha256'),
  stateDirectory: absolute('--state-directory'),
  backupDirectory: absolute('--backup-directory'),
  sourceGenerationBefore: value('--source-generation-before'),
  sourceGenerationAfter: value('--source-generation-after'),
  servingGenerationBefore: value('--serving-generation-before'),
  servingGenerationAfter: value('--serving-generation-after'),
  derivedPlanSha256,
}
if (path.dirname(approval.databaseRealpath) === approval.stateDirectory
  || path.dirname(approval.databaseRealpath) === approval.backupDirectory
  || approval.stateDirectory === approval.backupDirectory) {
  throw new Error('repair_state_backup_database_directories_must_be_distinct')
}
if (path.join(approval.stateDirectory, 'repair.lock') !== path.resolve(DEFAULT_JP_OHLCV_REPAIR_LOCK)) {
  throw new Error('repair_production_writer_barrier_path_mismatch')
}
const bundle = {
  version: 1,
  generatedAt: new Date().toISOString(),
  approval,
  approvalSha256: repairApprovalSha256(approval),
  scope,
  productionMutationAuthorized: false,
  executionStatus: 'HOLD_PENDING_EXPLICIT_APPROVAL',
}
fs.mkdirSync(path.dirname(outputFile), { recursive: true })
fs.writeFileSync(outputFile, `${JSON.stringify(bundle, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
console.log(JSON.stringify({
  outputFile,
  approvalSha256: bundle.approvalSha256,
  missingRows: scope.missingRows.length,
  preservedConflicts: scope.preservedConflicts.map((row) => row.ticker),
  executionStatus: bundle.executionStatus,
}))
