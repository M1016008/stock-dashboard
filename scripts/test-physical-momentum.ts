import assert from 'node:assert/strict'
import {
  adjustLikelySplitDiscontinuities,
  composePhysicalMomentumScores,
  computePhysicalMomentumRawRows,
  meanAndStd,
  rollingSma,
  winsorizedMeanAndStd,
  winsorizedZScore,
  zScore,
} from '@/lib/physical-momentum'
import {
  buildPhysicalRawMetricView,
  describePhysicalScore,
} from '@/lib/physical-momentum-view'

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
  const relativeVolume21 = 1020 / 1010.5
  approx(day21.velocity, 20 / 100)
  assert.equal(day21.acceleration, null)
  approx(day21.momentum, relativeVolume21 * 0.2)
  approx(day21.energy, 0.5 * relativeVolume21 * 0.2 ** 2)

  const day22 = metrics[21]
  const velocity22 = 20 / 101
  approx(day22.velocity, velocity22)
  approx(day22.acceleration, velocity22 - 0.2)
  assert.equal(metrics[218].ma200Angle, null)
  assert.notEqual(metrics[219].ma200Angle, null)
  assert.notEqual(metrics[219].maAngleAvg, null)
}

function testSplitAdjustment(): void {
  const rows = [
    { date: '2026-07-13', close: 4.65, volume: 613_371_861 },
    { date: '2026-07-14', close: 4.28, volume: 493_151_916 },
    { date: '2026-07-15', close: 45.98, volume: 51_217_782 },
    { date: '2026-07-16', close: 52.02, volume: 60_800_609 },
  ]
  const adjusted = adjustLikelySplitDiscontinuities(rows)
  approx(adjusted[1].close, 42.8)
  approx(adjusted[1].volume, 49_315_191.6)
  approx(adjusted[2].close, 45.98)

  const largeReverseSplit = adjustLikelySplitDiscontinuities([
    { date: '2026-07-02', close: 0.022, volume: 219_731_764 },
    { date: '2026-07-06', close: 6.38, volume: 4_857_154 },
  ])
  approx(largeReverseSplit[0].close, 6.6)
  approx(largeReverseSplit[0].volume, 219_731_764 / 300)

  const providerSplit = adjustLikelySplitDiscontinuities([
    { date: '2026-07-02', close: 0.022, volume: 219_731_764 },
    { date: '2026-07-06', close: 6.38, volume: 4_857_154, splitFactor: 0.005 },
  ])
  approx(providerSplit[0].close, 4.4)

  const ordinaryDecline = adjustLikelySplitDiscontinuities([
    { date: '2026-06-22', close: 0.111, volume: 208_565_924 },
    { date: '2026-06-23', close: 0.0563, volume: 294_900_340 },
  ])
  approx(ordinaryDecline[0].close, 0.111)
}

function testPriceScaleIndependentMaAngle(): void {
  const start = new Date('2025-01-01T00:00:00Z')
  const base = Array.from({ length: 230 }, (_, index) => ({
    date: new Date(start.getTime() + index * 86_400_000).toISOString().slice(0, 10),
    close: 100 + index,
    volume: 1000,
  }))
  const scaled = base.map((row) => ({ ...row, close: row.close * 10 }))
  const baseMetrics = computePhysicalMomentumRawRows(base, 20)
  const scaledMetrics = computePhysicalMomentumRawRows(scaled, 20)
  approx(baseMetrics[229].maAngleAvg, scaledMetrics[229].maAngleAvg ?? 0)
}

function testZScores(): void {
  const stats = meanAndStd([1, 2, 3])
  approx(stats.mean, 2)
  approx(stats.std, Math.sqrt(2 / 3))
  approx(zScore(3, stats.mean, stats.std), (3 - 2) / Math.sqrt(2 / 3))

  const robustStats = winsorizedMeanAndStd([...Array.from({ length: 100 }, (_, index) => index), 10_000])
  assert.ok((robustStats.upper ?? Infinity) < 10_000)
  approx(
    winsorizedZScore(10_000, robustStats),
    winsorizedZScore(robustStats.upper, robustStats) ?? 0,
  )
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

function testPlainLanguageViews(): void {
  assert.deepEqual(buildPhysicalRawMetricView('velocity', 0.2103), {
    label: '20日騰落率',
    value: '+21.0%',
    interpretation: '強い上昇',
    detail: '強い上昇 / 20営業日前の終値と比較',
    tone: 'up',
  })
  assert.equal(buildPhysicalRawMetricView('acceleration', 0.1128).value, '+11.3pt')
  const force = buildPhysicalRawMetricView('force', 0.0877)
  assert.equal(force.value, '出来高を伴って上向きの力が増加')
  assert.equal(force.detail, '出来高と20日騰落率の変化を組み合わせた方向指標 / 市場内の強弱はPFSで比較')
  assert.doesNotMatch(force.detail, /Force指数|0\.0877/)
  assert.equal(describePhysicalScore('pms', 0.02), '市場平均付近')
  assert.equal(describePhysicalScore('pfs', 2.42), '上向きの力がかなり強い')
}

testRollingSma()
testRawMetrics()
testSplitAdjustment()
testPriceScaleIndependentMaAngle()
testZScores()
testScoreComposition()
testPlainLanguageViews()

console.log('Physical momentum tests passed')
