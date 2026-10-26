import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// @ts-expect-error Node 22+ provides node:sqlite; the installed @types/node version predates it.
import { DatabaseSync } from 'node:sqlite'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stockboard-us-period-explorer-'))
const dbPath = path.join(root, 'fixture.db')
const cachePath = path.join(root, 'serving-cache.db')
const db = new DatabaseSync(dbPath)

db.exec(`
  CREATE TABLE market_universe (
    market TEXT NOT NULL, ticker TEXT NOT NULL, name TEXT, active INTEGER NOT NULL,
    exchange TEXT, currency TEXT, asset_type TEXT, sector TEXT, industry TEXT,
    start_date TEXT, end_date TEXT, shares_outstanding INTEGER, source TEXT,
    source_payload_json TEXT, updated_at INTEGER, PRIMARY KEY (market, ticker)
  );
  CREATE TABLE market_classifications (
    market TEXT NOT NULL, ticker TEXT NOT NULL, taxonomy TEXT NOT NULL,
    effective_from TEXT NOT NULL, effective_to TEXT, sector_name TEXT,
    industry_name TEXT, updated_at INTEGER
  );
  CREATE TABLE market_ohlcv_daily (
    market TEXT NOT NULL, ticker TEXT NOT NULL, date TEXT NOT NULL,
    open REAL, high REAL, low REAL, close REAL,
    adj_open REAL, adj_high REAL, adj_low REAL, adj_close REAL,
    volume INTEGER, adj_volume INTEGER, source TEXT, imported_at INTEGER,
    PRIMARY KEY (market, ticker, date)
  );
  CREATE TABLE market_daily_snapshots (
    market TEXT NOT NULL, ticker TEXT NOT NULL, date TEXT NOT NULL,
    ma_25 REAL, ma_75 REAL,
    daily_a_stage INTEGER, daily_b_stage INTEGER,
    weekly_a_stage INTEGER, weekly_b_stage INTEGER,
    monthly_a_stage INTEGER, monthly_b_stage INTEGER,
    PRIMARY KEY (market, ticker, date)
  );
`)

const insertUniverse = db.prepare(`
  INSERT INTO market_universe
    (market, ticker, name, active, exchange, currency, asset_type, sector, industry,
     start_date, end_date, shares_outstanding, source, source_payload_json, updated_at)
  VALUES ('US', ?, ?, ?, 'NASDAQ', 'USD', 'Stock', ?, ?, '2020-01-01', NULL, ?, 'fixture', '{}', 1)
`)
insertUniverse.run('AAA', 'Alpha', 1, 'Fallback Technology', 'Fallback Software', 1_000_000)
insertUniverse.run('BBB', 'Beta', 1, 'Healthcare', 'Biotech', 2_000_000)
insertUniverse.run('ATEST', 'Artifact', 1, 'Invalid', 'Invalid', 1)

db.prepare(`
  INSERT INTO market_classifications
    (market, ticker, taxonomy, effective_from, sector_name, industry_name, updated_at)
  VALUES ('US', 'AAA', 'US_SEC_SIC', '0000-01-01', 'Technology', 'Software', 1)
`).run()

