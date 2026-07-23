import assert from 'node:assert/strict'
import {
  diversifyHistoricalAnalogs,
  normalizedVectorSimilarity,
  normalizeHistoricalAnalogSort,
  sortHistoricalAnalogs,
  stageNeighborCodes,
  type ScoredHistoricalAnalog,
} from '@/lib/ml/historical-analogs'

const neighbors = stageNeighborCodes('524141')
assert.equal(neighbors.length, 31)
assert.ok(neighbors.includes('524131'))
assert.ok(neighbors.includes('624141'))
assert.deepEqual(stageNeighborCodes('52-141'), ['52-141'])

assert.equal(normalizedVectorSimilarity([0, 0, 0], [0, 0, 0]), 1)
assert.ok(normalizedVectorSimilarity([0, 0, 0], [0.1, 0.1, 0.1]) > normalizedVectorSimilarity([0, 0, 0], [1, 1, 1]))
assert.equal(normalizeHistoricalAnalogSort('return_desc'), 'return_desc')
assert.equal(normalizeHistoricalAnalogSort('invalid'), 'similarity')

function row(ticker: string, date: string, score: number, returnPct: number): ScoredHistoricalAnalog {
  return {
    ticker,
    date,
    stageCode: '524141',
    featureJson: '{}',
    vectorJson: '[]',
    name: null,
    marketSegment: null,
    sector17Name: null,
    sector33Name: null,
    returnPct,
    maxReturnPct: returnPct + 2,
    minReturnPct: returnPct - 2,
    similarityScore: score,
    structuralScore: score,
    vectorScore: score,
    components: [],
    reason: {},
  }
}

const rows = [
  row('6496', '2026-06-23', 0.94, 5),
  row('6496', '2026-06-30', 0.93, 8),
  row('7203', '2024-01-10', 0.9, -6),
]
assert.equal(sortHistoricalAnalogs(rows, 'similarity')[0].similarityScore, 0.94)
assert.equal(sortHistoricalAnalogs(rows, 'return_desc')[0].returnPct, 8)
assert.equal(sortHistoricalAnalogs(rows, 'return_asc')[0].returnPct, -6)
assert.deepEqual(diversifyHistoricalAnalogs(sortHistoricalAnalogs(rows, 'similarity'), 3).map((item) => item.ticker), ['6496', '7203'])

console.log('historical analog tests passed')
