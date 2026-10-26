// Chart-parity OHLCV aggregation for SMA Dynamics Lab only.
//
// Bar boundaries are NOT re-implemented here: the lab asks lib/timeframes
// getTimeframeBucketKey which sessions / weeks share a bar, so a lab bar and the
// same-named main-chart bar always hold the same sessions (TradingView semantics).
// Nothing here feeds Stage/Trigger calculations.
//
// Grouping rules (documented contract, see scripts/test-sma-dynamics-timeframes.ts):
// - nD (session × n): sessions are numbered inside each exchange year starting at that
//   year's first market session (the chart's trading-year session index); bucket b holds
//   indices [b·n, b·n + n − 1]. A bar never spans New Year, so a year's last bar may be short.
//   2D and 3D are chart intervals. 5D is Lab-only: same engine, same rule with n = 5
//   (there is no 5D chart interval to compare with).
// - nW: calendar weeks (Mon–Sun). 1W is the calendar week. For n > 1 the TradingView rule
//   applies: a week belongs to the year of its Monday, a year's first week is the week
//   containing Jan 4 (moved to Monday when Jan 4 is a weekend) and bucket b holds weeks
//   [b·n, b·n + n − 1] of that year, so multi-week bars restart every year.
// - nM: calendar months numbered from 1970-01; bucket b holds months [b·n, b·n + n − 1], so
//   3M buckets are calendar quarters, 12M calendar years and 24M/36M/60M multi-year bars
//   counted from 1970 (the same boundaries as the chart's month / year intervals).
// - Only sessions of the market calendar belong to a bucket. Missing rows never shift a
//   boundary; they are reported and the bar is flagged instead.
// There is deliberately no fixed-epoch mode (continuous numbering independent of the year):
// it disagrees with the chart for 2D/3D/2W/3W and the lab must show the chart's bars.
import {
  calendarMonthBucket,
  calendarWeekStart,
  createTimeframeBucketContext,
  getTimeframeBucketKey,
  tradingViewWeekBucketOrdinal,
  type TimeframeBucketContext,
} from '@/lib/timeframes'
import {
  isIsoCalendarDate,
  normalizeSmaHistory,
  type SmaDataIssue,
  type SmaDynamicsMarket,
} from '@/lib/sma-dynamics'

export type SmaLabTimeframeUnit = 'session' | 'week' | 'month'

/** Generic N-session / N-week / N-month bar. New timeframes only need a new entry. */
export interface SmaLabTimeframeSpec {
  unit: SmaLabTimeframeUnit
  count: number
}

/**
 * How a lab bar relates to the same-named main-chart interval (lib/timeframes):
 * - same: boundaries come from the chart's own bucket function (getTimeframeBucketKey)
 * - lab_only: no main-chart interval with that length exists (5D); it follows the chart's
 *   multi-session rule (exchange-year session numbering) with n = 5
 */
export type SmaLabChartAlignment = 'same' | 'lab_only'

