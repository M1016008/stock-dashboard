import assert from 'node:assert/strict'
import {
  buildHistoricalAnalogShortlist,
  calendarDaysBetween,
  dateRangesOverlap,
  historicalAnalogProfileConfig,
  historicalAnalogRecencyBucket,
  historicalAnalogRecencyShortlistTarget,
  isWithinHistoricalAnalogRecency,
  normalizedVectorSimilarity,
  normalizeHistoricalAnalogProfile,
  normalizeHistoricalAnalogRecency,
  normalizeHistoricalAnalogSort,
  requiredHistoricalAnalogComponents,
  stageNeighborCodes,
  weightedVectorSequenceSimilarity,
  weightedVectorSequenceSimilarityDetails,
} from '@/lib/ml/historical-analogs'
import { buildHistoricalAnalogChartSeries } from '@/lib/ml/historical-analog-chart'
import {
  MA_SEQUENCE_EMBEDDING_FEATURE_LENGTH,
  MA_SEQUENCE_MONTHLY_PERIODS,
  MA_SEQUENCE_PERIODS,
  MA_SEQUENCE_STAGE_PERIODS,
  MA_SEQUENCE_WEEKLY_PERIODS,
  MA_SEQUENCE_YEARLY_PERIODS,
  buildMaSequenceEmbedding,
  maSequenceEmbeddingRangesForCoverage,
  maSequenceEmbeddingSimilarity,
  maSequenceScoringProfileForMarket,
  prepareMaSequence,
  scoreMaSequence,
  scoreMaSequenceRange,
  stageCodeAt,
} from '@/lib/ml/ma-sequence'
import { CHART_INTERVAL_OPTIONS } from '@/lib/timeframes'

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
assert.ok(
  normalizedVectorSimilarity([0, 0, 0], [0.1, 0.1, 0.1])
    > normalizedVectorSimilarity([0, 0, 0], [1, 1, 1]),
)
assert.equal(
  weightedVectorSequenceSimilarity(
    [[0, 0], [1, 1], [2, 2]],
    [[0, 0], [1, 1], [2, 2]],
  ),
  1,
)
assert.ok(
  (weightedVectorSequenceSimilarity(
    [[0, 0], [1, 1], [2, 2]],
    [[0, 0], [2, 2], [4, 4]],
  ) ?? 1) < 1,
)
assert.equal(
  weightedVectorSequenceSimilarity(
    [[0, 0], null, [2, 2]],
    [[0, 0], [99, 99], [2, 2]],
  ),
  1,
)
assert.equal(weightedVectorSequenceSimilarity([null, null], [null, null]), null)
assert.deepEqual(
  weightedVectorSequenceSimilarityDetails(
    [[0, 0], null, [2, 2]],
    [[0, 0], [99, 99], [2, 2]],
  ),
  { score: 1, pointCount: 2, totalPoints: 3 },
)
assert.equal(normalizeHistoricalAnalogSort('recent'), 'recent')
assert.equal(normalizeHistoricalAnalogSort('return_desc'), 'similarity')
assert.equal(normalizeHistoricalAnalogRecency('2w'), '2w')
assert.equal(normalizeHistoricalAnalogRecency('invalid'), 'all')
assert.equal(normalizeHistoricalAnalogProfile('long'), 'long')
assert.equal(normalizeHistoricalAnalogProfile('invalid'), 'balanced')
assert.deepEqual(
  historicalAnalogProfileConfig('balanced').weights,
  { daily: 0.4, weekly: 0.25, monthly: 0.2, yearly: 0.15 },
)
assert.deepEqual(
  requiredHistoricalAnalogComponents(['daily', 'weekly', 'monthly', 'yearly']),
  ['daily', 'weekly', 'monthly', 'yearly'],
)
assert.deepEqual(
  requiredHistoricalAnalogComponents(['daily', 'weekly', 'monthly']),
  ['daily', 'weekly', 'monthly'],
)
assert.deepEqual(requiredHistoricalAnalogComponents(['daily']), [])
assert.equal(calendarDaysBetween('2026-07-10', '2026-07-24'), 14)
assert.equal(historicalAnalogRecencyBucket(14), '2w')
assert.equal(historicalAnalogRecencyBucket(15), '1m')
assert.equal(historicalAnalogRecencyBucket(32), '3m')
assert.equal(historicalAnalogRecencyBucket(93), 'older')
assert.ok(isWithinHistoricalAnalogRecency('2026-07-10', '2026-07-24', '2w'))
assert.ok(!isWithinHistoricalAnalogRecency('2026-07-09', '2026-07-24', '2w'))
assert.ok(dateRangesOverlap('2026-01-01', '2026-02-01', '2026-01-15', '2026-03-01'))
assert.ok(!dateRangesOverlap('2026-01-01', '2026-02-01', '2026-02-02', '2026-03-01'))
assert.equal(historicalAnalogRecencyShortlistTarget('2w', 40, 400, 260), 240)
assert.equal(historicalAnalogRecencyShortlistTarget('all', 40, 400, 260), 0)

