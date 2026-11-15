import assert from 'node:assert/strict'
import {
  bootstrapMedianDistribution,
  compareTransitionCohorts,
  type TransitionComparisonRecord,
} from '@/lib/research/six-stage-statistics'

const records: TransitionComparisonRecord[] = []
for (let index = 0; index < 120; index += 1) {
  const signalDate = `202${index % 5}-${String(index % 12 + 1).padStart(2, '0')}-${String(index % 27 + 1).padStart(2, '0')}`
  records.push({ cohort: 'H001', ticker: `H${index % 20}`, signalDate, netReturn: 0.03 + (index % 7) / 1_000 })
  records.push({ cohort: 'C2', ticker: `C${index % 20}`, signalDate, netReturn: -0.01 + (index % 5) / 1_000 })
}

const first = compareTransitionCohorts({ records, iterations: 200, seed: 42 })
const second = compareTransitionCohorts({ records, iterations: 200, seed: 42 })
assert.deepEqual(first, second, 'seeded cluster bootstrap must be deterministic')
assert.equal(first.samples.h001, 120)
assert.equal(first.samples.c2, 120)
assert.ok(first.medianDifference > 0)
assert.equal(first.interpretation, 'POSITIVE_INTERVAL')
assert.ok(first.tickerClusterBootstrap.iterationsCompleted >= 180)
assert.ok(first.signalDateClusterBootstrap.iterationsCompleted >= 180)
assert.ok(first.matchedSignalDate.datesWithBothCohorts > 0)
assert.equal(first.matchedSignalDate.h001Samples, 120)
assert.equal(first.matchedSignalDate.c2Samples, 120)
assert.ok(first.matchedSignalDate.medianDailyDifference > 0)
assert.ok(first.matchedSignalDate.bootstrap95.lower > 0)
assert.deepEqual(
  bootstrapMedianDistribution({ records, axis: 'ticker', iterations: 100, seed: 7 }),
  bootstrapMedianDistribution({ records, axis: 'ticker', iterations: 100, seed: 7 }),
)

assert.throws(() => compareTransitionCohorts({
  records: records.filter((row) => row.cohort === 'H001'),
  iterations: 100,
}), /both H001 and C2/)

console.log('Six-stage transition statistics tests: PASS')

const monthly = compareTransitionCohorts({ records, iterations: 200, seed: 42, timeAxis: 'signalMonth' })
assert.equal(monthly.signalDateClusterBootstrap.axis, 'signalMonth')
assert.equal(monthly.medianDifference, first.medianDifference)
assert.ok(monthly.conservative95.lower > 0)
console.log('Six-stage transition statistics month-cluster tests: PASS')