export const SMA_LAB_TIMEFRAMES = [
  { id: '1D', label: '1D', name: '日足', barNoun: '日足', spec: { unit: 'session', count: 1 }, core: true, chartCode: 'D', chartAlignment: 'same' },
  { id: '2D', label: '2D', name: '2営業日足', barNoun: '2営業日足', spec: { unit: 'session', count: 2 }, core: true, chartCode: '2D', chartAlignment: 'same' },
  { id: '3D', label: '3D', name: '3営業日足', barNoun: '3営業日足', spec: { unit: 'session', count: 3 }, core: true, chartCode: '3D', chartAlignment: 'same' },
  { id: '5D', label: '5D', name: '5営業日足', barNoun: '5営業日足', spec: { unit: 'session', count: 5 }, core: true, chartCode: null, chartAlignment: 'lab_only' },
  { id: '1W', label: '1W', name: '週足', barNoun: '週足', spec: { unit: 'week', count: 1 }, core: true, chartCode: 'W', chartAlignment: 'same' },
  { id: '2W', label: '2W', name: '2週足', barNoun: '2週足', spec: { unit: 'week', count: 2 }, core: true, chartCode: '2W', chartAlignment: 'same' },
  { id: '3W', label: '3W', name: '3週足', barNoun: '3週足', spec: { unit: 'week', count: 3 }, core: false, chartCode: '3W', chartAlignment: 'same' },
  { id: '1M', label: '1M', name: '月足', barNoun: '月足', spec: { unit: 'month', count: 1 }, core: true, chartCode: 'M', chartAlignment: 'same' },
  { id: '2M', label: '2M', name: '2か月足', barNoun: '2か月足', spec: { unit: 'month', count: 2 }, core: false, chartCode: '2M', chartAlignment: 'same' },
  { id: '3M', label: '3M', name: '四半期足', barNoun: '四半期足', spec: { unit: 'month', count: 3 }, core: true, chartCode: '3M', chartAlignment: 'same' },
  { id: '6M', label: '6M', name: '半年足', barNoun: '半年足', spec: { unit: 'month', count: 6 }, core: false, chartCode: '6M', chartAlignment: 'same' },
  { id: '1Y', label: '1Y', name: '年足', barNoun: '年足', spec: { unit: 'month', count: 12 }, core: false, chartCode: 'Y', chartAlignment: 'same' },
  { id: '2Y', label: '2Y', name: '2年足', barNoun: '2年足', spec: { unit: 'month', count: 24 }, core: false, chartCode: '2Y', chartAlignment: 'same' },
  { id: '3Y', label: '3Y', name: '3年足', barNoun: '3年足', spec: { unit: 'month', count: 36 }, core: false, chartCode: '3Y', chartAlignment: 'same' },
  { id: '5Y', label: '5Y', name: '5年足', barNoun: '5年足', spec: { unit: 'month', count: 60 }, core: false, chartCode: '5Y', chartAlignment: 'same' },
] as const satisfies ReadonlyArray<{
  id: string
  label: string
  name: string
  barNoun: string
  spec: SmaLabTimeframeSpec
  /** The eight timeframes the lab was specified for; the rest extend coverage to the chart's other intervals. */
  core: boolean
  chartCode: string | null
  chartAlignment: SmaLabChartAlignment
}>

export type SmaLabTimeframeId = (typeof SMA_LAB_TIMEFRAMES)[number]['id']
export type SmaLabTimeframe = (typeof SMA_LAB_TIMEFRAMES)[number]

export function smaLabTimeframe(id: SmaLabTimeframeId): SmaLabTimeframe {
  return SMA_LAB_TIMEFRAMES.find((item) => item.id === id) ?? SMA_LAB_TIMEFRAMES[0]
}

export function isSmaLabTimeframeId(value: unknown): value is SmaLabTimeframeId {
  return SMA_LAB_TIMEFRAMES.some((item) => item.id === value)
}

// ---------------------------------------------------------------------------
// Market calendars

// TSE still traded some Saturdays before 1989. The app has no authoritative
// pre-1990 exchange-session artifact, so the lab fails closed outside this range
// instead of presenting a weekday/holiday approximation as exact.
export const SMA_LAB_MIN_DATE = '1990-01-01'
export const SMA_LAB_MAX_DATE = '2099-12-31'

/**
 * Full-day exchange closures/openings the shared calendars do not model. Applied
 * only inside the lab; lib/server calendars stay authoritative elsewhere.
 */
export const SMA_LAB_CALENDAR_OVERRIDES: Record<SmaDynamicsMarket, { closed: readonly string[]; open: readonly string[] }> = {
  JP: {
    // Imperial funeral/enthronement/wedding days, the 2019 accession holidays, and the
    // 2020-10-01 TSE all-day trading halt.
    closed: ['1989-02-24', '1990-11-12', '1993-06-09', '2019-04-30', '2019-05-01', '2019-05-02', '2019-10-22', '2020-10-01'],
    open: [],
  },
  US: {
    // National days of mourning, 9/11 and Hurricane Sandy. Early closes remain sessions.
    closed: ['1994-04-27', '2001-09-11', '2001-09-12', '2001-09-13', '2001-09-14', '2004-06-11', '2007-01-02', '2012-10-29', '2012-10-30', '2018-12-05', '2025-01-09'],
    open: [],
  },
}

export interface SmaLabCalendar {
  id: string
  market: SmaDynamicsMarket
  /** Human-readable calendar name for the UI. */
  label: string
  isSession(date: string): boolean
}

function nthWeekday(year: number, month: number, weekday: number, nth: number): string {
  const first = new Date(Date.UTC(year, month - 1, 1))
  return fromUtc(Date.UTC(year, month - 1, 1 + (weekday - first.getUTCDay() + 7) % 7 + (nth - 1) * 7))
}

