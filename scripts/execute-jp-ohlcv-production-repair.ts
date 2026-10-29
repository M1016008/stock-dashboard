import fs from 'node:fs'
import path from 'node:path'
import type { JpOhlcvMissingOnlyRepairScope } from '@/lib/jp-ohlcv-data-quality'
import {
  inspectJpOhlcvProductionRepair,
  repairApprovalSha256,
  repairPrewriteCleanupApprovalSha256,
  repairResumeServicesApprovalSha256,
  repairRollbackApprovalSha256,
  type JpOhlcvRepairApproval,
  type JpOhlcvRepairPaths,
  type JpOhlcvRepairPrewriteCleanupApproval,
  type JpOhlcvRepairResumeServicesApproval,
  type JpOhlcvRepairRollbackApproval,
} from '@/lib/jp-ohlcv-production-repair'
import type { JpOhlcvRepairExecutionPlan } from '@/lib/jp-ohlcv-command-adapter'

type ApprovalBundle = {
  version: 1
  approval: JpOhlcvRepairApproval
  approvalSha256: string
  scope: JpOhlcvMissingOnlyRepairScope
  executionStatus: 'HOLD_PENDING_EXPLICIT_APPROVAL'
}

let reportPaths: JpOhlcvRepairPaths | null = null
let executionEntered = false

function value(flag: string): string | null {
  const index = process.argv.indexOf(flag)
  const result = index >= 0 ? process.argv[index + 1] ?? null : null
  return result?.startsWith('--') ? null : result
}

function absolute(flag: string): string {
  const result = value(flag)
  if (!result || !path.isAbsolute(result)) throw new Error(`${flag}_absolute_path_required`)
  return path.resolve(result)
}

function readJson<T>(file: string): T {
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`${file}_symlink_forbidden`)
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T
}

