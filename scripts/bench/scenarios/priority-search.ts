import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import type { BenchScenario, WorkerContext } from '../lib/scenario'

function scale(name: string, fallback: number): number {
  const params = JSON.parse(process.env.STOCKBOARD_BENCH_FIXTURE_PARAMS || '{}') as Record<string, unknown>
  const fixtureKey = name === 'STOCKBOARD_BENCH_TICKERS'
    ? 'tickers'
    : name === 'STOCKBOARD_BENCH_US_TICKERS'
      ? 'usTickers'
      : 'sessions'
  const fixtureValue = Number(params[fixtureKey])
  if (Number.isFinite(fixtureValue) && fixtureValue > 0) return Math.floor(fixtureValue)
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

const tickerCount = scale('STOCKBOARD_BENCH_TICKERS', 300)
const usTickerCount = scale('STOCKBOARD_BENCH_US_TICKERS', tickerCount)
const sessionCount = scale('STOCKBOARD_BENCH_SESSIONS', 760)
const fixture = { id: 'priority-search', params: { tickers: tickerCount, usTickers: usTickerCount, sessions: sessionCount } } as const

function isoDay(index: number): string {
  const date = new Date(Date.UTC(2026, 0, 5))
  let remaining = index
  while (remaining > 0) {
    date.setUTCDate(date.getUTCDate() + 1)
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) remaining -= 1
  }
  return date.toISOString().slice(0, 10)
}

const latest = isoDay(sessionCount - 1)
const fixtureSourceDate = latest < '2027-12-30' ? '2027-12-30' : latest
const prior = isoDay(sessionCount - 2)
const prior2 = isoDay(sessionCount - 3)
const analogStart = isoDay(sessionCount - 30)

function stripVolatile(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripVolatile)
  if (!value || typeof value !== 'object') return value
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (['elapsedMs', 'servingBuiltAt', 'generatedAt', 'computedAt', 'cacheHit'].includes(key)) continue
    result[key] = stripVolatile(item)
  }
  // The PIT fix added an explicit nullable field. An absent legacy field and
  // explicit null carry identical information; a real source date is retained.
  if ('serverCache' in result && result.serverCache && typeof result.serverCache === 'object') {
    const cache = result.serverCache as Record<string, unknown>
    delete cache.hit
    delete cache.ageMs
    if (!('mlSummarySourceDate' in cache)) cache.mlSummarySourceDate = null
  }
  if ('cache' in result && result.cache && typeof result.cache === 'object') {
    const cache = result.cache as Record<string, unknown>
    delete cache.status
    delete cache.hit
  }
  return result
}

function describeRows(body: unknown): Record<string, unknown> {
  const value = body as Record<string, unknown>
  const rows = (value.rows ?? value.results ?? value.data) as unknown[] | undefined
  const pagination = value.pagination as Record<string, unknown> | undefined
  return {
    status: value.success ?? true,
    count: rows?.length ?? 0,
    total: value.total ?? value.count ?? pagination?.total ?? null,
  }
}

function describeAnalogRows(body: unknown): Record<string, unknown> {
  const value = body as Record<string, unknown>
  const analogs = value.analogs as unknown[] | undefined
  const pagination = value.pagination as Record<string, unknown> | undefined
  return {
    count: analogs?.length ?? 0,
    total: pagination?.total ?? null,
  }
}

