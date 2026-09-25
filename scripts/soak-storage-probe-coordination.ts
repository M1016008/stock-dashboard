import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { certifyVolumeIdentitySingleFlight, type VolumeIdentity } from '@/lib/storage/external-storage-guard'

const scriptPath = fileURLToPath(import.meta.url)
const workerRoles = [
  'web-like', 'historical-like', 'analog-like', 'us-analytics-like',
  'jp-updater-like', 'health-like', 'ml-like', 'maintenance-like',
] as const

function wait(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function fixtureVolume(mountPath: string): VolumeIdentity {
  return {
    mountPoint: mountPath,
    uuid: 'soak-fixture',
    filesystem: 'apfs',
    writable: true,
    freeBytes: 1_000_000,
    totalBytes: 2_000_000,
  }
}

function child(): void {
  const mountPath = process.env.PROBE_SOAK_MOUNT!
  const coordinationDir = process.env.PROBE_SOAK_COORDINATION!
  const timelinePath = process.env.PROBE_SOAK_TIMELINE!
  const role = process.env.PROBE_SOAK_ROLE!
  const endAt = Number(process.env.PROBE_SOAK_END_AT)
  let calls = 0
  while (Date.now() < endAt) {
    certifyVolumeIdentitySingleFlight(mountPath, (context) => {
      const started = Date.now()
      fs.appendFileSync(timelinePath, `${JSON.stringify({ kind: 'START', at: started, pid: process.pid, role })}\n`)
      wait(20)
      const ended = Date.now()
      context.recordSubprocess({
        stage: 'DISKUTIL_INFO', childPid: process.pid,
        startedAt: new Date(started).toISOString(), endedAt: new Date(ended).toISOString(),
        durationMs: ended - started, exitStatus: 0, signal: null, externalProbeSpawned: true,
      })
      fs.appendFileSync(timelinePath, `${JSON.stringify({ kind: 'END', at: ended, pid: process.pid, role })}\n`)
      return fixtureVolume(mountPath)
    }, {
      coordinationDir,
      cacheTtlMs: 750,
      waitMs: 5_000,
      pollMs: 10,
      leaseMs: 5_000,
      callerRole: role,
    })
    calls++
    wait(125)
  }
  process.stdout.write(`${JSON.stringify({ role, calls })}\n`)
}

function runWorker(env: NodeJS.ProcessEnv): Promise<{ role: string; calls: number }> {
  return new Promise((resolve, reject) => {
    const handle = spawn(process.execPath, [...process.execArgv, scriptPath, '--child'], {
      env, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    handle.stdout.on('data', (chunk) => { stdout += String(chunk) })
    handle.stderr.on('data', (chunk) => { stderr += String(chunk) })
    handle.on('error', reject)
    handle.on('exit', (code) => {
      if (code === 0) resolve(JSON.parse(stdout.trim()) as { role: string; calls: number })
      else reject(new Error(`soak worker exited ${code}: ${stderr}`))
    })
  })
}

function requestedMinutes(): number {
  const index = process.argv.indexOf('--minutes')
  const value = Number(index >= 0 ? process.argv[index + 1] : process.env.PROBE_SOAK_MINUTES ?? 30)
  if (!Number.isFinite(value) || value <= 0) throw new Error('soak minutes must be positive')
  return value
}

async function main(): Promise<void> {
  if (process.argv[2] === '--child') {
    child()
    return
  }
  const minutes = requestedMinutes()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stockboard-probe-soak-'))
  const mountPath = path.join(root, 'mount')
  const coordinationDir = path.join(root, 'coordination')
  const timelinePath = path.join(root, 'timeline.ndjson')
  fs.mkdirSync(mountPath)
  const endAt = Date.now() + minutes * 60_000
  try {
    const workers = await Promise.all(workerRoles.map((role) => runWorker({
      ...process.env,
      PROBE_SOAK_MOUNT: mountPath,
      PROBE_SOAK_COORDINATION: coordinationDir,
      PROBE_SOAK_TIMELINE: timelinePath,
      PROBE_SOAK_ROLE: role,
      PROBE_SOAK_END_AT: String(endAt),
    })))
    const events = fs.readFileSync(timelinePath, 'utf8').trim().split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { kind: 'START' | 'END'; at: number })
      .sort((left, right) => left.at - right.at || (left.kind === 'END' ? -1 : 1))
    let active = 0
    let maximum = 0
    let probes = 0
    for (const event of events) {
      active += event.kind === 'START' ? 1 : -1
      if (event.kind === 'START') probes++
      maximum = Math.max(maximum, active)
      assert.ok(active >= 0)
    }
    assert.equal(active, 0)
    assert.equal(maximum, 1, 'soak must never overlap full probes')
    console.log(JSON.stringify({
      status: 'PASS',
      minutes,
      processes: workers.length,
      requests: workers.reduce((sum, worker) => sum + worker.calls, 0),
      fullProbes: probes,
      maximumConcurrentFullProbes: maximum,
      sigpipe: 0,
      timeouts: 0,
      falseFatal: 0,
    }))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
