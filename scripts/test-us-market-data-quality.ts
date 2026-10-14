import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClient } from '@libsql/client'
import {
  US_ACCEPTED_OBSERVED_PRICE_EVENTS,
  US_ANALYTICAL_PRICE_ROW_EXCLUSIONS,
  isUsAnalyticalPriceRowEligible,
  usAnalyticsPriceIneligibleSql,
  usSourceAnalyticalPriceEligibleSql,
} from '@/lib/us-market-data-quality'

assert.equal(US_ANALYTICAL_PRICE_ROW_EXCLUSIONS.length, 1)
assert.deepEqual(
  US_ANALYTICAL_PRICE_ROW_EXCLUSIONS[0],
  {
    ticker: 'QMMM',
    startDate: '2025-09-29',
    reason: 'OFFICIAL_TRADING_HALT_ZERO_VOLUME',
    authority: 'NASDAQ',
    authorityUrl: 'https://ir.nasdaq.com/news-releases/news-release-details/nasdaq-halts-qmmm-holdings-limited',
  },
)
assert.equal(US_ACCEPTED_OBSERVED_PRICE_EVENTS[0]?.ticker, 'RGC')
assert.equal(US_ACCEPTED_OBSERVED_PRICE_EVENTS[0]?.date, '2025-06-16')

assert.equal(isUsAnalyticalPriceRowEligible({ ticker: 'QMMM', date: '2025-09-26', volume: 1 }), true)
assert.equal(isUsAnalyticalPriceRowEligible({ ticker: 'QMMM', date: '2025-09-29', volume: 0 }), false)
assert.equal(isUsAnalyticalPriceRowEligible({ ticker: 'QMMM', date: '2026-10-13', volume: 0 }), false)
assert.equal(isUsAnalyticalPriceRowEligible({ ticker: 'QMMM', date: '2026-10-14', volume: 10 }), true)
assert.equal(isUsAnalyticalPriceRowEligible({ ticker: 'RGC', date: '2025-06-16', volume: 4_945_431 }), true)
assert.equal(isUsAnalyticalPriceRowEligible({ ticker: 'THIN', date: '2026-10-13', volume: 0 }), true)
assert.throws(() => usSourceAnalyticalPriceEligibleSql('m; DELETE'), /Unsafe US market-data SQL alias/)
assert.doesNotMatch(usAnalyticsPriceIneligibleSql('ohlcv_daily'), /NOT/)

