// SMA Dynamics Lab: one shared DAILY future-close scenario projected onto all 15 timeframes.
// Deterministic synthetic histories only; no database, API or network.
//
// Independent reference: the same history plus the entered future sessions is fed to the main chart's
// own resampler (lib/timeframes) and SMA (smaAt). A chart bar is complete when the next market
// session starts another chart bucket; the lab must confirm exactly those bars and no others.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SMA_DYNAMICS_DEFAULT_SETTINGS, SmaDynamicsView } from '@/components/stock/sma-dynamics/SmaDynamicsView'
import { findSmaDynamicsFixture } from '@/lib/sma-dynamics-fixtures'
import type { OHLCV } from '@/types/stock'
import {
  CHART_INTERVAL_OPTIONS,
  createTimeframeBucketContext,
  getTimeframeBucketKey,
  intervalToSpec,
  resampleOhlcv,
  resampleOhlcvWithTradingSessions,
  smaAt,
  type TimeframeSpec,
} from '@/lib/timeframes'
import { computeSmaLab, type SmaLabAvailable, type SmaLabResult } from '@/lib/sma-dynamics-lab'
import {
  analyzeSolverGoal,
  checkGoal,
  cleanFloat,
  DAILY_SCENARIO_DEFAULT_SESSIONS,
  emptyDailyScenario,
  evaluateScenario,
  forwardBase,
  freshSimulationState,
  projectAllSma,
  representativePath,
  scopeSimulationState,
  scenarioFromCloses,
  simulationIdentity,
  type DailyScenarioDraft,
} from '@/lib/sma-dynamics-scenario'
import {
  adaptationApplied,
  adaptDailyScenarioToTimeframe,
  clearDaily,
  convertDailyUnit,
  dailyFutureSessions,
  dailyPresetFlat,
  dailyPresetRate,
  dailyPresetShock,
  dailyPresetTarget,
  dailyTargetCloses,
  describeDailyAdaptation,
  describeDailyBar,
  exactPriceText,
  evaluateDailyScenario,
  projectDailyScenario,
  setDailyInput,
  setDailySessions,
  type DailyScenarioProjection,
  type DailyTimeframeProjection,
} from '@/lib/sma-dynamics-daily-scenario'
import { SMA_LAB_TIMEFRAMES, sessionsBetween, smaLabCalendar, type SmaLabRawRow, type SmaLabTimeframeId } from '@/lib/sma-dynamics-timeframes'
import type { SmaDynamicsMarket } from '@/lib/sma-dynamics'

// ---------------------------------------------------------------------------
// Synthetic histories

function history(market: SmaDynamicsMarket, start: string, asOf: string): SmaLabRawRow[] {
  return sessionsBetween(smaLabCalendar(market), start, asOf).map((date, i) => {
    const close = Math.round((1000 + i * 0.4 + 60 * Math.sin(i / 11) + ((i * 7919) % 13)) * 100) / 100
    return { date, open: close - 0.5, high: close + 2, low: close - 3, close, volume: 1000 + (i % 17) }
  })
}

interface Scenario {
  id: string
  market: SmaDynamicsMarket
  asOf: string
  rows: SmaLabRawRow[]
  labFor: (timeframe: SmaLabTimeframeId) => SmaLabResult
  lab1D: SmaLabAvailable
}

function scenario(id: string, market: SmaDynamicsMarket, asOf: string): Scenario {
  const rows = history(market, '1996-01-04', asOf)
  const cache = new Map<string, SmaLabResult>()
  const labFor = (timeframe: SmaLabTimeframeId): SmaLabResult => {
    const cached = cache.get(timeframe)
    if (cached) return cached
    const computed = computeSmaLab({ rows, market, timeframe, horizon: 1, analysisDate: asOf })
    cache.set(timeframe, computed)
    return computed
  }
  const lab1D = labFor('1D')
  assert.equal(lab1D.status, 'available')
  assert.equal(lab1D.status === 'available' && lab1D.asOf.date, asOf, `${id}: as-of date`)
  return { id, market, asOf, rows, labFor, lab1D: lab1D as SmaLabAvailable }
}

const JP_YEAR_END = scenario('jp-year-end', 'JP', '2026-12-25')
const US_YEAR_END = scenario('us-year-end', 'US', '2026-12-28')
const JP_MID = scenario('jp-mid', 'JP', '2026-10-14')
const US_THANKSGIVING = scenario('us-thanksgiving', 'US', '2026-11-24')
const ALL = [JP_YEAR_END, US_YEAR_END, JP_MID, US_THANKSGIVING]

function project(s: Scenario, draft: DailyScenarioDraft): DailyScenarioProjection {
  const projection = projectDailyScenario({ market: s.market, asOf: s.lab1D.asOf, draft, labFor: s.labFor })
  assert.ok(projection, `${s.id}: projection`)
  return projection
}

function available(projection: DailyScenarioProjection, id: SmaLabTimeframeId) {
  const item = projection.timeframes.find((entry) => entry.timeframe === id)
  assert.ok(item && item.status === 'available', `${id} available`)
  return item as Extract<DailyTimeframeProjection, { status: 'available' }>
}