function lastWeekday(year: number, month: number, weekday: number): string {
  const last = new Date(Date.UTC(year, month, 0))
  return fromUtc(last.getTime() - ((last.getUTCDay() - weekday + 7) % 7) * MS_PER_DAY)
}

function jpVernalEquinoxDay(year: number): number {
  return year <= 2099
    ? Math.floor(20.8431 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4))
    : Math.floor(21.851 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4))
}

function jpAutumnalEquinoxDay(year: number): number {
  return year <= 2099
    ? Math.floor(23.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4))
    : Math.floor(24.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4))
}

/** Statutory JP holidays for the supported 1990+ range, before substitute/citizens' holidays. */
function baseJpHolidays(year: number): Set<string> {
  const holidays = new Set<string>([
    `${year}-01-01`,
    year < 2000 ? `${year}-01-15` : nthWeekday(year, 1, 1, 2),
    `${year}-02-11`,
    `${year}-03-${String(jpVernalEquinoxDay(year)).padStart(2, '0')}`,
    `${year}-04-29`,
    `${year}-05-03`,
    `${year}-05-05`,
    year < 2003 ? `${year}-09-15` : nthWeekday(year, 9, 1, 3),
    `${year}-09-${String(jpAutumnalEquinoxDay(year)).padStart(2, '0')}`,
    year < 2000 ? `${year}-10-10` : nthWeekday(year, 10, 1, 2),
    `${year}-11-03`,
    `${year}-11-23`,
  ])
  if (year <= 2018) holidays.add(`${year}-12-23`)
  if (year >= 2020) holidays.add(`${year}-02-23`)
  if (year >= 2007) holidays.add(`${year}-05-04`)
  if (year >= 1996 && year <= 2002) holidays.add(`${year}-07-20`)
  if (year >= 2003) holidays.add(nthWeekday(year, 7, 1, 3))
  if (year >= 2016) holidays.add(`${year}-08-11`)

  // Tokyo Olympics exceptions: the ordinary dates did not also remain holidays.
  if (year === 2020) {
    holidays.delete(nthWeekday(year, 7, 1, 3))
    holidays.delete(`${year}-08-11`)
    holidays.delete(nthWeekday(year, 10, 1, 2))
    holidays.add(`${year}-07-23`)
    holidays.add(`${year}-07-24`)
    holidays.add(`${year}-08-10`)
  } else if (year === 2021) {
    holidays.delete(nthWeekday(year, 7, 1, 3))
    holidays.delete(`${year}-08-11`)
    holidays.delete(nthWeekday(year, 10, 1, 2))
    holidays.add(`${year}-07-22`)
    holidays.add(`${year}-07-23`)
    holidays.add(`${year}-08-08`)
  }
  return holidays
}

const jpHolidayCache = new Map<number, ReadonlySet<string>>()

function jpHolidays(year: number): ReadonlySet<string> {
  const cached = jpHolidayCache.get(year)
  if (cached) return cached
  const base = new Set<string>()
  for (const y of [year - 1, year, year + 1]) for (const date of baseJpHolidays(y)) base.add(date)
  const holidays = new Set(base)
  // Substitute holidays began in 1973. Before 2007 only the following Monday
  // was designated; since 2007 the next non-holiday is designated.
  for (const date of base) {
    if (new Date(`${date}T00:00:00Z`).getUTCDay() !== 0) continue
    let substitute = addCalendarDays(date, 1)
    if (date >= '2007-01-01') while (holidays.has(substitute)) substitute = addCalendarDays(substitute, 1)
    holidays.add(substitute)
  }
  // Citizens' holidays are created only by two surrounding national holidays,
  // not by substitute holidays.
  for (let date = `${year}-01-02`; date < `${year}-12-31`; date = addCalendarDays(date, 1)) {
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay()
    if (weekday === 0 || weekday === 6 || holidays.has(date)) continue
    if (base.has(addCalendarDays(date, -1)) && base.has(addCalendarDays(date, 1))) holidays.add(date)
  }
  jpHolidayCache.set(year, holidays)
  return holidays
}

function isStandardJpSession(date: string): boolean {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay()
  if (day === 0 || day === 6) return false
  const monthDay = date.slice(5)
  if (monthDay <= '01-03' || monthDay === '12-31') return false
  return !jpHolidays(Number(date.slice(0, 4))).has(date)
}

