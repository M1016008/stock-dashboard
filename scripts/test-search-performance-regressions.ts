import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClient } from '@libsql/client'
import { KeyedSingleflight } from '@/lib/server/keyed-singleflight'
import type { ExactCandidate } from '@/app/api/ml/historical-analogs/route'

const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockboard-search-performance-'))
const databasePath = path.join(runtimeDir, 'stockboard.db')
const analogPath = path.join(runtimeDir, 'analog-jp.db')
const servingCachePath = path.join(runtimeDir, 'serving-cache.db')
Object.assign(process.env, {
  NODE_ENV: 'test',
  EXTERNAL_STORAGE_REQUIRED: 'false',
  USE_LOCAL_DB: '1',
  STOCKBOARD_DB_PATH: databasePath,
  ANALOG_JP_DB_PATH: analogPath,
  SERVING_CACHE_DB_PATH: servingCachePath,
  STOCK_DATA_INCIDENT_DIR: path.join(runtimeDir, 'incidents'),
})
process.once('exit', () => fs.rmSync(runtimeDir, { recursive: true, force: true }))

function tradingDates(count: number): string[] {
  const dates: string[] = []
  const current = new Date('2025-01-01T00:00:00.000Z')
  while (dates.length < count) {
    const day = current.getUTCDay()
    if (day !== 0 && day !== 6) dates.push(current.toISOString().slice(0, 10))
    current.setUTCDate(current.getUTCDate() + 1)
  }
  return dates
}

async function testKeyedSingleflight(): Promise<{ executions: number; maxActive: number }> {
  const coordinator = new KeyedSingleflight(2)
  let executions = 0
  const sameKey = await Promise.all(Array.from({ length: 8 }, () => coordinator.run('same', async () => {
    executions += 1
    await new Promise((resolve) => setTimeout(resolve, 10))
    return 'shared'
  })))
  assert.deepEqual(sameKey, Array(8).fill('shared'))
  assert.equal(executions, 1, 'same-key work must execute exactly once')

  let active = 0
  let maxActive = 0
  await Promise.all(Array.from({ length: 6 }, (_, index) => coordinator.run(`key-${index}`, async () => {
    active += 1
    maxActive = Math.max(maxActive, active)
    await new Promise((resolve) => setTimeout(resolve, 8))
    active -= 1
  })))
  assert.equal(maxActive, 2, 'different keys must use the configured bounded concurrency')
  return { executions, maxActive }
}

async function seedSyntheticDatabase(): Promise<{ dates: string[]; tickers: string[] }> {
  const { ensureReady, execBatch } = await import('@/lib/db/client')
  await ensureReady()
  const dates = tradingDates(320)
  const periodTickers = ['1000', '1001', '1002', '1003']
  const universe = [
    ['1000', 'Alpha Holdings'],
    ['1001', 'Alpha'],
    ['1002', 'Alphabet Systems'],
    ['1003', 'Beta Industries'],
    ['ALPHA', 'Alpha Ticker'],
    ['9001', 'Rate 100%'],
    ['9002', 'Rate 100X'],
    ['9003', 'Under_score'],
    ['9004', 'UnderXscore'],
    ['9005', 'Slash\\Name'],
  ] as const
  const statements: Array<{ sql: string; args: Array<string | number> }> = []
  for (const [index, [ticker, name]] of universe.entries()) {
    statements.push({
      sql: `INSERT INTO ticker_universe (
        ticker, name, active, added_at, shares_outstanding, shares_updated_at,
        sector17_name, sector33_name, market_segment, margin_type
      ) VALUES (?, ?, 1, 100, ?, 100, ?, ?, 'Prime', '貸借')`,
      args: [ticker, name, 1_000_000 + index * 10_000, `Sector17-${index % 2}`, `Sector33-${index % 2}`],
    })
    statements.push({
      sql: 'INSERT INTO stock_classification(ticker, major_category, sub_industry, updated_at) VALUES (?, ?, ?, 100)',
      args: [ticker, ticker === '1003' ? 'Alpha' : `Major-${index % 3}`, `Sub-${index}`],
    })
  }
  for (const date of dates) {
    statements.push({
      sql: 'INSERT INTO serving_daily_snapshot_dates(date, tickers, computed_at) VALUES (?, ?, 100)',
      args: [date, periodTickers.length],
    })
  }
  for (const [tickerIndex, ticker] of periodTickers.entries()) {
    for (const [dateIndex, date] of dates.entries()) {
      const close = 80 + tickerIndex * 17 + dateIndex * (0.04 + tickerIndex * 0.01) + Math.sin(dateIndex / 11)
      statements.push({
        sql: 'INSERT INTO ohlcv_daily(ticker, date, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?)',
        args: [ticker, date, close - 0.5, close + 1.5, close - 1.5, close, 10_000 + tickerIndex * 1_000 + dateIndex],
      })
    }
    statements.push({
      sql: `INSERT INTO historical_universe (
        ticker, name, first_trade_date, last_trade_date, latest_ohlcv_date, status
      ) VALUES (?, ?, ?, ?, ?, 'active')`,
      args: [ticker, `Company ${ticker}`, dates[0], dates.at(-1)!, dates.at(-1)!],
    })
    for (const [offset, date] of [[20, dates.at(-20)!], [1, dates.at(-1)!]] as const) {
      const close = 100 + tickerIndex * 10 + offset
      statements.push({
        sql: `INSERT INTO daily_snapshots (
          ticker, date, ma_5, ma_25, ma_75,
          daily_a_stage, daily_b_stage, weekly_a_stage, weekly_b_stage, monthly_a_stage, monthly_b_stage,
          computed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 100)`,
        args: [ticker, date, close + 1, close, close - 1, 1 + tickerIndex, 2 + tickerIndex, 2, 2, 3, 3],
      })
    }
    statements.push({
      sql: `INSERT INTO valuation_daily_serving (
        ticker, valuation_date, price_date, price, per, forward_per, pbr, basis_id, calculated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 100)`,
      args: [ticker, dates.at(-1)!, dates.at(-1)!, 100 + tickerIndex, 10 + tickerIndex, 11 + tickerIndex, 1 + tickerIndex / 10, `basis-${ticker}`],
    })
  }
  for (let index = 0; index < statements.length; index += 200) {
    await execBatch(statements.slice(index, index + 200))
  }
  return { dates, tickers: periodTickers }
}