const anchor = (s: Scenario) => s.lab1D.asOf.close
const evenMinus10 = (s: Scenario) => dailyPresetTarget(anchor(s), emptyDailyScenario(3), -10, 'even')

// ---------------------------------------------------------------------------
// Draft helpers and presets

{
  assert.equal(DAILY_SCENARIO_DEFAULT_SESSIONS, 3)
  const a = 1000
  const targetCloses = (distribution: 'even' | 'first' | 'final') => dailyTargetCloses(a, 3, -10, distribution)
  assert.deepEqual(targetCloses('first'), [900, 900, 900], 'all on the first session, then held')
  assert.deepEqual(targetCloses('final'), [1000, 1000, 900], 'flat until the final session')
  const even = targetCloses('even')
  assert.ok(Math.abs(even[0] - 966.6666666667) < 1e-6 && Math.abs(even[1] - 933.3333333333) < 1e-6 && even[2] === 900, 'even: -3.33% per session, ends exactly on target')
  // All three end at the same level after T+3.
  for (const d of ['even', 'first', 'final'] as const) assert.equal(targetCloses(d)[2], 900)

  const draft = dailyPresetTarget(a, emptyDailyScenario(3), -10, 'even')
  assert.deepEqual(draft.inputs, ['-3.333333', '-6.666667', '-10'])
  const sessions = ['2026-12-28', '2026-12-29', '2026-12-30']
  const evaluation = evaluateDailyScenario(a, sessions, draft)
  assert.equal(evaluation.state, 'complete')
  assert.equal(evaluation.enteredThrough, 3)
  assert.equal(evaluation.cells[2].close, 900)
  assert.deepEqual(evaluation.cells.map((cell) => cell.date), sessions)

  // Existing flat / rise / fall / shock comparisons survive as daily presets.
  assert.deepEqual(evaluateDailyScenario(a, sessions, dailyPresetFlat(a, emptyDailyScenario(3))).closes, [1000, 1000, 1000])
  const rise = evaluateDailyScenario(a, sessions, dailyPresetRate(a, emptyDailyScenario(3), 0.5)).closes
  assert.ok(Math.abs(rise[2]! - 1000 * 1.005 ** 3) < 1e-4, 'preset text keeps 6 decimals of percent')
  const fall = evaluateDailyScenario(a, sessions, dailyPresetRate(a, emptyDailyScenario(3), -0.5)).closes
  assert.ok(fall[0]! < 1000 && fall[2]! < fall[1]!)
  const shock = evaluateDailyScenario(a, sessions, dailyPresetShock(a, emptyDailyScenario(3), 10, 2, 'hold')).closes
  assert.deepEqual(shock, [1000, 1100, 1100])
  const revert = evaluateDailyScenario(a, sessions, dailyPresetShock(a, emptyDailyScenario(3), 10, 1, 'revert')).closes
  assert.deepEqual(revert, [1100, 1050, 1000])

  // Editing: sessions can grow and shrink without losing typed entries; units convert without changing closes.
  let edited = setDailyInput(emptyDailyScenario(3), 2, '-1.5')
  edited = setDailySessions(edited, 5)
  assert.equal(edited.sessions, 5)
  assert.equal(edited.inputs.length, 5)
  assert.equal(setDailySessions(setDailyInput(edited, 5, '2'), 3).inputs[4], '2', 'shortening keeps entries beyond the scope')
  assert.equal(setDailySessions(edited, 999).sessions, 60)
  assert.equal(setDailySessions(edited, 0).sessions, 1)
  const asPrice = convertDailyUnit(a, dailyPresetTarget(a, emptyDailyScenario(3), -10, 'first'), 'price')
  assert.deepEqual(evaluateDailyScenario(a, sessions, asPrice).closes, [900, 900, 900])
  assert.deepEqual(clearDaily(a, asPrice).inputs, ['', '', ''])
  assert.equal(exactPriceText(1234.5), '1234.5')
  assert.equal(Number(exactPriceText(1e-7)), 1e-7)
  assert.doesNotMatch(exactPriceText(1e-7), /e/i)
}

// ---------------------------------------------------------------------------
// Calendars: the daily sessions are the next market sessions (holidays skipped, never invented)
{
  assert.deepEqual(dailyFutureSessions(smaLabCalendar('JP'), '2026-12-25', 3), ['2026-12-28', '2026-12-29', '2026-12-30'])
  assert.deepEqual(dailyFutureSessions(smaLabCalendar('JP'), '2026-12-30', 2), ['2027-01-04', '2027-01-05'], 'JP year end: 12-31 and 01-01..03 are closed')
  assert.deepEqual(dailyFutureSessions(smaLabCalendar('US'), '2026-12-28', 3), ['2026-12-29', '2026-12-30', '2026-12-31'])
  assert.deepEqual(dailyFutureSessions(smaLabCalendar('US'), '2026-11-24', 3), ['2026-11-25', '2026-11-27', '2026-11-30'], 'Thanksgiving closed, half-day Friday is a session')
  assert.deepEqual(dailyFutureSessions(smaLabCalendar('JP'), '2026-10-14', 3), ['2026-10-15', '2026-10-16', '2026-10-19'])
  assert.deepEqual(dailyFutureSessions(smaLabCalendar('US'), '2026-12-31', 1), ['2027-01-04'], 'US 2027-01-01 closed, weekend skipped')
  // Fail closed at the calendar edge: no projection rather than a made-up session.
  assert.throws(() => dailyFutureSessions(smaLabCalendar('JP'), '2099-12-30', 3), RangeError)
  const edge = projectDailyScenario({ market: 'JP', asOf: { date: '2099-12-30', close: 1 }, draft: emptyDailyScenario(3), labFor: () => ({ status: 'unavailable' } as SmaLabResult) })
  assert.equal(edge, null)
}

