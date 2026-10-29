import fs from 'node:fs'
import path from 'node:path'
import { runDailyTriggerEvaluations } from '@/lib/server/trigger-daily-evaluations'
import { composeTriggerNotificationsForBatch } from '@/lib/server/trigger-notification-composition'
import { jpOhlcvRepairBarrierDecision } from '@/lib/jp-ohlcv-repair-barrier'

function argumentValue(name: string): string | undefined {
  const inline = process.argv.find((value) => value.startsWith(`${name}=`))
  if (inline) return inline.slice(name.length + 1)
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function writeEvidence(file: string, payload: unknown): void {
  const output = path.resolve(file)
  const directory = path.dirname(output)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporary = path.join(directory, `.${path.basename(output)}.${process.pid}.${Date.now()}.tmp`)
  const descriptor = fs.openSync(temporary, 'wx', 0o600)
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(payload, null, 2)}\n`)
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
  fs.renameSync(temporary, output)
  const directoryDescriptor = fs.openSync(directory, 'r')
  try { fs.fsyncSync(directoryDescriptor) } finally { fs.closeSync(directoryDescriptor) }
}

async function main(): Promise<void> {
  const requestedAsOf = argumentValue('--as-of')
  const repairSourceGeneration = argumentValue('--repair-source-generation')
  const evidenceOutput = argumentValue('--evidence-output')
  const dryRun = process.argv.includes('--dry-run')
  if (evidenceOutput && (!repairSourceGeneration || dryRun)) {
    throw new Error('repair_trigger_evidence_requires_live_repair_generation')
  }
  if (repairSourceGeneration) {
    const decision = jpOhlcvRepairBarrierDecision({ jobType: 'jp_ohlcv_gap_repair' })
    if (decision.blocked
      || process.env.STOCKBOARD_JP_OHLCV_REPAIR_OWNER !== '1'
      || process.env.STOCKBOARD_UPDATE_JOB_TYPE !== 'jp_ohlcv_gap_repair') {
      throw new Error(`repair_trigger_owner_not_verified:${decision.reason ?? 'owner_environment_invalid'}`)
    }
  }
  const result = await runDailyTriggerEvaluations({
    requestedAsOf,
    dryRun,
    sourceGeneration: repairSourceGeneration,
    forceReevaluate: Boolean(repairSourceGeneration) && !dryRun,
  })
  const report = {
    dryRun: result.dryRun,
    reusedBatch: result.reusedBatch,
    requestedAsOf: result.requestedAsOf,
    resolvedAsOf: result.resolvedAsOf,
    batch: result.batch,
    repairSourceGeneration: repairSourceGeneration ?? null,
    notificationsSuppressed: Boolean(repairSourceGeneration),
    notificationSuppressionReason: repairSourceGeneration
      ? 'Historical source repair re-evaluation must not resend user notifications.'
      : null,
    definitions: result.items.map((item) => ({
      definitionId: item.definitionId,
      evaluationVersion: item.evaluationVersion,
      status: item.status,
      evaluationId: item.evaluationId,
      lifecycleEventCount: item.lifecycleEventCount,
      durationMs: Math.round(item.durationMs),
      errorCategory: item.errorCategory,
    })),
  }
  console.log(JSON.stringify(report, null, 2))
  if (evidenceOutput) {
    writeEvidence(evidenceOutput, {
      version: 1,
      recordedAt: new Date().toISOString(),
      sourceGeneration: repairSourceGeneration,
      batchId: result.batch?.id ?? null,
      status: result.batch?.status ?? null,
      resolvedAsOf: result.resolvedAsOf,
      failedCount: result.batch?.failedCount ?? null,
      notificationsSuppressed: true,
      definitionCount: result.items.length,
      evaluationIds: result.items.map((item) => item.evaluationId).filter(Boolean),
    })
  }
  if (!dryRun && !repairSourceGeneration && result.batch
    && (result.batch.status === 'COMPLETED' || result.batch.status === 'COMPLETED_WITH_ERRORS')) {
    try {
      const notifications = await composeTriggerNotificationsForBatch({ batchId: result.batch.id })
      console.log(JSON.stringify({
        notificationComposition: {
          batchId: notifications.batchId,
          createdCount: notifications.createdCount,
          reusedCount: notifications.reusedCount,
          notificationTypes: notifications.notifications.map((item) => item.notificationType),
          performance: notifications.performance,
        },
      }, null, 2))
    } catch (error) {
      console.error('Trigger notification composition failed:', error)
    }
  }
  if (result.batch?.status === 'FAILED'
    || (repairSourceGeneration && result.batch?.status === 'COMPLETED_WITH_ERRORS')) process.exitCode = 1
}

main().catch((error) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error))
  process.exitCode = 1
})
