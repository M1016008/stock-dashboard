import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
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
    { sql: `CREATE TABLE market_ohlcv_daily (
      market TEXT NOT NULL, ticker TEXT NOT NULL, date TEXT NOT NULL,
      open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL, volume INTEGER NOT NULL,
      adj_open REAL, adj_high REAL, adj_low REAL, adj_close REAL, adj_volume REAL,
      PRIMARY KEY (market, ticker, date)
    )` },
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

  process.env.USE_LOCAL_DB = '1'
  process.env.STOCKBOARD_DB_PATH = databasePath
  process.env.STOCKBOARD_DB_READ_CONCURRENCY = '0'

  const { loadTwoYearLineSearchEntries, selectTwoYearLineSummary } = await import('../lib/server/two-year-line-search')

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
    tickers: ['JP-LINE'],
    asOfDate: '2028-01-05',
  })
  assert.equal(calendarClipped.metadata.asOfDate, '2027-12-30')

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