export async function setupUsAnalytics(context: WorkerContext): Promise<void> {
  if (fs.existsSync(context.runtime.usAnalyticsDbPath)) return
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (file: string) => any }
  const db = new DatabaseSync(context.runtime.usAnalyticsDbPath)
  const source = context.runtime.dbPath.replaceAll("'", "''")
  try {
    db.exec(`
      ATTACH DATABASE '${source}' AS source;
      CREATE TABLE ticker_universe AS
        SELECT ticker, name, active, sector AS sector17_name, industry AS sector33_name,
               exchange AS market_segment, NULL AS margin_type
        FROM source.market_universe WHERE market='US';
      CREATE UNIQUE INDEX ticker_universe_ticker_idx ON ticker_universe(ticker);
      CREATE TABLE ohlcv_daily AS
        SELECT ticker, date, COALESCE(adj_open, open) AS open, COALESCE(adj_high, high) AS high,
               COALESCE(adj_low, low) AS low, COALESCE(adj_close, close) AS close,
               COALESCE(adj_volume, volume) AS volume
        FROM source.market_ohlcv_daily WHERE market='US';
      CREATE UNIQUE INDEX ohlcv_daily_ticker_date_idx ON ohlcv_daily(ticker,date);
      CREATE INDEX ohlcv_daily_date_ticker_idx ON ohlcv_daily(date,ticker);
      CREATE INDEX ohlcv_date_idx ON ohlcv_daily(date);
      CREATE TABLE daily_snapshots AS
        SELECT ticker, date, daily_a_stage, daily_b_stage, weekly_a_stage, weekly_b_stage,
               monthly_a_stage, monthly_b_stage, prev_close, close_5d, close_20d, close_60d,
               close_120d, avg_volume_20
        FROM source.market_daily_snapshots WHERE market='US';
      CREATE UNIQUE INDEX daily_snapshots_ticker_date_idx ON daily_snapshots(ticker,date);
      CREATE INDEX daily_snapshots_date_ticker_idx ON daily_snapshots(date,ticker);
    `)
    const sourceTables = db.prepare(`
      SELECT name FROM source.sqlite_master
      WHERE type='table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all() as Array<{ name: string }>
    const existing = new Set(
      (db.prepare(`SELECT name FROM main.sqlite_master WHERE type='table'`).all() as Array<{ name: string }>)
        .map((row) => row.name),
    )
    for (const { name } of sourceTables) {
      if (existing.has(name)) continue
      const quoted = `"${name.replaceAll('"', '""')}"`
      db.exec(`CREATE TABLE ${quoted} AS SELECT * FROM source.${quoted} WHERE 0`)
    }
    const universeColumns = new Set(
      (db.prepare('PRAGMA table_info(market_universe)').all() as Array<{ name: string }>).map((row) => row.name),
    )
    if (!universeColumns.has('sector17_name')) db.exec('ALTER TABLE market_universe ADD COLUMN sector17_name TEXT')
    if (!universeColumns.has('sector33_name')) db.exec('ALTER TABLE market_universe ADD COLUMN sector33_name TEXT')
    db.exec(`
      UPDATE market_universe
      SET sector17_name=COALESCE(sector17_name,sector),
          sector33_name=COALESCE(sector33_name,industry);
      CREATE INDEX IF NOT EXISTS serving_current_similars_score_idx
      ON serving_current_similars(as_of_date, similarity_score);
      CREATE INDEX IF NOT EXISTS serving_backtest_results_horizon_date_idx
      ON serving_backtest_results(horizon_days,date DESC,ticker);
    `)
    db.exec(`
      INSERT INTO physical_momentum_metrics
      SELECT * FROM source.physical_momentum_metrics WHERE market='US';
      DETACH DATABASE source;
    `)
  } finally { db.close() }
}

