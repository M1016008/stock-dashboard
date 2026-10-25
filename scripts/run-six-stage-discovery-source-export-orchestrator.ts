import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import {
  runSixStageDiscoveryExecution,
  type DiscoveryWorker,
  type DiscoveryWorkerResult,
} from '@/lib/research/six-stage-discovery-execution'
import {
  certifySixStageDiscoveryStoragePreflight,
  prepareSixStageDiscoveryStoragePreflight,
  type SixStageDiscoveryStoragePlan,
  type SixStageLaunchdIdentity,
} from '@/lib/research/six-stage-discovery-storage-preflight'
import {
  assertNoUnauthorizedDatabaseHandles,
  createLaunchdWriterHoldDriver,
} from '@/lib/storage/launchd-writer-hold-driver'
import { WriterHoldError } from '@/lib/storage/weekly-writer-hold'

const planPath = process.argv[2]
const expectedPlanHash = process.argv[3]
if (!planPath || !expectedPlanHash) {
  throw new Error('usage: tsx run-six-stage-discovery-source-export-orchestrator.ts plan.json expected-plan-sha256')
}

const rawPlan = fs.readFileSync(planPath)
const planHash = crypto.createHash('sha256').update(rawPlan).digest('hex')
if (planHash !== expectedPlanHash) throw new Error(`plan hash mismatch: ${planHash}`)
const plan = JSON.parse(rawPlan.toString('utf8')) as SixStageDiscoveryStoragePlan
const prepared = prepareSixStageDiscoveryStoragePreflight(plan, { mode: 'AUTHORIZED_PRODUCTION_READ' })
const orchestratorStartedAt = Date.now()
const startNotBefore = Date.parse(plan.authorization.executionWindow.startNotBefore)
const startNoLaterThan = Date.parse(plan.authorization.executionWindow.startNoLaterThan)
const endNoLaterThan = Date.parse(plan.authorization.executionWindow.endNoLaterThan)
if (orchestratorStartedAt < startNotBefore || orchestratorStartedAt > startNoLaterThan) {
  throw new Error('OUTSIDE_APPROVED_START_WINDOW')
}
const maximumTotalRunMs = Math.min(
  plan.resourceLimits.maximumTotalRunSeconds * 1_000,
  endNoLaterThan - orchestratorStartedAt,
)
if (maximumTotalRunMs < plan.writerAndHealthIsolation.maximumWriterHoldSeconds * 1_000) {
  throw new Error('INSUFFICIENT_APPROVED_RUNTIME_REMAINING')
}
certifySixStageDiscoveryStoragePreflight(prepared)

function directoryBytes(root: string): number {
  try {
    const stat = fs.lstatSync(root)
    if (stat.isSymbolicLink()) throw new Error('OUTPUT_SYMLINK_REJECTED')
    if (stat.isFile()) return stat.size
    if (!stat.isDirectory()) return 0
    return fs.readdirSync(root).reduce((total, entry) => total + directoryBytes(path.join(root, entry)), 0)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return 0
    throw error
  }
}

function startWorker(token: string): DiscoveryWorker {
  const child = spawn(process.execPath, [
    '--import',
    'tsx',
    'scripts/run-six-stage-discovery-source-export.mjs',
    planPath,
    expectedPlanHash,
  ], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['inherit', 'inherit', 'inherit', 'pipe'],
  })
  const workerPid = child.pid
  const attestationStream = child.stdio[3]
  if (!workerPid || !attestationStream || !('end' in attestationStream)) {
    child.kill('SIGTERM')
    throw new Error('WORKER_ATTESTATION_CHANNEL_UNAVAILABLE')
  }
  attestationStream.end(JSON.stringify({ token, planHash, orchestratorPid: process.pid }))
  let settled = false
  let settle: ((result: DiscoveryWorkerResult) => void) | null = null
  const completion = new Promise<DiscoveryWorkerResult>((resolve) => { settle = resolve })
  child.once('error', (error) => {
    process.stderr.write(`research worker process error: ${error.message}\n`)
    if (!child.pid && !settled) {
      settled = true
      settle?.({ code: 1, signal: null })
    }
  })
  child.once('exit', (code, signal) => {
    if (!settled) {
      settled = true
      settle?.({ code, signal })
    }
  })
  return {
    pid: workerPid,
    completion,
    async terminate() {
      if (settled) return
      child.kill('SIGTERM')
      const graceful = await Promise.race([
        completion.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 10_000)),
      ])
      if (!graceful && !settled) {
        child.kill('SIGKILL')
        await completion
      }
    },
  }
}