// ---------------------------------------------------------------------------
// One 3-session scenario across all 15 timeframes: exact phases at known boundaries

{
  const projection = project(JP_YEAR_END, evenMinus10(JP_YEAR_END))
  assert.deepEqual(projection.timeframes.map((item) => item.timeframe), SMA_LAB_TIMEFRAMES.map((item) => item.id), 'all 15 timeframes, catalogue order')
  assert.equal(projection.timeframes.length, 15)
  assert.deepEqual(projection.sessions, ['2026-12-28', '2026-12-29', '2026-12-30'], 'JP last three sessions of 2026')
  // Bars confirmed by the three year-end sessions.
  const expectedConfirmed: Record<string, number> = {
    '1D': 3, '2D': 2, '3D': 2, '5D': 2,
    '1W': 1, '2W': 1, '3W': 1,
    '1M': 1, '2M': 1, '3M': 1, '6M': 1,
    // Multi-year blocks are counted from 1970: 3Y = 2024-2026 ends here, 2Y = 2026-2027 and 5Y = 2025-2029 do not.
    '1Y': 1, '2Y': 0, '3Y': 1, '5Y': 0,
  }
  for (const item of projection.timeframes) {
    const tf = available(projection, item.timeframe)
    assert.equal(tf.confirmedBars, expectedConfirmed[item.timeframe], `JP year end ${item.timeframe}: confirmed bars`)
    for (const bar of tf.bars) {
      if (bar.phase === 'confirmed') {
        assert.equal(bar.enteredSessions, bar.requiredSessions, `${item.timeframe}: confirmed = every required session entered`)
        assert.ok(bar.close != null && bar.provisionalClose == null)
      }
    }
  }
  // The 5Y block 2025-2029 is only provisional: it has a provisional close but no confirmed one.
  const five = available(projection, '5Y')
  assert.equal(five.bars[0].phase, 'provisional')
  assert.equal(five.bars[0].close, null, 'never a confirmed close')
  assert.equal(five.bars[0].provisionalClose, projection.evaluation.cells[2].close)
  assert.equal(five.bars[0].enteredSessions, 3)
  assert.ok(five.bars[0].requiredSessions > 3)
  assert.match(describeDailyBar(five.bars[0]), /暫定/)
  assert.equal(five.sma[3][0], null, 'a provisional bar has no confirmed SMA')
  assert.ok(five.provisionalSma[3][0] != null, 'but shows a provisional SMA from the entered sessions')
  // 2D/3D/5D year-end bars: the first completes the forming bar, the second is the short last bar of the year.
  for (const id of ['2D', '3D', '5D'] as const) {
    const tf = available(projection, id)
    assert.equal(tf.bars[0].completesForming, true, `${id}: first projected bar completes the forming bar`)
    assert.deepEqual(tf.bars.map((bar) => bar.lastSession), id === '2D' ? ['2026-12-28', '2026-12-30'] : ['2026-12-28', '2026-12-30'])
    assert.ok(tf.bars[1].requiredSessions <= 2)
  }
  // 1D: three bars, closes are the three daily entries.
  const daily = available(projection, '1D')
  assert.deepEqual(daily.bars.map((bar) => bar.close), projection.evaluation.closes)
}

{
  const projection = project(US_YEAR_END, evenMinus10(US_YEAR_END))
  assert.deepEqual(projection.sessions, ['2026-12-29', '2026-12-30', '2026-12-31'])
  for (const id of ['1D', '1W', '2W', '3W', '1M', '2M', '3M', '6M', '1Y', '3Y'] as const) {
    assert.ok(available(projection, id).confirmedBars >= 1, `US year end ${id} confirmed`)
  }
  assert.equal(available(projection, '1D').confirmedBars, 3)
  assert.equal(available(projection, '1W').bars[0].completesForming, true)
  assert.equal(available(projection, '5Y').confirmedBars, 0)
  assert.equal(available(projection, '5Y').provisionalIndex, 0)
}

