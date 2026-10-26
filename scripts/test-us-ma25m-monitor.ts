import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  US_MONTHLY_MA_MONITOR_PERIODS,
  US_MONTHLY_MA_PRICE_BASIS,
  US_MONTHLY_MA_UNAVAILABLE_PERIODS,
  buildUsMonthlyMaHistory,
  buildUsMonthlyMaMonitorRows,
  filterUsMonthlyMaRows,
  parseUsMonthlyPeriod,
  summarizeUsMonthlyMaRows,
  usMonthlyMaLimitations,
  type UsMonthlyMaSourceRow,
} from '@/lib/us-ma25m-monitor'
import { US_ADJUSTED_PRICE_BASIS } from '@/lib/us-adjusted-ohlcv'
import { NextRequest } from 'next/server'
import { GET as getMonitorList } from '@/app/api/us/ma25m-monitor/route'
import { GET as getMonitorDetail } from '@/app/api/us/ma25m-monitor/[ticker]/route'

const root = process.cwd()

function weekdaySessions(count: number): string[] {
  const output: string[] = []
  const cursor = new Date('2026-08-03T00:00:00Z')
  while (output.length < count) {
    const day = cursor.getUTCDay()
    if (day !== 0 && day !== 6) output.push(cursor.toISOString().slice(0, 10))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return output
}

const dates = weekdaySessions(35)

function sourceRow(ticker: string, index: number): UsMonthlyMaSourceRow {
  const close = ticker === 'AAPL' ? 112 - index * 0.35 : 95.95 + index * 0.3
  const common = 100
  return {
    ticker,
    name: ticker === 'AAPL' ? 'Apple Inc.' : 'Example Energy Corp.',
    exchange: ticker === 'AAPL' ? 'NASDAQ' : 'NYSE',
    sector: ticker === 'AAPL' ? 'Technology' : 'Energy',
    industry: ticker === 'AAPL' ? 'Consumer Electronics' : 'Oil & Gas',
    assetType: 'Stock',
    date: dates[index],
    open: close - 0.2,
    high: close + 0.7,
    low: close - 0.7,
    close,
    volume: 1_000_000 + index * 10_000,
    avgVolume20: 1_100_000,
    dailyAStage: 1,
    dailyBStage: 2,
    weeklyAStage: 2,
    weeklyBStage: 3,
    monthlyAStage: 3,
    monthlyBStage: 4,
    monthlyMa3: common,
    monthlyMa5: common + 1,
    monthlyMa10: common + 2,
    monthlyMa20: common + 3,
    monthlyMa25: ticker === 'AAPL' && index === dates.length - 1 ? null : common + 4,
  }
}

const source = ['AAPL', 'XEC'].flatMap((ticker) => dates.map((_, index) => sourceRow(ticker, index)))
const asOfDate = dates.at(-1)!
const built = buildUsMonthlyMaMonitorRows(source, asOfDate)

assert.deepEqual(US_MONTHLY_MA_MONITOR_PERIODS, [3, 5, 10, 20, 25])
assert.deepEqual(US_MONTHLY_MA_UNAVAILABLE_PERIODS, [15])
assert.equal(US_MONTHLY_MA_PRICE_BASIS, US_ADJUSTED_PRICE_BASIS)
assert.ok(built.rows.every((row) => row.date === asOfDate))
assert.ok(!new Set<number>(built.rows.map((row) => row.period)).has(15), '15M must not be synthesized')
assert.equal(built.sourceTickers, 2)
assert.equal(built.eligibleTickers, 2)
assert.equal(built.missingByPeriod[25], 1, 'missing latest 25M must remain missing')
assert.equal(built.rows.filter((row) => row.ticker === 'AAPL').length, 4)
assert.equal(built.rows.filter((row) => row.ticker === 'XEC').length, 5)

const aapl3 = built.rows.find((row) => row.ticker === 'AAPL' && row.period === 3)
assert.ok(aapl3)
assert.equal(aapl3.name, 'Apple Inc.')
assert.equal(aapl3.historyWindowSessions, 35)
assert.equal(aapl3.dailyAStage, 1)
assert.ok(Number.isFinite(aapl3.distancePct))
assert.ok(Number.isFinite(aapl3.approachScore))

const history = buildUsMonthlyMaHistory(
  source.filter((row) => row.ticker === 'XEC'),
  25,
)
assert.equal(history.length, dates.length)
assert.equal(history[0].date, dates[0])
assert.equal(history.at(-1)?.date, asOfDate)
assert.ok(history.some((row) => row.crossDirection === 'up'), 'fixture must exercise existing cross semantics')

const filtered = filterUsMonthlyMaRows(built.rows, {
  period: 3,
  status: 'all',
  query: 'apple',
  exchange: 'NASDAQ',
  sector: 'Technology',
  maxDistance: null,
  minScore: 0,
  contactThreshold: 2,
  sort: 'ticker',
  direction: 'asc',
  offset: 0,
  limit: 20,
})
assert.equal(filtered.total, 1)
assert.equal(filtered.rows[0]?.ticker, 'AAPL')

const paged = filterUsMonthlyMaRows(built.rows, {
  period: 'all',
  status: 'all',
  query: '',
  exchange: null,
  sector: null,
  maxDistance: null,
  minScore: 0,
  contactThreshold: 2,
  sort: 'ticker',
  direction: 'asc',
  offset: 2,
  limit: 3,
})
assert.equal(paged.total, 9)
assert.equal(paged.rows.length, 3)

const summary = summarizeUsMonthlyMaRows(built.rows, 2)
assert.equal(summary.monitored, 2)
assert.ok(summary.signals >= 0)
assert.equal(parseUsMonthlyPeriod('15'), 'all', 'unsupported 15M parameter must not become a synthetic period')
assert.equal(parseUsMonthlyPeriod('25'), 25)
assert.match(usMonthlyMaLimitations(31).join(' '), /15か月線/)
assert.match(usMonthlyMaLimitations(31).join(' '), /未観測/)

const listRoute = fs.readFileSync(path.join(root, 'app/api/us/ma25m-monitor/route.ts'), 'utf8')
const detailRoute = fs.readFileSync(path.join(root, 'app/api/us/ma25m-monitor/[ticker]/route.ts'), 'utf8')
const page = fs.readFileSync(path.join(root, 'app/us/ma25m-monitor/page.tsx'), 'utf8')

for (const route of [listRoute, detailRoute]) {
  assert.match(route, /market_daily_snapshots/)
  assert.match(route, /market_ohlcv_daily/)
  assert.match(route, /ticker = 'SPY'/, 'US trading sessions must be anchored to SPY')
  assert.match(route, /US_ADJUSTED_(?:OPEN|CLOSE)_SQL/)
  assert.doesNotMatch(route, /STOCKBOARD_DB_PATH|\/Volumes\//, 'route must use the guarded serving contract')
}
assert.match(listRoute, /sourceGeneration/)
assert.match(listRoute, /price_basis_mismatch/)
assert.match(page, /\/api\/us\/ma25m-monitor/)
assert.match(page, /\/us\/stock\//)
assert.match(page, /15か月線/)
assert.match(page, /補完しません/)

async function verifyInvalidQueries(): Promise<void> {
  const invalidListCases = [
    'period=15',
    'status=unknown',
    'sort=unknown',
    'dir=sideways',
    'limit=0',
    'limit=1.5',
    'offset=-1',
    'contactPct=nan',
    'period=3&period=5',
  ]
  for (const query of invalidListCases) {
    const response = await getMonitorList(new NextRequest(`http://localhost/api/us/ma25m-monitor?${query}`))
    assert.equal(response.status, 400, `list query must fail closed: ${query}`)
  }

  const invalidDetailCases = [
    'date=2026-02-30',
    'period=15',
    'period=all',
    'limit=19',
    'limit=20.5',
    'date=2026-08-01&date=2026-08-02',
  ]
  for (const query of invalidDetailCases) {
    const response = await getMonitorDetail(
      new NextRequest(`http://localhost/api/us/ma25m-monitor/AAPL?${query}`),
      { params: Promise.resolve({ ticker: 'AAPL' }) },
    )
    assert.equal(response.status, 400, `detail query must fail closed: ${query}`)
  }
}

verifyInvalidQueries()
  .then(() => console.log('US monthly MA monitor fixture tests passed'))
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })

