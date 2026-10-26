import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// @ts-expect-error Node 22+ provides node:sqlite; the installed @types/node version predates it.
import { DatabaseSync } from 'node:sqlite'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stockboard-us-sector-etf-detail-'))
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
  CREATE INDEX market_ohlcv_market_ticker_date_idx ON market_ohlcv_daily(market, ticker, date);
  CREATE TABLE market_daily_snapshots (
    market TEXT NOT NULL, ticker TEXT NOT NULL, date TEXT NOT NULL,
    ma_5 REAL, ma_25 REAL, ma_75 REAL, ma_150 REAL, ma_200 REAL, ma_300 REAL,
    weekly_ma_5 REAL, weekly_ma_13 REAL, weekly_ma_25 REAL, weekly_ma_50 REAL, weekly_ma_100 REAL,
    monthly_ma_3 REAL, monthly_ma_5 REAL, monthly_ma_10 REAL, monthly_ma_20 REAL, monthly_ma_25 REAL,
    daily_a_stage INTEGER, daily_b_stage INTEGER,
    weekly_a_stage INTEGER, weekly_b_stage INTEGER,
    monthly_a_stage INTEGER, monthly_b_stage INTEGER,
    PRIMARY KEY (market, ticker, date)
  );
  CREATE INDEX market_snapshots_market_date_ticker_idx ON market_daily_snapshots(market, date, ticker);
`)

const insertPrice = db.prepare(`
  INSERT INTO market_ohlcv_daily
    (market, ticker, date, open, high, low, close,
     adj_open, adj_high, adj_low, adj_close, volume, adj_volume,
     div_cash, split_factor, source, imported_at)
  VALUES ('US', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 'fixture-tiingo', 456)
