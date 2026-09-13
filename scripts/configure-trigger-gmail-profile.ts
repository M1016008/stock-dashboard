import {
  DEFAULT_GMAIL_DELIVERY_PROFILE_ID,
  upsertGmailDeliveryProfile,
} from '@/lib/server/notification-delivery-profiles'

function argument(name: string): string | undefined {
  const prefix = `--${name}=`
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length)
}

async function main(): Promise<void> {
  const recipientEmail = argument('recipient')
  const baseUrl = argument('base-url')
  if (!recipientEmail || !baseUrl) throw new Error('--recipient and --base-url are required')
  if (process.argv.includes('--enable') && process.argv.includes('--disable')) {
    throw new Error('--enable and --disable cannot be used together')
  }
  const enabled = process.argv.includes('--enable')
    ? true
    : process.argv.includes('--disable') ? false : undefined
  const profile = await upsertGmailDeliveryProfile({
    id: argument('profile-id') ?? DEFAULT_GMAIL_DELIVERY_PROFILE_ID,
    recipientEmail,
    baseUrl,
    enabled,
  })
  console.log(JSON.stringify({
    id: profile.id,
    provider: profile.provider,
    recipientEmail: profile.recipientEmail,
    enabled: profile.enabled,
    baseUrl: profile.baseUrl,
    oauthTokenStoredInDatabase: false,
  }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Delivery profile configuration failed')
  process.exitCode = 1
})
