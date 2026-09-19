import assert from 'node:assert/strict'
import {
  aggregateSpreadSensitivity, SpreadSensitivitySourceDriftError,
} from '@/lib/server/trigger-discovery-spread-sensitivity'
import {
  DEFAULT_MA_ZONE_TRIGGER_CONFIG, evaluateMaSpreadExpansion, evaluateMaZoneTrigger,
  type MaZoneTriggerObservation,
} from '@/lib/trigger-discovery-engine'
import { spreadSensitivityGrid } from '@/lib/trigger-discovery-spread-sensitivity'
import type { TriggerOutcomeRow } from '@/lib/trigger-discovery-outcome-contract'

const grid = spreadSensitivityGrid()
assert.equal(grid.length, 13)
assert.deepEqual(grid.map((row) => [row.lookbackIntervals, row.requiredExpandedIntervals]), [
  [3, 2], [3, 3], [4, 2], [4, 3], [4, 4], [6, 3], [6, 4], [6, 5], [6, 6],
  [8, 4], [8, 6], [8, 7], [8, 8],
])
assert.equal(new Set(grid.map((row) => `${row.lookbackIntervals}:${row.requiredExpandedIntervals}`)).size, 13)
const baseline = grid.find((row) => row.isBaseline)!
assert.equal(baseline.configuredMinExpansionRatio, 0.7)
assert.equal(baseline.requiredExpandedIntervals, 3)
assert.equal(baseline.effectiveMinExpansionRatio, 0.75)
assert.equal(grid.find((row) => row.lookbackIntervals === 8 && row.requiredExpandedIntervals === 7)
  ?.effectiveMinExpansionRatio, 0.875)

const series: MaZoneTriggerObservation[] = Array.from({ length: 30 }, (_, i) => ({
  date: `2025-01-${String(i + 1).padStart(2, '0')}`,
  price: 120, ma1: 101 + i * .2, ma2: 100 + i * .02,
}))
const config = { ...DEFAULT_MA_ZONE_TRIGGER_CONFIG, spreadExpansionEnabled: true }
const direct = evaluateMaSpreadExpansion({ observations: series, config, bothRising: true })
const engine = evaluateMaZoneTrigger({ observations: series, asOf: '2025-01-30', config })
assert.equal(direct.maSpreadPct, engine.maSpreadPct)
assert.equal(direct.maSpreadSlope, engine.maSpreadSlope)
assert.equal(direct.maSpreadExpansionRatio, engine.maSpreadExpansionRatio)
assert.equal(direct.passed, engine.maSpreadExpanding)

function outcome(date: string, diagnostic: ReturnType<typeof evaluateMaSpreadExpansion>): TriggerOutcomeRow {
  return {
    ticker: '7003', eventDate: date, snapshotBasis: 'CURRENT', spreadDiagnosticDate: date,
    spreadExpansionAvailable: diagnostic.available, spreadExpansionPass: diagnostic.passed,
    bullishMaOrder: diagnostic.bullishMaOrder,
    maSpreadPct: diagnostic.maSpreadPct, maSpreadSlope: diagnostic.maSpreadSlope,
    maSpreadExpansionRatio: diagnostic.maSpreadExpansionRatio,
    availability20: 'AVAILABLE', availability60: 'AVAILABLE',
    availability120: 'INSUFFICIENT_FUTURE_DATA', availability245: 'NOT_REQUESTED',
    return20: .1, return60: -.05, return120: null, return245: null,
    mfe20: .12, mfe60: .2, mfe120: null, mfe245: null,
    mae20: -.03, mae60: -.07, mae120: null, mae245: null,
  } as TriggerOutcomeRow
}

const current = series.slice(-9)
const eventDate = current.at(-1)!.date
const reference = evaluateMaSpreadExpansion({ observations: current, config, bothRising: true })
for (const configuredMinExpansionRatio of [.7, .71, .74, .75]) {
  const equivalent = evaluateMaSpreadExpansion({ observations: current,
    config: { ...config, minExpansionRatio: configuredMinExpansionRatio }, bothRising: true })
  assert.equal(equivalent.passed, reference.passed)
  assert.equal(equivalent.expandingIntervals, reference.expandingIntervals)
}
const row = outcome(eventDate, reference)
const future = { date: '2025-01-31', price: 120, ma1: 900, ma2: 100 }
const observations = new Map([[`7003\u001f${eventDate}`, [...current, future]]])
const result = aggregateSpreadSensitivity({ rows: [row], observations, compareSavedBaseline: true })
assert.equal(result.overall.eventCount, 1)
assert.equal(result.parameterSets.length, 13)
assert.equal(result.parameterSets.find((parameter) => parameter.isBaseline)?.passEventCount, 1)
for (const parameter of result.parameterSets) {
  assert.equal(parameter.passEventCount + parameter.failEventCount + parameter.unknownEventCount, 1)
  assert.equal(parameter.groups.PASS.horizons[0]?.smallSample, true)
}
assert.equal(result.parameterSets.find((parameter) => parameter.isBaseline)?.groups.PASS.horizons[0]?.medianReturn, .1)
assert.equal(result.parameterSets.find((parameter) => parameter.isBaseline)?.groups.PASS.horizons[1]?.medianMfe, .2)
assert.equal(result.parameterSets.find((parameter) => parameter.isBaseline)?.passRate, 1)

const short = current.slice(-4)
const shortDate = short.at(-1)!.date
const shortRow = outcome(shortDate, evaluateMaSpreadExpansion({ observations: short, config, bothRising: true }))
const shortResult = aggregateSpreadSensitivity({ rows: [shortRow],
  observations: new Map([[`7003\u001f${shortDate}`, short]]), compareSavedBaseline: true })
assert.equal(shortResult.parameterSets.find((parameter) => parameter.lookbackIntervals === 3
  && parameter.requiredExpandedIntervals === 2)?.unknownEventCount, 0)
assert.equal(shortResult.parameterSets.find((parameter) => parameter.lookbackIntervals === 8
  && parameter.requiredExpandedIntervals === 4)?.unknownEventCount, 1)
assert.equal(shortResult.parameterSets.find((parameter) => parameter.lookbackIntervals === 8
  && parameter.requiredExpandedIntervals === 4)?.failEventCount, 0)

assert.throws(() => aggregateSpreadSensitivity({
  rows: [{ ...row, maSpreadPct: 99 }], observations, compareSavedBaseline: true,
}), SpreadSensitivitySourceDriftError)
assert.equal(row.return20, .1)
assert.equal(row.mfe60, .2)
assert.equal(row.mae60, -.07)
console.log('spread sensitivity grid, PIT, baseline, unknown, source drift: PASS')
