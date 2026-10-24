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

  async function request(limit: number, sort: string) {
    const response = await GET(new NextRequest(
      `http://local.test/api/backtest/query?date=${date}&horizon=40&limit=${limit}&sort=${sort}`,
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

  console.log('JP backtest full-predicate summary and stable sort tests: ok')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
}).finally(() => {
  fs.rmSync(runtimeDir, { recursive: true, force: true })
})
