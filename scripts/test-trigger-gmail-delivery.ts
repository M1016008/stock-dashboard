import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { buildNotificationMime } from '@/lib/notification-email'
import { ensureReady, execAll, execGet, execRun } from '@/lib/db/client'
import {
  deliverNotificationOutboxItem,
  getNotificationDeliveryPreview,
  NotificationDeliveryServiceError,
} from '@/lib/server/notification-delivery'
import {
  GmailNotificationDeliveryAdapter,
  NotificationDeliveryAdapterError,
  type NotificationDeliveryAdapter,
} from '@/lib/server/notification-delivery-adapter'
import {
  NotificationDeliveryProfileError,
  upsertGmailDeliveryProfile,
} from '@/lib/server/notification-delivery-profiles'
import type { SecretStore } from '@/lib/server/macos-keychain'

const fixturePrefix = `gmail-test-${randomUUID()}`
const profileId = `${fixturePrefix}-profile`
const batchIds: string[] = []
const outboxIds: string[] = []

function fakeAdapter(input?: {
  error?: NotificationDeliveryAdapterError | Error
  delayMs?: number
  calls?: { value: number }
}): NotificationDeliveryAdapter {
  return {
    provider: 'GMAIL',
    deliver: async () => {
      if (input?.calls) input.calls.value += 1
      if (input?.delayMs) await new Promise((resolve) => setTimeout(resolve, input.delayMs))
      if (input?.error) throw input.error
      return {
        provider: 'GMAIL',
        providerMessageId: `message-${randomUUID()}`,
        providerThreadId: `thread-${randomUUID()}`,
        tokenRefreshMs: 0.4,
        providerSendMs: 0.6,
      }
    },
  }
}

async function createOutbox(label: string): Promise<string> {
  const batchId = randomUUID()
  const outboxId = randomUUID()
  batchIds.push(batchId)
  outboxIds.push(outboxId)
  await execRun(`INSERT INTO trigger_evaluation_batches (
    id, source, requested_as_of, resolved_as_of, status, completed_at
  ) VALUES (?, ?, '2097-01-01', '2097-01-01', 'COMPLETED', unixepoch())`, [
    batchId, `${fixturePrefix}-${label}`,
  ])
  await execRun(`INSERT INTO notification_outbox (
    id, batch_id, notification_type, status, notification_policy_version,
    dedupe_key, subject, text_body, html_body, payload_json,
    created_at, ready_at, send_attempt_count
  ) VALUES (?, ?, 'DAILY_DIGEST', 'PENDING', 1, ?, ?, ?, ?, '{}', unixepoch(), unixepoch(), 0)`, [
    outboxId,
    batchId,
    `${fixturePrefix}:${label}`,
    `日本語件名 ${label}`,
    `Stage 日 4/3｜週 2/1｜月 1/1 | /stock/7003 | /trigger-discovery`,
    '<p><a href="/stock/7003">7003</a> <a href="/trigger-discovery">Trigger</a></p>',
  ])
  return outboxId
}

async function status(id: string): Promise<{
  status: string
  send_attempt_count: number
  delivery_retryable: number | null
  last_error_category: string | null
  text_body: string
  html_body: string
  payload_json: string
}> {
  return (await execGet(`SELECT status, send_attempt_count, delivery_retryable,
    last_error_category, text_body, html_body, payload_json
    FROM notification_outbox WHERE id=?`, [id]))!
}

async function cleanup(): Promise<void> {
  if (outboxIds.length) {
    const marks = outboxIds.map(() => '?').join(',')
    await execRun(`DELETE FROM notification_delivery_attempts WHERE outbox_id IN (${marks})`, outboxIds)
    await execRun(`DELETE FROM notification_outbox WHERE id IN (${marks})`, outboxIds)
  }
  await execRun('DELETE FROM notification_delivery_profiles WHERE id=?', [profileId])
  if (batchIds.length) {
    await execRun(`DELETE FROM trigger_evaluation_batches WHERE id IN (${batchIds.map(() => '?').join(',')})`, batchIds)
  }
}

