export type WriterRuntimeIdentity = {
  label: string
  definitionSha256: string
  program: string
  loaded: boolean
  disabled: boolean
  instances: number
}

export type ApprovedWriterIdentity = Pick<WriterRuntimeIdentity,
  'label' | 'definitionSha256' | 'program'>

export type WriterHoldDriver = {
  observe(label: string): Promise<WriterRuntimeIdentity>
  bootout(label: string): Promise<void>
  bootstrap(label: string): Promise<void>
  now(): number
}

export type WriterHoldReceipt = {
  heldLabels: string[]
  alreadyUnloadedLabels: string[]
  intentionallyDisabledLabels: string[]
  restoredLabels: string[]
  holdDurationMs: number
  restored: true
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
  driver: WriterHoldDriver
  operation: (assertHoldValid: () => Promise<void>) => Promise<T>
}): Promise<{ result: T; receipt: WriterHoldReceipt }> {
  if (!Number.isSafeInteger(args.maximumHoldMs) || args.maximumHoldMs <= 0) {
    throw new Error('WRITER_HOLD_LIMIT_INVALID')
  }
  const labels = args.approved.map((item) => item.label)
  if (new Set(labels).size !== labels.length) throw new Error('DUPLICATE_WRITER_LABEL')
  const before = new Map<string, WriterRuntimeIdentity>()
  for (const expected of args.approved) {
    const observed = await args.driver.observe(expected.label)
    assertIdentity(expected, observed)
    before.set(expected.label, observed)
  }

  const startedAt = args.driver.now()
  const heldLabels: string[] = []
  const alreadyUnloadedLabels: string[] = []
  const intentionallyDisabledLabels: string[] = []
  const restoredLabels: string[] = []
  let operationError: unknown = null
  let result: T | undefined

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
        await args.driver.bootout(expected.label)
        const stopped = await args.driver.observe(expected.label)
        assertIdentity(expected, stopped)
        if (stopped.loaded || stopped.instances !== 0) throw new Error(`WRITER_BOOTOUT_FAILED:${expected.label}`)
        heldLabels.push(expected.label)
      }
    }
    await assertHoldValid()
    result = await args.operation(assertHoldValid)
    await assertHoldValid()
  } catch (error) {
    operationError = error
  } finally {
    for (const expected of [...args.approved].reverse()) {
      const original = before.get(expected.label)!
      if (!original.loaded || original.disabled) continue
      try {
        await args.driver.bootstrap(expected.label)
        const restored = await args.driver.observe(expected.label)
        assertIdentity(expected, restored)
        if (!restored.loaded || restored.instances !== 1 || restored.disabled) {
          throw new Error(`WRITER_RESTORE_FAILED:${expected.label}`)
        }
        restoredLabels.push(expected.label)
      } catch (restoreError) {
        if (!operationError) operationError = restoreError
        else operationError = new AggregateError([operationError, restoreError], 'WRITER_OPERATION_AND_RESTORE_FAILED')
      }
    }
  }

  if (operationError) throw operationError
  return {
    result: result as T,
    receipt: {
      heldLabels,
      alreadyUnloadedLabels,
      intentionallyDisabledLabels,
      restoredLabels,
      holdDurationMs: args.driver.now() - startedAt,
      restored: true,
    },
  }
}
