import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type { InValue, Transaction } from '@libsql/client'
import { buildNotificationMime } from '@/lib/notification-email'
import { client, ensureReady, execGet } from '@/lib/db/client'
import {
  createGmailRefreshTokenStore,
  getGmailOAuthClientConfig,
} from '@/lib/server/gmail-oauth'
import {
  GmailNotificationDeliveryAdapter,
  NotificationDeliveryAdapterError,
  type NotificationDeliveryAdapter,
  type NotificationDeliveryErrorCategory,
} from '@/lib/server/notification-delivery-adapter'
import {
  getEnabledNotificationDeliveryProfile,
  getNotificationDeliveryProfile,
  type NotificationDeliveryProfile,
} from '@/lib/server/notification-delivery-profiles'
import type { TriggerNotificationOutboxStatus, TriggerNotificationType } from '@/lib/trigger-notification'

type OutboxDeliveryRow = {
  id: string
  batch_id: string
  notification_type: TriggerNotificationType
  status: TriggerNotificationOutboxStatus
  dedupe_key: string
  subject: string
  text_body: string
  html_body: string
  created_at: number
  send_attempt_count: number
  sent_at: number | null
  delivery_profile_id: string | null
  delivery_provider: string | null
  provider_message_id: string | null
  provider_thread_id: string | null
  delivery_retryable: number | null
  last_error_category: string | null
}

export interface NotificationDeliveryPreview {
  outboxId: string
  notificationType: TriggerNotificationType
  status: TriggerNotificationOutboxStatus
  subject: string
  profileId: string
  recipientEmail: string
  profileEnabled: boolean
  baseUrl: string
}

export interface NotificationDeliveryResult {
  outboxId: string
  status: TriggerNotificationOutboxStatus
  disposition: 'DELIVERED' | 'ALREADY_SENT' | 'NOT_CLAIMED' | 'FAILED' | 'DELIVERY_UNKNOWN'
  provider: 'GMAIL' | null
  providerMessageId: string | null
  providerThreadId: string | null
  attemptNumber: number
  errorCategory: NotificationDeliveryErrorCategory | null
  retryable: boolean | null
  performance: {
    outboxReadMs: number
    mimeGenerationMs: number
    tokenRefreshMs: number
    providerSendMs: number
    dbStatusUpdateMs: number
    totalMs: number
  }
}

export class NotificationDeliveryServiceError extends Error {
  constructor(public readonly category:
    | 'OUTBOX_NOT_FOUND'
    | 'OUTBOX_CANCELLED'
    | 'FAILED_RETRY_NOT_CONFIRMED'
    | 'UNKNOWN_RETRY_NOT_CONFIRMED') {
    super(category)
    this.name = 'NotificationDeliveryServiceError'
  }
}

export interface NotificationDeliveryDependencies {
  adapterFactory?: (profile: NotificationDeliveryProfile) => NotificationDeliveryAdapter
  now?: () => number
}

function defaultAdapterFactory(): NotificationDeliveryAdapter {
  return new GmailNotificationDeliveryAdapter({
    config: getGmailOAuthClientConfig(),
    refreshTokenStore: createGmailRefreshTokenStore(),
  })
}

async function outbox(id: string): Promise<OutboxDeliveryRow> {
  const row = await execGet<OutboxDeliveryRow>(
    `SELECT id, batch_id, notification_type, status, dedupe_key, subject,
            text_body, html_body, created_at, send_attempt_count, sent_at,
            delivery_profile_id, delivery_provider, provider_message_id,
            provider_thread_id, delivery_retryable, last_error_category
     FROM notification_outbox WHERE id=?`,
    [id],
  )
  if (!row) throw new NotificationDeliveryServiceError('OUTBOX_NOT_FOUND')
  return row
}

