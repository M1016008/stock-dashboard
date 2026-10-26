// SMA Dynamics Lab aggregation contract: market calendars, fixed bucket boundaries,
// OHLCV aggregation, confirmed vs forming bars, gaps and listing starts.
// Fixture/inline data only; no database, API or network.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { isJpMarketTradingDate } from '@/lib/server/jp-market-calendar'
import { CHART_INTERVAL_OPTIONS, createTimeframeBucketContext, getTimeframeBucketKey } from '@/lib/timeframes'
import { isUsMarketTradingDate } from '@/lib/server/us-data-freshness'
import {
  addCalendarDays,
  addCalendarMonths,
  aggregateSmaLabBars,
  bucketForDate,
  futureBuckets,
  nextBucket,
  normalizeSmaLabHistory,
  sessionsBetween,
  shiftSession,
  SMA_LAB_CALENDAR_OVERRIDES,
  SMA_LAB_TIMEFRAMES,
  smaLabCalendar,
  type SmaLabRawRow,
  type SmaLabTimeframeSpec,
} from '@/lib/sma-dynamics-timeframes'
import { computeSmaLab } from '@/lib/sma-dynamics-lab'
import { SMA_DYNAMICS_FIXTURES } from '@/lib/sma-dynamics-fixtures'

const JP = smaLabCalendar('JP')
const US = smaLabCalendar('US')
const weekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay()

// ---------------------------------------------------------------------------
// Independent era-boundary fixtures. These dates are not derived from the
// implementation and catch proleptic application of modern holiday rules.
{
  assert.equal(JP.isSession('1999-01-11'), true, 'Coming of Age Day was still Jan 15 in 1999')
  assert.equal(JP.isSession('1999-01-15'), false)
  assert.equal(JP.isSession('2000-01-10'), false, 'Happy Monday began in 2000')
  assert.equal(JP.isSession('2018-12-24'), false, 'Emperor birthday substitute holiday')
  assert.equal(JP.isSession('2019-12-23'), true, 'no Emperor birthday in 2019')
  assert.equal(US.isSession('1997-01-20'), true, 'NYSE MLK closure began in 1998')
  assert.equal(US.isSession('1998-01-19'), false)
  assert.equal(US.isSession('2021-12-31'), true, 'Saturday New Year is not observed on Friday by NYSE')
  assert.equal(US.isSession('2038-12-31'), true, 'Saturday New Year rule remains correct beyond a finite override list')
  assert.equal(JP.isSession('1989-01-04'), false, 'calendar fails closed before its attested range')
  assert.equal(JP.isSession('2100-01-04'), false, 'calendar fails closed after its attested range')
  assert.throws(() => sessionsBetween(JP, '1989-12-01', '1990-01-31'), RangeError)
  assert.throws(() => futureBuckets(JP, { unit: 'month', count: 1 }, '2099-12-30', 2), RangeError)
}

// ---------------------------------------------------------------------------
// Timeframe catalogue: the eight specified timeframes plus the chart's other intervals
// (3W, 2M, 6M, 1Y, 2Y, 3Y, 5Y) as generic unit × count.
assert.deepEqual(SMA_LAB_TIMEFRAMES.map((item) => [item.id, item.spec.unit, item.spec.count]), [
  ['1D', 'session', 1], ['2D', 'session', 2], ['3D', 'session', 3], ['5D', 'session', 5],
  ['1W', 'week', 1], ['2W', 'week', 2], ['3W', 'week', 3],
  ['1M', 'month', 1], ['2M', 'month', 2], ['3M', 'month', 3], ['6M', 'month', 6],
  ['1Y', 'month', 12], ['2Y', 'month', 24], ['3Y', 'month', 36], ['5Y', 'month', 60],
])
assert.deepEqual(SMA_LAB_TIMEFRAMES.filter((item) => item.core).map((item) => item.id), ['1D', '2D', '3D', '5D', '1W', '2W', '1M', '3M'])

