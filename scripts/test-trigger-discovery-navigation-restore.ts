import assert from 'node:assert/strict'
import {
  parseTriggerDiscoveryNavigationSnapshot,
  serializeTriggerDiscoveryNavigationSnapshot,
  TRIGGER_DISCOVERY_NAVIGATION_TTL_MS,
  type TriggerDiscoveryNavigationPayload,
} from '../lib/client/trigger-discovery-navigation-restore'

const now = Date.UTC(2026, 8, 15, 0, 0, 0)
const returnUrl = '/trigger-discovery?qa=navigation-restore&mode=current'
const returnToken = 'qa-return-token'
const payload = {
  mode: 'current',
  timeframe: 'BIWEEKLY',
  draft: {
    asOf: '2026-08-25',
    ma1Period: '20',
    ma2Period: '25',
    maxDistance: '5',
    nearDistance: '2',
    spreadExpansionEnabled: true,
    spreadLookbackIntervals: '4',
    minExpansionRatioPct: '70',
    requireBullishMaOrder: true,
    priceMin: '500',
    priceMax: '5000',
    averageVolumeMin: '300000',
    averageVolumeMax: '',
    averageTradingValueMin: '100000000',
    averageTradingValueMax: '',
    liquidityLookbackSessions: '20',
  },
  selectedMarkets: ['プライム'],
  stageFilters: { monthAStage: [1], monthBStage: [1] },
  effectiveEngineConfig: {
    slopeLookbackSessions: 3,
    approachLookbackSessions: 3,
    minimumAboveZoneRatio: 0.5,
    maxPriceStalenessSessions: 3,
  },
  viewConfig: { sort: { key: 'triggerScore', direction: 'desc' }, pageSize: 100 },
  response: {
    contractVersion: 'trigger-discovery-search-v1',
    meta: {
      requestedAsOf: '2026-08-25',
      resolvedAsOf: '2026-08-25',
      timeframe: 'BIWEEKLY',
      pitUniverseCount: 4200,
      currentPriceCount: 4170,
      staleAcceptedCount: 30,
      triggerEvaluatedCount: 4200,
      triggerMatchedCount: 303,
      matchedCount: 88,
      returnedCount: 0,
      page: 2,
      pageSize: 100,
      totalPages: 3,
    },
    criteria: {
      ma1Period: 20,
      ma2Period: 25,
      maxApproachDistancePct: 5,
      nearDistancePct: 2,
      spreadExpansionEnabled: true,
      spreadLookbackIntervals: 4,
      minExpansionRatio: 0.7,
      requireBullishMaOrder: true,
      liquidityLookbackSessions: 20,
      markets: ['プライム'],
      stageFilters: { monthAStage: [1], monthBStage: [1] },
      sort: { key: 'triggerScore', direction: 'desc' },
    },
    rows: [],
    performance: {
      totalMs: 100,
      dbQueryMs: 80,
      maPreparationMs: 10,
      engineEvaluationMs: 5,
      stageJoinMs: 2,
      queryCount: 5,
      cacheHit: false,
    },
  },
  lastRequest: {
    requestedAsOf: '2026-08-25',
    timeframe: 'BIWEEKLY',
    ma1Period: 20,
    ma2Period: 25,
    maxApproachDistancePct: 5,
    nearDistancePct: 2,
    spreadExpansionEnabled: true,
    spreadLookbackIntervals: 4,
    minExpansionRatio: 0.7,
    requireBullishMaOrder: true,
    markets: ['プライム'],
    stageFilters: { monthAStage: [1], monthBStage: [1] },
    sort: { key: 'triggerScore', direction: 'desc' },
    page: 2,
    pageSize: 100,
  },
  builderOpen: false,
  selectedSavedId: 'saved-trigger-1',
  activeSavedId: 'saved-trigger-1',
  scroll: { windowY: 840, resultsTableX: 516, resultsTableY: 1_260 },
} satisfies TriggerDiscoveryNavigationPayload

const serialized = serializeTriggerDiscoveryNavigationSnapshot({ returnToken, returnUrl, payload, savedAt: now })
const restored = parseTriggerDiscoveryNavigationSnapshot({
  serialized,
  historyToken: returnToken,
  currentUrl: returnUrl,
  now: now + 1_000,
})

assert.ok(restored, 'a matching one-time browser Back snapshot must restore')
assert.deepEqual(restored.payload, payload, 'the response, PIT request, Saved Trigger, view, and scroll state must round-trip exactly')
assert.equal(restored.payload.lastRequest.page, 2)
assert.equal(restored.payload.lastRequest.pageSize, 100)
assert.deepEqual(restored.payload.lastRequest.sort, { key: 'triggerScore', direction: 'desc' })
assert.equal(restored.payload.timeframe, 'BIWEEKLY')
assert.equal(restored.payload.response.meta.requestedAsOf, '2026-08-25')
assert.deepEqual(restored.payload.scroll, { windowY: 840, resultsTableX: 516, resultsTableY: 1_260 })

assert.equal(parseTriggerDiscoveryNavigationSnapshot({
  serialized,
  historyToken: undefined,
  currentUrl: returnUrl,
  now,
}), null, 'a new direct visit without the original history marker must not restore')
assert.equal(parseTriggerDiscoveryNavigationSnapshot({
  serialized,
  historyToken: 'another-history-entry',
  currentUrl: returnUrl,
  now,
}), null, 'another history entry must not consume the snapshot')
assert.equal(parseTriggerDiscoveryNavigationSnapshot({
  serialized,
  historyToken: returnToken,
  currentUrl: '/trigger-discovery?mode=period',
  now,
}), null, 'a period-analysis URL must not receive a current-search snapshot')
assert.equal(parseTriggerDiscoveryNavigationSnapshot({
  serialized,
  historyToken: returnToken,
  currentUrl: returnUrl,
  now: now + TRIGGER_DISCOVERY_NAVIGATION_TTL_MS + 1,
}), null, 'expired snapshots must not restore indefinitely')
assert.equal(parseTriggerDiscoveryNavigationSnapshot({
  serialized: '{invalid',
  historyToken: returnToken,
  currentUrl: returnUrl,
  now,
}), null, 'malformed session data must fail closed')

console.log('Trigger Discovery navigation restore tests passed')
