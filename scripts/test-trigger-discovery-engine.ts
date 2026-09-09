import assert from 'node:assert/strict'
import {
  DEFAULT_MA_ZONE_TRIGGER_CONFIG,
  TriggerConfigError,
  calculateMaZoneSnapshot,
  classifyMaTrend,
  evaluateMaZoneTrigger,
  evaluateMonthlyMaPullbackTrigger,
  type MaZoneTriggerConfig,
  type MaZoneTriggerObservation,
} from '@/lib/trigger-discovery-engine'
import type { OHLCV } from '@/types/stock'

const config: MaZoneTriggerConfig = {
  ...DEFAULT_MA_ZONE_TRIGGER_CONFIG,
  slopeLookbackSessions: 4,
  approachLookbackSessions: 4,
  minimumAboveZoneRatio: 0.7,
}

function observations(args: {
  prices: number[]
  ma1?: number[]
  ma2?: number[]
}): MaZoneTriggerObservation[] {
  return args.prices.map((price, index) => ({
    date: `2026-01-${String(index + 1).padStart(2, '0')}`,
    price,
    ma1: args.ma1?.[index] ?? 100 + index,
    ma2: args.ma2?.[index] ?? 90 + index,
  }))
}

function evaluate(rows: MaZoneTriggerObservation[], overrides: Partial<MaZoneTriggerConfig> = {}) {
  return evaluateMaZoneTrigger({
    observations: rows,
    asOf: rows.at(-1)?.date ?? '2026-01-31',
    config: { ...config, ...overrides },
  })
}

assert.equal(classifyMaTrend(0.02, 0.01), 'RISING')
assert.equal(classifyMaTrend(0.01, 0.01), 'FLAT')
assert.equal(classifyMaTrend(-0.02, 0.01), 'FALLING')

const risingToward = evaluate(observations({ prices: [112, 111, 110, 108, 105] }))
assert.equal(risingToward.ma1Trend, 'RISING')
assert.equal(risingToward.ma2Trend, 'RISING')
assert.equal(risingToward.bothRising, true)
assert.equal(risingToward.fromAbove, true)
assert.equal(risingToward.approachDirection, 'TOWARD_ZONE')
assert.ok((risingToward.approachVelocityPctPointsPerSession ?? 0) > 0)
assert.equal(risingToward.status, 'NEAR')
assert.equal(risingToward.matched, true)

const onlyMa1Rising = evaluate(observations({
  prices: [112, 111, 110, 108, 105],
  ma1: [100, 101, 102, 103, 104],
  ma2: [94, 93, 92, 91, 90],
}))
assert.equal(onlyMa1Rising.ma1Trend, 'RISING')
assert.equal(onlyMa1Rising.ma2Trend, 'FALLING')
assert.equal(onlyMa1Rising.bothRising, false)
assert.equal(onlyMa1Rising.matched, false)

const onlyMa2Rising = evaluate(observations({
  prices: [112, 111, 110, 108, 105],
  ma1: [104, 103, 102, 101, 100],
  ma2: [90, 91, 92, 93, 94],
}))
assert.equal(onlyMa2Rising.ma1Trend, 'FALLING')
assert.equal(onlyMa2Rising.ma2Trend, 'RISING')
assert.equal(onlyMa2Rising.bothRising, false)

const bothFalling = evaluate(observations({
  prices: [112, 111, 110, 108, 105],
  ma1: [104, 103, 102, 101, 100],
  ma2: [94, 93, 92, 91, 90],
}))
assert.equal(bothFalling.ma1Trend, 'FALLING')
assert.equal(bothFalling.ma2Trend, 'FALLING')
assert.equal(bothFalling.bothRising, false)

const bothFlat = evaluate(observations({
  prices: [112, 111, 110, 108, 102],
  ma1: [100, 100, 100, 100, 100],
  ma2: [90, 90, 90, 90, 90],
}))
assert.equal(bothFlat.ma1Trend, 'FLAT')
assert.equal(bothFlat.ma2Trend, 'FLAT')
assert.equal(bothFlat.bothRising, false)

const above = calculateMaZoneSnapshot(110, 100, 90)
assert.equal(above.pricePosition, 'ABOVE_ZONE')
assert.equal(above.zoneUpper, 100)
assert.equal(above.zoneLower, 90)
assert.equal(above.zoneDistancePct, 10)
assert.equal(calculateMaZoneSnapshot(100, 100, 90).pricePosition, 'IN_ZONE')
assert.equal(calculateMaZoneSnapshot(95, 100, 90).pricePosition, 'IN_ZONE')
assert.equal(calculateMaZoneSnapshot(90, 100, 90).pricePosition, 'IN_ZONE')
assert.equal(calculateMaZoneSnapshot(80, 100, 90).pricePosition, 'BELOW_ZONE')
assert.equal(calculateMaZoneSnapshot(95, 90, 100).pricePosition, 'IN_ZONE')
assert.equal(calculateMaZoneSnapshot(95, 100, 90).ma1DistancePct, -5)
assert.ok(Math.abs(calculateMaZoneSnapshot(95, 100, 90).ma2DistancePct - 5.5555555556) < 1e-8)

const fromBelow = evaluate(observations({ prices: [85, 87, 89, 91, 94] }))
assert.equal(fromBelow.fromAbove, false)
assert.equal(fromBelow.matched, false)

const longInZone = evaluate(observations({ prices: [95, 96, 97, 98, 99] }))
assert.equal(longInZone.fromAbove, false)
assert.equal(longInZone.status, 'IN_ZONE')
assert.equal(longInZone.matched, false)

