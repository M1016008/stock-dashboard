import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

interface SqliteStatement {
  run(...values: Array<string | number>): unknown
  all(...values: Array<string | number>): Array<Record<string, unknown>>
}

interface SqliteDatabase {
  exec(sql: string): void
  prepare(sql: string): SqliteStatement
  close(): void
}

interface SqliteModule {
  DatabaseSync: new (databasePath: string, options?: { readOnly?: boolean }) => SqliteDatabase
}

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as SqliteModule

type Market = 'JP' | 'US'

const benchmarkMarket = parseBenchmarkMarket()
const jpTickerCount = benchmarkMarket === 'US' ? 0 : positiveIntegerEnv('TWO_YEAR_BENCH_JP_TICKERS', 4_200)
const usTickerCount = benchmarkMarket === 'JP' ? 0 : positiveIntegerEnv('TWO_YEAR_BENCH_US_TICKERS', 10_000)
// One hundred sessions per two-year block keeps the fixture bounded while
// exercising 7.1 million daily rows at the default JP/US universe sizes.
const sessionsPerBlock = positiveIntegerEnv('TWO_YEAR_BENCH_SESSIONS_PER_BLOCK', 100)
const coldLimitMs = positiveIntegerEnv('TWO_YEAR_BENCH_COLD_LIMIT_MS', 30_000)
const warmLimitMs = positiveIntegerEnv('TWO_YEAR_BENCH_WARM_LIMIT_MS', 5_000)
const asOfDate = '2027-12-30'
const blockYears = [2018, 2020, 2022, 2024, 2026] as const

function parseBenchmarkMarket(): Market | 'BOTH' {
  const value = process.env.TWO_YEAR_BENCH_MARKET?.trim().toUpperCase() || 'BOTH'
  if (value === 'JP' || value === 'US' || value === 'BOTH') return value
  throw new Error('TWO_YEAR_BENCH_MARKET must be JP, US, or BOTH')
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isInteger(value) && value > 0 ? value : fallback
}

function sessionDates(startYear: number): string[] {
  return Array.from({ length: sessionsPerBlock }, (_, index) => {
    const fraction = index / Math.max(1, sessionsPerBlock - 1)
    const dayOffset = Math.round(fraction * 720)
    const date = new Date(Date.UTC(startYear, 0, 3 + dayOffset))
    return date.toISOString().slice(0, 10)
  })
}

function blockPrices(startYear: number, tickerIndex: number): { open: number; close: number } {
  const base = 80 + (tickerIndex % 400) * 0.25
  const values: Record<number, readonly [number, number]> = {
    2018: [base, base * 1.02],
    2020: [base * 1.08, base * 0.96],
    2022: [base * 0.98, base * 1.12],
    2024: [base * 1.10, base * 1.28],
    2026: [base * 1.24, base * 1.42],
  }
  const [open, close] = values[startYear]
  return { open, close }
}

function interpolate(open: number, close: number, index: number): number {
  if (sessionsPerBlock === 1) return close
  return open + ((close - open) * index) / (sessionsPerBlock - 1)
}

