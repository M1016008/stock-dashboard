import { execAll } from '@/lib/db/client'
import {
  addIsoDays,
  buildCloseCalendar,
  isIsoDate,
  type CloseCalendarResult,
} from '@/lib/mtf-close-calendar'
import { getJpTradingDates } from '@/lib/server/jp-market-calendar'

const CACHE_TTL_MS = 5 * 60 * 1000
const SESSION_ANCHOR = '2000-01-04'
const MAX_RANGE_DAYS = 370

type DateRow = { date: string }

export interface MarketSessionCoverage {
  tradingDates: string[]
  actualCoverageFrom: string | null
  actualCoverageTo: string | null
  calendarSource: CloseCalendarResult['calendarSource']
  warnings: string[]
}

export type MarketSessionLoader = (from: string, to: string) => Promise<MarketSessionCoverage>

export class MtfCloseCalendarRequestError extends Error {
  constructor(message: string, readonly status = 400, readonly code = 'INVALID_REQUEST') {
    super(message)
    this.name = 'MtfCloseCalendarRequestError'
  }
}

let sessionCache: { loadedAt: number; dates: string[] } | null = null

function daysBetween(from: string, to: string): number {
  return Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}

function validateRange(from: string, to: string, maxRangeDays: number | null = MAX_RANGE_DAYS) {
  if (!isIsoDate(from) || !isIsoDate(to)) {
    throw new MtfCloseCalendarRequestError('from and to must be valid ISO dates (YYYY-MM-DD).')
  }
  if (from > to) throw new MtfCloseCalendarRequestError('from must be on or before to.')
  if (maxRangeDays != null && daysBetween(from, to) > maxRangeDays) {
    throw new MtfCloseCalendarRequestError(`Date range must not exceed ${maxRangeDays} days.`)
  }
  if (from < SESSION_ANCHOR) {
    throw new MtfCloseCalendarRequestError(
      `Calendar coverage starts at ${SESSION_ANCHOR}.`,
      422,
      'CALENDAR_COVERAGE_UNAVAILABLE',
    )
  }
}

async function loadActualMarketDates(): Promise<string[]> {
  const now = Date.now()
  if (sessionCache && now - sessionCache.loadedAt < CACHE_TTL_MS) return sessionCache.dates
  const rows = await execAll<DateRow>(
    `SELECT DISTINCT date
       FROM ohlcv_daily
      WHERE date IS NOT NULL
      ORDER BY date ASC`,
  )
  const dates = rows.map((row) => row.date).filter(isIsoDate)
  sessionCache = { loadedAt: now, dates }
  return dates
}

async function loadJpMarketSessionCoverageInternal(from: string, to: string): Promise<MarketSessionCoverage> {
  const through = addIsoDays(to, 14)

  try {
    const actualDates = await loadActualMarketDates()
    if (actualDates.length === 0) throw new Error('ohlcv_daily has no market dates')
    const actualFrom = actualDates[0]
    const actualTo = actualDates.at(-1) ?? actualFrom
    const prefix = actualFrom > SESSION_ANCHOR
      ? getJpTradingDates(SESSION_ANCHOR, addIsoDays(actualFrom, -1))
      : []
    const suffix = through > actualTo
      ? getJpTradingDates(addIsoDays(actualTo, 1), through)
      : []

    return {
      tradingDates: [...prefix, ...actualDates, ...suffix],
      actualCoverageFrom: actualFrom,
      actualCoverageTo: actualTo,
      calendarSource: 'MARKET_OHLCV_AND_JP_HOLIDAY_RULES',
      warnings: [],
    }
  } catch (error) {
    console.warn('MTF close calendar: market OHLCV dates unavailable; using JP calendar rules.', {
      errorClass: error instanceof Error ? error.name : 'UnknownError',
    })
    return {
      tradingDates: getJpTradingDates(SESSION_ANCHOR, through),
      actualCoverageFrom: null,
      actualCoverageTo: null,
      calendarSource: 'JP_HOLIDAY_RULES_ONLY',
      warnings: ['MARKET_OHLCV_DATES_UNAVAILABLE'],
    }
  }
}

export async function loadJpMarketSessionCoverage(from: string, to: string): Promise<MarketSessionCoverage> {
  validateRange(from, to)
  return loadJpMarketSessionCoverageInternal(from, to)
}

export async function loadJpMarketSessionCoverageForValidation(
  from: string,
  to: string,
): Promise<MarketSessionCoverage> {
  validateRange(from, to, null)
  return loadJpMarketSessionCoverageInternal(from, to)
}

export function parseMtfCloseCalendarQuery(searchParams: URLSearchParams): {
  market: 'JP'
  from: string
  to: string
} {
  const market = (searchParams.get('market') ?? 'JP').toUpperCase()
  const from = searchParams.get('from') ?? ''
  const to = searchParams.get('to') ?? ''
  if (market !== 'JP') {
    throw new MtfCloseCalendarRequestError('Unsupported market. MTF Close Calendar currently supports JP.')
  }
  validateRange(from, to)
  return { market: 'JP', from, to }
}

export async function getMtfCloseCalendar(
  input: { market: 'JP'; from: string; to: string },
  loadSessions: MarketSessionLoader = loadJpMarketSessionCoverage,
): Promise<CloseCalendarResult> {
  validateRange(input.from, input.to)
  const coverage = await loadSessions(input.from, input.to)
  return buildCloseCalendar({
    ...input,
    tradingDates: coverage.tradingDates,
    actualCoverageFrom: coverage.actualCoverageFrom,
    actualCoverageTo: coverage.actualCoverageTo,
    calendarSource: coverage.calendarSource,
    warnings: coverage.warnings,
  })
}