{
  // Mid-period: JP Sports Day week. T+1/T+2 finish the week, T+3 only starts the next one.
  const projection = project(JP_MID, evenMinus10(JP_MID))
  assert.deepEqual(projection.sessions, ['2026-10-15', '2026-10-16', '2026-10-19'])
  const week = available(projection, '1W')
  assert.deepEqual(week.bars.map((bar) => bar.phase), ['confirmed', 'provisional'])
  assert.equal(week.bars[0].lastSession, '2026-10-16')
  assert.equal(week.bars[0].close, projection.evaluation.cells[1].close, 'week close = close of its last session (T+2)')
  assert.deepEqual([week.bars[1].enteredSessions, week.bars[1].requiredSessions], [1, 5])
  assert.equal(week.bars[1].provisionalClose, projection.evaluation.cells[2].close)
  assert.equal(week.sma[5][1], null)
  // Hand-computed SMA(5) for the provisional week: last four confirmed closes (incl. T+2) + T+3.
  const confirmed = week.lab.bars.slice(0, week.lab.lastConfirmedIndex! + 1).map((bar) => bar.close!)
  const sma5Confirmed = (confirmed.slice(-4).reduce((sum, v) => sum + v, 0) + week.bars[0].close!) / 5
  assert.ok(Math.abs(week.sma[5][0]! - sma5Confirmed) < 1e-9)
  const sma5Prov = (confirmed.slice(-3).reduce((sum, v) => sum + v, 0) + week.bars[0].close! + week.bars[1].provisionalClose!) / 5
  assert.ok(Math.abs(week.provisionalSma[5][1]! - sma5Prov) < 1e-9)
  for (const id of ['1M', '3M', '6M', '1Y', '2Y', '3Y', '5Y'] as const) {
    const tf = available(projection, id)
    assert.equal(tf.confirmedBars, 0, `${id}: nothing confirmed mid-period`)
    assert.equal(tf.bars[0].phase, 'provisional')
    assert.equal(tf.bars[0].completesForming, true)
  }
  assert.equal(available(projection, '1D').confirmedBars, 3)
}

{
  // US Thanksgiving week and month end.
  const projection = project(US_THANKSGIVING, evenMinus10(US_THANKSGIVING))
  assert.deepEqual(projection.sessions, ['2026-11-25', '2026-11-27', '2026-11-30'])
  const week = available(projection, '1W')
  assert.deepEqual(week.bars.map((bar) => bar.phase), ['confirmed', 'provisional'])
  assert.equal(week.bars[0].lastSession, '2026-11-27', 'half-day Friday closes the week')
  assert.equal(week.bars[0].requiredSessions, 2)
  const month = available(projection, '1M')
  assert.deepEqual(month.bars.map((bar) => bar.phase), ['confirmed'])
  assert.equal(month.bars[0].lastSession, '2026-11-30')
  assert.equal(available(projection, '2M').confirmedBars, 0, 'Nov-Dec bar is still open')
  assert.equal(available(projection, '2M').bars[0].phase, 'provisional')
}

// ---------------------------------------------------------------------------
// Chart parity: identical history + the same entered sessions → identical bars and SMA values

const CHART_PERIODS = [3, 5, 10, 25]

function chartSpecFor(item: (typeof SMA_LAB_TIMEFRAMES)[number]): TimeframeSpec {
  if (item.chartCode == null) return { timeframe: 'day', multiplier: item.spec.count }
  const option = CHART_INTERVAL_OPTIONS.find((candidate) => candidate.code === item.chartCode)
  assert.ok(option, `${item.id}: chart interval exists`)
  return intervalToSpec(option.code)
}

function assertChartParity(s: Scenario, projection: DailyScenarioProjection, label: string) {
  const calendar = smaLabCalendar(s.market)
  const entered = projection.evaluation.enteredThrough
  const rows: OHLCV[] = [
    ...s.rows.map((row) => ({ date: row.date as string, open: row.open as number, high: row.high as number, low: row.low as number, close: row.close as number, volume: row.volume as number })),
    ...projection.sessions.slice(0, entered).map((date, i) => {
      const close = projection.evaluation.closes[i]!
      return { date, open: close, high: close, low: close, close, volume: 0 }
    }),
  ]
  const tradingDates = sessionsBetween(calendar, '1996-01-01', `${Number(s.asOf.slice(0, 4)) + 1}-12-31`)
  const context = createTimeframeBucketContext(tradingDates)
  for (const item of SMA_LAB_TIMEFRAMES) {
    const tf = available(projection, item.id)
    const spec = chartSpecFor(item)
    const bars = item.chartCode == null
      ? resampleOhlcv(rows, spec, context)
      : resampleOhlcvWithTradingSessions(rows, spec, tradingDates)
    const isComplete = (bar: OHLCV) => {
      const next = tradingDates.find((date) => date > bar.date)!
      return getTimeframeBucketKey(next, spec, context) !== getTimeframeBucketKey(bar.date, spec, context)
    }
    const last = bars.at(-1)!
    const completeBars = isComplete(last) ? bars : bars.slice(0, -1)
    const partial = isComplete(last) ? null : last
    const historyCount = tf.lab.lastConfirmedIndex! + 1
    const where = `${label} ${s.market} ${item.id}`
    // Bars (closes, in order) that the chart considers complete = the lab's history + its confirmed projection.
    const labCloses = [...tf.lab.bars.slice(0, historyCount).map((bar) => bar.close), ...tf.bars.filter((bar) => bar.phase === 'confirmed').map((bar) => bar.close)]
    assert.deepEqual(labCloses, completeBars.map((bar) => bar.close), `${where}: confirmed bars = chart's complete bars`)
    // The chart's trailing partial bar is the lab's provisional bar (same close), or there is none.
    // (A history-only forming bar with no entered session is the lab's existing forming bar, not a projected one.)
    if (partial && partial.date > s.asOf) {
      assert.notEqual(tf.provisionalIndex, null, `${where}: chart has a forming bar → lab has a provisional bar`)
      assert.equal(tf.bars[tf.provisionalIndex!].provisionalClose, partial.close, `${where}: provisional close`)
    } else {
      assert.equal(tf.provisionalIndex, null, `${where}: no provisional bar when the chart has none`)
    }
    // SMA values: same windows, same arithmetic.
    for (const period of CHART_PERIODS) {
      const summary = tf.lab.periods.find((entry) => entry.period === period)!
      let j = 0
      for (const [index, bar] of tf.bars.entries()) {
        if (bar.phase === 'confirmed') {
          const expected = summary.anchorValue == null ? null : smaAt(completeBars, period, historyCount + j)
          assert.equal(tf.sma[period][index], expected, `${where} SMA${period} at confirmed T+${bar.k}`)
          j += 1
        } else {
          assert.equal(tf.sma[period][index], null, `${where} SMA${period}: unconfirmed bar has no confirmed SMA`)
        }
      }
      if (partial && partial.date > s.asOf && tf.provisionalIndex != null) {
        const expected = summary.anchorValue == null ? null : smaAt([...completeBars, partial], period, completeBars.length)
        assert.equal(tf.provisionalSma[period][tf.provisionalIndex], expected, `${where} SMA${period} provisional`)
      }
    }
  }
}

