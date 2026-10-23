import assert from 'node:assert/strict'

import {
  aggregateTwentyFourMonthCandles,
  detectRisingCloseLines,
  extendRisingCloseLine,
  standardizedRisingCloseAngleDeg,
  twoYearBlockStartYear,
  twoYearLineExtensionDate,
  type TwoYearCandle,
} from '../lib/two-year-candles'
import type { OHLCV } from '../types/stock'

function row(date: string, open: number, high: number, low: number, close: number): OHLCV {
  return { date, open, high, low, close, volume: 100 }
}

assert.equal(twoYearBlockStartYear('2024-01-04'), 2024)
assert.equal(twoYearBlockStartYear('2025-12-30'), 2024)
assert.equal(twoYearBlockStartYear('2026-10-19'), 2026)
assert.equal(twoYearBlockStartYear('2025-12-31'), 2024)
assert.equal(twoYearBlockStartYear('2026-01-01'), 2026)
assert.equal(twoYearLineExtensionDate('2026-10-19'), '2029-01-01')

const rows = [
  row('2022-01-04', 120, 125, 116, 118),
  row('2022-12-30', 118, 121, 110, 112),
  row('2023-01-04', 112, 115, 104, 108),
  row('2023-12-29', 108, 110, 96, 100),
  row('2024-01-04', 100, 104, 98, 102),
  row('2024-12-30', 102, 112, 101, 110),
  row('2025-01-06', 110, 118, 108, 116),
  row('2025-12-30', 116, 126, 114, 124),
  row('2026-01-05', 124, 128, 120, 126),
  row('2026-12-30', 126, 132, 123, 130),
  row('2027-01-04', 130, 138, 128, 136),
]
const sessions = rows.map((item) => item.date)
const candles = aggregateTwentyFourMonthCandles(rows, { market: 'JP', asOfDate: '2027-01-04', exchangeSessions: sessions })
assert.equal(candles.length, 3)
assert.deepEqual(candles.map((candle) => candle.startYear), [2022, 2024, 2026])
assert.deepEqual(candles.map((candle) => candle.date), ['2023-01-01', '2025-01-01', '2027-01-01'])
assert.deepEqual(candles.map((candle) => candle.status), ['confirmed', 'confirmed', 'forming'])
assert.equal(candles[0].open, 120)
assert.equal(candles[0].high, 125)
assert.equal(candles[0].low, 96)
assert.equal(candles[0].close, 100)
assert.equal(candles[2].provisionalEligible, true)
assert.equal(candles[2].exchangeTimeZone, 'Asia/Tokyo')

const line = detectRisingCloseLines(candles)
assert.equal(line.length, 1)
assert.equal(line[0].status, 'provisional')
assert.equal(line[0].pattern, 'three')
assert.deepEqual(line[0].points, [
  { date: '2025-01-01', value: 124 },
  { date: '2027-01-01', value: 136 },
])
const extended = extendRisingCloseLine(line[0], '2029-01-01')
assert.equal(extended.extendedPoints.length, 3)
assert.ok(extended.extendedPoints[2].value > 136)

const beforeBoundary = aggregateTwentyFourMonthCandles(rows.filter((item) => item.date <= '2026-12-30'), {
  market: 'JP',
  asOfDate: '2026-12-30',
  exchangeSessions: sessions.filter((date) => date <= '2026-12-30'),
})
assert.equal(beforeBoundary.at(-1)?.provisionalEligible, false)
assert.equal(detectRisingCloseLines(beforeBoundary).length, 0)

const atBoundary = aggregateTwentyFourMonthCandles(rows.filter((item) => item.date <= '2026-12-30'), {
  market: 'JP',
  asOfDate: '2027-01-01',
  exchangeSessions: sessions.filter((date) => date <= '2026-12-30'),
})
assert.equal(atBoundary.at(-1)?.provisionalEligible, true)
assert.equal(detectRisingCloseLines(atBoundary)[0]?.status, 'provisional')

