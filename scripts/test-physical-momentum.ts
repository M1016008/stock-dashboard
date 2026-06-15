import assert from 'node:assert/strict'
import {
  composePhysicalMomentumScores,
  computePhysicalMomentumRawRows,
  meanAndStd,
  rollingSma,
  zScore,
} from '@/lib/physical-momentum'

function approx(actual: number | null, expected: number, tolerance = 1e-9): void {
  assert.equal(typeof actual, 'number')
  assert.ok(Math.abs((actual ?? 0) - expected) <= tolerance, `${actual} !== ${expected}`)
}

function testRollingSma(): void {
  assert.deepEqual(rollingSma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4])
}

function testRawMetrics(): void {
  const start = new Date('2026-01-01T00:00:00Z')
  const rows = Array.from({ length: 230 }, (_, index) => ({
    date: new Date(start.getTime() + index * 86_400_000).toISOString().slice(0, 10),
    close: 100 + index,
    volume: 1000 + index,
  }))
  const metrics = computePhysicalMomentumRawRows(rows, 20)
  const day21 = metrics[20]
  approx(day21.velocity, 20 / 100)
  assert.equal(day21.acceleration, null)
  approx(day21.momentum, 1020 * 0.2)
  approx(day21.energy, 0.5 * 1020 * 0.2 ** 2)

  const day22 = metrics[21]
  const velocity22 = 20 / 101
  approx(day22.velocity, velocity22)
  approx(day22.acceleration, velocity22 - 0.2)
  assert.equal(metrics[218].ma200Angle, null)
  assert.notEqual(metrics[219].ma200Angle, null)
  assert.notEqual(metrics[219].maAngleAvg, null)
}

function testZScores(): void {
  const stats = meanAndStd([1, 2, 3])
  approx(stats.mean, 2)
  approx(stats.std, Math.sqrt(2 / 3))
  approx(zScore(3, stats.mean, stats.std), (3 - 2) / Math.sqrt(2 / 3))
}

function testScoreComposition(): void {
  const scores = composePhysicalMomentumScores({
    zVelocity: 1,
    zAcceleration: 2,
    zMomentum: 3,
    zForce: 4,
    zMaAngleAvg: 5,
    zEnergy: 6,
  })
  approx(scores.physicalMomentumScore, 3.5)
  approx(scores.physicalForceScore, 3)
  approx(scores.physicalEnergyScore, 4.5)
}

testRollingSma()
testRawMetrics()
testZScores()
testScoreComposition()

console.log('Physical momentum tests passed')