async function main(): Promise<void> {
  await ensureReady()
  await cleanup().catch(() => undefined)
  try {
    const disabledProfile = await upsertGmailDeliveryProfile({
      id: profileId,
      recipientEmail: 'delivery-fixture@example.test',
      baseUrl: 'https://stockboard.example.test',
    })
    assert.equal(disabledProfile.enabled, false)
    const successId = await createOutbox('success')
    const disabledCalls = { value: 0 }
    await assert.rejects(
      () => deliverNotificationOutboxItem({ outboxId: successId, profileId }, {
        adapterFactory: () => fakeAdapter({ calls: disabledCalls }),
      }),
      (error: unknown) => error instanceof NotificationDeliveryProfileError
        && error.category === 'PROFILE_DISABLED',
    )
    assert.equal(disabledCalls.value, 0)
    assert.equal((await status(successId)).status, 'PENDING')
    const profile = await upsertGmailDeliveryProfile({
      id: profileId,
      recipientEmail: disabledProfile.recipientEmail,
      baseUrl: disabledProfile.baseUrl,
      enabled: true,
    })
    assert.equal(profile.enabled, true)

    const mime = buildNotificationMime({
      outboxId: '00000000-0000-4000-8000-000000000001',
      dedupeKey: 'trigger-notification:fixture:DAILY_DIGEST:v1',
      recipientEmail: profile.recipientEmail,
      baseUrl: profile.baseUrl,
      subject: '日本語件名',
      textBody: 'Stage 日 4/3｜週 2/1｜月 1/1 /stock/7003',
      htmlBody: '<a href="/stock/7003">銘柄</a>',
      createdAt: '2026-09-11T00:00:00.000Z',
    })
    assert.match(mime.mime, /Content-Type: multipart\/alternative/)
    assert.match(mime.mime, /Content-Type: text\/plain; charset=UTF-8/)
    assert.match(mime.mime, /Content-Type: text\/html; charset=UTF-8/)
    assert.match(mime.mime, /Subject: =\?UTF-8\?B\?/)
    assert.match(mime.mime, /X-Trigger-Outbox-Id:/)
    assert.match(mime.textBody, /https:\/\/stockboard\.example\.test\/stock\/7003/)
    assert.match(mime.htmlBody, /href="https:\/\/stockboard\.example\.test\/stock\/7003"/)
    assert.match(mime.textBody, /日 4\/3｜週 2\/1｜月 1\/1/)
    assert.match(mime.rawBase64Url, /^[A-Za-z0-9_-]+$/)
    assert.equal(mime.mime.includes('\nFrom:'), false)

    const original = await status(successId)
    const successCalls = { value: 0 }
    const successStartedAt = performance.now()
    const delivered = await deliverNotificationOutboxItem({ outboxId: successId, profileId }, {
      adapterFactory: () => fakeAdapter({ calls: successCalls }),
      now: () => Date.parse('2026-09-11T01:00:00.000Z'),
    })
    const measuredSuccessMs = performance.now() - successStartedAt
    assert.equal(delivered.status, 'SENT')
    assert.equal(delivered.disposition, 'DELIVERED')
    assert.equal(successCalls.value, 1)
    const afterSuccess = await status(successId)
    assert.equal(afterSuccess.send_attempt_count, 1)
    assert.equal(afterSuccess.text_body, original.text_body)
    assert.equal(afterSuccess.html_body, original.html_body)
    assert.equal(afterSuccess.payload_json, original.payload_json)
    const sentAgain = await deliverNotificationOutboxItem({ outboxId: successId, profileId }, {
      adapterFactory: () => { throw new Error('adapter must not be created for SENT') },
    })
    assert.equal(sentAgain.disposition, 'ALREADY_SENT')
    assert.equal((await status(successId)).send_attempt_count, 1)

    const authId = await createOutbox('auth')
    const authResult = await deliverNotificationOutboxItem({ outboxId: authId, profileId }, {
      adapterFactory: () => fakeAdapter({
        error: new NotificationDeliveryAdapterError('AUTH_REQUIRED', false, false),
      }),
    })
    assert.equal(authResult.status, 'FAILED')
    assert.equal(authResult.errorCategory, 'AUTH_REQUIRED')
    assert.equal(authResult.retryable, false)

    const explicitFailureId = await createOutbox('rate-limit')
    const explicitFailure = await deliverNotificationOutboxItem({ outboxId: explicitFailureId, profileId }, {
      adapterFactory: () => fakeAdapter({
        error: new NotificationDeliveryAdapterError('RATE_LIMITED', true, false),
      }),
    })
    assert.equal(explicitFailure.status, 'FAILED')
    assert.equal(explicitFailure.retryable, true)
    await assert.rejects(
      () => deliverNotificationOutboxItem({ outboxId: explicitFailureId, profileId }),
      (error: unknown) => error instanceof NotificationDeliveryServiceError
        && error.category === 'FAILED_RETRY_NOT_CONFIRMED',
    )

    const unknownId = await createOutbox('unknown')
    const unknownResult = await deliverNotificationOutboxItem({ outboxId: unknownId, profileId }, {
      adapterFactory: () => fakeAdapter({ error: new Error('synthetic connection reset') }),
    })
    assert.equal(unknownResult.status, 'DELIVERY_UNKNOWN')
    assert.equal(unknownResult.retryable, false)
    await assert.rejects(
      () => deliverNotificationOutboxItem({ outboxId: unknownId, profileId }),
      (error: unknown) => error instanceof NotificationDeliveryServiceError
        && error.category === 'UNKNOWN_RETRY_NOT_CONFIRMED',
    )

    const concurrentId = await createOutbox('concurrent')
    const concurrentCalls = { value: 0 }
    const concurrentAdapter = fakeAdapter({ delayMs: 30, calls: concurrentCalls })
    const concurrent = await Promise.all([
      deliverNotificationOutboxItem({ outboxId: concurrentId, profileId }, {
        adapterFactory: () => concurrentAdapter,
      }),
      deliverNotificationOutboxItem({ outboxId: concurrentId, profileId }, {
        adapterFactory: () => concurrentAdapter,
      }),
    ])
    assert.equal(concurrentCalls.value, 1)
    assert.equal(concurrent.some((row) => row.disposition === 'DELIVERED'), true)
    assert.equal(concurrent.some((row) => row.disposition === 'NOT_CLAIMED'), true)
    assert.equal((await status(concurrentId)).send_attempt_count, 1)

    const preview = await getNotificationDeliveryPreview({ outboxId: successId, profileId })
    assert.equal(preview.recipientEmail, profile.recipientEmail)
    assert.equal(preview.profileEnabled, true)

    const syntheticRefreshToken = `fixture-${randomBytes(24).toString('base64url')}`
    const syntheticAccessToken = `fixture-${randomBytes(24).toString('base64url')}`
    const store: SecretStore = {
      get: async () => syntheticRefreshToken,
      set: async () => undefined,
    }
    let gmailRequests = 0
    const gmailAdapter = new GmailNotificationDeliveryAdapter({
      config: { clientId: 'fixture.apps.googleusercontent.com', clientSecret: randomBytes(20).toString('base64url') },
      refreshTokenStore: store,
      tokenTransport: {
        fetch: async () => Response.json({ access_token: syntheticAccessToken, expires_in: 3600 }),
      },
      gmailTransport: {
        fetch: async (url, init) => {
          gmailRequests += 1
          assert.equal(String(url), 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send')
          assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${syntheticAccessToken}`)
          assert.equal(typeof JSON.parse(String(init?.body)).raw, 'string')
          return Response.json({ id: 'provider-message', threadId: 'provider-thread' })
        },
      },
    })
    const adapterResult = await gmailAdapter.deliver({ rawBase64Url: mime.rawBase64Url })
    assert.equal(adapterResult.providerMessageId, 'provider-message')
    assert.equal(gmailRequests, 1)

    const capturedLogs: string[] = []
    const originalError = console.error
    const originalLog = console.log
    console.error = (...values: unknown[]) => { capturedLogs.push(values.map(String).join(' ')) }
    console.log = (...values: unknown[]) => { capturedLogs.push(values.map(String).join(' ')) }
    let ambiguousError: unknown
    try {
      const ambiguousAdapter = new GmailNotificationDeliveryAdapter({
        config: { clientId: 'fixture.apps.googleusercontent.com', clientSecret: randomBytes(20).toString('base64url') },
        refreshTokenStore: store,
        tokenTransport: {
          fetch: async () => Response.json({ access_token: syntheticAccessToken, expires_in: 3600 }),
        },
        gmailTransport: {
          fetch: async () => { throw new Error(`connection reset ${syntheticAccessToken}`) },
        },
      })
      await ambiguousAdapter.deliver({ rawBase64Url: mime.rawBase64Url })
    } catch (error) {
      ambiguousError = error
    } finally {
      console.error = originalError
      console.log = originalLog
    }
    assert.equal(
      ambiguousError instanceof NotificationDeliveryAdapterError
        && ambiguousError.category === 'DELIVERY_UNKNOWN'
        && ambiguousError.outcomeUnknown,
      true,
    )
    assert.equal(capturedLogs.join('\n').includes(syntheticRefreshToken), false)
    assert.equal(capturedLogs.join('\n').includes(syntheticAccessToken), false)
    assert.equal(String(ambiguousError).includes(syntheticAccessToken), false)

    const explicitAdapter = new GmailNotificationDeliveryAdapter({
      config: { clientId: 'fixture.apps.googleusercontent.com', clientSecret: randomBytes(20).toString('base64url') },
      refreshTokenStore: store,
      tokenTransport: {
        fetch: async () => Response.json({ access_token: syntheticAccessToken, expires_in: 3600 }),
      },
      gmailTransport: {
        fetch: async () => Response.json({ error: { errors: [{ reason: 'rateLimitExceeded' }] } }, { status: 429 }),
      },
    })
    await assert.rejects(
      () => explicitAdapter.deliver({ rawBase64Url: mime.rawBase64Url }),
      (error: unknown) => error instanceof NotificationDeliveryAdapterError
        && error.category === 'RATE_LIMITED' && error.retryable && !error.outcomeUnknown,
    )

    const insufficientPermissionAdapter = new GmailNotificationDeliveryAdapter({
      config: { clientId: 'fixture.apps.googleusercontent.com', clientSecret: randomBytes(20).toString('base64url') },
      refreshTokenStore: store,
      tokenTransport: {
        fetch: async () => Response.json({ access_token: syntheticAccessToken, expires_in: 3600 }),
      },
      gmailTransport: {
        fetch: async () => Response.json({
          error: { errors: [{ reason: 'insufficientPermissions' }] },
        }, { status: 403 }),
      },
    })
    await assert.rejects(
      () => insufficientPermissionAdapter.deliver({ rawBase64Url: mime.rawBase64Url }),
      (error: unknown) => error instanceof NotificationDeliveryAdapterError
        && error.category === 'AUTH_REQUIRED' && !error.retryable && !error.outcomeUnknown,
    )

    const storedRows = await execAll<Record<string, unknown>>(`
      SELECT id, status, last_error_category, provider_message_id, provider_thread_id
      FROM notification_outbox WHERE id IN (${outboxIds.map(() => '?').join(',')})
    `, outboxIds)
    const serializedRows = JSON.stringify(storedRows)
    assert.equal(serializedRows.includes(syntheticRefreshToken), false)
    assert.equal(serializedRows.includes(syntheticAccessToken), false)
    const attempts = await execGet<{ count: number }>(
      `SELECT COUNT(*) AS count FROM notification_delivery_attempts
       WHERE outbox_id IN (${outboxIds.map(() => '?').join(',')})`,
      outboxIds,
    )
    assert.equal(Number(attempts?.count), 5)

    console.log(JSON.stringify({
      mime: {
        multipartAlternative: true,
        japaneseSubject: true,
        relativeLinksAbsolutized: true,
        rawEncoding: 'base64url',
        sender: 'authenticated Gmail account; no spoofed From header',
      },
      stateTransitions: {
        success: 'PENDING -> SENDING -> SENT',
        auth: 'PENDING -> SENDING -> FAILED/AUTH_REQUIRED',
        ambiguous: 'PENDING -> SENDING -> DELIVERY_UNKNOWN',
        sentApiCallsOnReplay: 0,
        concurrentProviderCalls: concurrentCalls.value,
      },
      performanceBreakdownMs: Object.fromEntries(
        Object.entries(delivered.performance).map(([key, value]) => [key, Number(value.toFixed(3))]),
      ),
      measuredSuccessMs: Number(measuredSuccessMs.toFixed(3)),
      realGmailMessagesSent: 0,
    }, null, 2))
    console.log('Trigger Gmail MIME, adapter, state, concurrency, and secret tests passed')
  } finally {
    await cleanup()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error))
  process.exitCode = 1
})
