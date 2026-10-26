import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { NextRequest } from 'next/server'
import {
  US_DAILY_CLOSE_MAX_UNIVERSE,
  buildUsDailyCloseReport,
  isUsDailyCloseDate,
  type UsDailyCloseServingRow,
} from '@/lib/server/us-daily-close-report'
import { GET } from '@/app/api/us/daily-close/route'

const root = process.cwd()
const serverSource = fs.readFileSync(path.join(root, 'lib/server/us-daily-close-report.ts'), 'utf8')
const routeSource = fs.readFileSync(path.join(root, 'app/api/us/daily-close/route.ts'), 'utf8')
const pageSource = fs.readFileSync(path.join(root, 'app/us/daily-close/page.tsx'), 'utf8')

assert.equal(isUsDailyCloseDate('2026-10-26'), true)
assert.equal(isUsDailyCloseDate('2024-02-29'), true)
assert.equal(isUsDailyCloseDate('2026-02-29'), false)
assert.equal(isUsDailyCloseDate('2026-1-02'), false)
assert.equal(isUsDailyCloseDate(''), false)

const baseStages = {
  dayB: 2, weekA: 3, weekB: 4, monthA: 5, monthB: 6,
  prevDayB: 2, prevWeekA: 3, prevWeekB: 4, prevMonthA: 5, prevMonthB: 6,
}
const rows: UsDailyCloseServingRow[] = [
  {
    ticker: 'AAA', name: 'Alpha', sector: 'Technology',
    close0: 110, close1: 100, close2: 98, close5: 95, close10: 90, close20: 80,
    currentVolume: 200, avgVolume20: 100,
    dayA: 5, prevDayA: 4, ...baseStages,
  },
  {
    ticker: 'BBB', name: 'Beta', sector: 'Finance',
    close0: 90, close1: 100, close2: 102, close5: 105, close10: 110, close20: 120,
    currentVolume: 50, avgVolume20: 100,
    dayA: 2, prevDayA: 2, ...baseStages,
  },
  {
    ticker: 'CCC', name: null, sector: null,
    close0: 100, close1: 100, close2: 100, close5: 100, close10: 100, close20: 100,
    currentVolume: 10, avgVolume20: 0,
    dayA: null, prevDayA: null, ...baseStages,
  },
  {
    ticker: 'DDD', name: 'Delta', sector: 'Industrials',
    close0: 100, close1: null, close2: null, close5: null, close10: null, close20: null,
    currentVolume: 20, avgVolume20: null,
    dayA: 3, prevDayA: null, ...baseStages,
  },
]

const report = buildUsDailyCloseReport({
  requestedDate: null,
  dates: {
    latestDate: '2026-10-26', asOfDate: '2026-10-26', previousDate: '2026-10-23',
    snapshotDate: '2026-10-26', previousSnapshotDate: '2026-10-23',
  },
  rows,
  benchmarks: [
    { ticker: 'SPY', close0: 505, close1: 500 },
    { ticker: 'QQQ', close0: 490, close1: 500 },
  ],
  earnings: [
    { ticker: 'BBB', name: 'Beta', reportDate: '2026-10-29', timeBucket: 'after_close', source: 'finnhub' },
    { ticker: 'AAA', name: 'Alpha', reportDate: '2026-10-28', timeBucket: 'before_open', source: 'finnhub' },
  ],
  generatedAt: '2026-10-26T20:00:00.000Z',
})

assert.equal(report.status, 'ready')
assert.equal(report.marketCode, 'US')
assert.equal(report.current, true)
assert.equal(report.priceBasis, 'COALESCE(adj_close, close)')
assert.equal(report.classificationBasis, 'CURRENT_REFERENCE')
assert.deepEqual(
  [report.market.advances, report.market.declines, report.market.unchanged, report.market.unobserved],
  [1, 1, 1, 1],
)
assert.equal(report.market.adjustedTurnoverUsd, 29_500)
assert.equal(report.coverage.observedRows, 4)
assert.equal(report.coverage.pricedRows, 4)
assert.equal(report.coverage.classifiedRows, 3)
assert.equal(report.leaders.gainers[0]?.ticker, 'AAA')
assert.equal(report.leaders.decliners[0]?.ticker, 'BBB')
assert.equal(report.leaders.volumeSpikes[0]?.ticker, 'AAA')
assert.equal(report.leaders.volumeSpikes[0]?.volumeRatio, 2)
assert.equal(report.leaders.stageImproving[0]?.ticker, 'AAA')
assert.deepEqual(report.leaders.stageImproving[0]?.changes, ['日A S4→S5'])
assert.equal(report.sectors.length, 3)
assert.ok(Math.abs((report.benchmarks.find((row) => row.ticker === 'SPY')?.changePct ?? 0) - 1) < 1e-9)
assert.equal(report.benchmarks.find((row) => row.ticker === 'DIA')?.price, null)
assert.deepEqual(report.earnings.rows.map((row) => row.ticker), ['AAA', 'BBB'])
assert.equal(report.unavailable.ownership.status, 'UNAVAILABLE')
assert.match(report.unavailable.ownership.reason, /代替しません/)
assert.equal(report.unavailable.news.status, 'UNAVAILABLE')
assert.match(report.unavailable.news.reason, /推測しません/)
assert.ok(report.limitations.some((item) => item.includes('StockBoard派生Sector')))