async function testJpSearch(): Promise<void> {
  const { NextRequest } = await import('next/server')
  const { GET } = await import('@/app/api/search/route')
  const search = async (query: string) => {
    const response = await GET(new NextRequest(`http://local.test/api/search?q=${encodeURIComponent(query)}`))
    assert.equal(response.status, 200)
    return await response.json() as Array<{ ticker: string }>
  }
  assert.deepEqual(
    (await search('alpha')).map((row) => row.ticker).slice(0, 5),
    ['ALPHA', '1001', '1003', '1000', '1002'],
    'exact matches must precede prefix matches with deterministic ticker ties',
  )
  assert.deepEqual((await search('%')).map((row) => row.ticker), ['9001'])
  assert.deepEqual((await search('_')).map((row) => row.ticker), ['9003'])
  assert.deepEqual((await search('\\')).map((row) => row.ticker), ['9005'])
}

async function testPeriodExplorer(dates: string[]): Promise<{ coldQueries: number; warmQueries: number }> {
  const { queryPeriodExplorer } = await import('@/lib/server/period-explorer-read-model')
  const from = dates.at(-20)!
  const to = dates.at(-1)!
  let queries = 0
  ;(globalThis as { __phase16dQaSqlQuery?: (count?: number) => void }).__phase16dQaSqlQuery =
    (count = 1) => { queries += count }
  const full = await queryPeriodExplorer({ from, to, ranking: 'return_up', limit: 500 })
  const coldQueries = queries
  assert.equal(full.total, 4)
  queries = 0
  const first = await queryPeriodExplorer({ from, to, ranking: 'return_up', limit: 2, offset: 0 })
  const second = await queryPeriodExplorer({ from, to, ranking: 'return_up', limit: 2, offset: 2 })
  const warmQueries = queries
  assert.ok(
    warmQueries <= coldQueries * 2,
    `pagination query work must stay bounded (cold=${coldQueries}, paged=${warmQueries})`,
  )
  assert.deepEqual([...first.rows, ...second.rows], full.rows, 'paged rows must exactly equal the unpaged result')
  const afterPaginationQueries = queries
  const filtered = await queryPeriodExplorer({
    from,
    to,
    ranking: 'return_up',
    filters: { markets: ['Prime'], avgVolumeMin: 1 },
    sort: 'avgVolume',
    limit: 500,
  })
  const filteredQueries = queries - afterPaginationQueries
  assert.ok(
    filteredQueries <= coldQueries * 2,
    `filter and sort query work must stay bounded (cold=${coldQueries}, filtered=${filteredQueries})`,
  )
  assert.deepEqual(
    new Set(filtered.rows.map((row) => row.rowType === 'stock' ? row.ticker : '')),
    new Set(full.rows.map((row) => row.rowType === 'stock' ? row.ticker : '')),
  )
  for (const ranking of [
    'volume_increase',
    'realized_volatility',
    'high_52_proximity',
    'stage_improve',
    'sector_avg_return',
  ] as const) {
    const beforeRankingQueries = queries
    const allRows = await queryPeriodExplorer({ from, to, ranking, limit: 500 })
    const afterRankingQueries = queries
    const pageSize = 2
    const pages = await Promise.all(Array.from(
      { length: Math.ceil(allRows.total / pageSize) },
      (_, page) => queryPeriodExplorer({ from, to, ranking, limit: pageSize, offset: page * pageSize }),
    ))
    assert.deepEqual(
      pages.flatMap((page) => page.rows),
      allRows.rows,
      `${ranking} pagination must preserve exact range-core results`,
    )
    const rankingColdQueries = afterRankingQueries - beforeRankingQueries
    const rankingPageQueries = queries - afterRankingQueries
    assert.ok(
      rankingPageQueries <= Math.max(coldQueries * Math.ceil(allRows.total / pageSize), rankingColdQueries * 2),
      `${ranking} pagination query work must stay bounded (cold=${rankingColdQueries}, paged=${rankingPageQueries})`,
    )
  }
  delete (globalThis as { __phase16dQaSqlQuery?: (count?: number) => void }).__phase16dQaSqlQuery
  return { coldQueries, warmQueries }
}

