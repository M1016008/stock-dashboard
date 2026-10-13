import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import { once } from 'node:events'
import { createFriendReadonlyGateway, friendReadonlyDecision } from '@/lib/friend-readonly-gateway'

async function port(server: http.Server): Promise<number> {
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return address.port
}

async function main() {
  const installer = fs.readFileSync('scripts/install-local-friend-readonly-gateway.ts', 'utf8')
  assert.match(installer, /com\.stockboard\.friend-readonly-gateway/)
  assert.match(installer, /const host = '127\.0\.0\.1'/)
  assert.match(installer, /const origin = 'http:\/\/127\.0\.0\.1:3000'/)
  assert.match(installer, /<key>KeepAlive<\/key><true\/>/)
  assert.doesNotMatch(installer, /cloudflared|allowed-mail|token/)

  const originRequests: Array<{ method: string; path: string; headers: http.IncomingHttpHeaders; body: string }> = []
  const origin = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      originRequests.push({
        method: request.method ?? '',
        path: request.url ?? '',
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, path: request.url }))
    })
  })
  origin.listen(0, '127.0.0.1')
  await once(origin, 'listening')
  const originPort = await port(origin)

  const gateway = createFriendReadonlyGateway({
    host: '127.0.0.1',
    port: 3136,
    origin: new URL(`http://127.0.0.1:${originPort}`),
  })
  gateway.listen(0, '127.0.0.1')
  await once(gateway, 'listening')
  const gatewayPort = await port(gateway)
  const base = `http://127.0.0.1:${gatewayPort}`

  try {
  const deepLink = await fetch(`${base}/stock/6098?tab=overview`, {
    headers: { authorization: 'secret', cookie: 'private=1', 'cf-access-jwt-assertion': 'private' },
  })
  assert.equal(deepLink.status, 200)
  assert.equal(originRequests.length, 1)
  assert.equal(originRequests[0].path, '/stock/6098?tab=overview')
  assert.equal(originRequests[0].headers.authorization, undefined)
  assert.equal(originRequests[0].headers.cookie, undefined)
  assert.equal(originRequests[0].headers['cf-access-jwt-assertion'], undefined)
  assert.equal(originRequests[0].headers['x-stockboard-access-mode'], 'friend-read-only')

  const head = await fetch(`${base}/api/health`, { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(originRequests.length, 2)

  const searchBody = JSON.stringify({ requestedAsOf: '2026-10-08', timeframe: 'MONTHLY' })
  const search = await fetch(`${base}/api/trigger-discovery/search?source=friend`, {
    method: 'POST',
    headers: {
      authorization: 'secret',
      cookie: 'private=1',
      'cf-access-jwt-assertion': 'private',
      'content-type': 'application/json',
    },
    body: searchBody,
  })
  assert.equal(search.status, 200)
  assert.equal(originRequests.length, 3)
  assert.equal(originRequests[2].path, '/api/trigger-discovery/search?source=friend')
  assert.equal(originRequests[2].body, searchBody)
  assert.equal(originRequests[2].headers.authorization, undefined)
  assert.equal(originRequests[2].headers.cookie, undefined)
  assert.equal(originRequests[2].headers['cf-access-jwt-assertion'], undefined)
  assert.equal(originRequests[2].headers['x-stockboard-access-mode'], 'friend-read-only')

  const miniChartsBody = JSON.stringify({ tickers: ['6098'], requestedAsOf: '2026-10-08' })
  const miniCharts = await fetch(`${base}/api/trigger-discovery/mini-charts`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: miniChartsBody,
  })
  assert.equal(miniCharts.status, 200)
  assert.equal(originRequests.length, 4)
  assert.equal(originRequests[3].body, miniChartsBody)

  for (const path of [
    '/api/chart-drill/answer',
    '/api/custom-charts/evaluate',
    '/api/integrated-screener',
    '/api/integrated-screener/reason',
    '/api/trigger-discovery/historical-scan',
    '/api/trigger-discovery/outcome-segment-comparisons',
  ]) {
    const response = await fetch(`${base}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })
    assert.equal(response.status, 200, `${path} read transport must be forwarded`)
  }
  assert.equal(originRequests.length, 10)

  for (const path of [
    '/api/us/trigger-discovery/search',
    '/api/us/trigger-discovery/mini-charts',
  ]) {
    const response = await fetch(`${base}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })
    assert.equal(response.status, 200, `${path} US read transport must be forwarded`)
  }
  assert.equal(originRequests.length, 12)

  const wrongContentType = await fetch(`${base}/api/trigger-discovery/search`, {
    method: 'POST', headers: { 'content-type': 'text/plain' }, body: searchBody,
  })
  assert.equal(wrongContentType.status, 415)
  assert.equal(originRequests.length, 12)

  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    const response = await fetch(`${base}/api/trigger-discovery/saved`, { method })
    assert.equal(response.status, 405, `${method} must be blocked`)
  }
  const nearMatch = await fetch(`${base}/api/trigger-discovery/search/extra`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: searchBody,
  })
  assert.equal(nearMatch.status, 405)
  assert.equal(originRequests.length, 12, 'Mutating requests must not reach the origin')

  for (const path of [
    '/admin/db',
    '/large-holders/admin/entities',
    '/api/admin/update-latest',
    '/api/large-holders/admin/health',
    '/%61dmin/db',
    '/large-holders/%61dmin/entities',
    '/%2561dmin/db',
    '/safe/../admin/db',
  ]) {
    const response = await fetch(`${base}${path}`)
    assert.equal(response.status, 404, `${path} must be hidden`)
  }
  assert.equal(originRequests.length, 12, 'Private paths must not reach the origin')

  assert.deepEqual(friendReadonlyDecision('POST', '/stock/6098'), {
    allowed: false, status: 405, code: 'READ_ONLY_ACCESS',
  })
  assert.deepEqual(friendReadonlyDecision('TRACE', '/stock/6098'), {
    allowed: false, status: 405, code: 'READ_ONLY_ACCESS',
  })
  assert.deepEqual(friendReadonlyDecision('POST', '/api/trigger-discovery/search?source=friend'), {
    allowed: true,
    pathname: '/api/trigger-discovery/search?source=friend',
    forwardJsonBody: true,
  })
  assert.deepEqual(friendReadonlyDecision('POST', '/api/trigger-discovery/saved'), {
    allowed: false, status: 405, code: 'READ_ONLY_ACCESS',
  })
  assert.deepEqual(friendReadonlyDecision('POST', '/api/us/trigger-discovery/search'), {
    allowed: true,
    pathname: '/api/us/trigger-discovery/search',
    forwardJsonBody: true,
  })
  assert.deepEqual(friendReadonlyDecision('POST', '/api/us/trigger-discovery/mini-charts'), {
    allowed: true,
    pathname: '/api/us/trigger-discovery/mini-charts',
    forwardJsonBody: true,
  })
  assert.throws(() => createFriendReadonlyGateway({
    host: '0.0.0.0', port: 3136, origin: new URL('http://127.0.0.1:3000'),
  }), /must_bind_loopback/)
  assert.throws(() => createFriendReadonlyGateway({
    host: '127.0.0.1', port: 3136, origin: new URL('http://192.168.1.10:3000'),
  }), /origin_must_be_loopback/)
    console.log('friend read-only gateway: PASS (safe reads forwarded, writes/admin/upgrade fail closed)')
  } finally {
    gateway.close()
    origin.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
