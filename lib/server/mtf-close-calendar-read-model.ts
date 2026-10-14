import { execAll } from '@/lib/db/client'
import {
  addIsoDays,
  buildCloseCalendar,
  isIsoDate,
  type CloseCalendarResult,
} from '@/lib/mtf-close-calendar'
import { getJpTradingDates } from '@/lib/server/jp-market-calendar'
import { getUsTradingDates, isUsMarketTradingDate } from '@/lib/server/us-data-freshness'

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

type CloseCalendarMarket = 'JP' | 'US'

const sessionCache = new Map<CloseCalendarMarket, { loadedAt: number; dates: string[] }>()

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

async function loadActualMarketDates(market: CloseCalendarMarket): Promise<string[]> {
  const now = Date.now()
  const cached = sessionCache.get(market)
  if (cached && now - cached.loadedAt < CACHE_TTL_MS) return cached.dates
  const rows = market === 'JP'
    ? await execAll<DateRow>(`SELECT DISTINCT date
       FROM ohlcv_daily
      WHERE date IS NOT NULL
      ORDER BY date ASC`)
    : await execAll<DateRow>(`WITH RECURSIVE trading_dates(date) AS (
         SELECT MIN(date)
           FROM market_ohlcv_daily INDEXED BY market_ohlcv_market_date_idx
          WHERE market = 'US' AND date >= '${SESSION_ANCHOR}'
         UNION ALL
         SELECT (
           SELECT MIN(date)
             FROM market_ohlcv_daily INDEXED BY market_ohlcv_market_date_idx
            WHERE market = 'US' AND date > trading_dates.date
         )
           FROM trading_dates
          WHERE date IS NOT NULL
       )
       SELECT date
         FROM trading_dates
        WHERE date IS NOT NULL
        ORDER BY date ASC`)
  const dates = rows
    .map((row) => row.date)
    .filter((date) => isIsoDate(date) && (market === 'JP' || isUsMarketTradingDate(date)))
  sessionCache.set(market, { loadedAt: now, dates })
  return dates
}

async function loadMarketSessionCoverageInternal(
  market: CloseCalendarMarket,
  from: string,
  to: string,
): Promise<MarketSessionCoverage> {
  const through = addIsoDays(to, 14)
  const projectedDates = market === 'JP' ? getJpTradingDates : getUsTradingDates
  const hybridSource = market === 'JP'
    ? 'MARKET_OHLCV_AND_JP_HOLIDAY_RULES'
    : 'MARKET_OHLCV_AND_US_HOLIDAY_RULES'
  const fallbackSource = market === 'JP' ? 'JP_HOLIDAY_RULES_ONLY' : 'US_HOLIDAY_RULES_ONLY'

  try {
    const actualDates = await loadActualMarketDates(market)
    if (actualDates.length === 0) throw new Error(`${market} OHLCV has no market dates`)
    const actualFrom = actualDates[0]
    const actualTo = actualDates.at(-1) ?? actualFrom
    const prefix = actualFrom > SESSION_ANCHOR
      ? projectedDates(SESSION_ANCHOR, addIsoDays(actualFrom, -1))
      : []
    const suffix = through > actualTo
      ? projectedDates(addIsoDays(actualTo, 1), through)
      : []

    return {
      tradingDates: [...prefix, ...actualDates, ...suffix],
      actualCoverageFrom: actualFrom,
      actualCoverageTo: actualTo,
      calendarSource: hybridSource,
      warnings: [],
    }
  } catch (error) {
    console.warn(`MTF close calendar: ${market} OHLCV dates unavailable; using holiday rules.`, {
      errorClass: error instanceof Error ? error.name : 'UnknownError',
    })
    return {
      tradingDates: projectedDates(SESSION_ANCHOR, through),
      actualCoverageFrom: null,
      actualCoverageTo: null,
      calendarSource: fallbackSource,
      warnings: ['MARKET_OHLCV_DATES_UNAVAILABLE'],
    }
  }
}

export async function loadJpMarketSessionCoverage(from: string, to: string): Promise<MarketSessionCoverage> {
  validateRange(from, to)
  return loadMarketSessionCoverageInternal('JP', from, to)
}

export async function loadUsMarketSessionCoverage(from: string, to: string): Promise<MarketSessionCoverage> {
  validateRange(from, to)
  return loadMarketSessionCoverageInternal('US', from, to)
}

export async function loadJpMarketSessionCoverageForValidation(
  from: string,
  to: string,
): Promise<MarketSessionCoverage> {
  validateRange(from, to, null)
  return loadMarketSessionCoverageInternal('JP', from, to)
}

export async function loadUsMarketSessionCoverageForValidation(
  from: string,
  to: string,
): Promise<MarketSessionCoverage> {
  validateRange(from, to, null)
  return loadMarketSessionCoverageInternal('US', from, to)
}

export function parseMtfCloseCalendarQuery(searchParams: URLSearchParams): {
  market: CloseCalendarMarket
  from: string
  to: string
} {
  const market = (searchParams.get('market') ?? 'JP').toUpperCase()
  const from = searchParams.get('from') ?? ''
  const to = searchParams.get('to') ?? ''
  if (market !== 'JP' && market !== 'US') {
    throw new MtfCloseCalendarRequestError('Unsupported market. Use JP or US.')
  }
  validateRange(from, to)
  return { market, from, to }
}

export async function getMtfCloseCalendar(
  input: { market: CloseCalendarMarket; from: string; to: string },
  loadSessions: MarketSessionLoader = input.market === 'JP'
    ? loadJpMarketSessionCoverage
    : loadUsMarketSessionCoverage,
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
