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
const earlierSessions: string[] = []
const earlierCursor = new Date('2024-10-01T00:00:00.000Z')
while (earlierSessions.length < 499) {
  const day = earlierCursor.getUTCDay()
  if (day !== 0 && day !== 6) earlierSessions.push(earlierCursor.toISOString().slice(0, 10))
  earlierCursor.setUTCDate(earlierCursor.getUTCDate() + 1)
}
for (const date of earlierSessions) {
  insertPrice.run('SPY', date, 100, 101, 99, 100, 100, 101, 99, 100, 1_000, 1_000)
}
for (const row of [
  ['SPY', '2026-10-20', 500, 502, 498, 501, 500, 502, 498, 501, 10000, 10000],
  ['SPY', '2026-10-21', 501, 504, 500, 503, 501, 504, 500, 503, 11000, 11000],
  ['SPY', '2026-10-22', 503, 506, 502, 505, 503, 506, 502, 505, 12000, 12000],
  ['AAA', '2026-10-20', 99, 102, 98, 100, 49.5, 51, 49, 50, 1000, 2000],
  ['AAA', '2026-10-21', 101, 112, 100, 110, 50.5, 56, 50, 55, 1200, null],
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
const calendarPlan = db.prepare("EXPLAIN QUERY PLAN SELECT date FROM market_ohlcv_daily WHERE market = 'US' AND ticker = 'SPY' ORDER BY date ASC").all()
  .map((row) => String((row as { detail?: unknown }).detail ?? ''))
  .join(' ')
assert.match(calendarPlan, /(?:COVERING )?INDEX .*\(market=\? AND ticker=\?\)/)
assert.doesNotMatch(calendarPlan, /USE TEMP B-TREE|SCAN market_ohlcv_daily/)
db.close()

process.env.USE_LOCAL_DB = '1'
process.env.STOCKBOARD_DB_PATH = dbPath
process.env.SERVING_CACHE_DB_PATH = cachePath
delete process.env.TURSO_DATABASE_URL
delete process.env.TURSO_AUTH_TOKEN

async function main(): Promise<void> {
  const {
    PERIOD_EXPLORER_MAX_TRADING_DAYS,
    PeriodExplorerInputError,
    getPeriodExplorerCalendar,
    queryPeriodExplorer,
    resolvePeriodExplorerDateRange,
  } = await import('@/lib/server/period-explorer-read-model')

  try {
  const calendar = await getPeriodExplorerCalendar('US')
  assert.equal(calendar.length, 502)
  assert.deepEqual(calendar.slice(-3), ['2026-10-20', '2026-10-21', '2026-10-22'])
  assert.equal(PERIOD_EXPLORER_MAX_TRADING_DAYS, 500)
  await assert.rejects(
    resolvePeriodExplorerDateRange(calendar[0], calendar.at(-1), 'US'),
    (error: unknown) => error instanceof PeriodExplorerInputError && /最大500取引日/.test(error.message),
  )
  await assert.rejects(resolvePeriodExplorerDateRange('2026-02-30', '2026-10-22', 'US'), PeriodExplorerInputError)
  const range = await resolvePeriodExplorerDateRange('2026-10-20', '2026-10-22', 'US')
  assert.equal(range.tradingDays, 3)
  assert.equal(range.current, true)

  const response = await queryPeriodExplorer({
    market: 'US', from: range.adoptedFrom, to: range.adoptedTo,
    ranking: 'return_up', taxonomy: 'sector17', limit: 20,
  })
  assert.equal(response.market, 'US')
  assert.equal(response.dataBasis.shares, 'current_only')
  assert.deepEqual(
    response.rows.map((row) => row.rowType === 'stock' ? row.ticker : '').sort(),
    ['AAA', 'SPY'],
    'rows without adjusted endpoints and test symbols must be excluded while the SPY calendar row remains eligible',
  )
  const alpha = response.rows.find((row) => row.rowType === 'stock' && row.ticker === 'AAA')
  assert.ok(alpha && alpha.rowType === 'stock')
  assert.equal(alpha.startClose, 50, 'adjusted close must be the endpoint basis')
  assert.equal(alpha.endClose, 60)
  assert.ok(Math.abs((alpha.periodReturnPct ?? 0) - 20) < 1e-9)
  assert.equal(alpha.selectedSector, 'Technology')
  assert.equal(alpha.marketCap, 60_000_000)
  assert.equal(alpha.marketCapBasis, 'current')

  const volume = await queryPeriodExplorer({
    market: 'US', from: range.adoptedFrom, to: range.adoptedTo,
    ranking: 'avg_volume', taxonomy: 'sector17', limit: 20,
  })
  const volumeAlpha = volume.rows.find((row) => row.rowType === 'stock' && row.ticker === 'AAA')
  assert.ok(volumeAlpha && volumeAlpha.rowType === 'stock')
  assert.equal(volumeAlpha.volumeObservations, 2)
  assert.equal(volumeAlpha.turnoverObservations, 2)

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

  const historical = await queryPeriodExplorer({
    market: 'US', from: '2026-10-20', to: '2026-10-21', ranking: 'return_up', limit: 20,
  })
  assert.equal(historical.range.current, false)
  assert.equal(historical.dataBasis.shares, 'unavailable_historical')
  assert.equal(historical.dataBasis.classifications, 'unavailable_historical')
  assert.deepEqual(historical.options, { markets: [], sectors: [], marginTypes: [] })
  const historicalAlpha = historical.rows.find((row) => row.rowType === 'stock' && row.ticker === 'AAA')
  assert.ok(historicalAlpha && historicalAlpha.rowType === 'stock')
  assert.equal(historicalAlpha.marketCap, null)
  assert.equal(historicalAlpha.selectedSector, null)
  await assert.rejects(
    queryPeriodExplorer({
      market: 'US', from: '2026-10-20', to: '2026-10-21', ranking: 'return_up',
      filters: { marketCapMin: 1 },
    }),
    (error: unknown) => error instanceof PeriodExplorerInputError && /PIT分類/.test(error.message),
  )
  const clientSource = fs.readFileSync(path.join(process.cwd(), 'app/period-explorer/PeriodExplorerClient.tsx'), 'utf8')
  const serverSource = fs.readFileSync(path.join(process.cwd(), 'lib/server/period-explorer-read-model.ts'), 'utf8')
  assert.match(clientSource, /historicalUs/)
  assert.match(clientSource, /stripUnavailableHistoricalUsParams/)
  assert.match(clientSource, /turnoverObservations/)
  assert.match(clientSource, /現行参照を混入させない/)
  assert.match(serverSource, /ticker = 'SPY'/)
  assert.doesNotMatch(serverSource, /SELECT DISTINCT date FROM market_ohlcv_daily WHERE market = 'US'/)
    console.log('US Period Explorer fixture tests: PASS')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
