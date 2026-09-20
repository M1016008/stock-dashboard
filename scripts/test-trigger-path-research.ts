import assert from 'node:assert/strict'
import { aggregatePathResearch, parsePathResearchQuery, PathResearchInputError } from '@/lib/server/trigger-path-research-segmentation'
import { pathBand } from '@/lib/trigger-path-bands'
import type { TriggerOutcomeRow } from '@/lib/trigger-discovery-outcome-contract'
import type { TriggerPathWindow, TriggerPathProfile } from '@/lib/trigger-path-contract'
import type { PathResearchRow } from '@/lib/trigger-path-research-contract'

function windowAt(depth: number | null, closeDepth = depth): TriggerPathWindow {
  return {
    breachedZoneLower: depth != null && depth < 0,
    firstZoneLowerCloseBreachDate: closeDepth != null && closeDepth < 0 ? '2025-01-07' : null,
    maxZoneUndershootLowPct: depth,
    maxZoneUndershootClosePct: closeDepth,
    tradingSessionsToDeepest: depth != null && depth < 0 ? 3 : null,
    totalBelowZoneSessions: closeDepth != null && closeDepth < 0 ? 3 : 0,
    longestConsecutiveBelowZoneSessions: closeDepth != null && closeDepth < 0 ? 2 : 0,
    sessionsFromHitToLowerReclaim: depth != null && depth < 0 ? 5 : null,
    reclaimStatus: depth != null && depth < 0 ? 'LOWER_RECLAIMED' : 'NOT_BREACHED',
    undershootToZoneWidthRatio: depth != null && depth < 0 ? Math.abs(depth) / 2 : null,
    undershootAtrMultiple: depth != null && depth < 0 ? Math.abs(depth) / 4 : null,
  } as TriggerPathWindow
}

const depthCases = [
  [0, 'NOT_BREACHED'], [-0.999, 'D0_1'], [-1, 'D1_2'], [-1.999, 'D1_2'],
  [-2, 'D2_3'], [-2.999, 'D2_3'], [-3, 'D3_5'], [-4.999, 'D3_5'],
  [-5, 'D5_8'], [-7.999, 'D5_8'], [-8, 'D8_PLUS'],
] as const
for (const [value, expected] of depthCases) {
  assert.equal(pathBand(windowAt(value), 'pathDepthLow'), expected, `low ${value}`)
  assert.equal(pathBand(windowAt(value), 'pathDepthClose'), expected, `close ${value}`)
}
assert.equal(pathBand(windowAt(-1, 0), 'pathDepthClose'), 'NOT_BREACHED')
assert.equal(pathBand(null, 'pathDepthLow'), 'UNKNOWN')
assert.equal(pathBand(windowAt(-2), 'timeToDeepest'), 'S3_5')
assert.equal(pathBand(windowAt(-2), 'belowZoneDuration'), 'S3_5')
assert.equal(pathBand(windowAt(-2), 'longestBelowStreak'), 'S1_2')
assert.equal(pathBand(windowAt(-2), 'reclaimSpeed'), 'S4_5')
assert.equal(pathBand(windowAt(-2), 'reclaimStatus'), 'LOWER_RECLAIMED')
assert.equal(pathBand(windowAt(-2), 'zoneWidthDepth'), 'R1_2')
assert.equal(pathBand(windowAt(-2), 'atrDepth'), 'R05_1')
for (const [value, expected] of [[1, 'S0_1'], [2, 'S2_3'], [3, 'S2_3'], [4, 'S4_5'],
  [5, 'S4_5'], [6, 'S6_10'], [10, 'S6_10'], [11, 'S11_20'], [20, 'S11_20'],
  [21, 'S21_PLUS']] as const) {
  assert.equal(pathBand({ ...windowAt(-2), sessionsFromHitToLowerReclaim: value }, 'reclaimSpeed'), expected)
}

function outcome(index: number): TriggerOutcomeRow {
  return {
    eventDate: `2025-01-${String(index + 6).padStart(2, '0')}`,
    ticker: index < 2 ? '7003' : `70${index}3`, companyName: 'Fixture',
    eventType: 'STATUS_CHANGED', previousStatus: 'APPROACHING', currentStatus: 'NEAR',
    anchorPrice: 100, triggerScore: 50 + index * 10,
    dayAStage: 1, dayBStage: 2, weekAStage: 3, weekBStage: 4, monthAStage: 5, monthBStage: 6,
    return20: 0.01 * index, return60: 0.10 * index, return120: 0.20 * index, return245: 0.30 * index,
    mfe20: 0.05 * index, mfe60: 0.10 * index, mfe120: 0.20 * index, mfe245: 0.30 * index,
    mae20: -0.01 * index, mae60: -0.02 * index, mae120: -0.03 * index, mae245: -0.04 * index,
    availability20: 'AVAILABLE', availability60: 'AVAILABLE', availability120: 'AVAILABLE', availability245: 'AVAILABLE',
  }
}