async function testIntegratedScreener(asOf: string): Promise<{
  baselineQueries: number
  concurrentQueries: number
}> {
  const { buildScreeningServingDate, queryIntegratedScreener } = await import('@/lib/server/integrated-screener-serving')
  const { execGet, execRun } = await import('@/lib/db/client')
  let queries = 0
  ;(globalThis as { __phase16dQaSqlQuery?: (count?: number) => void }).__phase16dQaSqlQuery =
    (count = 1) => { queries += count }
  const initial = await buildScreeningServingDate(asOf, true)
  const baselineQueries = queries
  assert.equal(initial.cacheHit, false)

  await execRun("UPDATE stock_classification SET updated_at=200 WHERE ticker='1003'")
  queries = 0
  const concurrent = await Promise.all(Array.from({ length: 4 }, () => buildScreeningServingDate(asOf)))
  const concurrentQueries = queries
  assert.equal(new Set(concurrent.map((result) => result.sourceVersion)).size, 1)
  assert.equal(
    concurrentQueries,
    baselineQueries + 3 * (concurrent.length - 1),
    'concurrent cold callers may probe latest date, generation metadata, and source freshness, but must share one materialization build',
  )
  const stored = await execGet<{ calculated_at: number; source_version: string }>(`
    SELECT calculated_at, source_version FROM stock_screening_serving_dates WHERE as_of = ?
  `, [asOf])
  assert.equal(concurrent[0].calculatedAt, Number(stored?.calculated_at))
  assert.equal(concurrent[0].sourceVersion, stored?.source_version)

  await execRun('UPDATE stock_screening_serving_dates SET calculated_at=? WHERE as_of=?', [1_234_567_890, asOf])
  const storedTimeResponse = await queryIntegratedScreener({ asOf, sort: 'marketCap', limit: 3 })
  assert.equal(storedTimeResponse.servingBuiltAt, 1_234_567_890, 'response must return the stored build time')

  queries = 0
  const warm = await queryIntegratedScreener({ asOf, sort: 'marketCap', limit: 3 })
  assert.equal(warm.cacheHit, true)
  assert.equal(queries, 1, 'a warm response must retain one data_version probe and avoid metadata rereads')
  await execRun(`
    UPDATE stock_classification
    SET major_category='Changed Alpha', updated_at=300
    WHERE ticker='1003'
  `)
  const refreshed = await queryIntegratedScreener({ asOf, sort: 'marketCap', limit: 3 })
  assert.equal(refreshed.cacheHit, false, 'source-generation changes must bypass the response cache')
  const refreshedRow = refreshed.rows.find((row) => row.ticker === '1003')
  assert.equal(refreshedRow?.majorCategory, 'Changed Alpha')
  const externalWriter = createClient({ url: `file:${databasePath}` })
  try {
    await externalWriter.execute({
      sql: "UPDATE stock_classification SET major_category='External Alpha', updated_at=350 WHERE ticker='1003'",
      args: [],
    })
  } finally {
    externalWriter.close()
  }
  const externallyRefreshed = await queryIntegratedScreener({ asOf, sort: 'marketCap', limit: 3 })
  assert.equal(externallyRefreshed.cacheHit, false, 'external SQLite commits must invalidate the source watermark cache')
  assert.equal(externallyRefreshed.rows.find((row) => row.ticker === '1003')?.majorCategory, 'External Alpha')
  const generation = await execGet<{ source_version: string; row_count: number }>(`
    SELECT source_version, row_count FROM stock_screening_serving_dates WHERE as_of=?
  `, [asOf])
  assert.match(generation?.source_version ?? '', /^pit-v1:/, 'published current generations must remain usable as certified history')
  const generationRows = await execGet<{ rows: number; mixed: number }>(`
    SELECT COUNT(*) AS rows,
      SUM(CASE WHEN source_version <> ? THEN 1 ELSE 0 END) AS mixed
    FROM stock_screening_serving WHERE as_of=?
  `, [generation?.source_version ?? '', asOf])
  assert.equal(Number(generationRows?.rows), Number(generation?.row_count))
  assert.equal(Number(generationRows?.mixed), 0, 'published serving rows must belong to one atomic source generation')
  await execRun(
    "INSERT INTO daily_snapshots(ticker,date,computed_at) VALUES ('1000','2099-01-04',400)",
  )
  const historical = await buildScreeningServingDate(asOf)
  assert.equal(historical.cacheHit, true, 'a generation certified when current must remain readable after date rollover')
  assert.equal(historical.sourceVersion, generation?.source_version)
  await assert.rejects(
    () => buildScreeningServingDate('2025-01-02'),
    /certified point-in-time generation/,
    'historical screens without certified PIT inputs must fail closed',
  )
  delete (globalThis as { __phase16dQaSqlQuery?: (count?: number) => void }).__phase16dQaSqlQuery
  return { baselineQueries, concurrentQueries }
}

