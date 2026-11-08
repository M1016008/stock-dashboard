import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { NextRequest } from 'next/server'

const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockboard-jp-backtest-summary-'))
Object.assign(process.env, {
  NODE_ENV: 'test',
  EXTERNAL_STORAGE_REQUIRED: 'false',
  USE_LOCAL_DB: '1',
  STOCKBOARD_DB_PATH: path.join(runtimeDir, 'stockboard.db'),
})

async function main() {
  const { execBatch } = await import('@/lib/db/client')
  const { GET } = await import('@/app/api/backtest/query/route')
  const date = '2026-01-05'

  await execBatch(['B001', 'A001', 'C001'].map((ticker) => ({
    sql: `INSERT INTO ticker_universe (ticker, name, active) VALUES (?, ?, 1)`,
    args: [ticker, `Synthetic ${ticker}`],
  })))
  await execBatch([
    { ticker: 'B001', max: 10, min: -5, days: 3, hit10: 1 },
    { ticker: 'A001', max: 10, min: -3, days: 2, hit10: 1 },
    { ticker: 'C001', max: 5, min: -10, days: 4, hit10: 0 },
  ].map((row) => ({
    sql: `INSERT INTO serving_backtest_results (
      date, horizon_days, ticker, name, pattern_code,
      daily_a_stage, daily_b_stage, weekly_a_stage, weekly_b_stage,
      monthly_a_stage, monthly_b_stage, close, volume_ratio_20,
      return_pct, max_return_pct, days_to_max, min_return_pct,
      hit_10, hit_20, hit_40
    ) VALUES (?, 40, ?, ?, '111111', 1, 1, 1, 1, 1, 1, 100, 1, 1, ?, ?, ?, ?, 0, 0)`,
    args: [date, row.ticker, `Synthetic ${row.ticker}`, row.max, row.days, row.min, row.hit10],
  })))

  // serving 行が無い日付は model_features + forward_extrema の fallback 経路を通る。
  const fallbackDate = '2026-01-06'
  await execBatch([
    { ticker: 'A001', max: 4, min: -2, days: 1, hit10: 0 },
    { ticker: 'B001', max: 12, min: -6, days: 5, hit10: 1 },
  ].flatMap((row) => [
    { sql: `INSERT INTO model_features (ticker, date, pattern_code) VALUES (?, ?, '111111')`, args: [row.ticker, fallbackDate] },
    {
      sql: `INSERT INTO forward_extrema (ticker, date, horizon_days, return_pct, max_return_pct, days_to_max, min_return_pct, hit_10)
        VALUES (?, ?, 40, 1, ?, ?, ?, ?)`,
      args: [row.ticker, fallbackDate, row.max, row.days, row.min, row.hit10],
    },
  ]))
  await execBatch([{
    sql: `INSERT INTO sector_master (ticker, sector33, updated_at) VALUES ('B001', 'SyntheticSector33', '2026-01-01')`,
    args: [],
  }])

  async function request(limit: number, sort: string, requestDate = date, extra = '') {
    const response = await GET(new NextRequest(
      `http://local.test/api/backtest/query?date=${requestDate}&horizon=40&limit=${limit}&sort=${sort}${extra}`,
    ))
    assert.equal(response.status, 200)
    return response.json() as Promise<Record<string, any>>
  }

  const first = await request(1, 'maxReturn')
  assert.deepEqual(first.results.map((row: { ticker: string }) => row.ticker), ['A001'], 'ties must use ticker order')
  assert.equal(first.summary.count, 3)
  assert.equal(first.summary.withOutcome, 3)

  const second = await request(2, 'drawdown')
  assert.deepEqual(second.summary, first.summary, 'summary must be invariant to result limit and sort')
  assert.equal(first.summary.hit10Rate, 2 / 3)
  assert.equal(first.summary.avgMaxReturnPct, 25 / 3)
  assert.equal(first.summary.avgMinReturnPct, -6)
  assert.equal(first.summary.avgDaysToMax, 3)
  assert.equal(first.source, 'serving_backtest_results')

  const fallback = await request(300, 'maxReturn', fallbackDate)
  assert.equal('source' in fallback, false, 'fallback response must not carry source')
  assert.deepEqual(fallback.results.map((row: { ticker: string }) => row.ticker), ['B001', 'A001'], 'fallback must sort by max return, not ticker')
  assert.deepEqual(fallback.summary, {
    count: 2,
    withOutcome: 2,
    hit10Rate: 0.5,
    hit20Rate: 0,
    hit40Rate: 0,
    avgMaxReturnPct: 8,
    avgMinReturnPct: -4,
    avgDaysToMax: 3,
  })

  const fallbackSector = await request(300, 'maxReturn', fallbackDate, '&sector=SyntheticSector33')
  assert.deepEqual(fallbackSector.results.map((row: { ticker: string }) => row.ticker), ['B001'], 'fallback sector filter must match sm.sector33')
  assert.equal(fallbackSector.summary.count, 1)

  console.log('JP backtest full-predicate summary and stable sort tests: ok')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
}).finally(() => {
  fs.rmSync(runtimeDir, { recursive: true, force: true })
})
