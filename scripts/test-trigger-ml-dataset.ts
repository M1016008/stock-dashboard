import assert from 'node:assert/strict'
import { calculateEventOutcome } from '@/lib/server/trigger-discovery-outcome-analysis'
import { buildTriggerPathPoints, calculateTriggerPath } from '@/lib/server/trigger-path-calculation'
import { assignEpisodeSplits, buildMlRowsForEvent, shouldPurge, splitPolicyFromSessions,
  type ExactStageRow } from '@/lib/server/trigger-ml-dataset-core'
import { DEFAULT_MA_ZONE_TRIGGER_CONFIG } from '@/lib/trigger-discovery-engine'
import type { TriggerHistoricalScanEvent } from '@/lib/trigger-discovery-historical-scan-contract'
import type { PathResearchRow } from '@/lib/trigger-path-research-contract'
import { TRIGGER_ML_FEATURE_REGISTRY, validateTriggerMlRow } from '@/lib/trigger-ml-dataset-contract'

const dates = Array.from({ length: 305 }, (_, index) => {
  const date = new Date(Date.UTC(2024, 11, 1 + index))
  return date.toISOString().slice(0, 10)
})
const eventIndex = 25
const eventDate = dates[eventIndex]
const allDays = dates.map((date, index) => ({ ticker: '7003', date, high: 114, low: 104,
  close: index === eventIndex ? 108 : 110 }))
allDays[eventIndex + 1] = { ticker: '7003', date: dates[eventIndex + 1], high: 99, low: 90, close: 95 }
allDays[eventIndex + 2] = { ticker: '7003', date: dates[eventIndex + 2], high: 105, low: 99, close: 103 }
allDays[eventIndex + 3] = { ticker: '7003', date: dates[eventIndex + 3], high: 109, low: 104, close: 105 }
allDays[eventIndex + 4] = { ticker: '7003', date: dates[eventIndex + 4], high: 114, low: 104, close: 112 }

const event: TriggerHistoricalScanEvent = {
  date: eventDate, eventType: 'STATUS_CHANGED', ticker: '7003', companyName: '三井E&S',
  previousStatus: 'APPROACHING', currentStatus: 'IN_ZONE', snapshotBasis: 'CURRENT',
  price: 108, ma1: 110, ma2: 100, zoneDistancePct: 0,
  triggerScore: 73, scoreBreakdown: { proximity: 25, approach: 15, maTrend: 16,
    stageStructure: 12, liquidity: 5 } as TriggerHistoricalScanEvent['scoreBreakdown'],
  priceDate: eventDate, maDate: eventDate, stageDate: eventDate,
  dayAStage: 1, dayBStage: 2, weekAStage: 3, weekBStage: 4,
  monthAStage: 5, monthBStage: 6,
}
const config = { ...DEFAULT_MA_ZONE_TRIGGER_CONFIG }
const stageRows = new Map<string, ExactStageRow>(dates.map((date) => [date, {
  date, daily_a_stage: 1, daily_b_stage: 2, weekly_a_stage: 3, weekly_b_stage: 4,
  monthly_a_stage: 5, monthly_b_stage: 6,
}]))
stageRows.delete(dates[eventIndex + 5])
const policy = splitPolicyFromSessions(dates.slice(eventIndex, 275), {
  validationStart: dates[90], testStart: dates[130], embargoSessions: 0,
})

