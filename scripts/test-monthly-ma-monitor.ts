import assert from 'node:assert/strict'
import {
  MONTHLY_MA_CLUSTER_CONFIG,
  MONTHLY_MA_MONITOR_PERIODS,
  buildMonthlyMaClusterGroups,
  buildMonthlyMaMonitorSeries,
  findMonthlyMaClusters,
} from '@/lib/monthly-ma-monitor'
import {
  buildContinuousMonthlyMaSeries,
  buildSnapshotCalculations,
} from '@/lib/snapshots/continuous-ma'
import type { OHLCV } from '@/types/stock'

const periods = [...MONTHLY_MA_MONITOR_PERIODS]
assert.deepEqual(periods, [3, 5, 10, 15, 20, 25])

const clusterGroups = buildMonthlyMaClusterGroups(periods)
assert.equal(clusterGroups.length, 10)
assert.deepEqual(clusterGroups[0].periods, [3, 5, 10])
assert.deepEqual(clusterGroups.find((group) => group.key === '3-5-10-15-20-25')?.periods, periods)

function monthlyRows(): OHLCV[] {
  const rows: OHLCV[] = []
  for (let month = 0; month < 30; month += 1) {
    const year = 2023 + Math.floor(month / 12)
    const monthOfYear = (month % 12) + 1
    for (const day of [10, 20]) {
      const close = 100 + month * 2 + day / 100
      rows.push({
        date: `${year}-${String(monthOfYear).padStart(2, '0')}-${day}`,
        open: close - 0.5,
        high: close + 1,
        low: close - 1,
        close,
        volume: 100_000 + month,
      })
    }
  }
  return rows
}

const source = monthlyRows()
const generic = buildContinuousMonthlyMaSeries(source, periods)
const snapshot = buildSnapshotCalculations(source, { includeWarmup: true })
const genericLatest = generic.at(-1)!
const snapshotLatest = snapshot.at(-1)!
assert.ok(genericLatest.values.get(15) != null)
for (const [period, key] of [
  [3, 'monthly_ma_3'],
  [5, 'monthly_ma_5'],
  [10, 'monthly_ma_10'],
  [20, 'monthly_ma_20'],
  [25, 'monthly_ma_25'],
] as const) {
  assert.equal(genericLatest.values.get(period), snapshotLatest[key])
}

const shortMid = findMonthlyMaClusters(new Map([
  [3, 100], [5, 100.8], [10, 101.2], [15, 120], [20, 140], [25, 160],
]))
assert.equal(shortMid.length, 1)
assert.deepEqual(shortMid[0].periods, [3, 5, 10])
assert.equal(shortMid[0].type, 'short_mid')
assert.equal(shortMid[0].isStrong, false)

const midStrong = findMonthlyMaClusters(new Map([
  [3, 80], [5, 100], [10, 100.5], [15, 101], [20, 101.5], [25, 130],
]))
assert.equal(midStrong.length, 1)
assert.deepEqual(midStrong[0].periods, [5, 10, 15, 20])
assert.equal(midStrong[0].type, 'mid')
assert.equal(midStrong[0].isStrong, true)

const midLong = findMonthlyMaClusters(new Map([
  [3, 70], [5, 80], [10, 100], [15, 100.5], [20, 101], [25, 101.5],
]))
assert.deepEqual(midLong[0].periods, [10, 15, 20, 25])
assert.equal(midLong[0].type, 'mid_long')

assert.equal(findMonthlyMaClusters(new Map([
  [3, 100], [5, 101], [10, 120], [15, 140], [20, 160], [25, 180],
])).length, 0)
assert.equal(findMonthlyMaClusters(new Map([
  [3, 100], [5, 102], [10, 104], [15, 140], [20, 160], [25, 180],
])).length, 0)
assert.equal(MONTHLY_MA_CLUSTER_CONFIG.spreadThresholdPct, 3)

