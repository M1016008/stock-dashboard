import assert from 'node:assert/strict'
import { computeUsScreenerPeriodMetrics } from '@/lib/us-screener-period-metrics'
import type { OHLCV } from '@/types/stock'

const marketDates = Array.from({ length: 205 }, (_, index) => `d${String(index).padStart(3, '0')}`)
const missing = new Set([3, 184, 202])
const rows: OHLCV[] = marketDates
  .map((date, index) => ({
    ticker: 'TEST',
    date,
    open: index + 1,
    high: index + 1,
    low: index + 1,
    close: index + 1,
    volume: (index + 1) * 10,
  }))
  .filter((_, index) => !missing.has(index))

const metrics = computeUsScreenerPeriodMetrics(rows, marketDates)
const latest = metrics.at(-1)
assert.ok(latest)
assert.equal(latest.prevClose, 204)
assert.equal(latest.close5d, 200)
assert.equal(latest.close20d, null)
assert.equal(latest.close60d, 145)
assert.equal(latest.close120d, 85)
assert.equal(latest.ma200Observations, 198)

const expectedCurrent = rows
  .filter((row) => Number(row.date.slice(1)) >= 5)
  .map((row) => row.close)
const expectedPrevious = rows
  .filter((row) => {
    const index = Number(row.date.slice(1))
    return index >= 4 && index <= 203
  })
  .map((row) => row.close)
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length
assert.equal(latest.ma200, mean(expectedCurrent))
assert.equal(latest.ma200Prev, mean(expectedPrevious))

const expectedVolume = rows
  .filter((row) => Number(row.date.slice(1)) >= 185)
  .map((row) => row.volume)
assert.equal(latest.avgVolume20, mean(expectedVolume))

console.log('US screener period metric tests: ok')
