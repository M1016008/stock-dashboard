// Deterministic SMA dynamics contract: exact windows, price freeze, market calendars,
// PIT boundary, warmup, data integrity, determinism, and Stage isolation.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  computeSmaDynamics,
  futureSessionDates,
  normalizeSmaHistory,
  SMA_DYNAMICS_DEFAULT_HORIZON,
  SMA_DYNAMICS_DEFAULT_WINDOW,
  SMA_DYNAMICS_HORIZONS,
  SMA_DYNAMICS_PERIODS,
  SMA_DYNAMICS_WINDOWS,
  windowSessionsFor,
  type SmaDynamicsAvailable,
  type SmaDynamicsMarket,
  type SmaDynamicsPeriod,
  type SmaDynamicsRawRow,
  type SmaDynamicsResult,
} from '@/lib/sma-dynamics'
import { buildSmaDynamicsFixtures, findSmaDynamicsFixture, fixtureSessionDates, SMA_DYNAMICS_FIXTURES } from '@/lib/sma-dynamics-fixtures'
import { getNextJpTradingDate, isJpMarketTradingDate } from '@/lib/server/jp-market-calendar'
import { getNextUsTradingDate, isUsMarketTradingDate } from '@/lib/server/us-data-freshness'

function near(actual: number | null | undefined, expected: number, message: string) {
  assert.ok(actual != null && Number.isFinite(actual), `${message}: expected a number, got ${actual}`)
  assert.ok(Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected)), `${message}: ${actual} !== ${expected}`)
}

