import assert from 'node:assert/strict'
import {
  computeForwardExtremaRows,
  computeRecentForwardExtremaRows,
  exactForwardExtremaRecomputeBars,
  recentForwardExtremaLoadBars,
  type ForwardExtremaBar,
  type ForwardExtremaRow,
} from '@/lib/backtest/forward-extrema'

function naive(ticker: string, bars: ForwardExtremaBar[], horizons: readonly number[], startIndex: number): ForwardExtremaRow[] {
  const horizonSet = new Set(horizons)
  const maxHorizon = Math.max(...horizons)
  const rows: ForwardExtremaRow[] = []
  for (let index = startIndex; index < bars.length; index += 1) {
    const base = bars[index]
    if (!Number.isFinite(base.close) || base.close <= 0) continue
    let maxReturnPct = Number.NEGATIVE_INFINITY
    let minReturnPct = Number.POSITIVE_INFINITY
    let maxReturnDate = ''
    let minReturnDate = ''
    let daysToMax = 0
    let daysToMin = 0
    const targetDays: Record<number, number | null> = { 10: null, 20: null, 40: null }
    const maxFutureDays = Math.min(maxHorizon, bars.length - index - 1)
    for (let day = 1; day <= maxFutureDays; day += 1) {
      const bar = bars[index + day]
      const highReturn = ((bar.high - base.close) / base.close) * 100
      const lowReturn = ((bar.low - base.close) / base.close) * 100
      if (highReturn > maxReturnPct) {
        maxReturnPct = highReturn
        maxReturnDate = bar.date
        daysToMax = day
      }
      if (lowReturn < minReturnPct) {
        minReturnPct = lowReturn
        minReturnDate = bar.date
        daysToMin = day
      }
      for (const target of [10, 20, 40]) {
        if (targetDays[target] == null && highReturn >= target) targetDays[target] = day
      }
      if (!horizonSet.has(day)) continue
      rows.push({
        ticker,
        date: base.date,
        horizon_days: day,
        return_pct: ((bar.close - base.close) / base.close) * 100,
        end_date: bar.date,
        max_return_pct: maxReturnPct,
        max_return_date: maxReturnDate,
        days_to_max: daysToMax,
        min_return_pct: minReturnPct,
        min_return_date: minReturnDate,
        days_to_min: daysToMin,
        hit_10: targetDays[10] == null ? 0 : 1,
        hit_20: targetDays[20] == null ? 0 : 1,
        hit_40: targetDays[40] == null ? 0 : 1,
        days_to_10: targetDays[10],
        days_to_20: targetDays[20],
        days_to_40: targetDays[40],
      })
    }
  }
  return rows
}

let seed = 20260723
function random(): number {
  seed = (seed * 1664525 + 1013904223) >>> 0
  return seed / 2 ** 32
}

const bars: ForwardExtremaBar[] = []
let close = 100
for (let index = 0; index < 280; index += 1) {
  close = Math.max(10, close * (1 + (random() - 0.48) * 0.05))
  const high = close * (1 + random() * 0.08)
  const low = close * (1 - random() * 0.08)
  bars.push({
    date: new Date(Date.UTC(2024, 0, 1 + index)).toISOString().slice(0, 10),
    close,
    high,
    low,
  })
}

const horizons = [5, 10, 20, 40, 60, 90, 200]
const expected = naive('TEST', bars, horizons, 17)
const actual = computeForwardExtremaRows({ ticker: 'TEST', bars, horizons, startIndex: 17 })
assert.deepEqual(actual, expected)

const exactRecomputeBars = exactForwardExtremaRecomputeBars(horizons)
assert.equal(exactRecomputeBars, 201)
const fullRecent = computeForwardExtremaRows({
  ticker: 'TEST',
  bars,
  horizons,
  startIndex: bars.length - exactRecomputeBars,
})
const slicedRecent = computeForwardExtremaRows({
  ticker: 'TEST',
  bars: bars.slice(-exactRecomputeBars),
  horizons,
})
assert.deepEqual(slicedRecent, fullRecent)

const recentDays = 30
const recentLoadBars = recentForwardExtremaLoadBars(recentDays, horizons)
assert.equal(recentLoadBars, 230)
const recentBars = bars.slice(-recentLoadBars)
const recentRows = computeRecentForwardExtremaRows({
  ticker: 'TEST',
  bars: recentBars,
  horizons,
  recentDays,
})
for (const horizon of horizons) {
  assert.equal(
    recentRows.filter((row) => row.horizon_days === horizon).length,
    recentDays,
    `recent rows should retain ${recentDays} mature labels for horizon ${horizon}`,
  )
}

const boundedRecentRows = computeRecentForwardExtremaRows({
  ticker: 'TEST',
  bars: recentBars,
  horizons,
  recentDays,
  startDate: recentRows[Math.floor(recentRows.length / 2)].date,
})
assert.ok(boundedRecentRows.length > 0)
assert.ok(boundedRecentRows.every((row) => row.date >= recentRows[Math.floor(recentRows.length / 2)].date))

console.log(
  `forward extrema optimization parity passed: rows=${actual.length}, exact_recompute_bars=${exactRecomputeBars}, recent_load_bars=${recentLoadBars}`,
)