const brokenAfterProvisional = aggregateTwentyFourMonthCandles([
  ...rows,
  row('2027-06-30', 136, 137, 118, 120),
], {
  market: 'JP',
  asOfDate: '2027-06-30',
  exchangeSessions: [...sessions, '2027-06-30'],
})
assert.equal(detectRisingCloseLines(brokenAfterProvisional).length, 0, 'a broken provisional condition must remove the provisional line')

const staleTicker = aggregateTwentyFourMonthCandles(rows.filter((item) => item.date <= '2027-01-04'), {
  market: 'JP',
  asOfDate: '2027-06-30',
  exchangeSessions: [...sessions, '2027-06-30'],
})
assert.equal(staleTicker.at(-1)?.status, 'incomplete', 'market as-of must expose a stale ticker row as incomplete')
assert.equal(detectRisingCloseLines(staleTicker).length, 0)

const missingCalendarSession = aggregateTwentyFourMonthCandles(rows, {
  market: 'US',
  asOfDate: '2027-01-04',
  exchangeSessions: [...sessions, '2024-06-03'],
})
assert.equal(missingCalendarSession.find((candle) => candle.startYear === 2024)?.status, 'incomplete')
assert.equal(missingCalendarSession.find((candle) => candle.startYear === 2024)?.missingSessionCount, 1)
assert.equal(missingCalendarSession[0].exchangeTimeZone, 'America/New_York')
assert.equal(detectRisingCloseLines(missingCalendarSession).length, 0)

const equalCloseCandles = candles.map((candle) => ({ ...candle })) as TwoYearCandle[]
equalCloseCandles[2] = { ...equalCloseCandles[2], close: equalCloseCandles[1].close }
assert.equal(detectRisingCloseLines(equalCloseCandles).length, 0, 'C.close must be strictly greater than B.close')

const nonConsecutive = [candles[0], { ...candles[1], startYear: 2026 }, { ...candles[2], startYear: 2028 }]
assert.equal(detectRisingCloseLines(nonConsecutive).length, 0)

for (const mutate of [
  (items: TwoYearCandle[]) => { items[0] = { ...items[0], close: items[0].open + 1 } },
  (items: TwoYearCandle[]) => { items[1] = { ...items[1], close: items[1].open - 1 } },
  (items: TwoYearCandle[]) => { items[2] = { ...items[2], close: items[2].open - 1 } },
]) {
  const changed = candles.map((candle) => ({ ...candle }))
  mutate(changed)
  assert.equal(detectRisingCloseLines(changed).length, 0)
}

const invalidAndDuplicateRows = aggregateTwentyFourMonthCandles([
  row('2024-01-04', 0, 0, 0, 0),
  row('2024-01-04', 100, 105, 98, 102),
  row('2024-01-04', 101, 106, 99, 103),
  row('2025-12-30', 103, 120, 100, 118),
], {
  market: 'JP',
  asOfDate: '2026-01-05',
  exchangeSessions: ['2024-01-04', '2025-12-30', '2026-01-05'],
})
assert.equal(invalidAndDuplicateRows[0].open, 101, 'the last valid duplicate is deterministic')
assert.equal(invalidAndDuplicateRows[0].close, 118)

const incompleteHistory = aggregateTwentyFourMonthCandles(rows, { market: 'JP', asOfDate: '2027-01-04', exchangeSessions: [] })
assert.ok(incompleteHistory.every((candle) => candle.status === 'incomplete'))
assert.equal(detectRisingCloseLines(incompleteHistory).length, 0)

const postListingHistory = aggregateTwentyFourMonthCandles([
  row('2025-06-02', 100, 105, 98, 103),
  row('2025-12-30', 103, 112, 101, 110),
], {
  market: 'JP',
  asOfDate: '2026-01-05',
  exchangeSessions: ['2024-01-04', '2025-06-02', '2025-12-30', '2026-01-05'],
})
assert.equal(postListingHistory[0].status, 'incomplete', 'a post-listing partial first block must not look confirmed')

