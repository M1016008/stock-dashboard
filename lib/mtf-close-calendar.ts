import {
  CLOSE_TIMEFRAMES,
  createTimeframeBucketContext,
  getTimeframeBucketKey,
  intervalToSpec,
  type CloseTimeframe,
  type TimeframeBucketContext,
} from '@/lib/timeframes'

const MS_PER_DAY = 86_400_000

export interface CloseCalendarDay {
  date: string
  isTradingDay: boolean
  nextTradingDate: string | null
  closeTimeframes: CloseTimeframe[]
  closeCount: number
}

export interface CloseCalendarResult {
  market: 'JP'
  from: string
  to: string
  days: CloseCalendarDay[]
  sessionAnchorDate: string | null
  sessionCoverageFrom: string | null
  sessionCoverageTo: string | null
  calendarSource: 'MARKET_OHLCV_AND_JP_HOLIDAY_RULES' | 'JP_HOLIDAY_RULES_ONLY'
  warnings: string[]
}

export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

export function addIsoDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * MS_PER_DAY).toISOString().slice(0, 10)
}

export function enumerateCalendarDates(from: string, to: string): string[] {
  const dates: string[] = []
  for (let date = from; date <= to; date = addIsoDays(date, 1)) dates.push(date)
  return dates
}

export function getNextTradingDay(date: string, tradingDates: readonly string[]): string | null {
  let low = 0
  let high = tradingDates.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (tradingDates[middle] <= date) low = middle + 1
    else high = middle
  }
  return tradingDates[low] ?? null
}

export function getPreviousTradingDay(date: string, tradingDates: readonly string[]): string | null {
  let low = 0
  let high = tradingDates.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (tradingDates[middle] < date) low = middle + 1
    else high = middle
  }
  return tradingDates[low - 1] ?? null
}

export function getCloseTimeframes(
  date: string,
  nextTradingDate: string,
  context: TimeframeBucketContext,
  timeframes: readonly CloseTimeframe[] = CLOSE_TIMEFRAMES,
): CloseTimeframe[] {
  return timeframes.filter((timeframe) => (
    getTimeframeBucketKey(date, intervalToSpec(timeframe), context) !==
    getTimeframeBucketKey(nextTradingDate, intervalToSpec(timeframe), context)
  ))
}

export function buildCloseCalendar(args: {
  market: 'JP'
  from: string
  to: string
  tradingDates: readonly string[]
  actualCoverageFrom?: string | null
  actualCoverageTo?: string | null
  calendarSource?: CloseCalendarResult['calendarSource']
  warnings?: readonly string[]
}): CloseCalendarResult {
  const tradingDates = [...new Set(args.tradingDates)].filter(isIsoDate).sort()
  const tradingSet = new Set(tradingDates)
  const context = createTimeframeBucketContext(tradingDates)
  const warnings = [...(args.warnings ?? [])]

  const days = enumerateCalendarDates(args.from, args.to).map<CloseCalendarDay>((date) => {
    const isTradingDay = tradingSet.has(date)
    const nextTradingDate = getNextTradingDay(date, tradingDates)
    if (!isTradingDay) {
      return { date, isTradingDay: false, nextTradingDate, closeTimeframes: [], closeCount: 0 }
    }

    if (!nextTradingDate) {
      if (!warnings.includes('NEXT_TRADING_SESSION_UNAVAILABLE')) {
        warnings.push('NEXT_TRADING_SESSION_UNAVAILABLE')
      }
      return { date, isTradingDay: true, nextTradingDate: null, closeTimeframes: ['D'], closeCount: 1 }
    }

    const closeTimeframes = getCloseTimeframes(date, nextTradingDate, context)
    return { date, isTradingDay: true, nextTradingDate, closeTimeframes, closeCount: closeTimeframes.length }
  })

  return {
    market: args.market,
    from: args.from,
    to: args.to,
    days,
    sessionAnchorDate: context.anchorDate,
    sessionCoverageFrom: args.actualCoverageFrom === undefined ? tradingDates[0] ?? null : args.actualCoverageFrom,
    sessionCoverageTo: args.actualCoverageTo === undefined ? tradingDates.at(-1) ?? null : args.actualCoverageTo,
    calendarSource: args.calendarSource ?? 'MARKET_OHLCV_AND_JP_HOLIDAY_RULES',
    warnings,
  }
}

export type CloseCountFilter = 0 | 2 | 3 | 4 | 5

export function visibleCloseTimeframes(
  day: Pick<CloseCalendarDay, 'closeTimeframes'>,
  enabled: ReadonlySet<CloseTimeframe>,
): CloseTimeframe[] {
  return day.closeTimeframes.filter((timeframe) => enabled.has(timeframe))
}

export function passesCloseCountFilter(
  day: Pick<CloseCalendarDay, 'closeTimeframes'>,
  enabled: ReadonlySet<CloseTimeframe>,
  minimum: CloseCountFilter,
): boolean {
  return visibleCloseTimeframes(day, enabled).length >= minimum
}

export function getUpcomingCloseDays(
  days: readonly CloseCalendarDay[],
  enabled: ReadonlySet<CloseTimeframe>,
  from: string,
  limit = 8,
): Array<CloseCalendarDay & { visibleTimeframes: CloseTimeframe[] }> {
  return days
    .filter((day) => day.date >= from && day.isTradingDay)
    .map((day) => ({ ...day, visibleTimeframes: visibleCloseTimeframes(day, enabled) }))
    .filter((day) => day.visibleTimeframes.length >= 2)
    .slice(0, limit)
}