function presentationCandidate(ticker: string, startDate: string, endDate: string): ExactCandidate {
  return {
    ticker,
    startDate,
    middleDate: startDate,
    endDate,
    score: 0.9,
    dailyScore: 0.9,
    weeklyScore: 0.9,
    monthlyScore: 0.9,
    yearlyScore: 0.9,
    mlFeatureScore: null,
    mlFeaturePointCount: 0,
    mlFeatureTotalPoints: 3,
    components: [],
    approximationScore: 0.8,
    bandMatches: 2,
    stageCode: null,
  }
}

async function testAnalogPresentationBatching(): Promise<{ batchedQueries: number; referenceQueries: number }> {
  const { loadPresentations } = await import('@/lib/server/historical-analog-presentations')
  const dates = Array.from({ length: 800 }, (_, index) => {
    const date = new Date(Date.UTC(2023, 0, 1 + index)).toISOString().slice(0, 10)
    return date
  })
  const prices = ['AAA', 'BBB'].flatMap((ticker, tickerIndex) => dates.map((date, index) => {
    const close = 50 + tickerIndex * 20 + index * 0.05 + Math.sin(index / 9)
    return { ticker, date, open: close - 1, high: close + 2, low: close - 2, close, volume: 1_000 + index }
  }))
  const candidates = [
    presentationCandidate('AAA', dates[600], dates[640]),
    presentationCandidate('BBB', dates[610], dates[650]),
  ]
  let queryCount = 0
  const fakeDb = {
    all: async <T>(_sql: string, args: readonly (string | number | null)[] = []): Promise<T[]> => {
      queryCount += 1
      const ranges = Array.from({ length: args.length / 3 }, (_, index) => ({
        ticker: String(args[index * 3]),
        from: String(args[index * 3 + 1]),
        to: String(args[index * 3 + 2]),
      }))
      return prices.filter((row) => ranges.some((range) =>
        row.ticker === range.ticker && row.date >= range.from && row.date <= range.to
      )) as T[]
    },
    get: async <T>(): Promise<T | undefined> => undefined,
  }
  const batched = await loadPresentations(fakeDb as never, candidates)
  const batchedQueries = queryCount
  assert.equal(batchedQueries, 1, 'one page of presentations must use one OHLCV query')

  queryCount = 0
  const reference = new Map<string, unknown>()
  for (const candidate of candidates) {
    const perTicker = await loadPresentations(fakeDb as never, [candidate])
    for (const [key, value] of perTicker) reference.set(key, value)
  }
  const referenceQueries = queryCount
  assert.equal(referenceQueries, 2)
  assert.deepEqual([...batched.entries()], [...reference.entries()], 'batched presentation output must be exact')
  return { batchedQueries, referenceQueries }
}