function row(index: number, depth: number, unavailable = false): PathResearchRow {
  const fixed = windowAt(depth)
  return {
    eventKey: `e${index}`, episodeKey: index < 2 ? 'episode-7003' : `episode-${index}`,
    ticker: outcome(index).ticker, eventDate: outcome(index).eventDate,
    eventSelector: 'NEAR_ENTERED', anchorSemantics: 'EVENT_SAVED_PRICE',
    timeframe: 'MONTHLY', ma1Period: 20, ma2Period: 25, anchorPrice: 100,
    analysisCutoffDate: '2026-09-18', pathStatus: 'AVAILABLE',
    pathProfile: { horizonPaths: ([20, 60, 120, 245] as const).map((horizon) => ({
      horizonSessions: horizon, availability: !(unavailable && horizon === 60),
      endDate: '2025-04-01', returnFromHit: 0.01, path: unavailable && horizon === 60 ? null : fixed,
    })) } as TriggerPathProfile,
    outcome: outcome(index),
  }
}

const rows = [row(0, -0.5), row(1, -2), row(2, -5), row(3, -8, true)]
const manifest = { jobId: 'job', outcomeJobId: 'outcome', analysisCutoffDate: '2026-09-18',
  eventSelector: 'NEAR_ENTERED', timeframe: 'MONTHLY' as const,
  ma1Period: 20, ma2Period: 25, sourceObservationCount: 4 }
const base = { rows, manifest, horizon: 60 as const, unit: 'EVENT' as const, cohort: null }
const one = aggregatePathResearch({ ...base, dimensions: ['pathDepthLow'] })
assert.equal(one.overall.eventCount, 4)
assert.equal(one.overall.horizon.eligibleCount, 3)
assert.equal(one.meta.excludedForMissingFixedPath, 1)
assert.deepEqual(one.meta.anchorSemanticsCounts, { EVENT_SAVED_PRICE: 4, PREVIOUS_CANDIDATE_SAVED_PRICE: 0 })
assert.equal(one.groups.at(-1)?.keys.pathDepthLow, 'UNKNOWN')
assert.ok(Object.values(one.integrity).every(Boolean))
const two = aggregatePathResearch({ ...base, dimensions: ['pathDepthLow', 'stage:monthA'] })
assert.ok(Object.values(two.integrity).every(Boolean))
assert.equal(two.groups.reduce((sum, group) => sum + group.eventCount, 0), 4)
const episode = aggregatePathResearch({ ...base, unit: 'EPISODE', dimensions: ['pathDepthLow'] })
assert.equal(episode.overall.eventCount, 3)
assert.equal(episode.groups.find((group) => group.keys.pathDepthLow === 'D0_1')?.eventCount, 1)
assert.equal(episode.groups.find((group) => group.keys.pathDepthLow === 'D2_3'), undefined)
const cohort = aggregatePathResearch({ ...base, dimensions: ['pathDepthLow'],
  cohort: { metric: 'mfe', horizon: 60, min: 0.2, max: null } })
assert.equal(cohort.meta.outcomeConditioned, true)
assert.equal(cohort.overall.eventCount, 2)
assert.equal(cohort.overall.horizon.eligibleCount, 1)
const mixedAnchor = aggregatePathResearch({ ...base,
  rows: [rows[0], { ...rows[1], anchorSemantics: 'PREVIOUS_CANDIDATE_SAVED_PRICE' }],
  manifest: { ...manifest, sourceObservationCount: 2, eventSelector: 'ALL' },
  dimensions: ['pathDepthLow'],
})
assert.deepEqual(mixedAnchor.meta.anchorSemanticsCounts,
  { EVENT_SAVED_PRICE: 1, PREVIOUS_CANDIDATE_SAVED_PRICE: 1 })
for (const horizon of [20, 60, 120, 245] as const) {
  const sample = aggregatePathResearch({ ...base, horizon, dimensions: ['pathDepthLow'] })
  assert.equal(sample.meta.horizon, horizon)
  assert.ok(Object.values(sample.integrity).every(Boolean))
}
assert.deepEqual(parsePathResearchQuery('http://local/?dimension=pathDepthLow&horizon=60').dimensions, ['pathDepthLow'])
assert.throws(() => parsePathResearchQuery('http://local/?dimension=pathDepthLow&dimension=pathDepthLow'), PathResearchInputError)
assert.throws(() => parsePathResearchQuery('http://local/?dimension=unknown'), PathResearchInputError)
assert.throws(() => parsePathResearchQuery('http://local/?dimension=pathDepthLow&dimension=scoreBand&dimension=stage:monthA'), PathResearchInputError)
console.log('trigger-path-research: PASS (bands, boundaries, fixed windows, cohort, Event/Episode, 1D/2D integrity)')