const oldStageCandidates = Array.from({ length: 120 }, (_, index) => ({
  ticker: `OLD${String(index).padStart(3, '0')}`,
  date: '2024-01-31',
  baseOffsetSessions: 0,
  sourceRole: 'end' as const,
}))
const recentApproximateCandidates = Array.from({ length: 300 }, (_, index) => ({
  ticker: index === 154 ? '6496' : `REC${String(index).padStart(3, '0')}`,
  date: `2026-07-${String(24 - (index % 15)).padStart(2, '0')}`,
  baseOffsetSessions: 0,
  sourceRole: 'end' as const,
}))
const recencyAwareShortlist = buildHistoricalAnalogShortlist(
  oldStageCandidates,
  recentApproximateCandidates,
  {
    latestMarketDate: '2026-07-24',
    recency: '2w',
    periodSessions: 60,
    resultLimit: 40,
    totalLimit: 400,
    stageLimit: 120,
    recencyLimit: 260,
    maxAnchorsPerTicker: 4,
  },
)
assert.equal(recencyAwareShortlist.diagnostics.policy, 'recency-first')
assert.equal(recencyAwareShortlist.diagnostics.recencyTarget, 240)
assert.equal(recencyAwareShortlist.diagnostics.recencyShortlistCount, 240)
assert.equal(recencyAwareShortlist.diagnostics.stagePoolCount, 0)
assert.ok(recencyAwareShortlist.rows.some((row) => row.ticker === '6496'))
assert.ok(recencyAwareShortlist.rows.every((row) =>
  isWithinHistoricalAnalogRecency(row.date, '2026-07-24', '2w')
))

const allPeriodShortlist = buildHistoricalAnalogShortlist(
  oldStageCandidates,
  recentApproximateCandidates,
  {
    latestMarketDate: '2026-07-24',
    recency: 'all',
    periodSessions: 60,
    resultLimit: 40,
    totalLimit: 400,
    stageLimit: 120,
    recencyLimit: 260,
    maxAnchorsPerTicker: 4,
  },
)
assert.equal(allPeriodShortlist.diagnostics.policy, 'global-stage-first')
assert.equal(allPeriodShortlist.diagnostics.recencyShortlistCount, 0)
assert.equal(allPeriodShortlist.rows[0]?.ticker, 'OLD000')

function priceRows(transform: (value: number, index: number) => number) {
  return Array.from({ length: 5_500 }, (_, index) => {
    const date = new Date(Date.UTC(2011, 0, 1 + index)).toISOString().slice(0, 10)
    const value = 80 + index * 0.025 + Math.sin(index / 9) * 4 + Math.sin(index / 27) * 7
    return { date, close: transform(value, index) }
  })
}

assert.deepEqual(MA_SEQUENCE_PERIODS, [5, 25, 75, 200])
assert.deepEqual(MA_SEQUENCE_STAGE_PERIODS, [5, 10, 20, 40, 60, 90, 200])
assert.deepEqual(MA_SEQUENCE_WEEKLY_PERIODS, [13, 26, 52])
assert.deepEqual(MA_SEQUENCE_MONTHLY_PERIODS, [9, 24, 60])
assert.deepEqual(MA_SEQUENCE_YEARLY_PERIODS, [3, 5, 10])
const sequenceA = prepareMaSequence(priceRows((value) => value))
const sequenceScaled = prepareMaSequence(priceRows((value) => value * 3.25))
const sequenceInverse = prepareMaSequence(priceRows((value, index) => 260 - value + index * 0.01))
const sequenceIndex = sequenceA.rows.length - 1
const scaledScore = scoreMaSequence(sequenceA, sequenceIndex, sequenceScaled, sequenceIndex)
const inverseScore = scoreMaSequence(sequenceA, sequenceIndex, sequenceInverse, sequenceIndex)
assert.ok(scaledScore.score > 0.99, `price-scale invariance failed: ${scaledScore.score}`)
assert.ok(inverseScore.score < scaledScore.score - 0.2)
assert.ok(scaledScore.components.some((component) => component.key === 'daily40' && component.available))
assert.deepEqual(sequenceA.weekly.periods, MA_SEQUENCE_WEEKLY_PERIODS)
assert.deepEqual(sequenceA.monthly.periods, MA_SEQUENCE_MONTHLY_PERIODS)
assert.deepEqual(sequenceA.yearly.periods, MA_SEQUENCE_YEARLY_PERIODS)

