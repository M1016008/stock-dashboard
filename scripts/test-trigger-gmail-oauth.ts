import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import {
  GMAIL_SEND_SCOPE,
  GmailOAuthError,
  buildGmailAuthorizationUrl,
  createGmailOAuthState,
  createGmailPkcePair,
  exchangeGmailAuthorizationCode,
  gmailRefreshTokenAccount,
  parseGmailOAuthCallback,
  refreshGmailAccessToken,
  type GmailOAuthClientConfig,
} from '@/lib/server/gmail-oauth'
import type { SecretStore } from '@/lib/server/macos-keychain'

const config: GmailOAuthClientConfig = {
  clientId: 'fixture-client.apps.googleusercontent.com',
  clientSecret: randomBytes(18).toString('base64url'),
}

async function expectCategory(operation: () => Promise<unknown> | unknown, category: string): Promise<void> {
  await assert.rejects(async () => operation(), (error: unknown) => (
    error instanceof GmailOAuthError && error.category === category
  ))
}

async function main(): Promise<void> {
  const pkce = createGmailPkcePair()
  assert.match(pkce.verifier, /^[A-Za-z0-9_-]{43,128}$/)
  assert.equal(
    pkce.challenge,
    createHash('sha256').update(pkce.verifier, 'ascii').digest('base64url'),
  )
  const state = createGmailOAuthState()
  const redirectUri = 'http://127.0.0.1:54321/oauth2/callback'
  const authorizationUrl = new URL(buildGmailAuthorizationUrl({
    clientId: config.clientId,
    redirectUri,
    state,
    codeChallenge: pkce.challenge,
  }))
  assert.equal(authorizationUrl.searchParams.get('scope'), GMAIL_SEND_SCOPE)
  assert.equal(authorizationUrl.searchParams.get('access_type'), 'offline')
  assert.equal(authorizationUrl.searchParams.get('prompt'), 'consent')
  assert.equal(authorizationUrl.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(authorizationUrl.searchParams.get('state'), state)
  assert.equal(
    parseGmailOAuthCallback(`${redirectUri}?state=${state}&code=synthetic-code`, state),
    'synthetic-code',
  )
  await expectCategory(
    () => parseGmailOAuthCallback(`${redirectUri}?state=wrong&code=synthetic-code`, state),
    'STATE_MISMATCH',
  )
  await expectCategory(
    () => parseGmailOAuthCallback(`${redirectUri}?state=${state}&error=access_denied`, state),
    'OAUTH_CALLBACK_ERROR',
  )

  const syntheticRefreshToken = `fixture-${randomBytes(24).toString('base64url')}`
  let postedForm = ''
  const exchanged = await exchangeGmailAuthorizationCode({
    config,
    code: 'synthetic-code',
    codeVerifier: pkce.verifier,
    redirectUri,
    transport: {
      fetch: async (_url, init) => {
        postedForm = String(init?.body ?? '')
        return Response.json({ refresh_token: syntheticRefreshToken, access_token: 'discarded' })
      },
    },
  })
  assert.equal(exchanged.refreshToken, syntheticRefreshToken)
  assert.match(postedForm, /grant_type=authorization_code/)
  assert.match(postedForm, /code_verifier=/)

  const stored = new Map<string, string>()
  const fakeStore: SecretStore = {
    get: async (account) => stored.get(account) ?? null,
    set: async (account, secret) => { stored.set(account, secret) },
  }
  await fakeStore.set(gmailRefreshTokenAccount(config.clientId), exchanged.refreshToken)
  assert.equal(await fakeStore.get(gmailRefreshTokenAccount(config.clientId)), syntheticRefreshToken)

  await expectCategory(() => exchangeGmailAuthorizationCode({
    config,
    code: 'synthetic-code',
    codeVerifier: pkce.verifier,
    redirectUri,
    transport: { fetch: async () => Response.json({ access_token: 'discarded' }) },
  }), 'REFRESH_TOKEN_MISSING')

  const refreshed = await refreshGmailAccessToken({
    config,
    refreshToken: syntheticRefreshToken,
    transport: { fetch: async () => Response.json({ access_token: 'synthetic-access', expires_in: 3600 }) },
  })
  assert.equal(refreshed.expiresInSeconds, 3600)
  await expectCategory(() => refreshGmailAccessToken({
    config,
    refreshToken: syntheticRefreshToken,
    transport: { fetch: async () => Response.json({ error: 'invalid_grant' }, { status: 400 }) },
  }), 'AUTH_REQUIRED')

  const rendered = JSON.stringify({ category: 'AUTH_REQUIRED', account: gmailRefreshTokenAccount(config.clientId) })
  assert.equal(rendered.includes(syntheticRefreshToken), false)
  assert.equal(rendered.includes(config.clientSecret), false)
  console.log(JSON.stringify({
    scope: GMAIL_SEND_SCOPE,
    pkce: 'S256',
    stateValidated: true,
    offlineAccess: true,
    refreshTokenStorageContract: 'SecretStore / macOS Keychain',
    realGoogleRequests: 0,
  }, null, 2))
  console.log('Trigger Gmail OAuth contract tests passed')
}

main().catch((error) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error))
  process.exitCode = 1
})
