import assert from 'node:assert/strict'
import {
  assertNoLegacyH10DecisionFields,
  directionalizeEventHorizon,
  evaluateEventPricePath,
  evaluateFirstPassage,
  matchesSmaConditions,
  reconstructEventSmaSnapshot,
  summarizeDistribution,
  summarizeFirstPassage,
  summarizeThresholdHits,
  type EventPriceBar,
  type ExistingSmaFeatureInput,
} from '@/lib/research/six-stage-event-path-research'

const prices: EventPriceBar[] = Array.from({ length: 22 }, (_, index) => ({
  date: `2022-01-${String(index + 1).padStart(2, '0')}`,
  open: 100,
  high: index === 2 ? 106 : index === 4 ? 111 : index === 8 ? 116 : index === 15 ? 121 : 102,
  low: index === 3 ? 94 : index === 7 ? 89 : index === 12 ? 84 : index === 18 ? 79 : 98,
  close: 100 + index / 2,
}))

const path = evaluateEventPricePath(prices, 0)
assert.equal(path.termination, 'COMPLETE')
assert.deepEqual(path.missingHorizons, [])
assert.equal(path.completedHorizons.length, 4)
const horizon20 = path.completedHorizons.at(-1)!
assert.equal(horizon20.firstUpDay[5], 2)
assert.equal(horizon20.firstDownDay[5], 3)
assert.equal(horizon20.firstUpDay[20], 15)
assert.equal(horizon20.firstDownDay[20], 18)

const long = directionalizeEventHorizon(horizon20, 'LONG')
const short = directionalizeEventHorizon(horizon20, 'SHORT')
assert.equal(long.hitOrder[5], 'FAVORABLE_FIRST')
assert.equal(short.hitOrder[5], 'ADVERSE_FIRST')
assert.equal(short.priceReturn, -long.priceReturn)
assert.equal(short.mfe, -long.mae)
assert.equal(short.mae, -long.mfe)

const longPassage = evaluateFirstPassage({
  excursions: path.dailyExcursions,
  direction: 'LONG',
  horizonSessions: 20,
  favorableThreshold: 0.05,
  adverseThreshold: 0.05,
  termination: path.termination,
})
const shortPassage = evaluateFirstPassage({
  excursions: path.dailyExcursions,
  direction: 'SHORT',
  horizonSessions: 20,
  favorableThreshold: 0.05,
  adverseThreshold: 0.05,
  termination: path.termination,
})
assert.equal(longPassage.classification, 'FAVORABLE_FIRST')
assert.equal(shortPassage.classification, 'ADVERSE_FIRST')
const passageSummary = summarizeFirstPassage([longPassage, shortPassage])
assert.equal(passageSummary.favorableFirstRateAllValid, 0.5)
assert.equal(passageSummary.favorableFirstRateDecided, 0.5)

const sameSession = evaluateFirstPassage({
  excursions: [{ day: 1, upReturn: 0.06, downReturn: -0.06 }],
  direction: 'LONG', horizonSessions: 5, favorableThreshold: 0.05, adverseThreshold: 0.05,
  termination: 'RIGHT_CENSORED',
})
assert.equal(sameSession.classification, 'SAME_SESSION')
assert.equal(summarizeFirstPassage([sameSession]).sameSessionUnknown, 1)

const rawBoundary = evaluateEventPricePath([
  { date: '2022-01-01', open: 100, high: 100, low: 100, close: 100 },
  ...Array.from({ length: 5 }, (_, index) => ({
    date: `2022-01-${String(index + 2).padStart(2, '0')}`,
    open: 100, high: 110, low: 90, close: 100,
  })),
], 0)
assert.equal(rawBoundary.completedHorizons[0].firstUpDay[10], 1)
assert.equal(rawBoundary.completedHorizons[0].firstDownDay[10], 1)

const exactBoundary = evaluateFirstPassage({
  excursions: [{ day: 1, upReturn: 115 / 100 - 1, downReturn: 1 - 1 }],
  direction: 'LONG', horizonSessions: 5, favorableThreshold: 0.15, adverseThreshold: 0.15,
  termination: 'RIGHT_CENSORED',
})
assert.equal(exactBoundary.favorableDay, 1)