async function setupAnalogIndexForMarket(context: WorkerContext, market: 'JP' | 'US'): Promise<void> {
  const target = path.join(context.runtime.root, market === 'JP' ? 'analog-jp.db' : 'analog-us.db')
  if (fs.existsSync(target)) return
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (file: string, options?: unknown) => any }
  const source = new DatabaseSync(context.runtime.dbPath, { readOnly: true })
  const targetDb = new DatabaseSync(target)
  const sequence = await context.importFromRoot<{
    MA_SEQUENCE_VERSION: number
    MA_SEQUENCE_SCORE_VERSION: string
    prepareMaSequence(rows: Array<{ date: string; close: number }>): unknown
    buildMaSequenceEmbedding(prepared: unknown, index: number): { quantized: Uint8Array; bands: number[]; coverageMask: number } | null
    stageCodeAt(prepared: unknown, index: number): string | null
  }>('lib/ml/ma-sequence.ts')
  try {
    targetDb.exec(`
      CREATE TABLE analog_sequence_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
      CREATE TABLE analog_sequence_index(
        ticker TEXT NOT NULL, date TEXT NOT NULL, stage_code TEXT, embedding BLOB NOT NULL,
        coverage_mask INTEGER NOT NULL, band0 INTEGER NOT NULL, band1 INTEGER NOT NULL,
        band2 INTEGER NOT NULL, band3 INTEGER NOT NULL, PRIMARY KEY(ticker,date)
      ) WITHOUT ROWID;
      CREATE TABLE analog_sequence_prices(
        ticker TEXT NOT NULL, date TEXT NOT NULL, close REAL NOT NULL, PRIMARY KEY(ticker,date)
      ) WITHOUT ROWID;
      CREATE TABLE analog_sequence_price_chunks(
        ticker TEXT NOT NULL, chunk_year INTEGER NOT NULL, points BLOB NOT NULL, row_count INTEGER NOT NULL,
        from_date TEXT NOT NULL, to_date TEXT NOT NULL, PRIMARY KEY(ticker,chunk_year)
      ) WITHOUT ROWID;
      CREATE INDEX analog_sequence_band0_idx ON analog_sequence_index(band0,date,ticker);
      CREATE INDEX analog_sequence_band1_idx ON analog_sequence_index(band1,date,ticker);
      CREATE INDEX analog_sequence_band2_idx ON analog_sequence_index(band2,date,ticker);
      CREATE INDEX analog_sequence_band3_idx ON analog_sequence_index(band3,date,ticker);
      CREATE INDEX analog_sequence_stage_idx ON analog_sequence_index(stage_code,date,ticker);
    `)
    const meta = targetDb.prepare('INSERT INTO analog_sequence_meta(key,value) VALUES (?,?)')
    const metaValues: Record<string, string> = {
      version: String(sequence.MA_SEQUENCE_VERSION), source_date: fixtureSourceDate,
      coverage_from: isoDay(0), coverage_to: fixtureSourceDate,
      row_count: '0', completed: '1', updated_at: '2026-01-01T00:00:00.000Z',
      feature_schema: String(sequence.MA_SEQUENCE_SCORE_VERSION), price_source_date: latest,
      price_completed: '1', price_chunks_completed: '0',
    }
    for (const entry of Object.entries(metaValues)) meta.run(...entry)
    const priceInsert = targetDb.prepare('INSERT INTO analog_sequence_prices(ticker,date,close) VALUES (?,?,?)')
    const indexInsert = targetDb.prepare(`INSERT INTO analog_sequence_index(
      ticker,date,stage_code,embedding,coverage_mask,band0,band1,band2,band3
    ) VALUES (?,?,?,?,?,?,?,?,?)`)
    let inserted = 0
    targetDb.exec('BEGIN')
    const marketTickerCount = market === 'JP' ? tickerCount : usTickerCount
    for (let tickerIndex = 0; tickerIndex < marketTickerCount; tickerIndex += 1) {
      const ticker = market === 'JP'
        ? String(1000 + tickerIndex)
        : `S${String(tickerIndex + 1).padStart(5, '0')}`
      const sql = market === 'JP'
        ? 'SELECT date,close FROM ohlcv_daily WHERE ticker=? ORDER BY date'
        : "SELECT date,adj_close AS close FROM market_ohlcv_daily WHERE market='US' AND ticker=? ORDER BY date"
      const rows = source.prepare(sql).all(ticker)
        .map((row: Record<string, unknown>) => ({ date: String(row.date), close: Number(row.close) }))
      for (const row of rows) priceInsert.run(ticker, row.date, row.close)
      const prepared = sequence.prepareMaSequence(rows)
      for (let anchor = 0; anchor < rows.length; anchor += 1) {
        const embedding = sequence.buildMaSequenceEmbedding(prepared, anchor)
        if (!embedding) continue
        indexInsert.run(ticker, rows[anchor].date, sequence.stageCodeAt(prepared, anchor), embedding.quantized,
          embedding.coverageMask, ...embedding.bands)
        inserted += 1
      }
    }
    targetDb.exec('COMMIT')
    targetDb.prepare("UPDATE analog_sequence_meta SET value=? WHERE key='row_count'").run(String(inserted))
  } catch (error) {
    try { targetDb.exec('ROLLBACK') } catch { /* no active transaction */ }
    throw error
  } finally { source.close(); targetDb.close() }
}