async function main(): Promise<void> {
  const client = createClient({ url: ':memory:' })
  await client.execute(`CREATE TABLE market_ohlcv_daily (
    ticker TEXT NOT NULL,
    date TEXT NOT NULL,
    volume INTEGER,
    adj_volume INTEGER
  )`)
  await client.batch([
    { sql: `INSERT INTO market_ohlcv_daily VALUES ('RGC', '2025-06-16', 4945431, 4945431)`, args: [] },
    { sql: `INSERT INTO market_ohlcv_daily VALUES ('QMMM', '2025-09-26', 1200, 1200)`, args: [] },
    { sql: `INSERT INTO market_ohlcv_daily VALUES ('QMMM', '2025-09-29', 0, 0)`, args: [] },
    { sql: `INSERT INTO market_ohlcv_daily VALUES ('QMMM', '2026-10-13', 0, 0)`, args: [] },
    { sql: `INSERT INTO market_ohlcv_daily VALUES ('QMMM', '2026-10-14', 100, 100)`, args: [] },
    { sql: `INSERT INTO market_ohlcv_daily VALUES ('THIN', '2026-10-13', 0, 0)`, args: [] },
  ], 'write')
  const eligible = await client.execute(`
    SELECT ticker, date
    FROM market_ohlcv_daily m
    WHERE ${usSourceAnalyticalPriceEligibleSql('m')}
    ORDER BY ticker, date
  `)
  assert.deepEqual(
    eligible.rows.map((row) => `${String(row.ticker)}:${String(row.date)}`),
    [
      'QMMM:2025-09-26',
      'QMMM:2026-10-14',
      'RGC:2025-06-16',
      'THIN:2026-10-13',
    ],
  )
  client.close()

  const builder = readFileSync('scripts/build-us-analytics-db.ts', 'utf8')
  assert.match(builder, /SOURCE_PRICE_ELIGIBLE_SQL/)
  assert.match(builder, /SOURCE_SNAPSHOT_PRICE_ELIGIBLE_SQL/)
  assert.match(builder, /pruneIneligibleAnalyticalRows/)
  assert.match(builder, /await pruneIneligibleAnalyticalRows\(target\)/)
  const maintenance = readFileSync('scripts/apply-us-market-data-quality-policy.ts', 'utf8')
  assert.doesNotMatch(maintenance, /UPPER\(ticker\)/)

  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'stockboard-us-source-quality-'))
  try {
    const sourcePath = path.join(temporaryDirectory, 'source.db')
    const targetPath = path.join(temporaryDirectory, 'analytics.db')
    const source = createClient({ url: `file:${sourcePath}` })
    await source.execute(`CREATE TABLE market_universe (
      market TEXT NOT NULL, ticker TEXT NOT NULL, name TEXT, active INTEGER NOT NULL,
      exchange TEXT, sector TEXT, industry TEXT, shares_outstanding INTEGER,
      PRIMARY KEY (market, ticker)
    )`)
    await source.execute(`CREATE TABLE market_classifications (
      market TEXT NOT NULL, ticker TEXT NOT NULL, taxonomy TEXT NOT NULL,
      effective_from TEXT NOT NULL, sector_name TEXT, industry_name TEXT
    )`)
    await source.execute(`CREATE TABLE market_ohlcv_daily (
      market TEXT NOT NULL, ticker TEXT NOT NULL, date TEXT NOT NULL,
      open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL,
      adj_open REAL, adj_high REAL, adj_low REAL, adj_close REAL,
      volume INTEGER NOT NULL, adj_volume INTEGER, split_factor REAL,
      PRIMARY KEY (market, ticker, date)
    )`)
    await source.execute(`CREATE INDEX market_ohlcv_market_ticker_date_idx
      ON market_ohlcv_daily(market, ticker, date)`)
    await source.execute(`CREATE TABLE market_daily_snapshots (
      market TEXT NOT NULL, ticker TEXT NOT NULL, date TEXT NOT NULL,
      ma_5 REAL, ma_25 REAL, ma_75 REAL, ma_150 REAL, ma_300 REAL,
      weekly_ma_5 REAL, weekly_ma_13 REAL, weekly_ma_25 REAL, weekly_ma_50 REAL, weekly_ma_100 REAL,
      monthly_ma_3 REAL, monthly_ma_5 REAL, monthly_ma_10 REAL, monthly_ma_20 REAL, monthly_ma_25 REAL,
      daily_a_stage INTEGER, daily_b_stage INTEGER, weekly_a_stage INTEGER, weekly_b_stage INTEGER,
      monthly_a_stage INTEGER, monthly_b_stage INTEGER,
      PRIMARY KEY (market, ticker, date)
    )`)
    await source.execute(`CREATE TABLE update_locks (
      job_type TEXT, status TEXT, lease_expires_at INTEGER
    )`)
    await source.batch([
      ...[['RGC', 'Regencell'], ['QMMM', 'QMMM'], ['THIN', 'Thin Co']].map(([ticker, name]) => ({
        sql: `INSERT INTO market_universe VALUES ('US', ?, ?, 1, 'NASDAQ', NULL, NULL, NULL)`,
        args: [ticker, name],
      })),
      ...[
        ['RGC', '2025-06-13', 595.1, 15.6605263158, 15316, 403],
        ['RGC', '2025-06-16', 60, 60, 4945431, 38],
        ['QMMM', '2025-09-26', 119.4, 119.4, 1000, 1],
        ['QMMM', '2025-09-29', 119.4, 119.4, 0, 1],
        ['QMMM', '2026-10-13', 119.4, 119.4, 0, 1],
        ['QMMM', '2026-10-14', 120, 120, 100, 1],
        ['THIN', '2026-10-13', 5, 5, 0, 1],
      ].map(([ticker, date, close, adjustedClose, volume, splitFactor]) => ({
        sql: `INSERT INTO market_ohlcv_daily
          (market, ticker, date, open, high, low, close, adj_open, adj_high, adj_low, adj_close,
           volume, adj_volume, split_factor)
          VALUES ('US', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [ticker, date, close, close, close, close, adjustedClose, adjustedClose, adjustedClose,
          adjustedClose, volume, volume, splitFactor],
      })),
    ], 'write')
    const sourcePrices = await source.execute(`SELECT ticker, date FROM market_ohlcv_daily`)
    await source.batch(sourcePrices.rows.map((row) => ({
      sql: `INSERT INTO market_daily_snapshots (market, ticker, date, daily_a_stage)
            VALUES ('US', ?, ?, 1)`,
      args: [String(row.ticker), String(row.date)],
    })), 'write')
    source.close()

    const result = spawnSync('npm', ['exec', '--', 'tsx', 'scripts/build-us-analytics-db.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TURSO_DATABASE_URL: '',
        TURSO_AUTH_TOKEN: '',
        USE_LOCAL_DB: '1',
        EXTERNAL_STORAGE_REQUIRED: 'false',
        STOCKBOARD_DB_PATH: sourcePath,
        US_ANALYTICS_DB_PATH: targetPath,
        US_ANALYTICS_LIMIT: '3',
        US_ANALYTICS_NATIVE_COPY: '1',
        US_ANALYTICS_ALLOW_LOCAL: '1',
      },
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)

    const target = createClient({ url: `file:${targetPath}` })
    const copiedPrices = await target.execute(`SELECT ticker, date FROM ohlcv_daily ORDER BY ticker, date`)
    assert.deepEqual(copiedPrices.rows.map((row) => `${row.ticker}:${row.date}`), [
      'QMMM:2025-09-26',
      'QMMM:2026-10-14',
      'RGC:2025-06-13',
      'RGC:2025-06-16',
      'THIN:2026-10-13',
    ])
    const copiedSnapshots = await target.execute(`SELECT ticker, date FROM daily_snapshots ORDER BY ticker, date`)
    assert.deepEqual(copiedSnapshots.rows.map((row) => `${row.ticker}:${row.date}`), [
      'QMMM:2025-09-26',
      'QMMM:2026-10-14',
      'RGC:2025-06-13',
      'RGC:2025-06-16',
      'THIN:2026-10-13',
    ])
    await target.batch([
      {
        sql: `INSERT INTO forward_returns
          (ticker, date, horizon_days, return_pct, return_category, end_date)
          VALUES ('QMMM', '2025-09-26', 5, 0, 'flat', '2025-10-03')`,
        args: [],
      },
      {
        sql: `INSERT INTO forward_returns
          (ticker, date, horizon_days, return_pct, return_category, end_date)
          VALUES ('RGC', '2025-06-16', 5, 10, 'up', '2025-06-23')`,
        args: [],
      },
    ], 'write')
    target.close()

    const maintenanceEnv = {
      ...process.env,
      TURSO_DATABASE_URL: '',
      TURSO_AUTH_TOKEN: '',
      USE_LOCAL_DB: '1',
      EXTERNAL_STORAGE_REQUIRED: 'false',
      STOCKBOARD_DB_ROLE: 'us-analytics',
      STOCKBOARD_DB_PATH: targetPath,
      US_ANALYTICS_DB_PATH: targetPath,
      STOCKBOARD_SOURCE_DB_PATH: sourcePath,
      SKIP_SCHEMA_ENSURE: '1',
    }
    const dryRun = spawnSync('npm', ['exec', '--', 'tsx', 'scripts/apply-us-market-data-quality-policy.ts'], {
      cwd: process.cwd(), env: maintenanceEnv, encoding: 'utf8', timeout: 120_000,
    })
    assert.equal(dryRun.status, 0, `${dryRun.stdout}\n${dryRun.stderr}`)
    assert.match(dryRun.stdout, /"mode": "DRY_RUN"/)
    assert.match(dryRun.stdout, /"forward_returns": 1/)

    const apply = spawnSync('npm', [
      'exec', '--', 'tsx', 'scripts/apply-us-market-data-quality-policy.ts', '--apply',
    ], {
      cwd: process.cwd(), env: maintenanceEnv, encoding: 'utf8', timeout: 120_000,
    })
    assert.equal(apply.status, 0, `${apply.stdout}\n${apply.stderr}`)
    assert.match(apply.stdout, /US market-data quality policy applied/)

    const verifiedTarget = createClient({ url: `file:${targetPath}` })
    const remainingReturns = await verifiedTarget.execute(
      `SELECT ticker FROM forward_returns ORDER BY ticker`,
    )
    assert.deepEqual(remainingReturns.rows.map((row) => String(row.ticker)), ['RGC'])
    const policy = await verifiedTarget.execute(
      `SELECT value FROM us_analytics_metadata WHERE key = 'market_data_quality_policy'`,
    )
    assert.equal(String(policy.rows[0]?.value), 'us_market_data_quality_v1')
    verifiedTarget.close()

    const verifiedSource = createClient({ url: `file:${sourcePath}` })
    const rawCount = await verifiedSource.execute(`SELECT COUNT(*) AS count FROM market_ohlcv_daily`)
    assert.equal(Number(rawCount.rows[0]?.count), 7)
    verifiedSource.close()
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true })
  }

  console.log('US market data quality policy tests PASS')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
