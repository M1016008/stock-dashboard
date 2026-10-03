import { getCloseTimeframes, getNextTradingDay } from '@/lib/mtf-close-calendar'
import {
  CLOSE_TIMEFRAMES,
  createTimeframeBucketContext,
  type CloseTimeframe,
  type TimeframeBucketContext,
} from '@/lib/timeframes'

export const TRADINGVIEW_ORACLE_COLUMNS = {
  exchangeDate: 'SB_EXCHANGE_DATE',
  confirmed: 'SB_BAR_CONFIRMED',
  regularSession: 'SB_SESSION_REGULAR',
  timeframes: Object.fromEntries(
    CLOSE_TIMEFRAMES.map((timeframe) => [timeframe, `SB_MTF_${timeframe}`]),
  ) as Record<CloseTimeframe, string>,
} as const

export type TradingViewParityStatus = 'PASS' | 'FAIL' | 'NOT_VALIDATED'

export interface TradingViewOracleObservation {
  date: string
  expectedCloseTimeframes: CloseTimeframe[]
}

export interface TradingViewOracleImport {
  symbol: string
  market: 'JP'
  chartTimeframe: '1D'
  exchangeTimezone: 'Asia/Tokyo'
  session: 'regular'
  from: string
  to: string
  observations: TradingViewOracleObservation[]
}

export interface TradingViewMtfFixtureObservation extends TradingViewOracleObservation {
  nextTradingDate: string
  sessionOrdinal: number
  nextSessionOrdinal: number
  tradingYearSessionIndex: number
  nextTradingYearSessionIndex: number
  tradingYearWeekIndex: number
  nextTradingYearWeekIndex: number
}

export interface TradingViewMtfFixture {
  schemaVersion: 2
  status: TradingViewParityStatus
  oracle: Omit<TradingViewOracleImport, 'observations'> | null
  sessionContext: {
    anchorDate: string
    coverageFrom: string | null
    coverageTo: string | null
    calendarSource: string
  } | null
  observations: TradingViewMtfFixtureObservation[]
  pending?: Array<{
    symbol: string
    range: string
    timeframes: CloseTimeframe[]
    status: 'PENDING_TRADINGVIEW_CSV_EXPORT'
  }>
}

export interface TradingViewParityMismatch {
  date: string
  timeframe: CloseTimeframe
  tradingViewExpected: boolean
  stockBoardActual: boolean
}

export interface TradingViewTimeframeResult {
  timeframe: CloseTimeframe
  expectedCloses: number
  actualCloses: number
  mismatches: number
}

export interface TradingViewParityReport {
  result: TradingViewParityStatus
  symbol: string | null
  period: { from: string; to: string } | null
  session: string | null
  totalDatesCompared: number
  totalTfDateComparisons: number
  totalMismatches: number
  timeframes: TradingViewTimeframeResult[]
  mismatches: TradingViewParityMismatch[]
  october30: {
    status: 'COMPARED' | 'NOT_IN_ORACLE_PERIOD'
    tradingView: CloseTimeframe[] | null
    stockBoard: CloseTimeframe[] | null
  }
}

function normalizeColumnName(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
}

function findRequiredColumn(headers: readonly string[], expected: string): number {
  const token = normalizeColumnName(expected)
  const matches = headers
    .map((header, index) => ({ normalized: normalizeColumnName(header), index }))
    .filter(({ normalized }) => normalized === token || normalized.endsWith(token))
  if (matches.length !== 1) {
    throw new Error(`TradingView CSV requires exactly one ${expected} column; found ${matches.length}.`)
  }
  return matches[0].index
}

function parseFlag(value: string, column: string, rowNumber: number): boolean {
  const normalized = value.trim().toLowerCase()
  if (normalized === '1' || normalized === '1.0' || normalized === 'true') return true
  if (normalized === '0' || normalized === '0.0' || normalized === 'false') return false
  throw new Error(`TradingView CSV row ${rowNumber} has an invalid ${column} flag.`)
}

