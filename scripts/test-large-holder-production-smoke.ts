import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { assertLargeHolderIdentity, assertLargeHolderInvariant, largeHolderIdentity,
  largeHolderInvariant } from './lib/large-holder-production-smoke'

const current = {
  snapshotId: 'snapshot-1',
  snapshotStatus: 'VALIDATED_WITH_QUARANTINE',
  certificationAsOf: '2026-09-25',
  priceDate: '2026-09-25',
  currentPositionCount: 359,
  investorCount: 233,
  activityCounts: { NEW_5PCT: 12, INCREASE: 8, DECREASE: 4, EXIT_5PCT: 0 },
  quarantinedDocumentCount: 3,
  publicCurrentValuationReadyCount: 282,
}

const identity = largeHolderIdentity(current, '2026-09-25')
assert.equal(identity.snapshotId, 'snapshot-1')
assert.equal(largeHolderInvariant(current, '2026-09-25').activityCount, 24)
assert.doesNotThrow(() => assertLargeHolderIdentity({ ...current }, identity, '2026-09-25'))
assert.doesNotThrow(() => assertLargeHolderInvariant(
  largeHolderInvariant(current, '2026-09-25'),
  { ...current },
  '2026-09-25',
))

assert.throws(
  () => largeHolderIdentity({ error: 'certified_snapshot_stale' }, '2026-09-25'),
  /certified_snapshot_stale/,
)
assert.throws(
  () => largeHolderIdentity({ ...current, priceDate: '2026-09-24' }, '2026-09-25'),
  /priceDate is stale/,
)
assert.throws(
  () => largeHolderIdentity({ ...current, certificationAsOf: '2026-09-24' }, '2026-09-25'),
  /certification is not current/,
)
assert.throws(
  () => largeHolderIdentity({ ...current, snapshotStatus: 'STALE' }, '2026-09-25'),
  /snapshotStatus is not certified/,
)
assert.throws(
  () => assertLargeHolderIdentity({ ...current, snapshotId: 'snapshot-2' }, identity, '2026-09-25'),
  /snapshotId changed/,
)
assert.throws(
  () => assertLargeHolderInvariant(
    largeHolderInvariant(current, '2026-09-25'),
    { ...current, investorCount: 234 },
    '2026-09-25',
  ),
  /investorCount/,
)

const smoke = readFileSync('scripts/smoke-production-site.ts', 'utf8')
const suite = smoke.slice(smoke.indexOf('async function runLargeHolderSmokeChecks'),
  smoke.indexOf('async function runSavedEvaluationCheck'))
for (const name of [
  'Large Holder API overview',
  'Large Holder API rankings',
  'Large Holder API activity',
  'Large Holder API investors',
  'Large Holder API investor detail',
  'Large Holder API stock integration',
  'Large Holder API filing source',
]) assert.ok(suite.includes(name), `missing production smoke API check: ${name}`)
for (const name of [
  'Large Holder page overview',
  'Large Holder page rankings',
  'Large Holder page activity',
  'Large Holder page investor detail',
]) assert.ok(suite.includes(name), `missing production smoke page check: ${name}`)
assert.ok(!suite.includes("method: 'POST'"), 'Large Holder production smoke must remain read-only')

console.log('large-holder production smoke certification and fail-closed regression: PASS')
