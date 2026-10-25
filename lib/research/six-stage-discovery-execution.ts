import {
  withWeeklyWriterHold,
  type ApprovedWriterIdentity,
  type WriterHoldDriver,
  type WriterHoldReceipt,
} from '@/lib/storage/weekly-writer-hold'

export type DiscoveryWorkerResult = Readonly<{
  code: number | null
  signal: NodeJS.Signals | null
}>

export type DiscoveryWorker = Readonly<{
  pid: number
  completion: Promise<DiscoveryWorkerResult>
  terminate: () => Promise<void>
}>

export type DiscoveryExecutionDriver = Readonly<{
  now: () => number
  sleep: (milliseconds: number) => Promise<void>
  startWorker: () => DiscoveryWorker
  sourceReadComplete: () => boolean
  outputBytes: () => number
  assertHandlePolicy: (workerPid?: number, additionallyApprovedPids?: readonly number[]) => Promise<void>
}>

export type DiscoveryExecutionLimits = Readonly<{
  maximumWriterHoldMs: number
  maximumHandleDrainMs: number
  maximumSourceReadMs: number
  maximumTotalRunMs: number
  maximumOutputBytes: number
  monitorIntervalMs: number
}>

export type DiscoveryExecutionResult = Readonly<{
  worker: DiscoveryWorkerResult
  writerHold: WriterHoldReceipt
}>

function assertLimits(limits: DiscoveryExecutionLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`INVALID_EXECUTION_LIMIT:${name}`)
  }
  if (limits.maximumSourceReadMs > limits.maximumWriterHoldMs
    || limits.maximumWriterHoldMs > limits.maximumTotalRunMs) {
    throw new Error('EXECUTION_LIMIT_ORDER_INVALID')
  }
}

export async function runSixStageDiscoveryExecution(args: {
  approvedWriters: ApprovedWriterIdentity[]
  writerDriver: WriterHoldDriver
  executionDriver: DiscoveryExecutionDriver
  limits: DiscoveryExecutionLimits
  abortSignal?: AbortSignal
}): Promise<DiscoveryExecutionResult> {
  assertLimits(args.limits)
  if (args.abortSignal?.aborted) throw new Error('EXECUTION_INTERRUPTED')
  const startedAt = args.executionDriver.now()
  let worker: DiscoveryWorker | null = null
  let workerResult: DiscoveryWorkerResult | null = null
  let workerSettled = false

  const assertCommon = () => {
    if (args.abortSignal?.aborted) throw new Error('EXECUTION_INTERRUPTED')
    if (args.executionDriver.now() - startedAt > args.limits.maximumTotalRunMs) {
      throw new Error('EXECUTION_DEADLINE_EXCEEDED')
    }
    if (args.executionDriver.outputBytes() > args.limits.maximumOutputBytes) {
      throw new Error('OUTPUT_LIMIT_EXCEEDED')
    }
  }

  const waitForTick = async () => {
    if (!worker) throw new Error('WORKER_NOT_STARTED')
    await Promise.race([
      args.executionDriver.sleep(args.limits.monitorIntervalMs),
      worker.completion.then(() => undefined),
    ])
  }

  const stopWorker = async () => {
    if (worker && !workerSettled) await worker.terminate()
  }

  const waitForInitialHandleDrain = async (assertHoldValid: () => Promise<void>) => {
    const deadline = args.executionDriver.now() + args.limits.maximumHandleDrainMs
    for (;;) {
      try {
        await args.executionDriver.assertHandlePolicy()
        return
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!message.startsWith('UNAUTHORIZED_DATABASE_HANDLE:')
          || args.executionDriver.now() >= deadline) throw error
        assertCommon()
        await assertHoldValid()
        await args.executionDriver.sleep(Math.min(args.limits.monitorIntervalMs, 1_000))
      }
    }
  }

  let held: { result: DiscoveryWorker; receipt: WriterHoldReceipt }
  try {
    held = await withWeeklyWriterHold({
      approved: args.approvedWriters,
      maximumHoldMs: args.limits.maximumWriterHoldMs,
      driver: args.writerDriver,
      assertRestoreSafe: async (writerPids) => args.executionDriver.assertHandlePolicy(undefined, writerPids),
      operation: async (assertHoldValid) => {
        try {
          assertCommon()
          await assertHoldValid()
          await waitForInitialHandleDrain(assertHoldValid)
          worker = args.executionDriver.startWorker()
          worker.completion.then((result) => {
            workerResult = result
            workerSettled = true
          })
          for (;;) {
            assertCommon()
            if (args.executionDriver.now() - startedAt > args.limits.maximumSourceReadMs) {
              throw new Error('SOURCE_READ_DEADLINE_EXCEEDED')
            }
            await assertHoldValid()
            await args.executionDriver.assertHandlePolicy(worker.pid)
            if (args.executionDriver.sourceReadComplete()) {
              await args.executionDriver.assertHandlePolicy()
              return worker
            }
            if (workerSettled) throw new Error(`WORKER_EXITED_BEFORE_SOURCE_COMPLETE:${workerResult?.code ?? 'null'}`)
            await waitForTick()
          }
        } catch (error) {
          await stopWorker()
          throw error
        }
      },
    })
  } catch (error) {
    await stopWorker()
    throw error
  }

  worker = held.result
  try {
    while (!workerSettled) {
      assertCommon()
      await waitForTick()
    }
    assertCommon()
    const finalWorkerResult = await worker.completion
    if (finalWorkerResult.code !== 0 || finalWorkerResult.signal !== null) {
      throw new Error(`WORKER_FAILED:${finalWorkerResult.code ?? 'null'}:${finalWorkerResult.signal ?? 'none'}`)
    }
    return { worker: finalWorkerResult, writerHold: held.receipt }
  } catch (error) {
    await stopWorker()
    throw error
  }
}
