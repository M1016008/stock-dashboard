import assert from 'node:assert/strict'
import { TriggerConfigError } from '@/lib/trigger-discovery-engine'
import { TriggerDiscoveryInputError } from '@/lib/server/trigger-discovery-read-model'
import {
  parseTriggerDiscoverySearchRequest,
  triggerDiscoveryBaseSearchKey,
} from '@/lib/server/trigger-discovery-search-request'

function parses(overrides: Record<string, unknown> = {}) {
  return parseTriggerDiscoverySearchRequest({ requestedAsOf: '2026-09-06', ...overrides })
}

const defaults = parses()
assert.equal(defaults.input.asOf, '2026-09-06')
assert.equal(defaults.timeframe, 'MONTHLY')
assert.equal(defaults.request.timeframe, 'MONTHLY')
assert.deepEqual(defaults.input.triggerConfig, {
  ma1Period: 20,
  ma2Period: 25,
  slopeLookbackSessions: 20,
  approachLookbackSessions: 20,
  minimumAboveZoneRatio: 0.7,
  maxApproachDistancePct: 5,
  nearDistancePct: 2,
  spreadExpansionEnabled: false,
  spreadLookbackIntervals: 4,
  minExpansionRatio: 0.7,
  requireBullishMaOrder: true,
  belowZoneToleranceEnabled: false,
  maxBelowZonePct: 3,
})
assert.equal(parses({ belowZoneToleranceEnabled: true, maxBelowZonePct: 3 }).input.triggerConfig?.belowZoneToleranceEnabled, true)
assert.equal(parses({ statusFilter: 'BELOW_ZONE' }).request.statusFilter, 'BELOW_ZONE')
assert.equal(triggerDiscoveryBaseSearchKey(defaults.input, defaults.timeframe),
  triggerDiscoveryBaseSearchKey(parses({ statusFilter: 'BELOW_ZONE' }).input, defaults.timeframe),
  'view filter must reuse the same base evaluation')
assert.notEqual(triggerDiscoveryBaseSearchKey(defaults.input, defaults.timeframe),
  triggerDiscoveryBaseSearchKey(parses({ belowZoneToleranceEnabled: true }).input, defaults.timeframe),
  'Below tolerance ON must have a distinct evaluation key')
assert.equal(parses({ spreadExpansionEnabled: true }).input.triggerConfig?.spreadExpansionEnabled, true)
assert.notEqual(
  triggerDiscoveryBaseSearchKey(defaults.input, defaults.timeframe),
  triggerDiscoveryBaseSearchKey(parses({ spreadExpansionEnabled: true }).input, defaults.timeframe),
  'Spread OFF and ON must not share a search cache entry',
)
assert.equal(defaults.page, 1)
assert.equal(defaults.pageSize, 50)
assert.equal(defaults.input.offset, 0)

const biweekly = parses({ timeframe: 'BIWEEKLY' })
assert.equal(biweekly.timeframe, 'BIWEEKLY')
assert.equal(biweekly.request.timeframe, 'BIWEEKLY')
assert.notEqual(
  triggerDiscoveryBaseSearchKey(defaults.input, defaults.timeframe),
  triggerDiscoveryBaseSearchKey(biweekly.input, biweekly.timeframe),
  'Monthly and Biweekly must never share a search cache entry',
)

const arbitrary = parses({
  ma1Period: 10,
  ma2Period: 20,
  markets: ['プライム', 'スタンダード'],
  priceMin: 500,
  priceMax: 5_000,
  averageVolumeMin: 100_000,
  averageVolumeMax: 2_000_000,
  averageTradingValueMin: 50_000_000,
  averageTradingValueMax: 5_000_000_000,
  liquidityLookbackSessions: 40,
  stageFilters: { weekBStage: [1, 2], monthAStage: ['unknown'] },
  sort: { key: 'averageTradingValue', direction: 'desc' },
  page: 3,
  pageSize: 25,
})
assert.deepEqual(arbitrary.input.markets, ['プライム', 'スタンダード'].sort((left, right) => left.localeCompare(right, 'ja')))
assert.equal(arbitrary.input.offset, 50)
assert.equal(arbitrary.input.limit, 25)
assert.deepEqual(arbitrary.input.stageFilters, { weekBStage: [1, 2], monthAStage: ['unknown'] })
assert.equal(arbitrary.input.sortBy, 'averageTradingValue')
assert.equal(arbitrary.input.sortDirection, 'desc')

const scoreSort = parses({ sort: { key: 'triggerScore', direction: 'desc' } })
assert.equal(scoreSort.input.sortBy, 'triggerScore')
assert.equal(scoreSort.input.sortDirection, 'desc')

for (const invalid of [
  { ma1Period: 1 },
  { ma1Period: 20, ma2Period: 20 },
  { maxApproachDistancePct: 1, nearDistancePct: 2 },
  { spreadLookbackIntervals: 1 },
  { spreadLookbackIntervals: 25 },
  { minExpansionRatio: 1.01 },
  { maxBelowZonePct: 0 },
  { maxBelowZonePct: 20.01 },
]) {
  assert.throws(() => parses(invalid), TriggerConfigError)
}

for (const invalid of [
  { requestedAsOf: '2026-02-31' },
  { priceMin: '500' },
  { pageSize: 500 },
  { page: 0 },
  { liquidityLookbackSessions: 0 },
  { maxPriceStalenessSessions: 61 },
  { timeframe: 'WEEKLY' },
  { sort: { key: 'unknown', direction: 'asc' } },
  { stageFilters: { weeklyStage: [1] } },
  { stageFilters: { dayAStage: [0] } },
  { spreadExpansionEnabled: 'true' },
  { requireBullishMaOrder: 1 },
  { belowZoneToleranceEnabled: 'true' },
  { statusFilter: 'UNKNOWN' },
]) {
  assert.throws(() => parseTriggerDiscoverySearchRequest({ requestedAsOf: '2026-09-06', ...invalid }), TriggerDiscoveryInputError)
}

console.log('trigger discovery API request tests passed')