export async function setupAnalogIndex(context: WorkerContext): Promise<void> {
  return setupAnalogIndexForMarket(context, 'JP')
}

export async function setupAnalogIndexUs(context: WorkerContext): Promise<void> {
  await setupUsAnalytics(context)
  return setupAnalogIndexForMarket(context, 'US')
}

const common = {
  priority: 'A' as const,
  fixture,
  normalize: stripVolatile,
  normalizeNotes: 'Only elapsed/build timestamps and cache hit/miss diagnostics are removed; legacy absent mlSummarySourceDate is canonicalized to null. Freshness generations, rows, order, values, counts, and errors remain digest inputs.',
  concurrency: [1, 4],
  coldSamples: 4,
  warmPerProcess: 6,
  expectedStatuses: [200] as const,
}

export const scenarios: BenchScenario[] = [
  {
    ...common, id: 'jp-screener/compound-filter-sort-page', title: 'JP screener compound filter, sort, and pagination', market: 'JP',
    async request(context) {
      return context.callRoute('app/api/screener/route.ts', `http://local.test/api/screener?date=${latest}&daily_a=1,3&minPrice=50&sort=marketCap&dir=desc&limit=50&offset=0`, { key: 'jp-compound' })
    }, describe: describeRows,
  },
  {
    ...common, id: 'us-screener/computed-filter-sort-page', title: 'US screener computed PMS filter and sort over full fixture universe', market: 'US',
    async request(context) {
      return context.callRoute('app/api/us/screener/route.ts', `http://local.test/api/us/screener?date=${latest}&quality=all&pmsMin=0&sort=acceleration&dir=desc&limit=50`, { key: 'us-computed' })
    }, describe: describeRows,
  },
  {
    ...common, id: 'integrated-screener/compound-filter', title: 'Integrated screener serving query with compound conditions', market: 'JP', prepareKey: 'integrated-serving',
    async prepare(context) {
      const module = await context.importFromRoot<{ buildScreeningServingDate(date: string, force: boolean): Promise<unknown> }>('lib/server/integrated-screener-serving.ts')
      await module.buildScreeningServingDate(latest, true)
    },
    async request(context) {
      return context.callRoute('app/api/integrated-screener/route.ts', 'http://local.test/api/integrated-screener', {
        method: 'POST', key: 'integrated-compound', body: {
          asOf: latest, conditions: [
            { id: 'roe', metric: 'roe', operator: 'gte', value: 8 },
            { id: 'stage', metric: 'dailyAStage', operator: 'in', value: [1, 3] },
            { id: 'pms', metric: 'pms', operator: 'gt', value: -5 },
          ], sort: 'marketCap', direction: 'desc', limit: 50, offset: 0,
        },
      })
    }, describe: describeRows,
  },
  {
    ...common, id: 'stage-transition/jp-custom-range', title: 'JP stage-transition exact transition with custom PIT range', market: 'JP',
    async request(context) {
      return context.callRoute('app/api/hex/transitions/route.ts', `http://local.test/api/hex/transitions?from=111111&to=211111&period=custom&dateFrom=${prior2}&dateTo=${prior}&pageSize=50`, { key: 'jp-transition' })
    }, describe: describeRows,
  },
  {
    ...common, id: 'stage-transition/us-custom-range', title: 'US stage-transition exact transition against isolated analytics sidecar', market: 'US',
    setup: setupUsAnalytics, planDatabase: 'usAnalytics',
    async request(context) {
      return context.callRoute('app/api/us/hex/transitions/route.ts', `http://local.test/api/us/hex/transitions?from=111111&to=211111&period=custom&dateFrom=${prior2}&dateTo=${prior}&pageSize=50`, { key: 'us-transition' })
    }, describe: describeRows,
  },
  {
    ...common, id: 'two-year-line/jp-full-api', title: 'JP 24-month line full screener API over the complete fixture universe', market: 'JP', prepareKey: 'two-year-serving',
    async prepare(context) {
      const module = await context.importFromRoot<{ buildTwoYearLineServingCache(input: { market: 'JP' | 'US'; tickers: string[]; asOfDate: string }): Promise<unknown> }>('lib/server/two-year-line-search.ts')
      await module.buildTwoYearLineServingCache({ market: 'JP', tickers: Array.from({ length: tickerCount }, (_, index) => String(1000 + index)), asOfDate: latest })
      await module.buildTwoYearLineServingCache({ market: 'US', tickers: Array.from({ length: usTickerCount }, (_, index) => `S${String(index + 1).padStart(5, '0')}`), asOfDate: latest })
    },
    async request(context) {
      return context.callRoute(
        'app/api/screener/route.ts',
        `http://local.test/api/screener?date=${latest}&twoYearLine=either&twoYearPattern=either&sort=twoYearLineAngleDeg&dir=desc&limit=50&offset=0`,
        { key: 'two-year-JP' },
      )
    }, describe: describeRows,
  },
  {
    ...common, id: 'two-year-line/us-full-api', title: 'US 24-month line full screener API over the complete fixture universe', market: 'US', prepareKey: 'two-year-serving',
    async prepare(context) {
      const module = await context.importFromRoot<{ buildTwoYearLineServingCache(input: { market: 'JP' | 'US'; tickers: string[]; asOfDate: string }): Promise<unknown> }>('lib/server/two-year-line-search.ts')
      await module.buildTwoYearLineServingCache({ market: 'JP', tickers: Array.from({ length: tickerCount }, (_, index) => String(1000 + index)), asOfDate: latest })
      await module.buildTwoYearLineServingCache({ market: 'US', tickers: Array.from({ length: usTickerCount }, (_, index) => `S${String(index + 1).padStart(5, '0')}`), asOfDate: latest })
    },
    async request(context) {
      return context.callRoute(
        'app/api/us/screener/route.ts',
        `http://local.test/api/us/screener?date=${latest}&quality=all&twoYearLine=either&twoYearPattern=either&sort=twoYearLineAngleDeg&dir=desc&limit=50`,
        { key: 'two-year-US' },
      )
    }, describe: describeRows,
  },
  {
    ...common, id: 'period-explorer/return-ranking', title: 'Period Explorer return ranking, filters, sort, and pagination', market: 'JP',
    async request(context) {
      return context.callRoute('app/api/period-explorer/route.ts', `http://local.test/api/period-explorer?from=${isoDay(sessionCount - 20)}&to=${latest}&ranking=return_up&market=プライム&sort=ranking&direction=desc&limit=50&offset=0`, { key: 'period-return' })
    }, describe: describeRows,
  },
  {
    ...common, id: 'analog-search/jp-similar-period', title: 'JP Historical Analog Search with a full-universe synthetic sequence index', market: 'JP', prepareKey: 'analog-jp',
    setup: setupAnalogIndex, planDatabase: 'analogJp', coldSamples: 2, warmPerProcess: 3, concurrency: [1, 2],
    async request(context) {
      return context.callRoute('app/api/ml/historical-analogs/route.ts', `http://local.test/api/ml/historical-analogs?market=JP&ticker=1000&startDate=${analogStart}&endDate=${latest}&sort=similarity&recency=all&profile=balanced&limit=10&offset=0&minScore=0.15`, { key: 'analog-jp' })
    }, describe: describeAnalogRows,
  },
  {
    ...common, id: 'analog-search/us-similar-period', title: 'US Historical Analog Search with a full-universe synthetic sequence index', market: 'US', prepareKey: 'analog-us',
    setup: setupAnalogIndexUs, planDatabase: 'analogUs', coldSamples: 2, warmPerProcess: 3, concurrency: [1, 2],
    async request(context) {
      return context.callRoute('app/api/ml/historical-analogs/route.ts', `http://local.test/api/ml/historical-analogs?market=US&ticker=S00001&startDate=${analogStart}&endDate=${latest}&sort=similarity&recency=all&profile=balanced&limit=10&offset=0&minScore=0.15`, { key: 'analog-us' })
    }, describe: describeAnalogRows,
  },
]
