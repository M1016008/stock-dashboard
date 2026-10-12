import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
// @ts-expect-error Node 22+ provides node:sqlite; the installed @types/node version predates it.
import { DatabaseSync } from 'node:sqlite'
import { US_HEX_ROWS_SQL, usHexRowsParams, type UsHexRawRow } from '@/lib/server/us-hex-serving'

const db = new DatabaseSync(':memory:')
db.exec(`
  CREATE TABLE market_universe (
    market TEXT NOT NULL,
    ticker TEXT NOT NULL,
    name TEXT,
    exchange TEXT,
    asset_type TEXT,
    sector TEXT,
    industry TEXT,
    shares_outstanding REAL,
    active INTEGER NOT NULL
  );
  CREATE INDEX market_universe_market_active_idx ON market_universe(market, active, ticker);

  CREATE TABLE market_daily_snapshots (
    market TEXT NOT NULL,
    ticker TEXT NOT NULL,
    date TEXT NOT NULL,
    daily_a_stage INTEGER,
    daily_b_stage INTEGER,
    weekly_a_stage INTEGER,
    weekly_b_stage INTEGER,
    monthly_a_stage INTEGER,
    monthly_b_stage INTEGER,
    ma_5 REAL,
    ma_25 REAL,
    ma_75 REAL,
    ma_300 REAL
  );
  CREATE INDEX market_snapshots_market_date_ticker_idx
    ON market_daily_snapshots(market, date, ticker);

  CREATE TABLE market_classifications (
    market TEXT NOT NULL,
    ticker TEXT NOT NULL,
    taxonomy TEXT NOT NULL,
    effective_from TEXT NOT NULL,
    sector_name TEXT,
    industry_name TEXT
  );

  CREATE TABLE market_ohlcv_daily (
    market TEXT NOT NULL,
    ticker TEXT NOT NULL,
    date TEXT NOT NULL,
    close REAL,
    adj_close REAL
  );
  CREATE INDEX market_ohlcv_market_date_ticker_idx
    ON market_ohlcv_daily(market, date, ticker);
`)

const insertUniverse = db.prepare(`
  INSERT INTO market_universe
    (market, ticker, name, exchange, asset_type, sector, industry, shares_outstanding, active)
  VALUES ('US', ?, ?, 'NASDAQ', 'Stock', ?, ?, ?, 1)
`)
insertUniverse.run('AAA', 'Alpha', 'Fallback sector', 'Fallback industry', 1000)
insertUniverse.run('BBB', 'Beta', 'Fallback sector', null, 2000)
insertUniverse.run('ATEST', 'Test artifact', 'Ignored', null, 1)

db.prepare(`
  INSERT INTO market_classifications
    (market, ticker, taxonomy, effective_from, sector_name, industry_name)
  VALUES ('US', 'AAA', ?, '0000-01-01', 'Technology', 'Software')
`).run(usHexRowsParams('2026-10-09').at(-1) as string)

const insertSnapshot = db.prepare(`
  INSERT INTO market_daily_snapshots
    (market, ticker, date, daily_a_stage, daily_b_stage, weekly_a_stage, weekly_b_stage,
     monthly_a_stage, monthly_b_stage, ma_5, ma_25, ma_75, ma_300)
  VALUES ('US', 'AAA', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`)
insertSnapshot.run('2026-10-07', 2, 2, 3, 3, 4, 4, 90, 80, 70, 60)
insertSnapshot.run('2026-10-08', 1, 2, 3, 4, 5, 6, 100, 90, 80, 70)
insertSnapshot.run('2026-10-09', 1, 1, 2, 2, 3, 3, 110, 100, 90, 80)

const insertPrice = db.prepare(`
  INSERT INTO market_ohlcv_daily (market, ticker, date, close, adj_close)
  VALUES ('US', ?, ?, ?, ?)
`)
for (const [date, close, adjusted] of [
  ['2025-12-31', 50, 55],
  ['2026-04-09', 60, null],
  ['2026-07-09', 70, null],
  ['2026-09-09', 80, null],
  ['2026-10-02', 90, null],
  ['2026-10-08', 100, null],
  ['2026-10-09', 105, 110],
] as const) {
  insertPrice.run('AAA', date, close, adjusted)
}

const rows = db.prepare(US_HEX_ROWS_SQL).all(...usHexRowsParams('2026-10-09')) as unknown as UsHexRawRow[]
assert.deepEqual(rows.map((row) => row.ticker), ['AAA', 'BBB'])

const alpha = rows[0]
assert.equal(alpha.sector, 'Technology')
assert.equal(alpha.industry, 'Software')
assert.equal(alpha.price, 110, 'adjusted close must take precedence')
assert.equal(alpha.perf_1d, 10)
assert.ok(Math.abs((alpha.perf_1w ?? 0) - 22.2222222222) < 1e-8)
assert.equal(alpha.perf_1m, 37.5)
assert.ok(Math.abs((alpha.perf_3m ?? 0) - 57.1428571429) < 1e-8)
assert.ok(Math.abs((alpha.perf_6m ?? 0) - 83.3333333333) < 1e-8)
assert.equal(alpha.perf_ytd, 100, 'YTD must use the latest market date on or before January 1')
assert.equal(alpha.daily_a_stage, 1)
assert.equal(alpha.prev_ma_5, 100)
assert.equal(alpha.prev2_ma_5, 90)

const beta = rows[1]
assert.equal(beta.snapshot_ticker, null)
assert.equal(beta.price, null)
assert.equal(beta.perf_1d, null)
assert.equal(beta.sector, 'Fallback sector')

assert.equal((US_HEX_ROWS_SQL.match(/JOIN market_ohlcv_daily/g) ?? []).length, 1)
assert.match(US_HEX_ROWS_SQL, /INDEXED BY market_ohlcv_market_date_ticker_idx/)
assert.doesNotMatch(US_HEX_ROWS_SQL, /LEFT JOIN market_ohlcv_daily/)

const routeSource = readFileSync('app/api/us/hex/route.ts', 'utf8')
const viewSource = readFileSync('components/hex/HexStageMapView.tsx', 'utf8')
assert.match(routeSource, /compact-v1/)
assert.match(routeSource, /delete compact\.ml_candidate_direction/)
assert.match(viewSource, /params\.set\('compact', '1'\)/)

db.close()
console.log('US HEX serving query tests: PASS')
