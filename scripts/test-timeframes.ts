import assert from 'node:assert/strict'
import { resampleOhlcv } from '@/lib/timeframes'
import type { OHLCV } from '@/types/stock'

const rows: OHLCV[] = [
  { date: '2026-01-29', open: 100, high: 110, low: 95, close: 105, volume: 1_000 },
  { date: '2026-01-30', open: 106, high: 112, low: 101, close: 108, volume: 2_000 },
  { date: '2026-02-02', open: 109, high: 120, low: 107, close: 118, volume: 3_000 },
  { date: '2026-02-03', open: 117, high: 119, low: 111, close: 113, volume: 4_000 },
  { date: '2026-02-06', open: 114, high: 124, low: 112, close: 122, volume: 5_000 },
  { date: '2026-02-09', open: 123, high: 130, low: 121, close: 128, volume: 6_000 },
  { date: '2026-02-13', open: 127, high: 131, low: 120, close: 121, volume: 7_000 },
  { date: '2026-03-02', open: 122, high: 140, low: 119, close: 136, volume: 8_000 },
]

function candleKey(row: OHLCV) {
  return {
    date: row.date,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
  }
}

const twoDay = resampleOhlcv(rows, { timeframe: 'day', multiplier: 2 }).map(candleKey)
assert.deepEqual(twoDay[0], { date: '2026-01-30', open: 100, high: 112, low: 95, close: 108, volume: 3_000 })
assert.deepEqual(twoDay[1], { date: '2026-02-03', open: 109, high: 120, low: 107, close: 113, volume: 7_000 })

const threeDay = resampleOhlcv(rows, { timeframe: 'day', multiplier: 3 }).map(candleKey)
assert.deepEqual(threeDay[0], { date: '2026-02-02', open: 100, high: 120, low: 95, close: 118, volume: 6_000 })
assert.deepEqual(threeDay[1], { date: '2026-02-09', open: 117, high: 130, low: 111, close: 128, volume: 15_000 })

const weekly = resampleOhlcv(rows, { timeframe: 'week', multiplier: 1 }).map(candleKey)
assert.deepEqual(weekly[0], { date: '2026-01-30', open: 100, high: 112, low: 95, close: 108, volume: 3_000 })
assert.deepEqual(weekly[1], { date: '2026-02-06', open: 109, high: 124, low: 107, close: 122, volume: 12_000 })

const twoWeek = resampleOhlcv(rows, { timeframe: 'week', multiplier: 2 }).map(candleKey)
assert.deepEqual(twoWeek[0], { date: '2026-01-30', open: 100, high: 112, low: 95, close: 108, volume: 3_000 })
assert.deepEqual(twoWeek[1], { date: '2026-02-13', open: 109, high: 131, low: 107, close: 121, volume: 25_000 })

const threeWeek = resampleOhlcv(rows, { timeframe: 'week', multiplier: 3 }).map(candleKey)
assert.deepEqual(threeWeek[0], { date: '2026-02-13', open: 100, high: 131, low: 95, close: 121, volume: 28_000 })
assert.deepEqual(threeWeek[1], { date: '2026-03-02', open: 122, high: 140, low: 119, close: 136, volume: 8_000 })

const monthly = resampleOhlcv(rows, { timeframe: 'month', multiplier: 1 }).map(candleKey)
assert.deepEqual(monthly[0], { date: '2026-01-30', open: 100, high: 112, low: 95, close: 108, volume: 3_000 })
assert.deepEqual(monthly[1], { date: '2026-02-13', open: 109, high: 131, low: 107, close: 121, volume: 25_000 })

const twoMonth = resampleOhlcv(rows, { timeframe: 'month', multiplier: 2 }).map(candleKey)
assert.deepEqual(twoMonth[0], { date: '2026-02-13', open: 100, high: 131, low: 95, close: 121, volume: 28_000 })
assert.deepEqual(twoMonth[1], { date: '2026-03-02', open: 122, high: 140, low: 119, close: 136, volume: 8_000 })

const threeMonth = resampleOhlcv(rows, { timeframe: 'month', multiplier: 3 }).map(candleKey)
assert.deepEqual(threeMonth[0], { date: '2026-03-02', open: 100, high: 140, low: 95, close: 136, volume: 36_000 })

const halfYearRows: OHLCV[] = [
  ...rows,
  { date: '2026-07-01', open: 141, high: 150, low: 138, close: 148, volume: 9_000 },
  { date: '2026-12-30', open: 149, high: 165, low: 145, close: 160, volume: 10_000 },
]
const sixMonth = resampleOhlcv(halfYearRows, { timeframe: 'month', multiplier: 6 }).map(candleKey)
assert.deepEqual(sixMonth[0], { date: '2026-03-02', open: 100, high: 140, low: 95, close: 136, volume: 36_000 })
assert.deepEqual(sixMonth[1], { date: '2026-12-30', open: 141, high: 165, low: 138, close: 160, volume: 19_000 })

const sixMonthSubset = resampleOhlcv(halfYearRows.filter((row) => row.date >= '2026-07-01'), {
  timeframe: 'month',
  multiplier: 6,
}).map(candleKey)
assert.deepEqual(sixMonthSubset, sixMonth.slice(1))

const yearlyRows: OHLCV[] = [
  { date: '2023-01-04', open: 80, high: 90, low: 75, close: 86, volume: 100 },
  { date: '2023-12-29', open: 87, high: 115, low: 82, close: 110, volume: 200 },
  { date: '2024-01-04', open: 112, high: 120, low: 105, close: 118, volume: 300 },
  { date: '2024-12-30', open: 119, high: 140, low: 108, close: 135, volume: 400 },
  { date: '2025-01-06', open: 136, high: 145, low: 125, close: 130, volume: 500 },
  { date: '2025-12-30', open: 131, high: 150, low: 120, close: 148, volume: 600 },
  { date: '2026-01-05', open: 149, high: 155, low: 140, close: 152, volume: 700 },
]

const yearly = resampleOhlcv(yearlyRows, { timeframe: 'year', multiplier: 1 }).map(candleKey)
assert.deepEqual(yearly[0], { date: '2023-12-29', open: 80, high: 115, low: 75, close: 110, volume: 300 })
assert.deepEqual(yearly[2], { date: '2025-12-30', open: 136, high: 150, low: 120, close: 148, volume: 1_100 })

const twoYear = resampleOhlcv(yearlyRows, { timeframe: 'year', multiplier: 2 }).map(candleKey)
assert.deepEqual(twoYear[0], { date: '2023-12-29', open: 80, high: 115, low: 75, close: 110, volume: 300 })
assert.deepEqual(twoYear[1], { date: '2025-12-30', open: 112, high: 150, low: 105, close: 148, volume: 1_800 })
assert.deepEqual(twoYear[2], { date: '2026-01-05', open: 149, high: 155, low: 140, close: 152, volume: 700 })

const threeYear = resampleOhlcv(yearlyRows, { timeframe: 'year', multiplier: 3 }).map(candleKey)
assert.deepEqual(threeYear[0], { date: '2023-12-29', open: 80, high: 115, low: 75, close: 110, volume: 300 })
assert.deepEqual(threeYear[1], { date: '2026-01-05', open: 112, high: 155, low: 105, close: 152, volume: 2_500 })

const threeYearSubset = resampleOhlcv(yearlyRows.filter((row) => row.date >= '2024-01-01'), {
  timeframe: 'year',
  multiplier: 3,
}).map(candleKey)
assert.deepEqual(threeYearSubset, threeYear.slice(1))

console.log('timeframe resampling tests passed')
