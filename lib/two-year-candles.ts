import type { OHLCV } from '@/types/stock'

export type TwoYearMarket = 'JP' | 'US'
export type TwoYearCandleStatus = 'confirmed' | 'forming' | 'incomplete'
export type RisingClosePattern = 'three' | 'four'

export interface TwoYearCandle extends OHLCV {
  periodStart: string
  periodEnd: string
  midpointDate: string
  firstSourceDate: string
  lastSourceDate: string
  startYear: number
  status: TwoYearCandleStatus
  provisionalEligible: boolean
  missingSessionCount: number
  exchangeTimeZone: 'Asia/Tokyo' | 'America/New_York'
}

export interface RisingCloseLine {
  id: string
  pattern: RisingClosePattern
  status: 'confirmed' | 'provisional'
  sourcePeriods: readonly [number, number, number] | readonly [number, number, number, number]
  aStartYear: number
  bStartYear: number
  cStartYear: number
  dStartYear?: number
  endpointStartYear: number
  points: readonly [TwoYearLinePoint, TwoYearLinePoint]
}

export interface TwoYearLinePoint {
  date: string
  value: number
}

export interface ExtendedRisingCloseLine extends RisingCloseLine {
  extendedPoints: readonly TwoYearLinePoint[]
}

export function twoYearBlockStartYear(isoDate: string): number {
  assertIsoDate(isoDate)
  const year = Number(isoDate.slice(0, 4))
  return year - (year % 2)
}

export function twoYearPeriod(startYear: number): Readonly<{
  periodStart: string
  periodEnd: string
  midpointDate: string
}> {
  if (!Number.isInteger(startYear) || startYear % 2 !== 0) throw new Error('two_year_start_must_be_even')
  return {
    periodStart: `${startYear}-01-01`,
    periodEnd: `${startYear + 1}-12-31`,
    midpointDate: `${startYear + 1}-01-01`,
  }
}

export function aggregateTwentyFourMonthCandles(
  rows: readonly OHLCV[],
  options: Readonly<{
    market: TwoYearMarket
    asOfDate: string
    exchangeSessions: readonly string[]
  }>,
): TwoYearCandle[] {
  assertIsoDate(options.asOfDate)
  const asOfBlock = twoYearBlockStartYear(options.asOfDate)
  const validRows = rows
    .filter(isValidOhlcv)
    .filter((row) => row.date <= options.asOfDate)
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date))
  const uniqueRows = new Map(validRows.map((row) => [row.date, row]))
  const sessions = [...new Set(options.exchangeSessions)]
    .filter((date) => isIsoDate(date) && date <= options.asOfDate)
    .sort()
  const grouped = new Map<number, OHLCV[]>()

  for (const row of uniqueRows.values()) {
    const startYear = twoYearBlockStartYear(row.date)
    const bucket = grouped.get(startYear) ?? []
    bucket.push(row)
    grouped.set(startYear, bucket)
  }

  return [...grouped.entries()]
    .sort(([left], [right]) => left - right)
    .map(([startYear, bucket]) => {
      const period = twoYearPeriod(startYear)
      const first = bucket[0]
      const last = bucket[bucket.length - 1]
      const expectedSessions = sessions.filter((date) => date >= period.periodStart && date <= period.periodEnd)
      const observed = new Set(bucket.map((row) => row.date))
      const missingSessionCount = expectedSessions.filter((date) => !observed.has(date)).length
      const calendarCoverageAvailable = expectedSessions.length > 0
      const calendarCoversPeriodStart = expectedSessions[0] <= `${startYear}-01-10`
      const calendarStartsNoLaterThanData = calendarCoverageAvailable && expectedSessions[0] <= first.date
      const coverageComplete = calendarCoverageAvailable
        && calendarCoversPeriodStart
        && calendarStartsNoLaterThanData
        && missingSessionCount === 0
      const isCurrentBlock = startYear === asOfBlock
      const status: TwoYearCandleStatus = coverageComplete
        ? (isCurrentBlock ? 'forming' : 'confirmed')
        : 'incomplete'
      return {
        // Lightweight Charts places every series on one shared logical time axis.
        // The 24-month candle and its close-line vertex therefore use the same
        // period midpoint anchor.
        date: period.midpointDate,
        open: first.open,
        high: Math.max(...bucket.map((row) => row.high)),
        low: Math.min(...bucket.map((row) => row.low)),
        close: last.close,
        volume: bucket.reduce((sum, row) => sum + row.volume, 0),
        adjustedClose: last.adjustedClose ?? null,
        ...period,
        firstSourceDate: first.date,
        lastSourceDate: last.date,
        startYear,
        status,
        provisionalEligible: status === 'forming' && options.asOfDate >= period.midpointDate,
        missingSessionCount,
        exchangeTimeZone: options.market === 'JP' ? 'Asia/Tokyo' : 'America/New_York',
      }
    })
}

export function detectRisingCloseLines(candles: readonly TwoYearCandle[]): RisingCloseLine[] {
  const sorted = candles.slice().sort((a, b) => a.startYear - b.startYear)
  let currentIndex = -1
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    if (sorted[index].status === 'forming') {
      currentIndex = index
      break
    }
  }
  if (currentIndex < 0) return []

  const current = sorted[currentIndex]
  const previousIndex = sorted.findIndex((candle) => candle.startYear === current.startYear - 2)
  const confirmed = previousIndex >= 0 && sorted[previousIndex].status === 'confirmed'
    ? detectLineEndingAt(sorted, previousIndex, 'confirmed')
    : null
  const provisional = current.provisionalEligible
    ? detectLineEndingAt(sorted, currentIndex, 'provisional')
    : null
  return [confirmed, provisional].filter((line): line is RisingCloseLine => line !== null)
}

