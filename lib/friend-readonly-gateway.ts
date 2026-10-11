import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http'
import { URL } from 'node:url'
import {
  FRIEND_READ_ONLY_ACCESS_MODE,
  isFriendPrivatePath,
  isFriendReadonlyJsonPostPath,
} from '@/lib/friend-readonly-policy'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])
const READ_METHODS = new Set(['GET', 'HEAD'])
const MAX_READ_ONLY_JSON_BODY_BYTES = 512 * 1024
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])
const PRIVATE_REQUEST_HEADERS = new Set([
  'authorization',
  'cf-access-jwt-assertion',
  'cookie',
  'proxy-authorization',
])

export type FriendReadonlyGatewayOptions = {
  host: string
  port: number
  origin: URL
  requestTimeoutMs?: number
}

export type FriendReadonlyDecision =
  | { allowed: true; pathname: string; forwardJsonBody?: true }
  | { allowed: false; status: 404 | 405; code: 'NOT_FOUND' | 'READ_ONLY_ACCESS' }

function repeatedlyDecodePath(pathname: string): string | null {
  let decoded = pathname
  for (let index = 0; index < 4; index += 1) {
    try {
      const next = decodeURIComponent(decoded)
      if (next === decoded) return decoded
      decoded = next
    } catch {
      return null
    }
  }
  return decoded
}

function blockedPath(pathname: string): boolean {
  const decoded = repeatedlyDecodePath(pathname)
  if (!decoded) return true
  return isFriendPrivatePath(decoded)
}

export function friendReadonlyDecision(method: string | undefined, requestUrl: string | undefined): FriendReadonlyDecision {
  const normalizedMethod = (method ?? '').toUpperCase()
  let url: URL
  try {
    url = new URL(requestUrl ?? '/', 'http://friend-gateway.invalid')
  } catch {
    return { allowed: false, status: 404, code: 'NOT_FOUND' }
  }
  if (blockedPath(url.pathname)) return { allowed: false, status: 404, code: 'NOT_FOUND' }
  const pathname = `${url.pathname}${url.search}`
  if (READ_METHODS.has(normalizedMethod)) return { allowed: true, pathname }
  if (normalizedMethod === 'POST' && isFriendReadonlyJsonPostPath(url.pathname)) {
    return { allowed: true, pathname, forwardJsonBody: true }
  }
  return { allowed: false, status: 405, code: 'READ_ONLY_ACCESS' }
}

function validateOptions(options: FriendReadonlyGatewayOptions): void {
  if (!LOOPBACK_HOSTS.has(options.host)) throw new Error('friend_gateway_must_bind_loopback')
  if (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65_535) {
    throw new Error('friend_gateway_port_invalid')
  }
  if (options.origin.protocol !== 'http:' || !LOOPBACK_HOSTS.has(options.origin.hostname)) {
    throw new Error('friend_gateway_origin_must_be_loopback_http')
  }
  if (options.origin.username || options.origin.password || options.origin.pathname !== '/'
    || options.origin.search || options.origin.hash) {
    throw new Error('friend_gateway_origin_invalid')
  }
}

function forwardedHeaders(headers: IncomingHttpHeaders, origin: URL): IncomingHttpHeaders {
  const forwarded: IncomingHttpHeaders = {}
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(lower) || PRIVATE_REQUEST_HEADERS.has(lower)
      || lower.startsWith('cf-access-')) continue
    forwarded[lower] = value
  }
  forwarded.host = origin.host
  forwarded['x-stockboard-access-mode'] = FRIEND_READ_ONLY_ACCESS_MODE
  delete forwarded['content-length']
  return forwarded
}

function blockedResponse(response: ServerResponse, decision: Extract<FriendReadonlyDecision, { allowed: false }>): void {
  response.writeHead(decision.status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  })
  response.end(JSON.stringify({ error: decision.code }))
}

function errorResponse(response: ServerResponse, status: 400 | 413 | 415, code: string): void {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  })
  response.end(JSON.stringify({ error: code }))
}

export function createFriendReadonlyGateway(options: FriendReadonlyGatewayOptions): http.Server {
  validateOptions(options)
  const timeoutMs = Math.max(5_000, Math.min(options.requestTimeoutMs ?? 60_000, 120_000))
  const server = http.createServer((request: IncomingMessage, response: ServerResponse) => {
    const decision = friendReadonlyDecision(request.method, request.url)
    if (!decision.allowed) {
      request.resume()
      blockedResponse(response, decision)
      return
    }

    const forward = (body?: Buffer) => {
      const headers = forwardedHeaders(request.headers, options.origin)
      if (body) headers['content-length'] = String(body.byteLength)
      const upstream = http.request({
        protocol: options.origin.protocol,
        hostname: options.origin.hostname,
        port: options.origin.port,
        method: request.method,
        path: decision.pathname,
        headers,
        timeout: timeoutMs,
      }, (originResponse) => {
        const responseHeaders = { ...originResponse.headers }
        for (const header of HOP_BY_HOP_HEADERS) delete responseHeaders[header]
        response.writeHead(originResponse.statusCode ?? 502, responseHeaders)
        originResponse.pipe(response)
      })

      upstream.on('timeout', () => upstream.destroy(new Error('friend_gateway_origin_timeout')))
      upstream.on('error', () => {
        if (response.headersSent) response.destroy()
        else {
          response.writeHead(502, {
            'cache-control': 'no-store',
            'content-type': 'application/json; charset=utf-8',
            'x-content-type-options': 'nosniff',
          })
          response.end(JSON.stringify({ error: 'ORIGIN_UNAVAILABLE' }))
        }
      })
      upstream.end(body)
    }

    if (!decision.forwardJsonBody) {
      // GET and HEAD never need a request body. Discard opaque bytes rather
      // than forwarding them to an origin handler.
      request.resume()
      forward()
      return
    }

    const contentType = String(request.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase()
    if (contentType !== 'application/json') {
      request.resume()
      errorResponse(response, 415, 'JSON_BODY_REQUIRED')
      return
    }
    const chunks: Buffer[] = []
    let totalBytes = 0
    let bodyTooLarge = false
    request.on('data', (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      totalBytes += bytes.byteLength
      if (totalBytes > MAX_READ_ONLY_JSON_BODY_BYTES) bodyTooLarge = true
      else if (!bodyTooLarge) chunks.push(bytes)
    })
    request.on('end', () => {
      if (bodyTooLarge) {
        errorResponse(response, 413, 'REQUEST_BODY_TOO_LARGE')
        return
      }
      const body = Buffer.concat(chunks)
      try {
        JSON.parse(body.toString('utf8'))
      } catch {
        errorResponse(response, 400, 'INVALID_JSON')
        return
      }
      forward(body)
    })
    request.on('error', () => {
      if (!response.headersSent) errorResponse(response, 400, 'REQUEST_BODY_UNAVAILABLE')
    })
  })
  server.on('upgrade', (_request, socket) => socket.destroy())
  return server
}

export function friendReadonlyGatewayOptionsFromEnvironment(env: NodeJS.ProcessEnv = process.env): FriendReadonlyGatewayOptions {
  const host = env.STOCKBOARD_FRIEND_GATEWAY_HOST?.trim() || '127.0.0.1'
  const port = Number(env.STOCKBOARD_FRIEND_GATEWAY_PORT ?? 3136)
  const origin = new URL(env.STOCKBOARD_FRIEND_ORIGIN?.trim() || 'http://127.0.0.1:3000')
  return { host, port, origin }
}
