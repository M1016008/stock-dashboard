import assert from 'node:assert/strict'
import { getStageTransitionDirection } from '@/lib/hex-stage'
import {
  calculateDirectionalStageAlignment,
  calculateGroupStructure,
  calculateTrendStructureMetrics,
  propagationFromAxisMomentum,
  trendStructureBand,
} from '@/lib/sector-structure'

// Stage番号の昇順は改善順ではない。MA構造の意味に沿う遷移を固定する。
assert.equal(getStageTransitionDirection(1, 2), 'deteriorate')
assert.equal(getStageTransitionDirection(2, 3), 'deteriorate')
assert.equal(getStageTransitionDirection(3, 4), 'deteriorate')
assert.equal(getStageTransitionDirection(4, 5), 'improve')
assert.equal(getStageTransitionDirection(5, 6), 'improve')
assert.equal(getStageTransitionDirection(6, 1), 'improve')
assert.equal(getStageTransitionDirection(1, 6), 'deteriorate')
assert.equal(getStageTransitionDirection(1, 1), 'stable')

const summary = calculateGroupStructure([
  {
    previousStages: { dailyA: 4, dailyB: 5, weeklyA: 3, weeklyB: 2, monthlyA: 1, monthlyB: 6 },
    stages: { dailyA: 5, dailyB: 6, weeklyA: 4, weeklyB: 1, monthlyA: 1, monthlyB: 6 },
  },
  {
    previousStages: { dailyA: 5, dailyB: 6, weeklyA: 4, weeklyB: 1, monthlyA: 2, monthlyB: 1 },
    stages: { dailyA: 4, dailyB: 1, weeklyA: 5, weeklyB: 2, monthlyA: 3, monthlyB: 6 },
  },
])

assert.equal(summary.nStocks, 2)
assert.equal(summary.axes.dailyA.stages[4], 1)
assert.equal(summary.axes.dailyA.stages[5], 1)
assert.equal(summary.axes.dailyA.improving, 1)
assert.equal(summary.axes.dailyA.deteriorating, 1)
assert.ok(summary.strengthScore != null && summary.strengthScore >= 0 && summary.strengthScore <= 100)
assert.ok(summary.axes.dailyA.changeScore >= -100 && summary.axes.dailyA.changeScore <= 100)

// 大幅遷移も通常の改善・悪化件数へ一度だけ含める。
const jumpOnly = calculateGroupStructure([
  { previousStages: { dailyA: 1 }, stages: { dailyA: 4 } },
])
assert.equal(jumpOnly.axes.dailyA.jumpDeteriorating, 1)
assert.equal(jumpOnly.axes.dailyA.deteriorating, 1)
assert.equal(jumpOnly.axes.dailyA.changeScore, -100)

const propagation = propagationFromAxisMomentum({
  dailyA: 5,
  dailyB: 3,
  weeklyA: 1,
  weeklyB: 0,
  monthlyA: 0,
  monthlyB: 0,
})
assert.equal(propagation.direction, 'improving')
assert.equal(propagation.phase, 3)
assert.match(propagation.label, /日足A → 日足B → 週足A/)

const trend = calculateTrendStructureMetrics({
  stages: { dailyA: 1, dailyB: 1, weeklyA: 1, weeklyB: 1, monthlyA: 1, monthlyB: 1 },
  ma: { ma5: 104, ma25: 103, ma75: 102, ma300: 101 },
  previousMa: { ma5: 100, ma25: 100, ma75: 100, ma300: 100 },
})
assert.equal(trend.stageScore, 100)
assert.equal(trend.maUpCount, 4)
assert.equal(trend.maDirectionScore, 100)
assert.equal(trend.trendScore, 100)
assert.equal(trendStructureBand(trend.trendScore)?.key, 'strong_up')
assert.equal(trendStructureBand(60)?.key, 'up')
assert.equal(trendStructureBand(50)?.key, 'neutral')
assert.equal(trendStructureBand(40)?.key, 'down')
assert.equal(trendStructureBand(20)?.key, 'strong_down')
assert.ok(calculateDirectionalStageAlignment({ weeklyA: 1, weeklyB: 1, monthlyA: 1, monthlyB: 1 }, 'up') > 90)
assert.equal(calculateTrendStructureMetrics({
  stages: {},
  ma: { ma5: 104, ma25: 103, ma75: 102, ma300: 101 },
  previousMa: { ma5: 100, ma25: 100, ma75: 100, ma300: 100 },
}).trendScore, null)

console.log('sector structure tests passed')