const bandSeries = buildMonthlyMaMonitorSeries([
  { date: '2026-07-01', open: 110, high: 111, low: 109, close: 110, targetValue: 100, targetLow: 99, targetHigh: 101 },
  { date: '2026-07-02', open: 108, high: 109, low: 107, close: 108, targetValue: 100, targetLow: 99, targetHigh: 101 },
  { date: '2026-07-03', open: 106, high: 107, low: 105, close: 106, targetValue: 100, targetLow: 99, targetHigh: 101 },
  { date: '2026-07-04', open: 104, high: 105, low: 103, close: 104, targetValue: 100, targetLow: 99, targetHigh: 101 },
  { date: '2026-07-05', open: 102.5, high: 103, low: 102, close: 102.5, targetValue: 100, targetLow: 99, targetHigh: 101 },
  { date: '2026-07-06', open: 102, high: 102.5, low: 100.5, close: 102, targetValue: 100, targetLow: 99, targetHigh: 101 },
])
assert.equal(bandSeries.at(-1)?.isApproaching, true)
assert.equal(bandSeries.at(-1)?.approachDirection, 'above')
assert.equal(bandSeries.at(-1)?.isTouch, true)

const bandCross = buildMonthlyMaMonitorSeries([
  { date: '2026-08-01', open: 98, high: 98.5, low: 97.5, close: 98, targetValue: 100, targetLow: 99, targetHigh: 101 },
  { date: '2026-08-02', open: 102, high: 102.5, low: 101.5, close: 102, targetValue: 100, targetLow: 99, targetHigh: 101 },
])
assert.equal(bandCross[1].crossDirection, 'up')

const inactiveBand = buildMonthlyMaMonitorSeries([
  { date: '2026-08-01', open: 98, high: 100, low: 97, close: 98, targetValue: 100, targetLow: 99, targetHigh: 101, eventActive: false },
  { date: '2026-08-02', open: 102, high: 103, low: 100, close: 102, targetValue: 100, targetLow: 99, targetHigh: 101, eventActive: false },
])
assert.equal(inactiveBand[0].isTouch, false)
assert.equal(inactiveBand[1].crossDirection, null)

const newlyActiveBand = buildMonthlyMaMonitorSeries([
  { date: '2026-08-01', open: 98, high: 98.5, low: 97.5, close: 98, targetValue: 100, targetLow: 99, targetHigh: 101, eventActive: false },
  { date: '2026-08-02', open: 102, high: 102.5, low: 101.5, close: 102, targetValue: 100, targetLow: 99, targetHigh: 101, eventActive: true },
])
assert.equal(newlyActiveBand[1].crossDirection, null)

const stableActiveBand = buildMonthlyMaMonitorSeries([
  { date: '2026-08-01', open: 98, high: 98.5, low: 97.5, close: 98, targetValue: 100, targetLow: 99, targetHigh: 101, eventActive: true },
  { date: '2026-08-02', open: 102, high: 102.5, low: 101.5, close: 102, targetValue: 100, targetLow: 99, targetHigh: 101, eventActive: true },
])
assert.equal(stableActiveBand[1].crossDirection, 'up')

const lineDeparture = buildMonthlyMaMonitorSeries([
  { date: '2026-09-01', open: 100, high: 100.5, low: 99.5, close: 100, targetValue: 100 },
  { date: '2026-09-02', open: 101, high: 101.5, low: 100.5, close: 101, targetValue: 100 },
])
assert.equal(lineDeparture[1].crossDirection, null)

const roundedContactBoundary = buildMonthlyMaMonitorSeries([
  { date: '2026-10-01', open: 102.0000004, high: 102.1, low: 101.9, close: 102.0000004, targetValue: 100 },
])
assert.equal(roundedContactBoundary[0].distancePct, 2)
assert.equal(roundedContactBoundary[0].absDistancePct, 2)
assert.equal(roundedContactBoundary[0].isContactDefault, true)

console.log('monthly MA monitor tests passed')