const staleEarnings = buildUsDailyCloseReport({
  requestedDate: null,
  dates: {
    latestDate: '2026-10-26', asOfDate: '2026-10-26', previousDate: '2026-10-23',
    snapshotDate: '2026-10-26', previousSnapshotDate: '2026-10-23',
  },
  rows,
  earnings: [],
  earningsStatus: 'unavailable',
})
assert.equal(staleEarnings.current, true)
assert.equal(staleEarnings.earnings.status, 'unavailable')
assert.ok(staleEarnings.limitations.some((item) => item.includes('同期範囲または鮮度')))

const laggingSnapshot = buildUsDailyCloseReport({
  requestedDate: null,
  dates: {
    latestDate: '2026-10-26', asOfDate: '2026-10-26', previousDate: '2026-10-23',
    snapshotDate: '2026-10-23', previousSnapshotDate: '2026-10-22',
  },
  rows,
})
assert.equal(laggingSnapshot.current, true, 'latest price date remains current even when Stage snapshot is older')
assert.equal(laggingSnapshot.classificationBasis, 'CURRENT_REFERENCE')
assert.equal(laggingSnapshot.coverage.classifiedRows, 3)
assert.equal(laggingSnapshot.snapshotDate, '2026-10-23')

const empty = buildUsDailyCloseReport({
  requestedDate: '2020-01-01',
  dates: { latestDate: '2026-10-26', asOfDate: null, previousDate: null, snapshotDate: null, previousSnapshotDate: null },
  rows: [],
  generatedAt: '2026-10-26T20:00:00.000Z',
})
assert.equal(empty.status, 'empty')
assert.equal(empty.asOfDate, null)
assert.equal(empty.current, false)

const historical = buildUsDailyCloseReport({
  requestedDate: '2026-10-23',
  dates: {
    latestDate: '2026-10-26', asOfDate: '2026-10-23', previousDate: '2026-10-22',
    snapshotDate: '2026-10-23', previousSnapshotDate: '2026-10-22',
  },
  rows,
  earnings: [],
  earningsStatus: 'unavailable',
})
assert.equal(historical.earnings.status, 'unavailable')
assert.equal(historical.earnings.rows.length, 0)
assert.equal(historical.classificationBasis, 'UNAVAILABLE_HISTORICAL')
assert.equal(historical.coverage.classifiedRows, 0)
assert.equal(historical.sectors.length, 0)
assert.ok(historical.leaders.gainers.every((row) => row.sector == null))
assert.ok(historical.limitations.some((item) => item.includes('imported_at')))

assert.throws(() => buildUsDailyCloseReport({
  requestedDate: null,
  dates: { latestDate: null, asOfDate: null, previousDate: null, snapshotDate: null, previousSnapshotDate: null },
  rows: Array(US_DAILY_CLOSE_MAX_UNIVERSE + 1).fill(rows[0]),
}), /us_daily_close_universe_limit_exceeded/)

assert.match(serverSource, /LIMIT \$\{US_DAILY_CLOSE_MAX_UNIVERSE \+ 1\}/)
assert.match(serverSource, /limit: US_DAILY_CLOSE_EARNINGS_LIMIT/)
assert.match(serverSource, /COALESCE\(o\.adj_close,o\.close\)/)
assert.match(serverSource, /market='US'/)
assert.match(serverSource, /ticker='SPY'/, 'US report calendar must be anchored to SPY sessions')
assert.match(serverSource, /SELECT date FROM market_ohlcv_daily\s+WHERE market='US' AND ticker='SPY' AND date<=\?/)
assert.match(serverSource, /currentPriceDate\s+\? loadEarningsState/)
assert.match(serverSource, /getUsEarningsCalendar/)
assert.match(serverSource, /'CURRENT_REFERENCE' : 'UNAVAILABLE_HISTORICAL'/)
assert.match(serverSource, /includeCurrentClassification/)
assert.doesNotMatch(serverSource, /FROM\s+(?:large_holder|large_holders|news|materials)\b/i)
assert.match(pageSource, /US Ownership: UNAVAILABLE/)
assert.match(pageSource, /US Materials \/ News: UNAVAILABLE/)
assert.match(pageSource, /別ソースや推定値へフォールバックしません/)
assert.match(pageSource, /StockBoard業種区分（SIC）/)
assert.match(pageSource, /action=\{<Link[\s\S]*>再試行<\/Link>\}/)
assert.doesNotMatch(pageSource, />Sector<\/th>/)
assert.match(pageSource, /report\.sectors\.length \? <Card/)
assert.match(pageSource, /過去日のセクター分類は利用できません/)
assert.match(pageSource, /決算予定を利用できません/)
assert.match(pageSource, /予定なしとして扱わず/)
assert.match(routeSource, /params\.getAll\('date'\)/)
assert.match(routeSource, /unknown\.length > 0/)
assert.match(routeSource, /status: 400/)

async function main() {
  async function expectBadRequest(url: string) {
    const response = await GET(new NextRequest(url))
    assert.equal(response.status, 400, url)
    assert.equal((await response.json()).error, 'invalid_us_daily_close_query')
  }

  await expectBadRequest('http://localhost/api/us/daily-close?date=2026-02-29')
  await expectBadRequest('http://localhost/api/us/daily-close?date=2026-10-26&date=2026-10-27')
  await expectBadRequest('http://localhost/api/us/daily-close?date=')
  await expectBadRequest('http://localhost/api/us/daily-close?limit=10')

  console.log('US Daily Close report tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