for (const s of ALL) {
  const a = anchor(s)
  const paths: Array<[string, DailyScenarioDraft]> = [
    ['even -10%', dailyPresetTarget(a, emptyDailyScenario(3), -10, 'even')],
    ['first -10%', dailyPresetTarget(a, emptyDailyScenario(3), -10, 'first')],
    ['final -10%', dailyPresetTarget(a, emptyDailyScenario(3), -10, 'final')],
    ['flat', dailyPresetFlat(a, emptyDailyScenario(3))],
    ['rise', dailyPresetRate(a, emptyDailyScenario(3), 0.5)],
    ['fall', dailyPresetRate(a, emptyDailyScenario(3), -0.5)],
    ['shock +10% @T+2', dailyPresetShock(a, emptyDailyScenario(3), 10, 2, 'hold')],
    ['6 sessions even +6%', dailyPresetTarget(a, emptyDailyScenario(6), 6, 'even')],
    ['1 session', dailyPresetTarget(a, emptyDailyScenario(1), -3, 'first')],
    ['gap: T+1, T+3', setDailyInput(setDailyInput(emptyDailyScenario(3), 1, '-1'), 3, '-3')],
    ['empty', emptyDailyScenario(3)],
  ]
  for (const [name, draft] of paths) assertChartParity(s, project(s, draft), `${s.id} ${name}`)
}

// ---------------------------------------------------------------------------
// Multiple paths: same endpoint, different SMA history

{
  const s = JP_MID
  const a = anchor(s)
  const results = (['even', 'first', 'final'] as const).map((distribution) => available(project(s, dailyPresetTarget(a, emptyDailyScenario(3), -10, distribution)), '1D'))
  const [even, first, final] = results
  const minus10 = cleanFloat(a * 0.9)
  for (const result of results) assert.equal(result.bars[2].close, minus10, 'every path ends on -10% at T+3')
  assert.notDeepEqual(even.bars.map((bar) => bar.close), first.bars.map((bar) => bar.close))
  assert.notDeepEqual(first.bars.map((bar) => bar.close), final.bars.map((bar) => bar.close))
  // SMA(5) after three sessions is the same (same three closes sum differs): first-day shock sinks it the most.
  assert.ok(first.sma[5][2]! < even.sma[5][2]! && even.sma[5][2]! < final.sma[5][2]!, 'earlier drop → lower SMA at T+3')
  // The week bar confirmed at T+2 depends on the path; the daily T+1 close differs by path.
  const weekFirst = available(project(s, dailyPresetTarget(a, emptyDailyScenario(3), -10, 'first')), '1W')
  const weekFinal = available(project(s, dailyPresetTarget(a, emptyDailyScenario(3), -10, 'final')), '1W')
  assert.equal(weekFirst.bars[0].close, minus10)
  assert.equal(weekFinal.bars[0].close, a, 'T+2 is still flat on the final-day path')
  assert.equal(weekFirst.bars[1].provisionalClose, weekFinal.bars[1].provisionalClose, 'T+3 = -10% on both')
}

// ---------------------------------------------------------------------------
// No inference: gaps, invalid entries and partial entry never confirm a bar

