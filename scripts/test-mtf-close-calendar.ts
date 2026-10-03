import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  buildCloseCalendar,
  getCloseTimeframes,
  getNextTradingDay,
  getPreviousTradingDay,
  getUpcomingCloseDays,
  passesCloseCountFilter,
  visibleCloseTimeframes,
} from '@/lib/mtf-close-calendar'
import {
  getJpTradingDates,
  getNextJpTradingDate,
  getPreviousJpTradingDate,
  isJpMarketTradingDate,
} from '@/lib/server/jp-market-calendar'
import {
  CLOSE_TIMEFRAMES,
  createTimeframeBucketContext,
  getTimeframeBucketKey,
  intervalToSpec,
  resampleOhlcv,
  type CloseTimeframe,
} from '@/lib/timeframes'
import {
  getMtfCloseCalendar,
  MtfCloseCalendarRequestError,
  parseMtfCloseCalendarQuery,
  type MarketSessionCoverage,
} from '@/lib/server/mtf-close-calendar-read-model'
import {
  buildTradingViewMtfFixture,
  compareTradingViewMtfFixture,
  importTradingViewOracleRows,
  TRADINGVIEW_ORACLE_COLUMNS,
  type TradingViewMtfFixture,
} from '@/lib/tradingview/mtf-close-parity'
import type { OHLCV } from '@/types/stock'

