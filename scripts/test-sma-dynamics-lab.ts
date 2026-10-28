// SMA Dynamics Lab contract: timeframe-linked SMAs, Price Freeze per timeframe,
// display-range invariance, Phase 1 parity, chart-model semantics, determinism.
// Fixture data only; no database, API or network.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { computeSmaDynamics, SMA_DYNAMICS_HORIZONS, SMA_DYNAMICS_PERIODS, type SmaDynamicsAvailable } from '@/lib/sma-dynamics'
import {
  computeSmaLab,
  describeHorizon,
  firstBarIndexInRange,
  projectSmaPath,
  priceFreezePath,
  SMA_LAB_COLORS,
  SMA_LAB_DEFAULT_PERIODS,
  SMA_LAB_DEFAULT_RANGE,
  SMA_LAB_PERIODS,
  SMA_LAB_PHASE1_PERIODS,
  SMA_LAB_RANGES,
  smaLabDefaultHorizon,
  smaLabHorizonOptions,
  smaLabMaxHorizonBars,
  smaLabRangeStart,
  visibleSlotRange,
  zoomSlotRange,
  type SmaLabAvailable,
  type SmaLabResult,
} from '@/lib/sma-dynamics-lab'
import { createTimeframeBucketContext, getTimeframeBucketKey } from '@/lib/timeframes'
import { buildSmaLabChartModel, dateToChartTime, futureRegionPixelRange } from '@/lib/sma-dynamics-chart-model'
import { addCalendarDays, SMA_LAB_TIMEFRAMES, smaLabCalendar, type SmaLabTimeframeId } from '@/lib/sma-dynamics-timeframes'
import { findSmaDynamicsFixture, fixtureSessionDates, SMA_DYNAMICS_FIXTURES } from '@/lib/sma-dynamics-fixtures'
import { MOVING_AVERAGE_COLORS } from '@/lib/chart-colors'

function near(actual: number | null | undefined, expected: number, message: string) {
  assert.ok(actual != null && Number.isFinite(actual), `${message}: expected a number, got ${actual}`)
  assert.ok(Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected)), `${message}: ${actual} !== ${expected}`)
}
function available(result: SmaLabResult, message: string): SmaLabAvailable {
  assert.equal(result.status, 'available', `${message}: ${result.status === 'unavailable' ? result.reason : ''}`)
  return result as SmaLabAvailable
}
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length
const fixture = (id: string) => {
  const found = findSmaDynamicsFixture(id)
  assert.ok(found, id)
  return found
}
const run = (id: string, timeframe: SmaLabTimeframeId, horizon?: number) => {
  const item = fixture(id)
  return computeSmaLab({ rows: item.rows, market: item.market, analysisDate: item.analysisDate, timeframe, horizon })
}