{
  const s = JP_MID
  const gap = project(s, setDailyInput(setDailyInput(emptyDailyScenario(3), 1, '-1'), 3, '-3'))
  assert.equal(gap.evaluation.enteredThrough, 1)
  assert.deepEqual(gap.evaluation.missingK, [2])
  const daily = available(gap, '1D')
  assert.deepEqual(daily.bars.map((bar) => bar.phase), ['confirmed', 'unentered', 'unentered'])
  assert.equal(daily.bars[2].close, null, 'T+3 was entered but a missing T+2 stops it from being used')
  assert.equal(daily.bars[2].isolatedSessions, 1)
  assert.match(describeDailyBar(daily.bars[2]), /途中の営業日が未入力/)
  assert.deepEqual(daily.sma[5].map((value) => value != null), [true, false, false])
  const week = available(gap, '1W')
  assert.deepEqual(week.bars.map((bar) => bar.phase), ['provisional', 'unentered'], 'week needs T+1 and T+2; only T+1 is entered')
  assert.equal(week.bars[0].close, null)
  assert.deepEqual([week.bars[0].enteredSessions, week.bars[0].requiredSessions], [1, 2])
  assert.equal(week.bars[1].isolatedSessions, 1)
  assert.equal(week.sma[5][0], null)
  assert.ok(week.provisionalSma[5][0] != null)

  const invalid = project(s, setDailyInput(setDailyInput(emptyDailyScenario(3), 1, '-1'), 2, 'abc'))
  assert.deepEqual(invalid.evaluation.invalidK, [2])
  assert.equal(available(invalid, '1D').confirmedBars, 1)
  const nonPositive = project(s, setDailyInput(emptyDailyScenario(3), 1, '-100'))
  assert.equal(nonPositive.evaluation.cells[0].status, 'non_positive')
  assert.equal(available(nonPositive, '1D').confirmedBars, 0)

  const empty = project(s, emptyDailyScenario(3))
  assert.equal(empty.evaluation.state, 'empty')
  for (const item of empty.timeframes) {
    const tf = available(empty, item.timeframe)
    assert.equal(tf.confirmedBars, 0)
    assert.ok(tf.bars.every((bar) => bar.phase === 'unentered' && bar.close == null && bar.provisionalClose == null))
    assert.ok(Object.values(tf.sma).every((series) => series.every((value) => value == null)))
  }

  // A 2-session scenario cannot confirm the JP year-end 3-session 3D bar's tail.
  const two = project(JP_YEAR_END, dailyPresetFlat(anchor(JP_YEAR_END), emptyDailyScenario(2)))
  assert.equal(available(two, '1M').confirmedBars, 0, 'Dec 30 not entered → December is not confirmed')
  assert.equal(available(two, '1M').bars[0].phase, 'provisional')
  assert.equal(available(two, '2D').confirmedBars, 1, 'only the bar completing the forming 12-25/12-28 pair')
  assert.equal(available(two, '2D').bars[1].phase, 'provisional')
}

// ---------------------------------------------------------------------------
// Switching timeframes preserves the one daily scenario

{
  const id = simulationIdentity('JP', '7203', JP_MID.asOf)
  const state = freshSimulationState(id)
  assert.equal(state.daily.sessions, 3)
  assert.deepEqual(state.daily.inputs, ['', '', ''])
  const draft = dailyPresetTarget(anchor(JP_MID), state.daily, -10, 'even')
  // The draft lives beside, not inside, the per-timeframe scenarios, so a timeframe change cannot touch it.
  const withDaily = { ...state, daily: draft, scenarios: { '1W|2026-10-14': { unit: 'pct' as const, inputs: ['1', '2'] } } }
  assert.deepEqual(scopeSimulationState(withDaily, id).daily, draft)
  assert.equal(scopeSimulationState(withDaily, simulationIdentity('JP', '6758', JP_MID.asOf)).daily.inputs.every((text) => text === ''), true, 'another security starts empty')
  assert.equal(scopeSimulationState(withDaily, simulationIdentity('JP', '7203', '2026-10-13')).daily.inputs.every((text) => text === ''), true, 'another analysis date starts empty')
  // One projection serves every selected timeframe with the same closes.
  const projection = project(JP_MID, draft)
  const closesSeen = new Set(projection.timeframes.map(() => JSON.stringify(projection.evaluation.closes)))
  assert.equal(closesSeen.size, 1)
  const again = project(JP_MID, draft)
  assert.deepEqual(
    again.timeframes.map((item) => (item.status === 'available' ? item.bars.map((bar) => [bar.phase, bar.close, bar.provisionalClose]) : null)),
    projection.timeframes.map((item) => (item.status === 'available' ? item.bars.map((bar) => [bar.phase, bar.close, bar.provisionalClose]) : null)),
    'deterministic',
  )
}

// ---------------------------------------------------------------------------
// Daily → selected timeframe adaptation: explicit provenance, then Forward / Inverse consistency