function emptyPerformance(startedAt: number, outboxReadMs: number): NotificationDeliveryResult['performance'] {
  return {
    outboxReadMs,
    mimeGenerationMs: 0,
    tokenRefreshMs: 0,
    providerSendMs: 0,
    dbStatusUpdateMs: 0,
    totalMs: performance.now() - startedAt,
  }
}

function existingResult(
  row: OutboxDeliveryRow,
  startedAt: number,
  outboxReadMs: number,
): NotificationDeliveryResult {
  return {
    outboxId: row.id,
    status: row.status,
    disposition: row.status === 'SENT' ? 'ALREADY_SENT' : 'NOT_CLAIMED',
    provider: row.delivery_provider === 'GMAIL' ? 'GMAIL' : null,
    providerMessageId: row.provider_message_id,
    providerThreadId: row.provider_thread_id,
    attemptNumber: Number(row.send_attempt_count),
    errorCategory: row.last_error_category as NotificationDeliveryErrorCategory | null,
    retryable: row.delivery_retryable == null ? null : Boolean(row.delivery_retryable),
    performance: emptyPerformance(startedAt, outboxReadMs),
  }
}

export async function getNotificationDeliveryPreview(input: {
  outboxId: string
  profileId?: string
}): Promise<NotificationDeliveryPreview> {
  await ensureReady()
  const [row, profile] = await Promise.all([
    outbox(input.outboxId),
    getNotificationDeliveryProfile(input.profileId),
  ])
  return {
    outboxId: row.id,
    notificationType: row.notification_type,
    status: row.status,
    subject: row.subject,
    profileId: profile.id,
    recipientEmail: profile.recipientEmail,
    profileEnabled: profile.enabled,
    baseUrl: profile.baseUrl,
  }
}

async function rollbackQuietly(tx: Transaction): Promise<void> {
  await tx.rollback().catch(() => undefined)
  tx.close()
}

function isDatabaseBusy(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /SQLITE_BUSY|database is locked/i.test(message)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function withDeliveryWriteRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      if (!isDatabaseBusy(error) || attempt >= 7) throw error
      await sleep(Math.min(250, 15 * 2 ** attempt))
    }
  }
}

async function claimOutbox(input: {
  row: OutboxDeliveryRow
  profile: NotificationDeliveryProfile
  allowFailedRetry: boolean
  allowUnknownRetry: boolean
  nowSeconds: number
}): Promise<number | null> {
  const status = input.row.status
  if (status === 'CANCELLED') throw new NotificationDeliveryServiceError('OUTBOX_CANCELLED')
  if (status === 'FAILED' && (!input.allowFailedRetry || !Boolean(input.row.delivery_retryable))) {
    throw new NotificationDeliveryServiceError('FAILED_RETRY_NOT_CONFIRMED')
  }
  if (status === 'DELIVERY_UNKNOWN' && !input.allowUnknownRetry) {
    throw new NotificationDeliveryServiceError('UNKNOWN_RETRY_NOT_CONFIRMED')
  }
  if (status !== 'PENDING' && status !== 'FAILED' && status !== 'DELIVERY_UNKNOWN') return null

  return withDeliveryWriteRetry(async () => {
    const tx = await client.transaction('write')
    try {
      const claimed = await tx.execute({
        sql: `UPDATE notification_outbox SET
                status='SENDING', send_attempt_count=send_attempt_count+1,
                delivery_profile_id=?, delivery_provider='GMAIL',
                delivery_retryable=NULL, delivery_started_at=?, last_error_category=NULL
              WHERE id=? AND status=?`,
        args: [input.profile.id, input.nowSeconds, input.row.id, status] as InValue[],
      })
      if (Number(claimed.rowsAffected ?? 0) !== 1) {
        await rollbackQuietly(tx)
        return null
      }
      const current = await tx.execute({
        sql: 'SELECT send_attempt_count FROM notification_outbox WHERE id=?',
        args: [input.row.id],
      })
      const attemptNumber = Number(current.rows[0]?.send_attempt_count)
      if (!Number.isInteger(attemptNumber) || attemptNumber < 1) throw new Error('delivery_attempt_number_invalid')
      await tx.execute({
        sql: `INSERT INTO notification_delivery_attempts (
                id, outbox_id, delivery_profile_id, attempt_number, provider,
                started_at, status, duration_ms
              ) VALUES (?, ?, ?, ?, 'GMAIL', ?, 'SENDING', 0)`,
        args: [randomUUID(), input.row.id, input.profile.id, attemptNumber, input.nowSeconds] as InValue[],
      })
      await tx.commit()
      tx.close()
      return attemptNumber
    } catch (error) {
      await rollbackQuietly(tx)
      throw error
    }
  })
}

