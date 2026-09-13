import assert from 'node:assert/strict'
import {
  evaluateBiweeklyMaPullbackTrigger,
  type MaZoneTriggerConfig,
} from '@/lib/trigger-discovery-engine'
import {
  BIWEEKLY_ANCHOR_MONDAY,
  buildBiweeklyBarsFromDaily,
  buildBiweeklyBarsFromWeekly,
  buildContinuousBiweeklyMaSeriesFromWeekly,
} from '@/lib/trigger-discovery-timeframe'
import type { OHLCV } from '@/types/stock'

function bar(date: string, open: number, high: number, low: number, close: number, volume: number): OHLCV {
  return { date, open, high, low, close, volume, adjustedClose: null }
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

function weeklyRowsFromBiweeklyCloses(closes: number[], start = '2026-01-09'): OHLCV[] {
  return closes.flatMap((close, index) => [
    bar(addDays(start, index * 14), close, close + 1, close - 1, close, 100 + index),
    bar(addDays(start, index * 14 + 7), close, close + 2, close - 2, close, 200 + index),
  ])
}

assert.equal(BIWEEKLY_ANCHOR_MONDAY, '1970-01-05')

const completeTwoWeeks = buildBiweeklyBarsFromDaily([
  bar('2026-01-05', 100, 104, 99, 103, 1_000),
  bar('2026-01-09', 103, 110, 102, 108, 2_000),
  bar('2026-01-12', 109, 112, 105, 106, 3_000),
  bar('2026-01-16', 106, 115, 104, 114, 4_000),
], { adjustSplits: false })
assert.deepEqual(completeTwoWeeks, [
  bar('2026-01-16', 100, 115, 99, 114, 10_000),
])

const incompleteFirstWeek = buildBiweeklyBarsFromDaily([
  bar('2026-01-05', 100, 104, 99, 103, 1_000),
  bar('2026-01-09', 103, 110, 102, 108, 2_000),
], { adjustSplits: false })
assert.deepEqual(incompleteFirstWeek, [bar('2026-01-09', 100, 110, 99, 108, 3_000)])

const yearBoundary = buildBiweeklyBarsFromWeekly([
  bar('2023-12-29', 80, 90, 75, 88, 100),
  bar('2024-01-05', 89, 98, 86, 96, 200),
])
assert.deepEqual(yearBoundary, [bar('2024-01-05', 80, 98, 75, 96, 300)])

const isoWeek53 = buildBiweeklyBarsFromWeekly([
  bar('2020-12-31', 50, 55, 48, 54, 150),
  bar('2021-01-08', 55, 60, 52, 59, 250),
])
assert.deepEqual(isoWeek53, [bar('2021-01-08', 50, 60, 48, 59, 400)])

const holidayWeek = buildBiweeklyBarsFromDaily([
  bar('2026-05-01', 200, 205, 198, 204, 1_000),
  bar('2026-05-07', 205, 210, 202, 209, 2_000),
  bar('2026-05-08', 209, 214, 207, 212, 3_000),
], { adjustSplits: false })
assert.equal(holidayWeek.length, 1)
assert.deepEqual(holidayWeek[0], bar('2026-05-08', 200, 214, 198, 212, 6_000))

const stableSource = [
  bar('2026-01-09', 10, 12, 9, 11, 10),
  bar('2026-01-16', 11, 13, 10, 12, 20),
  bar('2026-01-23', 12, 14, 11, 13, 30),
  bar('2026-01-30', 13, 15, 12, 14, 40),
  bar('2026-02-06', 14, 16, 13, 15, 50),
  bar('2026-02-13', 15, 17, 14, 16, 60),
]
const stableAtA = buildBiweeklyBarsFromWeekly(stableSource.slice(0, 2))
const stableAtPlusOneWeek = buildBiweeklyBarsFromWeekly(stableSource.slice(0, 3))
const stableAtPlusTwoWeeks = buildBiweeklyBarsFromWeekly(stableSource.slice(0, 4))
assert.deepEqual(stableAtPlusOneWeek.slice(0, -1), stableAtA)
assert.deepEqual(stableAtPlusTwoWeeks.slice(0, 1), stableAtA)

const pitWithFuture = buildBiweeklyBarsFromDaily([
  ...completeTwoWeeks.flatMap((row) => [row]),
  bar('2026-01-23', 114, 120, 110, 119, 5_000),
], { adjustSplits: false }).filter((row) => row.date <= '2026-01-16')
assert.deepEqual(pitWithFuture, completeTwoWeeks)

const maWeeklyRows = weeklyRowsFromBiweeklyCloses(
  Array.from({ length: 130 }, (_, index) => 100 + index),
)
const periods = [10, 20, 25, 50, 100]
const maSeries = buildContinuousBiweeklyMaSeriesFromWeekly(
  maWeeklyRows,
  periods,
  { adjustSplits: false },
)
const biweeklyCloses = buildBiweeklyBarsFromWeekly(maWeeklyRows).map((row) => row.close)
const latestMa = maSeries.at(-1)!
for (const period of periods) {
  const expected = biweeklyCloses.slice(-period).reduce((sum, close) => sum + close, 0) / period
  assert.ok(Math.abs((latestMa.values.get(period) ?? Number.NaN) - expected) < 1e-10)
}

const triggerConfig: Partial<MaZoneTriggerConfig> = {
  ma1Period: 2,
  ma2Period: 3,
  slopeLookbackSessions: 2,
  approachLookbackSessions: 3,
  minimumAboveZoneRatio: 2 / 3,
  maxApproachDistancePct: 10,
  nearDistancePct: 2,
}

function evaluateCloses(closes: number[]) {
  const weekly = weeklyRowsFromBiweeklyCloses(closes)
  return evaluateBiweeklyMaPullbackTrigger({
    rows: weekly,
    asOf: weekly.at(-1)!.date,
    config: triggerConfig,
  })
}

const approaching = evaluateCloses([10, 20, 30, 40, 50, 60, 68, 73, 76])
assert.equal(approaching.status, 'APPROACHING')
assert.equal(approaching.matched, true)
assert.equal(approaching.bothRising, true)
assert.equal(approaching.fromAbove, true)

const near = evaluateCloses([10, 20, 30, 40, 50, 60, 68, 72, 74])
assert.equal(near.status, 'NEAR')
assert.equal(near.matched, true)

const inZone = evaluateCloses([10, 20, 30, 40, 50, 60, 68, 70, 69])
assert.equal(inZone.status, 'IN_ZONE')
assert.equal(inZone.matched, true)

const belowZone = evaluateCloses([10, 20, 30, 40, 50, 60, 68, 70, 60])
assert.equal(belowZone.status, 'BELOW_ZONE')
assert.equal(belowZone.matched, false)

const oneMaFalling = evaluateCloses([10, 20, 30, 40, 50, 60, 20, 40, 55])
assert.equal(oneMaFalling.ma1Trend, 'RISING')
assert.equal(oneMaFalling.ma2Trend, 'FALLING')
assert.equal(oneMaFalling.matched, false)

const fromBelow = evaluateCloses([10, 20, 30, 40, 50, 60, 50, 55, 59])
assert.equal(fromBelow.bothRising, true)
assert.equal(fromBelow.fromAbove, false)
assert.equal(fromBelow.matched, false)

const pitRows = weeklyRowsFromBiweeklyCloses([10, 20, 30, 40, 50, 60, 68, 72, 74])
const pitAsOf = pitRows.at(-3)!.date
const pitResult = evaluateBiweeklyMaPullbackTrigger({
  rows: [...pitRows, bar('2030-01-04', 1, 2, 0.5, 1, 1)],
  asOf: pitAsOf,
  config: triggerConfig,
})
assert.ok((pitResult.observationDate ?? '') <= pitAsOf)

console.log('trigger discovery biweekly tests passed')
