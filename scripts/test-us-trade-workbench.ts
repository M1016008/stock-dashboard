import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { NextRequest } from 'next/server'
// @ts-expect-error Node 22+ provides node:sqlite; the installed @types/node version predates it.
import { DatabaseSync } from 'node:sqlite'
import { GET as getUsTradeWorkbenchApi } from '@/app/api/us/trade-workbench-candidates/route'
import {
  getUsTradeWorkbench,
  type UsTradeWorkbenchExecutor,
} from '@/lib/queries/us-trade-workbench'
import { US_ADJUSTED_PRICE_BASIS } from '@/lib/us-adjusted-ohlcv'

const db = new DatabaseSync(':memory:')
db.exec(`
  CREATE TABLE ticker_universe (
    ticker TEXT PRIMARY KEY,
    name TEXT,
    active INTEGER NOT NULL,
    market_segment TEXT,
    sector17_name TEXT,
    sector33_name TEXT
  );
  CREATE TABLE ohlcv_daily (
    ticker TEXT NOT NULL,
    date TEXT NOT NULL,
    open REAL NOT NULL,
    high REAL NOT NULL,
    low REAL NOT NULL,
    close REAL NOT NULL,
    volume INTEGER NOT NULL,
    PRIMARY KEY (ticker, date)
  );
  CREATE TABLE daily_snapshots (
    ticker TEXT NOT NULL,
    date TEXT NOT NULL,
    ma_5 REAL,
    ma_25 REAL,
    ma_75 REAL,
    daily_a_stage INTEGER,
    daily_b_stage INTEGER,
    weekly_a_stage INTEGER,
    weekly_b_stage INTEGER,
    monthly_a_stage INTEGER,
    monthly_b_stage INTEGER,
    PRIMARY KEY (ticker, date)
  );
  CREATE TABLE serving_ml_physics_candidates (
    as_of_date TEXT NOT NULL,
    direction TEXT NOT NULL,
    horizon_days INTEGER NOT NULL,
    rank INTEGER NOT NULL,
    ticker TEXT NOT NULL,
    candidate_score REAL NOT NULL,
    model_name TEXT,
    PRIMARY KEY (as_of_date, direction, horizon_days, ticker)
  );
  CREATE TABLE us_analytics_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  INSERT INTO us_analytics_metadata VALUES ('ohlcv_price_basis', '${US_ADJUSTED_PRICE_BASIS}');
  INSERT INTO ticker_universe VALUES
    ('AAPL', 'Apple Inc.', 1, 'NASDAQ', 'Technology', 'Consumer Electronics'),
    ('TSLA', 'Tesla, Inc.', 1, 'NASDAQ', 'Consumer Cyclical', 'Auto Manufacturers'),
    ('MISS', 'Missing Price Corp.', 1, 'NYSE', 'Industrials', 'Machinery'),
    ('ATEST', 'Fixture Artifact', 1, 'NASDAQ', 'Testing', 'Testing');
  INSERT INTO ohlcv_daily VALUES
    ('AAPL', '2026-10-08', 195, 202, 194, 200, 900000),
    ('AAPL', '2026-10-09', 202, 211, 201, 210, 1000000),
    ('TSLA', '2026-10-08', 310, 312, 298, 300, 700000),
    ('TSLA', '2026-10-09', 296, 299, 278, 280, 800000);
  INSERT INTO daily_snapshots VALUES
    ('AAPL', '2026-10-08', 190, 180, 170, 1, 2, 1, 2, 6, 1),
    ('AAPL', '2026-10-09', 200, 185, 175, 1, 1, 1, 2, 6, 1),
    ('TSLA', '2026-10-08', 310, 320, 330, 4, 3, 4, 3, 4, 3),
    ('TSLA', '2026-10-09', 295, 315, 325, 4, 4, 4, 3, 4, 3);
  INSERT INTO serving_ml_physics_candidates VALUES
    ('2026-10-09', 'up', 20, 1, 'AAPL', 0.96, 'physics-v2'),
    ('2026-10-09', 'wait', 20, 80, 'AAPL', 0.20, 'physics-v2'),
    ('2026-10-09', 'down', 20, 1, 'TSLA', 0.97, 'physics-v2'),
    ('2026-10-09', 'up', 20, 110, 'TSLA', 0.10, 'physics-v2'),
    ('2026-10-09', 'up', 20, 2, 'MISS', 0.91, 'physics-v2'),
    ('2026-10-09', 'up', 20, 3, 'ATEST', 0.90, 'physics-v2');
`)

const executor: UsTradeWorkbenchExecutor = {
  async all<T>(sql: string, args: readonly unknown[] = []): Promise<T[]> {
    return db.prepare(sql).all(...args) as T[]
  },
  async get<T>(sql: string, args: readonly unknown[] = []): Promise<T | undefined> {
    return db.prepare(sql).get(...args) as T | undefined
  },
}

