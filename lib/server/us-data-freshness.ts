const US_EOD_READY_MINUTES_JST = 6 * 60 + 30
const MS_PER_DAY = 24 * 60 * 60 * 1000

function jstParts(date: Date): { year: number; month: number; day: number; minuteOfDay: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value)
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    minuteOfDay: value('hour') * 60 + value('minute'),
  }
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function dateFromYmd(date: string): Date {
  return new Date(`${date}T00:00:00Z`)
}

function nthWeekday(year: number, month: number, weekday: number, nth: number): string {
  const first = new Date(Date.UTC(year, month - 1, 1))
  const offset = (weekday - first.getUTCDay() + 7) % 7
  const day = 1 + offset + (nth - 1) * 7
  return formatDate(new Date(Date.UTC(year, month - 1, day)))
}

function lastWeekday(year: number, month: number, weekday: number): string {
  const last = new Date(Date.UTC(year, month, 0))
  const offset = (last.getUTCDay() - weekday + 7) % 7
  last.setUTCDate(last.getUTCDate() - offset)
  return formatDate(last)
}

function observedFixedHoliday(year: number, month: number, day: number): string {
  const holiday = new Date(Date.UTC(year, month - 1, day))
  if (holiday.getUTCDay() === 6) holiday.setUTCDate(holiday.getUTCDate() - 1)
  if (holiday.getUTCDay() === 0) holiday.setUTCDate(holiday.getUTCDate() + 1)
  return formatDate(holiday)
}

function easterSunday(year: number): Date {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return new Date(Date.UTC(year, month - 1, day))
}

function regularUsMarketHolidays(year: number): Set<string> {
  const holidays = new Set<string>([
    observedFixedHoliday(year, 1, 1),
    nthWeekday(year, 1, 1, 3),
    nthWeekday(year, 2, 1, 3),
    lastWeekday(year, 5, 1),
    observedFixedHoliday(year, 7, 4),
    nthWeekday(year, 9, 1, 1),
    nthWeekday(year, 11, 4, 4),
    observedFixedHoliday(year, 12, 25),
  ])

  const goodFriday = new Date(easterSunday(year).getTime() - 2 * MS_PER_DAY)
  holidays.add(formatDate(goodFriday))
  if (year >= 2022) holidays.add(observedFixedHoliday(year, 6, 19))

  // A Saturday New Year's Day is observed on the prior calendar year.
  holidays.add(observedFixedHoliday(year + 1, 1, 1))
  return holidays
}

export function usMarketClosureReason(date: string): string | null {
  const value = dateFromYmd(date)
  const weekday = value.getUTCDay()
  if (weekday === 0 || weekday === 6) return 'weekend'
  if (regularUsMarketHolidays(value.getUTCFullYear()).has(date)) {
    return 'regular US exchange holiday'
  }
  return null
}

export function rollBackToUsTradingDate(date: Date): Date {
  const value = new Date(date)
  while (usMarketClosureReason(formatDate(value))) {
    value.setUTCDate(value.getUTCDate() - 1)
  }
  return value
}

export function expectedLatestUsTradingDate(now = new Date()): string {
  const parts = jstParts(now)
  const todayJst = new Date(Date.UTC(parts.year, parts.month - 1, parts.day))
  const latestPossibleSession = new Date(todayJst)
  latestPossibleSession.setUTCDate(
    latestPossibleSession.getUTCDate()
      - (parts.minuteOfDay >= US_EOD_READY_MINUTES_JST ? 1 : 2),
  )

  return formatDate(rollBackToUsTradingDate(latestPossibleSession))
}