const validBeforeLaterInvalid = evaluateFirstPassage({
  excursions: Array.from({ length: 5 }, (_, index) => ({ day: index + 1, upReturn: 0.01, downReturn: -0.01 })),
  direction: 'LONG', horizonSessions: 5, favorableThreshold: 0.05, adverseThreshold: 0.05,
  termination: 'INVALID_PRICE',
})
assert.equal(validBeforeLaterInvalid.classification, 'NEITHER')
assert.equal(validBeforeLaterInvalid.completeHorizon, true)

const rightCensored = evaluateEventPricePath(prices.slice(0, 12), 0)
assert.equal(rightCensored.termination, 'RIGHT_CENSORED')
assert.deepEqual(rightCensored.completedHorizons.map((row) => row.horizonSessions), [5, 10])
assert.deepEqual(rightCensored.missingHorizons, [15, 20])

const cutoffPrices = prices.map((bar, index) => ({
  ...bar,
  date: index < 6
    ? `2022-12-${String(index + 23).padStart(2, '0')}`
    : `2023-01-${String(index - 5).padStart(2, '0')}`,
}))
const cutoffCensored = evaluateEventPricePath(cutoffPrices, 0)
assert.equal(cutoffCensored.termination, 'RIGHT_CENSORED')
assert.deepEqual(cutoffCensored.completedHorizons.map((row) => row.horizonSessions), [5])
assert.equal(cutoffCensored.maximumObservedExitDate, '2022-12-28')
assert.ok(cutoffCensored.completedHorizons.every((row) => row.exitDate <= '2022-12-30'))

const long5 = path.completedHorizons.map((row) => directionalizeEventHorizon(row, 'LONG'))
const hits = summarizeThresholdHits(long5, 5)
assert.equal(hits.samples, 4)
assert.equal(hits.favorableHitRate, 1)
assert.equal(hits.adverseHitRate, 1)

const featureInput: ExistingSmaFeatureInput = {
  canonicalClose: 110,
  dailyFastGap: 105 / 100 - 1,
  closeGap: { 25: Math.log(110 / 100), 75: Math.log(110 / 95), 150: Math.log(110 / 90), 200: Math.log(110 / 85), 300: Math.log(110 / 80) },
  angle: { 25: 4, 75: 3, 150: 2, 200: 1, 300: -1 },
  curvature: { 25: 0.4, 75: 0.3, 150: 0.2, 200: 0.1, 300: -0.1 },
}
const sma = reconstructEventSmaSnapshot(featureInput)
assert.ok(Math.abs(sma.values[5]! - 105) < 1e-10)
assert.deepEqual(sma.highToLowOrder, [5, 25, 75, 150, 200, 300])
assert.equal(matchesSmaConditions(sma, [
  { period: 25, metric: 'ANGLE', minimum: 3.9 },
  { period: 200, metric: 'CLOSE_GAP', minimum: 0.2 },
], [5, 25, 75, 150, 200, 300]), true)
assert.equal(matchesSmaConditions(sma, [{ period: 5, metric: 'ANGLE', minimum: 0 }]), false)

const distribution = summarizeDistribution([
  { ticker: 'A', signalDate: '2020-01-01', value: -0.02 },
  { ticker: 'A', signalDate: '2020-02-01', value: 0.01 },
  { ticker: 'B', signalDate: '2021-01-01', value: 0.02 },
  { ticker: 'C', signalDate: '2022-01-01', value: 1 },
])
assert.equal(distribution.samples, 4)
assert.equal(distribution.median, 0.015)
assert.equal(distribution.positiveRate, 0.75)
assert.equal(distribution.distinctTickers, 3)
assert.equal(distribution.distinctYears, 3)
assert.ok(distribution.topAbsolute1Contribution! > 0.9)
assert.ok(distribution.meanWithoutTopAbsolute5! < distribution.mean!)

assert.doesNotThrow(() => assertNoLegacyH10DecisionFields({ rows: [{ value: 0.001 }] }))
assert.doesNotThrow(() => assertNoLegacyH10DecisionFields({ pValue: 0.01, qValue: 0.02 }))
assert.throws(() => assertNoLegacyH10DecisionFields({ selected: true }), /legacy H10 decision field/)

console.log('six-stage event path research tests passed')