function fixture(futureLow: number) {
  const daily = allDays.map((row) => ({ ...row }))
  daily[eventIndex + 10].low = futureLow
  const series = buildTriggerPathPoints({ rows: daily, event,
    maByDate: new Map(dates.map((date) => [date, { ma1: 110, ma2: 100, atr20: 2 }])),
    marketSessions: dates.slice(eventIndex) })
  const outcome = calculateEventOutcome(event, daily, [20, 60, 120, 245], dates)
  const profile = calculateTriggerPath({ eventKey: 'e1', event, timeframe: 'MONTHLY',
    ma1Period: 20, ma2Period: 25, analysisCutoffDate: dates.at(-1)!,
    marketSessions: dates.slice(eventIndex), points: series })
  const row: PathResearchRow = { eventKey: 'e1', episodeKey: 'episode-1', ticker: '7003',
    eventDate, eventSelector: 'IN_ZONE_ENTERED', anchorSemantics: 'EVENT_SAVED_PRICE',
    timeframe: 'MONTHLY', ma1Period: 20, ma2Period: 25, anchorPrice: 108,
    analysisCutoffDate: dates.at(-1)!, pathStatus: 'AVAILABLE', pathProfile: profile, outcome }
  return buildMlRowsForEvent({ datasetId: 'dataset-fixture', row, event,
    series, daily, marketSessions: dates, stages: stageRows, config, split: 'TRAIN',
    splitPolicy: policy, analysisCutoffDate: dates.at(-1)! })
}

const ordinary = fixture(101)
const extreme = fixture(1)
assert.deepEqual(ordinary.map((row) => row.checkpoint),
  ['D0', 'D3', 'D5', 'D10', 'D20', 'LOWER_RECLAIM', 'UPPER_RECLAIM'])
for (const row of ordinary) {
  validateTriggerMlRow(row)
  assert.ok(row.sourceObservationDates.every((date) => date <= row.featureAsOfDate))
  assert.equal(row.sourceAudit.savedScoreAtHit, 73)
  assert.equal(row.eventFeature.scoreWithoutFlowComponent, 68)
  assert.ok(row.outcomeLabel.snapshotForward.every((label) => label.labelAnchorDate === row.featureAsOfDate))
}
for (const checkpoint of ['D3', 'D5'] as const) {
  const a = ordinary.find((row) => row.checkpoint === checkpoint)!
  const b = extreme.find((row) => row.checkpoint === checkpoint)!
  assert.deepEqual(a.eventFeature, b.eventFeature)
  assert.deepEqual(a.pathSnapshot, b.pathSnapshot, `${checkpoint} cannot see D10 extreme`)
  assert.equal(a.featureAsOfDate, dates[eventIndex + Number(checkpoint.slice(1))])
}
assert.notEqual(ordinary.find((row) => row.checkpoint === 'D10')!.pathSnapshot.maxDownsideSoFar,
  extreme.find((row) => row.checkpoint === 'D10')!.pathSnapshot.maxDownsideSoFar)
assert.equal(ordinary.find((row) => row.checkpoint === 'D5')!.pathSnapshot.dayAStageAsOf, 'UNKNOWN')
assert.equal(ordinary.find((row) => row.checkpoint === 'D3')!.pathSnapshot.dayAStageAsOf, 'S1')
assert.equal(ordinary.find((row) => row.checkpoint === 'LOWER_RECLAIM')!.featureAsOfDate, dates[eventIndex + 2])
assert.equal(ordinary.find((row) => row.checkpoint === 'UPPER_RECLAIM')!.featureAsOfDate, dates[eventIndex + 4])
assert.ok(ordinary.find((row) => row.checkpoint === 'LOWER_RECLAIM')!.pathSnapshot.hasReclaimedZoneLower)
assert.equal(ordinary.find((row) => row.checkpoint === 'D0')!.pathSnapshot.maxDownsideSoFar, null)
assert.deepEqual(ordinary.find((row) => row.checkpoint === 'D0')!.outcomeLabel.eventAnchored,
  ordinary.find((row) => row.checkpoint === 'D0')!.outcomeLabel.snapshotForward)
assert.notDeepEqual(ordinary.find((row) => row.checkpoint === 'D5')!.outcomeLabel.eventAnchored,
  ordinary.find((row) => row.checkpoint === 'D5')!.outcomeLabel.snapshotForward)