const insertPrice = db.prepare(`
  INSERT INTO market_ohlcv_daily
    (market, ticker, date, open, high, low, close, adj_open, adj_high, adj_low, adj_close,
     volume, adj_volume, source, imported_at)
  VALUES ('US', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'fixture', 1)
`)
for (const row of [
  ['AAA', '2026-10-20', 99, 102, 98, 100, 49.5, 51, 49, 50, 1000, 2000],
  ['AAA', '2026-10-21', 101, 112, 100, 110, 50.5, 56, 50, 55, 1200, 2400],
  ['AAA', '2026-10-22', 111, 122, 110, 120, 55.5, 61, 55, 60, 1400, 2800],
  ['BBB', '2026-10-20', 20, 21, 19, 20, null, null, null, null, 500, null],
  ['BBB', '2026-10-21', 20, 22, 20, 21, null, null, null, null, 600, null],
  ['BBB', '2026-10-22', 21, 23, 21, 22, null, null, null, null, 700, null],
  ['ATEST', '2026-10-20', 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  ['ATEST', '2026-10-22', 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
] as const) insertPrice.run(...row)

const insertSnapshot = db.prepare(`
  INSERT INTO market_daily_snapshots
    (market, ticker, date, ma_25, ma_75, daily_a_stage, daily_b_stage,
     weekly_a_stage, weekly_b_stage, monthly_a_stage, monthly_b_stage)
  VALUES ('US', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`)
insertSnapshot.run('AAA', '2026-10-20', 48, 45, 2, 2, 3, 3, 4, 4)
insertSnapshot.run('AAA', '2026-10-22', 54, 47, 1, 2, 2, 3, 3, 4)
insertSnapshot.run('BBB', '2026-10-20', 19, 18, 4, 4, 4, 4, 4, 4)
insertSnapshot.run('BBB', '2026-10-22', 21, 19, 4, 4, 4, 4, 4, 4)
db.close()

process.env.USE_LOCAL_DB = '1'
process.env.STOCKBOARD_DB_PATH = dbPath
process.env.SERVING_CACHE_DB_PATH = cachePath
delete process.env.TURSO_DATABASE_URL
delete process.env.TURSO_AUTH_TOKEN

async function main(): Promise<void> {
  const {
    getPeriodExplorerCalendar,
    queryPeriodExplorer,
    resolvePeriodExplorerDateRange,
  } = await import('@/lib/server/period-explorer-read-model')

  try {
  const calendar = await getPeriodExplorerCalendar('US')
  assert.deepEqual(calendar, ['2026-10-20', '2026-10-21', '2026-10-22'])
  const range = await resolvePeriodExplorerDateRange('2026-10-20', '2026-10-22', 'US')
  assert.equal(range.tradingDays, 3)

  const response = await queryPeriodExplorer({
    market: 'US', from: range.adoptedFrom, to: range.adoptedTo,
    ranking: 'return_up', taxonomy: 'sector17', limit: 20,
  })
  assert.equal(response.market, 'US')
  assert.equal(response.dataBasis.shares, 'current_only')
  assert.equal(response.rows.length, 2, 'test symbols must be excluded')
  const alpha = response.rows.find((row) => row.rowType === 'stock' && row.ticker === 'AAA')
  assert.ok(alpha && alpha.rowType === 'stock')
  assert.equal(alpha.startClose, 50, 'adjusted close must be the endpoint basis')
  assert.equal(alpha.endClose, 60)
  assert.ok(Math.abs((alpha.periodReturnPct ?? 0) - 20) < 1e-9)
  assert.equal(alpha.selectedSector, 'Technology')
  assert.equal(alpha.marketCap, 60_000_000)
  assert.equal(alpha.marketCapBasis, 'current')

  const technical = await queryPeriodExplorer({
    market: 'US', from: range.adoptedFrom, to: range.adoptedTo,
    ranking: 'stage_improve', limit: 20,
  })
  const technicalAlpha = technical.rows.find((row) => row.rowType === 'stock' && row.ticker === 'AAA')
  assert.ok(technicalAlpha && technicalAlpha.rowType === 'stock')
  assert.equal(technicalAlpha.rankingValue, 3)

  const marketCapFiltered = await queryPeriodExplorer({
    market: 'US', from: range.adoptedFrom, to: range.adoptedTo,
    ranking: 'return_up', filters: { marketCapMin: 50_000_000 }, limit: 20,
  })
  assert.deepEqual(marketCapFiltered.rows.map((row) => row.rowType === 'stock' ? row.ticker : ''), ['AAA'])
    console.log('US Period Explorer fixture tests: PASS')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
