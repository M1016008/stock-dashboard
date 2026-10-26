import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  US_MONTHLY_MA_MONITOR_PERIODS,
  US_MONTHLY_MA_PRICE_BASIS,
  US_MONTHLY_MA_UNAVAILABLE_PERIODS,
  buildUsMonthlyMaHistory,
  buildUsMonthlyMaMonitorRows,
  deriveUsMonthlyMa15Value,
  filterUsMonthlyMaRows,
  parseUsMonthlyPeriod,
  summarizeUsMonthlyMaRows,
  usMonthlyMaLimitations,
  type UsMonthlyMaSourceRow,
} from '@/lib/us-ma25m-monitor'
import { attestUsMonthlyMaGeneration } from '@/lib/server/us-monthly-ma-generation'
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
  const sourceMonth = dates[index].slice(0, 7)
  const monthlyMa15AnchorDate = sourceMonth === '2026-08' ? '2025-10-31' : '2025-11-28'
  const monthlyMa15BridgeDate = sourceMonth === '2026-08' ? '2025-11-03' : '2025-12-01'
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
    monthlyMa15AnchorDate,
    monthlyMa15BridgeDate,
    monthlyMa15AnchorMa5: common - 4,
    monthlyMa20: common + 3,
    monthlyMa25: ticker === 'AAPL' && index === dates.length - 1 ? null : common + 4,
  }
}

const source = ['AAPL', 'XEC'].flatMap((ticker) => dates.map((_, index) => sourceRow(ticker, index)))
const asOfDate = dates.at(-1)!
const built = buildUsMonthlyMaMonitorRows(source, asOfDate)

assert.deepEqual(US_MONTHLY_MA_MONITOR_PERIODS, [3, 5, 10, 15, 20, 25])
assert.deepEqual(US_MONTHLY_MA_UNAVAILABLE_PERIODS, [])
assert.equal(US_MONTHLY_MA_PRICE_BASIS, US_ADJUSTED_PRICE_BASIS)
assert.ok(built.rows.every((row) => row.date === asOfDate))
assert.ok(new Set<number>(built.rows.map((row) => row.period)).has(15), '15M must be derived from snapshot month boundaries')
assert.equal(built.sourceTickers, 2)
assert.equal(built.eligibleTickers, 2)
assert.equal(built.missingByPeriod[25], 1, 'missing latest 25M must remain missing')
assert.equal(built.missingByPeriod[15], 0)
assert.equal(built.rows.filter((row) => row.ticker === 'AAPL').length, 5)
assert.equal(built.rows.filter((row) => row.ticker === 'XEC').length, 6)

const aapl3 = built.rows.find((row) => row.ticker === 'AAPL' && row.period === 3)
assert.ok(aapl3)
assert.equal(aapl3.name, 'Apple Inc.')
assert.equal(aapl3.historyWindowSessions, 35)
assert.equal(aapl3.dailyAStage, 1)
assert.ok(Number.isFinite(aapl3.distancePct))
assert.ok(Number.isFinite(aapl3.approachScore))

const aapl15 = built.rows.find((row) => row.ticker === 'AAPL' && row.period === 15)
assert.ok(aapl15)
assert.equal(aapl15.maValue, 100, '15M = (current/forming MA10 * 10 + completed month -10 MA5 * 5) / 15')

const formingMonthRow = sourceRow('AAPL', dates.length - 1)
const completedTailCloses = [92, 94, 96, 98, 100]
const recentCompletedAndFormingCloses = Array.from({ length: 10 }, () => 102)
const directFifteenMonthMean = [...completedTailCloses, ...recentCompletedAndFormingCloses]
  .reduce((sum, value) => sum + value, 0) / 15
assert.equal(directFifteenMonthMean, 100)
assert.equal(formingMonthRow.date.slice(0, 7), '2026-09')
assert.equal(formingMonthRow.monthlyMa15AnchorDate, '2025-11-28',
  'the completed five-month tail must be anchored at month -10')
assert.equal(formingMonthRow.monthlyMa15BridgeDate, '2025-12-01',
  'the month -9 first observation proves the completed tail joins the current continuous segment')
assert.equal(deriveUsMonthlyMa15Value(formingMonthRow), directFifteenMonthMean,
  'the weighted derivation must equal 14 completed month closes plus the current forming close')
assert.equal(deriveUsMonthlyMa15Value({ ...formingMonthRow, monthlyMa10: 105 }), 102,
  'the forming month must use the source-date MA10 without future close substitution')
assert.equal(deriveUsMonthlyMa15Value({ ...formingMonthRow, monthlyMa15AnchorMa5: null }), null,
  'missing completed-month anchor must remain missing')
