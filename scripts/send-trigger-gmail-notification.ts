import {
  deliverNotificationOutboxItem,
  getNotificationDeliveryPreview,
} from '@/lib/server/notification-delivery'
import { DEFAULT_GMAIL_DELIVERY_PROFILE_ID } from '@/lib/server/notification-delivery-profiles'

function argument(name: string): string | undefined {
  const prefix = `--${name}=`
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length)
}

async function main(): Promise<void> {
  const outboxId = argument('outbox-id')
  if (!outboxId) throw new Error('--outbox-id is required')
  const profileId = argument('profile-id') ?? DEFAULT_GMAIL_DELIVERY_PROFILE_ID
  const preview = await getNotificationDeliveryPreview({ outboxId, profileId })
  console.log(JSON.stringify({
    outboxId: preview.outboxId,
    notificationType: preview.notificationType,
    status: preview.status,
    recipient: preview.recipientEmail,
    subject: preview.subject,
    profileId: preview.profileId,
    profileEnabled: preview.profileEnabled,
    willSend: process.argv.includes('--confirm-send'),
  }, null, 2))
  if (!process.argv.includes('--confirm-send')) {
    console.log('送信していません。実送信には --confirm-send が必要です。')
    return
  }
  const result = await deliverNotificationOutboxItem({
    outboxId,
    profileId,
    allowFailedRetry: process.argv.includes('--retry-failed'),
    allowUnknownRetry: process.argv.includes('--confirm-unknown-resend'),
  })
  console.log(JSON.stringify({
    outboxId: result.outboxId,
    status: result.status,
    disposition: result.disposition,
    provider: result.provider,
    providerMessageId: result.providerMessageId,
    providerThreadId: result.providerThreadId,
    attemptNumber: result.attemptNumber,
    errorCategory: result.errorCategory,
    retryable: result.retryable,
    performance: result.performance,
  }, null, 2))
  if (result.status === 'FAILED' || result.status === 'DELIVERY_UNKNOWN') process.exitCode = 1
}

main().catch((error) => {
  const category = error && typeof error === 'object' && 'category' in error
    ? String(error.category)
    : 'MANUAL_DELIVERY_FAILED'
  console.error(`Gmail delivery failed: ${category}`)
  process.exitCode = 1
})