function parseExchangeDate(value: string, rowNumber: number): string {
  const digits = value.trim().replace(/\.0+$/, '')
  if (!/^\d{8}$/.test(digits)) {
    throw new Error(`TradingView CSV row ${rowNumber} has an invalid exchange date.`)
  }
  const date = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`
  const parsed = new Date(`${date}T00:00:00Z`)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error(`TradingView CSV row ${rowNumber} has a non-calendar exchange date.`)
  }
  return date
}

export function importTradingViewOracleRows(
  rows: readonly (readonly string[])[],
  args: { symbol: string; from: string; to: string },
): TradingViewOracleImport {
  const headers = rows[0]
  if (!headers) throw new Error('TradingView CSV has no header row.')

  const exchangeDateColumn = findRequiredColumn(headers, TRADINGVIEW_ORACLE_COLUMNS.exchangeDate)
  const confirmedColumn = findRequiredColumn(headers, TRADINGVIEW_ORACLE_COLUMNS.confirmed)
  const regularSessionColumn = findRequiredColumn(headers, TRADINGVIEW_ORACLE_COLUMNS.regularSession)
  const timeframeColumns = new Map(CLOSE_TIMEFRAMES.map((timeframe) => [
    timeframe,
    findRequiredColumn(headers, TRADINGVIEW_ORACLE_COLUMNS.timeframes[timeframe]),
  ]))

  const observations: TradingViewOracleObservation[] = []
  const seenDates = new Set<string>()
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index]
    const rowNumber = index + 1
    const date = parseExchangeDate(row[exchangeDateColumn] ?? '', rowNumber)
    if (date < args.from || date > args.to) continue
    if (!parseFlag(row[confirmedColumn] ?? '', TRADINGVIEW_ORACLE_COLUMNS.confirmed, rowNumber)) continue
    if (!parseFlag(row[regularSessionColumn] ?? '', TRADINGVIEW_ORACLE_COLUMNS.regularSession, rowNumber)) {
      throw new Error(`TradingView CSV row ${rowNumber} is not from the regular exchange session.`)
    }
    if (seenDates.has(date)) throw new Error(`TradingView CSV contains duplicate exchange date ${date}.`)
    seenDates.add(date)

    observations.push({
      date,
      expectedCloseTimeframes: CLOSE_TIMEFRAMES.filter((timeframe) => parseFlag(
        row[timeframeColumns.get(timeframe)!] ?? '',
        TRADINGVIEW_ORACLE_COLUMNS.timeframes[timeframe],
        rowNumber,
      )),
    })
  }

  observations.sort((left, right) => left.date.localeCompare(right.date))
  if (observations.length === 0) {
    throw new Error(`TradingView CSV contains no confirmed 1D observations in ${args.from}..${args.to}.`)
  }

  return {
    symbol: args.symbol,
    market: 'JP',
    chartTimeframe: '1D',
    exchangeTimezone: 'Asia/Tokyo',
    session: 'regular',
    from: args.from,
    to: args.to,
    observations,
  }
}

export function buildTradingViewMtfFixture(args: {
  oracle: TradingViewOracleImport
  tradingDates: readonly string[]
  anchorDate: string
  coverageFrom: string | null
  coverageTo: string | null
  calendarSource: string
}): TradingViewMtfFixture {
  const tradingDates = [...new Set(args.tradingDates)].sort()
  const ordinalByDate = new Map(tradingDates.map((date, index) => [date, index]))
  const bucketContext = createTimeframeBucketContext(tradingDates)
  const observations = args.oracle.observations.map<TradingViewMtfFixtureObservation>((observation) => {
    const sessionOrdinal = ordinalByDate.get(observation.date)
    const nextTradingDate = getNextTradingDay(observation.date, tradingDates)
    const nextSessionOrdinal = nextTradingDate == null ? null : ordinalByDate.get(nextTradingDate)
    if (sessionOrdinal == null) {
      throw new Error(`TradingView date ${observation.date} is missing from StockBoard market sessions.`)
    }
    if (nextTradingDate == null || nextSessionOrdinal == null) {
      throw new Error(`Next StockBoard market session is unavailable after ${observation.date}.`)
    }
    const tradingYearSessionIndex = bucketContext.tradingYearDateIndex.get(observation.date)
    const nextTradingYearSessionIndex = bucketContext.tradingYearDateIndex.get(nextTradingDate)
    const tradingYearWeekIndex = bucketContext.tradingYearWeekIndex.get(observation.date)
    const nextTradingYearWeekIndex = bucketContext.tradingYearWeekIndex.get(nextTradingDate)
    if (
      tradingYearSessionIndex == null
      || nextTradingYearSessionIndex == null
      || tradingYearWeekIndex == null
      || nextTradingYearWeekIndex == null
    ) {
      throw new Error(`TradingView bucket context is unavailable for ${observation.date}.`)
    }
    return {
      ...observation,
      nextTradingDate,
      sessionOrdinal,
      nextSessionOrdinal,
      tradingYearSessionIndex,
      nextTradingYearSessionIndex,
      tradingYearWeekIndex,
      nextTradingYearWeekIndex,
    }
  })

  const fixture: TradingViewMtfFixture = {
    schemaVersion: 2,
    status: 'NOT_VALIDATED',
    oracle: {
      symbol: args.oracle.symbol,
      market: args.oracle.market,
      chartTimeframe: args.oracle.chartTimeframe,
      exchangeTimezone: args.oracle.exchangeTimezone,
      session: args.oracle.session,
      from: args.oracle.from,
      to: args.oracle.to,
    },
    sessionContext: {
      anchorDate: args.anchorDate,
      coverageFrom: args.coverageFrom,
      coverageTo: args.coverageTo,
      calendarSource: args.calendarSource,
    },
    observations,
  }
  fixture.status = compareTradingViewMtfFixture(fixture).result
  return fixture
}

function fixtureContext(fixture: TradingViewMtfFixture): TimeframeBucketContext {
  const tradingDateIndex = new Map<string, number>()
  const tradingYearDateIndex = new Map<string, number>()
  const tradingYearWeekIndex = new Map<string, number>()
  for (const observation of fixture.observations) {
    const existing = tradingDateIndex.get(observation.date)
    const nextExisting = tradingDateIndex.get(observation.nextTradingDate)
    if (existing != null && existing !== observation.sessionOrdinal) {
      throw new Error(`Fixture has conflicting session ordinal for ${observation.date}.`)
    }
    if (nextExisting != null && nextExisting !== observation.nextSessionOrdinal) {
      throw new Error(`Fixture has conflicting session ordinal for ${observation.nextTradingDate}.`)
    }
    tradingDateIndex.set(observation.date, observation.sessionOrdinal)
    tradingDateIndex.set(observation.nextTradingDate, observation.nextSessionOrdinal)
    tradingYearDateIndex.set(observation.date, observation.tradingYearSessionIndex)
    tradingYearDateIndex.set(observation.nextTradingDate, observation.nextTradingYearSessionIndex)
    tradingYearWeekIndex.set(observation.date, observation.tradingYearWeekIndex)
    tradingYearWeekIndex.set(observation.nextTradingDate, observation.nextTradingYearWeekIndex)
  }
  return {
    tradingDateIndex,
    tradingYearDateIndex,
    tradingYearWeekIndex,
    anchorDate: fixture.sessionContext?.anchorDate ?? [...tradingDateIndex.keys()].sort()[0] ?? null,
  }
}

export function compareTradingViewMtfFixture(fixture: TradingViewMtfFixture): TradingViewParityReport {
  if (
    fixture.schemaVersion !== 2
    || fixture.observations.length === 0
    || fixture.oracle == null
    || fixture.sessionContext == null
  ) {
    return emptyParityReport()
  }

  const context = fixtureContext(fixture)
  const mismatches: TradingViewParityMismatch[] = []
  const results = new Map(CLOSE_TIMEFRAMES.map((timeframe) => [timeframe, {
    timeframe,
    expectedCloses: 0,
    actualCloses: 0,
    mismatches: 0,
  } satisfies TradingViewTimeframeResult]))
  let october30: TradingViewParityReport['october30'] = {
    status: 'NOT_IN_ORACLE_PERIOD',
    tradingView: null,
    stockBoard: null,
  }

  for (const observation of fixture.observations) {
    const actualCloseTimeframes = getCloseTimeframes(
      observation.date,
      observation.nextTradingDate,
      context,
    )
    const expected = new Set(observation.expectedCloseTimeframes)
    const actual = new Set(actualCloseTimeframes)
    for (const timeframe of CLOSE_TIMEFRAMES) {
      const timeframeResult = results.get(timeframe)!
      const tradingViewExpected = expected.has(timeframe)
      const stockBoardActual = actual.has(timeframe)
      if (tradingViewExpected) timeframeResult.expectedCloses += 1
      if (stockBoardActual) timeframeResult.actualCloses += 1
      if (tradingViewExpected !== stockBoardActual) {
        timeframeResult.mismatches += 1
        mismatches.push({ date: observation.date, timeframe, tradingViewExpected, stockBoardActual })
      }
    }
    if (observation.date === '2026-10-30') {
      october30 = {
        status: 'COMPARED',
        tradingView: [...observation.expectedCloseTimeframes],
        stockBoard: actualCloseTimeframes,
      }
    }
  }

  return {
    result: mismatches.length === 0 ? 'PASS' : 'FAIL',
    symbol: fixture.oracle.symbol,
    period: { from: fixture.oracle.from, to: fixture.oracle.to },
    session: `${fixture.oracle.exchangeTimezone} / ${fixture.oracle.session} / ${fixture.oracle.chartTimeframe}`,
    totalDatesCompared: fixture.observations.length,
    totalTfDateComparisons: fixture.observations.length * CLOSE_TIMEFRAMES.length,
    totalMismatches: mismatches.length,
    timeframes: CLOSE_TIMEFRAMES.map((timeframe) => results.get(timeframe)!),
    mismatches,
    october30,
  }
}

export function emptyParityReport(): TradingViewParityReport {
  return {
    result: 'NOT_VALIDATED',
    symbol: null,
    period: null,
    session: null,
    totalDatesCompared: 0,
    totalTfDateComparisons: 0,
    totalMismatches: 0,
    timeframes: CLOSE_TIMEFRAMES.map((timeframe) => ({
      timeframe,
      expectedCloses: 0,
      actualCloses: 0,
      mismatches: 0,
    })),
    mismatches: [],
    october30: { status: 'NOT_IN_ORACLE_PERIOD', tradingView: null, stockBoard: null },
  }
}
