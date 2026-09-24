import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  StorageUnavailableError,
  certifyVolumeIdentitySingleFlight,
  storageProbeCoordinationPaths,
  type ProbeCertificationContext,
  type VolumeIdentity,
} from '@/lib/storage/external-storage-guard'

const scriptPath = fileURLToPath(import.meta.url)
const roles = [
  'web-like', 'historical-like', 'analog-like', 'us-analytics-like',
  'jp-updater-like', 'health-like', 'ml-like', 'maintenance-like',
  'classification-like', 'earnings-like', 'freshness-like', 'weekly-like',
  'themes-like', 'news-like', 'monitor-like', 'worker-like',
] as const

type ChildResult = {
  ok: boolean
  pid: number
  role: string
  uuid?: string | null
  code?: string
  signal?: string | null
}

type TimelineEvent = {
  kind: 'START' | 'END'
  pid: number
  at: number
  role: string
  result?: string
}

function fixtureVolume(mountPath: string): VolumeIdentity {
  return {
    mountPoint: mountPath,
    uuid: 'single-flight-fixture',
    filesystem: 'apfs',
    writable: true,
    freeBytes: 1_000_000,
    totalBytes: 2_000_000,
  }
}

function wait(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function appendTimeline(filePath: string, event: TimelineEvent): void {
  fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`)
}

function simulatedProbe(context: ProbeCertificationContext, mountPath: string): VolumeIdentity {
  const timelinePath = process.env.PROBE_FIXTURE_TIMELINE!
  const role = process.env.PROBE_FIXTURE_ROLE!
  const behavior = process.env.PROBE_FIXTURE_BEHAVIOR ?? 'success'
  const started = Date.now()
  appendTimeline(timelinePath, { kind: 'START', pid: process.pid, at: started, role })
  wait(behavior === 'sigpipe-once' ? 160 : 120)

  let result = 'success'
  let signal: string | null = null
  try {
    if (behavior === 'persistent-failure') {
      result = 'persistent-failure'
      signal = 'SIGPIPE'
      throw new StorageUnavailableError('PROBE_FAILED', 'fixture persistent SIGPIPE', {
        probeStage: 'DISKUTIL_INFO', startedAt: new Date(started).toISOString(),
        durationMs: Date.now() - started, exitStatus: null, signal, stderr: null,
      })
    }
    if (behavior === 'sigpipe-once') {
      const marker = process.env.PROBE_FIXTURE_FAIL_ONCE!
      let descriptor: number | null = null
      try { descriptor = fs.openSync(marker, 'wx', 0o600) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      if (descriptor !== null) {
        fs.closeSync(descriptor)
        result = 'sigpipe'
        signal = 'SIGPIPE'
        throw new StorageUnavailableError('PROBE_FAILED', 'fixture owner SIGPIPE', {
          probeStage: 'DISKUTIL_INFO', startedAt: new Date(started).toISOString(),
          durationMs: Date.now() - started, exitStatus: null, signal, stderr: null,
        })
      }
    }
    return fixtureVolume(mountPath)
  } finally {
    const ended = Date.now()
    context.recordSubprocess({
      stage: 'DISKUTIL_INFO', childPid: process.pid,
      startedAt: new Date(started).toISOString(), endedAt: new Date(ended).toISOString(),
      durationMs: ended - started, exitStatus: signal ? null : 0,
      signal, externalProbeSpawned: true,
    })
    appendTimeline(timelinePath, { kind: 'END', pid: process.pid, at: ended, role, result })
  }
}

function child(): void {
  const mountPath = process.env.PROBE_FIXTURE_MOUNT!
  const coordinationDir = process.env.PROBE_FIXTURE_COORDINATION!
  const role = process.env.PROBE_FIXTURE_ROLE!
  fs.appendFileSync(process.env.PROBE_FIXTURE_READY!, `${process.pid}\n`)
  while (!fs.existsSync(process.env.PROBE_FIXTURE_GO!)) wait(5)
  let result: ChildResult
  try {
    const volume = certifyVolumeIdentitySingleFlight(
      mountPath,
      (context) => simulatedProbe(context, mountPath),
      {
        coordinationDir,
        cacheTtlMs: Number(process.env.PROBE_FIXTURE_CACHE_TTL ?? 10_000),
        waitMs: Number(process.env.PROBE_FIXTURE_WAIT_MS ?? 5_000),
        pollMs: 5,
        leaseMs: 5_000,
        callerRole: role,
      },
    )
    result = { ok: true, pid: process.pid, role, uuid: volume.uuid }
  } catch (error) {
    const unavailable = error instanceof StorageUnavailableError ? error : null
    result = {
      ok: false,
      pid: process.pid,
      role,
      code: unavailable?.storageCode ?? 'UNKNOWN',
      signal: unavailable?.probeDiagnostics?.signal ?? null,
    }
  }
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

function runChild(env: NodeJS.ProcessEnv): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const processHandle = spawn(process.execPath, [...process.execArgv, scriptPath, '--child'], {
      env, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    processHandle.stdout.on('data', (chunk) => { stdout += String(chunk) })
    processHandle.stderr.on('data', (chunk) => { stderr += String(chunk) })
    processHandle.on('error', reject)
    processHandle.on('exit', (code) => {
      if (code === 0) resolve(JSON.parse(stdout.trim()) as ChildResult)
      else reject(new Error(`single-flight child exited ${code}: ${stderr}`))
    })
  })
}

function readJsonLines<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return []
  return fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as T)
}

function maximumConcurrentProbes(events: TimelineEvent[]): number {
  const ordered = [...events].sort((left, right) => left.at - right.at || (left.kind === 'END' ? -1 : 1))
  let active = 0
  let maximum = 0
  for (const event of ordered) {
    active += event.kind === 'START' ? 1 : -1
    maximum = Math.max(maximum, active)
    assert.ok(active >= 0, 'probe timeline cannot end before it starts')
  }
  assert.equal(active, 0, 'all fixture probes must finish')
  return maximum
}

async function runScenario(
  root: string,
  name: string,
  callers: number,
  behavior: 'success' | 'sigpipe-once' | 'persistent-failure',
): Promise<{ results: ChildResult[]; probes: number; maxConcurrent: number; joins: number }> {
  const mountPath = path.join(root, 'mount')
  const coordinationDir = path.join(root, name)
  const timelinePath = path.join(root, `${name}-timeline.ndjson`)
  const failOncePath = path.join(root, `${name}-failed-once`)
  const readyPath = path.join(root, `${name}-ready`)
  const goPath = path.join(root, `${name}-go`)
  const pending = Array.from({ length: callers }, (_, index) => runChild({
    ...process.env,
    PROBE_FIXTURE_MOUNT: mountPath,
    PROBE_FIXTURE_COORDINATION: coordinationDir,
    PROBE_FIXTURE_TIMELINE: timelinePath,
    PROBE_FIXTURE_FAIL_ONCE: failOncePath,
    PROBE_FIXTURE_BEHAVIOR: behavior,
    PROBE_FIXTURE_ROLE: roles[index % roles.length],
    PROBE_FIXTURE_READY: readyPath,
    PROBE_FIXTURE_GO: goPath,
    PROBE_FIXTURE_WAIT_MS: behavior === 'persistent-failure' ? '1500' : '5000',
  }))
  const readyDeadline = Date.now() + 15_000
  while (Date.now() < readyDeadline) {
    const ready = fs.existsSync(readyPath)
      ? fs.readFileSync(readyPath, 'utf8').trim().split('\n').filter(Boolean).length
      : 0
    if (ready === callers) break
    wait(10)
  }
  const ready = fs.existsSync(readyPath)
    ? fs.readFileSync(readyPath, 'utf8').trim().split('\n').filter(Boolean).length
    : 0
  assert.equal(ready, callers, `${name}: all children must reach the start barrier`)
  fs.writeFileSync(goPath, 'go\n')
  const results = await Promise.all(pending)
  const timeline = readJsonLines<TimelineEvent>(timelinePath)
  const starts = timeline.filter((event) => event.kind === 'START')
  const telemetryPath = storageProbeCoordinationPaths(mountPath, coordinationDir).telemetryPath
  const telemetry = readJsonLines<{ event: string }>(telemetryPath)
  return {
    results,
    probes: starts.length,
    maxConcurrent: maximumConcurrentProbes(timeline),
    joins: telemetry.filter((event) => event.event === 'JOINED_RESULT').length,
  }
}

async function main(): Promise<void> {
  if (process.argv[2] === '--child') {
    child()
    return
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stockboard-probe-singleflight-'))
  const mountPath = path.join(root, 'mount')
  fs.mkdirSync(mountPath)
  try {
    const aliasPath = path.join(root, 'mount-alias')
    fs.symlinkSync(mountPath, aliasPath)
    const canonicalPaths = storageProbeCoordinationPaths(mountPath, path.join(root, 'canonical'))
    assert.deepEqual(
      storageProbeCoordinationPaths(`${mountPath}${path.sep}`, path.join(root, 'canonical')),
      canonicalPaths,
      'trailing slash must not split volume coordination',
    )
    assert.deepEqual(
      storageProbeCoordinationPaths(aliasPath, path.join(root, 'canonical')),
      canonicalPaths,
      'realpath aliases must not split volume coordination',
    )

    const staleMount = path.join(root, 'stale-owner-mount')
    const staleCoordination = path.join(root, 'stale-owner-coordination')
    fs.mkdirSync(staleMount)
    const stalePaths = storageProbeCoordinationPaths(staleMount, staleCoordination)
    fs.mkdirSync(path.dirname(stalePaths.lockPath), { recursive: true })
    fs.writeFileSync(stalePaths.lockPath, JSON.stringify({
      version: 2,
      requestId: 'stale-owner',
      volumeKey: 'stale-volume',
      pid: process.pid,
      processStartIdentity: 'different-process-start',
      acquiredAt: Date.now() - 60_000,
      leaseExpiresAt: Date.now() - 30_000,
    }))
    const staleTime = new Date(Date.now() - 60_000)
    fs.utimesSync(stalePaths.lockPath, staleTime, staleTime)
    assert.equal(certifyVolumeIdentitySingleFlight(
      staleMount,
      () => fixtureVolume(staleMount),
      { coordinationDir: staleCoordination, cacheTtlMs: 10_000, waitMs: 100, pollMs: 5 },
    ).uuid, 'single-flight-fixture', 'PID reuse must not preserve an expired owner lease')

    let fullProbes = 0
    let joins = 0
    let maximum = 0
    let totalCallers = 0
    for (let round = 0; round < 50; round++) {
      const callers = 8 + (round % 9)
      const scenario = await runScenario(root, `round-${round}`, callers, 'success')
      assert.ok(scenario.results.every((result) => result.ok && result.uuid === 'single-flight-fixture'))
      assert.equal(scenario.probes, 1, `round ${round}: callers must share one full certification`)
      assert.equal(scenario.maxConcurrent, 1, `round ${round}: full probes must never overlap`)
      assert.equal(scenario.joins, callers - 1, `round ${round}: every waiter must join the result`)
      totalCallers += callers
      fullProbes += scenario.probes
      joins += scenario.joins
      maximum = Math.max(maximum, scenario.maxConcurrent)
    }

    const sigpipe = await runScenario(root, 'sigpipe-injection', 8, 'sigpipe-once')
    assert.equal(sigpipe.maxConcurrent, 1, 'SIGPIPE recovery probes must remain serialized')
    assert.equal(sigpipe.probes, 2, 'one failed owner must be followed by one serialized successful owner')
    assert.equal(sigpipe.results.filter((result) => result.ok).length, 7)
    assert.equal(sigpipe.results.filter((result) => result.signal === 'SIGPIPE').length, 1)
    assert.equal(fs.existsSync(path.join(root, 'sigpipe-injection', 'FAILED_SAFE')), false,
      'a recovered transient probe failure must not create the global fatal latch')

    const persistent = await runScenario(root, 'persistent-failure', 8, 'persistent-failure')
    assert.equal(persistent.maxConcurrent, 1, 'persistent failures must never create a probe storm')
    assert.ok(persistent.results.every((result) => !result.ok && result.code === 'PROBE_FAILED'))
    assert.equal(fs.existsSync(path.join(root, 'business-write')), false,
      'persistent uncertainty must not permit a business write')

    console.log(JSON.stringify({
      status: 'PASS',
      rounds: 50,
      callers: totalCallers,
      fullProbes,
      singleFlightJoins: joins,
      maximumConcurrentFullProbes: maximum,
      sigpipeInjection: { fullProbes: sigpipe.probes, recoveredWaiters: 7, falseFailedSafe: 0 },
      persistentFailure: { callers: 8, fullProbes: persistent.probes, businessWrites: 0 },
    }))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