const noisyFromAbove = evaluate(observations({ prices: [112, 100, 111, 108, 105] }))
assert.equal(noisyFromAbove.aboveZoneRatio, 0.75)
assert.equal(noisyFromAbove.fromAbove, true)

const crossedBelow = evaluate(observations({ prices: [112, 89, 111, 108, 105] }))
assert.equal(crossedBelow.fromAbove, false)

const shrinking = evaluate(observations({ prices: [115, 113, 111, 109, 105] }))
assert.equal(shrinking.approachDirection, 'TOWARD_ZONE')
const expanding = evaluate(observations({ prices: [105, 108, 111, 114, 118] }))
assert.equal(expanding.approachDirection, 'AWAY_FROM_ZONE')
const flatDistance = evaluate(observations({
  prices: [105, 106.05, 107.1, 108.15, 109.2],
  ma1: [100, 101, 102, 103, 104],
  ma2: [90, 91, 92, 93, 94],
}))
assert.equal(flatDistance.approachDirection, 'FLAT')
const noisyShrink = evaluate(observations({ prices: [115, 112, 113, 108, 106] }))
assert.equal(noisyShrink.approachDirection, 'TOWARD_ZONE')

const farAbove = evaluate(observations({ prices: [120, 119, 118, 117, 116] }))
assert.equal(farAbove.status, 'NOT_MATCHED')
const exactApproach = evaluate(observations({ prices: [115, 113, 111, 109, 109.2] }))
assert.ok(Math.abs((exactApproach.snapshot?.zoneDistancePct ?? 0) - 5) < 1e-10)
assert.equal(exactApproach.status, 'APPROACHING')
const exactNear = evaluate(observations({ prices: [115, 112, 109, 107, 106.08] }))
assert.ok(Math.abs((exactNear.snapshot?.zoneDistancePct ?? 0) - 2) < 1e-10)
assert.equal(exactNear.status, 'NEAR')
const upperBoundary = evaluate(observations({ prices: [112, 110, 108, 106, 104] }))
assert.equal(upperBoundary.status, 'IN_ZONE')
assert.equal(upperBoundary.matched, true)
const lowerBoundary = evaluate(observations({ prices: [112, 109, 106, 100, 94] }))
assert.equal(lowerBoundary.status, 'IN_ZONE')
const belowZone = evaluate(observations({ prices: [112, 108, 104, 98, 93] }))
assert.equal(belowZone.status, 'BELOW_ZONE')
assert.equal(belowZone.matched, false)

const insufficient = evaluate(observations({ prices: [110, 108, 106] }))
assert.equal(insufficient.availability, 'insufficient_history')
assert.equal(insufficient.status, 'NOT_MATCHED')
const invalid = observations({ prices: [112, 111, 110, 108, 105] })
invalid[4].price = Number.NaN
const invalidResult = evaluate(invalid)
assert.equal(invalidResult.availability, 'invalid_data')
assert.equal(invalidResult.status, 'NOT_MATCHED')

assert.throws(() => evaluate(risingToward.snapshot ? observations({ prices: [112, 111, 110, 108, 105] }) : [], {
  ma1Period: 20,
  ma2Period: 20,
}), TriggerConfigError)
assert.throws(() => evaluate(observations({ prices: [112, 111, 110, 108, 105] }), { ma1Period: 1 }), TriggerConfigError)
assert.throws(() => evaluate(observations({ prices: [112, 111, 110, 108, 105] }), { ma2Period: 121 }), TriggerConfigError)
assert.throws(() => evaluate(observations({ prices: [112, 111, 110, 108, 105] }), { maxApproachDistancePct: 101 }), TriggerConfigError)
assert.throws(() => calculateMaZoneSnapshot(Number.POSITIVE_INFINITY, 100, 90), TypeError)

const pitRows = observations({ prices: [112, 111, 110, 108, 105] })
const pitBeforeFuture = evaluateMaZoneTrigger({
  observations: [...pitRows, { date: '2026-12-31', price: 1, ma1: 1, ma2: 2 }],
  asOf: '2026-01-05',
  config,
})
assert.deepEqual(pitBeforeFuture, risingToward)

const monthlyRows: OHLCV[] = []
for (let month = 0; month < 30; month += 1) {
  const year = 2023 + Math.floor(month / 12)
  const monthNumber = (month % 12) + 1
  const close = 100 + month
  monthlyRows.push({
    date: `${year}-${String(monthNumber).padStart(2, '0')}-10`,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 100_000,
  })
  monthlyRows.push({
    date: `${year}-${String(monthNumber).padStart(2, '0')}-20`,
    open: close + 1,
    high: close + 2,
    low: close,
    close: close + 1,
    volume: 100_000,
  })
}
const monthlyAsOf = monthlyRows.at(-2)!.date
const monthlyResult = evaluateMonthlyMaPullbackTrigger({
  rows: monthlyRows,
  asOf: monthlyAsOf,
  config: {
    ma1Period: 10,
    ma2Period: 20,
    slopeLookbackSessions: 2,
    approachLookbackSessions: 3,
  },
})
assert.equal(monthlyResult.availability, 'available')
assert.equal(monthlyResult.ma1Period, 10)
assert.equal(monthlyResult.ma2Period, 20)
assert.equal(monthlyResult.observationDate, monthlyAsOf)
assert.equal(monthlyResult.snapshot?.price, monthlyRows.at(-2)?.close)

console.log('trigger discovery engine tests passed')
