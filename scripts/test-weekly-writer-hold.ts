import assert from 'node:assert/strict'
import { withWeeklyWriterHold, WriterHoldError, WriterPreflightError, type ApprovedWriterIdentity,
  type WriterHoldDriver, type WriterRuntimeIdentity } from '@/lib/storage/weekly-writer-hold'

const expected: ApprovedWriterIdentity[] = [
  { label: 'com.stockboard.update-latest', definitionSha256: 'a'.repeat(64), program: '/approved/jp' },
  { label: 'com.stockboard.us-update-latest', definitionSha256: 'b'.repeat(64), program: '/approved/us' },
  { label: 'com.stockboard.ml-weekly-governance', definitionSha256: 'c'.repeat(64), program: '/approved/disabled' },
]

function driver(options: { duplicate?: boolean; mismatch?: boolean; advanceMs?: number } = {}): {
  value: WriterHoldDriver
  states: Map<string, WriterRuntimeIdentity>
  actions: string[]
} {
  let now = 0
  const states = new Map<string, WriterRuntimeIdentity>([
    [expected[0].label, { ...expected[0], loaded: true, disabled: false, instances: options.duplicate ? 2 : 1 }],
    [expected[1].label, { ...expected[1], loaded: false, disabled: false, instances: 0 }],
    [expected[2].label, { ...expected[2], loaded: false, disabled: true, instances: 0 }],
  ])
  if (options.mismatch) states.get(expected[0].label)!.definitionSha256 = 'd'.repeat(64)
  const actions: string[] = []
  return {
    states,
    actions,
    value: {
      async observe(label) { return structuredClone(states.get(label)!) },
      async bootout(label) {
        actions.push(`bootout:${label}`)
        Object.assign(states.get(label)!, { loaded: false, instances: 0 })
      },
      async bootstrap(label) {
        actions.push(`bootstrap:${label}`)
        Object.assign(states.get(label)!, { loaded: true, instances: 1 })
      },
      async processGroupAlive() { return false },
      async sleep(milliseconds) { now += milliseconds },
      now() { const current = now; now += options.advanceMs ?? 1; return current },
    },
  }
}

