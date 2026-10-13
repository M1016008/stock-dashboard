import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClient } from '@libsql/client'
import { NextRequest } from 'next/server'

const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockboard-us-backtest-'))
const dbPath = path.join(runtimeDir, 'us-backtest.db')
Object.assign(process.env, {
  NODE_ENV: 'test',
  EXTERNAL_STORAGE_REQUIRED: 'false',
  US_ANALYTICS_DB_PATH: dbPath,
})

const db = createClient({ url: `file:${dbPath}` })
const insertResult = `INSERT INTO serving_backtest_results VALUES (
  ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
)`

async function setup() {
  await db.batch([
    `CREATE TABLE serving_backtest_dates (date TEXT PRIMARY KEY, total_tickers INTEGER NOT NULL, signal_tickers INTEGER NOT NULL, computed_at INTEGER NOT NULL)`,
    `CREATE TABLE serving_backtest_results (
      date TEXT NOT NULL, horizon_days INTEGER NOT NULL, ticker TEXT NOT NULL, name TEXT, pattern_code TEXT,
      daily_a_stage INTEGER, daily_b_stage INTEGER, weekly_a_stage INTEGER, weekly_b_stage INTEGER,
      monthly_a_stage INTEGER, monthly_b_stage INTEGER, close REAL, volume_ratio_20 REAL, range_pct REAL,
      atr20_pct REAL, ma5_pos_pct REAL, ma25_pos_pct REAL, ma75_pos_pct REAL, signal_codes TEXT,
      return_pct REAL, max_return_pct REAL, max_return_date TEXT, days_to_max INTEGER,
      min_return_pct REAL, min_return_date TEXT, days_to_min INTEGER, hit_10 INTEGER, hit_20 INTEGER, hit_40 INTEGER,
      PRIMARY KEY (date, horizon_days, ticker)
    )`,
    `CREATE INDEX serving_backtest_results_horizon_date_idx ON serving_backtest_results(horizon_days, date DESC)`,
    `CREATE TABLE serving_signal_evidence (ticker TEXT, date TEXT, signal_code TEXT, label TEXT, reason_json TEXT, PRIMARY KEY (ticker, date, signal_code))`,
    `CREATE TABLE model_features (ticker TEXT, date TEXT, pattern_code TEXT, PRIMARY KEY (ticker, date))`,
    `CREATE TABLE ohlcv_daily (ticker TEXT, date TEXT, close REAL, PRIMARY KEY (ticker, date))`,
    `CREATE INDEX ohlcv_date_idx ON ohlcv_daily(date)`,
  ])
  await db.batch([
    { sql: `INSERT INTO serving_backtest_dates VALUES (?, ?, ?, ?)`, args: ['2026-01-01', 1, 1, 1] },
    { sql: `INSERT INTO serving_backtest_dates VALUES (?, ?, ?, ?)`, args: ['2026-01-02', 3, 2, 1] },
    { sql: `INSERT INTO serving_backtest_dates VALUES (?, ?, ?, ?)`, args: ['2026-01-05', 3, 2, 1] },
  ])
  await db.batch([
    { sql: insertResult, args: ['2026-01-01', 5, 'HOL', 'Holiday row', '111111', 1, 1, 1, 1, 1, 1, 10, 1, 1, 1, 1, 1, 1, 'MA_UP', 1, 2, '2026-01-02', 1, -1, '2026-01-02', 1, 0, 0, 0] },
    { sql: insertResult, args: ['2026-01-02', 5, 'AAPL', 'Apple', '111111', 1, 1, 1, 1, 1, 1, 100, 1.2, 2, 1.5, 3, 5, 8, 'MA_UP,BREAKOUT', 0, 12, '2026-01-09', 5, -3, '2026-01-06', 2, 1, 0, 0] },
    { sql: insertResult, args: ['2026-01-02', 5, 'TSLA', 'Tesla', '212233', 2, 1, 2, 2, 3, 3, 200, 2.1, 5, 4, -2, 1, 6, 'BREAKOUT', -4, 8, '2026-01-08', 4, -11, '2026-01-07', 3, 0, 0, 0] },
    { sql: insertResult, args: ['2026-01-02', 5, 'PFE', 'Pfizer', null, null, null, null, null, null, null, 25, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null] },
    { sql: insertResult, args: ['2026-01-05', 5, 'AAPL', 'Apple', '111111', 1, 1, 1, 1, 1, 1, 102, 1.1, 2, 1.4, 3, 5, 8, 'MA_UP', 4, 15, '2026-01-12', 5, -2, '2026-01-06', 1, 1, 0, 0] },
    { sql: insertResult, args: ['2026-01-02', 20, 'AAPL', 'Apple', '111111', 1, 1, 1, 1, 1, 1, 100, 1.2, 2, 1.5, 3, 5, 8, 'MA_UP', 8, 25, '2026-02-02', 20, -5, '2026-01-12', 6, 1, 1, 0] },
  ])
  await db.batch([
    { sql: `INSERT INTO serving_signal_evidence VALUES (?, ?, ?, ?, ?)`, args: ['AAPL', '2026-01-02', 'MA_UP', 'MA上向き', JSON.stringify({ basis: 'fixture' })] },
    { sql: `INSERT INTO model_features VALUES (?, ?, ?)`, args: ['AAPL', '2025-12-30', '211111'] },
    { sql: `INSERT INTO model_features VALUES (?, ?, ?)`, args: ['AAPL', '2026-01-02', '111111'] },
    { sql: `INSERT INTO model_features VALUES (?, ?, ?)`, args: ['AAPL', '2026-01-09', '111111'] },
    { sql: `INSERT INTO ohlcv_daily VALUES (?, ?, ?)`, args: ['AAPL', '2025-12-30', 98] },
    { sql: `INSERT INTO ohlcv_daily VALUES (?, ?, ?)`, args: ['AAPL', '2026-01-02', 100] },
    { sql: `INSERT INTO ohlcv_daily VALUES (?, ?, ?)`, args: ['AAPL', '2026-01-09', 112] },
  ])
}

