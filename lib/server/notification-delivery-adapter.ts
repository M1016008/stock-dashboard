import { performance } from 'node:perf_hooks'
import {
  GmailOAuthError,
  gmailRefreshTokenAccount,
  refreshGmailAccessToken,
  type GmailOAuthClientConfig,
  type GmailOAuthTokenTransport,
} from '@/lib/server/gmail-oauth'
import type { SecretStore } from '@/lib/server/macos-keychain'

export type NotificationDeliveryErrorCategory =
  | 'AUTH_REQUIRED'
  | 'RATE_LIMITED'
  | 'TEMPORARY_PROVIDER_ERROR'
  | 'PERMANENT_PROVIDER_ERROR'
  | 'INVALID_MESSAGE'
  | 'DELIVERY_UNKNOWN'

export class NotificationDeliveryAdapterError extends Error {
  constructor(
    public readonly category: NotificationDeliveryErrorCategory,
    public readonly retryable: boolean,
    public readonly outcomeUnknown: boolean,
  ) {
    super(category)
    this.name = 'NotificationDeliveryAdapterError'
  }
}

export interface NotificationDeliveryAdapterInput {
  rawBase64Url: string
}

export interface NotificationDeliveryAdapterResult {
  provider: 'GMAIL'
  providerMessageId: string
  providerThreadId: string | null
  tokenRefreshMs: number
  providerSendMs: number
}

export interface NotificationDeliveryAdapter {
  readonly provider: 'GMAIL'
  deliver(input: NotificationDeliveryAdapterInput): Promise<NotificationDeliveryAdapterResult>
}

export interface GmailApiTransport {
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>
}

const defaultTransport: GmailApiTransport = { fetch: globalThis.fetch.bind(globalThis) }

function oauthDeliveryError(error: GmailOAuthError): NotificationDeliveryAdapterError {
  if (error.category === 'AUTH_REQUIRED' || error.category === 'REFRESH_TOKEN_MISSING'
    || error.category === 'CONFIG_REQUIRED') {
    return new NotificationDeliveryAdapterError('AUTH_REQUIRED', false, false)
  }
  if (error.category === 'RATE_LIMITED') {
    return new NotificationDeliveryAdapterError('RATE_LIMITED', true, false)
  }
  if (error.category === 'TEMPORARY_PROVIDER_ERROR') {
    return new NotificationDeliveryAdapterError('TEMPORARY_PROVIDER_ERROR', true, false)
  }
  return new NotificationDeliveryAdapterError('PERMANENT_PROVIDER_ERROR', false, false)
}

async function safeJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await response.json()
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function googleErrorReasons(body: Record<string, unknown>): string[] {
  const error = body.error
  if (!error || typeof error !== 'object' || Array.isArray(error)) return []
  const errors = (error as Record<string, unknown>).errors
  if (!Array.isArray(errors)) return []
  return errors.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
    const reason = (entry as Record<string, unknown>).reason
    return typeof reason === 'string' ? [reason] : []
  })
}

function explicitGmailFailure(status: number, body: Record<string, unknown>): NotificationDeliveryAdapterError {
  const reasons = googleErrorReasons(body)
  if (status === 401 || reasons.some((reason) => [
    'authError',
    'forbidden',
    'insufficientPermissions',
    'invalidCredentials',
  ].includes(reason))) {
    return new NotificationDeliveryAdapterError('AUTH_REQUIRED', false, false)
  }
  if (status === 429 || reasons.some((reason) => /rateLimit|quotaExceeded/i.test(reason))) {
    return new NotificationDeliveryAdapterError('RATE_LIMITED', true, false)
  }
  if (status >= 500 || status === 408) {
    return new NotificationDeliveryAdapterError('TEMPORARY_PROVIDER_ERROR', true, false)
  }
  if (status === 400 || status === 422) {
    return new NotificationDeliveryAdapterError('INVALID_MESSAGE', false, false)
  }
  return new NotificationDeliveryAdapterError('PERMANENT_PROVIDER_ERROR', false, false)
}

export class GmailNotificationDeliveryAdapter implements NotificationDeliveryAdapter {
  readonly provider = 'GMAIL' as const

  constructor(private readonly dependencies: {
    config: GmailOAuthClientConfig
    refreshTokenStore: SecretStore
    tokenTransport?: GmailOAuthTokenTransport
    gmailTransport?: GmailApiTransport
  }) {}

  async deliver(input: NotificationDeliveryAdapterInput): Promise<NotificationDeliveryAdapterResult> {
    const refreshStartedAt = performance.now()
    let refreshToken: string | null
    try {
      refreshToken = await this.dependencies.refreshTokenStore.get(
        gmailRefreshTokenAccount(this.dependencies.config.clientId),
      )
    } catch {
      throw new NotificationDeliveryAdapterError('AUTH_REQUIRED', false, false)
    }
    if (!refreshToken) throw new NotificationDeliveryAdapterError('AUTH_REQUIRED', false, false)
    let accessToken: string
    try {
      accessToken = (await refreshGmailAccessToken({
        config: this.dependencies.config,
        refreshToken,
        transport: this.dependencies.tokenTransport,
      })).accessToken
    } catch (error) {
      if (error instanceof GmailOAuthError) throw oauthDeliveryError(error)
      throw new NotificationDeliveryAdapterError('TEMPORARY_PROVIDER_ERROR', true, false)
    }
    const tokenRefreshMs = performance.now() - refreshStartedAt

    const sendStartedAt = performance.now()
    let response: Response
    try {
      response = await (this.dependencies.gmailTransport ?? defaultTransport).fetch(
        'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({ raw: input.rawBase64Url }),
        },
      )
    } catch {
      throw new NotificationDeliveryAdapterError('DELIVERY_UNKNOWN', false, true)
    }
    const body = await safeJson(response)
    if (!response.ok) throw explicitGmailFailure(response.status, body)
    const providerMessageId = typeof body.id === 'string' ? body.id : ''
    if (!providerMessageId) {
      throw new NotificationDeliveryAdapterError('DELIVERY_UNKNOWN', false, true)
    }
    return {
      provider: 'GMAIL',
      providerMessageId,
      providerThreadId: typeof body.threadId === 'string' ? body.threadId : null,
      tokenRefreshMs,
      providerSendMs: performance.now() - sendStartedAt,
    }
  }
}
