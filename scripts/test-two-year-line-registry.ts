import assert from 'node:assert/strict'

import {
  buildTwoYearLineRegistry,
  evaluateRisingCloseLineAtDate,
  matchesTwoYearLineQuery,
  matchesTwoYearLineFilter,
  parseTwoYearLineFilter,
  parseTwoYearLinePatternFilter,
  projectRisingCloseLineToDates,
  selectTwoYearLineSummaryForQuery,
  twoYearConfirmedDistancePriority,
} from '../lib/two-year-line-registry'
import type { OHLCV } from '../types/stock'
import { intervalToSpec, resampleOhlcv, type ChartIntervalCode } from '../lib/timeframes'

function row(date: string, open: number, close: number): OHLCV {
  return { date, open, high: Math.max(open, close) + 2, low: Math.min(open, close) - 2, close, volume: 100 }
}

const history = [
  row('2016-01-04', 100, 98), row('2017-12-29', 98, 80),
  row('2018-01-04', 80, 82), row('2019-12-30', 82, 102),
  row('2020-01-06', 132, 130), row('2021-12-30', 130, 106),
  row('2022-01-04', 106, 108), row('2023-12-29', 108, 124),
  row('2024-01-04', 124, 126), row('2025-12-30', 126, 148),
  row('2026-01-05', 148, 150), row('2027-01-04', 150, 172),
]
const registry = buildTwoYearLineRegistry({
  market: 'JP', securityKey: 'fixture:JP:6098', asOfDate: '2027-01-04',
  priceBasisVersion: 'fixture-raw-v1', history,
  exchangeSessions: history.map((item) => item.date),
})

assert.equal(registry.availability, 'available')
assert.deepEqual(registry.lines.map((line) => [line.id, line.status]), [
  ['three:2020-2022-2024', 'confirmed'], ['four:2020-2022-2024-2026', 'provisional'],
])
assert.equal(registry.latest?.lineId, 'four:2020-2022-2024-2026')
assert.deepEqual(registry.latest?.sourcePeriods, [2020, 2022, 2024, 2026])
assert.equal(registry.latestConfirmed?.pattern, 'three')
assert.equal(registry.latestProvisional?.pattern, 'four')
assert.ok((registry.latestConfirmed?.distancePct ?? 0) < 0, 'current close is below the extended confirmed line')
for (const filter of ['confirmed', 'provisional', 'either', 'none'] as const) {
  assert.equal(matchesTwoYearLineFilter(registry, filter), true)
}
assert.equal(parseTwoYearLineFilter('provisional'), 'provisional')
assert.equal(parseTwoYearLineFilter('bad'), 'none')
assert.equal(parseTwoYearLinePatternFilter('four'), 'four')
assert.equal(parseTwoYearLinePatternFilter('bad'), 'either')

const line = registry.lines[0]
assert.equal(evaluateRisingCloseLineAtDate(line, '2018-12-31'), null)
assert.equal(evaluateRisingCloseLineAtDate(line, line.points[0].date), line.points[0].value)
assert.equal(evaluateRisingCloseLineAtDate(line, line.points[1].date), line.points[1].value)
const projected = projectRisingCloseLineToDates(line, ['2024-01-05', '2023-01-05', '2023-01-05', '2018-12-31'])
assert.ok(projected.some((point) => point.time === line.points[0].date))
assert.ok(projected.some((point) => point.time === line.points[1].date))
assert.ok(projected[1].value > projected[0].value)

const fourOnly = {
  status: 'either',
  pattern: 'four',
  minAngleDeg: 0,
  maxAngleDeg: 90,
} as const
assert.equal(matchesTwoYearLineQuery([registry.latestConfirmed!, registry.latestProvisional!], fourOnly), true)
assert.equal(selectTwoYearLineSummaryForQuery([registry.latestConfirmed!, registry.latestProvisional!], fourOnly)?.status, 'provisional')
assert.equal(matchesTwoYearLineQuery([registry.latestConfirmed!], {
  status: 'confirmed', pattern: 'three', minAngleDeg: registry.latestConfirmed!.angleDeg + 0.01, maxAngleDeg: null,
}), false)
assert.deepEqual(
  [-10, 0.2, -0.5, 5, -3]
    .sort((left, right) => (twoYearConfirmedDistancePriority(right) ?? -Infinity) - (twoYearConfirmedDistancePriority(left) ?? -Infinity)),
  [-0.5, -3, -10, 0.2, 5],
)

const supportedTimeframes: ChartIntervalCode[] = [
  'D', '2D', '3D', 'W', '2W', '3W', 'M', '2M', '3M', '6M', 'Y', '2Y', '3Y', '5Y',
]
for (const interval of supportedTimeframes) {
  const dates = interval === '2Y'
    ? registry.candles.map((candle) => candle.date)
    : resampleOhlcv(history, intervalToSpec(interval)).map((item) => item.date)
  const points = projectRisingCloseLineToDates(line, dates)
  assert.ok(points.length >= 2, `${interval} must retain the source line on its own display dates`)
  for (const point of points) {
    assert.equal(point.value, evaluateRisingCloseLineAtDate(line, point.time), `${interval} must not recompute slope`)
  }
}

const syntheticUniverse = [
  { ticker: 'BOTH', registry },
  { ticker: 'NONE', registry: { ...registry, lines: [], latest: null } },
  { ticker: 'CONFIRMED', registry: { ...registry, lines: registry.lines.filter((item) => item.status === 'confirmed') } },
  { ticker: 'PROVISIONAL', registry: { ...registry, lines: registry.lines.filter((item) => item.status === 'provisional') } },
]
const applyFilterBeforePagination = (filter: 'confirmed' | 'provisional' | 'either', limit: number) => syntheticUniverse
  .filter((item) => matchesTwoYearLineFilter(item.registry, filter))
  .slice(0, limit)
  .map((item) => item.ticker)
assert.deepEqual(applyFilterBeforePagination('confirmed', 2), ['BOTH', 'CONFIRMED'])
assert.deepEqual(applyFilterBeforePagination('provisional', 2), ['BOTH', 'PROVISIONAL'])
assert.deepEqual(applyFilterBeforePagination('either', 3), ['BOTH', 'CONFIRMED', 'PROVISIONAL'])

const noCalendar = buildTwoYearLineRegistry({
  market: 'US', securityKey: 'fixture:US:AAPL', asOfDate: '2027-01-04',
  priceBasisVersion: 'fixture-split-only-v1', history, exchangeSessions: [],
})
assert.equal(noCalendar.availability, 'calendar_unavailable')
assert.equal(matchesTwoYearLineFilter(noCalendar, 'either'), false)

console.log('24-month line registry tests passed')
