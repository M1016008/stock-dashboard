import assert from 'node:assert/strict'
import {
  DEFAULT_TRIGGER_SCORE_CONFIG,
  calculateTriggerApproachScore,
  calculateTriggerLiquidityScore,
  calculateTriggerMaTrendScore,
  calculateTriggerProximityScore,
  calculateTriggerScore,
  calculateTriggerStageStructureScore,
  type TriggerScoreInput,
  type TriggerScoreStages,
} from '@/lib/trigger-score'

const stages: TriggerScoreStages = {
  dayAStage: 1,
  dayBStage: 6,
  weekAStage: 2,
  weekBStage: 5,
  monthAStage: 3,
  monthBStage: 4,
}

function input(overrides: Partial<TriggerScoreInput> = {}): TriggerScoreInput {
  return {
    triggerStatus: 'NEAR',
    fromAbove: true,
    zoneDistancePct: 1,
    maxApproachDistancePct: 5,
    approachVelocityPctPointsPerSession: 0.25,
    ma1SlopePct: 1,
    ma2SlopePct: 1,
    averageTradingValue: 100_000_000,
    ...stages,
    ...overrides,
  }
}

assert.equal(Object.values(DEFAULT_TRIGGER_SCORE_CONFIG.weights).reduce((sum, value) => sum + value, 0), 100)

assert.equal(calculateTriggerProximityScore(input({ triggerStatus: 'IN_ZONE', zoneDistancePct: 0 })), 30)
assert.equal(calculateTriggerProximityScore(input({ zoneDistancePct: 0.5 })), 27)
assert.equal(calculateTriggerProximityScore(input({ zoneDistancePct: 1 })), 24)
assert.equal(calculateTriggerProximityScore(input({ zoneDistancePct: 2 })), 18)
assert.equal(calculateTriggerProximityScore(input({ zoneDistancePct: 5 })), 0)
assert.equal(calculateTriggerProximityScore(input({ triggerStatus: 'BELOW_ZONE', zoneDistancePct: -0.5 })), 0)
assert.equal(calculateTriggerProximityScore(input({ zoneDistancePct: 0, maxApproachDistancePct: 0 })), 0)

assert.equal(calculateTriggerApproachScore(input({ approachVelocityPctPointsPerSession: 0.5 })), 20)
assert.equal(calculateTriggerApproachScore(input({ approachVelocityPctPointsPerSession: 0.1 })), 4)
assert.equal(calculateTriggerApproachScore(input({ approachVelocityPctPointsPerSession: 0 })), 0)
assert.equal(calculateTriggerApproachScore(input({ approachVelocityPctPointsPerSession: 50 })), 20)
assert.equal(calculateTriggerApproachScore(input({ triggerStatus: 'IN_ZONE', approachVelocityPctPointsPerSession: -0.2 })), 10)
assert.equal(calculateTriggerApproachScore(input({ triggerStatus: 'IN_ZONE', fromAbove: false, approachVelocityPctPointsPerSession: -0.2 })), 0)

assert.equal(calculateTriggerMaTrendScore(input({ ma1SlopePct: 2, ma2SlopePct: 2 })), 20)
assert.equal(calculateTriggerMaTrendScore(input({ ma1SlopePct: 2, ma2SlopePct: 0.2 })), 5.6)
assert.equal(calculateTriggerMaTrendScore(input({ ma1SlopePct: 0.02, ma2SlopePct: 0.02 })), 0.2)
assert.equal(calculateTriggerMaTrendScore(input({ ma1SlopePct: 20, ma2SlopePct: 20 })), 20)
assert.equal(calculateTriggerMaTrendScore(input({ ma1SlopePct: -1, ma2SlopePct: 2 })), 4)

const allStrong = calculateTriggerStageStructureScore({
  dayAStage: 1, dayBStage: 1, weekAStage: 1, weekBStage: 1, monthAStage: 1, monthBStage: 1,
})
const allWeak = calculateTriggerStageStructureScore({
  dayAStage: 4, dayBStage: 4, weekAStage: 4, weekBStage: 4, monthAStage: 4, monthBStage: 4,
})
const allMissing = calculateTriggerStageStructureScore({
  dayAStage: null, dayBStage: null, weekAStage: null, weekBStage: null, monthAStage: null, monthBStage: null,
})
const partial = calculateTriggerStageStructureScore({
  dayAStage: 1, dayBStage: null, weekAStage: null, weekBStage: null, monthAStage: null, monthBStage: null,
})
const stageSix = calculateTriggerStageStructureScore({
  dayAStage: 6, dayBStage: 6, weekAStage: 6, weekBStage: 6, monthAStage: 6, monthBStage: 6,
})
const stageTwo = calculateTriggerStageStructureScore({
  dayAStage: 2, dayBStage: 2, weekAStage: 2, weekBStage: 2, monthAStage: 2, monthBStage: 2,
})
assert.equal(allStrong.score, 20)
assert.equal(allWeak.score, 0)
assert.equal(allMissing.score, 10, 'all-missing Stage receives a neutral score, not zero or full points')
assert.equal(allMissing.coverage, 0)
assert.ok(partial.score > 10 && partial.score < 20, 'partial Stage is shrunk toward neutral according to coverage')
assert.equal(partial.availableAxes, 1)
assert.ok(stageSix.score > stageTwo.score, 'cyclical Stage semantics, not numeric ordering, drive the score')

assert.equal(calculateTriggerLiquidityScore(null), 0)
assert.equal(calculateTriggerLiquidityScore(1_000_000), 0)
assert.equal(calculateTriggerLiquidityScore(Math.sqrt(1_000_000 * 1_000_000_000)), 5)
assert.equal(calculateTriggerLiquidityScore(1_000_000_000), 10)
assert.equal(calculateTriggerLiquidityScore(100_000_000_000), 10)

const first = calculateTriggerScore(input())
const second = calculateTriggerScore(input())
assert.deepEqual(first, second, 'the same inputs always produce the same score')
const components = first.scoreBreakdown
assert.equal(
  components.total,
  Math.round((components.proximity + components.approach + components.maTrend + components.stageStructure + components.liquidity) * 1_000) / 1_000,
)
assert.equal(first.totalScore, components.total)
assert.ok(first.totalScore >= 0 && first.totalScore <= 100)

for (let index = 0; index < 500; index += 1) {
  const result = calculateTriggerScore(input({
    zoneDistancePct: (index % 60) / 10,
    approachVelocityPctPointsPerSession: (index - 250) / 100,
    ma1SlopePct: (index % 50) / 10,
    ma2SlopePct: ((index * 7) % 50) / 10,
    averageTradingValue: 10 ** (index % 12),
  }))
  assert.ok(result.totalScore >= 0 && result.totalScore <= 100)
}

console.log('trigger score tests passed')
