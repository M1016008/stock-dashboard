import fs from 'node:fs'
import path from 'node:path'
import type { JpOhlcvMissingOnlyRepairScope } from '@/lib/jp-ohlcv-data-quality'
import {
  repairApprovalSha256,
  repairRollbackApprovalSha256,
  type JpOhlcvRepairApproval,
  type JpOhlcvRepairPaths,
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
  const { installJpOhlcvRepairSignalHandlers, assertJpOhlcvRepairExecutionActive } = await import('@/lib/jp-ohlcv-repair-process-supervisor')
  const uninstallSignalHandlers = installJpOhlcvRepairSignalHandlers()
  const { createJpOhlcvCommandAdapters } = await import('@/lib/jp-ohlcv-command-adapter')
  const rollbackApprovalFile = value('--rollback-approval')
  try {
    if (rollbackApprovalFile) {
      if (!path.isAbsolute(rollbackApprovalFile)) throw new Error('--rollback-approval_absolute_path_required')
      const rollbackApproval = readJson<JpOhlcvRepairRollbackApproval>(path.resolve(rollbackApprovalFile))
      const expectedRollbackSha = value('--rollback-approval-sha256')
      if (!expectedRollbackSha || repairRollbackApprovalSha256(rollbackApproval) !== expectedRollbackSha) {
        throw new Error('repair_rollback_exact_approval_hash_required')
      }
      const { runJpOhlcvProductionRepairRollback } = await import('@/lib/jp-ohlcv-repair-runner')
      const adapters = createJpOhlcvCommandAdapters({ approval: bundle.approval, plan, rollbackApproval })
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
    const { runJpOhlcvProductionRepair } = await import('@/lib/jp-ohlcv-repair-runner')
    const adapters = createJpOhlcvCommandAdapters({ approval: bundle.approval, plan })
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
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error))
  process.exitCode = 1
})
