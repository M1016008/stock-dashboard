import assert from 'node:assert/strict'
import { withWeeklyWriterHold, type ApprovedWriterIdentity,
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
assert.deepEqual(held.receipt.heldLabels, [expected[0].label])
assert.deepEqual(held.receipt.alreadyUnloadedLabels, [expected[1].label])
assert.deepEqual(held.receipt.intentionallyDisabledLabels, [expected[2].label])
assert.deepEqual(held.receipt.restoredLabels, [expected[0].label])
assert.equal(normal.states.get(expected[2].label)!.disabled, true)
assert.equal(normal.states.get(expected[2].label)!.loaded, false)

const failing = driver()
await assert.rejects(() => withWeeklyWriterHold({
  approved: expected,
  maximumHoldMs: 1_000,
  driver: failing.value,
  operation: async () => { throw new Error('SYNC_FAILED') },
}), /SYNC_FAILED/)
assert.equal(failing.states.get(expected[0].label)!.loaded, true, 'loaded writer must be restored after failure')
assert.equal(failing.states.get(expected[2].label)!.loaded, false, 'disabled writer must remain disabled')

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

console.log(JSON.stringify({ verdict: 'PASS', loadedWriterRestored: true,
  disabledWriterRemainedDisabled: true, multipleInstancesRejected: true,
    identityMismatchRejected: true, holdTimeoutRejected: true,
    verificationRunsAfterWriterRestore: true }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