async function main() {
const sessions = getJpTradingDates('2000-01-04', '2027-01-15')
const context = createTimeframeBucketContext(sessions)

assert.equal(isJpMarketTradingDate('2026-10-09'), true)
assert.equal(isJpMarketTradingDate('2026-10-10'), false)
assert.equal(isJpMarketTradingDate('2026-10-12'), false)
assert.equal(getNextJpTradingDate('2026-10-09'), '2026-10-13')
assert.equal(getPreviousJpTradingDate('2026-10-13'), '2026-10-09')
assert.equal(getNextJpTradingDate('2026-12-30'), '2027-01-04')
assert.equal(getNextTradingDay('2026-10-09', sessions), '2026-10-13')
assert.equal(getPreviousTradingDay('2026-10-13', sessions), '2026-10-09')

for (const timeframe of CLOSE_TIMEFRAMES) {
  assert.ok(getTimeframeBucketKey('2026-10-09', intervalToSpec(timeframe), context))
}
assert.equal(intervalToSpec('5D').multiplier, 5)
assert.equal(CLOSE_TIMEFRAMES.length, 12)

const october = buildCloseCalendar({
  market: 'JP',
  from: '2026-10-01',
  to: '2026-10-31',
  tradingDates: sessions,
  actualCoverageFrom: '2008-01-04',
  actualCoverageTo: '2026-09-30',
})
assert.equal(october.days.length, 31)
const oct9 = october.days.find((day) => day.date === '2026-10-09')!
assert.deepEqual(oct9.closeTimeframes, ['D', 'W', '2W', '5W'])
assert.equal(oct9.closeCount, oct9.closeTimeframes.length)
assert.equal(oct9.nextTradingDate, '2026-10-13')
const oct30 = october.days.find((day) => day.date === '2026-10-30')!
assert.deepEqual(oct30.closeTimeframes, ['D', '3D', 'W', 'M', '2M', '5M'])
assert.equal(oct30.nextTradingDate, '2026-11-02')
assert.equal(october.days.find((day) => day.date === '2026-10-12')?.isTradingDay, false)

const yearEnd = buildCloseCalendar({
  market: 'JP',
  from: '2026-12-28',
  to: '2027-01-05',
  tradingDates: sessions,
})
const dec30 = yearEnd.days.find((day) => day.date === '2026-12-30')!
assert.equal(dec30.nextTradingDate, '2027-01-04')
assert.deepEqual(dec30.closeTimeframes, [...CLOSE_TIMEFRAMES])

const focused = new Set<CloseTimeframe>(['D', 'W', 'M'])
assert.deepEqual(visibleCloseTimeframes(oct30, focused), ['D', 'W', 'M'])
assert.equal(passesCloseCountFilter(oct30, focused, 3), true)
assert.equal(passesCloseCountFilter(oct30, focused, 4), false)
const upcoming = getUpcomingCloseDays(october.days, new Set(CLOSE_TIMEFRAMES), '2026-10-01', 3)
assert.equal(upcoming.length, 3)
assert.ok(upcoming.every((day) => day.visibleTimeframes.length >= 2))

const octoberRows: OHLCV[] = sessions
  .filter((date) => date >= '2026-09-25' && date <= '2026-11-10')
  .map((date, index) => ({
    date,
    open: 100 + index,
    high: 102 + index,
    low: 99 + index,
    close: 101 + index,
    volume: 1_000 + index,
  }))
const fiveDayCandles = resampleOhlcv(octoberRows, intervalToSpec('5D'), context)
const completedFiveDayCandleDates = fiveDayCandles
  .map((row) => row.date)
  .filter((date) => date >= '2026-10-01' && date <= '2026-10-31')
  .filter((date) => getCloseTimeframes(date, getNextTradingDay(date, sessions)!, context).includes('5D'))
const calendarFiveDayDates = october.days
  .filter((day) => day.closeTimeframes.includes('5D'))
  .map((day) => day.date)
assert.deepEqual(completedFiveDayCandleDates, calendarFiveDayDates)

const fixtureCoverage: MarketSessionCoverage = {
  tradingDates: sessions,
  actualCoverageFrom: '2008-01-04',
  actualCoverageTo: '2026-09-30',
  calendarSource: 'MARKET_OHLCV_AND_JP_HOLIDAY_RULES',
  warnings: [],
}
const apiInput = parseMtfCloseCalendarQuery(new URLSearchParams({
  market: 'JP',
  from: '2026-10-01',
  to: '2026-10-31',
}))
const apiResult = await getMtfCloseCalendar(apiInput, async () => fixtureCoverage)
assert.equal(apiResult.days.length, 31)
assert.equal(apiResult.days.find((day) => day.date === '2026-10-30')?.closeCount, 6)
assert.equal(apiResult.sessionCoverageTo, '2026-09-30')

assert.throws(
  () => parseMtfCloseCalendarQuery(new URLSearchParams({ market: 'US', from: '2026-10-01', to: '2026-10-31' })),
  (error) => error instanceof MtfCloseCalendarRequestError && error.status === 400,
)
assert.throws(
  () => parseMtfCloseCalendarQuery(new URLSearchParams({ market: 'JP', from: '2026-02-30', to: '2026-10-31' })),
  (error) => error instanceof MtfCloseCalendarRequestError && error.status === 400,
)
assert.throws(
  () => parseMtfCloseCalendarQuery(new URLSearchParams({ market: 'JP', from: '2026-11-01', to: '2026-10-01' })),
  (error) => error instanceof MtfCloseCalendarRequestError && error.status === 400,
)

const parityFixture = JSON.parse(fs.readFileSync(
  path.join(process.cwd(), 'fixtures/mtf-close-calendar/tradingview-close-dates.json'),
  'utf8',
)) as TradingViewMtfFixture
assert.equal(parityFixture.schemaVersion, 2)
assert.equal(parityFixture.status, 'PASS')
const fixtureReport = compareTradingViewMtfFixture(parityFixture)
assert.equal(fixtureReport.result, 'PASS')
assert.equal(fixtureReport.totalDatesCompared, 425)
assert.equal(fixtureReport.totalTfDateComparisons, 5_100)
assert.equal(fixtureReport.totalMismatches, 0)

const emptyFixture: TradingViewMtfFixture = {
  schemaVersion: 2,
  status: 'NOT_VALIDATED',
  oracle: null,
  sessionContext: null,
  observations: [],
  pending: [{
    symbol: 'TSE:7203',
    range: '2025-01-01..2026-10-02',
    timeframes: [...CLOSE_TIMEFRAMES],
    status: 'PENDING_TRADINGVIEW_CSV_EXPORT',
  }],
}
assert.equal(compareTradingViewMtfFixture(emptyFixture).result, 'NOT_VALIDATED')

const oracleHeaders = [
  TRADINGVIEW_ORACLE_COLUMNS.exchangeDate,
  TRADINGVIEW_ORACLE_COLUMNS.confirmed,
  TRADINGVIEW_ORACLE_COLUMNS.regularSession,
  ...CLOSE_TIMEFRAMES.map((timeframe) => TRADINGVIEW_ORACLE_COLUMNS.timeframes[timeframe]),
]
const oracleRows = [
  oracleHeaders,
  ['20261009', '1', '1', ...CLOSE_TIMEFRAMES.map((timeframe) => oct9.closeTimeframes.includes(timeframe) ? '1' : '0')],
  ['20261030', '1', '1', ...CLOSE_TIMEFRAMES.map((timeframe) => oct30.closeTimeframes.includes(timeframe) ? '1' : '0')],
]
const oracleImport = importTradingViewOracleRows(oracleRows, {
  symbol: 'TSE:7203',
  from: '2026-10-01',
  to: '2026-10-31',
})
const generatedFixture = buildTradingViewMtfFixture({
  oracle: oracleImport,
  tradingDates: sessions,
  anchorDate: sessions[0],
  coverageFrom: sessions[0],
  coverageTo: sessions.at(-1)!,
  calendarSource: 'TEST_MARKET_SESSIONS',
})
const passReport = compareTradingViewMtfFixture(generatedFixture)
assert.equal(passReport.result, 'PASS')
assert.equal(passReport.totalDatesCompared, 2)
assert.equal(passReport.totalTfDateComparisons, 24)
assert.equal(passReport.totalMismatches, 0)
assert.equal(passReport.october30.status, 'COMPARED')

const mismatchedFixture = structuredClone(generatedFixture)
mismatchedFixture.observations[0].expectedCloseTimeframes = mismatchedFixture.observations[0]
  .expectedCloseTimeframes
  .filter((timeframe) => timeframe !== 'D')
const failReport = compareTradingViewMtfFixture(mismatchedFixture)
assert.equal(failReport.result, 'FAIL')
assert.deepEqual(failReport.mismatches[0], {
  date: '2026-10-09',
  timeframe: 'D',
  tradingViewExpected: false,
  stockBoardActual: true,
})

console.log('MTF close calendar tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
