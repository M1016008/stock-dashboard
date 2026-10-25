import assert from 'node:assert/strict'
import fs from 'node:fs'
import { NextRequest } from 'next/server'
import { proxy } from '@/proxy'

function response(args: {
  path: string
  hostname?: string
  headers?: Record<string, string>
  environment?: Record<string, string | undefined>
}) {
  const previous = { ...process.env }
  try {
    for (const key of [
      'NODE_ENV',
      'STOCKBOARD_RUNTIME_SCOPE',
      'SIX_STAGE_REAL_RESEARCH_ONLY',
      'STOCKBOARD_FIXTURE_ONLY',
    ]) delete process.env[key]
    Object.assign(process.env, args.environment ?? {})
    return proxy(new NextRequest(`http://${args.hostname ?? '127.0.0.1'}:3001${args.path}`, {
      headers: args.headers,
    }))
  } finally {
    process.env = previous
  }
}

const realPath = '/api/research/six-stage/event-paths'
const realEnvironment = {
  NODE_ENV: 'development',
  STOCKBOARD_RUNTIME_SCOPE: 'development',
  SIX_STAGE_REAL_RESEARCH_ONLY: '1',
}

assert.equal(response({ path: realPath }).status, 404)
assert.equal(response({ path: realPath, environment: { SIX_STAGE_REAL_RESEARCH_ONLY: '1' } }).status, 404)
assert.equal(response({ path: realPath, environment: realEnvironment }).status, 200)
assert.equal(response({ path: realPath, hostname: 'stock.marketframe.jp', environment: realEnvironment }).status, 404)
assert.equal(response({ path: realPath, environment: realEnvironment, headers: { 'cf-ray': 'fixture' } }).status, 404)
assert.equal(response({ path: realPath, environment: realEnvironment, headers: { 'x-forwarded-host': 'stock.marketframe.jp' } }).status, 404)
assert.equal(response({ path: realPath, environment: { ...realEnvironment, NODE_ENV: 'production' } }).status, 404)
assert.equal(response({
  path: '/dev/six-stage-event-matching',
  environment: {
    NODE_ENV: 'development',
    STOCKBOARD_RUNTIME_SCOPE: 'development',
    STOCKBOARD_FIXTURE_ONLY: '1',
  },
}).status, 200)
assert.equal(response({
  path: realPath,
  environment: {
    NODE_ENV: 'development',
    STOCKBOARD_RUNTIME_SCOPE: 'development',
    STOCKBOARD_FIXTURE_ONLY: '1',
  },
}).status, 404)

const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }
assert.match(packageJson.scripts.dev, /-H 127\.0\.0\.1/)
assert.match(packageJson.scripts['dev:3000'], /-H 127\.0\.0\.1/)
assert.match(packageJson.scripts['share:start'], /-H 127\.0\.0\.1/)

console.log('six-stage research route isolation: PASS')
