import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { NextRequest } from 'next/server'
import { createIsolatedRuntimeEnvironment } from '@/lib/runtime/isolation'
import { proxy } from '@/proxy'

function response(args: {
  path: string
  hostname?: string
  headers?: Record<string, string>
  environment?: Record<string, string | undefined>
}) {
  const previous = { ...process.env }
  try {
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, args.environment ?? {})
    return proxy(new NextRequest(`http://${args.hostname ?? '127.0.0.1'}:3001${args.path}`, {
      headers: args.headers,
    }))
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, previous)
  }
}

const realPath = '/api/research/six-stage/event-paths'
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'stockboard-six-stage-isolation-'))
const realEnvironment = createIsolatedRuntimeEnvironment('test', temporary, {
  ...process.env,
  SIX_STAGE_REAL_RESEARCH_ONLY: '1',
})
const fixtureEnvironment = createIsolatedRuntimeEnvironment('test', temporary, {
  ...process.env,
  STOCKBOARD_FIXTURE_ONLY: '1',
})

try {
  assert.equal(response({ path: realPath }).status, 404)
  assert.equal(response({ path: realPath, environment: { SIX_STAGE_REAL_RESEARCH_ONLY: '1' } }).status, 404)
  assert.equal(response({ path: realPath, environment: realEnvironment }).status, 200)
  assert.equal(response({ path: realPath, environment: realEnvironment, headers: { 'x-forwarded-for': '127.0.0.1', 'x-forwarded-host': '127.0.0.1:3001' } }).status, 200)
  assert.equal(response({ path: realPath, hostname: 'stock.marketframe.jp', environment: realEnvironment }).status, 404)
  assert.equal(response({ path: realPath, environment: realEnvironment, headers: { 'cf-ray': 'fixture' } }).status, 404)
  assert.equal(response({ path: realPath, environment: realEnvironment, headers: { 'forwarded': 'host=stock.marketframe.jp' } }).status, 404)
  assert.equal(response({ path: realPath, environment: realEnvironment, headers: { 'x-forwarded-for': '203.0.113.9' } }).status, 404)
  assert.equal(response({ path: realPath, environment: realEnvironment, headers: { 'x-real-ip': '203.0.113.9' } }).status, 404)
  assert.equal(response({ path: realPath, environment: realEnvironment, headers: { 'x-forwarded-host': '127.0.0.1, stock.marketframe.jp' } }).status, 404)
  assert.equal(response({ path: realPath, environment: { ...realEnvironment, STOCKBOARD_SHARE_MODE: '1' } }).status, 404)
  assert.equal(response({ path: realPath, environment: { ...realEnvironment, STOCKBOARD_ISOLATION_ATTESTED: '0' } }).status, 404)
  assert.equal(response({ path: realPath, environment: { ...realEnvironment, STOCK_DATA_VOLUME_UUID: 'spoofed' } }).status, 404)
  assert.equal(response({ path: realPath, environment: { ...realEnvironment, NODE_ENV: 'production' } }).status, 404)
  assert.equal(response({ path: '/dev/six-stage-event-matching', environment: fixtureEnvironment }).status, 200)
  assert.equal(response({ path: '/api/research/six-stage/current-projection', environment: fixtureEnvironment }).status, 200)
  assert.equal(response({ path: '/api/research/six-stage/current-projection', hostname: 'stock.marketframe.jp', environment: fixtureEnvironment }).status, 404)
  assert.equal(response({ path: realPath, environment: fixtureEnvironment }).status, 404)

  const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }
  assert.match(packageJson.scripts.dev, /-H 127\.0\.0\.1/)
  assert.match(packageJson.scripts['dev:3000'], /-H 127\.0\.0\.1/)
  assert.match(packageJson.scripts['share:start'], /-H 127\.0\.0\.1/)
} finally {
  fs.rmSync(temporary, { recursive: true, force: true })
}

console.log('six-stage research route isolation: PASS')