async function main(): Promise<void> {
  if (!process.argv.includes('--execute')) throw new Error('--execute_required')
  if (process.env.NODE_ENV === 'test') throw new Error('repair_production_execution_test_environment_forbidden')
  if (process.env.USE_LOCAL_DB !== '1') throw new Error('repair_use_local_db_required')
  const bundle = readJson<ApprovalBundle>(absolute('--approval-bundle'))
  const plan = readJson<JpOhlcvRepairExecutionPlan>(absolute('--execution-plan'))
  if (bundle.version !== 1 || bundle.executionStatus !== 'HOLD_PENDING_EXPLICIT_APPROVAL') {
    throw new Error('repair_approval_bundle_invalid')
  }
  if (repairApprovalSha256(bundle.approval) !== bundle.approvalSha256) {
    throw new Error('repair_approval_bundle_hash_mismatch')
  }
  if (process.env.STOCKBOARD_JP_OHLCV_PRODUCTION_REPAIR_APPROVED !== bundle.approvalSha256) {
    throw new Error('repair_exact_approval_environment_required')
  }
  const configuredDatabase = process.env.STOCKBOARD_DB_PATH
  if (!configuredDatabase || !path.isAbsolute(configuredDatabase)
    || fs.realpathSync(configuredDatabase) !== bundle.approval.databaseRealpath) {
    throw new Error('repair_database_environment_identity_mismatch')
  }
  const { isCloudDatabase, localDbPath } = await import('@/lib/db/client')
  if (isCloudDatabase || fs.realpathSync(localDbPath) !== bundle.approval.databaseRealpath) {
    throw new Error('repair_local_database_client_identity_mismatch')
  }
  const paths: JpOhlcvRepairPaths = {
    stateDirectory: bundle.approval.stateDirectory,
    journal: path.join(bundle.approval.stateDirectory, 'repair-journal.json'),
    lock: path.join(bundle.approval.stateDirectory, 'repair.lock'),
  }
  reportPaths = paths
  const { installJpOhlcvRepairSignalHandlers, assertJpOhlcvRepairExecutionActive } = await import('@/lib/jp-ohlcv-repair-process-supervisor')
  const uninstallSignalHandlers = installJpOhlcvRepairSignalHandlers()
  const { createJpOhlcvCommandAdapters } = await import('@/lib/jp-ohlcv-command-adapter')
  const rollbackApprovalFile = value('--rollback-approval')
  const cleanupApprovalFile = value('--prewrite-cleanup-approval')
  const resumeServicesApprovalFile = value('--resume-services-approval')
  if ([rollbackApprovalFile, cleanupApprovalFile, resumeServicesApprovalFile].filter(Boolean).length > 1) {
    throw new Error('repair_recovery_mode_conflict')
  }
  try {
    if (cleanupApprovalFile) {
      if (!path.isAbsolute(cleanupApprovalFile)) throw new Error('--prewrite-cleanup-approval_absolute_path_required')
      const cleanupApproval = readJson<JpOhlcvRepairPrewriteCleanupApproval>(path.resolve(cleanupApprovalFile))
      const expectedCleanupSha = value('--prewrite-cleanup-approval-sha256')
      if (!expectedCleanupSha || repairPrewriteCleanupApprovalSha256(cleanupApproval) !== expectedCleanupSha) {
        throw new Error('repair_prewrite_cleanup_exact_approval_hash_required')
      }
      const { runJpOhlcvProductionRepairPrewriteCleanup } = await import('@/lib/jp-ohlcv-repair-runner')
      executionEntered = true
      const result = runJpOhlcvProductionRepairPrewriteCleanup({
        approval: bundle.approval,
        approvalSha256: bundle.approvalSha256,
        cleanupApproval,
        cleanupApprovalSha256: expectedCleanupSha,
        paths,
      })
      console.log(JSON.stringify(result))
      return
    }
    if (rollbackApprovalFile) {
      if (!path.isAbsolute(rollbackApprovalFile)) throw new Error('--rollback-approval_absolute_path_required')
      const rollbackApproval = readJson<JpOhlcvRepairRollbackApproval>(path.resolve(rollbackApprovalFile))
      const expectedRollbackSha = value('--rollback-approval-sha256')
      if (!expectedRollbackSha || repairRollbackApprovalSha256(rollbackApproval) !== expectedRollbackSha) {
        throw new Error('repair_rollback_exact_approval_hash_required')
      }
      const { runJpOhlcvProductionRepairRollback } = await import('@/lib/jp-ohlcv-repair-runner')
      const adapters = createJpOhlcvCommandAdapters({ approval: bundle.approval, plan, rollbackApproval })
      executionEntered = true
      const result = await runJpOhlcvProductionRepairRollback({
        approval: bundle.approval,
        approvalSha256: bundle.approvalSha256,
        rollbackApproval,
        rollbackApprovalSha256: expectedRollbackSha,
        paths,
        adapter: adapters.rollback,
      })
      assertJpOhlcvRepairExecutionActive()
      console.log(JSON.stringify(result))
      return
    }
    if (resumeServicesApprovalFile) {
      if (!path.isAbsolute(resumeServicesApprovalFile)) throw new Error('--resume-services-approval_absolute_path_required')
      const resumeApproval = readJson<JpOhlcvRepairResumeServicesApproval>(path.resolve(resumeServicesApprovalFile))
      const expectedResumeSha = value('--resume-services-approval-sha256')
      if (!expectedResumeSha || repairResumeServicesApprovalSha256(resumeApproval) !== expectedResumeSha) {
        throw new Error('repair_resume_services_exact_approval_hash_required')
      }
      const { runJpOhlcvProductionRepairResumeReadServices } = await import('@/lib/jp-ohlcv-repair-runner')
      const adapters = createJpOhlcvCommandAdapters({ approval: bundle.approval, plan })
      executionEntered = true
      const result = await runJpOhlcvProductionRepairResumeReadServices({
        approval: bundle.approval,
        approvalSha256: bundle.approvalSha256,
        resumeApproval,
        resumeApprovalSha256: expectedResumeSha,
        paths,
        adapter: adapters.forward,
      })
      assertJpOhlcvRepairExecutionActive()
      console.log(JSON.stringify(result))
      return
    }
    const { runJpOhlcvProductionRepair } = await import('@/lib/jp-ohlcv-repair-runner')
    const adapters = createJpOhlcvCommandAdapters({ approval: bundle.approval, plan })
    executionEntered = true
    const result = await runJpOhlcvProductionRepair({
      approval: bundle.approval,
      approvalSha256: bundle.approvalSha256,
      scope: bundle.scope,
      paths,
      adapter: adapters.forward,
    })
    assertJpOhlcvRepairExecutionActive()
    console.log(JSON.stringify(result))
  } finally {
    uninstallSignalHandlers()
  }
}

main().catch((error) => {
  let inspection: Record<string, unknown> | null = null
  if (reportPaths) {
    try { inspection = inspectJpOhlcvProductionRepair(reportPaths) } catch (inspectionError) {
      inspection = {
        status: 'HOLD_UNCERTAIN',
        reasons: [`STATUS_INSPECTION_FAILED:${inspectionError instanceof Error ? inspectionError.message : String(inspectionError)}`],
      }
    }
  }
  const stateJournal = inspection?.journal as { operatorAction?: unknown } | null | undefined
  const exactOperatorAction = typeof stateJournal?.operatorAction === 'string'
    ? stateJournal.operatorAction
    : typeof inspection?.fallbackOperatorAction === 'string'
      ? inspection.fallbackOperatorAction
      : null
  console.error(JSON.stringify({
    status: executionEntered ? 'TRANSACTION_HOLD_OR_REJECTED' : 'PRECONDITION_REJECTED_NO_RUNNER_ENTRY',
    automaticRetryAllowed: false,
    failure: {
      name: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : String(error),
    },
    repairState: inspection,
    operatorAction: exactOperatorAction
      ? `${exactOperatorAction} Automatic retry is forbidden.`
      : 'No runner state path was established. Correct only the rejected input, then obtain or reconfirm the exact approval before a new attempt.',
  }, null, 2))
  process.exitCode = 1
})
