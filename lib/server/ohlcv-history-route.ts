// lib/server/ohlcv-history-route.ts
// JP (/api/history) と US (/api/us/history) の OHLCV 履歴ルートで共通の
// クエリ解釈と応答組み立て (足変換 → 2年足レジストリ / meta / 配列)。
// 銘柄行の取得・価格基準・エラー応答・ログは各ルートに残す。
import { NextResponse } from 'next/server'
import type { OHLCV } from '@/types/stock'
import {
  parseTimeframeSpec,
  requiresTradingSessionCalendar,
  resampleOhlcv,
  resampleOhlcvWithTradingSessions,
  specToIntervalCode,
  type TimeframeSpec,
} from '@/lib/timeframes'
import { twoYearBlockStartYear, twoYearPeriod, type TwoYearMarket } from '@/lib/two-year-candles'
import { buildTwoYearLineRegistry } from '@/lib/two-year-line-registry'

export const HISTORY_PERIOD_DAYS: Readonly<Record<string, number>> = {
  '1mo': 30,
  '3mo': 90,
  '6mo': 180,
  '1y':  365,
  '2y':  730,
  '5y':  1825,
  '10y': 3650,
}
const HISTORY_PERIOD_KEYS = [...Object.keys(HISTORY_PERIOD_DAYS), 'all']

export interface OhlcvHistoryQuery {
  searchParams: URLSearchParams
  wantsTwoYearRegistry: boolean
  requestedAsOfDate: string | null
  period: string
  /** undefined only when period === 'all' */
  days: number | undefined
  timeframeSpec: TimeframeSpec | null
}

/** Validates in the order asOfDate → timeframe → period; returns a 400 response on the first failure. */
export function parseOhlcvHistoryQuery(requestUrl: string): OhlcvHistoryQuery | NextResponse {
  const { searchParams } = new URL(requestUrl)
  const wantsTwoYearRegistry = searchParams.get('twoYearRegistry') === '1'
  const requestedAsOfDate = parseAsOfDate(searchParams.get('asOfDate'))
  if (searchParams.has('asOfDate') && !requestedAsOfDate) {
    return NextResponse.json({ error: 'invalid_as_of_date' }, { status: 400 })
  }
  const period = wantsTwoYearRegistry ? 'all' : searchParams.get('period') ?? '1y'
  const timeframeSpec = parseTimeframeSpec({
    interval: searchParams.get('interval'),
    timeframe: searchParams.get('timeframe'),
    multiplier: searchParams.get('multiplier'),
  })
  const wantsTimeframe = searchParams.has('interval') || searchParams.has('timeframe') || searchParams.has('multiplier')
  if (wantsTimeframe && !timeframeSpec) {
    return NextResponse.json(
      { error: 'Invalid timeframe. Use interval=D|2D|3D|W|2W|3W|M|2M|3M|6M|Y|2Y|3Y|5Y or timeframe=day|week|month|year&multiplier=1..12.' },
      { status: 400 },
    )
  }
  const days = HISTORY_PERIOD_DAYS[period]
  if (!days && period !== 'all') {
    return NextResponse.json(
      { error: `Invalid period. Must be one of: ${HISTORY_PERIOD_KEYS.join(', ')}` },
      { status: 400 },
    )
  }
  return { searchParams, wantsTwoYearRegistry, requestedAsOfDate, period, days, timeframeSpec }
}

export interface OhlcvHistoryResponseOptions {
  query: OhlcvHistoryQuery
  ticker: string
  market: TwoYearMarket
  /** Price-basis-adjusted daily rows for the security. */
  history: OHLCV[]
  priceBasisVersion: string
  /** JP only: emitted in the meta payload between `interval` and `count`. */
  source?: string
  /** Calendar start used by meta when there are no output rows. */
  metaCalendarFallbackFromDate: string | null
  /** Benchmark session dates from `fromDate`, clipped to the requested asOfDate, ascending. */
  loadSessionDates: (fromDate: string) => Promise<string[]>
  /** Latest benchmark session date, clipped to the requested asOfDate. */
  loadLatestSessionDate: () => Promise<string | null>
}

export async function buildOhlcvHistoryResponse(options: OhlcvHistoryResponseOptions): Promise<NextResponse> {
  const { query, ticker, market, history, loadSessionDates, loadLatestSessionDate } = options
  const { searchParams, timeframeSpec } = query

  const timeframeCalendarFromDate = history[0] ? `${history[0].date.slice(0, 4)}-01-01` : null
  const timeframeSessions = timeframeSpec
    && requiresTradingSessionCalendar(timeframeSpec)
    && timeframeCalendarFromDate
    ? await loadSessionDates(timeframeCalendarFromDate)
    : []
  const output = timeframeSpec
    ? requiresTradingSessionCalendar(timeframeSpec)
      ? resampleOhlcvWithTradingSessions(history, timeframeSpec, timeframeSessions)
      : resampleOhlcv(history, timeframeSpec)
    : history

  if (query.wantsTwoYearRegistry) {
    const calendarFromDate = history[0]
      ? twoYearPeriod(twoYearBlockStartYear(history[0].date)).periodStart
      : null
    const exchangeSessions = calendarFromDate ? await loadSessionDates(calendarFromDate) : []
    const marketAsOfDate = (await loadLatestSessionDate()) ?? history.at(-1)?.date ?? null
    if (!marketAsOfDate) {
      return NextResponse.json({ error: 'two_year_registry_unavailable' }, { status: 404 })
    }
    return NextResponse.json(buildTwoYearLineRegistry({
      market,
      securityKey: `${market}:${ticker}`,
      asOfDate: marketAsOfDate,
      priceBasisVersion: options.priceBasisVersion,
      history,
      exchangeSessions,
    }))
  }

  if (searchParams.get('meta') === '1') {
    const wantsCalendar = searchParams.get('calendar') === '1'
    const calendarFromDate = output[0]
      ? twoYearPeriod(twoYearBlockStartYear(output[0].date)).periodStart
      : options.metaCalendarFallbackFromDate
    const marketSessions = wantsCalendar && calendarFromDate ? await loadSessionDates(calendarFromDate) : []
    const marketAsOfDate = wantsCalendar ? await loadLatestSessionDate() : undefined
    return NextResponse.json({
      ticker,
      period: query.period,
      timeframe: timeframeSpec ?? { timeframe: 'day', multiplier: 1 },
      interval: timeframeSpec ? specToIntervalCode(timeframeSpec) : 'D',
      ...(options.source !== undefined ? { source: options.source } : {}),
      count: output.length,
      rows: output,
      ...(wantsCalendar ? { marketSessions, marketAsOfDate } : {}),
    })
  }

  return NextResponse.json(output)
}

function parseAsOfDate(value: string | null): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const parsed = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : null
}
