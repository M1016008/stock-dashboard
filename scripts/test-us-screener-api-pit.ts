import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { NextRequest } from 'next/server'

const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockboard-us-screener-pit-'))
Object.assign(process.env, {
  NODE_ENV: 'test',
  EXTERNAL_STORAGE_REQUIRED: 'false',
  USE_LOCAL_DB: '1',
  STOCKBOARD_DB_PATH: path.join(runtimeDir, 'stockboard.db'),
  SERVING_CACHE_DB_PATH: path.join(runtimeDir, 'serving-cache.db'),
  STOCK_DATA_INCIDENT_DIR: path.join(runtimeDir, 'incidents'),
  US_ANALYTICS_DB_PATH: path.join(runtimeDir, 'missing-us-analytics.db'),
})

async function main() {
const { execRun } = await import('@/lib/db/client')
const { GET } = await import('@/app/api/us/screener/route')

for (const ticker of ['AAPL', 'MSFT']) {
  await execRun(
    `INSERT INTO market_universe (
       market, ticker, name, active, exchange, currency, asset_type,
       sector, industry, start_date, end_date, shares_outstanding, source
     ) VALUES ('US', ?, ?, ?, 'NASDAQ', 'USD', 'Stock', 'Current sector', 'Current industry', '2020-01-01', NULL, 1000, 'fixture')`,
    [ticker, ticker === 'AAPL' ? 'Apple' : 'Microsoft', ticker === 'AAPL' ? 1 : 0],
  )
  await execRun(
    `INSERT INTO market_classifications (
       market, ticker, taxonomy, effective_from, sector_name, industry_code,
       industry_name, source
     ) VALUES ('US', ?, 'US_SEC_SIC', '0000-01-01', 'Technology', '3571', 'Computers', 'fixture')`,
    [ticker],
  )
  for (const [date, close] of [['2025-01-03', 100], ['2026-01-02', 120]] as const) {
    await execRun(
      `INSERT INTO market_ohlcv_daily (
         market, ticker, date, open, high, low, close, volume,
         adj_open, adj_high, adj_low, adj_close, adj_volume, source
       ) VALUES ('US', ?, ?, ?, ?, ?, ?, 1000000, ?, ?, ?, ?, 1000000, 'fixture')`,
      [ticker, date, close, close, close, close, close, close, close, close],
    )
    await execRun(
      `INSERT INTO market_daily_snapshots (
         market, ticker, date, daily_a_stage, daily_b_stage, weekly_a_stage,
         weekly_b_stage, monthly_a_stage, monthly_b_stage, prev_close,
         close_5d, close_20d, close_60d, close_120d, avg_volume_20,
         ma_200, ma_200_prev, ma_200_observations
       ) VALUES ('US', ?, ?, 1, 2, 3, 4, 5, 6, ?, ?, ?, ?, ?, 1000000, ?, ?, 200)`,
      [ticker, date, close - 1, close - 5, close - 20, close - 30, close - 40, close - 10, close - 11],
    )
    await execRun(
      `INSERT INTO physical_momentum_metrics (
         market, symbol, date, acceleration, force, physical_momentum_score,
         physical_force_score, physical_energy_score
       ) VALUES ('US', ?, ?, 0.2, 0.3, 0.4, 0.5, 0.6)`,
      [ticker, date],
    )
  }
}

await execRun(
  `INSERT INTO market_earnings_calendar (
     market, ticker, report_date, hour, time_bucket, source, imported_at
   ) VALUES ('US', 'AAPL', '2025-02-01', 'amc', 'after_close', 'fixture', ?)`,
  [Math.floor(Date.parse('2024-12-20T12:00:00Z') / 1000)],
)
await execRun(
  `INSERT INTO market_earnings_calendar (
     market, ticker, report_date, hour, time_bucket, source, imported_at
   ) VALUES ('US', 'MSFT', '2025-02-02', 'amc', 'after_close', 'fixture', ?)`,
  [Math.floor(Date.parse('2025-03-01T12:00:00Z') / 1000)],
)

async function request(query: string) {
  const response = await GET(new NextRequest(`http://local.test/api/us/screener?${query}`))
  return { response, data: await response.json() as Record<string, any> }
}

const latest = await request('limit=10&quality=all')
assert.equal(latest.response.status, 200)
assert.equal(latest.data.date, '2026-01-02')
assert.equal(latest.data.pit.mode, 'LATEST')
assert.equal(latest.data.rows.length, 1)
assert.equal(latest.data.rows[0].ticker, 'AAPL')
assert.equal(latest.data.rows[0].market_cap, 120_000)
assert.equal(latest.data.rows[0].sector, 'Technology')

const historical = await request('date=2025-01-04&limit=10&quality=all')
assert.equal(historical.response.status, 200)
assert.equal(historical.data.date, '2025-01-03')
assert.equal(historical.data.pit.mode, 'HISTORICAL')
assert.deepEqual(historical.data.rows.map((row: { ticker: string }) => row.ticker), ['AAPL', 'MSFT'])
for (const row of historical.data.rows) {
  assert.equal(row.market_cap, null)
  assert.equal(row.sector, null)
  assert.equal(row.industry, null)
}
assert.equal(historical.data.rows.find((row: { ticker: string }) => row.ticker === 'AAPL').next_earnings_date, '2025-02-01')
assert.equal(historical.data.rows.find((row: { ticker: string }) => row.ticker === 'MSFT').next_earnings_date, null)

const blockedMarketCap = await request('date=2025-01-03&marketCapMin=1')
assert.equal(blockedMarketCap.response.status, 422)
const blockedSector = await request('date=2025-01-03&sector=Technology')
assert.equal(blockedSector.response.status, 422)
const invalidDate = await request('date=2025%2F01%2F03')
assert.equal(invalidDate.response.status, 400)
const impossibleDate = await request('date=2025-02-30')
assert.equal(impossibleDate.response.status, 400)
const beforeCoverage = await request('date=2019-12-31')
assert.equal(beforeCoverage.response.status, 200)
assert.equal(beforeCoverage.data.date, null)
assert.equal(beforeCoverage.data.rows.length, 0)

console.log('US screener API PIT integration tests: ok')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
