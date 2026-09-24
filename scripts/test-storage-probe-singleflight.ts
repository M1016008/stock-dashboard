import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { certifyVolumeIdentitySingleFlight, type VolumeIdentity } from '@/lib/storage/external-storage-guard'

const scriptPath = fileURLToPath(import.meta.url)

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

function child(): void {
  const mountPath = process.env.PROBE_FIXTURE_MOUNT!
  const coordinationDir = process.env.PROBE_FIXTURE_COORDINATION!
  const countPath = process.env.PROBE_FIXTURE_COUNT!
  const result = certifyVolumeIdentitySingleFlight(mountPath, () => {
    fs.appendFileSync(countPath, `${process.pid}\n`)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300)
    return fixtureVolume(mountPath)
  }, { coordinationDir, cacheTtlMs: 10_000, waitMs: 5_000, pollMs: 10 })
  process.stdout.write(`${result.uuid}\n`)
}

function runChild(env: NodeJS.ProcessEnv): Promise<string> {
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
      if (code === 0) resolve(stdout.trim())
      else reject(new Error(`single-flight child exited ${code}: ${stderr}`))
    })
  })
}

async function main(): Promise<void> {
  if (process.argv[2] === '--child') {
    child()
    return
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stockboard-probe-singleflight-'))
  const mountPath = path.join(root, 'mount')
  const coordinationDir = path.join(root, 'coordination')
  const countPath = path.join(root, 'certifications.txt')
  fs.mkdirSync(mountPath)
  try {
    const env = {
      ...process.env,
      PROBE_FIXTURE_MOUNT: mountPath,
      PROBE_FIXTURE_COORDINATION: coordinationDir,
      PROBE_FIXTURE_COUNT: countPath,
    }
    const results = await Promise.all(Array.from({ length: 8 }, () => runChild(env)))
    assert.deepEqual(new Set(results), new Set(['single-flight-fixture']))
    const invocations = fs.readFileSync(countPath, 'utf8').trim().split('\n').filter(Boolean)
    assert.equal(invocations.length, 1, 'eight concurrent processes must share one full certification')
    console.log('Storage probe single-flight: PASS (8 callers, 1 full certification)')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