function expectAvailable(result: SmaDynamicsResult, message: string): SmaDynamicsAvailable {
  assert.equal(result.status, 'available', `${message}: ${result.status === 'unavailable' ? result.reason : ''}`)
  return result as SmaDynamicsAvailable
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function linearRows(market: SmaDynamicsMarket, endDate: string, count: number, start = 100, step = 1): SmaDynamicsRawRow[] {
  const dates = fixtureSessionDates(market, endDate, count)
  assert.equal(dates.length, count)
  return dates.map((date, index) => ({ date, close: start + index * step }))
}

/** Expected frozen SMA at T+k: last (period - k) real closes plus k copies of the fixed close. */
function expectedFreeze(closes: number[], fixed: number, period: number, k: number): number {
  const real = k >= period ? [] : closes.slice(closes.length - (period - k))
  return mean([...real, ...Array<number>(Math.min(k, period)).fill(fixed)])
}

function weekdayOnly(anchor: string, count: number): string[] {
  const dates: string[] = []
  const cursor = new Date(`${anchor}T00:00:00Z`)
  while (dates.length < count) {
    cursor.setUTCDate(cursor.getUTCDate() + 1)
    const day = cursor.getUTCDay()
    if (day !== 0 && day !== 6) dates.push(cursor.toISOString().slice(0, 10))
  }
  return dates
}

// ---------------------------------------------------------------------------
// Constants match the approved design.
assert.deepEqual([...SMA_DYNAMICS_PERIODS], [5, 25, 75, 150, 200, 300])
assert.deepEqual(SMA_DYNAMICS_WINDOWS.map((item) => [item.id, item.sessions]), [['1m', 21], ['3m', 63], ['6m', 126]])
assert.equal(SMA_DYNAMICS_DEFAULT_WINDOW, '3m')
assert.equal(windowSessionsFor(SMA_DYNAMICS_DEFAULT_WINDOW), 63)
assert.deepEqual([...SMA_DYNAMICS_HORIZONS], [5, 10, 20, 60])
assert.equal(SMA_DYNAMICS_DEFAULT_HORIZON, 20)

// ---------------------------------------------------------------------------
// Exact SMA windows on the full history.
const linear = linearRows('JP', '2026-10-16', 400)
const linearCloses = linear.map((row) => row.close as number)
const fixed = linearCloses.at(-1) as number
{
  const result = expectAvailable(computeSmaDynamics({ rows: linear, market: 'JP' }), 'linear')
  assert.equal(result.anchor.date, '2026-10-16')
  assert.equal(result.anchor.close, 499)
  assert.equal(result.anchor.index, 399)
  assert.equal(result.windowSessions, 63)
  assert.equal(result.horizon, 20)
  assert.equal(result.historical.length, 63)
  assert.equal(result.historical.at(-1)?.offset, 0)
  assert.equal(result.historical[0].offset, -62)
  for (const period of SMA_DYNAMICS_PERIODS) {
    near(result.periods.find((row) => row.period === period)?.anchorValue, 499 - (period - 1) / 2, `anchor SMA${period}`)
    near(result.historical.at(-1)?.sma[period], mean(linearCloses.slice(400 - period)), `anchor window SMA${period}`)
    const at = 389
    near(result.historical.find((point) => point.offset === -10)?.sma[period], mean(linearCloses.slice(at - period + 1, at + 1)), `offset -10 SMA${period}`)
    const summary = result.periods.find((row) => row.period === period)
    assert.equal(summary?.status, 'ok')
    assert.equal(summary?.required, period)
    assert.equal(summary?.available, 400)
    assert.equal(summary?.shortfall, 0)
    near(summary?.closeGapPct, ((499 - (499 - (period - 1) / 2)) / (499 - (period - 1) / 2)) * 100, `close gap SMA${period}`)
  }
}

// ---------------------------------------------------------------------------
// Price freeze: k=1 and k=N recompute the real rolling window.
for (const horizon of [20, 60]) {
  const result = expectAvailable(computeSmaDynamics({ rows: linear, market: 'JP', horizon }), `freeze ${horizon}`)
  for (const period of SMA_DYNAMICS_PERIODS) {
    near(result.projected[0].sma[period], expectedFreeze(linearCloses, fixed, period, 1), `freeze k=1 SMA${period}`)
    near(result.projected[horizon - 1].sma[period], expectedFreeze(linearCloses, fixed, period, horizon), `freeze k=${horizon} SMA${period}`)
    if (period <= horizon) near(result.projected[period - 1].sma[period], fixed, `SMA${period} equals the fixed close at T+${period}`)
    const summary = result.periods.find((row) => row.period === period)
    near(summary?.endValue, expectedFreeze(linearCloses, fixed, period, horizon), `summary end SMA${period}`)
    near(summary?.endChange, expectedFreeze(linearCloses, fixed, period, horizon) - (499 - (period - 1) / 2), `summary change SMA${period}`)
  }
  for (const point of result.projected) assert.equal(point.close, fixed, 'every projected close equals the anchor close')
}

// ---------------------------------------------------------------------------
// No linear extrapolation of the SMA slope.
{
  const result = expectAvailable(computeSmaDynamics({ rows: linear, market: 'JP', horizon: 20 }), 'no extrapolation')
  const sma5Anchor = result.historical.at(-1)?.sma[5] as number
  const sma5Prev = result.historical.at(-2)?.sma[5] as number
  near(sma5Anchor - sma5Prev, 1, 'actual SMA5 slope before the anchor')
  near(result.projected[0].sma[5], 497.8, 'SMA5 T+1 = (496+497+498+499+499)/5')
  assert.notEqual(result.projected[0].sma[5], sma5Anchor + (sma5Anchor - sma5Prev), 'T+1 must not continue the slope')
  for (const point of result.projected.slice(4)) near(point.sma[5], 499, `SMA5 flat after the window is frozen (T+${point.k})`)

  const sma25 = [result.historical.at(-1)?.sma[25] as number, ...result.projected.map((point) => point.sma[25] as number)]
  const steps = sma25.slice(1).map((value, index) => value - sma25[index])
  steps.forEach((step, index) => near(step, (25 - (index + 1)) / 25, `SMA25 step T+${index + 1} = (fixed - dropped close) / 25`))
  for (let i = 1; i < steps.length; i += 1) assert.ok(steps[i] < steps[i - 1], 'frozen SMA25 steps shrink, never constant')

  // Falling input: freeze path stays bounded by the fixed close and never overshoots it.
  const falling = linearRows('JP', '2026-10-16', 400, 900, -1)
  const fallingResult = expectAvailable(computeSmaDynamics({ rows: falling, market: 'JP', horizon: 60 }), 'falling freeze')
  for (const point of fallingResult.projected) {
    for (const period of SMA_DYNAMICS_PERIODS) {
      assert.ok((point.sma[period] as number) >= fallingResult.anchor.close - 1e-9, `falling SMA${period} T+${point.k} stays above the fixed close`)
    }
  }
}

// ---------------------------------------------------------------------------
// Horizons 5/10/20/60 use consecutive market sessions.
for (const market of ['JP', 'US'] as const) {
  const rows = linearRows(market, market === 'JP' ? '2026-10-16' : '2026-11-25', 400)
  const isSession = market === 'JP' ? isJpMarketTradingDate : isUsMarketTradingDate
  const next = market === 'JP' ? getNextJpTradingDate : getNextUsTradingDate
  for (const horizon of SMA_DYNAMICS_HORIZONS) {
    const result = expectAvailable(computeSmaDynamics({ rows, market, horizon }), `${market} horizon ${horizon}`)
    assert.equal(result.horizon, horizon)
    assert.equal(result.projected.length, horizon)
    let previous = result.anchor.date
    result.projected.forEach((point, index) => {
      assert.equal(point.k, index + 1)
      assert.ok(isSession(point.date), `${market} ${point.date} must be a session`)
      assert.equal(point.date, next(previous), `${market} T+${point.k} must be the next session after ${previous}`)
      previous = point.date
    })
  }
}

// ---------------------------------------------------------------------------
// JP and US holiday/weekend future dates.
{
  const goldenWeek = futureSessionDates('JP', '2026-04-28', 5)
  assert.deepEqual(goldenWeek, ['2026-04-30', '2026-05-01', '2026-05-07', '2026-05-08', '2026-05-11'])
  assert.notDeepEqual(goldenWeek, weekdayOnly('2026-04-28', 5), 'JP dates must not be weekday-only')
  assert.deepEqual(futureSessionDates('JP', '2025-12-30', 6), ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09', '2026-01-13'])
  assert.deepEqual(futureSessionDates('JP', '2026-10-30', 5), ['2026-11-02', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-09'])

  const thanksgiving = futureSessionDates('US', '2026-11-25', 5)
  assert.deepEqual(thanksgiving, ['2026-11-27', '2026-11-30', '2026-12-01', '2026-12-02', '2026-12-03'])
  assert.notDeepEqual(thanksgiving, weekdayOnly('2026-11-25', 5), 'US dates must not be weekday-only')
  assert.deepEqual(futureSessionDates('US', '2026-12-23', 6), ['2026-12-24', '2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-04'])
  assert.deepEqual(futureSessionDates('US', '2026-07-01', 3), ['2026-07-02', '2026-07-06', '2026-07-07'])

  const jp = expectAvailable(computeSmaDynamics({ rows: linearRows('JP', '2026-04-28', 320), market: 'JP', horizon: 5 }), 'JP GW compute')
  assert.deepEqual(jp.projected.map((point) => point.date), goldenWeek)
  const us = expectAvailable(computeSmaDynamics({ rows: linearRows('US', '2026-11-25', 320), market: 'US', horizon: 5 }), 'US Thanksgiving compute')
  assert.deepEqual(us.projected.map((point) => point.date), thanksgiving)
}

// ---------------------------------------------------------------------------
// analysisDate is a hard PIT boundary.
{
  const boundary = linear[299].date as string
  const leaked: SmaDynamicsRawRow[] = linear.map((row, index) => (index > 299 ? { ...row, close: (row.close as number) * 10 } : row))
  leaked.push({ date: linear[350].date, close: 1 })
  leaked.push({ date: linear[360].date, close: -5 })
  const withFuture = expectAvailable(computeSmaDynamics({ rows: leaked, market: 'JP', analysisDate: boundary, horizon: 60 }), 'PIT with future rows')
  const truncated = expectAvailable(computeSmaDynamics({ rows: linear.slice(0, 300), market: 'JP', analysisDate: boundary, horizon: 60 }), 'PIT truncated')
  assert.equal(withFuture.anchor.date, boundary)
  assert.equal(withFuture.excludedAfterBoundary, 102)
  assert.deepEqual(withFuture.issues, [], 'invalid rows after the boundary must not even surface')
  const comparable = (result: SmaDynamicsAvailable) => JSON.stringify({ anchor: result.anchor, historical: result.historical, projected: result.projected, periods: result.periods })
  assert.equal(comparable(withFuture), comparable(truncated), 'rows after analysisDate must not change any output')
  assert.deepEqual(withFuture.projected.map((point) => point.date), futureSessionDates('JP', boundary, 60), 'future dates come from the calendar, not later rows')
  for (const point of [...withFuture.historical, ...withFuture.projected]) {
    assert.ok(point.date <= boundary || 'k' in point, 'historical points end at the boundary')
    for (const period of SMA_DYNAMICS_PERIODS) assert.ok((point.sma[period] ?? 0) < 1000, 'no leaked x10 values')
  }

  // Non-session analysis date resolves to the last session on or before it.
  const saturday = '2026-10-17'
  const weekend = expectAvailable(computeSmaDynamics({ rows: linear, market: 'JP', analysisDate: saturday }), 'weekend analysisDate')
  assert.equal(weekend.anchor.date, '2026-10-16')
  assert.equal(weekend.analysisBoundary, saturday)

  const invalidBoundary = computeSmaDynamics({ rows: linear, market: 'JP', analysisDate: '2026-02-30' })
  assert.equal(invalidBoundary.status, 'unavailable')
  assert.equal(invalidBoundary.status === 'unavailable' && invalidBoundary.reason, 'invalid_analysis_date')

  const beforeAll = computeSmaDynamics({ rows: linear, market: 'JP', analysisDate: '2000-01-04' })
  assert.equal(beforeAll.status === 'unavailable' && beforeAll.reason, 'no_rows_before_boundary')
}

// ---------------------------------------------------------------------------
// Warmup uses the full history before slicing the visible window.
{
  const result = expectAvailable(computeSmaDynamics({ rows: linear, market: 'JP', windowSessions: 21 }), 'warmup')
  assert.equal(result.historical.length, 21)
  assert.equal(result.historical[0].offset, -20)
  near(result.historical[0].sma[300], mean(linearCloses.slice(80, 380)), 'first visible SMA300 uses 300 sessions of warmup')
  near(result.historical[0].sma[300], 329.5, 'first visible SMA300 exact value')

  const sliced = expectAvailable(computeSmaDynamics({ rows: linear.slice(-21), market: 'JP', windowSessions: 21 }), 'slice-first counterexample')
  assert.equal(sliced.historical[0].sma[300], null, 'slicing first would lose the SMA300')
  for (const item of SMA_DYNAMICS_WINDOWS) {
    const windowed = expectAvailable(computeSmaDynamics({ rows: linear, market: 'JP', windowSessions: item.sessions }), `window ${item.id}`)
    assert.equal(windowed.historical.length, item.sessions)
    near(windowed.periods.find((row) => row.period === 300)?.anchorValue, 349.5, `window ${item.id} does not change the anchor SMA300`)
  }
}

// ---------------------------------------------------------------------------
// Insufficient history is exact per SMA and never padded with frozen closes.
for (const [count, expected] of [
  [250, { 200: 0, 300: 50 }],
  [180, { 200: 20, 300: 120 }],
  [299, { 200: 0, 300: 1 }],
  [300, { 200: 0, 300: 0 }],
] as const) {
  const result = expectAvailable(computeSmaDynamics({ rows: linear.slice(-count), market: 'JP', horizon: 60 }), `history ${count}`)
  for (const period of [200, 300] as const) {
    const summary = result.periods.find((row) => row.period === period)
    assert.equal(summary?.available, count)
    assert.equal(summary?.required, period)
    assert.equal(summary?.shortfall, expected[period], `history ${count} SMA${period} shortfall`)
    assert.equal(summary?.status, expected[period] > 0 ? 'insufficient_history' : 'ok')
    if (expected[period] > 0) {
      assert.equal(summary?.anchorValue, null)
      assert.equal(summary?.endValue, null)
      assert.ok(result.projected.every((point) => point.sma[period] === null), `SMA${period} freeze must stay empty with short history`)
      assert.ok(result.historical.every((point) => point.sma[period] === null))
    }
  }
}

// ---------------------------------------------------------------------------
// Duplicate and invalid rows are surfaced and never bridged.
{
  const normalized = normalizeSmaHistory([
    { date: '2026-01-07', close: 10 },
    { date: '2026-01-05', close: 'abc' },
    { date: '2026-01-06', close: 0 },
    { date: '2026-01-08', close: -1 },
    { date: '2026-01-09', close: Number.NaN },
    { date: '2026-01-13', close: null },
    { date: '2026-01-14', close: 11 },
    { date: '2026-01-14', close: 11 },
    { date: '2026-02-30', close: 12 },
    { date: '20260115', close: 12 },
    { date: 12345, close: 12 },
    { date: '2026-01-15', close: 12 },
  ], null)
  assert.deepEqual(normalized.series, [
    { date: '2026-01-05', close: null },
    { date: '2026-01-06', close: null },
    { date: '2026-01-07', close: 10 },
    { date: '2026-01-08', close: null },
    { date: '2026-01-09', close: null },
    { date: '2026-01-13', close: null },
    { date: '2026-01-14', close: null },
    { date: '2026-01-15', close: 12 },
  ])
  assert.deepEqual(normalized.issues, [
    { kind: 'invalid_date', date: '"2026-02-30"' },
    { kind: 'invalid_date', date: '"20260115"' },
    { kind: 'invalid_date', date: '12345' },
    { kind: 'invalid_close', date: '2026-01-05', value: '"abc"' },
    { kind: 'non_positive_close', date: '2026-01-06', value: '0' },
    { kind: 'non_positive_close', date: '2026-01-08', value: '-1' },
    { kind: 'invalid_close', date: '2026-01-09', value: 'NaN' },
    { kind: 'invalid_close', date: '2026-01-13', value: 'null' },
    { kind: 'duplicate_date', date: '2026-01-14', count: 2 },
  ])

  const duplicateDate = linear[389].date as string
  const withDuplicate = [...linear, { date: duplicateDate, close: 777 }]
  const result = expectAvailable(computeSmaDynamics({ rows: withDuplicate, market: 'JP' }), 'duplicate inside SMA25 window')
  assert.deepEqual(result.issues, [{ kind: 'duplicate_date', date: duplicateDate, count: 2 }])
  assert.equal(result.anchor.index, 399, 'duplicates keep one session slot, so offsets do not shift')
  const sma5 = result.periods.find((row) => row.period === 5)
  const sma25 = result.periods.find((row) => row.period === 25)
  assert.equal(sma5?.status, 'ok')
  near(sma5?.anchorValue, 497, 'SMA5 outside the duplicate stays exact')
  assert.equal(sma25?.status, 'invalid_window')
  assert.deepEqual(sma25?.invalidDatesInWindow, [duplicateDate])
  assert.equal(sma25?.shortfall, 0)
  assert.equal(result.historical.find((point) => point.offset === -10)?.sma[25], null)
  assert.equal(result.historical.find((point) => point.offset === 0)?.sma[25], null)
  near(result.historical.find((point) => point.offset === -11)?.sma[25], mean(linearCloses.slice(364, 389)), 'window before the duplicate is intact')
  assert.ok(result.projected.every((point) => point.sma[25] === null), 'no freeze path from an invalid anchor window')
  assert.ok(result.projected.every((point) => point.sma[5] != null))

  const zeroInside = linear.map((row, index) => (index === 397 ? { ...row, close: 0 } : row))
  const zeroResult = expectAvailable(computeSmaDynamics({ rows: zeroInside, market: 'JP' }), 'zero close')
  assert.equal(zeroResult.periods.find((row) => row.period === 5)?.status, 'invalid_window')
  assert.equal(zeroResult.historical.find((point) => point.offset === -2)?.close, null)

  const anchorNaN = linear.map((row, index) => (index === 399 ? { ...row, close: Number.NaN } : row))
  const anchorInvalid = computeSmaDynamics({ rows: anchorNaN, market: 'JP' })
  assert.equal(anchorInvalid.status, 'unavailable')
  assert.equal(anchorInvalid.status === 'unavailable' && anchorInvalid.reason, 'anchor_invalid')
  assert.equal(anchorInvalid.status === 'unavailable' && anchorInvalid.anchorDate, '2026-10-16', 'must not fall back to an earlier row')
  assert.deepEqual(anchorInvalid.issues, [{ kind: 'invalid_close', date: '2026-10-16', value: 'NaN' }])

  const anchorDuplicate = computeSmaDynamics({ rows: [...linear, { date: '2026-10-16', close: 499 }], market: 'JP' })
  assert.equal(anchorDuplicate.status === 'unavailable' && anchorDuplicate.reason, 'anchor_invalid')

  const empty = computeSmaDynamics({ rows: [], market: 'US' })
  assert.equal(empty.status === 'unavailable' && empty.reason, 'no_rows')

  assert.throws(() => computeSmaDynamics({ rows: linear, market: 'JP', horizon: 0 }), RangeError)
  assert.throws(() => computeSmaDynamics({ rows: linear, market: 'JP', windowSessions: 1.5 }), RangeError)
}

// ---------------------------------------------------------------------------
// Deterministic output, independent of input order.
{
  const shuffled = [...linear.filter((_, index) => index % 2 === 1).reverse(), ...linear.filter((_, index) => index % 2 === 0)]
  const sorted = JSON.stringify(computeSmaDynamics({ rows: linear, market: 'JP', horizon: 60, windowSessions: 126 }))
  assert.equal(JSON.stringify(computeSmaDynamics({ rows: shuffled, market: 'JP', horizon: 60, windowSessions: 126 })), sorted, 'unsorted input sorts ascending')
  assert.equal(JSON.stringify(computeSmaDynamics({ rows: linear, market: 'JP', horizon: 60, windowSessions: 126 })), sorted, 'repeat run is identical')

  assert.equal(JSON.stringify(buildSmaDynamicsFixtures()), JSON.stringify(SMA_DYNAMICS_FIXTURES), 'fixtures rebuild identically')
  for (const fixture of SMA_DYNAMICS_FIXTURES) {
    for (const horizon of SMA_DYNAMICS_HORIZONS) {
      const input = { rows: fixture.rows, market: fixture.market, analysisDate: fixture.analysisDate, horizon }
      const first = JSON.stringify(computeSmaDynamics(input))
      assert.equal(JSON.stringify(computeSmaDynamics(input)), first, `${fixture.id} h${horizon} deterministic`)
      assert.equal(JSON.stringify(computeSmaDynamics({ ...input, rows: [...fixture.rows].reverse() })), first, `${fixture.id} h${horizon} order independent`)
    }
  }
}

// ---------------------------------------------------------------------------
// Fixture cases exercise the intended shapes.
{
  const fixture = (id: string) => {
    const found = findSmaDynamicsFixture(id)
    assert.ok(found, `fixture ${id}`)
    return found
  }
  const run = (id: string, windowSessions = 63) => {
    const item = fixture(id)
    return computeSmaDynamics({ rows: item.rows, market: item.market, analysisDate: item.analysisDate, windowSessions })
  }
  const value = (result: SmaDynamicsAvailable, period: SmaDynamicsPeriod) => result.periods.find((row) => row.period === period)?.anchorValue as number

  const rising = expectAvailable(run('jp-rising'), 'jp-rising')
  assert.ok(value(rising, 5) > value(rising, 300), 'rising: SMA5 above SMA300')
  const falling = expectAvailable(run('us-falling'), 'us-falling')
  assert.ok(value(falling, 5) < value(falling, 300), 'falling: SMA5 below SMA300')
  assert.deepEqual(falling.projected.slice(0, 2).map((point) => point.date), ['2026-11-27', '2026-11-30'])
  expectAvailable(run('jp-sideways'), 'jp-sideways')

  const crossing = expectAvailable(run('us-crossing', 126), 'us-crossing')
  const first = crossing.historical[0]
  const last = crossing.historical.at(-1)
  assert.ok((first.sma[25] as number) < (first.sma[75] as number), 'crossing: SMA25 below SMA75 at the 6m window start')
  assert.ok((last?.sma[25] as number) > (last?.sma[75] as number), 'crossing: SMA25 above SMA75 at the anchor')
  assert.ok(crossing.projected.some((point) => point.date === '2027-01-04'), 'crossing: US year-end closures skipped')

  const short = expectAvailable(run('jp-short-history'), 'jp-short-history')
  assert.equal(short.periods.find((row) => row.period === 200)?.shortfall, 20)
  assert.equal(short.periods.find((row) => row.period === 300)?.shortfall, 120)

  const pit = expectAvailable(run('jp-pit-boundary'), 'jp-pit-boundary')
  assert.equal(pit.anchor.date, '2026-06-30')
  assert.ok(pit.excludedAfterBoundary > 0)
  for (const point of [...pit.historical, ...pit.projected]) {
    assert.ok((point.close ?? 0) < 6000)
    for (const period of SMA_DYNAMICS_PERIODS) assert.ok((point.sma[period] ?? 0) < 6000, 'pit: post-boundary spike never enters')
  }

  const invalid = expectAvailable(run('jp-invalid-data'), 'jp-invalid-data')
  assert.deepEqual([...new Set(invalid.issues.map((issue) => issue.kind))].sort(), ['duplicate_date', 'invalid_close', 'invalid_date', 'non_positive_close'])
  assert.equal(invalid.periods.find((row) => row.period === 5)?.status, 'ok')
  for (const period of [25, 75, 150, 200, 300] as const) {
    assert.equal(invalid.periods.find((row) => row.period === period)?.status, 'invalid_window', `invalid fixture SMA${period}`)
  }

  const anchorInvalid = run('jp-anchor-invalid')
  assert.equal(anchorInvalid.status === 'unavailable' && anchorInvalid.reason, 'anchor_invalid')
  const empty = run('empty')
  assert.equal(empty.status === 'unavailable' && empty.reason, 'no_rows')
}

// ---------------------------------------------------------------------------
// Stage logic is untouched and isolated from SMA dynamics (source contract).
{
  const timeframes = readFileSync('lib/timeframes.ts', 'utf8')
  // Main routes the stage rule through lib/stage-classification; SMA dynamics must not touch either.
  assert.ok(timeframes.includes(`export function stageFromThreeMa(ma1: number | null, ma2: number | null, ma3: number | null): number | null {
  return calculateStageFromThreeMa(ma1, ma2, ma3)
}`), 'stageFromThreeMa must keep delegating to the shared stage classification')

  const lib = readFileSync('lib/sma-dynamics.ts', 'utf8')
  const imports = [...lib.matchAll(/from '([^']+)'/g)].map((match) => match[1]).sort()
  assert.deepEqual(imports, ['@/lib/server/jp-market-calendar', '@/lib/server/us-data-freshness', '@/lib/timeframes', '@/types/stock'])
  assert.match(lib, /import \{ smaAt \} from '@\/lib\/timeframes'/, 'reuse the shared SMA math')
  assert.doesNotMatch(lib, /stageFromThreeMa|calculateStageFromThreeMa|stage-classification|hex-stage|StageTimeline|ma-trajectory|\/ml\//)
  assert.doesNotMatch(lib, /Math\.random|Date\.now|new Date\(\)/, 'no nondeterministic inputs')
  assert.doesNotMatch(lib, /reveal|showActual/i, 'no option can bypass the PIT boundary')

  const fixtures = readFileSync('lib/sma-dynamics-fixtures.ts', 'utf8')
  assert.doesNotMatch(fixtures, /Math\.random|Date\.now|new Date\(\)|fetch\(|@\/lib\/db|@\/lib\/queries/)
}

console.log('test-sma-dynamics: ok')