async function completeDelivery(input: {
  outboxId: string
  attemptNumber: number
  status: 'SENT' | 'FAILED' | 'DELIVERY_UNKNOWN'
  nowSeconds: number
  durationMs: number
  errorCategory: NotificationDeliveryErrorCategory | null
  retryable: boolean | null
  providerMessageId: string | null
  providerThreadId: string | null
}): Promise<void> {
  await withDeliveryWriteRetry(async () => {
    const tx = await client.transaction('write')
    try {
      await tx.execute({
      sql: `UPDATE notification_outbox SET
              status=?, sent_at=?, provider_message_id=?, provider_thread_id=?,
              delivery_retryable=?, last_error_category=?
            WHERE id=? AND status='SENDING' AND send_attempt_count=?`,
      args: [
        input.status,
        input.status === 'SENT' ? input.nowSeconds : null,
        input.providerMessageId,
        input.providerThreadId,
        input.retryable == null ? null : input.retryable ? 1 : 0,
        input.errorCategory,
        input.outboxId,
        input.attemptNumber,
      ] as InValue[],
    })
      await tx.execute({
      sql: `UPDATE notification_delivery_attempts SET
              completed_at=?, status=?, error_category=?, retryable=?,
              provider_message_id=?, provider_thread_id=?, duration_ms=?
            WHERE outbox_id=? AND attempt_number=? AND status='SENDING'`,
      args: [
        input.nowSeconds,
        input.status,
        input.errorCategory,
        input.retryable == null ? null : input.retryable ? 1 : 0,
        input.providerMessageId,
        input.providerThreadId,
        input.durationMs,
        input.outboxId,
        input.attemptNumber,
      ] as InValue[],
    })
      await tx.commit()
      tx.close()
    } catch (error) {
      await rollbackQuietly(tx)
      throw error
    }
  })
}

