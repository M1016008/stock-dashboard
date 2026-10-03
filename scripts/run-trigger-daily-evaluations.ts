import { runDailyTriggerEvaluations } from '@/lib/server/trigger-daily-evaluations'
import { composeTriggerNotificationsForBatch } from '@/lib/server/trigger-notification-composition'

function argumentValue(name: string): string | undefined {
  const inline = process.argv.find((value) => value.startsWith(`${name}=`))
  if (inline) return inline.slice(name.length + 1)
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function main(): Promise<void> {
  const requestedAsOf = argumentValue('--as-of')
  const dryRun = process.argv.includes('--dry-run')
  const result = await runDailyTriggerEvaluations({ requestedAsOf, dryRun })
  console.log(JSON.stringify({
    dryRun: result.dryRun,
    reusedBatch: result.reusedBatch,
    requestedAsOf: result.requestedAsOf,
    resolvedAsOf: result.resolvedAsOf,
    batch: result.batch,
    definitions: result.items.map((item) => ({
      definitionId: item.definitionId,
      evaluationVersion: item.evaluationVersion,
      status: item.status,
      evaluationId: item.evaluationId,
      lifecycleEventCount: item.lifecycleEventCount,
      durationMs: Math.round(item.durationMs),
      errorCategory: item.errorCategory,
    })),
  }, null, 2))
  if (!dryRun && result.batch && (result.batch.status === 'COMPLETED' || result.batch.status === 'COMPLETED_WITH_ERRORS')) {
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
  if (result.batch?.status === 'FAILED') process.exitCode = 1
}

main().catch((error) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error))
  process.exitCode = 1
})
