import { ensureReady, execGet, execRun } from '@/lib/db/client'
import {
  normalizeNotificationBaseUrl,
  normalizeNotificationRecipient,
} from '@/lib/notification-email'

export const DEFAULT_GMAIL_DELIVERY_PROFILE_ID = 'gmail-default' as const

type ProfileRow = {
  id: string
  provider: string
  recipient_email: string
  enabled: number
  base_url: string
  created_at: number
  updated_at: number
}

export interface NotificationDeliveryProfile {
  id: string
  provider: 'GMAIL'
  recipientEmail: string
  enabled: boolean
  baseUrl: string
  createdAt: string
  updatedAt: string
}

export class NotificationDeliveryProfileError extends Error {
  constructor(public readonly category: 'INVALID_PROFILE' | 'PROFILE_NOT_FOUND' | 'PROFILE_DISABLED') {
    super(category)
    this.name = 'NotificationDeliveryProfileError'
  }
}

function validateId(value: string): string {
  const id = value.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) {
    throw new NotificationDeliveryProfileError('INVALID_PROFILE')
  }
  return id
}

function profile(row: ProfileRow): NotificationDeliveryProfile {
  if (row.provider !== 'GMAIL') throw new NotificationDeliveryProfileError('INVALID_PROFILE')
  return {
    id: row.id,
    provider: 'GMAIL',
    recipientEmail: row.recipient_email,
    enabled: Boolean(row.enabled),
    baseUrl: row.base_url,
    createdAt: new Date(Number(row.created_at) * 1000).toISOString(),
    updatedAt: new Date(Number(row.updated_at) * 1000).toISOString(),
  }
}

export async function getNotificationDeliveryProfile(
  id: string = DEFAULT_GMAIL_DELIVERY_PROFILE_ID,
): Promise<NotificationDeliveryProfile> {
  await ensureReady()
  const row = await execGet<ProfileRow>(
    'SELECT * FROM notification_delivery_profiles WHERE id=?',
    [validateId(id)],
  )
  if (!row) throw new NotificationDeliveryProfileError('PROFILE_NOT_FOUND')
  return profile(row)
}

export async function getEnabledNotificationDeliveryProfile(
  id: string = DEFAULT_GMAIL_DELIVERY_PROFILE_ID,
): Promise<NotificationDeliveryProfile> {
  const value = await getNotificationDeliveryProfile(id)
  if (!value.enabled) throw new NotificationDeliveryProfileError('PROFILE_DISABLED')
  return value
}

export async function upsertGmailDeliveryProfile(input: {
  id?: string
  recipientEmail: string
  baseUrl: string
  enabled?: boolean
}): Promise<NotificationDeliveryProfile> {
  await ensureReady()
  const id = validateId(input.id ?? DEFAULT_GMAIL_DELIVERY_PROFILE_ID)
  const recipientEmail = normalizeNotificationRecipient(input.recipientEmail)
  const baseUrl = normalizeNotificationBaseUrl(input.baseUrl)
  const existing = await execGet<{ enabled: number }>(
    'SELECT enabled FROM notification_delivery_profiles WHERE id=?',
    [id],
  )
  const enabled = input.enabled ?? Boolean(existing?.enabled ?? 0)
  await execRun(`INSERT INTO notification_delivery_profiles (
      id, provider, recipient_email, enabled, base_url, created_at, updated_at
    ) VALUES (?, 'GMAIL', ?, ?, ?, unixepoch(), unixepoch())
    ON CONFLICT(id) DO UPDATE SET
      provider='GMAIL', recipient_email=excluded.recipient_email,
      enabled=excluded.enabled, base_url=excluded.base_url, updated_at=unixepoch()`, [
    id, recipientEmail, enabled ? 1 : 0, baseUrl,
  ])
  return getNotificationDeliveryProfile(id)
}