export function standardizedRisingCloseAngleDeg(line: RisingCloseLine): number | null {
  const [start, end] = line.points
  const startTime = Date.parse(`${start.date}T00:00:00Z`)
  const endTime = Date.parse(`${end.date}T00:00:00Z`)
  const years = (endTime - startTime) / (365.2425 * 86_400_000)
  if (![start.value, end.value, years].every(Number.isFinite) || start.value <= 0 || years <= 0) return null
  const annualLinearRise = (end.value / start.value - 1) / years
  const angle = Math.atan(annualLinearRise / 0.2) * 180 / Math.PI
  return Number.isFinite(angle) ? angle : null
}

function detectLineEndingAt(
  sorted: readonly TwoYearCandle[],
  endpointIndex: number,
  status: RisingCloseLine['status'],
): RisingCloseLine | null {
  const three = detectThreeCandleLine(sorted, endpointIndex, status)
  const four = detectFourCandleLine(sorted, endpointIndex, status)
  if (three && four) throw new Error('two_year_line_pattern_not_unique')
  return three ?? four
}

function detectThreeCandleLine(
  sorted: readonly TwoYearCandle[],
  endpointIndex: number,
  status: RisingCloseLine['status'],
): RisingCloseLine | null {
  if (endpointIndex < 2) return null
  const a = sorted[endpointIndex - 2]
  const b = sorted[endpointIndex - 1]
  const c = sorted[endpointIndex]
  if (!areConsecutive([a, b, c]) || !isEligibleEndpoint(c, status)) return null
  if (a.status !== 'confirmed' || b.status !== 'confirmed') return null
  if (!(a.close < a.open && b.close > b.open && c.close > c.open && c.close > b.close)) return null
  return {
    id: `three:${a.startYear}-${b.startYear}-${c.startYear}`,
    pattern: 'three',
    status,
    sourcePeriods: [a.startYear, b.startYear, c.startYear],
    aStartYear: a.startYear,
    bStartYear: b.startYear,
    cStartYear: c.startYear,
    endpointStartYear: c.startYear,
    points: [
      { date: b.midpointDate, value: b.close },
      { date: c.midpointDate, value: c.close },
    ],
  }
}

function detectFourCandleLine(
  sorted: readonly TwoYearCandle[],
  endpointIndex: number,
  status: RisingCloseLine['status'],
): RisingCloseLine | null {
  if (endpointIndex < 3) return null
  const a = sorted[endpointIndex - 3]
  const b = sorted[endpointIndex - 2]
  const c = sorted[endpointIndex - 1]
  const d = sorted[endpointIndex]
  if (!areConsecutive([a, b, c, d]) || !isEligibleEndpoint(d, status)) return null
  if (a.status !== 'confirmed' || b.status !== 'confirmed' || c.status !== 'confirmed') return null
  if (!(a.close < a.open && b.close > b.open && c.close > c.open && d.close > d.open && d.close > c.close)) return null
  return {
    id: `four:${a.startYear}-${b.startYear}-${c.startYear}-${d.startYear}`,
    pattern: 'four',
    status,
    sourcePeriods: [a.startYear, b.startYear, c.startYear, d.startYear],
    aStartYear: a.startYear,
    bStartYear: b.startYear,
    cStartYear: c.startYear,
    dStartYear: d.startYear,
    endpointStartYear: d.startYear,
    points: [
      { date: c.midpointDate, value: c.close },
      { date: d.midpointDate, value: d.close },
    ],
  }
}

function areConsecutive(candles: readonly TwoYearCandle[]): boolean {
  return candles.every((candle, index) => index === 0 || candle.startYear === candles[index - 1].startYear + 2)
}

function isEligibleEndpoint(candle: TwoYearCandle, status: RisingCloseLine['status']): boolean {
  return status === 'confirmed'
    ? candle.status === 'confirmed'
    : candle.status === 'forming' && candle.provisionalEligible
}

export function extendRisingCloseLine(line: RisingCloseLine, throughDate: string): ExtendedRisingCloseLine {
  assertIsoDate(throughDate)
  const [start, end] = line.points
  if (throughDate <= end.date) return { ...line, extendedPoints: [start, end] }
  const startTime = Date.parse(`${start.date}T00:00:00Z`)
  const endTime = Date.parse(`${end.date}T00:00:00Z`)
  const targetTime = Date.parse(`${throughDate}T00:00:00Z`)
  const slope = (end.value - start.value) / (endTime - startTime)
  return {
    ...line,
    extendedPoints: [start, end, { date: throughDate, value: end.value + slope * (targetTime - endTime) }],
  }
}

export function twoYearLineExtensionDate(asOfDate: string): string {
  const startYear = twoYearBlockStartYear(asOfDate)
  return twoYearPeriod(startYear + 2).midpointDate
}

function isValidOhlcv(row: OHLCV): boolean {
  return isIsoDate(row.date)
    && [row.open, row.high, row.low, row.close, row.volume].every(Number.isFinite)
    && row.open > 0
    && row.high > 0
    && row.low > 0
    && row.close > 0
    && row.volume >= 0
    && row.high >= Math.max(row.open, row.close, row.low)
    && row.low <= Math.min(row.open, row.close, row.high)
}

function assertIsoDate(value: string): void {
  if (!isIsoDate(value)) throw new Error('invalid_exchange_date')
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  return new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
}