function observedFixedHoliday(year: number, month: number, day: number, observeSaturday = true): string | null {
  const holiday = new Date(Date.UTC(year, month - 1, day))
  if (holiday.getUTCDay() === 6) return observeSaturday ? fromUtc(holiday.getTime() - MS_PER_DAY) : null
  if (holiday.getUTCDay() === 0) return fromUtc(holiday.getTime() + MS_PER_DAY)
  return fromUtc(holiday.getTime())
}

function easterSunday(year: number): Date {
  const a = year % 19; const b = Math.floor(year / 100); const c = year % 100
  const d = Math.floor(b / 4); const e = b % 4; const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3); const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4); const k = c % 4; const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return new Date(Date.UTC(year, month - 1, day))
}

const usHolidayCache = new Map<number, ReadonlySet<string>>()

function usHolidays(year: number): ReadonlySet<string> {
  const cached = usHolidayCache.get(year)
  if (cached) return cached
  const holidays = new Set<string>()
  const add = (date: string | null) => { if (date) holidays.add(date) }
  // NYSE does not move a Saturday New Year's Day to the preceding Friday.
  add(observedFixedHoliday(year, 1, 1, false))
  if (year >= 1998) holidays.add(nthWeekday(year, 1, 1, 3))
  holidays.add(nthWeekday(year, 2, 1, 3))
  holidays.add(lastWeekday(year, 5, 1))
  add(observedFixedHoliday(year, 7, 4))
  holidays.add(nthWeekday(year, 9, 1, 1))
  holidays.add(nthWeekday(year, 11, 4, 4))
  add(observedFixedHoliday(year, 12, 25))
  holidays.add(fromUtc(easterSunday(year).getTime() - 2 * MS_PER_DAY))
  if (year >= 2022) add(observedFixedHoliday(year, 6, 19))
  usHolidayCache.set(year, holidays)
  return holidays
}

function isStandardUsSession(date: string): boolean {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay()
  return day !== 0 && day !== 6 && !usHolidays(Number(date.slice(0, 4))).has(date)
}

function buildCalendar(market: SmaDynamicsMarket): SmaLabCalendar {
  const standard = market === 'US' ? isStandardUsSession : isStandardJpSession
  const closed = new Set(SMA_LAB_CALENDAR_OVERRIDES[market].closed)
  const open = new Set(SMA_LAB_CALENDAR_OVERRIDES[market].open)
  return {
    id: `sma-lab:${market}`,
    market,
    label: market === 'US' ? '米国取引所カレンダー(NYSE休場日)' : '東証カレンダー(祝日・年末年始)',
    isSession: (date) => isIsoCalendarDate(date)
      && date >= SMA_LAB_MIN_DATE
      && date <= SMA_LAB_MAX_DATE
      && (open.has(date) || (!closed.has(date) && standard(date))),
  }
}

const CALENDARS: Record<SmaDynamicsMarket, SmaLabCalendar> = { JP: buildCalendar('JP'), US: buildCalendar('US') }

export function smaLabCalendar(market: SmaDynamicsMarket): SmaLabCalendar {
  return CALENDARS[market]
}

const MS_PER_DAY = 86_400_000

function toUtc(date: string): number {
  return Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)))
}

function fromUtc(time: number): string {
  return new Date(time).toISOString().slice(0, 10)
}

export function addCalendarDays(date: string, days: number): string {
  return fromUtc(toUtc(date) + days * MS_PER_DAY)
}

/** Same day-of-month `months` later/earlier, clamped to the month end. */
export function addCalendarMonths(date: string, months: number): string {
  const year = Number(date.slice(0, 4))
  const month = Number(date.slice(5, 7)) - 1 + months
  const day = Number(date.slice(8, 10))
  const targetYear = year + Math.floor(month / 12)
  const targetMonth = ((month % 12) + 12) % 12
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate()
  return fromUtc(Date.UTC(targetYear, targetMonth, Math.min(day, lastDay)))
}

function floorDiv(value: number, divisor: number): number {
  return Math.floor(value / divisor)
}

interface YearSessions {
  dates: string[]
  index: Map<string, number>
}

const yearSessionCache = new Map<string, YearSessions>()
const yearContextCache = new Map<string, TimeframeBucketContext>()

