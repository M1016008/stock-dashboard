import assert from 'node:assert/strict'
import { runningJobIsVisible } from '@/lib/server/running-job-health'
import {
  marketPriceCoverageNeedsAttention,
  supplementalSourceNeedsAttention,
  supplementalSourcesAreFresh,
} from '@/lib/status-health'
import { decodePathSegment } from '@/lib/url-path'

const now = Date.parse('2026-08-11T12:00:00.000Z')
const oldStart = Math.floor((now - 60 * 60 * 1_000) / 1_000)

assert.equal(decodePathSegment('7003%2ET'), '7003.T')
assert.equal(decodePathSegment('%E0%A4%A'), '%E0%A4%A')

assert.equal(supplementalSourceNeedsAttention({ fresh: false }), true)
assert.equal(supplementalSourceNeedsAttention({ fresh: false, configured: false, optional: true }), false)
assert.equal(supplementalSourcesAreFresh({
  themes: { fresh: true },
  usEarnings: { fresh: false, configured: false, optional: true },
}), true)
assert.equal(marketPriceCoverageNeedsAttention({ pricePct: 96.6, priceProcessingComplete: true }), false)
assert.equal(marketPriceCoverageNeedsAttention({ pricePct: 96.6, priceProcessingComplete: false }), true)

assert.equal(runningJobIsVisible({
  jobType: 'physical_momentum_jp_normalize_chunk',
  startedAt: oldStart,
}, 'node scripts/run-ml-learning.ts', now), false)
assert.equal(runningJobIsVisible({
  jobType: 'physical_momentum_jp_normalize_chunk',
  startedAt: oldStart,
}, 'node scripts/batch-physical-momentum.ts', now), true)
assert.equal(runningJobIsVisible({
  jobType: 'forward_extrema_ml',
  startedAt: oldStart,
}, 'node scripts/batch-forward-extrema.ts', now), true)
assert.equal(runningJobIsVisible({
  jobType: 'physical_momentum_us_raw_chunk',
  startedAt: oldStart,
  payloadJson: JSON.stringify({ heartbeatAt: '2026-08-11T11:55:00.000Z' }),
}, '', now), false)
assert.equal(runningJobIsVisible({
  jobType: 'snapshot_compute',
  startedAt: Math.floor((now - 5 * 60 * 1_000) / 1_000),
  payloadJson: JSON.stringify({ heartbeatAt: '2026-08-11T11:59:00.000Z' }),
}, '', now), false)
assert.equal(runningJobIsVisible({
  jobType: 'snapshot_compute',
  startedAt: Math.floor((now - 5 * 60 * 1_000) / 1_000),
  payloadJson: JSON.stringify({ heartbeatAt: '2026-08-11T11:59:00.000Z' }),
}, 'node scripts/build-us-snapshots.ts', now), true)
assert.equal(runningJobIsVisible({
  jobType: 'unknown_long_running_job',
  startedAt: oldStart,
}, '', now), true)
assert.equal(runningJobIsVisible({
  jobType: 'physical_momentum_us_raw_chunk',
  startedAt: oldStart,
}, null, now), true)

console.log('status health tests passed')
