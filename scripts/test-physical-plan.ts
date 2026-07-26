import assert from 'node:assert/strict'
import {
  physicalPlanStructureDirection,
  resolvePhysicalPlanDecision,
  type PhysicalPlanDecisionInput,
} from '@/lib/physical-plan'

const aaplMetrics = {
  sma5Velocity5: 0.51,
  sma25Velocity5: 2.06,
  sma75Velocity10: 3.42,
  sma200Velocity10: 1.3,
  sma5Acceleration5: -3.22,
  priceToSma25: 7.49,
}

const aaplCalibration = {
  targetDirection: 'down' as const,
  hitRate: 0.2785,
  baseRate: 0.2156,
  lift: 1.2916,
  confidenceScore: 43.79,
}

function decision(overrides: Partial<PhysicalPlanDecisionInput>): ReturnType<typeof resolvePhysicalPlanDecision> {
  return resolvePhysicalPlanDecision({
    horizonDays: 20,
    status: '失速警戒',
    metrics: aaplMetrics,
    pms: 1.61,
    pfs: 2.42,
    calibration: aaplCalibration,
    candidates: [],
    ...overrides,
  })
}

assert.equal(physicalPlanStructureDirection(5, aaplMetrics), 'mixed')
assert.equal(physicalPlanStructureDirection(20, aaplMetrics), 'up')
assert.equal(physicalPlanStructureDirection(60, aaplMetrics), 'up')
assert.equal(physicalPlanStructureDirection(200, aaplMetrics), 'up')

const aaplShort = decision({ horizonDays: 5 })
assert.equal(aaplShort.direction, 'mixed')
assert.equal(aaplShort.statisticsQuality, 'contrary')

const aaplMedium = decision({ horizonDays: 20 })
assert.equal(aaplMedium.direction, 'up')
assert.equal(aaplMedium.statisticsQuality, 'contrary')
assert.equal(aaplMedium.caution, true)

const weakUp = decision({
  status: '上昇継続',
  calibration: {
    targetDirection: 'up',
    hitRate: 0.2026,
    baseRate: 0.2046,
    lift: 0.9902,
    confidenceScore: 27.56,
  },
})
assert.equal(weakUp.direction, 'up')
assert.equal(weakUp.statisticsQuality, 'weak')
assert.equal(weakUp.caution, true)

const candidateConflict = decision({
  horizonDays: 200,
  status: '上昇継続',
  calibration: null,
  candidates: [{ direction: 'down', rank: 26 }],
})
assert.equal(candidateConflict.direction, 'mixed')
assert.equal(candidateConflict.candidateDirection, 'down')

console.log('Physical observation plan tests passed')