// ---------------------------------------------------------------------------
// Catalogue
assert.deepEqual([...SMA_LAB_PERIODS], [3, 5, 10, 13, 25, 50, 75, 100, 150, 200, 300])
assert.deepEqual([...SMA_LAB_DEFAULT_PERIODS], [5, 25, 75], 'representative SMAs only on first open')
for (const period of SMA_DYNAMICS_PERIODS) assert.ok((SMA_LAB_PERIODS as readonly number[]).includes(period), `Phase 1 SMA${period} stays selectable`)
assert.deepEqual([...SMA_LAB_PHASE1_PERIODS], [5, 25, 75, 150, 200, 300])
const ONE_TO_TWENTY = Array.from({ length: 20 }, (_, i) => i + 1)
assert.deepEqual(smaLabHorizonOptions('1D'), [...ONE_TO_TWENTY, 60], '1D keeps arbitrary 1..20 plus the Phase 1 60 sessions')
for (const timeframe of SMA_LAB_TIMEFRAMES.filter((item) => item.id !== '1D')) {
  // Bars up to 2Y reach 20 bars; 3Y / 5Y stop earlier so the projection stays inside the supported calendar.
  const cap = smaLabMaxHorizonBars(timeframe.id)
  assert.deepEqual(smaLabHorizonOptions(timeframe.id), ONE_TO_TWENTY.slice(0, cap), `${timeframe.id}: arbitrary 1..${cap} bars selectable`)
}
assert.deepEqual(['1W', '3M', '1Y', '2Y', '3Y', '5Y'].map((id) => smaLabMaxHorizonBars(id as SmaLabTimeframeId)), [20, 20, 20, 20, 13, 8])
assert.ok(smaLabDefaultHorizon('5Y') <= smaLabMaxHorizonBars('5Y'))
assert.equal(smaLabDefaultHorizon('1D'), 20)
assert.equal(smaLabDefaultHorizon('1W'), 5)
assert.deepEqual(SMA_LAB_RANGES.map((item) => item.id), ['1w', '2w', '1m', '3m', '6m', '1y', '3y', 'all'])
assert.equal(SMA_LAB_DEFAULT_RANGE, '6m')
{
  const colors = SMA_LAB_PERIODS.map((period) => SMA_LAB_COLORS[period])
  assert.equal(new Set(colors).size, colors.length, 'every SMA period has its own color')
  for (const period of [3, 5, 25, 75, 200] as const) assert.equal(SMA_LAB_COLORS[period], MOVING_AVERAGE_COLORS[period], `SMA${period} matches the legacy shared palette`)
  assert.equal(MOVING_AVERAGE_COLORS[150], undefined, 'SMA150 keeps the pre-Lab shared-chart fallback')
  assert.equal(MOVING_AVERAGE_COLORS[300], undefined, 'SMA300 keeps the pre-Lab shared-chart fallback')
  assert.equal(SMA_LAB_COLORS[150], '#7c3aed', 'the Lab owns its SMA150 color')
  assert.equal(SMA_LAB_COLORS[300], '#0e7490', 'the Lab owns its SMA300 color')
  assert.equal(MOVING_AVERAGE_COLORS[13], '#dc2626', 'shared palette untouched')
}

// ---------------------------------------------------------------------------
// Phase 1 regression: 1D lab equals Phase 1 exactly for every fixture and horizon.
for (const item of SMA_DYNAMICS_FIXTURES) {
  for (const horizon of SMA_DYNAMICS_HORIZONS) {
    const phase1Result = computeSmaDynamics({ rows: item.rows, market: item.market, analysisDate: item.analysisDate, horizon })
    const labResult = computeSmaLab({ rows: item.rows, market: item.market, analysisDate: item.analysisDate, horizon, timeframe: '1D' })
    assert.equal(labResult.status, phase1Result.status, `${item.id} status`)
    if (phase1Result.status === 'unavailable' || labResult.status === 'unavailable') {
      assert.equal(labResult.status === 'unavailable' && labResult.reason, phase1Result.status === 'unavailable' && phase1Result.reason, `${item.id} reason`)
      continue
    }
    const phase1: SmaDynamicsAvailable = phase1Result
    const lab: SmaLabAvailable = labResult
    assert.equal(lab.asOf.date, phase1.anchor.date)
    assert.equal(lab.asOf.close, phase1.anchor.close)
    if (lab.issues.some((issue) => issue.kind === 'missing_session')) {
      // Intended Phase 1.1 change: Phase 1 had no calendar and bridged a missing session;
      // the lab keeps the session slot and leaves every touching window empty.
      assert.ok(['jp-listing-gap', 'jp-7003-gap'].includes(item.id), 'only explicit gap fixtures have calendar gaps')
      const gapDate = item.id === 'jp-7003-gap' ? '2026-07-17' : '2026-07-08'
      const gapBar = lab.bars.find((bar) => bar.firstSession === gapDate)!
      assert.equal(gapBar.close, null)
      assert.equal(lab.sma[5][gapBar.index + 1], null, 'lab: window touching the gap is empty')
      assert.notEqual(phase1.historical.length, 0)
      continue
    }
    for (const period of SMA_DYNAMICS_PERIODS) {
      const a = phase1.periods.find((row) => row.period === period)!
      const b = lab.periods.find((row) => row.period === period)!
      assert.equal(b.status, a.status, `${item.id} h${horizon} SMA${period} status`)
      assert.equal(b.anchorValue, a.anchorValue, `${item.id} h${horizon} SMA${period} anchor (bit-identical)`)
      assert.equal(b.endValue, a.endValue, `${item.id} h${horizon} SMA${period} end`)
      assert.equal(b.shortfall, a.shortfall)
      phase1.projected.forEach((point, index) => {
        assert.equal(lab.projection.sma[period][index], point.sma[period], `${item.id} h${horizon} SMA${period} T+${point.k}`)
        assert.equal(lab.projection.bars[index].lastSession, point.date, `${item.id} T+${point.k} date`)
      })
      for (const point of phase1.historical) {
        const bar = lab.bars.find((candidate) => candidate.firstSession === point.date)!
        assert.equal(lab.sma[period][bar.index], point.sma[period], `${item.id} ${point.date} SMA${period}`)
      }
    }
  }
}