// Boundary parity with the main chart (lib/timeframes). Every chart-linked timeframe, including
// 2D/3D/2W/3W (exchange-year session numbering, TradingView multi-week reset), holds exactly the
// sessions the chart's own bucket function puts in one bar. 5D is Lab-only and uses the same rule.
{
  const chartSpec = (code: string) => {
    const option = CHART_INTERVAL_OPTIONS.find((item) => item.code === code)
    assert.ok(option, `chart interval ${code} exists`)
    return option.spec
  }
  assert.deepEqual(SMA_LAB_TIMEFRAMES.filter((item) => item.chartAlignment === 'lab_only').map((item) => item.id), ['5D'])
  for (const calendar of [JP, US]) {
    const allSessions = sessionsBetween(calendar, '1994-01-01', '2035-12-31')
    const context = createTimeframeBucketContext(allSessions)
    for (const item of SMA_LAB_TIMEFRAMES) {
      const spec = item.chartAlignment === 'lab_only'
        ? ({ timeframe: 'day', multiplier: 5 } as const)
        : chartSpec(item.chartCode!)
      if (item.chartAlignment === 'lab_only') assert.equal(item.chartCode, null, `${item.id}: lab-only has no chart code`)
      else assert.ok(CHART_INTERVAL_OPTIONS.some((option) => option.code === item.chartCode), `${item.id}: chart code ${item.chartCode} is a real chart interval`)
      // Reference groups: sessions sharing a chart bucket key, straight from lib/timeframes.
      const groups = new Map<string, string[]>()
      for (const date of allSessions) {
        const key = getTimeframeBucketKey(date, spec, context)
        const list = groups.get(key) ?? []
        list.push(date)
        groups.set(key, list)
      }
      for (const sessions of groups.values()) {
        if (sessions[0] < '1996-01-01' || sessions.at(-1)! > '2033-12-31') continue
        // Long month/year bars: probe both ends; session and week bars: every session.
        const probes = item.spec.unit === 'month' ? [sessions[0], sessions.at(-1)!] : sessions
        for (const date of probes) {
          const bucket = bucketForDate(calendar, item.spec, date)
          assert.deepEqual(bucket.sessions, sessions, `${calendar.market} ${item.id} @${date}: same sessions as the chart bar`)
        }
      }
    }
  }
}

