import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { buildFriendReadonlyGatewayRuntime } from '@/scripts/build-friend-readonly-gateway-runtime'

async function freePort(): Promise<number> {
  const server = net.createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const port = address.port
  server.close()
  await once(server, 'close')
  return port
}

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'friend-runtime-'))
  const output = path.join(root, 'output')
  const originPort = await freePort()
  const gatewayPort = await freePort()
  const originRequests: Array<{ method: string; url: string }> = []
  const gatewayEnvironment: NodeJS.ProcessEnv = {
    NODE_ENV: 'test',
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    STOCKBOARD_FRIEND_GATEWAY_HOST: '127.0.0.1',
    STOCKBOARD_FRIEND_GATEWAY_PORT: String(gatewayPort),
    STOCKBOARD_FRIEND_ORIGIN: `http://127.0.0.1:${originPort}`,
  }
  const origin = http.createServer((request, response) => {
    originRequests.push({ method: request.method ?? '', url: request.url ?? '' })
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ status: 'ok' }))
  })
  origin.listen(originPort, '127.0.0.1')
  await once(origin, 'listening')
  let child: ReturnType<typeof spawn> | null = null
  try {
    const built = await buildFriendReadonlyGatewayRuntime({
      outputDirectory: output,
      productionRuntimeRoot: path.join(root, 'production-runtime'),
      productionPlistPath: path.join(root, 'com.stockboard.friend-readonly-gateway.plist'),
      nodeExecutable: process.execPath,
      logDirectory: path.join(root, 'logs'),
    })
    const bundle = fs.readFileSync(built.bundlePath, 'utf8')
    const plist = fs.readFileSync(built.plistPath, 'utf8')
    assert.doesNotMatch(bundle, /from ['"]tsx|--import.{0,20}tsx/)
    assert.doesNotMatch(plist, /Worktree|worktree|node_modules|tsx/)
    assert.match(plist, /127\.0\.0\.1/)
    const firstChild = spawn(process.execPath, [built.bundlePath], {
      env: gatewayEnvironment,
      stdio: ['ignore', 'pipe', 'pipe'] as const,
    })
    child = firstChild
    await Promise.race([
      once(firstChild.stdout!, 'data'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('gateway_bundle_ready_timeout')), 10_000)),
    ])
    const health = await fetch(`http://127.0.0.1:${gatewayPort}/api/health`)
    assert.equal(health.status, 200)
    const head = await fetch(`http://127.0.0.1:${gatewayPort}/api/health`, { method: 'HEAD' })
    assert.equal(head.status, 200)
    const mutation = await fetch(`http://127.0.0.1:${gatewayPort}/api/health`, { method: 'POST' })
    assert.equal(mutation.status, 405)
    const privatePath = await fetch(`http://127.0.0.1:${gatewayPort}/api/admin/update-latest`)
    assert.equal(privatePath.status, 404)
    assert.deepEqual(originRequests.map((entry) => entry.method), ['GET', 'HEAD'])
    firstChild.kill('SIGTERM')
    await once(firstChild, 'close')
    const secondChild = spawn(process.execPath, [built.bundlePath], {
      env: gatewayEnvironment,
      stdio: ['ignore', 'pipe', 'pipe'] as const,
    })
    child = secondChild
    await Promise.race([
      once(secondChild.stdout!, 'data'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('gateway_bundle_restart_timeout')), 10_000)),
    ])
    assert.equal((await fetch(`http://127.0.0.1:${gatewayPort}/api/health`)).status, 200)
    console.log('Friend read-only immutable runtime regression: PASS (policy, no tsx, restart)')
  } finally {
    if (child && child.exitCode === null) child.kill('SIGKILL')
    origin.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
}

void main()
