import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { MacOsKeychainSecretStore, type SecretStore } from '@/lib/server/macos-keychain'

export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send' as const
export const GMAIL_OAUTH_AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth' as const
export const GMAIL_OAUTH_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token' as const
export const GMAIL_KEYCHAIN_SERVICE = 'com.stockboard.trigger-gmail' as const

export type GmailOAuthErrorCategory =
  | 'CONFIG_REQUIRED'
  | 'AUTH_REQUIRED'
  | 'RATE_LIMITED'
  | 'TEMPORARY_PROVIDER_ERROR'
  | 'PERMANENT_PROVIDER_ERROR'
  | 'STATE_MISMATCH'
  | 'OAUTH_CALLBACK_ERROR'
  | 'REFRESH_TOKEN_MISSING'

export class GmailOAuthError extends Error {
  constructor(
    public readonly category: GmailOAuthErrorCategory,
    public readonly retryable: boolean,
  ) {
    super(category)
    this.name = 'GmailOAuthError'
  }
}

export interface GmailOAuthClientConfig {
  clientId: string
  clientSecret: string
}

export interface GmailPkcePair {
  verifier: string
  challenge: string
}

export interface GmailOAuthTokenTransport {
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>
}

const defaultTransport: GmailOAuthTokenTransport = { fetch: globalThis.fetch.bind(globalThis) }

export function getGmailOAuthClientConfig(
  env: NodeJS.ProcessEnv = process.env,
): GmailOAuthClientConfig {
  const clientId = env.TRIGGER_GMAIL_OAUTH_CLIENT_ID?.trim()
  const clientSecret = env.TRIGGER_GMAIL_OAUTH_CLIENT_SECRET?.trim()
  if (!clientId || !clientSecret) throw new GmailOAuthError('CONFIG_REQUIRED', false)
  return { clientId, clientSecret }
}

export function gmailRefreshTokenAccount(clientId: string): string {
  return `gmail-send-${createHash('sha256').update(clientId).digest('hex').slice(0, 20)}`
}

export function createGmailRefreshTokenStore(): SecretStore {
  return new MacOsKeychainSecretStore(GMAIL_KEYCHAIN_SERVICE)
}

export function createGmailPkcePair(): GmailPkcePair {
  const verifier = randomBytes(64).toString('base64url')
  const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url')
  return { verifier, challenge }
}

export function createGmailOAuthState(): string {
  return randomBytes(32).toString('base64url')
}

export function buildGmailAuthorizationUrl(input: {
  clientId: string
  redirectUri: string
  state: string
  codeChallenge: string
}): string {
  const url = new URL(GMAIL_OAUTH_AUTHORIZATION_ENDPOINT)
  url.searchParams.set('client_id', input.clientId)
  url.searchParams.set('redirect_uri', input.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', GMAIL_SEND_SCOPE)
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'consent')
  url.searchParams.set('state', input.state)
  url.searchParams.set('code_challenge', input.codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  return url.toString()
}

function equalState(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual)
  const expectedBytes = Buffer.from(expected)
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
}

export function parseGmailOAuthCallback(callbackUrl: string, expectedState: string): string {
  const url = new URL(callbackUrl)
  const state = url.searchParams.get('state') ?? ''
  if (!equalState(state, expectedState)) throw new GmailOAuthError('STATE_MISMATCH', false)
  if (url.searchParams.has('error')) throw new GmailOAuthError('OAUTH_CALLBACK_ERROR', false)
  const code = url.searchParams.get('code')
  if (!code) throw new GmailOAuthError('OAUTH_CALLBACK_ERROR', false)
  return code
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

function tokenEndpointError(status: number, body: Record<string, unknown>): GmailOAuthError {
  if (body.error === 'invalid_grant' || body.error === 'invalid_client' || status === 401) {
    return new GmailOAuthError('AUTH_REQUIRED', false)
  }
  if (status === 429) return new GmailOAuthError('RATE_LIMITED', true)
  if (status >= 500) return new GmailOAuthError('TEMPORARY_PROVIDER_ERROR', true)
  return new GmailOAuthError('PERMANENT_PROVIDER_ERROR', false)
}

async function postTokenForm(
  form: URLSearchParams,
  transport: GmailOAuthTokenTransport,
): Promise<Record<string, unknown>> {
  let response: Response
  try {
    response = await transport.fetch(GMAIL_OAUTH_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    })
  } catch {
    throw new GmailOAuthError('TEMPORARY_PROVIDER_ERROR', true)
  }
  const body = await safeJson(response)
  if (!response.ok) throw tokenEndpointError(response.status, body)
  return body
}

export async function exchangeGmailAuthorizationCode(input: {
  config: GmailOAuthClientConfig
  code: string
  codeVerifier: string
  redirectUri: string
  transport?: GmailOAuthTokenTransport
}): Promise<{ refreshToken: string }> {
  const body = await postTokenForm(new URLSearchParams({
    client_id: input.config.clientId,
    client_secret: input.config.clientSecret,
    code: input.code,
    code_verifier: input.codeVerifier,
    redirect_uri: input.redirectUri,
    grant_type: 'authorization_code',
  }), input.transport ?? defaultTransport)
  const refreshToken = typeof body.refresh_token === 'string' ? body.refresh_token : ''
  if (!refreshToken) throw new GmailOAuthError('REFRESH_TOKEN_MISSING', false)
  return { refreshToken }
}

export async function refreshGmailAccessToken(input: {
  config: GmailOAuthClientConfig
  refreshToken: string
  transport?: GmailOAuthTokenTransport
}): Promise<{ accessToken: string; expiresInSeconds: number | null }> {
  const body = await postTokenForm(new URLSearchParams({
    client_id: input.config.clientId,
    client_secret: input.config.clientSecret,
    refresh_token: input.refreshToken,
    grant_type: 'refresh_token',
  }), input.transport ?? defaultTransport)
  const accessToken = typeof body.access_token === 'string' ? body.access_token : ''
  if (!accessToken) throw new GmailOAuthError('AUTH_REQUIRED', false)
  return {
    accessToken,
    expiresInSeconds: typeof body.expires_in === 'number' ? body.expires_in : null,
  }
}