// Production 7003 regression: the market session is retained, the strict SMA75 is
// unavailable, and chart whitespace prevents a later valid segment from bridging it.
{
  const result = available(run('jp-7003-gap', '1D', 5), '7003 gap')
  const summary = result.periods.find((item) => item.period === 75)!
  assert.equal(result.asOf.date, '2026-10-28')
  assert.equal(summary.status, 'invalid_window')
  assert.deepEqual(summary.invalidBarsInWindow, ['2026-07-17'])
  assert.ok(result.issues.some((issue) => issue.kind === 'missing_session' && issue.date === '2026-07-17'))
  const lastValid = result.sma[75].findLastIndex((value) => value != null)
  assert.equal(result.bars[lastValid].lastSession, '2026-07-16')
  const model = buildSmaLabChartModel(result, [75])
  const missing = model.actual.get(75)!.find((point) => point.time === dateToChartTime('2026-07-17'))!
  assert.ok(!('value' in missing), 'the missing session is chart whitespace, not a bridged point')
}

// Once the missing session has rolled out of a 75-session window, SMA75 resumes.
{
  const dates = fixtureSessionDates('JP', '2026-12-18', 210)
  const rows = dates.filter((date) => date !== '2026-07-17').map((date, index) => ({ date, close: 3000 + index }))
  const result = available(computeSmaLab({ rows, market: 'JP', analysisDate: null, timeframe: '1D', horizon: 5 }), 'gap recovery')
  const gapIndex = result.bars.findIndex((bar) => bar.lastSession === '2026-07-17')
  assert.ok(gapIndex > 75)
  assert.equal(result.sma[75][gapIndex + 74], null)
  assert.notEqual(result.sma[75][gapIndex + 75], null, 'SMA resumes only after the gap leaves the strict window')
  const line = buildSmaLabChartModel(result, [75]).actual.get(75)!
  assert.ok(!('value' in line[gapIndex + 74]) && 'value' in line[gapIndex + 75])
}

// The future hatch is bounded by the actual forecast interval, not the pane edge.
assert.deepEqual(futureRegionPixelRange({
  anchorX: 100, nextAnchorX: 110, lastX: 150, nextLastX: 160, previousLastX: 140, paneWidth: 400,
}), { left: 105, right: 155 })
assert.deepEqual(futureRegionPixelRange({
  anchorX: -20, nextAnchorX: -10, lastX: 390, nextLastX: null, previousLastX: 380, paneWidth: 400,
}), { left: 0, right: 395 })
assert.equal(futureRegionPixelRange({
  anchorX: 420, nextAnchorX: 430, lastX: 450, nextLastX: 460, previousLastX: 440, paneWidth: 400,
}), null)

// ---------------------------------------------------------------------------
// Independent reference: naive session numbering, grouping and SMA.
function referenceBars(id: string, timeframe: SmaLabTimeframeId) {
  const item = fixture(id)
  const tf = SMA_LAB_TIMEFRAMES.find((entry) => entry.id === timeframe)!
  const calendar = smaLabCalendar(item.market)
  const closes = new Map(item.rows.map((row) => [row.date as string, row.close as number]))
  const dates = [...closes.keys()].sort()
  const asOf = dates.at(-1)!
  // Naive grouping straight from the main chart's bucket function (lib/timeframes), fed the market's
  // full session list: 2D/3D/5D number sessions per exchange year, 2W/3W restart each year (TradingView).
  const allSessions: string[] = []
  for (let date = `${dates[0].slice(0, 4)}-01-01`; date <= addCalendarDays(asOf, 400); date = addCalendarDays(date, 1)) {
    if (calendar.isSession(date)) allSessions.push(date)
  }
  const chartContext = createTimeframeBucketContext(allSessions)
  const keyOf = (date: string): string => {
    const n = tf.spec.count
    if (tf.spec.unit === 'session') return getTimeframeBucketKey(date, { timeframe: 'day', multiplier: n }, chartContext)
    if (tf.spec.unit === 'week') return getTimeframeBucketKey(date, { timeframe: 'week', multiplier: n })
    const months = (Number(date.slice(0, 4)) - 1970) * 12 + Number(date.slice(5, 7)) - 1
    return `m${Math.floor(months / n)}`
  }
  const groups = new Map<string, string[]>()
  for (const date of allSessions) {
    if (date < dates[0]) continue
    const key = keyOf(date)
    const list = groups.get(key) ?? []
    list.push(date)
    groups.set(key, list)
  }
  const confirmed: number[] = []
  for (const sessions of groups.values()) {
    if (sessions.at(-1)! > asOf) break
    confirmed.push(closes.get(sessions.at(-1)!)!)
  }
  return { confirmed, asOfClose: closes.get(asOf)! }
}

