const MS_PER_DAY = 24 * 60 * 60 * 1000

function ymd(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function dateFromYmd(date: string): Date {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day))
}

function formatUtcDate(date: Date): string {
  return ymd(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate())
}

function nthMonday(year: number, month: number, nth: number): string {
  const first = new Date(Date.UTC(year, month - 1, 1))
  const offset = (8 - first.getUTCDay()) % 7
  return ymd(year, month, 1 + offset + (nth - 1) * 7)
}

function vernalEquinoxDay(year: number): number {
  if (year <= 1979) return Math.floor(20.8357 + 0.242194 * (year - 1980) - Math.floor((year - 1983) / 4))
  if (year <= 2099) return Math.floor(20.8431 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4))
  return Math.floor(21.851 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4))
}

function autumnalEquinoxDay(year: number): number {
  if (year <= 1979) return Math.floor(23.2588 + 0.242194 * (year - 1980) - Math.floor((year - 1983) / 4))
  if (year <= 2099) return Math.floor(23.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4))
  return Math.floor(24.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4))
}

function baseJapaneseNationalHolidays(year: number): Set<string> {
  const holidays = new Set<string>([
    ymd(year, 1, 1),
    nthMonday(year, 1, 2),
    ymd(year, 2, 11),
    ymd(year, 3, vernalEquinoxDay(year)),
    ymd(year, 4, 29),
    ymd(year, 5, 3),
    ymd(year, 5, 4),
    ymd(year, 5, 5),
    nthMonday(year, 9, 3),
    ymd(year, 9, autumnalEquinoxDay(year)),
    nthMonday(year, 10, 2),
    ymd(year, 11, 3),
    ymd(year, 11, 23),
  ])

  if (year >= 2020) holidays.add(ymd(year, 2, 23))
  if (year >= 2016) holidays.add(ymd(year, 8, 11))

  if (year === 2020) {
    holidays.delete(nthMonday(year, 7, 3))
    holidays.delete(ymd(year, 8, 11))
    holidays.delete(nthMonday(year, 10, 2))
    holidays.add(ymd(year, 7, 23))
    holidays.add(ymd(year, 7, 24))
    holidays.add(ymd(year, 8, 10))
  } else if (year === 2021) {
    holidays.delete(nthMonday(year, 7, 3))
    holidays.delete(ymd(year, 8, 11))
    holidays.delete(nthMonday(year, 10, 2))
    holidays.add(ymd(year, 7, 22))
    holidays.add(ymd(year, 7, 23))
    holidays.add(ymd(year, 8, 8))
  } else {
    holidays.add(nthMonday(year, 7, 3))
  }

  return holidays
}

function japaneseNationalHolidays(year: number): Set<string> {
  const holidays = new Set<string>()
  for (const date of baseJapaneseNationalHolidays(year - 1)) holidays.add(date)
  for (const date of baseJapaneseNationalHolidays(year)) holidays.add(date)
  for (const date of baseJapaneseNationalHolidays(year + 1)) holidays.add(date)

  const base = new Set(holidays)
  for (const date of base) {
    if (dateFromYmd(date).getUTCDay() !== 0) continue
    let substitute = new Date(dateFromYmd(date).getTime() + MS_PER_DAY)
    while (holidays.has(formatUtcDate(substitute))) {
      substitute = new Date(substitute.getTime() + MS_PER_DAY)
    }
    holidays.add(formatUtcDate(substitute))
  }

  const start = dateFromYmd(`${year}-01-01`)
  const end = dateFromYmd(`${year}-12-31`)
  for (let time = start.getTime(); time <= end.getTime(); time += MS_PER_DAY) {
    const current = new Date(time)
    const weekday = current.getUTCDay()
    if (weekday === 0 || weekday === 6) continue
    const currentDate = formatUtcDate(current)
    if (holidays.has(currentDate)) continue
    const previous = formatUtcDate(new Date(time - MS_PER_DAY))
    const next = formatUtcDate(new Date(time + MS_PER_DAY))
    if (holidays.has(previous) && holidays.has(next)) holidays.add(currentDate)
  }

  return holidays
}

export function jpMarketClosureReason(date: string): string | null {
  const [year, month, day] = date.split('-').map(Number)
  const utcDate = new Date(Date.UTC(year, month - 1, day))
  const weekday = utcDate.getUTCDay()
  if (weekday === 0 || weekday === 6) return 'weekend'
  if ((month === 1 && day <= 3) || (month === 12 && day === 31)) {
    return 'exchange year-end/new-year holiday'
  }
  if (japaneseNationalHolidays(year).has(date)) return 'Japanese national holiday'
  return null
}

export function rollBackToJpTradingDate(date: Date): Date {
  const value = new Date(date)
  while (jpMarketClosureReason(formatUtcDate(value))) {
    value.setUTCDate(value.getUTCDate() - 1)
  }
  return value
}