/** The chart's bucket context for one exchange year (trading-year session index of the market calendar). */
function yearContext(calendar: SmaLabCalendar, year: number): TimeframeBucketContext {
  const key = `${calendar.id}:${year}`
  const cached = yearContextCache.get(key)
  if (cached) return cached
  const context = createTimeframeBucketContext(yearSessions(calendar, year).dates)
  yearContextCache.set(key, context)
  return context
}

function yearSessions(calendar: SmaLabCalendar, year: number): YearSessions {
  assertSupportedYear(year)
  const key = `${calendar.id}:${year}`
  const cached = yearSessionCache.get(key)
  if (cached) return cached
  const dates: string[] = []
  for (let time = Date.UTC(year, 0, 1); new Date(time).getUTCFullYear() === year; time += MS_PER_DAY) {
    const date = fromUtc(time)
    if (calendar.isSession(date)) dates.push(date)
  }
  const entry = { dates, index: new Map(dates.map((date, index) => [date, index])) }
  yearSessionCache.set(key, entry)
  return entry
}

function assertSupportedYear(year: number) {
  if (year < Number(SMA_LAB_MIN_DATE.slice(0, 4)) || year > Number(SMA_LAB_MAX_DATE.slice(0, 4))) {
    throw new RangeError(`SMA lab calendar supports ${SMA_LAB_MIN_DATE}..${SMA_LAB_MAX_DATE}: ${year}`)
  }
}

/** Session `delta` sessions away from `date` (which must be a session). */
export function shiftSession(calendar: SmaLabCalendar, date: string, delta: number): string {
  let year = Number(date.slice(0, 4))
  let sessions = yearSessions(calendar, year)
  const start = sessions.index.get(date)
  if (start == null) throw new RangeError(`${date} is not a ${calendar.market} session`)
  let target = start + delta
  while (target < 0) {
    year -= 1
    assertSupportedYear(year)
    sessions = yearSessions(calendar, year)
    target += sessions.dates.length
  }
  while (target >= sessions.dates.length) {
    target -= sessions.dates.length
    year += 1
    assertSupportedYear(year)
    sessions = yearSessions(calendar, year)
  }
  return sessions.dates[target]
}

/** Inclusive session list between two calendar dates. */
export function sessionsBetween(calendar: SmaLabCalendar, from: string, to: string): string[] {
  if (from > to) return []
  if (!isIsoCalendarDate(from) || !isIsoCalendarDate(to) || from < SMA_LAB_MIN_DATE || to > SMA_LAB_MAX_DATE) {
    throw new RangeError(`SMA lab calendar supports ${SMA_LAB_MIN_DATE}..${SMA_LAB_MAX_DATE}: ${from}..${to}`)
  }
  const out: string[] = []
  for (let year = Number(from.slice(0, 4)); year <= Number(to.slice(0, 4)); year += 1) {
    for (const date of yearSessions(calendar, year).dates) {
      if (date >= from && date <= to) out.push(date)
    }
  }
  return out
}

/** First session strictly after `date` (any calendar day). */
export function nextSessionAfter(calendar: SmaLabCalendar, date: string): string {
  let year = Number(date.slice(0, 4))
  for (let guard = 0; guard < 3; guard += 1, year += 1) {
    assertSupportedYear(year)
    const found = yearSessions(calendar, year).dates.find((candidate) => candidate > date)
    if (found) return found
  }
  throw new RangeError(`no ${calendar.market} session after ${date}`)
}

// ---------------------------------------------------------------------------
// Buckets

export interface SmaLabBucket {
  /** Stable identity: the chart bucket key for sessions / weeks (e.g. "day:2026:2:5", "week:2026:2:3"), "M3:226" for months. */
  key: string
  /** Monotonic bucket number within the spec. */
  ordinal: number
  /** Calendar period covered (inclusive). */
  periodStart: string
  periodEnd: string
  /** Market sessions inside the period, ascending. Never empty for a bar. */
  sessions: readonly string[]
}

function monthStart(monthIndex: number): string {
  return fromUtc(Date.UTC(1970 + floorDiv(monthIndex, 12), ((monthIndex % 12) + 12) % 12, 1))
}

function monthEnd(monthIndex: number): string {
  return fromUtc(Date.UTC(1970 + floorDiv(monthIndex, 12), (((monthIndex % 12) + 12) % 12) + 1, 0))
}

