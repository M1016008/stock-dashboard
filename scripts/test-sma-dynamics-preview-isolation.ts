import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import { proxy } from '@/proxy'

type RuntimeMode = 'development' | 'production'

function withRuntime<T>(mode: RuntimeMode, shareMode: boolean, run: () => T): T {
  const previousNodeEnv = process.env.NODE_ENV
  const previousShareMode = process.env.STOCKBOARD_SHARE_MODE
  Object.defineProperty(process.env, 'NODE_ENV', { configurable: true, enumerable: true, value: mode, writable: true })
  if (shareMode) process.env.STOCKBOARD_SHARE_MODE = '1'
  else delete process.env.STOCKBOARD_SHARE_MODE
  try {
    return run()
  } finally {
    if (previousNodeEnv === undefined) Reflect.deleteProperty(process.env, 'NODE_ENV')
    else Object.defineProperty(process.env, 'NODE_ENV', { configurable: true, enumerable: true, value: previousNodeEnv, writable: true })
    if (previousShareMode === undefined) Reflect.deleteProperty(process.env, 'STOCKBOARD_SHARE_MODE')
    else process.env.STOCKBOARD_SHARE_MODE = previousShareMode
  }
}

function request(path: string): NextRequest {
  return new NextRequest(new URL(path, 'http://127.0.0.1:3000'))
}

for (const path of ['/dev/sma-dynamics', '/dev/sma-dynamics/', '/dev/sma-dynamics?fixture=jp-rising']) {
  const production = withRuntime('production', false, () => proxy(request(path)))
  assert.equal(production.status, 404, `production rejects ${path}`)
  assert.equal(production.headers.get('cache-control'), 'no-store, no-cache, must-revalidate, max-age=0')

  const share = withRuntime('development', true, () => proxy(request(path)))
  assert.equal(share.status, 404, `share mode rejects ${path}`)
}

const development = withRuntime('development', false, () => proxy(request('/dev/sma-dynamics?fixture=jp-rising')))
assert.equal(development.status, 200, 'development keeps the fixture preview available')
assert.equal(development.headers.get('x-middleware-next'), '1', 'development continues to the fixture page')

console.log('test-sma-dynamics-preview-isolation: ok')