{
  for (const s of ALL) {
    const projection = project(s, evenMinus10(s))
    for (const item of SMA_LAB_TIMEFRAMES) {
      const tfp = available(projection, item.id)
      const horizon = Math.min(5, item.spec.unit === 'month' ? Math.floor(480 / item.spec.count) : 5)
      const lab = computeSmaLab({ rows: s.rows, market: s.market, timeframe: item.id, horizon, analysisDate: s.asOf })
      assert.equal(lab.status, 'available')
      if (lab.status !== 'available') continue
      const base = forwardBase(lab)
      const adaptation = adaptDailyScenarioToTimeframe(tfp, base.horizon)!
      const where = `${s.id} ${item.id}`
      // Same bars as the selected-timeframe projection.
      tfp.bars.slice(0, base.horizon).forEach((bar, index) => assert.equal(lab.projection.bars[index].key, bar.key, `${where}: bar ${index + 1} key`))
      assert.equal(adaptation.draft.unit, 'price')
      assert.equal(adaptation.confirmedK.length + adaptation.emptyK.length, base.horizon)
      const evaluation = evaluateScenario(base, adaptation.draft)
      evaluation.cells.forEach((cell) => {
        const bar = tfp.bars[cell.k - 1]
        if (bar?.phase === 'confirmed') assert.equal(cell.close, bar.close, `${where}: T+${cell.k} carries the confirmed close exactly`)
        else {
          assert.equal(cell.status, 'missing', `${where}: T+${cell.k} stays empty (never filled)`)
          assert.equal(cell.close, null)
        }
      })
      // Forward consistency: the selected-timeframe forward engine gives the daily projection's SMAs.
      for (const period of CHART_PERIODS) {
        evaluation.sma[period].forEach((value, index) => {
          const bar = tfp.bars[index]
          const expected = bar?.phase === 'confirmed' ? tfp.sma[period][index] : null
          assert.equal(value, expected, `${where} SMA${period} T+${index + 1}: selected-timeframe forward = daily projection`)
        })
      }
      assert.equal(adaptationApplied(adaptation, base, adaptation.draft), true)
      assert.equal(adaptation.complete, adaptation.confirmedK.length === base.horizon)
      const text = describeDailyAdaptation(adaptation, item.barNoun)
      assert.match(text, /日次シナリオから導出/)
      assert.match(text, new RegExp(`${adaptation.confirmedK.length}/${base.horizon}本`))
      if (adaptation.provisional.length > 0) assert.match(text, /暫定の足/)
    }
  }
  // Deterministic: the same daily entries always adapt to the same draft; a different path changes it.
  const a = adaptDailyScenarioToTimeframe(available(project(JP_YEAR_END, evenMinus10(JP_YEAR_END)), '2D'), 3)!
  const b = adaptDailyScenarioToTimeframe(available(project(JP_YEAR_END, evenMinus10(JP_YEAR_END)), '2D'), 3)!
  assert.deepEqual(a, b)
  assert.deepEqual(a.confirmedK, [1, 2])
  assert.deepEqual(a.emptyK, [3])
  assert.equal(a.complete, false)
  assert.equal(adaptDailyScenarioToTimeframe({ status: 'unavailable', timeframe: '2D', reason: 'lab_unavailable' }, 3), null)
  // "Applied" is false for a different draft and true only for equal closes.
  const lab = computeSmaLab({ rows: JP_YEAR_END.rows, market: 'JP', timeframe: '2D', horizon: 3, analysisDate: JP_YEAR_END.asOf }) as SmaLabAvailable
  const base = forwardBase(lab)
  assert.equal(adaptationApplied(a, base, { unit: 'price', inputs: ['', '', ''] }), false)
  assert.equal(adaptationApplied(a, base, { unit: 'price', inputs: [a.draft.inputs[0], a.draft.inputs[1], '5'] }), false)
  assert.equal(adaptationApplied(a, base, { unit: 'price', inputs: [a.draft.inputs[0], a.draft.inputs[1], ''] }), true)
  assert.equal(adaptationApplied(a, base, { unit: 'price', inputs: [a.draft.inputs[0], a.draft.inputs[1], 'abc'] }), false, 'invalid text is not an applied blank')
  assert.equal(adaptationApplied(a, base, { unit: 'price', inputs: [a.draft.inputs[0], a.draft.inputs[1], '0'] }), false, 'non-positive close is not an applied blank')
}