const lateCalendarProxy = aggregateTwentyFourMonthCandles([
  row('2024-01-04', 100, 105, 98, 103),
  row('2024-06-03', 103, 108, 101, 106),
  row('2025-12-30', 106, 120, 104, 118),
], {
  market: 'JP',
  asOfDate: '2026-01-05',
  exchangeSessions: ['2024-06-03', '2025-12-30', '2026-01-05'],
})
assert.equal(lateCalendarProxy[0].status, 'incomplete', 'a calendar proxy that starts after source data cannot prove completeness')

const confirmedRows = [
  ...rows.slice(0, 8),
  row('2026-01-05', 124, 130, 120, 128),
  row('2027-12-30', 128, 145, 126, 140),
  row('2028-01-04', 140, 144, 138, 142),
]
const confirmed = aggregateTwentyFourMonthCandles(confirmedRows, {
  market: 'JP',
  asOfDate: '2028-01-04',
  exchangeSessions: confirmedRows.map((item) => item.date),
})
assert.equal(confirmed[2].status, 'confirmed')
assert.equal(detectRisingCloseLines(confirmed)[0]?.status, 'confirmed')
assert.equal(detectRisingCloseLines(confirmed)[0]?.pattern, 'three')

const retainedRows = [
  row('2016-01-04', 100, 103, 76, 80),
  row('2017-12-29', 80, 82, 75, 78),
  row('2018-01-04', 78, 95, 76, 82),
  row('2019-12-30', 82, 106, 80, 102),
  row('2020-01-06', 102, 110, 98, 104),
  row('2021-12-30', 104, 130, 101, 126),
  row('2022-01-04', 126, 130, 101, 108),
  row('2023-12-29', 108, 112, 95, 100),
  row('2024-01-04', 100, 118, 98, 110),
  row('2025-12-30', 110, 128, 108, 124),
  row('2026-01-05', 124, 132, 115, 128),
  row('2027-06-30', 128, 132, 112, 118),
]
const retained = aggregateTwentyFourMonthCandles(retainedRows, {
  market: 'JP',
  asOfDate: '2027-06-30',
  exchangeSessions: retainedRows.map((item) => item.date),
})
const retainedLines = detectRisingCloseLines(retained)
assert.deepEqual(retainedLines, [], 'historical confirmed lines must not survive outside the immediately following block')

const currentWindowRows = [
  row('2020-01-06', 130, 133, 104, 106), row('2021-12-30', 106, 108, 100, 102),
  row('2022-01-04', 102, 108, 100, 104), row('2023-12-29', 104, 126, 102, 124),
  row('2024-01-04', 124, 130, 120, 126), row('2025-12-30', 126, 152, 124, 148),
  row('2026-01-05', 148, 152, 144, 150), row('2027-06-30', 150, 176, 148, 172),
]
const currentWindow = aggregateTwentyFourMonthCandles(currentWindowRows, {
  market: 'JP',
  asOfDate: '2027-06-30',
  exchangeSessions: currentWindowRows.map((item) => item.date),
})
const currentLines = detectRisingCloseLines(currentWindow)
assert.deepEqual(currentLines.map((item) => [item.pattern, item.status, item.sourcePeriods]), [
  ['three', 'confirmed', [2020, 2022, 2024]],
  ['four', 'provisional', [2020, 2022, 2024, 2026]],
])
assert.ok((standardizedRisingCloseAngleDeg(currentLines[0]) ?? 0) > 0)
assert.ok((standardizedRisingCloseAngleDeg(currentLines[0]) ?? 90) < 90)
assert.deepEqual(currentLines[0].points.map((point) => point.value), [124, 148])
assert.deepEqual(currentLines[1].points.map((point) => point.value), [148, 172])

const firstYear = aggregateTwentyFourMonthCandles(currentWindowRows.filter((item) => item.date <= '2026-01-05'), {
  market: 'JP',
  asOfDate: '2026-12-31',
  exchangeSessions: currentWindowRows.filter((item) => item.date <= '2026-01-05').map((item) => item.date),
})
assert.deepEqual(detectRisingCloseLines(firstYear).map((item) => item.status), ['confirmed'])

console.log('24-month candle and rising-close-line tests passed')