async function main() {
  await setup()
  const {
    getUsBacktestDates,
    getUsBacktestDetail,
    isIsoDate,
    queryUsBacktest,
  } = await import('@/lib/server/us-backtest')
  const executor = {
    all: async <T>(sql: string, args: readonly unknown[] = []) => {
      const result = await db.execute({ sql, args: args as never[] })
      return result.rows.map((row) => ({ ...row })) as T[]
    },
    get: async <T>(sql: string, args: readonly unknown[] = []) => {
      const result = await db.execute({ sql, args: args as never[] })
      return result.rows[0] ? ({ ...result.rows[0] } as T) : undefined
    },
  }

  assert.equal(isIsoDate('2026-01-02'), true)
  assert.equal(isIsoDate('2026-02-30'), false)

  const dates = await getUsBacktestDates(5, executor)
  assert.deepEqual(dates.dates.map((row) => row.date), ['2026-01-05', '2026-01-02'])
  assert.equal(dates.coverage.firstOutcomeDate, '2026-01-02')
  assert.equal(dates.coverage.latestOutcomeDate, '2026-01-05')
  assert.equal(dates.coverage.marketLatestDate, '2026-01-09')
  assert.equal(dates.coverage.classificationAvailability, 'OMITTED_HISTORICAL_PIT_UNAVAILABLE')
  assert.equal(dates.coverage.availableDates, 2, 'regular-session coverage must exclude US exchange holidays')

  const latest = await queryUsBacktest({ horizon: 5 }, executor)
  assert.equal(latest.date, '2026-01-05')
  assert.equal(latest.results[0]?.ticker, 'AAPL')

  await db.execute({
    sql: insertResult,
    args: ['2026-07-03', 5, 'HOL2', 'Latest holiday row', '111111', 1, 1, 1, 1, 1, 1, 10, 1, 1, 1, 1, 1, 1, 'MA_UP', 1, 2, '2026-07-06', 1, -1, '2026-07-06', 1, 0, 0, 0],
  })
  const latestWithHoliday = await queryUsBacktest({ horizon: 5 }, executor)
  assert.equal(latestWithHoliday.date, '2026-01-05', 'implicit latest date must skip US exchange holidays')

  const query = await queryUsBacktest({ date: '2026-01-02', horizon: 5, sort: 'ticker' }, executor)
  assert.equal(query.summary.count, 3)
  assert.equal(query.summary.withOutcome, 2)
  assert.equal(query.results[0]?.returnPct, 0, 'observed zero must remain zero')
  assert.equal(query.results[0]?.stages.join(''), '111111')
  assert.equal(query.results[1]?.maxReturnPct, null, 'missing outcome must remain unavailable')

  const maxSorted = await queryUsBacktest({ date: '2026-01-02', horizon: 5, sort: 'maxReturn' }, executor)
  assert.deepEqual(maxSorted.results.map((row) => row.ticker), ['AAPL', 'TSLA', 'PFE'], 'missing outcomes sort last')
  const minSorted = await queryUsBacktest({ date: '2026-01-02', horizon: 5, sort: 'minReturn' }, executor)
  assert.deepEqual(minSorted.results.map((row) => row.ticker), ['TSLA', 'AAPL', 'PFE'], 'missing drawdowns sort last')

  const target = await queryUsBacktest({ date: '2026-01-02', horizon: 5, targetPct: 10 }, executor)
  assert.deepEqual(target.results.map((row) => row.ticker), ['AAPL'])
  const stage = await queryUsBacktest({ date: '2026-01-02', horizon: 5, stageCode: '212233' }, executor)
  assert.deepEqual(stage.results.map((row) => row.ticker), ['TSLA'])
  const signal = await queryUsBacktest({ date: '2026-01-02', horizon: 5, signal: 'MA_UP' }, executor)
  assert.deepEqual(signal.results.map((row) => row.ticker), ['AAPL'])
  const negative = await queryUsBacktest({ date: '2026-01-02', horizon: 5, returnMetric: 'min', returnMax: -10 }, executor)
  assert.deepEqual(negative.results.map((row) => row.ticker), ['TSLA'])

  const detail = await getUsBacktestDetail({ ticker: 'AAPL', date: '2026-01-02', horizon: 5, move: 'up' }, executor)
  assert.equal(detail?.selectedOutcome.returnPct, 12)
  assert.equal(detail?.generatedNarrative, false)
  assert.deepEqual(detail?.chart.map((row) => row.date), ['2025-12-30', '2026-01-02', '2026-01-09'])
  assert.equal(detail?.evidence[0]?.signalCode, 'MA_UP')

  const { GET: queryRoute } = await import('@/app/api/us/backtest/query/route')
  const blocked = await queryRoute(new NextRequest('http://local.test/api/us/backtest/query?horizon=5&date=2026-01-02&sector=Technology'))
  assert.equal(blocked.status, 422)
  const invalid = await queryRoute(new NextRequest('http://local.test/api/us/backtest/query?horizon=5&date=2026-02-30'))
  assert.equal(invalid.status, 400)
  const holiday = await queryRoute(new NextRequest('http://local.test/api/us/backtest/query?horizon=5&date=2026-01-01'))
  assert.equal(holiday.status, 400)
  assert.equal((await holiday.json()).error, 'non_trading_date')

  const { GET: detailRoute } = await import('@/app/api/us/backtest/detail/route')
  const holidayDetail = await detailRoute(new NextRequest('http://local.test/api/us/backtest/detail?ticker=HOL&horizon=5&date=2026-01-01'))
  assert.equal(holidayDetail.status, 400)
  assert.equal((await holidayDetail.json()).error, 'non_trading_date')

  console.log('US backtest PIT and API tests: ok')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
}).finally(async () => {
  db.close()
})
