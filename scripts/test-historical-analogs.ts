import assert from 'node:assert/strict'
import {
  diversifyHistoricalAnalogs,
  normalizedVectorSimilarity,
  normalizeHistoricalAnalogSort,
  sortHistoricalAnalogs,
  stageNeighborCodes,
  type ScoredHistoricalAnalog,
} from '@/lib/ml/historical-analogs'
import {
  MA_SEQUENCE_LONG_TERM_PERIODS,
  MA_SEQUENCE_MONTHLY_PERIODS,
  MA_SEQUENCE_PERIODS,
  buildMaSequenceEmbedding,
  maSequenceEmbeddingSimilarity,
  maSequenceScoringProfileForMarket,
  prepareMaSequence,
  scoreMaSequence,
  stageCodeAt,
} from '@/lib/ml/ma-sequence'

const neighbors = stageNeighborCodes('524141')
assert.equal(neighbors.length, 31)
assert.ok(neighbors.includes('524131'))
assert.ok(neighbors.includes('624141'))
assert.deepEqual(stageNeighborCodes('52-141'), ['52-141'])
assert.equal(stageNeighborCodes('11544').length, 26)
assert.ok(stageNeighborCodes('11544').includes('21544'))
assert.equal(maSequenceScoringProfileForMarket('JP').key, 'structural-context')
assert.equal(maSequenceScoringProfileForMarket('US').key, 'trajectory-heavy')

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

function priceRows(transform: (value: number, index: number) => number) {
  return Array.from({ length: 560 }, (_, index) => {
    const date = new Date(Date.UTC(2024, 0, 1 + index)).toISOString().slice(0, 10)
    const value = 80 + index * 0.08 + Math.sin(index / 9) * 4 + Math.sin(index / 27) * 7
    return { date, close: transform(value, index) }
  })
}

assert.deepEqual(MA_SEQUENCE_PERIODS, [5, 10, 20, 40, 60, 90, 200])
assert.deepEqual(MA_SEQUENCE_MONTHLY_PERIODS, [3, 6, 12, 24, 36, 60])
assert.deepEqual(MA_SEQUENCE_LONG_TERM_PERIODS, [12, 24, 36, 60, 120])
const sequenceA = prepareMaSequence(priceRows((value) => value))
const sequenceScaled = prepareMaSequence(priceRows((value) => value * 3.25))
const sequenceInverse = prepareMaSequence(priceRows((value, index) => 220 - value + index * 0.01))
const sequenceIndex = sequenceA.rows.length - 1
const scaledScore = scoreMaSequence(sequenceA, sequenceIndex, sequenceScaled, sequenceIndex)
const inverseScore = scoreMaSequence(sequenceA, sequenceIndex, sequenceInverse, sequenceIndex)
assert.ok(scaledScore.score > 0.99, `price-scale invariance failed: ${scaledScore.score}`)
assert.ok(inverseScore.score < scaledScore.score - 0.25)
assert.ok(scaledScore.components.some((component) => component.key === 'daily40' && component.available))
assert.deepEqual(sequenceA.monthlyComparison.periods, MA_SEQUENCE_MONTHLY_PERIODS)
const embeddingA = buildMaSequenceEmbedding(sequenceA, sequenceIndex)
const embeddingScaled = buildMaSequenceEmbedding(sequenceScaled, sequenceIndex)
assert.ok(embeddingA)
assert.ok(embeddingScaled)
assert.equal(embeddingA.quantized.length, embeddingScaled.quantized.length)
assert.equal(maSequenceEmbeddingSimilarity(embeddingA.quantized, embeddingScaled.quantized), 1)
assert.deepEqual(embeddingA.bands, embeddingScaled.bands)
assert.match(stageCodeAt(sequenceA, sequenceIndex) ?? '', /^[1-6]{5}$/)

console.log('historical analog tests passed')
