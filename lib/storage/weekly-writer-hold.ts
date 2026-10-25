export type WriterRuntimeIdentity = {
  label: string
  definitionSha256: string
  program: string
  loaded: boolean
  disabled: boolean
  instances: number
  pid?: number | null
  processGroupId?: number | null
}

export type ApprovedWriterIdentity = Pick<WriterRuntimeIdentity,
  'label' | 'definitionSha256' | 'program'>

export type WriterHoldDriver = {
  observe(label: string): Promise<WriterRuntimeIdentity>
  bootout(label: string): Promise<void>
  bootstrap(label: string): Promise<void>
  processGroupAlive(processGroupId: number): Promise<boolean>
  sleep(milliseconds: number): Promise<void>
  now(): number
}

export type WriterHoldReceipt = {
  stopInitiatedLabels: string[]
  heldLabels: string[]
  alreadyUnloadedLabels: string[]
  intentionallyDisabledLabels: string[]
  restoredLabels: string[]
  alreadyLoadedOnRestoreLabels: string[]
  holdDurationMs: number
  restored: true
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export class WriterHoldError extends AggregateError {
  readonly primaryError: unknown | null
  readonly restoreErrors: readonly unknown[]

  constructor(primaryError: unknown | null, restoreErrors: readonly unknown[]) {
    const errors = [...(primaryError === null ? [] : [primaryError]), ...restoreErrors]
    const primary = primaryError === null ? 'NONE' : errorMessage(primaryError)
    const restore = restoreErrors.length === 0 ? 'NONE' : restoreErrors.map(errorMessage).join('|')
    super(errors, `WRITER_HOLD_FAILED:primary=${primary};restore=${restore}`)
    this.name = 'WriterHoldError'
    this.primaryError = primaryError
    this.restoreErrors = restoreErrors
  }
}

function assertIdentity(expected: ApprovedWriterIdentity, observed: WriterRuntimeIdentity): void {
  if (observed.label !== expected.label || observed.definitionSha256 !== expected.definitionSha256
    || observed.program !== expected.program) throw new Error(`WRITER_IDENTITY_MISMATCH:${expected.label}`)
  if (observed.instances < 0 || observed.instances > 1) throw new Error(`WRITER_INSTANCE_COUNT_INVALID:${expected.label}`)
  if (observed.disabled && observed.loaded) throw new Error(`DISABLED_WRITER_IS_LOADED:${expected.label}`)
}

export async function withWeeklyWriterHold<T>(args: {
  approved: ApprovedWriterIdentity[]
  maximumHoldMs: number
  maximumStopWaitMs?: number
  stopPollIntervalMs?: number
  driver: WriterHoldDriver
  operation: (assertHoldValid: () => Promise<void>) => Promise<T>
  assertRestoreSafe?: (currentlyLoadedWriterPids: readonly number[]) => Promise<void>
}): Promise<{ result: T; receipt: WriterHoldReceipt }> {
  if (!Number.isSafeInteger(args.maximumHoldMs) || args.maximumHoldMs <= 0) {
    throw new Error('WRITER_HOLD_LIMIT_INVALID')
  }
  const labels = args.approved.map((item) => item.label)
  if (new Set(labels).size !== labels.length) throw new Error('DUPLICATE_WRITER_LABEL')
  const maximumStopWaitMs = args.maximumStopWaitMs ?? 15_000
  const stopPollIntervalMs = args.stopPollIntervalMs ?? 100
  if (!Number.isSafeInteger(maximumStopWaitMs) || maximumStopWaitMs <= 0
    || !Number.isSafeInteger(stopPollIntervalMs) || stopPollIntervalMs <= 0
    || stopPollIntervalMs > maximumStopWaitMs) {
    throw new Error('WRITER_STOP_WAIT_INVALID')
  }
  const before = new Map<string, WriterRuntimeIdentity>()
  for (const expected of args.approved) {
    const observed = await args.driver.observe(expected.label)
    assertIdentity(expected, observed)
    before.set(expected.label, observed)
  }

  const startedAt = args.driver.now()
  const stopInitiatedLabels: string[] = []
  const bootoutMayStillCompleteLabels = new Set<string>()
  const heldLabels: string[] = []
  const alreadyUnloadedLabels: string[] = []
  const intentionallyDisabledLabels: string[] = []
  const restoredLabels: string[] = []
  const alreadyLoadedOnRestoreLabels: string[] = []
  let primaryError: unknown = null
  const restoreErrors: unknown[] = []
  let result: T | undefined

  const waitForState = async (
    expected: ApprovedWriterIdentity,
    predicate: (observed: WriterRuntimeIdentity) => boolean | Promise<boolean>,
    timeoutCode: string,
  ): Promise<WriterRuntimeIdentity> => {
    const deadline = args.driver.now() + maximumStopWaitMs
    for (;;) {
      const observed = await args.driver.observe(expected.label)
      assertIdentity(expected, observed)
      if (await predicate(observed)) return observed
      if (args.driver.now() >= deadline) throw new Error(`${timeoutCode}:${expected.label}`)
      await args.driver.sleep(stopPollIntervalMs)
    }
  }

  const originalProcessGroupStopped = async (original: WriterRuntimeIdentity): Promise<boolean> => {
    const processGroupId = original.processGroupId
    return processGroupId === null || processGroupId === undefined
      || !(await args.driver.processGroupAlive(processGroupId))
  }

  const assertHoldValid = async () => {
    if (args.driver.now() - startedAt > args.maximumHoldMs) throw new Error('WRITER_HOLD_LIMIT_EXCEEDED')
    for (const expected of args.approved) {
      const observed = await args.driver.observe(expected.label)
      assertIdentity(expected, observed)
      if (observed.loaded || observed.instances !== 0) throw new Error(`WRITER_RESTARTED_DURING_HOLD:${expected.label}`)
    }
  }

  try {
    for (const expected of args.approved) {
      const observed = before.get(expected.label)!
      if (observed.disabled) {
        intentionallyDisabledLabels.push(expected.label)
      } else if (!observed.loaded) {
        alreadyUnloadedLabels.push(expected.label)
      } else {
        stopInitiatedLabels.push(expected.label)
        bootoutMayStillCompleteLabels.add(expected.label)
        try {
          await args.driver.bootout(expected.label)
        } catch (error) {
          throw error
        }
        await waitForState(
          expected,
          async (stopped) => !stopped.loaded && stopped.instances === 0
            && await originalProcessGroupStopped(observed),
          'WRITER_BOOTOUT_TIMEOUT',
        )
        heldLabels.push(expected.label)
      }
    }
    await assertHoldValid()
    result = await args.operation(assertHoldValid)
    await assertHoldValid()
  } catch (error) {
    primaryError = error
  } finally {
    let restoreSafetyError: unknown = null
    if (args.assertRestoreSafe) {
      try {
        const currentlyLoadedWriterPids: number[] = []
        for (const expected of args.approved) {
          const current = await args.driver.observe(expected.label)
          assertIdentity(expected, current)
          if (current.loaded && current.pid !== null && current.pid !== undefined) {
            currentlyLoadedWriterPids.push(current.pid)
          }
        }
        await args.assertRestoreSafe(currentlyLoadedWriterPids)
      } catch (error) {
        restoreSafetyError = error
        restoreErrors.push(new Error(`WRITER_RESTORE_SAFETY_ERROR:${errorMessage(error)}`, { cause: error }))
      }
    }
    for (const expected of [...args.approved].reverse()) {
      const original = before.get(expected.label)!
      try {
        let current = await args.driver.observe(expected.label)
        assertIdentity(expected, current)
        if (current.disabled !== original.disabled) {
          throw new Error(`WRITER_DISABLED_STATE_CHANGED:${expected.label}`)
        }
        if (original.loaded) {
          if (current.loaded) {
            if (bootoutMayStillCompleteLabels.has(expected.label)) {
              current = await waitForState(
                expected,
                async (settled) => !settled.loaded && settled.instances === 0
                  && await originalProcessGroupStopped(original),
                'WRITER_RESTORE_STOP_SETTLE_TIMEOUT',
              )
            } else {
              if (original.processGroupId !== null && original.processGroupId !== undefined
                && current.processGroupId !== original.processGroupId
                && await args.driver.processGroupAlive(original.processGroupId)) {
                throw new Error(`WRITER_DUPLICATE_PROCESS_GROUP:${expected.label}:${original.processGroupId}`)
              }
              alreadyLoadedOnRestoreLabels.push(expected.label)
            }
          }
          if (!current.loaded) {
            if (restoreSafetyError !== null) {
              throw new Error(`WRITER_BOOTSTRAP_BLOCKED_BY_RESTORE_SAFETY:${expected.label}`)
            }
            await waitForState(
              expected,
              async (unloaded) => !unloaded.loaded && unloaded.instances === 0
                && await originalProcessGroupStopped(original),
              'WRITER_RESTORE_PROCESS_GROUP_TIMEOUT',
            )
            await args.driver.bootstrap(expected.label)
            current = await waitForState(
              expected,
              (restored) => restored.loaded && restored.instances === 1 && !restored.disabled,
              'WRITER_BOOTSTRAP_TIMEOUT',
            )
            restoredLabels.push(expected.label)
          }
        } else if (current.loaded) {
          await args.driver.bootout(expected.label)
          await waitForState(
            expected,
            (restored) => !restored.loaded && restored.instances === 0,
            'WRITER_RESTORE_TO_UNLOADED_TIMEOUT',
          )
        }
      } catch (restoreError) {
        restoreErrors.push(new Error(
          `WRITER_RESTORE_ERROR:${expected.label}:${errorMessage(restoreError)}`,
          { cause: restoreError },
        ))
      }
    }
    for (const expected of args.approved) {
      const original = before.get(expected.label)!
      try {
        const final = await args.driver.observe(expected.label)
        assertIdentity(expected, final)
        const expectedInstances = original.loaded ? 1 : 0
        if (final.loaded !== original.loaded || final.disabled !== original.disabled
          || final.instances !== expectedInstances) {
          throw new Error(`WRITER_FINAL_STATE_MISMATCH:${expected.label}`)
        }
      } catch (restoreError) {
        restoreErrors.push(new Error(
          `WRITER_FINAL_STATE_ERROR:${expected.label}:${errorMessage(restoreError)}`,
          { cause: restoreError },
        ))
      }
    }
  }

  if (primaryError !== null || restoreErrors.length > 0) {
    throw new WriterHoldError(primaryError, restoreErrors)
  }
  return {
    result: result as T,
    receipt: {
      stopInitiatedLabels,
      heldLabels,
      alreadyUnloadedLabels,
      intentionallyDisabledLabels,
      restoredLabels,
      alreadyLoadedOnRestoreLabels,
      holdDurationMs: args.driver.now() - startedAt,
      restored: true,
    },
  }
}