/** Longest supported bar: 60 months (5Y), or 60 weeks / sessions. */
export const SMA_LAB_MAX_TIMEFRAME_COUNT = 60

function assertSpec(spec: SmaLabTimeframeSpec) {
  if (!Number.isInteger(spec.count) || spec.count < 1 || spec.count > SMA_LAB_MAX_TIMEFRAME_COUNT) {
    throw new RangeError(`timeframe count must be an integer in 1..${SMA_LAB_MAX_TIMEFRAME_COUNT}: ${spec.count}`)
  }
}

/** Bucket containing `date`. For session specs `date` must be a session. */
export function bucketForDate(calendar: SmaLabCalendar, spec: SmaLabTimeframeSpec, date: string): SmaLabBucket {
  assertSpec(spec)
  if (!isIsoCalendarDate(date) || date < SMA_LAB_MIN_DATE || date > SMA_LAB_MAX_DATE) {
    throw new RangeError(`SMA lab calendar supports ${SMA_LAB_MIN_DATE}..${SMA_LAB_MAX_DATE}: ${date}`)
  }
  const n = spec.count
  if (spec.unit === 'session') {
    // Membership is decided by the chart's own bucket function over the exchange year's sessions.
    const year = Number(date.slice(0, 4))
    const { dates, index } = yearSessions(calendar, year)
    const at = index.get(date)
    if (at == null) throw new RangeError(`${date} is not a ${calendar.market} session`)
    const chartSpec = { timeframe: 'day', multiplier: n } as const
    const context = yearContext(calendar, year)
    const key = getTimeframeBucketKey(date, chartSpec, context)
    let first = at
    let last = at
    while (first > 0 && getTimeframeBucketKey(dates[first - 1], chartSpec, context) === key) first -= 1
    while (last < dates.length - 1 && getTimeframeBucketKey(dates[last + 1], chartSpec, context) === key) last += 1
    const sessions = dates.slice(first, last + 1)
    return { key, ordinal: year * 1000 + Math.floor(first / n), periodStart: sessions[0], periodEnd: sessions.at(-1)!, sessions }
  }
  if (spec.unit === 'week') {
    const chartSpec = { timeframe: 'week', multiplier: n } as const
    const key = getTimeframeBucketKey(date, chartSpec)
    let periodStart = calendarWeekStart(date)
    let periodEnd = addCalendarDays(periodStart, 6)
    // Multi-week bars restart each exchange year; walk whole weeks while the chart keeps them in this bar.
    while (getTimeframeBucketKey(addCalendarDays(periodStart, -7), chartSpec) === key) periodStart = addCalendarDays(periodStart, -7)
    while (getTimeframeBucketKey(addCalendarDays(periodEnd, 1), chartSpec) === key) periodEnd = addCalendarDays(periodEnd, 7)
    return { key, ordinal: tradingViewWeekBucketOrdinal(date, n), periodStart, periodEnd, sessions: sessionsBetween(calendar, periodStart, periodEnd) }
  }
  const bucket = floorDiv(calendarMonthBucket(date), n)
  const periodStart = monthStart(bucket * n)
  const periodEnd = monthEnd(bucket * n + n - 1)
  return { key: `M${n}:${bucket}`, ordinal: bucket, periodStart, periodEnd, sessions: sessionsBetween(calendar, periodStart, periodEnd) }
}

/** Next bucket that contains at least one session. */
export function nextBucket(calendar: SmaLabCalendar, spec: SmaLabTimeframeSpec, bucket: SmaLabBucket): SmaLabBucket {
  let cursor = bucket
  for (let guard = 0; guard < 60; guard += 1) {
    const probe = spec.unit === 'session'
      ? nextSessionAfter(calendar, cursor.periodEnd)
      : addCalendarDays(cursor.periodEnd, 1)
    cursor = bucketForDate(calendar, spec, probe)
    if (cursor.sessions.length > 0) return cursor
  }
  throw new RangeError(`no non-empty bucket after ${bucket.key}`)
}