async function main(): Promise<void> {
const normal = driver()
const phaseOrder: string[] = []
const held = await withWeeklyWriterHold({
  approved: expected,
  maximumHoldMs: 1_000,
  restoreSloMs: 100,
  driver: normal.value,
  operation: async (assertHoldValid) => {
    await assertHoldValid()
    assert.equal(normal.states.get(expected[0].label)!.loaded, false)
    phaseOrder.push('jp-snapshot-acquired', 'us-snapshot-acquired')
    return 'synced'
  },
})
assert.equal(normal.states.get(expected[0].label)!.loaded, true)
phaseOrder.push('writers-restored', 'destination-only-verification')
assert.deepEqual(phaseOrder, [
  'jp-snapshot-acquired',
  'us-snapshot-acquired',
  'writers-restored',
  'destination-only-verification',
])
assert.equal(held.result, 'synced')
assert.deepEqual(held.receipt.stopInitiatedLabels, [expected[0].label])
assert.deepEqual(held.receipt.heldLabels, [expected[0].label])
assert.deepEqual(held.receipt.alreadyUnloadedLabels, [expected[1].label])
assert.deepEqual(held.receipt.intentionallyDisabledLabels, [expected[2].label])
assert.deepEqual(held.receipt.restoredLabels, [expected[0].label])
assert.deepEqual(held.receipt.alreadyLoadedOnRestoreLabels, [])
assert.ok(held.receipt.restoreStartedAtMs <= held.receipt.restoreCompletedAtMs)
assert.equal(
  held.receipt.restoreDurationMs,
  held.receipt.restoreCompletedAtMs - held.receipt.restoreStartedAtMs,
)
assert.equal(held.receipt.restoreSloMs, 100)
assert.equal(held.receipt.restoreWithinSlo, true)
assert.equal(normal.states.get(expected[2].label)!.disabled, true)
assert.equal(normal.states.get(expected[2].label)!.loaded, false)

await assert.rejects(() => withWeeklyWriterHold({
  approved: expected,
  maximumHoldMs: 1_000,
  expectedLoadedLabels: [expected[0].label, expected[1].label],
  expectedUnloadedLabels: [expected[2].label],
  driver: driver().value,
  operation: async () => undefined,
}), (error: unknown) => {
  assert.ok(error instanceof WriterPreflightError)
  assert.equal(error.writerMutationAttempted, false)
  assert.match(error.message, new RegExp(
    `WRITER_INITIAL_STATE_MISMATCH:${expected[1].label}:expected_loaded:observed_unloaded`,
  ))
  return true
})

await assert.rejects(() => withWeeklyWriterHold({
  approved: expected,
  maximumHoldMs: 1_000,
  expectedLoadedLabels: [expected[0].label],
  expectedUnloadedLabels: [expected[2].label],
  driver: driver().value,
  operation: async () => undefined,
}), /WRITER_EXPECTED_STATE_LABELS_INVALID/)

await assert.rejects(() => withWeeklyWriterHold({
  approved: expected,
  maximumHoldMs: 1_000,
  expectedDisabledLabels: [expected[1].label, expected[2].label],
  driver: driver().value,
  operation: async () => undefined,
}), new RegExp(`WRITER_INITIAL_DISABLED_STATE_MISMATCH:${expected[1].label}:expected_disabled:observed_enabled`))

const failing = driver()
let failingError: unknown
try {
  await withWeeklyWriterHold({
    approved: expected,
    maximumHoldMs: 1_000,
    restoreSloMs: 100,
    driver: failing.value,
    operation: async () => { throw new Error('SYNC_FAILED') },
  })
} catch (error) {
  failingError = error
}
assert.ok(failingError instanceof WriterHoldError)
assert.match(failingError.message, /SYNC_FAILED/)
assert.equal(failingError.restoreEvidence.complete, true)
assert.deepEqual(failingError.restoreEvidence.expectedLoadedLabels, [expected[0].label])
assert.deepEqual(failingError.restoreEvidence.restoredLabels, [expected[0].label])
assert.ok(failingError.restoreEvidence.restoreDurationMs >= 0)
assert.equal(failingError.restoreEvidence.restoreSloMs, 100)
assert.equal(failingError.restoreEvidence.restoreWithinSlo, true)
assert.ok(failingError.restoreEvidence.holdElapsedMs >= failingError.restoreEvidence.restoreDurationMs)
assert.equal(failing.states.get(expected[0].label)!.loaded, true, 'loaded writer must be restored after failure')
assert.equal(failing.states.get(expected[2].label)!.loaded, false, 'disabled writer must remain disabled')

const slowRestore = driver({ advanceMs: 2 })
const slowRestoreResult = await withWeeklyWriterHold({
  approved: expected,
  maximumHoldMs: 1_000,
  restoreSloMs: 1,
  driver: slowRestore.value,
  operation: async () => undefined,
})
assert.equal(slowRestoreResult.receipt.restoreWithinSlo, false)

await assert.rejects(() => withWeeklyWriterHold({
  approved: expected,
  maximumHoldMs: 1_000,
  driver: driver({ duplicate: true }).value,
  operation: async () => undefined,
}), /WRITER_INSTANCE_COUNT_INVALID/)
await assert.rejects(() => withWeeklyWriterHold({
  approved: expected,
  maximumHoldMs: 1_000,
  driver: driver({ mismatch: true }).value,
  operation: async () => undefined,
}), /WRITER_IDENTITY_MISMATCH/)
await assert.rejects(() => withWeeklyWriterHold({
  approved: expected,
  maximumHoldMs: 1,
  driver: driver({ advanceMs: 2 }).value,
  operation: async (assertHoldValid) => { await assertHoldValid() },
}), /WRITER_HOLD_LIMIT_EXCEEDED/)

const delayed = driver()
let delayedObserveCount = 0
let delayedStopPending = false
const originalDelayedObserve = delayed.value.observe
const originalDelayedBootout = delayed.value.bootout
delayed.value.bootout = async (label) => {
  delayed.actions.push(`bootout-requested:${label}`)
  if (label !== expected[0].label) return originalDelayedBootout(label)
  delayedStopPending = true
}
delayed.value.observe = async (label) => {
  if (label === expected[0].label && delayedStopPending && delayed.states.get(label)!.loaded) {
    delayedObserveCount += 1
    if (delayedObserveCount >= 3) {
      Object.assign(delayed.states.get(label)!, { loaded: false, instances: 0 })
      delayedStopPending = false
    }
  }
  return originalDelayedObserve(label)
}
await withWeeklyWriterHold({
  approved: expected,
  maximumHoldMs: 10_000,
  maximumStopWaitMs: 1_000,
  stopPollIntervalMs: 10,
  driver: delayed.value,
  operation: async () => undefined,
})
assert.ok(delayedObserveCount >= 3, 'bootout completion must be polled instead of checked immediately')

const midExpected: ApprovedWriterIdentity[] = Array.from({ length: 16 }, (_, index) => ({
  label: `writer.${String(index).padStart(2, '0')}`,
  definitionSha256: index.toString(16).padStart(64, '0'),
  program: `/approved/writer-${index}`,
}))
const midStates = new Map(midExpected.map((item) => [item.label, {
  ...item, loaded: true, disabled: false, instances: 1,
  pid: 10_000 + Number(item.label.slice(-2)), processGroupId: null,
}]))
const midActions: string[] = []
let midClock = 0
const midDriver: WriterHoldDriver = {
  async observe(label) { return structuredClone(midStates.get(label)!) },
  async bootout(label) {
    midActions.push(`bootout:${label}`)
    if (label === midExpected[7].label) throw new Error('SYNTHETIC_BOOTOUT_FAILURE')
    Object.assign(midStates.get(label)!, { loaded: false, instances: 0 })
  },
  async bootstrap(label) {
    midActions.push(`bootstrap:${label}`)
    Object.assign(midStates.get(label)!, { loaded: true, instances: 1 })
  },
  async processGroupAlive() { return false },
  async sleep(milliseconds) { midClock += milliseconds },
  now: () => midClock,
}
let midError: unknown
try {
  await withWeeklyWriterHold({
    approved: midExpected,
    maximumHoldMs: 1_000,
    driver: midDriver,
    assertRestoreSafe: async (writerPids) => {
      assert.deepEqual(writerPids, Array.from({ length: 9 }, (_, index) => 10_007 + index))
    },
    operation: async () => undefined,
  })
} catch (error) {
  midError = error
}
assert.ok(midError instanceof WriterHoldError)
assert.match(midError.message, /SYNTHETIC_BOOTOUT_FAILURE/)
assert.ok(midError.restoreErrors.some((error) => String(error).includes('WRITER_RESTORE_STOP_SETTLE_TIMEOUT')),
  'an ambiguous bootout failure must fail loud if its final state cannot be proven settled')
for (const item of midExpected.slice(0, 7)) {
  assert.ok(midActions.includes(`bootstrap:${item.label}`), 'each stopped writer must be restored')
}
assert.ok(!midActions.includes(`bootstrap:${midExpected[7].label}`),
  'still-loaded failed writer must not be bootstrapped')
for (const item of midExpected.slice(8)) {
  assert.ok(!midActions.includes(`bootstrap:${item.label}`),
    'writers never reached by the stop loop must not be bootstrapped')
}
for (const state of midStates.values()) assert.equal(state.loaded, true)

const confirmFailure = driver()
confirmFailure.value.bootout = async (label) => {
  confirmFailure.actions.push(`bootout-without-completion:${label}`)
}
let confirmFailureOperationCalled = false
await assert.rejects(() => withWeeklyWriterHold({
  approved: expected,
  maximumHoldMs: 1_000,
  maximumStopWaitMs: 20,
  stopPollIntervalMs: 10,
  driver: confirmFailure.value,
  operation: async () => { confirmFailureOperationCalled = true },
}), /WRITER_BOOTOUT_TIMEOUT/)
assert.equal(confirmFailureOperationCalled, false)
assert.ok(!confirmFailure.actions.some((action) => action.startsWith('bootstrap:')),
  'a still-loaded writer must not be double-bootstrapped after confirmation timeout')
assert.equal(confirmFailure.states.get(expected[0].label)!.loaded, true)

const lateStop = driver()
let lateStopObserveCount = 0
let lateStopRequested = false
const lateStopObserve = lateStop.value.observe
lateStop.value.bootout = async (label) => {
  lateStop.actions.push(`bootout-late:${label}`)
  lateStopRequested = true
}
lateStop.value.observe = async (label) => {
  if (label === expected[0].label && lateStopRequested && lateStop.states.get(label)!.loaded) {
    lateStopObserveCount += 1
    if (lateStopObserveCount >= 6) {
      Object.assign(lateStop.states.get(label)!, { loaded: false, instances: 0 })
      lateStopRequested = false
    }
  }
  return lateStopObserve(label)
}
let lateStopError: unknown
try {
  await withWeeklyWriterHold({
    approved: expected,
    maximumHoldMs: 10_000,
    maximumStopWaitMs: 20,
    stopPollIntervalMs: 10,
    driver: lateStop.value,
    operation: async () => undefined,
  })
} catch (error) {
  lateStopError = error
}
assert.ok(lateStopError instanceof WriterHoldError)
assert.match(lateStopError.message, /WRITER_BOOTOUT_TIMEOUT/)
assert.deepEqual(lateStopError.restoreErrors, [])
assert.ok(lateStop.actions.includes(`bootstrap:${expected[0].label}`),
  'a stop completing during restore must be bootstrapped exactly once')
assert.equal(lateStop.states.get(expected[0].label)!.loaded, true)

const dual = driver()
dual.value.bootstrap = async (label) => {
  dual.actions.push(`bootstrap-failed:${label}`)
  throw new Error('SYNTHETIC_BOOTSTRAP_FAILURE')
}
let dualError: unknown
try {
  await withWeeklyWriterHold({
    approved: expected,
    maximumHoldMs: 1_000,
    driver: dual.value,
    operation: async () => { throw new Error('SYNTHETIC_PRIMARY_FAILURE') },
  })
} catch (error) {
  dualError = error
}
assert.ok(dualError instanceof WriterHoldError)
assert.match(dualError.message, /primary=SYNTHETIC_PRIMARY_FAILURE/)
assert.match(dualError.message, /SYNTHETIC_BOOTSTRAP_FAILURE/)
assert.ok(dualError.restoreErrors.some((error) => String(error).includes('WRITER_FINAL_STATE_ERROR')))
assert.equal(dualError.restoreEvidence.complete, false)
assert.ok(dualError.restoreEvidence.restoreErrorCount > 0)

const restoreOrderExpected = midExpected.slice(0, 2)
const restoreOrderStates = new Map(restoreOrderExpected.map((item) => [item.label, {
  ...item, loaded: true, disabled: false, instances: 1,
}]))
const restoreOrderActions: string[] = []
await withWeeklyWriterHold({
  approved: restoreOrderExpected,
  maximumHoldMs: 1_000,
  driver: {
    async observe(label) { return structuredClone(restoreOrderStates.get(label)!) },
    async bootout(label) {
      restoreOrderActions.push(`bootout:${label}`)
      Object.assign(restoreOrderStates.get(label)!, { loaded: false, instances: 0 })
    },
    async bootstrap(label) {
      restoreOrderActions.push(`bootstrap:${label}`)
      Object.assign(restoreOrderStates.get(label)!, { loaded: true, instances: 1 })
    },
    async processGroupAlive() { return false },
    async sleep() {},
    now: () => 0,
  },
  operation: async () => undefined,
})
assert.deepEqual(restoreOrderActions.filter((action) => action.startsWith('bootstrap:')), [
  `bootstrap:${restoreOrderExpected[1].label}`,
  `bootstrap:${restoreOrderExpected[0].label}`,
])

const processGroup = driver()
Object.assign(processGroup.states.get(expected[0].label)!, { pid: 30575, processGroupId: 30575 })
let processGroupPolls = 0
processGroup.value.processGroupAlive = async (value) => {
  assert.equal(value, 30575)
  processGroupPolls += 1
  return processGroupPolls < 3
}
await withWeeklyWriterHold({
  approved: expected,
  maximumHoldMs: 10_000,
  maximumStopWaitMs: 1_000,
  stopPollIntervalMs: 10,
  driver: processGroup.value,
  operation: async () => undefined,
})
assert.ok(processGroupPolls >= 3, 'bootout must wait for the original process group and descendants')

const orphanedGroup = driver()
Object.assign(orphanedGroup.states.get(expected[0].label)!, { pid: 30575, processGroupId: 30575 })
orphanedGroup.value.processGroupAlive = async () => true
await assert.rejects(() => withWeeklyWriterHold({
  approved: expected,
  maximumHoldMs: 10_000,
  maximumStopWaitMs: 20,
  stopPollIntervalMs: 10,
  driver: orphanedGroup.value,
  operation: async () => undefined,
}), (error: unknown) => {
  assert.ok(error instanceof WriterHoldError)
  assert.match(error.message, /WRITER_BOOTOUT_TIMEOUT/)
  assert.match(error.message, /WRITER_RESTORE_PROCESS_GROUP_TIMEOUT/)
  return true
})
assert.ok(!orphanedGroup.actions.some((action) => action.startsWith('bootstrap:')),
  'a surviving process group must block bootstrap to prevent duplicate writers')

const serviceSloStates = new Map(midExpected.map((item, index) => [item.label, {
  ...item,
  loaded: index < 13,
  disabled: index >= 14,
  instances: index < 13 ? 1 : 0,
}]))
let serviceSloClock = 0
const serviceSlo = await withWeeklyWriterHold({
  approved: midExpected,
  maximumHoldMs: 12 * 60 * 60_000,
  maximumStopWaitMs: 60_000,
  restoreSloMs: 60 * 60_000,
  expectedLoadedLabels: midExpected.slice(0, 13).map((item) => item.label),
  expectedUnloadedLabels: midExpected.slice(13).map((item) => item.label),
  expectedDisabledLabels: midExpected.slice(14).map((item) => item.label),
  driver: {
    async observe(label) { return structuredClone(serviceSloStates.get(label)!) },
    async bootout(label) { Object.assign(serviceSloStates.get(label)!, { loaded: false, instances: 0 }) },
    async bootstrap(label) {
      serviceSloClock += 1_000
      Object.assign(serviceSloStates.get(label)!, { loaded: true, instances: 1 })
    },
    async processGroupAlive() { return false },
    async sleep(milliseconds) { serviceSloClock += milliseconds },
    now: () => serviceSloClock,
  },
  operation: async () => undefined,
})
assert.equal(serviceSlo.receipt.restoredLabels.length, 13)
assert.equal(serviceSlo.receipt.alreadyUnloadedLabels.length, 1)
assert.equal(serviceSlo.receipt.intentionallyDisabledLabels.length, 2)
assert.equal(serviceSlo.receipt.restoreDurationMs, 13_000)
assert.equal(serviceSlo.receipt.restoreWithinSlo, true)

console.log(JSON.stringify({ verdict: 'PASS', loadedWriterRestored: true,
  disabledWriterRemainedDisabled: true, multipleInstancesRejected: true,
    identityMismatchRejected: true, holdTimeoutRejected: true,
    delayedBootoutWaited: true, partialBootoutRestoredWithoutDoubleBootstrap: true,
    sixteenWriterMidStopFailureCovered: true, bootoutConfirmationTimeoutCovered: true,
    lateStopCompletionRestored: true,
    primaryAndRestoreErrorsSeparated: true, finalStateMismatchReported: true,
    reverseRestoreOrderVerified: true, processGroupDrainWaited: true,
    persistentProcessGroupBlockedBootstrap: true,
    verificationRunsAfterWriterRestore: true,
    thirteenWriterRestoreDurationMs: serviceSlo.receipt.restoreDurationMs }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