assert.ok(ordinary.find((row) => row.checkpoint === 'D0')!.purged)
assert.equal(ordinary.find((row) => row.checkpoint === 'D0')!.purgedByHorizon['20'], false)
assert.equal(ordinary.find((row) => row.checkpoint === 'D0')!.purgedByHorizon['245'], true)

const sameEpisode = assignEpisodeSplits([
  { eventKey: 'e1', episodeKey: 'x', eventDate: dates[40] },
  { eventKey: 'e2', episodeKey: 'x', eventDate: dates[140] },
  { eventKey: 'e3', episodeKey: 'y', eventDate: dates[140] },
], policy)
assert.equal(sameEpisode.get('x'), 'TRAIN')
assert.equal(sameEpisode.get('y'), 'TEST')
assert.equal(shouldPurge('TRAIN', ordinary[0].outcomeLabel.snapshotForward[3], policy, dates), true)
assert.equal(shouldPurge('TEST', ordinary[0].outcomeLabel.snapshotForward[3], policy, dates), false)
assert.ok(TRIGGER_ML_FEATURE_REGISTRY.every((column) =>
  !/volume|liquidity|turnover|tradingvalue|return20|mfe20|future/i.test(column.name)))
assert.equal(TRIGGER_ML_FEATURE_REGISTRY.find((column) => column.name === 'eventFeature.fromAbove')?.type,
  'boolean')

const truncatedRow: PathResearchRow = {
  eventKey: 'e1', episodeKey: 'episode-1', ticker: '7003', eventDate,
  eventSelector: 'IN_ZONE_ENTERED', anchorSemantics: 'EVENT_SAVED_PRICE', timeframe: 'MONTHLY',
  ma1Period: 20, ma2Period: 25, anchorPrice: 108, analysisCutoffDate: dates[eventIndex + 4],
  pathStatus: 'AVAILABLE', pathProfile: null,
  outcome: calculateEventOutcome(event, allDays.slice(0, eventIndex + 5), [20, 60, 120, 245],
    dates.slice(0, eventIndex + 5)),
}
const truncated = buildMlRowsForEvent({ datasetId: 'cutoff-fixture', row: truncatedRow, event,
  series: buildTriggerPathPoints({ rows: allDays.slice(0, eventIndex + 5), event,
    maByDate: new Map(dates.map((date) => [date, { ma1: 110, ma2: 100, atr20: 2 }])),
    marketSessions: dates.slice(eventIndex, eventIndex + 5) }),
  daily: allDays.slice(0, eventIndex + 5), marketSessions: dates.slice(0, eventIndex + 5),
  stages: stageRows, config, split: 'TRAIN',
  splitPolicy: splitPolicyFromSessions(dates.slice(eventIndex, eventIndex + 5)),
  analysisCutoffDate: dates[eventIndex + 4] })
assert.ok(!truncated.some((row) => row.checkpoint === 'D5' || row.checkpoint === 'D20'))
assert.ok(truncated[0].outcomeLabel.snapshotForward.every((label) =>
  !label.labelAvailable && label.return == null))

const unavailable = buildMlRowsForEvent({ datasetId: 'missing-path-fixture',
  row: { ...truncatedRow, pathStatus: 'MISSING_MARKET_DATA' }, event,
  series: [], daily: [], marketSessions: dates.slice(0, eventIndex + 5), stages: new Map(),
  config, split: 'TRAIN', splitPolicy: splitPolicyFromSessions(dates.slice(eventIndex, eventIndex + 5)),
  analysisCutoffDate: dates[eventIndex + 4] })
assert.equal(unavailable.length, 1)
assert.equal(unavailable[0].pathSnapshot.totalBelowZoneSessionsSoFar, null)
assert.equal(unavailable[0].pathSnapshot.hasReclaimedZoneLower, null)
assert.equal(unavailable[0].outcomeLabel.snapshotForward[0].labelAvailable, false)

console.log('trigger ML dataset PIT/checkpoint/label/split/leakage fixtures: PASS')