async function main(): Promise<void> {
  if (fs.existsSync(plan.writeOnceDestination.incompleteDirectory)
    || fs.existsSync(plan.writeOnceDestination.finalDirectory)) {
    throw new Error('WRITE_ONCE_DESTINATION_ALREADY_EXISTS')
  }
  const token = crypto.randomBytes(32).toString('hex')
  const controller = new AbortController()
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP']
  const onSignal = () => controller.abort()
  for (const signal of signals) process.on(signal, onSignal)
  try {
    const approvedWriters = plan.writerAndHealthIsolation.approvedWriters.map((identity) => ({
      label: identity.label,
      definitionSha256: identity.definitionSha256,
      program: identity.program,
    }))
    const writerDriver = createLaunchdWriterHoldDriver(plan.writerAndHealthIsolation.approvedWriters)
    const result = await runSixStageDiscoveryExecution({
      approvedWriters,
      writerDriver,
      abortSignal: controller.signal,
      limits: {
        maximumWriterHoldMs: plan.writerAndHealthIsolation.maximumWriterHoldSeconds * 1_000,
        maximumHandleDrainMs: plan.writerAndHealthIsolation.handleProbeTimeoutSeconds * 1_000,
        maximumSourceReadMs: Math.min(
          plan.resourceLimits.maximumSourceReadSeconds * 1_000,
          (plan.writerAndHealthIsolation.maximumWriterHoldSeconds
            - plan.writerAndHealthIsolation.writerRestoreReserveSeconds) * 1_000,
        ),
        maximumTotalRunMs,
        maximumOutputBytes: plan.resourceLimits.maximumOutputBytes,
        monitorIntervalMs: plan.writerAndHealthIsolation.handleProbeIntervalSeconds * 1_000,
      },
      executionDriver: {
        now: Date.now,
        sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
        startWorker: () => startWorker(token),
        sourceReadComplete: () => [
          plan.writeOnceDestination.incompleteDirectory,
          plan.writeOnceDestination.finalDirectory,
        ].some((directory) => fs.existsSync(path.join(directory, 'SOURCE_READ_COMPLETE.json'))),
        outputBytes: () => directoryBytes(plan.writeOnceDestination.incompleteDirectory)
          + directoryBytes(plan.writeOnceDestination.finalDirectory),
        assertHandlePolicy: async (workerPid, additionallyApprovedPids) => {
          assertNoUnauthorizedDatabaseHandles({
            databasePath: prepared.sourcePath,
            approvedReaders: plan.writerAndHealthIsolation.approvedReaders as SixStageLaunchdIdentity[],
            workerPid,
            additionallyApprovedPids,
            timeoutMs: plan.writerAndHealthIsolation.handleProbeTimeoutSeconds * 1_000,
          })
        },
      },
    })
    process.stdout.write(`${JSON.stringify({
      status: 'PASS',
      planHash,
      writerHold: result.writerHold,
      worker: result.worker,
    })}\n`)
  } finally {
    for (const signal of signals) process.off(signal, onSignal)
  }
}

function serializeError(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error) return { name: error.name, message: error.message, stack: error.stack }
  return { name: 'UnknownError', message: String(error) }
}

main().catch((error) => {
  const record = error instanceof WriterHoldError
    ? {
        status: 'FAIL',
        failure: 'WRITER_HOLD',
        primaryError: error.primaryError === null ? null : serializeError(error.primaryError),
        restoreErrors: error.restoreErrors.map(serializeError),
      }
    : { status: 'FAIL', failure: 'EXECUTION', error: serializeError(error) }
  process.stderr.write(`${JSON.stringify(record, null, 2)}\n`)
  process.exitCode = 1
})