const weights = historicalAnalogProfileConfig('balanced').weights
const periodStart = sequenceIndex - 59
const scaledRange = scoreMaSequenceRange(
  sequenceA,
  periodStart,
  sequenceIndex,
  sequenceScaled,
  periodStart,
  sequenceIndex,
  weights,
)
const inverseRange = scoreMaSequenceRange(
  sequenceA,
  periodStart,
  sequenceIndex,
  sequenceInverse,
  periodStart,
  sequenceIndex,
  weights,
)
assert.ok(scaledRange.score > 0.99, `range price-scale invariance failed: ${scaledRange.score}`)
assert.ok(inverseRange.score < scaledRange.score - 0.15)
assert.ok(scaledRange.components.every((component) => component.available))

const shortRange = scoreMaSequenceRange(
  sequenceA,
  sequenceIndex - 4,
  sequenceIndex,
  sequenceScaled,
  sequenceIndex - 4,
  sequenceIndex,
  weights,
)
assert.ok(shortRange.dailyScore != null)
assert.ok(shortRange.weeklyScore != null)
assert.ok(shortRange.monthlyScore != null)
assert.ok(shortRange.yearlyScore != null)

const embeddingA = buildMaSequenceEmbedding(sequenceA, sequenceIndex)
const embeddingScaled = buildMaSequenceEmbedding(sequenceScaled, sequenceIndex)
assert.ok(embeddingA)
assert.ok(embeddingScaled)
assert.equal(embeddingA.quantized.length, embeddingScaled.quantized.length)
assert.equal(embeddingA.quantized.length, MA_SEQUENCE_EMBEDDING_FEATURE_LENGTH + 5)
assert.equal(embeddingA.coverageMask, 15)
assert.deepEqual(maSequenceEmbeddingRangesForCoverage(15), [
  [0, 41],
  [41, 49],
  [49, 57],
  [57, 65],
])
assert.equal(maSequenceEmbeddingSimilarity(embeddingA.quantized, embeddingScaled.quantized), 1)
assert.deepEqual(embeddingA.bands, embeddingScaled.bands)
assert.match(stageCodeAt(sequenceA, sequenceIndex) ?? '', /^[1-6]{5}$/)

const chartRows = Array.from({ length: 5_500 }, (_, index) => {
  const date = new Date(Date.UTC(2011, 0, 1 + index)).toISOString().slice(0, 10)
  const close = 100 + index * 0.1
  return {
    date,
    open: close - 1,
    high: close + 2,
    low: close - 2,
    close,
    volume: 1_000 + index,
  }
})
const chartStartDate = '2025-04-01'
const chartEndDate = '2025-07-31'
const chartsByInterval = new Map(
  CHART_INTERVAL_OPTIONS.map((option) => {
    const chart = buildHistoricalAnalogChartSeries(
      chartRows,
      option.code,
      chartStartDate,
      chartEndDate,
    )
    assert.ok(chart, `${option.label}の比較チャートを生成できること`)
    assert.ok(chart.points.length > 0, `${option.label}に表示点があること`)
    assert.match(chart.highlightStart, /^\d{4}-\d{2}-\d{2}$/)
    assert.match(chart.highlightEnd, /^\d{4}-\d{2}-\d{2}$/)
    return [option.code, chart] as const
  }),
)
assert.equal(chartsByInterval.size, 14)
const weeklyChart = chartsByInterval.get('W')!
const monthlyChart = chartsByInterval.get('M')!
const yearlyChart = chartsByInterval.get('Y')!
assert.ok(weeklyChart)
assert.ok(monthlyChart)
assert.ok(yearlyChart)
assert.ok(weeklyChart.points.length > monthlyChart.points.length)
assert.ok(monthlyChart.points.length > yearlyChart.points.length)
assert.ok(yearlyChart.points.some((point) => point.ma3 != null))
assert.ok(yearlyChart.points.some((point) => point.ma5 != null))
assert.ok(yearlyChart.points.some((point) => point.ma10 != null))
assert.ok(monthlyChart.points.some((point) => point.ma9 != null))
assert.ok(monthlyChart.points.some((point) => point.ma24 != null))
assert.ok(monthlyChart.points.some((point) => point.ma60 != null))
assert.ok(weeklyChart.points.some((point) => point.ma13 != null))
assert.ok(weeklyChart.points.some((point) => point.ma26 != null))
assert.ok(weeklyChart.points.some((point) => point.ma52 != null))
assert.ok(weeklyChart.points.some((point) => point.ma200 != null))
assert.equal(weeklyChart.startPrice, chartRows.find((row) => row.date === chartStartDate)?.close)
assert.equal(weeklyChart.endPrice, chartRows.find((row) => row.date === chartEndDate)?.close)
assert.ok(chartsByInterval.get('3W')?.points.length)
assert.ok(chartsByInterval.get('2Y')?.points.length)
assert.ok(chartsByInterval.get('3Y')?.points.length)
assert.ok(chartsByInterval.get('5Y')?.points.length)

console.log('historical analog period tests passed')