function createFixture(databasePath: string): { jpTickers: string[]; usTickers: string[]; rowCount: number } {
  const db = new DatabaseSync(databasePath)
  db.exec(`
    PRAGMA journal_mode=OFF;
    PRAGMA synchronous=OFF;
    PRAGMA temp_store=MEMORY;
    CREATE TABLE ohlcv_daily (
      ticker TEXT NOT NULL, date TEXT NOT NULL, open REAL NOT NULL, high REAL NOT NULL,
      low REAL NOT NULL, close REAL NOT NULL, volume INTEGER NOT NULL,
      PRIMARY KEY (ticker, date)
    );
    CREATE INDEX ohlcv_date_ticker_idx ON ohlcv_daily(date, ticker);
    CREATE TABLE market_ohlcv_daily (
      market TEXT NOT NULL, ticker TEXT NOT NULL, date TEXT NOT NULL,
      open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL,
      volume INTEGER NOT NULL, adj_open REAL, adj_high REAL, adj_low REAL,
      adj_close REAL, adj_volume REAL,
      PRIMARY KEY (market, ticker, date)
    );
    CREATE INDEX market_ohlcv_market_ticker_date_idx
      ON market_ohlcv_daily(market, ticker, date);
    CREATE INDEX market_ohlcv_market_date_ticker_idx
      ON market_ohlcv_daily(market, date, ticker);
    CREATE TABLE dashboard_trade_signal_cache (
      cache_key TEXT PRIMARY KEY, payload_json TEXT NOT NULL, computed_at INTEGER NOT NULL
    );
    CREATE TABLE batch_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, job_type TEXT NOT NULL, started_at INTEGER NOT NULL,
      finished_at INTEGER, status TEXT NOT NULL, total_tickers INTEGER, succeeded INTEGER DEFAULT 0,
      failed INTEGER DEFAULT 0, rows_inserted INTEGER DEFAULT 0, error_summary TEXT
    );
    CREATE TABLE market_data_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, market TEXT NOT NULL, job_type TEXT NOT NULL,
      status TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER,
      total_tickers INTEGER NOT NULL DEFAULT 0, succeeded INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0, rows_inserted INTEGER NOT NULL DEFAULT 0,
      error_summary TEXT, payload_json TEXT NOT NULL DEFAULT '{}'
    );
    INSERT INTO batch_runs (job_type, started_at, finished_at, status)
      VALUES ('ohlcv_fetch:jquants', 1, 2, 'success');
    INSERT INTO market_data_runs (market, job_type, status, started_at, finished_at)
      VALUES ('US', 'tiingo_ohlcv', 'success', 1, 2);
  `)
  const insertJp = db.prepare(`
    INSERT INTO ohlcv_daily (ticker, date, open, high, low, close, volume)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  const insertUs = db.prepare(`
    INSERT INTO market_ohlcv_daily (
      market, ticker, date, open, high, low, close, volume,
      adj_open, adj_high, adj_low, adj_close, adj_volume
    ) VALUES ('US', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const jpTickers = Array.from({ length: jpTickerCount }, (_, index) => `J${String(index + 1).padStart(5, '0')}`)
  const usTickers = Array.from({ length: usTickerCount }, (_, index) => `U${String(index + 1).padStart(5, '0')}`)
  const sessions = blockYears.map((startYear) => ({ startYear, dates: sessionDates(startYear) }))
  let rowCount = 0

  db.exec('BEGIN')
  try {
    for (const [blockIndex, { dates }] of sessions.entries()) {
      for (const [dateIndex, date] of dates.entries()) {
        const benchmark = 100 + blockIndex * 10 + dateIndex * 0.05
        insertJp.run('1306', date, benchmark, benchmark + 1, benchmark - 1, benchmark, 1_000_000)
        insertUs.run('SPY', date, benchmark, benchmark + 1, benchmark - 1, benchmark, 1_000_000,
          benchmark, benchmark + 1, benchmark - 1, benchmark, 1_000_000)
        rowCount += 2

      }
    }
    for (const [tickerIndex, ticker] of jpTickers.entries()) {
      for (const { startYear, dates } of sessions) {
        const prices = blockPrices(startYear, tickerIndex)
        for (const [dateIndex, date] of dates.entries()) {
          const close = interpolate(prices.open, prices.close, dateIndex)
          insertJp.run(ticker, date, close, close + 1, close - 1, close, 10_000 + tickerIndex)
          rowCount += 1
        }
      }
    }
    for (const [tickerIndex, ticker] of usTickers.entries()) {
      for (const { startYear, dates } of sessions) {
        const prices = blockPrices(startYear, tickerIndex)
        for (const [dateIndex, date] of dates.entries()) {
          const close = interpolate(prices.open, prices.close, dateIndex)
          insertUs.run(ticker, date, close, close + 1, close - 1, close, 10_000 + tickerIndex,
            close, close + 1, close - 1, close, 10_000 + tickerIndex)
          rowCount += 1
        }
      }
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  } finally {
    db.close()
  }
  return { jpTickers, usTickers, rowCount }
}

async function measure(
  market: Market,
  tickers: readonly string[],
  build: (options: { market: Market; tickers: readonly string[]; asOfDate: string }) => Promise<{
    cacheKey: string
    elapsedMs: number
    result: { entries: Map<string, { hasConfirmed: boolean; hasProvisional: boolean }> }
  }>,
  load: (options: { market: Market; tickers: readonly string[]; asOfDate: string }) => Promise<{
    entries: Map<string, { hasConfirmed: boolean; hasProvisional: boolean }>
  }>,
  clearCaches: () => void,
): Promise<{
  precomputeMs: number
  coldMs: number
  warmMs: number
  filterSortPageMs: number
  confirmed: number
  provisional: number
  rssDeltaMb: number
  cacheKey: string
}> {
  const rssBefore = process.memoryUsage().rss
  const precomputeStarted = performance.now()
  const built = await build({ market, tickers, asOfDate })
  const precomputeMs = performance.now() - precomputeStarted
  assert.equal(built.result.entries.size, tickers.length)
  clearCaches()
  const coldStarted = performance.now()
  const cold = await load({ market, tickers, asOfDate })
  const coldMs = performance.now() - coldStarted
  const warmStarted = performance.now()
  const warm = await load({ market, tickers, asOfDate })
  const warmMs = performance.now() - warmStarted
  const filterSortPageStarted = performance.now()
  const firstPage = [...cold.entries.entries()]
    .filter(([, entry]) => entry.hasConfirmed || entry.hasProvisional)
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, 100)
  const filterSortPageMs = performance.now() - filterSortPageStarted
  const rssDeltaMb = (process.memoryUsage().rss - rssBefore) / 1024 ** 2
  assert.equal(cold.entries.size, tickers.length)
  assert.equal(warm.entries.size, tickers.length)
  assert.deepEqual(
    [...cold.entries.entries()],
    [...built.result.entries.entries()],
    `${market} cached search output must match the precomputed registry exactly`,
  )
  assert.ok(firstPage.length <= 100)
  return {
    precomputeMs,
    coldMs,
    warmMs,
    filterSortPageMs,
    confirmed: [...cold.entries.values()].filter((entry) => entry.hasConfirmed).length,
    provisional: [...cold.entries.values()].filter((entry) => entry.hasProvisional).length,
    rssDeltaMb,
    cacheKey: built.cacheKey,
  }
}

async function main(): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'stockboard-two-year-performance-'))
  const databasePath = path.join(directory, 'fixture.db')
  try {
    const fixtureStarted = performance.now()
    const fixture = createFixture(databasePath)
    const fixtureMs = performance.now() - fixtureStarted

    delete process.env.TURSO_DATABASE_URL
    delete process.env.TURSO_AUTH_TOKEN
    delete process.env.STOCKBOARD_DB_ROLE
    delete process.env.US_ANALYTICS_DB_PATH
    delete process.env.LOCAL_DB_PATH
    process.env.EXTERNAL_STORAGE_REQUIRED = 'false'
    process.env.USE_LOCAL_DB = '1'
    process.env.SKIP_SCHEMA_ENSURE = '1'
    process.env.STOCKBOARD_DB_PATH = databasePath
    process.env.STOCKBOARD_DB_READ_CONCURRENCY = '0'
    process.env.STOCKBOARD_DB_CACHE_MB = '32'
    process.env.STOCKBOARD_DB_MMAP_MB = '0'

    const databaseBytes = (await stat(databasePath)).size
    const { localDbPath } = await import('../lib/db/client')
    assert.equal(path.resolve(localDbPath), path.resolve(databasePath), 'benchmark must resolve only to its fixture DB')
    const {
      buildTwoYearLineServingCache,
      clearTwoYearLineSearchCachesForQa,
      loadTwoYearLineSearchEntries,
      twoYearLineSearchHistoryStartDate,
      twoYearLineServingCacheSqlForQa,
      twoYearLineSearchSqlForQa,
    } = await import('../lib/server/two-year-line-search')
    const marketInputs = [
      ...(fixture.jpTickers.length > 0 ? [{ market: 'JP' as const, tickers: fixture.jpTickers }] : []),
      ...(fixture.usTickers.length > 0 ? [{ market: 'US' as const, tickers: fixture.usTickers }] : []),
    ]
    const metrics = {} as Partial<Record<Market, Awaited<ReturnType<typeof measure>>>>
    for (const item of marketInputs) {
      metrics[item.market] = await measure(
        item.market,
        item.tickers,
        buildTwoYearLineServingCache,
        loadTwoYearLineSearchEntries,
        clearTwoYearLineSearchCachesForQa,
      )
    }
    const sqlQa = measureSqlPlans({
      databasePath,
      historyStartDate: twoYearLineSearchHistoryStartDate(asOfDate),
      buildSql: twoYearLineSearchSqlForQa,
      markets: marketInputs,
    })
    for (const item of marketInputs) assertIndexedPlan(item.market, sqlQa[item.market]!.queryPlan)
    const cacheQueryPlans = measureCacheQueryPlans({
      databasePath,
      sql: twoYearLineServingCacheSqlForQa(),
      metrics,
    })
    const result = {
      isolation: {
        databasePath,
        resolvedDatabasePath: localDbPath,
        fixturePathMatch: path.resolve(localDbPath) === path.resolve(databasePath),
        externalStorageGuardRequired: false,
      },
      fixture: {
        jpTickers: jpTickerCount,
        usTickers: usTickerCount,
        sessionsPerBlock,
        blocks: blockYears.length,
        rows: fixture.rowCount,
        databaseMb: Math.round(databaseBytes / 1024 ** 2),
        createMs: Math.round(fixtureMs),
      },
      limits: { coldMs: coldLimitMs, warmMs: warmLimitMs },
      JP: metrics.JP ? roundMetrics(metrics.JP) : null,
      US: metrics.US ? roundMetrics(metrics.US) : null,
      sqlQa,
      cacheQueryPlans,
      maxRssMb: maxRssMb(),
    }
    console.log(JSON.stringify(result, null, 2))
    for (const item of marketInputs) {
      const measured = metrics[item.market]!
      assert.ok(measured.coldMs <= coldLimitMs, `${item.market} cold cache ${Math.round(measured.coldMs)}ms exceeds ${coldLimitMs}ms`)
      assert.ok(measured.warmMs <= warmLimitMs, `${item.market} warm cache ${Math.round(measured.warmMs)}ms exceeds ${warmLimitMs}ms`)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function assertIndexedPlan(market: Market, plan: readonly string[]): void {
  assert.ok(
    plan.some((detail) => detail.includes('ticker=? AND date>? AND date<?')),
    `${market} plan must use a ticker/date range index`,
  )
  assert.ok(
    plan.some((detail) => detail.includes('CREATE BLOOM FILTER')),
    `${market} plan must materialize the bounded market-session lookup`,
  )
  const table = market === 'JP' ? 'ohlcv_daily' : 'market_ohlcv_daily'
  assert.equal(
    plan.some((detail) => detail === `SCAN ${table}`),
    false,
    `${market} plan must not full-scan ${table}`,
  )
}

const CHUNK_SIZE = 500

function measureSqlPlans(options: Readonly<{
  databasePath: string
  historyStartDate: string
  buildSql: (market: Market, tickerCount: number) => Readonly<{
    compactBlocks: string
    splitEvents: string | null
  }>
  markets: ReadonlyArray<{
    market: Market
    tickers: readonly string[]
  }>
}>): Partial<Record<Market, { queryPlan: string[] }>> {
  const db = new DatabaseSync(options.databasePath, { readOnly: true })
  const output: Partial<Record<Market, { queryPlan: string[] }>> = {}
  try {
    for (const item of options.markets) {
      const planTickers = item.tickers.slice(0, CHUNK_SIZE)
      const compactPlanArgs = [
        ...planTickers,
        options.historyStartDate,
        asOfDate,
        options.historyStartDate,
        asOfDate,
      ]
      const splitPlanArgs = [...planTickers, options.historyStartDate, asOfDate]
      const planSql = options.buildSql(item.market, planTickers.length)
      const queryPlan = explain(db, planSql.compactBlocks, compactPlanArgs)
      if (planSql.splitEvents) queryPlan.push(...explain(db, planSql.splitEvents, splitPlanArgs))
      output[item.market] = {
        queryPlan: [...new Set(queryPlan)],
      }
    }
  } finally {
    db.close()
  }
  return output
}

function measureCacheQueryPlans(options: Readonly<{
  databasePath: string
  sql: string
  metrics: Partial<Record<Market, { cacheKey: string }>>
}>): Partial<Record<Market, string[]>> {
  const db = new DatabaseSync(options.databasePath, { readOnly: true })
  const output: Partial<Record<Market, string[]>> = {}
  try {
    for (const market of ['JP', 'US'] as const) {
      const cacheKey = options.metrics[market]?.cacheKey
      if (!cacheKey) continue
      const plan = explain(db, options.sql, [cacheKey])
      assert.ok(
        plan.some((detail) => detail.includes('dashboard_trade_signal_cache') && detail.includes('cache_key=?')),
        `${market} serving lookup must use the cache primary key`,
      )
      output[market] = plan
    }
  } finally {
    db.close()
  }
  return output
}

function explain(db: SqliteDatabase, sql: string, args: Array<string | number>): string[] {
  return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args)
    .map((row) => String(row.detail ?? ''))
    .filter(Boolean)
}

function maxRssMb(): number {
  return Math.round(process.resourceUsage().maxRSS / 1024)
}

function roundMetrics(metrics: Awaited<ReturnType<typeof measure>>) {
  return {
    precomputeMs: Math.round(metrics.precomputeMs),
    coldMs: Math.round(metrics.coldMs),
    warmMs: Math.round(metrics.warmMs),
    filterSortPageMs: Math.round(metrics.filterSortPageMs),
    confirmed: metrics.confirmed,
    provisional: metrics.provisional,
    rssDeltaMb: Math.round(metrics.rssDeltaMb),
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
