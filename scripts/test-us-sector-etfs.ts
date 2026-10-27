import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// @ts-expect-error Node 22+ provides node:sqlite; the installed @types/node version predates it.
import { DatabaseSync } from 'node:sqlite'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stockboard-us-sector-etfs-'))
const dbPath = path.join(root, 'fixture.db')
const db = new DatabaseSync(dbPath)

db.exec(`
  CREATE TABLE market_ohlcv_daily (
    market TEXT NOT NULL, ticker TEXT NOT NULL, date TEXT NOT NULL,
    open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL,
    adj_open REAL, adj_high REAL, adj_low REAL, adj_close REAL,
    volume INTEGER NOT NULL, adj_volume INTEGER, div_cash REAL, split_factor REAL,
    source TEXT NOT NULL, imported_at INTEGER NOT NULL,
    PRIMARY KEY (market, ticker, date)
  );
  CREATE INDEX market_ohlcv_market_date_idx ON market_ohlcv_daily(market, date);
  CREATE INDEX market_ohlcv_market_date_ticker_idx ON market_ohlcv_daily(market, date, ticker);
  CREATE INDEX market_ohlcv_market_ticker_date_idx ON market_ohlcv_daily(market, ticker, date);
  CREATE TABLE market_daily_snapshots (
    market TEXT NOT NULL, ticker TEXT NOT NULL, date TEXT NOT NULL,
    ma_5 REAL, ma_25 REAL, ma_75 REAL,
    daily_a_stage INTEGER, daily_b_stage INTEGER,
    weekly_a_stage INTEGER, weekly_b_stage INTEGER,
    monthly_a_stage INTEGER, monthly_b_stage INTEGER,
    PRIMARY KEY (market, ticker, date)
  );
  CREATE INDEX market_snapshots_market_date_ticker_idx ON market_daily_snapshots(market, date, ticker);
`)

const insertPrice = db.prepare(`
  INSERT INTO market_ohlcv_daily
    (market, ticker, date, open, high, low, close, adj_close, volume, source, imported_at)
  VALUES ('US', ?, ?, ?, ?, ?, ?, ?, ?, 'fixture-tiingo', 123)
`)
insertPrice.run('XLK', '2026-10-22', 200, 205, 198, 204, 102, 1000)
insertPrice.run('XLK', '2026-10-23', 210, 215, 208, 214, 107, 1100)
insertPrice.run('XLF', '2026-10-22', 50, 51, 49, 50, 50, 2000)
insertPrice.run('XLF', '2026-10-23', 49, 50, 48, 49, 49, 2100)
insertPrice.run('XLE', '2026-10-23', 90, 91, 89, 90, null, 800)

const insertSnapshot = db.prepare(`
  INSERT INTO market_daily_snapshots
    (market, ticker, date, ma_5, ma_25, ma_75, daily_a_stage, daily_b_stage,
     weekly_a_stage, weekly_b_stage, monthly_a_stage, monthly_b_stage)
  VALUES ('US', ?, '2026-10-23', ?, ?, ?, ?, ?, ?, ?, ?, ?)
`)
insertSnapshot.run('XLK', 105, 100, 95, 1, 2, 3, 4, 5, 6)
insertSnapshot.run('XLF', 48, 49, 50, 4, 4, 4, 4, 4, 4)
db.close()

process.env.USE_LOCAL_DB = '1'
process.env.STOCKBOARD_DB_PATH = dbPath
process.env.SKIP_SCHEMA_ENSURE = '1'
delete process.env.TURSO_DATABASE_URL
delete process.env.TURSO_AUTH_TOKEN

async function main(): Promise<void> {
  const { NextRequest } = await import('next/server')
  const { GET } = await import('@/app/api/us/sector-etfs/route')
  const { US_SECTOR_ETF_CATALOG, loadUsSectorEtfBoard } = await import('@/lib/server/us-sector-etf-read-model')

  try {
    assert.equal(US_SECTOR_ETF_CATALOG.length, 11)
    assert.equal(new Set(US_SECTOR_ETF_CATALOG.map((item) => item.ticker)).size, 11)

    const board = await loadUsSectorEtfBoard()
    assert.equal(board.status, 'ready')
    assert.equal(board.asOfDate, '2026-10-23')
    assert.equal(board.lineage.priceBasis, 'ADJUSTED_CLOSE')
    assert.equal(board.lineage.holdingsBasis, 'UNAVAILABLE')
    assert.deepEqual(board.lineage.sources, ['fixture-tiingo'])
    assert.equal(board.coverage.catalog, 11)
    assert.equal(board.coverage.priced, 2, 'raw close without adj_close must remain unavailable')
    assert.equal(board.coverage.completeStage, 2)
    assert.ok(board.coverage.missingPriceTickers.includes('XLE'))

    const technology = board.metrics.find((metric) => metric.ticker === 'XLK')
    assert.ok(technology)
    assert.equal(technology.price, 107, 'adjusted close is the only price basis')
    assert.equal(technology.previousPrice, 102)
    assert.ok(Math.abs((technology.changePct ?? 0) - (5 / 102) * 100) < 1e-12)
    assert.equal(technology.stageCode, '123456')
    assert.equal(technology.maOrderDaily, '5日 > 25日 > 75日')

    const unavailable = await loadUsSectorEtfBoard('2026-10-24')
    assert.equal(unavailable.status, 'empty', 'an unavailable requested day must not fall back')
    assert.equal(unavailable.asOfDate, null)

    const okResponse = await GET(new NextRequest('http://localhost/api/us/sector-etfs?date=2026-10-23'))
    assert.equal(okResponse.status, 200)
    const okBody = await okResponse.json()
    assert.equal(okBody.success, true)
    assert.equal(okBody.data.asOfDate, '2026-10-23')

    const unavailableResponse = await GET(new NextRequest('http://localhost/api/us/sector-etfs?date=2026-10-24'))
    assert.equal(unavailableResponse.status, 404)
    assert.equal((await unavailableResponse.json()).error, 'unavailable_date')

    for (const url of [
      'http://localhost/api/us/sector-etfs?date=2026-02-30',
      'http://localhost/api/us/sector-etfs?date=2026-10-23&date=2026-10-22',
    ]) {
      const response = await GET(new NextRequest(url))
      assert.equal(response.status, 400)
      assert.equal((await response.json()).error, 'invalid_date')
    }

    const modelSource = fs.readFileSync(path.join(process.cwd(), 'lib/server/us-sector-etf-read-model.ts'), 'utf8')
    assert.doesNotMatch(modelSource, /\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP)\b\s+/i)
    assert.match(modelSource, /adj_close/)
    assert.doesNotMatch(
      modelSource,
      /(?:FROM|JOIN)\s+[^\n;]*(?:holding|constituent)/i,
      'read model must not query ETF holdings or constituent tables',
    )
    console.log('US sector ETF fixture and API contract tests: PASS')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