async function main() {
const result = await getUsTradeWorkbench({ horizonDays: 20, limit: 40, budgetUsd: 1_000 }, executor)
assert.equal(result.coverage.availability, 'partial')
assert.equal(result.coverage.reason, 'INCOMPLETE_CANDIDATES_EXCLUDED')
assert.equal(result.coverage.asOfDate, '2026-10-09')
assert.equal(result.coverage.snapshotDate, '2026-10-09')
assert.equal(result.coverage.priceDate, '2026-10-09')
assert.equal(result.coverage.priceBasis, US_ADJUSTED_PRICE_BASIS)
assert.equal(result.coverage.rawCandidateCount, 4)
assert.equal(result.coverage.completeCandidateCount, 2)
assert.equal(result.coverage.excludedCandidateCount, 2, 'missing price and test symbols must remain visible in coverage')
assert.equal(result.coverage.completeRate, 0.5)
assert.deepEqual(result.candidates.map((candidate) => candidate.ticker), ['AAPL', 'TSLA'])

const apple = result.candidates.find((candidate) => candidate.ticker === 'AAPL')
assert.ok(apple)
assert.equal(apple.decision.action, 'buy_candidate')
assert.equal(apple.orderDraft.valid, true)
assert.equal(apple.orderDraft.side, 'BUY')
assert.equal(apple.orderDraft.currency, 'USD')
assert.equal(apple.orderDraft.lotSize, 1)
assert.equal(apple.orderDraft.quantity, 4)
assert.equal(apple.orderDraft.estimatedAmount, 840)
assert.equal(apple.maState.order, 'SHORT_ABOVE_MIDDLE_ABOVE_LONG')
assert.equal(apple.stageCode, '111261')

const tesla = result.candidates.find((candidate) => candidate.ticker === 'TSLA')
assert.ok(tesla)
assert.equal(tesla.decision.action, 'downside_watch')
assert.equal(tesla.orderDraft.valid, false)
assert.equal(tesla.orderDraft.side, null, 'borrow availability is absent, so no short order draft may be produced')
assert.ok(tesla.decision.riskNotes.some((note) => note.includes('借株可否')))
assert.ok(result.coverage.unavailableEvidence.includes('VALIDATED_OUTCOME_EVIDENCE'))
assert.ok(result.coverage.unavailableEvidence.includes('SIGNAL_RETURN_STATISTICS'))

db.prepare(`UPDATE us_analytics_metadata SET value = 'unknown_basis' WHERE key = 'ohlcv_price_basis'`).run()
const badBasis = await getUsTradeWorkbench({ horizonDays: 20 }, executor)
assert.equal(badBasis.coverage.availability, 'unavailable')
assert.equal(badBasis.coverage.reason, 'US_PRICE_BASIS_MISMATCH')
assert.equal(badBasis.candidates.length, 0)

db.prepare(`UPDATE us_analytics_metadata SET value = ? WHERE key = 'ohlcv_price_basis'`).run(US_ADJUSTED_PRICE_BASIS)
db.prepare(`INSERT INTO serving_ml_physics_candidates VALUES ('2026-10-10', 'up', 20, 1, 'AAPL', 0.99, 'physics-v2')`).run()
const generationMismatch = await getUsTradeWorkbench({ horizonDays: 20 }, executor)
assert.equal(generationMismatch.coverage.availability, 'unavailable')
assert.equal(generationMismatch.coverage.reason, 'US_SERVING_GENERATION_MISMATCH')
assert.equal(generationMismatch.candidates.length, 0, 'generation mismatch must not fall back to an older date')

const querySource = readFileSync('lib/queries/us-trade-workbench.ts', 'utf8')
const pageSource = readFileSync('app/us/trade/workbench/page.tsx', 'utf8')
const routeSource = readFileSync('app/api/us/trade-workbench-candidates/route.ts', 'utf8')

for (const stoppedSource of ['pattern_stats', 'signal_return_stats', 'ml_model_evaluations', 'validation', 'holdout']) {
  assert.doesNotMatch(querySource.toLowerCase(), new RegExp(stoppedSource), `must not read stopped source: ${stoppedSource}`)
}
assert.match(querySource, /US_ADJUSTED_PRICE_BASIS/)
assert.match(querySource, /lotSize: 1/)
assert.match(querySource, /borrow availability is absent|借株データがない/)
assert.doesNotMatch(querySource, /budgetYen|margin_type|貸借|100株/)
assert.match(pageSource, /USD/)
assert.match(pageSource, /1株/)
assert.match(pageSource, /過去Outcomeや借株可否は使いません/)
assert.match(routeSource, /status = result\.coverage\.availability === 'unavailable' \? 503 : 200/)
assert.match(routeSource, /invalid_query_parameters/)
assert.doesNotMatch(routeSource, /message: error|String\(error\)/)

const duplicateResponse = await getUsTradeWorkbenchApi(new NextRequest(
  'http://localhost/api/us/trade-workbench-candidates?horizon=20&horizon=40',
))
assert.equal(duplicateResponse.status, 400)
assert.equal((await duplicateResponse.json()).error, 'invalid_query_parameters')
const invalidResponse = await getUsTradeWorkbenchApi(new NextRequest(
  'http://localhost/api/us/trade-workbench-candidates?budgetUsd=-1',
))
assert.equal(invalidResponse.status, 400)
assert.equal((await invalidResponse.json()).error, 'invalid_query_parameters')

console.log('US trade workbench fixture tests passed')

}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