export async function deliverNotificationOutboxItem(input: {
  outboxId: string
  profileId?: string
  allowFailedRetry?: boolean
  allowUnknownRetry?: boolean
}, dependencies: NotificationDeliveryDependencies = {}): Promise<NotificationDeliveryResult> {
  const startedAt = performance.now()
  await ensureReady()
  const readStartedAt = performance.now()
  const initial = await outbox(input.outboxId)
  const outboxReadMs = performance.now() - readStartedAt
  if (initial.status === 'SENT' || initial.status === 'SENDING' || initial.status === 'CANCELLED') {
    if (initial.status === 'CANCELLED') throw new NotificationDeliveryServiceError('OUTBOX_CANCELLED')
    return existingResult(initial, startedAt, outboxReadMs)
  }
  if (initial.status === 'FAILED'
    && (!input.allowFailedRetry || !Boolean(initial.delivery_retryable))) {
    throw new NotificationDeliveryServiceError('FAILED_RETRY_NOT_CONFIRMED')
  }
  if (initial.status === 'DELIVERY_UNKNOWN' && !input.allowUnknownRetry) {
    throw new NotificationDeliveryServiceError('UNKNOWN_RETRY_NOT_CONFIRMED')
  }
  const profile = await getEnabledNotificationDeliveryProfile(input.profileId)
  const adapter = dependencies.adapterFactory?.(profile) ?? defaultAdapterFactory()

  const mimeStartedAt = performance.now()
  const mime = buildNotificationMime({
    outboxId: initial.id,
    dedupeKey: initial.dedupe_key,
    recipientEmail: profile.recipientEmail,
    baseUrl: profile.baseUrl,
    subject: initial.subject,
    textBody: initial.text_body,
    htmlBody: initial.html_body,
    createdAt: new Date(Number(initial.created_at) * 1000).toISOString(),
  })
  const mimeGenerationMs = performance.now() - mimeStartedAt
  const now = dependencies.now ?? Date.now
  const claimStartedAt = performance.now()
  const attemptNumber = await claimOutbox({
    row: initial,
    profile,
    allowFailedRetry: Boolean(input.allowFailedRetry),
    allowUnknownRetry: Boolean(input.allowUnknownRetry),
    nowSeconds: Math.floor(now() / 1000),
  })
  let dbStatusUpdateMs = performance.now() - claimStartedAt
  if (attemptNumber == null) {
    const current = await outbox(input.outboxId)
    return {
      ...existingResult(current, startedAt, outboxReadMs),
      performance: {
        ...emptyPerformance(startedAt, outboxReadMs),
        mimeGenerationMs,
        dbStatusUpdateMs,
      },
    }
  }

  const deliveryStartedAt = performance.now()
  try {
    const delivered = await adapter.deliver({ rawBase64Url: mime.rawBase64Url })
    const updateStartedAt = performance.now()
    await completeDelivery({
      outboxId: initial.id,
      attemptNumber,
      status: 'SENT',
      nowSeconds: Math.floor(now() / 1000),
      durationMs: performance.now() - deliveryStartedAt,
      errorCategory: null,
      retryable: null,
      providerMessageId: delivered.providerMessageId,
      providerThreadId: delivered.providerThreadId,
    })
    dbStatusUpdateMs += performance.now() - updateStartedAt
    return {
      outboxId: initial.id,
      status: 'SENT',
      disposition: 'DELIVERED',
      provider: delivered.provider,
      providerMessageId: delivered.providerMessageId,
      providerThreadId: delivered.providerThreadId,
      attemptNumber,
      errorCategory: null,
      retryable: null,
      performance: {
        outboxReadMs,
        mimeGenerationMs,
        tokenRefreshMs: delivered.tokenRefreshMs,
        providerSendMs: delivered.providerSendMs,
        dbStatusUpdateMs,
        totalMs: performance.now() - startedAt,
      },
    }
  } catch (error) {
    const normalized = error instanceof NotificationDeliveryAdapterError
      ? error
      : new NotificationDeliveryAdapterError('DELIVERY_UNKNOWN', false, true)
    const status = normalized.outcomeUnknown ? 'DELIVERY_UNKNOWN' : 'FAILED'
    const updateStartedAt = performance.now()
    await completeDelivery({
      outboxId: initial.id,
      attemptNumber,
      status,
      nowSeconds: Math.floor(now() / 1000),
      durationMs: performance.now() - deliveryStartedAt,
      errorCategory: normalized.category,
      retryable: normalized.outcomeUnknown ? false : normalized.retryable,
      providerMessageId: null,
      providerThreadId: null,
    })
    dbStatusUpdateMs += performance.now() - updateStartedAt
    return {
      outboxId: initial.id,
      status,
      disposition: status,
      provider: 'GMAIL',
      providerMessageId: null,
      providerThreadId: null,
      attemptNumber,
      errorCategory: normalized.category,
      retryable: normalized.outcomeUnknown ? false : normalized.retryable,
      performance: {
        outboxReadMs,
        mimeGenerationMs,
        tokenRefreshMs: 0,
        providerSendMs: performance.now() - deliveryStartedAt,
        dbStatusUpdateMs,
        totalMs: performance.now() - startedAt,
      },
    }
  }
}
