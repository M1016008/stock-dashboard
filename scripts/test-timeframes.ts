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

const weekly = resampleOhlcv(rows, { timeframe: 'week', multiplier: 1 }).map(candleKey)
assert.deepEqual(weekly[0], { date: '2026-01-30', open: 100, high: 112, low: 95, close: 108, volume: 3_000 })
assert.deepEqual(weekly[1], { date: '2026-02-06', open: 109, high: 124, low: 107, close: 122, volume: 12_000 })

const twoWeek = resampleOhlcv(rows, { timeframe: 'week', multiplier: 2 }).map(candleKey)
assert.deepEqual(twoWeek[0], { date: '2026-02-06', open: 100, high: 124, low: 95, close: 122, volume: 15_000 })
assert.deepEqual(twoWeek[1], { date: '2026-02-13', open: 123, high: 131, low: 120, close: 121, volume: 13_000 })

const monthly = resampleOhlcv(rows, { timeframe: 'month', multiplier: 1 }).map(candleKey)
assert.deepEqual(monthly[0], { date: '2026-01-30', open: 100, high: 112, low: 95, close: 108, volume: 3_000 })
assert.deepEqual(monthly[1], { date: '2026-02-13', open: 109, high: 131, low: 107, close: 121, volume: 25_000 })

const twoMonth = resampleOhlcv(rows, { timeframe: 'month', multiplier: 2 }).map(candleKey)
assert.deepEqual(twoMonth[0], { date: '2026-02-13', open: 100, high: 131, low: 95, close: 121, volume: 28_000 })
assert.deepEqual(twoMonth[1], { date: '2026-03-02', open: 122, high: 140, low: 119, close: 136, volume: 8_000 })

console.log('timeframe resampling tests passed')