// Concrete chart-boundary facts (independent of the implementation).
{
  const bucket = (calendar: typeof JP, spec: SmaLabTimeframeSpec, date: string) => bucketForDate(calendar, spec, date)
  const D = (count: number): SmaLabTimeframeSpec => ({ unit: 'session', count })
  const W = (count: number): SmaLabTimeframeSpec => ({ unit: 'week', count })
  // 2D/3D restart every exchange year: JP 2026 opens 01-05 (01-01..03 closed); the year's first 2D bar is 01-05 + 01-06.
  assert.deepEqual(bucket(JP, D(2), '2026-01-06').sessions, ['2026-01-05', '2026-01-06'])
  assert.deepEqual(bucket(US, D(2), '2026-01-05').sessions, ['2026-01-02', '2026-01-05'], 'US 2026 opens 01-02')
  assert.deepEqual(bucket(JP, D(3), '2026-01-06').sessions, ['2026-01-05', '2026-01-06', '2026-01-07'])
  assert.deepEqual(bucket(JP, D(3), '2026-01-09').sessions, ['2026-01-08', '2026-01-09', '2026-01-13'], 'Coming of Age Day 01-12 is not a session')
  // No bar spans New Year; the last bar of a year may be short.
  const jpYearEnd = bucket(JP, D(3), '2026-12-30')
  assert.ok(jpYearEnd.sessions.length <= 3 && jpYearEnd.sessions.every((date) => date.startsWith('2026')))
  assert.equal(bucket(JP, D(3), '2027-01-04').sessions[0], '2027-01-04', 'first 2027 session starts a new 3D bar')
  // 5D: same rule with n = 5, first bar of 2026 = first five sessions of the year.
  assert.deepEqual(bucket(JP, D(5), '2026-01-05').sessions, ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09'])
  // TradingView multi-week reset: 2W/3W bars restart at each year's first trading week.
  const span = (calendar: typeof JP, spec: SmaLabTimeframeSpec, date: string) => [bucket(calendar, spec, date).periodStart, bucket(calendar, spec, date).periodEnd]
  // 2026: Jan 4 is a Sunday, so the first trading week starts Monday 01-05.
  assert.deepEqual(span(JP, W(2), '2026-01-05'), ['2026-01-05', '2026-01-18'])
  assert.deepEqual(span(JP, W(2), '2026-01-19'), ['2026-01-19', '2026-02-01'])
  // 2025 (Jan 4 = Saturday, first week Mon 01-06): the last 2025 2W bar is 12-22..01-04 and keeps the US 01-02 session;
  // the JP year-end 12-30 is followed by 2026-01-05, a new bar.
  assert.deepEqual(span(US, W(2), '2026-01-02'), ['2025-12-22', '2026-01-04'])
  assert.ok(bucket(US, W(2), '2026-01-02').sessions.includes('2025-12-31') && bucket(US, W(2), '2026-01-02').sessions.includes('2026-01-02'))
  assert.deepEqual(bucket(JP, W(2), '2025-12-30').sessions.slice(-2), ['2025-12-29', '2025-12-30'])
  assert.notEqual(bucket(JP, W(2), '2025-12-30').key, bucket(JP, W(2), '2026-01-05').key)
  // 2024 (first week Mon 01-01): the week of 12-30 is index 52, so the year's last 3W bar holds only two weeks (12-23..01-05).
  assert.deepEqual(span(US, W(3), '2025-01-02'), ['2024-12-23', '2025-01-05'])
  assert.deepEqual(span(US, W(3), '2025-01-06'), ['2025-01-06', '2025-01-26'])
}

// Extended month-based bars: calendar halves, years and multi-year blocks counted from 1970.
{
  const bucket = (id: string, date: string) => bucketForDate(JP, SMA_LAB_TIMEFRAMES.find((item) => item.id === id)!.spec, date)
  assert.deepEqual([bucket('2M', '2025-02-20').periodStart, bucket('2M', '2025-02-20').periodEnd], ['2025-01-01', '2025-02-28'])
  assert.deepEqual([bucket('6M', '2025-06-30').periodStart, bucket('6M', '2025-06-30').periodEnd], ['2025-01-01', '2025-06-30'])
  assert.deepEqual([bucket('6M', '2025-07-01').periodStart, bucket('6M', '2025-07-01').periodEnd], ['2025-07-01', '2025-12-31'])
  assert.deepEqual([bucket('1Y', '2024-12-30').periodStart, bucket('1Y', '2024-12-30').periodEnd], ['2024-01-01', '2024-12-31'])
  assert.deepEqual([bucket('2Y', '2025-03-03').periodStart, bucket('2Y', '2025-03-03').periodEnd], ['2024-01-01', '2025-12-31'])
  assert.deepEqual([bucket('3Y', '2025-03-03').periodStart, bucket('3Y', '2025-03-03').periodEnd], ['2024-01-01', '2026-12-31'])
  assert.deepEqual([bucket('5Y', '2025-03-03').periodStart, bucket('5Y', '2025-03-03').periodEnd], ['2025-01-01', '2029-12-31'])
  assert.deepEqual([bucket('5Y', '2024-12-30').periodStart, bucket('5Y', '2024-12-30').periodEnd], ['2020-01-01', '2024-12-31'])
  assert.deepEqual([bucket('3W', '2025-01-15').periodStart, bucket('3W', '2025-01-15').periodEnd].map((d) => weekday(d)), [1, 0], '3W runs Monday to Sunday')
  // A year bar holds only market sessions, never the calendar year's weekends or holidays.
  assert.ok(bucket('1Y', '2024-06-03').sessions.every((date) => JP.isSession(date)))
  assert.ok(bucket('1Y', '2024-06-03').sessions.length > 230 && bucket('1Y', '2024-06-03').sessions.length < 250)
  // Future bars: the open year bar completes first, then whole following years.
  const years = futureBuckets(JP, SMA_LAB_TIMEFRAMES.find((item) => item.id === '1Y')!.spec, '2025-06-02', 3)
  assert.deepEqual(years.map((item) => [item.periodStart, item.periodEnd]), [['2025-01-01', '2025-12-31'], ['2026-01-01', '2026-12-31'], ['2027-01-01', '2027-12-31']])
  const quinquennial = futureBuckets(US, SMA_LAB_TIMEFRAMES.find((item) => item.id === '5Y')!.spec, '2025-06-02', 3)
  assert.deepEqual(quinquennial.map((item) => item.periodStart), ['2025-01-01', '2030-01-01', '2035-01-01'])
  assert.throws(() => bucketForDate(JP, { unit: 'month', count: 61 }, '2025-01-05'), RangeError)
}

// Confirmed vs forming on long bars, the PIT boundary and the year-end session of each market.
{
  const longJp = SMA_DYNAMICS_FIXTURES.find((item) => item.id === 'jp-long-history')!
  const compute = (market: 'JP' | 'US', rows: typeof longJp.rows, timeframe: '1Y' | '2Y' | '6M' | '5Y', analysisDate: string | null) =>
    computeSmaLab({ rows, market, timeframe, horizon: 3, analysisDate })
  // Mid-year: the open year is a forming bar whose projection first completes it.
  const mid = compute('JP', longJp.rows, '1Y', '2025-06-30')
  assert.equal(mid.status, 'available')
  if (mid.status === 'available') {
    assert.equal(mid.bars.at(-1)!.phase, 'forming')
    assert.equal(mid.formingIndex, mid.bars.length - 1)
    assert.equal(mid.bars.at(-1)!.periodStart, '2025-01-01')
    assert.equal(mid.projection.bars[0].completesForming, true)
    assert.equal(mid.lastConfirmedIndex, mid.bars.length - 2)
    assert.ok(mid.bars.at(-1)!.elapsedSessions < mid.bars.at(-1)!.expectedSessions)
    // Rows after the analysis date never enter any bar (point-in-time).
    assert.ok(mid.bars.every((bar) => bar.lastSession <= '2025-12-31' && bar.firstSession <= '2025-06-30'))
    assert.ok(mid.excludedAfterBoundary > 0)
  }
  // TSE's last 2025 session is 12-30: on that day the year bar is already confirmed; one session earlier it is not.
  const lastJp = compute('JP', longJp.rows, '1Y', '2025-12-30')
  const beforeLastJp = compute('JP', longJp.rows, '1Y', '2025-12-29')
  assert.equal(JP.isSession('2025-12-31'), false)
  assert.ok(lastJp.status === 'available' && beforeLastJp.status === 'available')
  if (lastJp.status === 'available' && beforeLastJp.status === 'available') {
    assert.equal(lastJp.bars.at(-1)!.phase, 'confirmed')
    assert.equal(lastJp.formingIndex, null)
    assert.equal(lastJp.projection.bars[0].periodStart, '2026-01-01', 'a confirmed year projects the next year')
    assert.equal(lastJp.projection.bars[0].completesForming, false)
    assert.equal(beforeLastJp.bars.at(-1)!.phase, 'forming')
    assert.equal(beforeLastJp.projection.bars[0].periodEnd, '2025-12-31')
  }
  // Multi-year and half-year bars confirm at their own last session.
  const twoYear = compute('JP', longJp.rows, '2Y', '2025-12-30')
  assert.ok(twoYear.status === 'available' && twoYear.bars.at(-1)!.phase === 'confirmed' && twoYear.bars.at(-1)!.periodStart === '2024-01-01')
  const half = compute('JP', longJp.rows, '6M', '2025-06-30')
  assert.ok(half.status === 'available' && half.bars.at(-1)!.phase === 'confirmed' && half.bars.at(-1)!.periodEnd === '2025-06-30')
  // 5Y: 2025-2029 is the open block in 2026.
  const five = compute('JP', longJp.rows, '5Y', null)
  assert.ok(five.status === 'available' && five.bars.at(-1)!.periodStart === '2025-01-01' && five.bars.at(-1)!.phase === 'forming')
  if (five.status === 'available') assert.equal(five.projection.bars[1].periodStart, '2030-01-01')
  // Horizons beyond what the calendar supports are rejected, not silently clipped.
  assert.throws(() => compute('JP', longJp.rows, '5Y', null).status === 'available' && computeSmaLab({ rows: longJp.rows, market: 'JP', timeframe: '5Y', horizon: 20 }), RangeError)
}

// ---------------------------------------------------------------------------
// Lab calendar overrides only add documented full-day exceptions.
for (const market of ['JP', 'US'] as const) {
  const shared = market === 'US' ? isUsMarketTradingDate : isJpMarketTradingDate
  const lab = smaLabCalendar(market)
  for (const date of SMA_LAB_CALENDAR_OVERRIDES[market].closed) {
    assert.ok(shared(date), `${market} ${date}: override must differ from the shared calendar`)
    assert.ok(!lab.isSession(date), `${market} ${date} closed in the lab`)
  }
  for (const date of SMA_LAB_CALENDAR_OVERRIDES[market].open) {
    assert.equal(weekday(date), 5, `${date} is a Friday`)
    assert.equal(date.slice(5), '12-31')
    assert.ok(!shared(date) && lab.isSession(date), `${market} ${date} open in the lab`)
  }
}
for (let date = '2026-01-01'; date <= '2027-11-30'; date = addCalendarDays(date, 1)) {
  assert.equal(JP.isSession(date), isJpMarketTradingDate(date), `JP lab = shared on ${date}`)
  assert.equal(US.isSession(date), isUsMarketTradingDate(date), `US lab = shared on ${date}`)
}

// ---------------------------------------------------------------------------
// Session shifting and the supported range.
{
  for (const [calendar, date] of [[JP, '2026-12-30'], [US, '2026-12-31'], [JP, '1999-12-30'], [US, '2019-04-29']] as const) {
    for (const delta of [-260, -7, -1, 1, 3, 400]) {
      const shifted = shiftSession(calendar, date, delta)
      assert.ok(calendar.isSession(shifted))
      assert.equal(sessionsBetween(calendar, delta > 0 ? date : shifted, delta > 0 ? shifted : date).length, Math.abs(delta) + 1)
    }
  }
  assert.deepEqual(sessionsBetween(JP, '2019-04-26', '2019-05-08'), ['2019-04-26', '2019-05-07', '2019-05-08'], 'JP 2019 accession holidays closed')
  assert.throws(() => bucketForDate(JP, { unit: 'session', count: 2 }, '2026-10-17'), RangeError, 'weekend is not a session')
}

// ---------------------------------------------------------------------------
// Multi-session boundaries follow the chart: exchange-year numbering, nothing spans New Year.
for (const [calendar, n] of [[JP, 2], [JP, 3], [JP, 5], [US, 2], [US, 3], [US, 5]] as const) {
  const spec: SmaLabTimeframeSpec = { unit: 'session', count: n }
  for (const date of sessionsBetween(calendar, '2025-11-01', '2026-02-28')) {
    const bucket = bucketForDate(calendar, spec, date)
    assert.ok(bucket.sessions.length >= 1 && bucket.sessions.length <= n)
    assert.ok(bucket.sessions.includes(date))
    assert.ok(bucket.sessions.every((session) => session.slice(0, 4) === date.slice(0, 4)), 'a multi-session bar stays inside its exchange year')
    const yearSessionsList = sessionsBetween(calendar, `${date.slice(0, 4)}-01-01`, `${date.slice(0, 4)}-12-31`)
    assert.equal(yearSessionsList.indexOf(bucket.sessions[0]) % n, 0, 'bucket starts at a multiple of n inside the year')
  }
}
{
  // The year's first and last bars: new year always starts a new bar, the old year's last bar may be short.
  for (const n of [2, 3, 5]) {
    const lastJp = bucketForDate(JP, { unit: 'session', count: n }, '2026-12-30')
    assert.ok(!lastJp.sessions.some((date) => date.startsWith('2027')), `${n}D does not continue into the next year`)
    assert.equal(bucketForDate(JP, { unit: 'session', count: n }, '2027-01-04').sessions[0], '2027-01-04')
  }
  // JP 2026 has 242 sessions (261 weekdays - 19 holidays): 242 = 2*121 = 3*80 + 2 = 5*48 + 2.
  assert.equal(sessionsBetween(JP, '2026-01-01', '2026-12-31').length, 242)
  assert.equal(bucketForDate(JP, { unit: 'session', count: 2 }, '2026-12-30').sessions.length, 2)
  assert.equal(bucketForDate(JP, { unit: 'session', count: 3 }, '2026-12-30').sessions.length, 2, 'short last 3D bar of the year')
  assert.equal(bucketForDate(JP, { unit: 'session', count: 5 }, '2026-12-30').sessions.length, 2, 'short last 5D bar of the year')
}

// ---------------------------------------------------------------------------
// Calendar weeks / 2 weeks / months / quarters.
{
  const gw = bucketForDate(JP, { unit: 'week', count: 1 }, '2026-05-07')
  assert.equal(gw.periodStart, '2026-05-04')
  assert.equal(gw.periodEnd, '2026-05-10')
  assert.deepEqual(gw.sessions, ['2026-05-07', '2026-05-08'], 'JP Golden Week week has two sessions')

  const thanksgiving = bucketForDate(US, { unit: 'week', count: 1 }, '2026-11-25')
  assert.deepEqual(thanksgiving.sessions, ['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-27'], 'US Thanksgiving closed; half-day Friday is a session')

  for (const date of ['2026-01-05', '2026-06-17', '2026-12-28']) {
    const two = bucketForDate(JP, { unit: 'week', count: 2 }, date)
    assert.equal(weekday(two.periodStart), 1)
    assert.equal(weekday(two.periodEnd), 0)
    assert.ok(two.periodStart <= date && date <= two.periodEnd)
    // Aligned to the exchange year's first trading week (2026: Monday 01-05), not to a 1970 epoch.
    const weeksFromYearStart = (Date.parse(`${two.periodStart}T00:00:00Z`) - Date.parse('2026-01-05T00:00:00Z')) / (7 * 86_400_000)
    assert.equal(weeksFromYearStart % 2, 0, '2W buckets aligned to the year\'s first trading week')
  }
  assert.equal(nextBucket(JP, { unit: 'week', count: 2 }, bucketForDate(JP, { unit: 'week', count: 2 }, '2026-06-17')).periodStart, addCalendarDays(bucketForDate(JP, { unit: 'week', count: 2 }, '2026-06-17').periodStart, 14))

  const decJp = bucketForDate(JP, { unit: 'month', count: 1 }, '2026-12-15')
  assert.deepEqual([decJp.periodStart, decJp.periodEnd, decJp.sessions.at(-1)], ['2026-12-01', '2026-12-31', '2026-12-30'], 'JP December closes on 12-30')
  const novUs = bucketForDate(US, { unit: 'month', count: 1 }, '2026-11-02')
  assert.equal(novUs.sessions.at(-1), '2026-11-30')
  const may = bucketForDate(JP, { unit: 'month', count: 1 }, '2026-05-31')
  assert.equal(may.sessions.at(-1), '2026-05-29', 'month end on a weekend closes on the last session')

  const q4Jp = bucketForDate(JP, { unit: 'month', count: 3 }, '2026-10-16')
  assert.deepEqual([q4Jp.periodStart, q4Jp.periodEnd, q4Jp.sessions[0], q4Jp.sessions.at(-1)], ['2026-10-01', '2026-12-31', '2026-10-01', '2026-12-30'])
  const q4Us = bucketForDate(US, { unit: 'month', count: 3 }, '2026-10-16')
  assert.equal(q4Us.sessions.at(-1), '2026-12-31')
  for (const [date, start] of [['2026-01-01', '2026-01-01'], ['2026-03-31', '2026-01-01'], ['2026-04-01', '2026-04-01'], ['2026-09-30', '2026-07-01']] as const) {
    assert.equal(bucketForDate(JP, { unit: 'month', count: 3 }, date).periodStart, start, `quarter of ${date}`)
  }
  assert.equal(addCalendarMonths('2026-03-31', -1), '2026-02-28')
  assert.equal(addCalendarMonths('2024-05-31', -3), '2024-02-29')
}

// ---------------------------------------------------------------------------
// Future buckets: the open bucket first (when the as-of date is inside it), then calendar buckets.
{
  const friday = futureBuckets(JP, { unit: 'week', count: 1 }, '2026-10-16', 2)
  assert.deepEqual(friday.map((bucket) => bucket.sessions.at(-1)), ['2026-10-23', '2026-10-30'], 'confirmed week: next weeks only')
  const wednesday = futureBuckets(JP, { unit: 'week', count: 1 }, '2026-10-14', 2)
  assert.deepEqual(wednesday.map((bucket) => bucket.sessions.at(-1)), ['2026-10-16', '2026-10-23'], 'forming week completes first')
  const quarters = futureBuckets(JP, { unit: 'month', count: 3 }, '2026-10-16', 4)
  assert.deepEqual(quarters.map((bucket) => bucket.sessions.at(-1)), ['2026-12-30', '2027-03-31', '2027-06-30', '2027-09-30'])
  const twoDay = futureBuckets(US, { unit: 'session', count: 2 }, '2026-11-25', 5)
  for (const bucket of twoDay) assert.equal(bucket.sessions.length, 2)
  for (let i = 1; i < twoDay.length; i += 1) assert.equal(sessionsBetween(US, twoDay[i - 1].sessions[1], twoDay[i].sessions[0]).length, 2, 'consecutive US sessions')
  const daily = futureBuckets(JP, { unit: 'session', count: 1 }, '2026-04-28', 5)
  assert.deepEqual(daily.map((bucket) => bucket.sessions[0]), ['2026-04-30', '2026-05-01', '2026-05-07', '2026-05-08', '2026-05-11'])
}

// ---------------------------------------------------------------------------
// OHLCV aggregation.
function ohlcRows(dates: string[], start = 100): SmaLabRawRow[] {
  return dates.map((date, index) => {
    const close = start + index
    return { date, open: close - 0.5, high: close + 2 + (index % 3), low: close - 3 - (index % 2), close, volume: 1000 + index }
  })
}

function aggregate(rows: SmaLabRawRow[], spec: SmaLabTimeframeSpec, calendar = JP, boundary: string | null = null) {
  const history = normalizeSmaLabHistory(rows, calendar, boundary)
  const asOf = history.rows.at(-1)!.date
  return { history, bars: aggregateSmaLabBars({ history, calendar, spec, asOf }) }
}

{
  const dates = sessionsBetween(JP, '2026-09-01', '2026-10-16')
  const rows = ohlcRows(dates)
  for (const timeframe of SMA_LAB_TIMEFRAMES) {
    const { bars } = aggregate(rows, timeframe.spec)
    for (const bar of bars) {
      const bucket = bucketForDate(JP, timeframe.spec, bar.firstSession)
      assert.equal(bar.key, bucket.key)
      const inBar = rows.filter((row) => (row.date as string) >= bar.firstSession && (row.date as string) <= bar.lastSession && (row.date as string) <= '2026-10-16')
      if (bar.leadingPartial || bar.phase === 'forming') continue
      assert.equal(bar.open, inBar[0].open, `${timeframe.id} open = first session open`)
      assert.equal(bar.high, Math.max(...inBar.map((row) => row.high as number)), `${timeframe.id} high`)
      assert.equal(bar.low, Math.min(...inBar.map((row) => row.low as number)), `${timeframe.id} low`)
      assert.equal(bar.close, inBar.at(-1)!.close, `${timeframe.id} close = last session close`)
      assert.equal(bar.volume, inBar.reduce((sum, row) => sum + (row.volume as number), 0), `${timeframe.id} volume sum`)
      assert.ok(bar.closeExact && bar.ohlcComplete)
    }
  }

  // Data start never moves a 2D/3D/5D boundary.
  for (const n of [2, 3, 5]) {
    const spec: SmaLabTimeframeSpec = { unit: 'session', count: n }
    const reference = new Map(aggregate(rows, spec).bars.filter((bar) => !bar.leadingPartial && bar.phase === 'confirmed').map((bar) => [bar.key, JSON.stringify(bar)]))
    for (let offset = 1; offset <= 5; offset += 1) {
      for (const bar of aggregate(rows.slice(offset), spec).bars) {
        if (bar.leadingPartial || bar.phase !== 'confirmed' || !reference.has(bar.key)) continue
        const expected = JSON.parse(reference.get(bar.key)!)
        assert.deepEqual({ ...bar, index: 0 }, { ...expected, index: 0 }, `${n}D bucket ${bar.key} identical when history starts ${offset} sessions later`)
      }
    }
  }
}

// Confirmed vs forming, listing start, gaps, invalid and close-only rows.
{
  // Listed Wednesday 2026-09-09; as-of Wednesday 2026-10-14.
  const dates = sessionsBetween(JP, '2026-09-09', '2026-10-14').filter((date) => date !== '2026-09-30' && date !== '2026-10-02')
  const rows = ohlcRows(dates)
  const { bars } = aggregate(rows, { unit: 'week', count: 1 })
  const first = bars[0]
  assert.equal(first.firstSession, '2026-09-07', 'week boundary is the calendar week, not the listing date')
  assert.ok(first.leadingPartial && !first.ohlcComplete && first.closeExact, 'listing week: flagged, close exact')
  assert.equal(first.close, rows.find((row) => row.date === '2026-09-11')!.close)

  const midGap = bars.find((bar) => bar.firstSession === '2026-09-28')!
  assert.deepEqual(midGap.missingDates, ['2026-09-30', '2026-10-02'])
  assert.equal(midGap.closeExact, false, 'week-closing Friday missing: no close')
  assert.equal(midGap.close, null)
  assert.equal(midGap.open, null, 'no candle without the closing session')

  const forming = bars.at(-1)!
  assert.equal(forming.phase, 'forming')
  assert.equal(forming.firstSession, '2026-10-13')
  assert.equal(forming.lastSession, '2026-10-16')
  assert.equal(forming.elapsedSessions, 2)
  assert.equal(forming.expectedSessions, 4, 'Sports Day Monday excluded')
  assert.equal(forming.close, rows.at(-1)!.close, 'forming close = latest close (provisional)')
  assert.equal(forming.closeExact, false, 'forming bars never enter the confirmed SMA')

  const result = computeSmaLab({ rows, market: 'JP', timeframe: '1W', horizon: 3 })
  assert.equal(result.status, 'available')
  if (result.status === 'available') {
    assert.deepEqual(result.issues.filter((issue) => issue.kind === 'missing_session').map((issue) => issue.date), ['2026-09-30', '2026-10-02'])
    assert.equal(result.formingIndex, bars.length - 1)
    assert.equal(result.projection.bars[0].completesForming, true)
    assert.equal(result.projection.bars[0].lastSession, '2026-10-16')
    assert.equal(result.projection.bars[0].sessionsAhead, 2)
  }

  // Mid-week gap keeps an exact close but an incomplete candle.
  const gapMid = aggregate(ohlcRows(sessionsBetween(JP, '2026-09-07', '2026-09-18').filter((date) => date !== '2026-09-09')), { unit: 'week', count: 1 }).bars[0]
  assert.ok(gapMid.closeExact && !gapMid.ohlcComplete)
  assert.deepEqual(gapMid.missingDates, ['2026-09-09'])
  assert.equal(gapMid.volume, null, 'volume is not summed over a gap')
}
{
  const dates = sessionsBetween(JP, '2026-09-07', '2026-09-18')
  const rows: SmaLabRawRow[] = ohlcRows(dates)
  rows[2] = { ...rows[2], high: (rows[2].low as number) - 1 } // inconsistent OHLC
  rows[6] = { date: rows[6].date, close: rows[6].close } // close-only
  rows.push({ date: '2026-09-12', open: 1, high: 1, low: 1, close: 1, volume: 1 }) // Saturday
  rows.push({ date: '1900-01-04', open: 1, high: 1, low: 1, close: 1, volume: 1 })
  const history = normalizeSmaLabHistory(rows, JP, null)
  assert.deepEqual(history.issues.map((issue) => `${issue.kind}:${issue.date}`), [
    'unsupported_date:1900-01-04',
    'invalid_ohlc:2026-09-09',
    'off_calendar_date:2026-09-12',
    'ohlc_unavailable:2026-09-15',
  ])
  assert.ok(!history.byDate.has('2026-09-12'), 'off-calendar rows are excluded, not merged')
  const bars = aggregateSmaLabBars({ history, calendar: JP, spec: { unit: 'week', count: 1 }, asOf: '2026-09-18' })
  assert.ok(bars.every((bar) => bar.closeExact), 'closes stay usable')
  assert.ok(bars.every((bar) => !bar.ohlcComplete), 'both weeks flagged incomplete')
  const daily = aggregateSmaLabBars({ history, calendar: JP, spec: { unit: 'session', count: 1 }, asOf: '2026-09-18' })
  const closeOnly = daily.find((bar) => bar.firstSession === '2026-09-15')!
  assert.equal(closeOnly.open, null, 'close-only day: no fabricated candle')
  assert.equal(closeOnly.close, rows[6].close)
}

// PIT: rows after the boundary never reach aggregation.
{
  const dates = sessionsBetween(JP, '2026-08-03', '2026-10-16')
  const rows = ohlcRows(dates)
  const boundary = '2026-09-16'
  const withFuture = rows.map((row) => ((row.date as string) > boundary ? { ...row, close: 99999, high: 99999 } : row))
  for (const timeframe of SMA_LAB_TIMEFRAMES) {
    const a = aggregate(withFuture, timeframe.spec, JP, boundary).bars
    const b = aggregate(rows.filter((row) => (row.date as string) <= boundary), timeframe.spec, JP, boundary).bars
    assert.deepEqual(a, b, `${timeframe.id}: post-boundary rows do not change bars`)
    assert.ok(a.every((bar) => (bar.high ?? 0) < 99999))
  }
}

// Source isolation: the lab never touches the Stage resampler or Stage code.
{
  for (const file of ['lib/sma-dynamics-timeframes.ts', 'lib/sma-dynamics-lab.ts', 'lib/sma-dynamics-chart-model.ts']) {
    const source = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    assert.doesNotMatch(source, /resampleOhlcv|stageFromThreeMa|hex-stage|StageTimeline|trigger|@\/lib\/db|fetch\(/i, `${file} stays out of Stage/Trigger/DB`)
    assert.doesNotMatch(source, /Math\.random|Date\.now|new Date\(\)/, `${file} deterministic`)
  }
}

console.log('test-sma-dynamics-timeframes: ok')
