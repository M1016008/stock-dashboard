import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createClient } from '@libsql/client'

async function main(): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'stockboard-two-year-search-'))
  const databasePath = path.join(directory, 'fixture.db')
  const fixtureClient = createClient({ url: `file:${databasePath}` })

  try {
  await fixtureClient.batch([
    { sql: `CREATE TABLE ohlcv_daily (
      ticker TEXT NOT NULL, date TEXT NOT NULL, open REAL NOT NULL, high REAL NOT NULL,
      low REAL NOT NULL, close REAL NOT NULL, volume INTEGER NOT NULL,
      PRIMARY KEY (ticker, date)
    )` },
    { sql: 'CREATE INDEX ohlcv_date_ticker_idx ON ohlcv_daily(date, ticker)' },
    { sql: `CREATE TABLE market_ohlcv_daily (
      market TEXT NOT NULL, ticker TEXT NOT NULL, date TEXT NOT NULL,
      open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL, volume INTEGER NOT NULL,
      adj_open REAL, adj_high REAL, adj_low REAL, adj_close REAL, adj_volume REAL,
      PRIMARY KEY (market, ticker, date)
    )` },
    { sql: `CREATE INDEX market_ohlcv_market_date_ticker_idx
      ON market_ohlcv_daily(market, date, ticker)` },
    { sql: `CREATE TABLE dashboard_trade_signal_cache (
      cache_key TEXT PRIMARY KEY, payload_json TEXT NOT NULL, computed_at INTEGER NOT NULL
    )` },
    { sql: `CREATE TABLE batch_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, job_type TEXT NOT NULL, started_at INTEGER NOT NULL,
      finished_at INTEGER, status TEXT NOT NULL, total_tickers INTEGER, succeeded INTEGER DEFAULT 0,
      failed INTEGER DEFAULT 0, rows_inserted INTEGER DEFAULT 0, error_summary TEXT
    )` },
    { sql: `CREATE TABLE market_data_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, market TEXT NOT NULL, job_type TEXT NOT NULL,
      status TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER,
      total_tickers INTEGER NOT NULL DEFAULT 0, succeeded INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0, rows_inserted INTEGER NOT NULL DEFAULT 0,
      error_summary TEXT, payload_json TEXT NOT NULL DEFAULT '{}'
    )` },
    { sql: `INSERT INTO batch_runs (job_type, started_at, finished_at, status)
      VALUES ('ohlcv_fetch:jquants', 1, 2, 'success')` },
    { sql: `INSERT INTO market_data_runs (market, job_type, status, started_at, finished_at)
      VALUES ('US', 'tiingo_ohlcv', 'success', 1, 2)` },
  ])

  const blocks = [
    { startYear: 2014, open: 100, close: 90 },
    { startYear: 2016, open: 90, close: 110 },
    { startYear: 2018, open: 110, close: 130 },
    { startYear: 2020, open: 130, close: 120 },
    { startYear: 2022, open: 120, close: 132 },
    { startYear: 2024, open: 132, close: 154 },
    { startYear: 2026, open: 154, close: 176 },
  ]
  const statements: Array<{ sql: string; args: Array<string | number | null> }> = []
  const fourCandleBlocks = new Map<number, readonly [number, number]>([
    [2018, [100, 90]],
    [2020, [90, 110]],
    [2022, [110, 130]],
    [2024, [130, 150]],
    [2026, [150, 140]],
  ])
  for (const block of blocks) {
    const sessions = [`${block.startYear}-01-03`, `${block.startYear + 1}-12-30`]
    for (const [index, date] of sessions.entries()) {
      const open = index === 0 ? block.open : block.close
      const close = index === 0 ? block.open : block.close
      for (const ticker of ['1306', 'JP-LINE']) {
        statements.push({
          sql: 'INSERT INTO ohlcv_daily (ticker, date, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?)',
          args: [ticker, date, open, Math.max(open, close) + 1, Math.min(open, close) - 1, close, 1000],
        })
      }
      const gapDate = block.startYear === 2024 && date === '2025-12-30' ? '2025-12-29' : date
      statements.push({
        sql: 'INSERT INTO ohlcv_daily (ticker, date, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?)',
        args: ['JP-GAP', gapDate, open, Math.max(open, close) + 1, Math.min(open, close) - 1, close, 1000],
      })
      for (const ticker of ['SPY', 'US-LINE']) {
        statements.push({
          sql: `INSERT INTO market_ohlcv_daily (
            market, ticker, date, open, high, low, close, volume,
            adj_open, adj_high, adj_low, adj_close, adj_volume
          ) VALUES ('US', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [ticker, date, open, open + 1, open - 1, close, 1000, open, open + 1, open - 1, close, 1000],
        })
      }
      const four = fourCandleBlocks.get(block.startYear)
      if (four) {
        const value = index === 0 ? four[0] : four[1]
        statements.push({
          sql: 'INSERT INTO ohlcv_daily (ticker, date, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?)',
          args: ['JP-FOUR', date, value, value + 1, value - 1, value, 1000],
        })
        statements.push({
          sql: `INSERT INTO market_ohlcv_daily (
            market, ticker, date, open, high, low, close, volume,
            adj_open, adj_high, adj_low, adj_close, adj_volume
          ) VALUES ('US', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: ['US-FOUR', date, value, value + 1, value - 1, value, 1000, value, value + 1, value - 1, value, 1000],
        })
      }
    }
  }
  statements.push(
    {
      sql: 'INSERT INTO ohlcv_daily (ticker, date, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?)',
      args: ['JP-SPLIT', '2019-12-30', 100, 101, 99, 100, 1000],
    },
    {
      sql: 'INSERT INTO ohlcv_daily (ticker, date, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?)',
      args: ['JP-SPLIT', '2020-12-30', 100, 101, 99, 100, 1000],
    },
    {
      sql: 'INSERT INTO ohlcv_daily (ticker, date, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?)',
      args: ['JP-SPLIT', '2021-12-30', 100, 101, 99, 100, 1000],
    },
    {
      sql: 'INSERT INTO ohlcv_daily (ticker, date, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?)',
      args: ['JP-SPLIT', '2022-01-04', 50, 51, 49, 50, 2000],
    },
  )
  await fixtureClient.batch(statements)
  fixtureClient.close()

  delete process.env.TURSO_DATABASE_URL
  delete process.env.TURSO_AUTH_TOKEN
  delete process.env.STOCKBOARD_DB_ROLE
  delete process.env.US_ANALYTICS_DB_PATH
  delete process.env.LOCAL_DB_PATH
  process.env.USE_LOCAL_DB = '1'
  process.env.STOCKBOARD_DB_PATH = databasePath
  process.env.STOCKBOARD_DB_READ_CONCURRENCY = '0'

  const { execGet, execRun, localDbPath } = await import('../lib/db/client')
  assert.equal(path.resolve(localDbPath), path.resolve(databasePath), 'test must resolve only to its fixture DB')

  const {
    buildTwoYearLineServingCache,
    clearTwoYearLineSearchCachesForQa,
    computeTwoYearLineSearchEntries,
    loadTwoYearLineSearchEntries,
    selectTwoYearLineSummary,
    TwoYearLineServingUnavailableError,
    twoYearLineSearchHistoryStartDate,
  } = await import('../lib/server/two-year-line-search')

  assert.equal(twoYearLineSearchHistoryStartDate('2026-10-23'), '2018-01-01')
  assert.equal(twoYearLineSearchHistoryStartDate('2027-12-30'), '2018-01-01')
  assert.equal(twoYearLineSearchHistoryStartDate('2028-01-01'), '2020-01-01')

  const jpServingTickers = ['JP-LINE', 'JP-FOUR', 'JP-GAP', 'JP-SPLIT', 'MISSING']
  const usServingTickers = ['US-LINE', 'US-FOUR']
  const jpDirect = await computeTwoYearLineSearchEntries({
    market: 'JP', tickers: jpServingTickers, asOfDate: '2027-12-30', sourceGeneration: 1,
  })
  const jpBuild = await buildTwoYearLineServingCache({
    market: 'JP', tickers: jpServingTickers, asOfDate: '2027-12-30',
  })
  const usBuild = await buildTwoYearLineServingCache({
    market: 'US', tickers: usServingTickers, asOfDate: '2027-12-30',
  })
  assert.deepEqual(
    [...jpBuild.result.entries.values()],
    [...jpDirect.entries.values()],
    'update-time serving output must match the shared direct math engine',
  )
  assert.match(jpBuild.cacheKey, /^two-year-line-serving%3Av1:JP:/)
  assert.match(usBuild.cacheKey, /^two-year-line-serving%3Av1:US:/)
  assert.equal(usBuild.result.entries.size, usServingTickers.length)
  clearTwoYearLineSearchCachesForQa()

  for (const market of ['JP', 'US'] as const) {
    const ticker = market === 'JP' ? 'JP-LINE' : 'US-LINE'
    const result = await loadTwoYearLineSearchEntries({ market, tickers: [ticker], asOfDate: '2027-12-30' })
    const entry = result.entries.get(ticker)
    assert(entry, `${market} entry must exist`)
    assert.equal(entry.availability, 'available')
    assert.equal(entry.hasConfirmed, true)
    assert.equal(entry.hasProvisional, true)
    assert.equal(selectTwoYearLineSummary(entry, 'confirmed')?.pattern, 'three')
    assert.equal(selectTwoYearLineSummary(entry, 'confirmed')?.sourcePeriods.join(','), '2020,2022,2024')
    assert.equal(selectTwoYearLineSummary(entry, 'provisional')?.pattern, 'four')
    assert.equal(selectTwoYearLineSummary(entry, 'provisional')?.sourcePeriods.join(','), '2020,2022,2024,2026')
    assert.equal(selectTwoYearLineSummary(entry, 'either')?.status, 'provisional')
    assert.ok((selectTwoYearLineSummary(entry, 'confirmed')?.angleDeg ?? 0) > 0)
    assert.ok(Number.isFinite(selectTwoYearLineSummary(entry, 'confirmed')?.distancePct))
    assert.equal(selectTwoYearLineSummary(entry, {
      status: 'either', pattern: 'four', minAngleDeg: null, maxAngleDeg: null,
    })?.status, 'provisional')
    assert.equal(result.metadata.calendarAvailable, true)
    assert.equal(result.metadata.requestedTickerCount, 1)
    assert.equal(result.metadata.availableTickerCount, 1)
  }

  const calendarClipped = await loadTwoYearLineSearchEntries({
    market: 'JP',
    tickers: ['JP-LINE', 'JP-FOUR'],
    asOfDate: '2028-01-05',
  })
  assert.equal(calendarClipped.metadata.asOfDate, '2027-12-30')
  assert.equal(calendarClipped.entries.get('JP-FOUR')?.latestConfirmed?.pattern, 'four')
  assert.equal(calendarClipped.entries.get('JP-FOUR')?.latestConfirmed?.sourcePeriods.join(','), '2018,2020,2022,2024')

  const gap = await loadTwoYearLineSearchEntries({ market: 'JP', tickers: ['JP-GAP'], asOfDate: '2027-12-30' })
  assert.equal(gap.entries.get('JP-GAP')?.hasConfirmed, false, 'a non-benchmark extra row must not conceal a missing benchmark session')
  assert.equal(gap.entries.get('JP-GAP')?.hasProvisional, false)

  const { NextRequest } = await import('next/server')
  const { GET: getJpHistory } = await import('../app/api/history/[ticker]/route')
  const historyResponse = await getJpHistory(
    new NextRequest('http://localhost/api/history/JP-SPLIT?period=all&asOfDate=2021-12-30'),
    { params: Promise.resolve({ ticker: 'JP-SPLIT' }) },
  )
  assert.equal(historyResponse.status, 200)
  const historyRows = await historyResponse.json() as Array<{ date: string; close: number }>
  assert.equal(historyRows.at(-1)?.date, '2021-12-30')
  assert.equal(historyRows.at(-1)?.close, 100, 'a split after the analysis date must not change the displayed historical basis')

  const registryResponse = await getJpHistory(
    new NextRequest('http://localhost/api/history/JP-SPLIT?twoYearRegistry=1&asOfDate=2021-12-30'),
    { params: Promise.resolve({ ticker: 'JP-SPLIT' }) },
  )
  assert.equal(registryResponse.status, 200)
  const registry = await registryResponse.json() as { candles: Array<{ close: number }> }
  assert.equal(registry.candles.at(-1)?.close, 100, 'chart and registry must share the same analysis-date price basis')

  const missing = await loadTwoYearLineSearchEntries({ market: 'JP', tickers: ['MISSING'], asOfDate: '2027-12-30' })
  assert.equal(missing.entries.get('MISSING')?.availability, 'history_unavailable')

  await assert.rejects(
    loadTwoYearLineSearchEntries({ market: 'JP', tickers: ['NOT-COVERED'], asOfDate: '2027-12-30' }),
    TwoYearLineServingUnavailableError,
    'a missing ticker must not be interpreted as no qualifying line',
  )

  await buildTwoYearLineServingCache({ market: 'JP', tickers: ['JP-SPLIT'], asOfDate: '2021-12-30' })
  clearTwoYearLineSearchCachesForQa()
  const historical = await loadTwoYearLineSearchEntries({
    market: 'JP', tickers: ['JP-SPLIT'], asOfDate: '2021-12-30',
  })
  assert.equal(historical.metadata.asOfDate, '2021-12-30')

  const jpPayloadRow = await execGet<{ cacheKey: string; payloadJson: string }>(
    `SELECT cache_key AS cacheKey, payload_json AS payloadJson
     FROM dashboard_trade_signal_cache
     WHERE cache_key LIKE '%:JP:%' AND payload_json LIKE '%JP-LINE%'
     ORDER BY computed_at DESC LIMIT 1`,
  )
  assert(jpPayloadRow)
  const corrupted = JSON.parse(jpPayloadRow.payloadJson) as Record<string, unknown>
  corrupted.priceBasisVersion = 'wrong-basis'
  await execRun(
    'UPDATE dashboard_trade_signal_cache SET payload_json = ?, computed_at = computed_at + 1 WHERE cache_key = ?',
    [JSON.stringify(corrupted), jpPayloadRow.cacheKey],
  )
  clearTwoYearLineSearchCachesForQa()
  await assert.rejects(
    loadTwoYearLineSearchEntries({ market: 'JP', tickers: ['JP-LINE'], asOfDate: '2027-12-30' }),
    TwoYearLineServingUnavailableError,
    'price-basis corruption must fail closed',
  )
  await buildTwoYearLineServingCache({ market: 'JP', tickers: jpServingTickers, asOfDate: '2027-12-30' })

  for (const status of ['failed', 'running'] as const) {
    await execRun(
      `INSERT INTO batch_runs (job_type, started_at, finished_at, status)
       VALUES ('ohlcv_fetch:jquants', ?, ?, ?)`,
      [Date.now(), status === 'running' ? null : Date.now(), status],
    )
    clearTwoYearLineSearchCachesForQa()
    await assert.rejects(
      loadTwoYearLineSearchEntries({ market: 'JP', tickers: ['JP-LINE'], asOfDate: '2027-12-30' }),
      TwoYearLineServingUnavailableError,
      `${status} source generation must fail closed`,
    )
    await execRun(
      "UPDATE batch_runs SET status = 'success', finished_at = ? WHERE id = (SELECT MAX(id) FROM batch_runs)",
      [Date.now()],
    )
    await buildTwoYearLineServingCache({ market: 'JP', tickers: jpServingTickers, asOfDate: '2027-12-30' })
  }

  await execRun(
    `INSERT INTO batch_runs (job_type, started_at, finished_at, status)
     VALUES ('ohlcv_fetch:jquants', ?, ?, 'partial')`,
    [Date.now(), Date.now()],
  )
  clearTwoYearLineSearchCachesForQa()
  await assert.rejects(
    loadTwoYearLineSearchEntries({ market: 'JP', tickers: ['JP-LINE'], asOfDate: '2027-12-30' }),
    TwoYearLineServingUnavailableError,
    'a terminal partial JP source generation must fail closed',
  )
  await execRun(
    "UPDATE batch_runs SET status = 'success', finished_at = ? WHERE id = (SELECT MAX(id) FROM batch_runs)",
    [Date.now()],
  )
  await buildTwoYearLineServingCache({ market: 'JP', tickers: jpServingTickers, asOfDate: '2027-12-30' })

  await execRun(
    `INSERT INTO market_data_runs (market, job_type, status, started_at, finished_at)
     VALUES ('US', 'tiingo_ohlcv', 'partial', ?, ?)`,
    [Date.now(), Date.now()],
  )
  await buildTwoYearLineServingCache({ market: 'US', tickers: usServingTickers, asOfDate: '2027-12-30' })
  clearTwoYearLineSearchCachesForQa()
  assert.equal(
    (await loadTwoYearLineSearchEntries({
      market: 'US', tickers: ['US-LINE'], asOfDate: '2027-12-30',
    })).entries.size,
    1,
    'the existing US partial-source contract must remain unchanged',
  )

  await execRun(
    `INSERT INTO batch_runs (job_type, started_at, status)
     VALUES ('ohlcv_fetch:jquants', ?, 'running')`,
    [Date.now()],
  )
  await execRun(
    `INSERT INTO batch_runs (job_type, started_at, finished_at, status)
     VALUES ('ohlcv_fetch:jquants', ?, ?, 'success')`,
    [Date.now(), Date.now()],
  )
  await buildTwoYearLineServingCache({ market: 'JP', tickers: jpServingTickers, asOfDate: '2027-12-30' })

  clearTwoYearLineSearchCachesForQa()
  await assert.rejects(
    loadTwoYearLineSearchEntries({ market: 'JP', tickers: ['JP-SPLIT'], asOfDate: '2021-12-30' }),
    TwoYearLineServingUnavailableError,
    'a historical cache from an older source generation must not be reused silently',
  )
  await buildTwoYearLineServingCache({ market: 'JP', tickers: ['JP-SPLIT'], asOfDate: '2021-12-30' })
  clearTwoYearLineSearchCachesForQa()
  assert.equal(
    (await loadTwoYearLineSearchEntries({
      market: 'JP', tickers: ['JP-SPLIT'], asOfDate: '2021-12-30',
    })).metadata.asOfDate,
    '2021-12-30',
    'an explicitly rebuilt historical cache must preserve its PIT as-of date',
  )

  for (const historicalAsOf of [
    '2014-01-03', '2015-12-30', '2016-01-03', '2017-12-30', '2018-01-03',
    '2019-12-30', '2020-01-03', '2021-12-30', '2022-01-03',
  ]) {
    await buildTwoYearLineServingCache({ market: 'JP', tickers: ['JP-LINE'], asOfDate: historicalAsOf })
  }
  clearTwoYearLineSearchCachesForQa()
  assert.equal(
    (await loadTwoYearLineSearchEntries({
      market: 'JP', tickers: ['JP-LINE'], asOfDate: '2027-12-30',
    })).entries.size,
    1,
    'historical cache retention must not evict the current-generation latest as-of payload',
  )

  await assert.rejects(
    buildTwoYearLineServingCache({
      market: 'JP',
      tickers: jpServingTickers,
      asOfDate: '2027-12-30',
      beforePersistForQa: async () => {
        await execRun(
          `INSERT INTO batch_runs (job_type, started_at, finished_at, status)
           VALUES ('ohlcv_fetch:jquants', ?, ?, 'success')`,
          [Date.now(), Date.now()],
        )
      },
    }),
    /source generation changed/,
    'a generation change during computation must abort publication',
  )

  const jpUpdateSource = await readFile(path.join(process.cwd(), 'scripts/update-latest.ts'), 'utf8')
  const jpQualityGate = jpUpdateSource.indexOf("throw new Error('Critical market data refresh did not reach the expected trading date')")
  const jpServingBuild = jpUpdateSource.indexOf("'scripts/build-two-year-line-serving.ts'")
  const jpNextServingStep = jpUpdateSource.indexOf("'scripts/backfill-valuation-serving.ts'")
  assert.ok(
    jpQualityGate >= 0 && jpQualityGate < jpServingBuild && jpServingBuild < jpNextServingStep,
    'JP daily update must build the 24-month cache after source quality gates and before later serving steps',
  )

  const usUpdateSource = await readFile(path.join(process.cwd(), 'scripts/update-us-latest.ts'), 'utf8')
  const usSnapshotGate = usUpdateSource.indexOf('snapshot coverage is below the publication threshold')
  const usServingBuild = usUpdateSource.indexOf("await runNpm('batch:two-year-line-serving'")
  const usHeavyMlGate = usUpdateSource.indexOf('if (hasActiveHeavyMlProcess())', usServingBuild)
  assert.ok(
    usSnapshotGate >= 0 && usSnapshotGate < usServingBuild && usServingBuild < usHeavyMlGate,
    'US daily update must build the 24-month cache after snapshot quality gates and before analytics/ML publication',
  )
  assert.match(
    usUpdateSource,
    /STOCKBOARD_DB_ROLE:\s*'primary'[\s\S]*STOCKBOARD_DB_PATH:\s*sourceDbPath/,
    'US daily build must explicitly use the primary source database role and path',
  )
  console.log('two-year line compact search tests: PASS')
  } finally {
    try { fixtureClient.close() } catch { /* already closed */ }
    await rm(directory, { recursive: true, force: true })
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
