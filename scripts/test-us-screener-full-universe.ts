import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { NextRequest } from 'next/server'

const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockboard-us-screener-universe-'))
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
  const date = '2026-01-02'

  await execRun(`
    WITH RECURSIVE seq(n) AS (
      SELECT 1
      UNION ALL
      SELECT n + 1 FROM seq WHERE n < 5001
    )
    INSERT INTO market_universe (
      market, ticker, name, active, exchange, currency, asset_type,
      sector, industry, start_date, shares_outstanding, source
    )
    SELECT 'US', printf('S%05d', n), printf('Synthetic %05d', n), 1,
      'NASDAQ', 'USD', 'Stock', 'Synthetic', 'Synthetic', '2020-01-01', 1000, 'fixture'
    FROM seq
  `)
  await execRun(`
    WITH RECURSIVE seq(n) AS (
      SELECT 1
      UNION ALL
      SELECT n + 1 FROM seq WHERE n < 5001
    )
    INSERT INTO market_ohlcv_daily (
      market, ticker, date, open, high, low, close, volume,
      adj_open, adj_high, adj_low, adj_close, adj_volume, source
    )
    SELECT 'US', printf('S%05d', n), ?, 100, 101, 99, 100, 1000000,
      100, 101, 99, 100, 1000000, 'fixture'
    FROM seq
  `, [date])
  await execRun(`
    WITH RECURSIVE seq(n) AS (
      SELECT 1
      UNION ALL
      SELECT n + 1 FROM seq WHERE n < 5001
    )
    INSERT INTO market_daily_snapshots (
      market, ticker, date, daily_a_stage, daily_b_stage, weekly_a_stage,
      weekly_b_stage, monthly_a_stage, monthly_b_stage, prev_close,
      close_5d, close_20d, close_60d, close_120d, avg_volume_20,
      ma_200, ma_200_prev, ma_200_observations
    )
    SELECT 'US', printf('S%05d', n), ?, CASE WHEN n = 5001 THEN 2 ELSE 1 END,
      1, 1, 1, 1, 1, 99, 95, 90, 80, 70, 1000000, 90, 89, 200
    FROM seq
  `, [date])
  await execRun(`
    WITH RECURSIVE seq(n) AS (
      SELECT 1
      UNION ALL
      SELECT n + 1 FROM seq WHERE n < 5001
    )
    INSERT INTO physical_momentum_metrics (
      market, symbol, date, acceleration, force, physical_momentum_score,
      physical_force_score, physical_energy_score
    )
    SELECT 'US', printf('S%05d', n), ?,
      CASE WHEN n = 5001 THEN 1 ELSE -1 END,
      CASE WHEN n = 5001 THEN 1 ELSE -1 END,
      CASE WHEN n = 5001 THEN 10 ELSE -10 END,
      CASE WHEN n = 5001 THEN 10 ELSE -10 END,
      CASE WHEN n = 5001 THEN 10 ELSE -10 END
    FROM seq
  `, [date])

  async function request(params: Record<string, string>) {
    const search = new URLSearchParams({ date, quality: 'all', limit: '10', ...params })
    const response = await GET(new NextRequest(`http://local.test/api/us/screener?${search}`))
    return { response, data: await response.json() as Record<string, any> }
  }

  const filters: Array<Record<string, string>> = [
    { pmsMin: '1' },
    { pfsMin: '1' },
    { pesMin: '1' },
    { accelerationPositive: '1' },
    { forcePositive: '1' },
    { stage23Candidate: '1' },
    { shortTermCheck: '強気優勢' },
    { physicalStatus: '上昇加速' },
  ]
  for (const filter of filters) {
    const { response, data } = await request(filter)
    assert.equal(response.status, 200)
    assert.deepEqual(data.rows.map((row: { ticker: string }) => row.ticker), ['S05001'])
    assert.equal(data.hasMore, false, `hasMore must reflect all matches for ${JSON.stringify(filter)}`)
  }

  const sorted = await request({ sort: 'acceleration', dir: 'desc', limit: '1' })
  assert.equal(sorted.response.status, 200)
  assert.equal(sorted.data.rows[0]?.ticker, 'S05001')
  assert.equal(sorted.data.hasMore, true)

  console.log('US screener full-universe computed filter and sort tests: ok')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
}).finally(() => {
  fs.rmSync(runtimeDir, { recursive: true, force: true })
})