/** `count` future buckets ending strictly after `asOf`, starting with the bucket that contains it if still open. */
export function futureBuckets(calendar: SmaLabCalendar, spec: SmaLabTimeframeSpec, asOf: string, count: number): SmaLabBucket[] {
  const out: SmaLabBucket[] = []
  if (count <= 0) return out
  let bucket = bucketForDate(calendar, spec, asOf)
  if (bucket.sessions.at(-1)! > asOf) out.push(bucket)
  while (out.length < count) {
    bucket = nextBucket(calendar, spec, bucket)
    out.push(bucket)
  }
  return out
}

// ---------------------------------------------------------------------------
// Daily normalization (extends the Phase 1 close normalization with OHLCV)

export interface SmaLabRawRow {
  date?: unknown
  open?: unknown
  high?: unknown
  low?: unknown
  close?: unknown
  volume?: unknown
}

export type SmaLabDataIssue =
  | SmaDataIssue
  | { kind: 'invalid_ohlc'; date: string }
  | { kind: 'ohlc_unavailable'; date: string }
  | { kind: 'off_calendar_date'; date: string }
  | { kind: 'unsupported_date'; date: string }
  | { kind: 'missing_session'; date: string }

export interface SmaLabDailyRow {
  date: string
  /** null when the close is unusable (invalid, non-positive, duplicate date). */
  close: number | null
  /** Present only when open/high/low/close are all valid and consistent. */
  ohlc: { open: number; high: number; low: number } | null
  volume: number | null
}

export interface NormalizedSmaLabHistory {
  rows: SmaLabDailyRow[]
  byDate: Map<string, SmaLabDailyRow>
  issues: SmaLabDataIssue[]
  excludedAfterBoundary: number
}

function positiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/**
 * PIT cut, sort, duplicates and close validation reuse normalizeSmaHistory so the
 * 1D lab and Phase 1 agree row for row. Rows on non-session dates are reported and
 * excluded rather than merged into a neighbouring bucket.
 */
export function normalizeSmaLabHistory(
  rows: ReadonlyArray<SmaLabRawRow>,
  calendar: SmaLabCalendar,
  boundary: string | null,
): NormalizedSmaLabHistory {
  const issues: SmaLabDataIssue[] = []
  const supported: SmaLabRawRow[] = []
  const rawByDate = new Map<string, SmaLabRawRow>()
  for (const row of rows) {
    const date = row?.date
    if (isIsoCalendarDate(date) && (date < SMA_LAB_MIN_DATE || date > SMA_LAB_MAX_DATE)) {
      if (boundary == null || date <= boundary) issues.push({ kind: 'unsupported_date', date })
      continue
    }
    supported.push(row)
    if (isIsoCalendarDate(date)) rawByDate.set(date, row)
  }

  const base = normalizeSmaHistory(supported, boundary)
  issues.push(...base.issues)
  const out: SmaLabDailyRow[] = []
  for (const point of base.series) {
    if (!calendar.isSession(point.date)) {
      issues.push({ kind: 'off_calendar_date', date: point.date })
      continue
    }
    const raw = rawByDate.get(point.date)
    let ohlc: SmaLabDailyRow['ohlc'] = null
    if (point.close != null && raw) {
      const { open, high, low } = raw
      if (open === undefined && high === undefined && low === undefined) {
        issues.push({ kind: 'ohlc_unavailable', date: point.date })
      } else if (
        positiveFinite(open) && positiveFinite(high) && positiveFinite(low)
        && high >= Math.max(open, point.close, low) && low <= Math.min(open, point.close)
      ) {
        ohlc = { open, high, low }
      } else {
        issues.push({ kind: 'invalid_ohlc', date: point.date })
      }
    }
    const volume = raw && typeof raw.volume === 'number' && Number.isFinite(raw.volume) && raw.volume >= 0 && point.close != null
      ? raw.volume
      : null
    out.push({ date: point.date, close: point.close, ohlc, volume })
  }
  issues.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0))
  return { rows: out, byDate: new Map(out.map((row) => [row.date, row])), issues, excludedAfterBoundary: base.excludedAfterBoundary }
}

// ---------------------------------------------------------------------------
// Aggregation

export type SmaLabBarPhase = 'confirmed' | 'forming'

