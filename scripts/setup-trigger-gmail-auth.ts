import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import {
  buildGmailAuthorizationUrl,
  createGmailOAuthState,
  createGmailPkcePair,
  createGmailRefreshTokenStore,
  exchangeGmailAuthorizationCode,
  getGmailOAuthClientConfig,
  gmailRefreshTokenAccount,
  GmailOAuthError,
  parseGmailOAuthCallback,
} from '@/lib/server/gmail-oauth'

const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('callback_server_address_unavailable'))
      resolve(address.port)
    })
  })
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

function openSystemBrowser(url: string): void {
  if (process.platform !== 'darwin') throw new Error('gmail_auth_requires_macos')
  const child = spawn('/usr/bin/open', [url], { detached: true, stdio: 'ignore' })
  child.unref()
}

async function main(): Promise<void> {
  const config = getGmailOAuthClientConfig()
  const state = createGmailOAuthState()
  const pkce = createGmailPkcePair()
  let settle: ((value: string) => void) | null = null
  let rejectCallback: ((error: Error) => void) | null = null
  const callback = new Promise<string>((resolve, reject) => {
    settle = resolve
    rejectCallback = reject
  })
  const server = createServer((request, response) => {
    if (!request.url?.startsWith('/oauth2/callback')) {
      response.writeHead(404).end('Not found')
      return
    }
    try {
      const callbackUrl = new URL(request.url, 'http://127.0.0.1')
      const code = parseGmailOAuthCallback(callbackUrl.toString(), state)
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end('<!doctype html><meta charset="utf-8"><title>Gmail認証完了</title><p>認証を受け付けました。この画面を閉じてターミナルへ戻ってください。</p>')
      settle?.(code)
    } catch (error) {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end('OAuth callback could not be validated.')
      rejectCallback?.(error instanceof Error ? error : new Error('oauth_callback_failed'))
    }
  })
  const port = await listen(server)
  const redirectUri = `http://127.0.0.1:${port}/oauth2/callback`
  const authorizationUrl = buildGmailAuthorizationUrl({
    clientId: config.clientId,
    redirectUri,
    state,
    codeChallenge: pkce.challenge,
  })
  console.log('System browserでGoogle認証を開きます。要求権限はGmail送信のみです。')
  openSystemBrowser(authorizationUrl)
  let timer: NodeJS.Timeout | undefined
  try {
    const code = await Promise.race([
      callback,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('oauth_callback_timeout')), CALLBACK_TIMEOUT_MS)
      }),
    ])
    const token = await exchangeGmailAuthorizationCode({
      config,
      code,
      codeVerifier: pkce.verifier,
      redirectUri,
    })
    const store = createGmailRefreshTokenStore()
    await store.set(gmailRefreshTokenAccount(config.clientId), token.refreshToken)
    console.log('Gmail送信用refresh tokenをmacOS Keychainへ保存しました。')
    console.log('Delivery Profileは自動で有効化されません。')
  } finally {
    if (timer) clearTimeout(timer)
    await close(server)
  }
}

main().catch((error) => {
  const category = error instanceof GmailOAuthError ? error.category : 'GMAIL_AUTH_SETUP_FAILED'
  console.error(`Gmail OAuth setup failed: ${category}`)
  process.exitCode = 1
})