for (const id of ['jp-rising', 'us-falling', 'us-crossing']) {
  for (const timeframe of SMA_LAB_TIMEFRAMES) {
    const result = available(run(id, timeframe.id, 5), `${id} ${timeframe.id}`)
    const reference = referenceBars(id, timeframe.id)
    const labConfirmed = result.bars.slice(0, result.lastConfirmedIndex! + 1).map((bar) => bar.close)
    // The reference starts at the first full bucket list; align from the end.
    const tail = labConfirmed.slice(-reference.confirmed.length)
    assert.deepEqual(tail.slice(1), reference.confirmed.slice(1), `${id} ${timeframe.id}: confirmed closes match the naive grouping`)
    const last = result.lastConfirmedIndex!
    for (const period of SMA_LAB_PERIODS) {
      if (period > reference.confirmed.length - 1) continue
      near(result.sma[period][last], mean(reference.confirmed.slice(-period)), `${id} ${timeframe.id} SMA${period} = mean of last ${period} confirmed ${timeframe.barNoun} closes`)
      // Price Freeze: real rolling window over confirmed closes + k frozen closes.
      result.projection.bars.forEach((bar, offset) => {
        const k = offset + 1
        const real = k >= period ? [] : reference.confirmed.slice(-(period - k))
        near(result.projection.sma[period][offset], mean([...real, ...Array<number>(Math.min(k, period)).fill(reference.asOfClose)]), `${id} ${timeframe.id} SMA${period} freeze T+${k}`)
        assert.equal(bar.close, reference.asOfClose)
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Price Freeze across timeframes: horizons, future boundaries, forming completion, no slope extrapolation.
{
  for (const [id, timeframe] of [['jp-rising', '1D'], ['jp-rising', '2D'], ['us-falling', '1W'], ['jp-rising', '3M'], ['jp-long-history', '3M']] as const) {
    for (const horizon of smaLabHorizonOptions(timeframe)) {
      const result = available(run(id, timeframe, horizon), `${id} ${timeframe} h${horizon}`)
      assert.equal(result.projection.bars.length, horizon, 'one future bar per requested bar')
      result.projection.bars.forEach((bar, index) => {
        assert.equal(bar.k, index + 1)
        assert.ok(bar.lastSession > result.asOf.date, 'future bar ends after the as-of date')
        assert.ok(smaLabCalendar(result.market).isSession(bar.lastSession), 'end date is a market session')
        if (index > 0) assert.ok(bar.firstSession > result.projection.bars[index - 1].lastSession, 'consecutive buckets')
      })
      assert.equal(result.projection.bars[0].completesForming, result.formingIndex != null, 'first future bar completes the forming bar when one exists')
    }
  }
  const quarterly = available(run('jp-rising', '3M', 5), '3M')
  assert.deepEqual(quarterly.projection.bars.map((bar) => bar.lastSession), ['2026-12-30', '2027-03-31', '2027-06-30', '2027-09-30', '2027-12-30'], '3M: future quarter ends from the JP calendar')
  const weekly = available(run('us-falling', '1W', 3), '1W')
  assert.deepEqual(weekly.projection.bars.map((bar) => bar.lastSession), ['2026-11-27', '2026-12-04', '2026-12-11'])
  assert.equal(weekly.projection.bars[0].sessionsAhead, 1)
  assert.equal(describeHorizon('1W', 3, weekly.projection.bars), '3本 = 週足×3（基準日の後 11営業日・現在の未確定足を含む）')
  assert.equal(describeHorizon('1D', 20), '20本 = 20営業日')
  assert.equal(describeHorizon('2D', 5), '5本 = 2営業日足×5')

  // Linear history: freeze is a rolling recomputation, never a slope extension.
  const rows = fixtureSessionDates('JP', '2026-10-16', 400).map((date, index) => ({ date, open: 100 + index, high: 101 + index, low: 99 + index, close: 100 + index, volume: 1 }))
  const linear = available(computeSmaLab({ rows, market: 'JP', timeframe: '1D', horizon: 20 }), 'linear')
  near(linear.projection.sma[5][0], 497.8, 'SMA5 T+1 = (496+497+498+499+499)/5')
  assert.notEqual(linear.projection.sma[5][0], 498, 'T+1 must not continue the slope')
  for (let k = 5; k <= 20; k += 1) near(linear.projection.sma[5][k - 1], 499, `SMA5 flat once the window is frozen (T+${k})`)

  // Generic path API used by Phase 2: freeze is just a constant path.
  assert.deepEqual(projectSmaPath([1, 2, 3, 4], priceFreezePath(4, 2), 2), [4, 4])
  assert.deepEqual(projectSmaPath([1, 2, 3, 4], [6, 8], 3), [13 / 3, 6])
  assert.deepEqual(projectSmaPath([1, 2], [5], 3), [null], 'short history is never padded with assumed closes')
  assert.throws(() => computeSmaLab({ rows, market: 'JP', timeframe: '1D', horizon: 0 }), RangeError)
  assert.throws(() => computeSmaLab({ rows, market: 'JP', timeframe: '1D', horizon: 61 }), RangeError)
}

// ---------------------------------------------------------------------------
// Confirmed vs provisional SMA on a forming bar.
{
  const result = available(run('us-falling', '1W', 5), 'forming')
  const forming = result.formingIndex!
  assert.equal(result.bars[forming].phase, 'forming')
  for (const period of SMA_LAB_PERIODS) assert.equal(result.sma[period][forming], null, `SMA${period}: forming bar never in the confirmed series`)
  const summary = result.periods.find((row) => row.period === 5)!
  const confirmed = result.bars.slice(0, forming).map((bar) => bar.close as number)
  near(summary.anchorValue, mean(confirmed.slice(-5)), 'anchor = last confirmed SMA5')
  near(summary.provisionalValue, mean([...confirmed.slice(-4), result.asOf.close]), 'provisional SMA5 includes the forming close')
  near(result.projection.sma[5][0], summary.provisionalValue!, 'freeze T+1 completes the forming bar at the as-of close')
  assert.notEqual(summary.provisionalValue, summary.anchorValue)
}

// ---------------------------------------------------------------------------
// Long histories and insufficient history are exact per timeframe.
{
  const long1m = available(run('jp-long-history', '1M'), '1M long')
  assert.equal(long1m.periods.find((row) => row.period === 300)!.status, 'ok', '1M x SMA300 computable from 2000')
  const long3m = available(run('jp-long-history', '3M'), '3M long')
  const sma300 = long3m.periods.find((row) => row.period === 300)!
  assert.equal(sma300.status, 'insufficient_history')
  assert.equal(sma300.available, long3m.lastConfirmedIndex! + 1)
  assert.equal(sma300.shortfall, 300 - sma300.available)
  assert.equal(sma300.anchorValue, null)
  assert.ok(long3m.projection.sma[300].every((value) => value === null), 'no freeze path without a real anchor value')
  assert.ok(long3m.sma[300].every((value) => value === null), 'no fabricated quarterly SMA300')
  const weekly = available(run('jp-long-history', '1W'), '1W long')
  assert.equal(weekly.periods.find((row) => row.period === 300)!.status, 'ok')
  const short = available(run('jp-short-history', '1W'), 'short 1W')
  for (const summary of short.periods) assert.equal(summary.shortfall, Math.max(0, summary.period - summary.available))
}

// ---------------------------------------------------------------------------
// Display range and focus never change computed values.
{
  for (const timeframe of SMA_LAB_TIMEFRAMES) {
    const first = run('jp-long-history', timeframe.id, 5)
    const snapshot = JSON.stringify(first)
    const result = available(first, timeframe.id)
    const model = buildSmaLabChartModel(result, SMA_LAB_PERIODS)
    let previous = -1
    for (const range of [...SMA_LAB_RANGES].reverse()) {
      const start = firstBarIndexInRange(result.bars, smaLabRangeStart(result.asOf.date, range.id))
      assert.ok(start >= previous, `${timeframe.id}: shorter ranges start later (${range.id})`)
      previous = start
      for (const focus of ['both', 'past', 'future'] as const) {
        const view = visibleSlotRange({ firstPastSlot: start, anchorSlot: model.anchorSlot, lastSlot: model.lastSlot, focus })
        assert.ok(view.to > view.from)
        if (focus === 'past') assert.ok(view.to <= model.anchorSlot + 1.5, 'past focus hides the future')
        if (focus === 'future') {
          assert.equal(view.to, model.lastSlot + 1)
          assert.ok(view.from >= model.anchorSlot - 10.5, 'future focus is a close-up')
        }
      }
    }
    assert.equal(JSON.stringify(run('jp-long-history', timeframe.id, 5)), snapshot, `${timeframe.id}: recomputation identical; range/focus are view-only`)
  }
  const computeSignature = readFileSync('lib/sma-dynamics-lab.ts', 'utf8').match(/export interface ComputeSmaLabInput \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.doesNotMatch(computeSignature, /range|focus|zoom|visible/i, 'the computation has no display-range input')

  assert.equal(smaLabRangeStart('2026-10-16', '1w'), '2026-10-09')
  assert.equal(smaLabRangeStart('2026-10-16', '3m'), '2026-07-16')
  assert.equal(smaLabRangeStart('2026-10-16', 'all'), null)
  const rising3m = available(run('jp-rising', '3M'), '3M few')
  const few = firstBarIndexInRange(rising3m.bars, smaLabRangeStart(rising3m.asOf.date, '3m'))
  assert.equal(rising3m.bars.length - few, 2, '3M bars in a 3-month range: 2 (UI says so, never switches timeframe)')

  const zoomed = zoomSlotRange({ from: 10, to: 30 }, 0.5, { from: -0.5, to: 100 })
  assert.deepEqual(zoomed, { from: 15, to: 25 })
  assert.deepEqual(zoomSlotRange({ from: 10, to: 12 }, 0.1, { from: -0.5, to: 100 }), { from: 9.5, to: 12.5 }, 'never narrower than 3 bars')
  assert.deepEqual(zoomSlotRange({ from: 0, to: 90 }, 10, { from: -0.5, to: 100 }), { from: -0.5, to: 100 }, 'never beyond the data')
}

// ---------------------------------------------------------------------------
// Chart model: actual vs assumption.
for (const [id, timeframe] of [['jp-rising', '1D'], ['us-falling', '1W'], ['jp-listing-gap', '1W'], ['jp-rising', '3M']] as const) {
  const result = available(run(id, timeframe, 5), `${id} ${timeframe} model`)
  const model = buildSmaLabChartModel(result, SMA_LAB_PERIODS)
  assert.equal(model.slots.length, model.lastSlot + 1)
  assert.equal(model.candles.length, model.slots.length)
  for (let i = 1; i < model.slots.length; i += 1) assert.ok(model.slots[i].time > model.slots[i - 1].time, 'strictly ascending times')
  model.slots.forEach((slot, index) => {
    if (slot.kind === 'future') assert.deepEqual(Object.keys(model.candles[index]), ['time'], 'no candle (OHLC) is drawn for future bars')
  })
  const forming = result.formingIndex
  for (const period of SMA_LAB_PERIODS) {
    const actual = model.actual.get(period)!
    if (forming != null) assert.ok(actual.every((point) => point.time !== model.slots[forming].time), 'solid line excludes the forming bar')
    const future = model.future.get(period)!
    if (future.length > 0) {
      assert.equal(future[0].time, model.slots[result.lastConfirmedIndex!].time, 'dotted line starts at the last confirmed bar')
      assert.equal(future[0].value, result.sma[period][result.lastConfirmedIndex!])
      assert.equal(future.length, result.projection.bars.length + 1)
    }
  }
  assert.ok(model.frozenClose.every((point) => point.value === result.asOf.close))
  assert.equal(model.frozenClose[0].time, model.slots[model.anchorSlot].time)
  assert.equal(model.frozenClose.at(-1)!.time, model.slots[model.lastSlot].time)
  if (forming != null) {
    const candle = model.candles[forming]
    assert.ok(candle.color?.startsWith('rgba('), 'forming candle is translucent')
  }
}
{
  const gap = available(run('jp-listing-gap', '1W', 3), 'gap')
  const model = buildSmaLabChartModel(gap, [5])
  const leading = gap.bars[0]
  assert.ok(leading.leadingPartial)
  assert.equal(model.candles[0].color, '#cbd5e1', 'listing week drawn as incomplete')
  const missingFriday = gap.bars.find((bar) => bar.lastSession === '2026-08-21')!
  assert.equal(missingFriday.closeExact, false)
  assert.deepEqual(Object.keys(model.candles[missingFriday.index]), ['time'], 'no candle when the closing session is missing')
  for (const period of [3, 5, 13] as const) {
    for (let offset = 0; offset < period; offset += 1) {
      const index = missingFriday.index + offset
      if (index <= gap.lastConfirmedIndex!) assert.equal(gap.sma[period][index], null, `SMA${period} windows touching the missing close are not bridged`)
    }
  }
}

// ---------------------------------------------------------------------------
// PIT boundary for every timeframe.
for (const timeframe of SMA_LAB_TIMEFRAMES) {
  const item = fixture('jp-pit-boundary')
  const withFuture = available(computeSmaLab({ rows: item.rows, market: 'JP', analysisDate: item.analysisDate, timeframe: timeframe.id, horizon: 5 }), `pit ${timeframe.id}`)
  const truncated = available(computeSmaLab({ rows: item.rows.filter((row) => (row.date as string) <= item.analysisDate!), market: 'JP', analysisDate: item.analysisDate, timeframe: timeframe.id, horizon: 5 }), `pit trunc ${timeframe.id}`)
  assert.equal(withFuture.asOf.date, '2026-06-30')
  assert.ok(withFuture.excludedAfterBoundary > 0)
  const strip = (result: SmaLabAvailable) => JSON.stringify({ bars: result.bars, sma: result.sma, projection: result.projection, periods: result.periods })
  assert.equal(strip(withFuture), strip(truncated), `${timeframe.id}: rows after analysisDate change nothing`)
  if (timeframe.id === '1M') assert.equal(withFuture.formingIndex, null, 'June bar is confirmed on 06-30')
  if (timeframe.id === '3M') assert.equal(withFuture.formingIndex, null, 'Q2 confirmed on 06-30')
}

// ---------------------------------------------------------------------------
// Unavailable states and determinism / replay.
{
  assert.equal((run('jp-anchor-invalid', '1W') as { reason?: string }).reason, 'anchor_invalid')
  assert.equal((run('empty', '3M') as { reason?: string }).reason, 'no_rows')
  const invalid = available(run('jp-invalid-data', '1W'), 'invalid 1W')
  assert.deepEqual([...new Set(invalid.issues.map((issue) => issue.kind))].sort(), ['duplicate_date', 'invalid_close', 'invalid_date', 'invalid_ohlc', 'non_positive_close'])

  for (const item of SMA_DYNAMICS_FIXTURES) {
    for (const timeframe of SMA_LAB_TIMEFRAMES) {
      const input = { rows: item.rows, market: item.market, analysisDate: item.analysisDate, timeframe: timeframe.id }
      const first = JSON.stringify(computeSmaLab(input))
      assert.equal(JSON.stringify(computeSmaLab(input)), first, `${item.id} ${timeframe.id} deterministic`)
      assert.equal(JSON.stringify(computeSmaLab({ ...input, rows: [...item.rows].reverse() })), first, `${item.id} ${timeframe.id} order independent`)
    }
  }
}

// ---------------------------------------------------------------------------
// Responsiveness budget for the largest fixture (26 years of daily rows).
{
  const item = fixture('jp-long-history')
  const started = performance.now()
  for (const timeframe of SMA_LAB_TIMEFRAMES) computeSmaLab({ rows: item.rows, market: 'JP', timeframe: timeframe.id })
  const elapsed = performance.now() - started
  assert.ok(elapsed < 4000, `all 8 timeframes over ${item.rows.length} rows in ${elapsed.toFixed(0)}ms`)
}

console.log('test-sma-dynamics-lab: ok')
