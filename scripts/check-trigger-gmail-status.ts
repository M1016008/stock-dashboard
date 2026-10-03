import {
  createGmailRefreshTokenStore,
  getGmailOAuthClientConfig,
  gmailRefreshTokenAccount,
  GmailOAuthError,
  refreshGmailAccessToken,
} from '@/lib/server/gmail-oauth'

async function main(): Promise<void> {
  let config
  try {
    config = getGmailOAuthClientConfig()
  } catch {
    console.log(JSON.stringify({
      credentialConfigured: false,
      refreshTokenExists: false,
      tokenRefreshable: false,
      status: 'CONFIG_REQUIRED',
    }, null, 2))
    return
  }
  const store = createGmailRefreshTokenStore()
  const refreshToken = await store.get(gmailRefreshTokenAccount(config.clientId))
  if (!refreshToken) {
    console.log(JSON.stringify({
      credentialConfigured: true,
      refreshTokenExists: false,
      tokenRefreshable: false,
      status: 'AUTH_REQUIRED',
    }, null, 2))
    return
  }
  try {
    const result = await refreshGmailAccessToken({ config, refreshToken })
    console.log(JSON.stringify({
      credentialConfigured: true,
      refreshTokenExists: true,
      tokenRefreshable: true,
      expiresInSeconds: result.expiresInSeconds,
      status: 'READY',
    }, null, 2))
  } catch (error) {
    console.log(JSON.stringify({
      credentialConfigured: true,
      refreshTokenExists: true,
      tokenRefreshable: false,
      status: error instanceof GmailOAuthError ? error.category : 'TOKEN_REFRESH_FAILED',
    }, null, 2))
    process.exitCode = 1
  }
}

main().catch(() => {
  console.error('Gmail status check failed: STATUS_CHECK_FAILED')
  process.exitCode = 1
})