`)
insertPrice.run('XLK', '2026-10-20', 200, 210, 190, 204, null, null, null, 102, 1_000, 2_000)
insertPrice.run('XLK', '2026-10-21', 204, 214, 200, 210, null, null, null, 105, 1_100, 2_200)
insertPrice.run('XLK', '2026-10-22', 210, 220, 208, 214, null, null, null, 107, 1_200, 2_400)
insertPrice.run('XLK', '2026-10-23', 216, 224, 212, 220, null, null, null, 110, 1_300, 2_600)
insertPrice.run('XLF', '2026-10-23', 50, 51, 49, 50, null, null, null, 50, 2_000, 2_000)
insertPrice.run('XLE', '2026-10-23', 90, 91, 89, 90, null, null, null, null, 800, null)

const insertSnapshot = db.prepare(`
  INSERT INTO market_daily_snapshots
    (market, ticker, date,
     ma_5, ma_25, ma_75, ma_150, ma_200, ma_300,
     weekly_ma_5, weekly_ma_13, weekly_ma_25, weekly_ma_50, weekly_ma_100,
     monthly_ma_3, monthly_ma_5, monthly_ma_10, monthly_ma_20, monthly_ma_25,
     daily_a_stage, daily_b_stage, weekly_a_stage, weekly_b_stage, monthly_a_stage, monthly_b_stage)
  VALUES ('US', 'XLK', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`)
insertSnapshot.run(
  '2026-10-17',
  100, 95, 90, 85, 82, 80,
  98, 94, 90, 86, 82,
  96, 92, 88, 84, 80,
  1, 2, 3, 4, 5, 6,
)
insertSnapshot.run(
  '2026-10-23',
  110, 100, 95, 90, 88, 85,
  108, 100, 94, 90, 85,
  106, 99, 93, 88, 84,
  1, 2, 3, 4, 5, 6,
)
db.close()

process.env.USE_LOCAL_DB = '1'
process.env.STOCKBOARD_DB_PATH = dbPath
process.env.SKIP_SCHEMA_ENSURE = '1'
delete process.env.TURSO_DATABASE_URL
delete process.env.TURSO_AUTH_TOKEN

async function main(): Promise<void> {
  const { NextRequest } = await import('next/server')
  const { GET } = await import('@/app/api/us/sector-etfs/[ticker]/route')
  const {
    loadUsSectorEtfDetail,
    resolveUsSectorEtfTicker,
  } = await import('@/lib/server/us-sector-etf-detail-read-model')

  try {
    const lowercaseResolution = resolveUsSectorEtfTicker('xlk')
    assert.equal(lowercaseResolution.status, 'valid')
    if (lowercaseResolution.status !== 'valid') throw new Error('XLK must resolve')
    assert.equal(lowercaseResolution.ticker, 'XLK')
    assert.equal(lowercaseResolution.catalog.ticker, 'XLK')
    assert.equal(resolveUsSectorEtfTicker('SPY').status, 'unsupported')
    assert.equal(resolveUsSectorEtfTicker('bad ticker').status, 'invalid')

    const detail = await loadUsSectorEtfDetail('XLK')
    assert.ok(detail)
    assert.equal(detail.asOfDate, '2026-10-23')
    assert.equal(detail.price.value, 110, 'adjusted close is the detail price basis')
    assert.equal(detail.price.previousValue, 107)
    assert.ok(Math.abs((detail.price.changePct ?? 0) - (3 / 107) * 100) < 1e-12)
    assert.equal(detail.lineage.priceBasis, 'tiingo_adj_ohlc_ratio_v1')
    assert.equal(detail.lineage.priceRequirement, 'ADJ_CLOSE_REQUIRED')
    assert.equal(detail.lineage.stageBasis, 'MARKET_DAILY_SNAPSHOTS_EXACT_AS_OF')
    assert.equal(detail.lineage.holdingsBasis, 'UNAVAILABLE_NO_APPROVED_SOURCE')
    assert.equal(detail.holdings.status, 'unavailable')
    assert.equal(detail.holdings.constituentsAvailable, false)
    assert.equal(detail.holdings.weightsAvailable, false)
    assert.match(detail.holdings.reason, /推定は行いません/)

    assert.equal(detail.history.length, 4)
    assert.equal(detail.history[0].date, '2026-10-20')
    assert.equal(detail.history.at(-1)?.date, '2026-10-23')
    assert.equal(detail.history[0].open, 100, 'missing adjusted open uses the approved adjusted-close ratio')
    assert.equal(detail.history[0].high, 105)
    assert.equal(detail.history[0].low, 95)
    assert.equal(detail.history[0].volume, 2_000)

    assert.equal(detail.stageCode, '123456')
    assert.equal(detail.stageDate, '2026-10-23')
    assert.equal(detail.movingAverages.daily.order, '5日 > 25日 > 75日 > 150日 > 200日 > 300日')
    assert.equal(detail.movingAverages.weekly.order, '5週 > 13週 > 25週 > 50週 > 100週')
    assert.equal(detail.movingAverages.monthly.order, '3月 > 5月 > 10月 > 20月 > 25月')
    assert.equal(detail.movingAverages.daily.angleObservationSteps, 1)
    assert.ok(detail.movingAverages.daily.angles.every((value) => value != null))

    const exactHistorical = await loadUsSectorEtfDetail('XLK', '2026-10-22')
    assert.ok(exactHistorical)
    assert.equal(exactHistorical.asOfDate, '2026-10-22')
    assert.equal(exactHistorical.price.value, 107)
    assert.equal(exactHistorical.stageDate, null, 'stage must not fall back from a non-matching snapshot date')
    assert.equal(exactHistorical.stageCode, null)
    assert.equal(exactHistorical.history.at(-1)?.date, '2026-10-22')

    assert.equal(await loadUsSectorEtfDetail('XLK', '2026-10-24'), null, 'unavailable date must not fall back')
    assert.equal(await loadUsSectorEtfDetail('XLE'), null, 'raw close without adj_close must remain unavailable')
    assert.equal(await loadUsSectorEtfDetail('SPY'), null, 'non-catalog ETFs are outside the detail contract')

    const okResponse = await GET(
      new NextRequest('http://localhost/api/us/sector-etfs/xlk?date=2026-10-23'),
      { params: Promise.resolve({ ticker: 'xlk' }) },
    )
    assert.equal(okResponse.status, 200)
    const okBody = await okResponse.json()
    assert.equal(okBody.success, true)
    assert.equal(okBody.data.catalog.ticker, 'XLK')
    assert.equal(okBody.data.asOfDate, '2026-10-23')

    const requestCases = [
      { url: 'http://localhost/api/us/sector-etfs/XLK?date=2026-02-30', ticker: 'XLK', status: 400, error: 'invalid_date' },
      { url: 'http://localhost/api/us/sector-etfs/XLK?date=2026-10-23&date=2026-10-22', ticker: 'XLK', status: 400, error: 'invalid_date' },
      { url: 'http://localhost/api/us/sector-etfs/XLK?foo=bar', ticker: 'XLK', status: 400, error: 'unsupported_query_parameter' },
      { url: 'http://localhost/api/us/sector-etfs/BAD', ticker: 'bad ticker', status: 400, error: 'invalid_ticker' },
      { url: 'http://localhost/api/us/sector-etfs/SPY', ticker: 'SPY', status: 404, error: 'unsupported_sector_etf' },
      { url: 'http://localhost/api/us/sector-etfs/XLK?date=2026-10-24', ticker: 'XLK', status: 404, error: 'unavailable_date' },
    ]
    for (const testCase of requestCases) {
      const response = await GET(
        new NextRequest(testCase.url),
        { params: Promise.resolve({ ticker: testCase.ticker }) },
      )
      assert.equal(response.status, testCase.status, testCase.url)
      assert.equal((await response.json()).error, testCase.error, testCase.url)
    }

    const modelSource = fs.readFileSync(path.join(process.cwd(), 'lib/server/us-sector-etf-detail-read-model.ts'), 'utf8')
    const pageSource = fs.readFileSync(path.join(process.cwd(), 'app/us/sector-etfs/[ticker]/page.tsx'), 'utf8')
    const listPageSource = fs.readFileSync(path.join(process.cwd(), 'app/us/sector-etfs/page.tsx'), 'utf8')
    assert.doesNotMatch(modelSource, /\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP)\b\s+/i)
    assert.doesNotMatch(modelSource, /(?:FROM|JOIN)\s+[^\n;]*(?:holding|constituent)/i)
    assert.match(modelSource, /adj_close IS NOT NULL/)
    assert.match(pageSource, /market="US"/)
    assert.match(pageSource, /構成銘柄・組入比率は利用できません/)
    assert.match(pageSource, /const retryHref = `\/us\/sector-etfs\/\$\{encodeURIComponent\(tickerResolution\.ticker\)\}\$\{requestedDate \? `\?date=\$\{encodeURIComponent\(requestedDate\)\}` : ''\}`/)
    assert.match(pageSource, /action=\{<Link href=\{retryHref\} prefetch=\{false\} className="btn" data-size="sm">再読み込み<\/Link>\}/)
    assert.doesNotMatch(pageSource, /['"]use client['"]/)
    assert.doesNotMatch(pageSource, /holding(?:s)?\.map/i, 'unavailable holdings must never be rendered as inferred rows')
    assert.match(listPageSource, /\/us\/sector-etfs\/\$\{encodeURIComponent\(metric\.ticker\)\}/)
    assert.match(listPageSource, /date=\$\{encodeURIComponent\(asOfDate\)\}/)

    console.log('US sector ETF detail fixture, API, and page contract tests: PASS')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
