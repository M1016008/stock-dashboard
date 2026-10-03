import { composeTriggerNotificationsForBatch } from '@/lib/server/trigger-notification-composition'

function argument(name: string): string | undefined {
  const prefix = `--${name}=`
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length)
}

async function main(): Promise<void> {
  const batchId = argument('batch-id')
  if (!batchId) throw new Error('--batch-id is required')
  const result = await composeTriggerNotificationsForBatch({ batchId })
  console.log(JSON.stringify({
    batchId: result.batchId,
    resolvedAsOf: result.resolvedAsOf,
    policyVersion: result.notificationPolicyVersion,
    createdCount: result.createdCount,
    reusedCount: result.reusedCount,
    performance: result.performance,
  }, null, 2))
  for (const notification of result.notifications) {
    console.log(`\n=== ${notification.notificationType} / ${notification.status} ===`)
    console.log(notification.subject)
    console.log(notification.textBody)
    console.log('\n--- HTML ---')
    console.log(notification.htmlBody)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
