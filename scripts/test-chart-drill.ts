import assert from 'node:assert/strict'
import {
  answerIsCorrect,
  computeOutcome,
  enrichCandlesWithMa,
  isCandidateForDifficulty,
  movingAverage,
} from '../lib/chart-drill/scoring'
import type { DrillCandle } from '../lib/chart-drill/types'

function candle(date: string, close: number, high = close, low = close): DrillCandle {
  return {
    date,
    open: close,
    high,
    low,
    close,
    volume: 1000,
    ma5: null,
    ma25: null,
    ma75: null,
    ma200: null,
  }
}

assert.deepEqual(movingAverage([1, 2, 3, 4], 2), [null, 1.5, 2.5, 3.5])

const enriched = enrichCandlesWithMa(Array.from({ length: 25 }, (_, index) => ({
  date: `2026-01-${String(index + 1).padStart(2, '0')}`,
  open: 100 + index,
  high: 101 + index,
  low: 99 + index,
  close: 100 + index,
  volume: 1000,
})))
assert.equal(enriched[4].ma5, 102)
assert.equal(enriched[24].ma25, 112)

const upOutcome = computeOutcome({
  base: candle('2026-01-01', 100),
  future: [
    candle('2026-01-02', 101, 102, 99),
    candle('2026-01-03', 104, 106, 101),
    candle('2026-01-04', 103, 104, 102),
  ],
  thresholdPct: 5,
})
assert.equal(upOutcome.actual, 'up')
assert.equal(upOutcome.thresholdHitDay, 2)
assert.equal(upOutcome.closeHit, false)
assert.equal(answerIsCorrect('up', upOutcome), true)
assert.equal(answerIsCorrect('pass', upOutcome), false)
assert.equal(isCandidateForDifficulty(upOutcome, 'up', 5, 'intermediate'), true)

const downOutcome = computeOutcome({
  base: candle('2026-01-01', 100),
  future: [
    candle('2026-01-02', 99, 100, 97),
    candle('2026-01-03', 94, 98, 94),
    candle('2026-01-04', 98, 99, 96),
  ],
  thresholdPct: 5,
})
assert.equal(downOutcome.actual, 'down')
assert.equal(downOutcome.thresholdHitDirection, 'down')
assert.equal(downOutcome.thresholdHitDay, 2)
assert.equal(downOutcome.closeHit, true)

const bothOutcome = computeOutcome({
  base: candle('2026-01-01', 100),
  future: [
    candle('2026-01-02', 105, 106, 99),
    candle('2026-01-03', 95, 101, 94),
  ],
  thresholdPct: 5,
})
assert.equal(bothOutcome.thresholdHitDirection, 'both')
assert.equal(bothOutcome.actual, 'up')
assert.equal(bothOutcome.highVolatility, true)

const passOutcome = computeOutcome({
  base: candle('2026-01-01', 100),
  future: [
    candle('2026-01-02', 101, 102, 99),
    candle('2026-01-03', 99, 101, 98),
  ],
  thresholdPct: 5,
})
assert.equal(passOutcome.actual, 'pass')
assert.equal(passOutcome.thresholdHit, false)
assert.equal(answerIsCorrect('pass', passOutcome), true)

console.log('chart-drill scoring tests passed')
