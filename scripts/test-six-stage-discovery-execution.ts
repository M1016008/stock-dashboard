import assert from 'node:assert/strict'
import {
  runSixStageDiscoveryExecution,
  type DiscoveryExecutionDriver,
  type DiscoveryWorkerResult,
} from '@/lib/research/six-stage-discovery-execution'
import { sourceReadThrottleDelayMs } from '@/lib/research/six-stage-source-rate-limit'
import type {
  ApprovedWriterIdentity,
  WriterHoldDriver,
  WriterRuntimeIdentity,
} from '@/lib/storage/weekly-writer-hold'

const approved: ApprovedWriterIdentity[] = [
  { label: 'writer.loaded', definitionSha256: 'a'.repeat(64), program: '/approved/loaded' },
  { label: 'writer.unloaded', definitionSha256: 'b'.repeat(64), program: '/approved/unloaded' },
  { label: 'writer.disabled', definitionSha256: 'c'.repeat(64), program: '/approved/disabled' },
]

type Scenario = 'normal' | 'worker-failure' | 'interrupt' | 'capacity' | 'handle-failure' | 'timeout'
  | 'post-operation-hold-failure'

function fixture(scenario: Scenario) {
  let now = 0
  let tick = 0
  let sourceComplete = false
  let outputBytes = 0
  let workerStarted = false
  let workerSettled = false
  let sourceHandleClosed = false
  let resolveWorker: ((result: DiscoveryWorkerResult) => void) | null = null
  const actions: string[] = []
  const states = new Map<string, WriterRuntimeIdentity>([
    [approved[0].label, { ...approved[0], loaded: true, disabled: false, instances: 1 }],
    [approved[1].label, { ...approved[1], loaded: false, disabled: false, instances: 0 }],
    [approved[2].label, { ...approved[2], loaded: false, disabled: true, instances: 0 }],
  ])
  const controller = new AbortController()

  const writerDriver: WriterHoldDriver = {
    async observe(label) {
      const observed = structuredClone(states.get(label)!)
      if (scenario === 'post-operation-hold-failure' && sourceHandleClosed && label === approved[0].label) {
        observed.loaded = true
        observed.instances = 1
      }
      return observed
    },
    async bootout(label) {
      actions.push(`bootout:${label}`)
      Object.assign(states.get(label)!, { loaded: false, instances: 0 })
    },
    async bootstrap(label) {
      actions.push(`bootstrap:${label}`)
      Object.assign(states.get(label)!, { loaded: true, instances: 1 })
    },
    now: () => now,
  }

  const executionDriver: DiscoveryExecutionDriver = {
    now: () => now,
    async sleep(milliseconds) {
      now += scenario === 'timeout' ? 2_000 : milliseconds
      tick += 1
      if ((scenario === 'normal' || scenario === 'post-operation-hold-failure') && tick === 1) sourceComplete = true
      if ((scenario === 'normal' || scenario === 'post-operation-hold-failure') && tick === 2 && !workerSettled) {
        workerSettled = true
        resolveWorker?.({ code: 0, signal: null })
      }
      if (scenario === 'worker-failure' && tick === 1 && !workerSettled) {
        workerSettled = true
        resolveWorker?.({ code: 1, signal: null })
      }
      if (scenario === 'interrupt' && tick === 1) controller.abort()
      if (scenario === 'capacity' && tick === 1) outputBytes = 101
      await Promise.resolve()
    },
    startWorker() {
      workerStarted = true
      actions.push('worker:start')
      const completion = new Promise<DiscoveryWorkerResult>((resolve) => { resolveWorker = resolve })
      return {
        pid: 4242,
        completion,
        async terminate() {
          actions.push('worker:terminate')
          if (!workerSettled) {
            workerSettled = true
            resolveWorker?.({ code: null, signal: 'SIGTERM' })
            await Promise.resolve()
          }
        },
      }
    },
    sourceReadComplete: () => sourceComplete,
    outputBytes: () => outputBytes,
    async assertHandlePolicy(workerPid) {
      actions.push(`handles:${workerPid ?? 'none'}`)
      if (workerStarted && workerPid === undefined) sourceHandleClosed = true
      if (scenario === 'handle-failure' && workerStarted) throw new Error('UNAUTHORIZED_DATABASE_HANDLE:9000:rogue')
    },
  }

  return { actions, states, writerDriver, executionDriver, controller }
}

const limits = {
  maximumWriterHoldMs: 1_000,
  maximumSourceReadMs: 1_000,
  maximumTotalRunMs: 3_000,
  maximumOutputBytes: 100,
  monitorIntervalMs: 100,
}

function assertRestored(value: ReturnType<typeof fixture>): void {
  assert.equal(value.states.get('writer.loaded')!.loaded, true)
  assert.equal(value.states.get('writer.loaded')!.instances, 1)
  assert.equal(value.states.get('writer.unloaded')!.loaded, false)
  assert.equal(value.states.get('writer.disabled')!.loaded, false)
  assert.equal(value.states.get('writer.disabled')!.disabled, true)
}

async function runScenario(scenario: Scenario, expected?: RegExp) {
  const value = fixture(scenario)
  const operation = runSixStageDiscoveryExecution({
    approvedWriters: approved,
    writerDriver: value.writerDriver,
    executionDriver: value.executionDriver,
    limits,
    abortSignal: value.controller.signal,
  })
  if (expected) await assert.rejects(operation, expected)
  else await operation
  assertRestored(value)
  return value
}

async function main(): Promise<void> {
  assert.equal(sourceReadThrottleDelayMs({
    logicalBytesRead: 2_000,
    elapsedMs: 500,
    maximumBytesPerSecond: 1_000,
  }), 1_500)
  assert.equal(sourceReadThrottleDelayMs({
    logicalBytesRead: 1_000,
    elapsedMs: 1_500,
    maximumBytesPerSecond: 1_000,
  }), 0)
  const normal = await runScenario('normal')
  assert.ok(normal.actions.indexOf('bootstrap:writer.loaded') > normal.actions.indexOf('handles:none'),
    'writers restore only after the worker closes its source handle')

  for (const [scenario, expected] of [
    ['worker-failure', /WORKER_EXITED_BEFORE_SOURCE_COMPLETE/],
    ['interrupt', /EXECUTION_INTERRUPTED/],
    ['capacity', /OUTPUT_LIMIT_EXCEEDED/],
    ['handle-failure', /UNAUTHORIZED_DATABASE_HANDLE/],
    ['timeout', /SOURCE_READ_DEADLINE_EXCEEDED/],
    ['post-operation-hold-failure', /WRITER_RESTARTED_DURING_HOLD/],
  ] as const) {
    const value = await runScenario(scenario, expected)
    assert.ok(value.actions.includes('worker:terminate') || scenario === 'worker-failure')
  }

  console.log(JSON.stringify({
    verdict: 'PASS',
    normalCompletionRestored: true,
    workerFailureRestored: true,
    interruptionRestored: true,
    capacityFailureRestored: true,
    unauthorizedHandleRestored: true,
    timeoutRestored: true,
    postOperationHoldFailureStoppedWorker: true,
    sourceReadRateLimitEnforced: true,
  }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
