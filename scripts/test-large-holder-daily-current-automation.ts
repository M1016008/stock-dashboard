import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  classifyLargeHolderDailyFailure,
  planLargeHolderDailyCurrent,
  type LargeHolderDailySnapshotStatus,
} from '@/lib/large-holders/daily-current-automation'

const status = (input: Partial<LargeHolderDailySnapshotStatus> = {}): LargeHolderDailySnapshotStatus => ({
  state: { marketDate: '2026-10-06', priceEvidenceDate: '2026-10-06', priceBatchComplete: true },
  snapshotPriceDate: '2026-10-05',
  status: 'STALE',
  certificationStatus: 'VALIDATED',
  currentGeneratedAt: '2026-10-05T10:00:00.000Z',
  ...input,
})

assert.equal(planLargeHolderDailyCurrent(status({ snapshotPriceDate: '2026-10-06', status: 'CURRENT' })).action,
  'ALREADY_CURRENT')
assert.equal(planLargeHolderDailyCurrent(status()).action, 'REFRESH')
assert.equal(planLargeHolderDailyCurrent(status({ state: {
  marketDate: '2026-10-06', priceEvidenceDate: '2026-10-05', priceBatchComplete: true,
} })).action, 'REFRESH')
assert.equal(planLargeHolderDailyCurrent(status({ state: {
  marketDate: '2026-10-02', priceEvidenceDate: '2026-10-02', priceBatchComplete: true,
}, snapshotPriceDate: '2026-10-02', status: 'CURRENT' })).action, 'ALREADY_CURRENT')
assert.equal(classifyLargeHolderDailyFailure('official_certification_gate_failed'), 'VALIDATION_FAILED')
assert.equal(classifyLargeHolderDailyFailure('fetch failed cause=ETIMEDOUT'), 'FAILED_TRANSIENT')
assert.equal(classifyLargeHolderDailyFailure('large_holder_status_timeout'), 'FAILED_TRANSIENT')
assert.equal(planLargeHolderDailyCurrent(status({ snapshotPriceDate: '2026-10-06', status: 'CURRENT',
  certificationStatus: 'VALIDATED_WITH_QUARANTINE' })).action, 'ALREADY_CURRENT')
assert.equal(classifyLargeHolderDailyFailure('large_holder_update_lock_busy'), 'ALREADY_RUNNING')
assert.equal(planLargeHolderDailyCurrent(status({ snapshotPriceDate: '2026-10-02' })).action, 'REFRESH')
assert.equal(planLargeHolderDailyCurrent(status({ snapshotPriceDate: '2026-10-06', status: 'CURRENT' })).action,
  'ALREADY_CURRENT')
assert.equal(planLargeHolderDailyCurrent(status({ state: {
  marketDate: '2026-10-06', priceEvidenceDate: '2026-10-06', priceBatchComplete: false,
} })).action, 'WAITING_FOR_PRICE_EVIDENCE')
assert.equal(planLargeHolderDailyCurrent(status({ snapshotPriceDate: '2026-10-07' })).action,
  'VALIDATION_FAILED')

const runner = readFileSync('scripts/run-large-holder-daily-current.ts', 'utf8')
const installer = readFileSync('scripts/install-local-large-holder-update.ts', 'utf8')
assert.match(runner, /snapshot-refresh/)
assert.match(runner, /update-daily/)
assert.match(runner, /SKIPPED_NO_API_KEY/)
assert.match(runner, /daily-current-events\.ndjson/)
assert.match(installer, /production\.env/)
assert.match(installer, /launchAgentStorageEnvironmentXml/)
assert.match(installer, /RunAtLoad/)
assert.doesNotMatch(installer, /large-holders:update-daily/)

console.log('large-holder daily CURRENT automation: PASS (A-J, canonical pipeline, bounded schedule)')
