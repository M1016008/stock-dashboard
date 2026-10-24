import { NextRequest, NextResponse } from 'next/server'
import { execAll } from '@/lib/db/client'
import { normalizeTickerForMarket } from '@/lib/markets'
import type { OHLCV } from '@/types/stock'
import {
  parseTimeframeSpec,
  requiresTradingSessionCalendar,
  resampleOhlcv,
  resampleOhlcvWithTradingSessions,
  specToIntervalCode,
} from '@/lib/timeframes'
import { US_ADJUSTED_PRICE_BASIS, toAdjustedUsOhlcvRows, type UsRawOhlcvRow } from '@/lib/us-adjusted-ohlcv'
import { twoYearBlockStartYear, twoYearPeriod } from '@/lib/two-year-candles'
import { buildTwoYearLineRegistry } from '@/lib/two-year-line-registry'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

const PERIOD_DAYS: Record<string, number> = {
  '1mo': 30,
  '3mo': 90,
  '6mo': 180,
  '1y': 365,
  '2y': 730,
  '5y': 1825,
  '10y': 3650,
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ ticker: string }> },
) {
  try {
    const { ticker: rawTicker } = await params
    const ticker = normalizeTickerForMarket(rawTicker, 'US')
    const { searchParams } = new URL(request.url)
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
    const days = PERIOD_DAYS[period]
    if (!days && period !== 'all') {
      return NextResponse.json(
        { error: `Invalid period. Must be one of: ${[...Object.keys(PERIOD_DAYS), 'all'].join(', ')}` },
        { status: 400 },
      )
    }
    const requestedFromDate = requestedAsOfDate && period !== 'all'
      ? new Date(new Date(`${requestedAsOfDate}T00:00:00Z`).getTime() - days * 86_400_000).toISOString().slice(0, 10)
      : null
    const rawRows = await execAll<UsRawOhlcvRow>(
      `
      SELECT
        date, open, high, low, close, volume,
        adj_open AS adjustedOpen,
        adj_high AS adjustedHigh,
        adj_low AS adjustedLow,
        adj_close AS adjustedClose,
        adj_volume AS adjustedVolume
      FROM market_ohlcv_daily
      WHERE market = 'US' AND ticker = ?
        ${period === 'all'
          ? ''
          : requestedFromDate
            ? 'AND date >= ?'
            : `AND date >= date((SELECT MAX(date) FROM market_ohlcv_daily WHERE market = 'US' AND ticker = ?), '-' || ? || ' days')`}
        ${requestedAsOfDate ? 'AND date <= ?' : ''}
      ORDER BY date
      `,
      [
        ticker,
        ...(period === 'all' ? [] : requestedFromDate ? [requestedFromDate] : [ticker, days]),
        ...(requestedAsOfDate ? [requestedAsOfDate] : []),
      ],
    )
    const rows: OHLCV[] = toAdjustedUsOhlcvRows(rawRows)
    const timeframeCalendarFromDate = rows[0] ? `${rows[0].date.slice(0, 4)}-01-01` : null
    const timeframeMarketSessions = timeframeSpec
      && requiresTradingSessionCalendar(timeframeSpec)
      && timeframeCalendarFromDate
      ? (await execAll<{ date: string }>(
          `SELECT date FROM market_ohlcv_daily WHERE market = 'US' AND ticker = 'SPY' AND date >= ? ${requestedAsOfDate ? 'AND date <= ?' : ''} ORDER BY date`,
          [timeframeCalendarFromDate, ...(requestedAsOfDate ? [requestedAsOfDate] : [])],
        )).map((row) => row.date)
      : []
    const output = timeframeSpec
      ? requiresTradingSessionCalendar(timeframeSpec)
        ? resampleOhlcvWithTradingSessions(rows, timeframeSpec, timeframeMarketSessions)
        : resampleOhlcv(rows, timeframeSpec)
      : rows
    if (wantsTwoYearRegistry) {
      const calendarFromDate = rows[0]
        ? twoYearPeriod(twoYearBlockStartYear(rows[0].date)).periodStart
        : null
      const marketSessions = calendarFromDate
        ? (await execAll<{ date: string }>(
            `SELECT date FROM market_ohlcv_daily WHERE market = 'US' AND ticker = 'SPY' AND date >= ? ${requestedAsOfDate ? 'AND date <= ?' : ''} ORDER BY date`,
            [calendarFromDate, ...(requestedAsOfDate ? [requestedAsOfDate] : [])],
          )).map((row) => row.date)
        : []
      const marketAsOfDate = (await execAll<{ date: string }>(
        `SELECT date FROM market_ohlcv_daily WHERE market = 'US' AND ticker = 'SPY' ${requestedAsOfDate ? 'AND date <= ?' : ''} ORDER BY date DESC LIMIT 1`,
        requestedAsOfDate ? [requestedAsOfDate] : [],
      ))[0]?.date ?? rows.at(-1)?.date ?? null
      if (!marketAsOfDate) {
        return NextResponse.json({ error: 'two_year_registry_unavailable' }, { status: 404 })
      }
      return NextResponse.json(buildTwoYearLineRegistry({
        market: 'US',
        securityKey: `US:${ticker}`,
        asOfDate: marketAsOfDate,
        priceBasisVersion: US_ADJUSTED_PRICE_BASIS,
        history: rows,
        exchangeSessions: marketSessions,
      }))
    }
    if (searchParams.get('meta') === '1') {
      const wantsCalendar = searchParams.get('calendar') === '1'
      const calendarFromDate = output[0]
        ? twoYearPeriod(twoYearBlockStartYear(output[0].date)).periodStart
        : null
      const marketSessions = wantsCalendar && calendarFromDate
        ? (await execAll<{ date: string }>(
            `SELECT date FROM market_ohlcv_daily WHERE market = 'US' AND ticker = 'SPY' AND date >= ? ${requestedAsOfDate ? 'AND date <= ?' : ''} ORDER BY date`,
            [calendarFromDate, ...(requestedAsOfDate ? [requestedAsOfDate] : [])],
          )).map((row) => row.date)
        : []
      const marketAsOfDate = wantsCalendar
        ? (await execAll<{ date: string }>(
            `SELECT date FROM market_ohlcv_daily WHERE market = 'US' AND ticker = 'SPY' ${requestedAsOfDate ? 'AND date <= ?' : ''} ORDER BY date DESC LIMIT 1`,
            requestedAsOfDate ? [requestedAsOfDate] : [],
          ))[0]?.date ?? null
        : undefined
      return NextResponse.json({
        ticker,
        period,
        timeframe: timeframeSpec ?? { timeframe: 'day', multiplier: 1 },
        interval: timeframeSpec ? specToIntervalCode(timeframeSpec) : 'D',
        count: output.length,
        rows: output,
        ...(wantsCalendar ? { marketSessions, marketAsOfDate } : {}),
      })
    }
    return NextResponse.json(output)
  } catch (error) {
    console.error('US history API error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch US history', message: (error as Error).message },
      { status: 500 },
    )
  }
}

function parseAsOfDate(value: string | null): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const parsed = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : null
}
