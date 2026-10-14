import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  endOfUsMarketDateEpoch,
  evaluateUsMlPredictionOutcome,
  type UsMlPredictionPrice,
} from '@/lib/server/us-ml-prediction-history'
import { selectUsPredictionHistoryRows } from '@/lib/us-ml-prediction-history-view'

const root = process.cwd()
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8')

assert.equal(
  new Date(endOfUsMarketDateEpoch('2026-07-01') * 1000).toISOString(),
  '2026-07-02T03:59:59.000Z',
  'summer market-date cutoff uses New York daylight time',
)

const pending = (asOfDate: string) => ({
  asOfDate,
  horizonDays: 40,
  direction: 'up' as const,
  rank: 1,
  score: 0.8,
  modelName: 'fixture',
  outcome: null,
})
const completed = (asOfDate: string) => ({
  ...pending(asOfDate),
  outcome: {
    returnPct: 4,
    maxReturnPct: 11,
    minReturnPct: -2,
    hitLabel: true,
  },
})
const mixedRows = [
  pending('2026-10-13'),
  pending('2026-10-12'),
  pending('2026-10-09'),
  completed('2026-08-14'),
  completed('2026-08-13'),
]
const selectedMixed = selectUsPredictionHistoryRows(mixedRows)
assert.deepEqual(
  selectedMixed.map((row) => row.asOfDate),
  ['2026-10-13', '2026-10-12', '2026-08-14', '2026-08-13'],
  'mixed US history keeps deterministic API order while exposing pending and completed outcomes',
)
assert.equal(selectedMixed.filter((row) => row.outcome).length, 2)
assert.deepEqual(
  selectUsPredictionHistoryRows(mixedRows.slice(0, 3)).map((row) => row.asOfDate),
  ['2026-10-13', '2026-10-12', '2026-10-09'],
  'all-pending history remains newest-first without filler rows',
)
assert.equal(
  new Date(endOfUsMarketDateEpoch('2026-01-05') * 1000).toISOString(),
  '2026-01-06T04:59:59.000Z',
  'winter market-date cutoff uses New York standard time',
)

const prices: UsMlPredictionPrice[] = [
  { date: '2026-01-02', close: 100 },
  { date: '2026-01-05', close: 104 },
  { date: '2026-01-06', close: 112 },
  { date: '2026-01-07', close: 94 },
  { date: '2026-01-08', close: 101 },
]
const up = evaluateUsMlPredictionOutcome(
  { asOfDate: '2026-01-02', direction: 'up', horizonDays: 3 },
  prices,
)
assert.ok(up)
assert.equal(up.hitLabel, true, 'up prediction hits after a +10% intrahorizon move')
assert.equal(up.missLabel, true, 'opposite adverse threshold remains independently visible')
assert.equal(up.payload.endDate, '2026-01-07')
assert.equal(up.payload.observedSessions, 3)
assert.notEqual(up.returnPct, null)
assert.ok(Math.abs(up.returnPct! - (-6)) < 1e-9, 'returns preserve numeric precision without brittle equality')

const down = evaluateUsMlPredictionOutcome(
  { asOfDate: '2026-01-02', direction: 'down', horizonDays: 3 },
  prices,
)
assert.ok(down)
assert.equal(down.hitLabel, true, 'down prediction hits after a -5% intrahorizon move')
assert.equal(down.missLabel, true, 'opposite +10% move remains visible')

assert.equal(
  evaluateUsMlPredictionOutcome(
    { asOfDate: '2026-01-05', direction: 'up', horizonDays: 4 },
    prices,
  ),
  null,
  'an outcome is unavailable until every requested future session is observed',
)

const server = read('lib/server/us-ml-prediction-history.ts')
const route = read('app/api/us/ml-prediction-history/route.ts')
const client = read('components/stock/StockMlInsights.tsx')

assert.match(server, /p\.created_at <= \?/, 'historical query is bounded by prediction publication time')
assert.match(server, /m\.trained_at <= \?/, 'historical query is bounded by model publication time')
assert.match(server, /AND date <= \?/, 'outcome prices are bounded by the requested market date')
assert.match(server, /ohlcv_daily_readonly/, 'computed outcomes declare their deterministic price source')
assert.doesNotMatch(server, /INSERT|UPDATE|DELETE/i, 'prediction history is read only')
assert.match(route, /hasUsAnalyticsDb/, 'route fails closed when the US analytics DB is absent')
assert.doesNotMatch(route, /getMlPredictionHistory/, 'US route never falls back to the JP prediction reader')
assert.match(client, /\/api\/us\/ml-prediction-history/, 'US stock ML view requests the market-safe history endpoint')
assert.doesNotMatch(client, /market === 'US'\s*\?\s*Promise\.resolve\(\{ rows: \[\] \}\)/, 'US history is no longer hardcoded empty')

console.log('US ML prediction history tests passed')