{
  // Inverse → daily: a solver path for the daily timeframe, entered as the shared daily scenario, is reproduced
  // exactly by the 1D projection, satisfies the goal, and drives the other timeframes consistently.
  const s = JP_MID
  const lab = computeSmaLab({ rows: s.rows, market: 'JP', timeframe: '1D', horizon: 3, analysisDate: s.asOf }) as SmaLabAvailable
  const base = forwardBase(lab)
  for (const direction of ['up', 'down'] as const) {
    for (const bar of [1, 2, 3]) {
      const goal = { kind: 'direction', period: 5, bar, direction } as const
      const analysis = analyzeSolverGoal(base, goal)
      assert.equal(analysis.status, 'feasible')
      const path = representativePath(base, analysis, 'hold', 0.01)
      assert.equal(path.status, 'found')
      const closes = path.closes!
      assert.equal(checkGoal(base, goal, closes).satisfied, true)
      const draft = { ...scenarioFromCloses(base, closes, 'price'), sessions: 3 }
      const projection = project(s, draft)
      const daily = available(projection, '1D')
      assert.deepEqual(daily.bars.map((entry) => entry.close), closes, 'daily scenario reproduces the solver path')
      const forward = projectAllSma(base, closes)
      for (const period of CHART_PERIODS) {
        assert.deepEqual(daily.sma[period], forward[period], `SMA${period}: daily projection = forward engine on the solver path`)
      }
      // Direction at the goal bar seen from the projected SMA series.
      const anchorSma = lab.periods.find((entry) => entry.period === 5)!.anchorValue!
      const series = [anchorSma, ...daily.sma[5].map((value) => value!)]
      const seen = series[bar] > series[bar - 1] ? 'up' : series[bar] < series[bar - 1] ? 'down' : 'flat'
      assert.equal(seen, direction, `solver goal ${direction}@T+${bar} visible in the daily projection`)
    }
  }
  // The same daily path seen from the weekly bars: confirmed weekly closes are the path's closes at the week-end sessions.
  const draft = { ...scenarioFromCloses(base, representativePath(base, analyzeSolverGoal(base, { kind: 'direction', period: 5, bar: 2, direction: 'up' }), 'hold', 0.01).closes!, 'price'), sessions: 3 }
  const projection = project(s, draft)
  const week = available(projection, '1W')
  assert.equal(week.bars[0].close, projection.evaluation.closes[1])
  const weekLab = computeSmaLab({ rows: s.rows, market: 'JP', timeframe: '1W', horizon: 2, analysisDate: s.asOf }) as SmaLabAvailable
  const weekBase = forwardBase(weekLab)
  const adapted = adaptDailyScenarioToTimeframe(week, 2)!
  const closes = evaluateScenario(weekBase, adapted.draft).closes
  const outgoing = weekBase.confirmedCloses.at(-5)!
  const expectedDirection = closes[0]! > outgoing ? 'up' : closes[0]! < outgoing ? 'down' : 'flat'
  const weekAnchorSma = weekLab.periods.find((entry) => entry.period === 5)!.anchorValue!
  const seenDirection = week.sma[5][0]! > weekAnchorSma ? 'up' : week.sma[5][0]! < weekAnchorSma ? 'down' : 'flat'
  const atOne = checkGoal(weekBase, { kind: 'direction', period: 5, bar: 1, direction: 'up' }, closes)
  assert.equal(atOne.directions[0], expectedDirection, 'weekly solver check = x_k versus the leaving close')
  assert.equal(atOne.directions[0], seenDirection, 'and agrees with the SMA the daily projection shows')
  assert.equal(atOne.complete, true)
  const atTwo = checkGoal(weekBase, { kind: 'direction', period: 5, bar: 2, direction: 'up' }, closes)
  assert.equal(atTwo.complete, false, 'T+2 week is only provisional → the goal check is incomplete, never guessed')
}

// ---------------------------------------------------------------------------
// UI: scenario mode shows the shared daily scenario and the all-timeframe comparison; other modes do not.
{
  const fixture = findSmaDynamicsFixture('jp-rising')!
  const view = (analysis: 'freeze' | 'scenario' | 'solver', timeframe: SmaLabTimeframeId) => renderToStaticMarkup(createElement(SmaDynamicsView, {
    security: { market: fixture.market, ticker: fixture.ticker, name: fixture.name },
    analysisDate: fixture.analysisDate,
    load: { status: 'ready', rows: fixture.rows },
    dataSource: { label: 'テスト', priceBasis: '合成データ' },
    initialSettings: { ...SMA_DYNAMICS_DEFAULT_SETTINGS, analysis, timeframe },
  }))
  const scenarioView = view('scenario', '1D')
  assert.match(scenarioView, /data-sma-daily-scenario/)
  assert.match(scenarioView, /data-sma-daily-sessions="3"/, 'three sessions by default')
  assert.equal((scenarioView.match(/data-sma-daily-target-preset="/g) ?? []).length, 3, 'even / first / final target presets')
  assert.equal((scenarioView.match(/<tr[^>]*data-timeframe="/g) ?? []).length, 15, 'one comparison row per timeframe')
  for (const item of SMA_LAB_TIMEFRAMES) assert.match(scenarioView, new RegExp(`data-timeframe="${item.id}"`))
  assert.match(scenarioView, /data-sma-daily-apply-button/)
  assert.match(scenarioView, /未入力の日は補完しません/)
  assert.match(scenarioView, /data-sma-scenario-editor/, 'the selected-timeframe editor stays available')
  // The shared scenario is the same for any selected timeframe: only the selected row and apply target change.
  const weekly = view('scenario', '1W')
  assert.match(weekly, /data-timeframe="1W"[^>]*data-selected/)
  assert.equal((weekly.match(/data-sma-daily-inputs/g) ?? []).length, 1)
  assert.match(weekly, /選択中の週足の入力欄に反映/)
  assert.doesNotMatch(view('freeze', '1D'), /data-sma-daily-scenario/)
  assert.doesNotMatch(view('solver', '1D'), /data-sma-daily-scenario/)
  // Nested cards are avoided: the daily panel uses dividers, not boxed sub-cards.
  const panelSource = readFileSync('components/stock/sma-dynamics/SmaDailyScenarioPanel.tsx', 'utf8')
  assert.doesNotMatch(panelSource, /rounded-\[var\(--radius-(md|lg)\)\][^"`]*border[^"`]*shadow|shadow-/, 'no card chrome inside the panel')
  assert.match(panelSource, /overflow-x-auto/, 'comparison table scrolls instead of overflowing at 390px')
}

console.log('test-sma-dynamics-daily-scenario: ok')