async function seedAnalogIndex(sourceDate: string, version: number): Promise<void> {
  const client = createClient({ url: `file:${analogPath}` })
  await client.execute('CREATE TABLE analog_sequence_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  const values: Record<string, string> = {
    version: String(version),
    source_date: sourceDate,
    coverage_from: '2020-01-01',
    coverage_to: sourceDate,
    row_count: '1',
    completed: '1',
    updated_at: sourceDate,
    feature_schema: 'fixture',
    embedding_bytes: '1',
    price_source_date: sourceDate,
    price_completed: '1',
    price_chunks_source_date: sourceDate,
    price_chunks_completed: '1',
  }
  await client.batch(Object.entries(values).map(([key, value]) => ({
    sql: 'INSERT INTO analog_sequence_meta(key, value) VALUES (?, ?)',
    args: [key, value],
  })))
  client.close()
}

async function testAnalogEarlyCache(dates: string[]): Promise<number> {
  const { NextRequest } = await import('next/server')
  const { MA_SEQUENCE_VERSION } = await import('@/lib/ml/ma-sequence')
  await seedAnalogIndex(dates.at(-1)!, MA_SEQUENCE_VERSION)
  const route = await import('@/app/api/ml/historical-analogs/route')
  const cache = await import('@/lib/server/historical-analog-cache')
  const { writeServingCache } = await import('@/lib/api/serving-cache')
  const requestedStartDate = dates.at(-15)!
  const requestedEndDate = dates.at(-1)!
  const key = cache.historicalAnalogResponseCacheKey({
    market: 'JP',
    ticker: '1000',
    requestedStartDate,
    requestedEndDate,
    latestMarketDate: requestedEndDate,
    indexSourceDate: requestedEndDate,
    indexUpdatedAt: requestedEndDate,
    sourceGeneration: cache.historicalAnalogSourceGeneration('JP'),
    profile: 'balanced',
    recency: 'all',
    sort: 'similarity',
    minScore: 0.4,
    limit: 20,
    offset: 0,
  })
  await writeServingCache(
    route.HISTORICAL_ANALOG_CACHE_NAMESPACE,
    key,
    { marker: 'early-cache' },
    60_000,
  )
  let queries = 0
  ;(globalThis as { __phase16dQaSqlQuery?: (count?: number) => void }).__phase16dQaSqlQuery =
    (count = 1) => { queries += count }
  const response = await route.GET(new NextRequest(
    `http://local.test/api/ml/historical-analogs?ticker=1000&startDate=${requestedStartDate}&endDate=${requestedEndDate}`,
  ))
  assert.equal(response.status, 200)
  assert.equal((await response.json() as { marker?: string }).marker, 'early-cache')
  assert.equal(queries, 1, 'cached analog requests must only read the latest market date from the main DB')
  delete (globalThis as { __phase16dQaSqlQuery?: (count?: number) => void }).__phase16dQaSqlQuery
  const generationProbe = path.join(runtimeDir, 'generation-probe.db')
  fs.writeFileSync(generationProbe, 'before')
  const beforeGeneration = cache.historicalAnalogFileGeneration([generationProbe])
  fs.appendFileSync(generationProbe, '-after')
  assert.notEqual(
    cache.historicalAnalogFileGeneration([generationProbe]),
    beforeGeneration,
    'same-date source mutations must invalidate historical analog caches',
  )
  return queries
}

async function main(): Promise<void> {
  const concurrency = await testKeyedSingleflight()
  const fixture = await seedSyntheticDatabase()
  await testJpSearch()
  const period = await testPeriodExplorer(fixture.dates)
  const integrated = await testIntegratedScreener(fixture.dates.at(-1)!)
  const presentation = await testAnalogPresentationBatching()
  const analogCacheQueries = await testAnalogEarlyCache(fixture.dates)
  console.log(JSON.stringify({
    ok: true,
    concurrency,
    period,
    integrated,
    presentation,
    analogCacheQueries,
  }))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