export interface SmaLabBar {
  index: number
  key: string
  periodStart: string
  periodEnd: string
  /** First / last market session of the bucket (calendar, not data). */
  firstSession: string
  lastSession: string
  phase: SmaLabBarPhase
  /** Calendar sessions in the bucket. */
  expectedSessions: number
  /** Calendar sessions up to and including the as-of date (equals expectedSessions when confirmed). */
  elapsedSessions: number
  /** Elapsed sessions that have a row with a valid close. */
  presentSessions: number
  open: number | null
  high: number | null
  low: number | null
  /**
   * confirmed: close of the bucket's last session (null if that row is missing or invalid).
   * forming: latest available close inside the bucket (provisional).
   */
  close: number | null
  volume: number | null
  /** The SMA may use this bar: confirmed and its closing session has a valid close. */
  closeExact: boolean
  /** Every elapsed session has valid OHLC; otherwise the candle is drawn as incomplete. */
  ohlcComplete: boolean
  /** Elapsed sessions before the first history row (listing / history start). */
  leadingPartial: boolean
  missingDates: string[]
  invalidDates: string[]
}

export interface AggregateSmaLabInput {
  history: NormalizedSmaLabHistory
  calendar: SmaLabCalendar
  spec: SmaLabTimeframeSpec
  /** Last session with a row at or before the PIT boundary. */
  asOf: string
}

export function aggregateSmaLabBars({ history, calendar, spec, asOf }: AggregateSmaLabInput): SmaLabBar[] {
  const first = history.rows[0]?.date
  if (!first || first > asOf) return []
  const bars: SmaLabBar[] = []
  let bucket = bucketForDate(calendar, spec, first)
  for (let guard = 0; guard < 200_000; guard += 1) {
    const elapsed = bucket.sessions.filter((date) => date <= asOf)
    const phase: SmaLabBarPhase = bucket.sessions.at(-1)! <= asOf ? 'confirmed' : 'forming'
    let open: number | null = null
    let high = -Infinity
    let low = Infinity
    let volume = 0
    let volumeComplete = true
    let lastClose: number | null = null
    let present = 0
    let ohlcComplete = true
    const missingDates: string[] = []
    const invalidDates: string[] = []
    let leadingPartial = false
    for (const date of elapsed) {
      const row = history.byDate.get(date)
      if (!row) {
        if (date < first) leadingPartial = true
        else missingDates.push(date)
        ohlcComplete = false
        volumeComplete = false
        continue
      }
      if (row.close == null) {
        invalidDates.push(date)
        ohlcComplete = false
        volumeComplete = false
        continue
      }
      present += 1
      lastClose = row.close
      if (row.ohlc) {
        if (open == null) open = row.ohlc.open
        high = Math.max(high, row.ohlc.high)
        low = Math.min(low, row.ohlc.low)
      } else {
        ohlcComplete = false
      }
      if (row.volume == null) volumeComplete = false
      else volume += row.volume
    }
    const closingRow = history.byDate.get(bucket.sessions.at(-1)!)
    const confirmedClose = phase === 'confirmed' && closingRow?.close != null ? closingRow.close : null
    const hasCandle = open != null && Number.isFinite(high) && Number.isFinite(low)
    const close = phase === 'confirmed' ? confirmedClose : lastClose
    bars.push({
      index: bars.length,
      key: bucket.key,
      periodStart: bucket.periodStart,
      periodEnd: bucket.periodEnd,
      firstSession: bucket.sessions[0],
      lastSession: bucket.sessions.at(-1)!,
      phase,
      expectedSessions: bucket.sessions.length,
      elapsedSessions: elapsed.length,
      presentSessions: present,
      open: hasCandle && close != null ? open : null,
      high: hasCandle && close != null ? Math.max(high, close) : null,
      low: hasCandle && close != null ? Math.min(low, close) : null,
      close,
      volume: volumeComplete ? volume : null,
      closeExact: phase === 'confirmed' && confirmedClose != null,
      ohlcComplete: ohlcComplete && !leadingPartial,
      leadingPartial,
      missingDates,
      invalidDates,
    })
    if (phase === 'forming' || bucket.sessions.at(-1)! >= asOf) break
    bucket = nextBucket(calendar, spec, bucket)
  }
  return bars
}

/** Calendar sessions between the first row and `asOf` that have no row at all. */
export function missingSessionIssues(history: NormalizedSmaLabHistory, calendar: SmaLabCalendar, asOf: string): SmaLabDataIssue[] {
  const first = history.rows[0]?.date
  if (!first) return []
  return sessionsBetween(calendar, first, asOf)
    .filter((date) => !history.byDate.has(date))
    .map((date) => ({ kind: 'missing_session' as const, date }))
}
