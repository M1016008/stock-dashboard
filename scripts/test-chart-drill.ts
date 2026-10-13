import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { NextRequest } from 'next/server'
import { POST } from '../app/api/chart-drill/answer/route'
import { chartDrillAnswerErrorResponse } from '../lib/chart-drill/http'
import { ChartDrillProblemError, decodeProblemId } from '../lib/chart-drill/server'
import {
  answerIsCorrect,
  computeOutcome,
  enrichCandlesWithMa,
  isCandidateForDifficulty,
  movingAverage,
} from '../lib/chart-drill/scoring'
import type { DrillCandle } from '../lib/chart-drill/types'
import { toAdjustedUsOhlcvRows } from '../lib/us-adjusted-ohlcv'

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

const splitAdjusted = toAdjustedUsOhlcvRows([
  {
    date: '2024-06-07',
    open: 1200,
    high: 1210,
    low: 1180,
    close: 1200,
    volume: 1_000,
    adjustedOpen: 120,
    adjustedHigh: 121,
    adjustedLow: 118,
    adjustedClose: 120,
    adjustedVolume: 10_000,
  },
  {
    date: '2024-06-10',
    open: 121,
    high: 123,
    low: 119,
    close: 122,
    volume: 10_500,
    adjustedOpen: 121,
    adjustedHigh: 123,
    adjustedLow: 119,
    adjustedClose: 122,
    adjustedVolume: 10_500,
  },
])
const splitOutcome = computeOutcome({
  base: candle(splitAdjusted[0].date, splitAdjusted[0].close, splitAdjusted[0].high, splitAdjusted[0].low),
  future: [candle(splitAdjusted[1].date, splitAdjusted[1].close, splitAdjusted[1].high, splitAdjusted[1].low)],
  thresholdPct: 5,
})
assert.equal(splitOutcome.actual, 'pass')
assert.ok(splitOutcome.maxDownPct > -5)

const validProblemPayload = {
  v: 1,
  market: 'JP',
  ticker: '7003',
  asOfDate: '2026-09-25',
  horizonDays: 10,
  thresholdPct: 5,
  direction: 'up',
  target: 'jp',
  difficulty: 'intermediate',
}
const validProblemId = Buffer.from(JSON.stringify(validProblemPayload), 'utf8').toString('base64url')
assert.deepEqual(decodeProblemId(validProblemId), validProblemPayload)
assert.throws(
  () => decodeProblemId('not-base64'),
  (error: unknown) => error instanceof ChartDrillProblemError && error.code === 'INVALID_PROBLEM_ID',
)

const chartDrillClientSource = readFileSync(
  new URL('../app/chart-drill/ChartDrillClient.tsx', import.meta.url),
  'utf8',
)
assert.equal(
  chartDrillClientSource.match(/<div className="min-w-0 space-y-3">/g)?.length,
  2,
  'Chart Drill grid columns must remain shrinkable on narrow viewports',
)
assert.doesNotMatch(
  chartDrillClientSource,
  /<div className="space-y-3">/,
  'Chart Drill grid columns must not restore the CSS Grid auto minimum width',
)

async function testAnswerApiErrors() {
  const missing = await POST(new NextRequest('http://localhost/api/chart-drill/answer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answer: 'pass' }),
  }))
  assert.equal(missing.status, 400)
  assert.deepEqual(await missing.json(), {
    error: 'invalid_problem_id',
    message: '問題IDが不正です。次の問題を取得してください。',
  })

  const malformed = await POST(new NextRequest('http://localhost/api/chart-drill/answer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ problemId: 'not-base64', answer: 'pass' }),
  }))
  assert.equal(malformed.status, 400)
  assert.equal((await malformed.json()).error, 'invalid_problem_id')

  const notFound = chartDrillAnswerErrorResponse(new ChartDrillProblemError(
    'PROBLEM_NOT_FOUND',
    '対象の問題が見つかりません。次の問題を取得してください。',
  ))
  assert.equal(notFound.status, 404)
  assert.equal((await notFound.json()).error, 'chart_drill_problem_not_found')

  const internal = chartDrillAnswerErrorResponse(new Error('SQL failed at /private/path with secret'))
  assert.equal(internal.status, 500)
  const internalBody = await internal.json() as { error: string; message: string }
  assert.equal(internalBody.error, 'chart_drill_internal_error')
  assert.equal(internalBody.message.includes('SQL'), false)
  assert.equal(internalBody.message.includes('/private/path'), false)
  assert.equal(internalBody.message.includes('secret'), false)
}

testAnswerApiErrors()
  .then(() => console.log('chart-drill scoring and API error tests passed'))
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
