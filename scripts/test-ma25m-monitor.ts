import assert from 'node:assert/strict'
import {
  buildMa25mMonitorSeries,
  MA25M_MONITOR_CONFIG,
  parseBoundedMonitorNumber,
  type Ma25mObservation,
} from '@/lib/ma25m-monitor'

function observations(distances: number[], options: { touchAt?: number; ma?: number } = {}): Ma25mObservation[] {
  const ma = options.ma ?? 100
  return distances.map((distance, index) => {
    const close = ma * (1 + distance / 100)
    const touch = index === options.touchAt
    return {
      date: `2026-07-${String(index + 1).padStart(2, '0')}`,
      open: close,
      high: touch ? ma + 1 : close + 0.2,
      low: touch ? ma - 1 : close - 0.2,
      close,
      ma25m: ma,
    }
  })
}

const approachingAbove = buildMa25mMonitorSeries(observations([12, 10, 8.5, 7.8, 6, 5, 4.2, 3.4, 2.7, 2.2, 1.8]))
assert.equal(approachingAbove.at(-1)?.isApproaching, true)
assert.equal(approachingAbove.at(-1)?.approachDirection, 'above')
assert.ok((approachingAbove.at(-1)?.approachSpeedPctPerDay ?? 0) > 0)

const approachingBelow = buildMa25mMonitorSeries(observations([-11, -9, -8, -7.4, -6, -5, -4.1, -3.3, -2.5, -1.8, -1.3]))
assert.equal(approachingBelow.at(-1)?.isApproaching, true)
assert.equal(approachingBelow.at(-1)?.approachDirection, 'below')

const noisyButApproaching = buildMa25mMonitorSeries(observations([9, 8, 8.4, 7, 6.8, 5.9, 6.1, 4.8, 4.2, 3.8, 3.2]))
assert.equal(noisyButApproaching.at(-1)?.isApproaching, true)

const flatNearLine = buildMa25mMonitorSeries(observations([1.2, 1.1, 1.2, 1.15, 1.1, 1.2, 1.15, 1.1, 1.2, 1.15, 1.1]))
assert.equal(flatNearLine.at(-1)?.isApproaching, false)
assert.equal(flatNearLine.at(-1)?.isContactDefault, true)
assert.ok((flatNearLine.at(-1)?.movementScore ?? 100) < 5)

const touch = buildMa25mMonitorSeries(observations([4, 3, 2, 1, 0.5, 1.2, 1.5], { touchAt: 4 }))
assert.equal(touch[4].isTouch, true)
assert.equal(touch[4].touchAgeSessions, 0)
assert.equal(touch[6].touchAgeSessions, 2)
assert.equal(touch[6].lastTouchDate, '2026-07-05')

const cross = buildMa25mMonitorSeries(observations([-4, -3, -2, -1, 0.4, 1.2]))
assert.equal(cross[4].crossDirection, 'up')
assert.equal(cross[5].lastCrossDirection, 'up')
assert.equal(cross[5].crossAgeSessions, 1)

const rapid = buildMa25mMonitorSeries(observations([15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5]))
assert.equal(rapid.at(-1)?.isRapidApproach, true)
assert.ok((rapid.at(-1)?.approachScore ?? 0) > (flatNearLine.at(-1)?.approachScore ?? 100))

const initial = buildMa25mMonitorSeries(observations([5, 4, 3, 2, 1], { touchAt: 4 }))
const seed = initial.at(-1)!
const incrementalSource = observations([3, 2, 1, 0.8, 0.6, 0.5, 0.4])
  .map((row, index) => ({ ...row, date: `2026-08-${String(index + 1).padStart(2, '0')}` }))
const incremental = buildMa25mMonitorSeries(incrementalSource, {
  seed,
  emitAfterDate: '2026-08-05',
})
assert.equal(incremental.length, 2)
assert.equal(incremental[0].touchAgeSessions, 1)

assert.equal(MA25M_MONITOR_CONFIG.contactThresholdPct, 2)
assert.equal(parseBoundedMonitorNumber(null, 2, 0.1, 10), 2)
assert.equal(parseBoundedMonitorNumber('', 100, 1, 200), 100)
assert.equal(parseBoundedMonitorNumber('999', 100, 1, 200), 200)
console.log('ma25m monitor tests passed')