assert.equal(deriveUsMonthlyMa15Value({ ...formingMonthRow, monthlyMa15BridgeDate: null }), null,
  'an unverified continuity boundary must remain missing')
assert.equal(deriveUsMonthlyMa15Value({ ...formingMonthRow, monthlyMa15AnchorDate: '2025-12-31' }), null,
  'an anchor from the wrong month must fail closed')

const missing15Source = source
  .filter((row) => row.ticker === 'AAPL')
  .map((row) => row.date === asOfDate ? { ...row, monthlyMa15AnchorMa5: null } : row)
const missing15Built = buildUsMonthlyMaMonitorRows(missing15Source, asOfDate)
assert.equal(missing15Built.missingByPeriod[15], 1)
assert.equal(missing15Built.rows.some((row) => row.period === 15), false)

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
assert.equal(paged.total, 11)
assert.equal(paged.rows.length, 3)

const summary = summarizeUsMonthlyMaRows(built.rows, 2)
assert.equal(summary.monitored, 2)
assert.ok(summary.signals >= 0)
assert.equal(parseUsMonthlyPeriod('15'), 15)
assert.equal(parseUsMonthlyPeriod('25'), 25)
assert.match(usMonthlyMaLimitations(31).join(' '), /10か月前の完了月末Snapshot/)
assert.match(usMonthlyMaLimitations(31).join(' '), /当月は形成中/)
assert.match(usMonthlyMaLimitations(31).join(' '), /補完せず未計算/)
assert.match(usMonthlyMaLimitations(31).join(' '), /未観測/)

const attestedRun = {
  id: 42,
  status: 'success',
  payloadJson: JSON.stringify({ stage: 'complete', priceBasis: US_MONTHLY_MA_PRICE_BASIS }),
  totalTickers: 2,
  succeeded: 2,
  failed: 0,
  finishedAt: 1_000,
  snapshotMaxComputedAt: 999,
}
assert.deepEqual(attestUsMonthlyMaGeneration(attestedRun), {
  ok: true,
  generation: 42,
  priceBasis: US_MONTHLY_MA_PRICE_BASIS,
})
assert.equal(attestUsMonthlyMaGeneration({ ...attestedRun, succeeded: 1 }).ok, false)
assert.equal(attestUsMonthlyMaGeneration({ ...attestedRun, snapshotMaxComputedAt: 1_001 }).ok, false)
assert.equal(attestUsMonthlyMaGeneration({ ...attestedRun, payloadJson: JSON.stringify({
  stage: 'complete', priceBasis: US_MONTHLY_MA_PRICE_BASIS, tickerStart: 'AAPL',
}) }).ok, false)

const listRoute = fs.readFileSync(path.join(root, 'app/api/us/ma25m-monitor/route.ts'), 'utf8')
const detailRoute = fs.readFileSync(path.join(root, 'app/api/us/ma25m-monitor/[ticker]/route.ts'), 'utf8')
const page = fs.readFileSync(path.join(root, 'app/us/ma25m-monitor/page.tsx'), 'utf8')

for (const route of [listRoute, detailRoute]) {
  assert.match(route, /market_daily_snapshots/)
  assert.match(route, /market_ohlcv_daily/)
  assert.match(route, /ticker = 'SPY'/, 'US trading sessions must be anchored to SPY')
  assert.match(route, /US_ADJUSTED_(?:OPEN|CLOSE)_SQL/)
  assert.match(route, /ma15_boundary_dates/)
  assert.match(route, /'-10 months'/)
  assert.match(route, /'-8 months'/)
  assert.match(route, /monthlyMa15AnchorMa5/)
  assert.match(route, /monthlyMa15BridgeDate/)
  assert.doesNotMatch(route, /STOCKBOARD_DB_PATH|\/Volumes\//, 'route must use the guarded serving contract')
}
for (const route of [listRoute, detailRoute]) {
  assert.match(route, /attestUsMonthlyMaGeneration/)
  assert.match(route, /us_monthly_ma_generation_unattested/)
  assert.match(route, /sourceGenerationStatus: 'attested'/)
  assert.match(route, /price_basis_mismatch/)
}
assert.match(page, /\/api\/us\/ma25m-monitor/)
assert.match(page, /\/us\/stock\//)
assert.match(page, /3・5・10・15・20・25か月線/)
assert.match(page, /10か月前の完了月末Snapshot/)
assert.match(page, /当月は形成中/)

async function verifyInvalidQueries(): Promise<void> {
  const invalidListCases = [
    'period=17',
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
    'period=17',
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
