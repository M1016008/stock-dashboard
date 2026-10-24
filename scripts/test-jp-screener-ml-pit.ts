import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { NextRequest } from 'next/server'

const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockboard-jp-screener-ml-pit-'))
Object.assign(process.env, {
  NODE_ENV: 'test',
  EXTERNAL_STORAGE_REQUIRED: 'false',
  USE_LOCAL_DB: '1',
  STOCKBOARD_DB_PATH: path.join(runtimeDir, 'stockboard.db'),
  SERVING_CACHE_DB_PATH: path.join(runtimeDir, 'serving-cache.db'),
  STOCK_DATA_INCIDENT_DIR: path.join(runtimeDir, 'incidents'),
})

async function main() {
  const { execRun } = await import('@/lib/db/client')
  const { GET } = await import('@/app/api/screener/route')
  const snapshotDate = '2025-01-03'

  await execRun(`INSERT INTO ticker_universe (ticker, name, active) VALUES ('7203', 'Synthetic Motor', 1)`)
  await execRun(
    `INSERT INTO ohlcv_daily (ticker, date, open, high, low, close, volume)
     VALUES ('7203', ?, 100, 101, 99, 100, 1000000)`,
    [snapshotDate],
  )
  await execRun(
    `INSERT INTO daily_snapshots (
       ticker, date, daily_a_stage, daily_b_stage, weekly_a_stage,
       weekly_b_stage, monthly_a_stage, monthly_b_stage
     ) VALUES ('7203', ?, 1, 1, 1, 1, 1, 1)`,
    [snapshotDate],
  )
  await execRun(
    `INSERT INTO serving_current_similars (
       as_of_date, base_ticker, rank, similar_ticker, similarity_score,
       similar_direction, payload_json, reason_json
     ) VALUES ('2024-12-31', '7203', 1, '1111', 0.91, 'up', '{}', '{}')`,
  )
  await execRun(
    `INSERT INTO serving_current_similars (
       as_of_date, base_ticker, rank, similar_ticker, similarity_score,
       similar_direction, payload_json, reason_json
     ) VALUES ('2025-02-01', '7203', 1, '2222', 0.99, 'down', '{}', '{}')`,
  )

  async function request() {
    const response = await GET(new NextRequest(`http://local.test/api/screener?date=${snapshotDate}&limit=10`))
    return { response, data: await response.json() as Record<string, any> }
  }

  const first = await request()
  assert.equal(first.response.status, 200)
  assert.equal(first.data.serverCache.mlSummarySourceDate, '2024-12-31')
  assert.equal(first.data.results[0]?.shortTermCheckMlText, '上昇1 / 下落0 / 最高類似91%')

  await execRun(
    `INSERT INTO serving_current_similars (
       as_of_date, base_ticker, rank, similar_ticker, similarity_score,
       similar_direction, payload_json, reason_json
     ) VALUES ('2025-01-02', '7203', 1, '3333', 0.95, 'down', '{}', '{}')`,
  )

  const afterBackfill = await request()
  assert.equal(afterBackfill.response.status, 200)
  assert.equal(afterBackfill.data.serverCache.hit, false, 'a changed PIT source date must use a new cache identity')
  assert.equal(afterBackfill.data.serverCache.mlSummarySourceDate, '2025-01-02')
  assert.equal(afterBackfill.data.results[0]?.shortTermCheckMlText, '上昇0 / 下落1 / 最高類似95%')

  console.log('JP screener ML PIT and cache identity tests: ok')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
}).finally(() => {
  fs.rmSync(runtimeDir, { recursive: true, force: true })
})
