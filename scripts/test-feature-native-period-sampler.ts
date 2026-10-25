import assert from 'node:assert/strict'

import { NativePeriodFeatureSampler } from '@/lib/feature-native-period-sampler'
import { divergenceRate, quadraticTrend } from '@/lib/features'

function approx(actual: number | null, expected: number, label: string): void {
  assert.notEqual(actual, null, label)
  assert.ok(Math.abs((actual ?? 0) - expected) < 1e-9, `${label}: ${actual} !== ${expected}`)
}

function masFor(period: number, intraperiod: number): number[] {
  return [
    130 + period * period * 0.4 + intraperiod,
    110 + period * 1.3 + intraperiod * 0.4,
    90 + period * 0.7 + intraperiod * 0.2,
    70 + period * 0.3 + intraperiod * 0.1,
    50 + period * 0.1,
  ]
}

function verifyNativeSampling(timescale: 'weekly' | 'monthly', periodCount: number, window: number): void {
  const sampler = new NativePeriodFeatureSampler(timescale, window, 250)
  const finalMas: number[][] = []
  let finalSample: ReturnType<NativePeriodFeatureSampler['sample']> = null

  for (let period = 0; period < periodCount; period += 1) {
    const dates = timescale === 'weekly'
      ? [1, 4].map((dayOffset) => {
          const date = new Date(Date.UTC(2025, 0, 6 + period * 7 + dayOffset))
          return date.toISOString().slice(0, 10)
        })
      : [5, 25].map((day) => new Date(Date.UTC(2024, period, day)).toISOString().slice(0, 10))

    const first = sampler.sample({ date: dates[0], mas: masFor(period, 0), stageA: 1, stageB: 1 })
    const secondMas = masFor(period, 1)
    finalMas.push(secondMas)
    finalSample = sampler.sample({ date: dates[1], mas: secondMas, stageA: 1, stageB: 1 })
    assert.ok(first && finalSample)
    assert.equal(first.stageAAge, period, `${timescale} stage age advances once at the new period`)
    assert.equal(finalSample.stageAAge, period, `${timescale} stage age does not advance within a period`)
  }

  assert.ok(finalSample)
  for (let maIndex = 0; maIndex < 5; maIndex += 1) {
    const expected = quadraticTrend(finalMas.map((mas) => mas[maIndex]), window)
    assert.ok(expected)
    approx(finalSample.trends[maIndex]?.slope ?? null, expected.slope, `${timescale} slope m${maIndex + 1}`)
    approx(finalSample.trends[maIndex]?.acceleration ?? null, expected.acceleration, `${timescale} curvature m${maIndex + 1}`)
  }

  const current = finalMas.at(-1)!
  const fivePeriodsAgo = finalMas[finalMas.length - 6]
  approx(
    finalSample.divergenceADelta,
    divergenceRate(current[0], current[1], current[2])
      - divergenceRate(fivePeriodsAgo[0], fivePeriodsAgo[1], fivePeriodsAgo[2]),
    `${timescale} five-period divergence delta`,
  )
  approx(
    finalSample.divergenceBDelta,
    divergenceRate(current[2], current[3], current[4])
      - divergenceRate(fivePeriodsAgo[2], fivePeriodsAgo[3], fivePeriodsAgo[4]),
    `${timescale} five-period divergence B delta`,
  )
}

verifyNativeSampling('weekly', 13, 13)
verifyNativeSampling('monthly', 12, 12)

const daily = new NativePeriodFeatureSampler('daily', 20, 250)
for (let index = 0; index < 3; index += 1) {
  const sample = daily.sample({
    date: `2026-01-0${index + 5}`,
    mas: masFor(index, 1),
    stageA: 1,
    stageB: 1,
  })
  assert.equal(sample?.stageAAge, index, 'daily stage age remains session-based')
}

console.log('native-period feature sampling tests passed')
