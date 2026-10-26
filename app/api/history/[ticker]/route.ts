// app/api/history/[ticker]/route.ts
// 履歴 OHLCV を「ローカル DB の ohlcv_daily」から返す (Phase 3.5 で Yahoo から置換)。
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db/client'
import { ohlcvDaily } from '@/lib/db/schema'
import { and, asc, desc, eq, gte, lte } from 'drizzle-orm'
import type { OHLCV } from '@/types/stock'
import {
  parseTimeframeSpec,
  requiresTradingSessionCalendar,
  resampleOhlcv,
  resampleOhlcvWithTradingSessions,
  specToIntervalCode,
} from '@/lib/timeframes'
import { loadManualOhlcvRows } from '@/lib/manual-ohlcv'
import { decodePathSegment } from '@/lib/url-path'
import { adjustLikelySplitOhlcv } from '@/lib/physical-momentum'
import { twoYearBlockStartYear, twoYearPeriod } from '@/lib/two-year-candles'
import { buildTwoYearLineRegistry } from '@/lib/two-year-line-registry'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

const PERIOD_DAYS: Record<string, number> = {
  '1mo': 30,
  '3mo': 90,
  '6mo': 180,
  '1y':  365,
  '2y':  730,
  '5y':  1825,
  '10y': 3650,
}
const PERIOD_KEYS = [...Object.keys(PERIOD_DAYS), 'all']

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ ticker: string }> },
) {
  try {
    const { ticker: rawTicker } = await params
    const ticker = decodePathSegment(rawTicker).replace(/\.T$/i, '')
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
        { error: `Invalid period. Must be one of: ${PERIOD_KEYS.join(', ')}` },
        { status: 400 },
      )
    }
    const safeDays = days ?? PERIOD_DAYS['1y']

    const periodAnchor = requestedAsOfDate ? new Date(`${requestedAsOfDate}T00:00:00Z`).getTime() : Date.now()
    const fromDate = period === 'all'
      ? null
      : new Date(periodAnchor - safeDays * 86_400_000).toISOString().slice(0, 10)
    let source: 'jquants' | 'manual_ohlcv' = 'jquants'
    const rows = await db
      .select()
      .from(ohlcvDaily)
      .where(fromDate === null
        ? requestedAsOfDate
          ? and(eq(ohlcvDaily.ticker, ticker), lte(ohlcvDaily.date, requestedAsOfDate))
          : eq(ohlcvDaily.ticker, ticker)
        : requestedAsOfDate
          ? and(eq(ohlcvDaily.ticker, ticker), gte(ohlcvDaily.date, fromDate), lte(ohlcvDaily.date, requestedAsOfDate))
          : and(eq(ohlcvDaily.ticker, ticker), gte(ohlcvDaily.date, fromDate)))
      .orderBy(asc(ohlcvDaily.date))

    let history: OHLCV[] = rows.map(r => ({
      date:   r.date,
      open:   r.open,
      high:   r.high,
      low:    r.low,
      close:  r.close,
      volume: r.volume,
    }))
    if (history.length === 0) {
      history = await loadManualOhlcvRows(ticker, { fromDate, asOfDate: requestedAsOfDate })
      if (history.length > 0) {
        source = 'manual_ohlcv'
      }
    }

    const adjustedHistory = source === 'jquants' ? adjustLikelySplitOhlcv(history) : history
    const timeframeCalendarFromDate = adjustedHistory[0]
      ? `${adjustedHistory[0].date.slice(0, 4)}-01-01`
      : null
    const timeframeMarketRows = timeframeSpec
      && requiresTradingSessionCalendar(timeframeSpec)
      && timeframeCalendarFromDate
      ? await db
          .select({ date: ohlcvDaily.date })
          .from(ohlcvDaily)
          .where(requestedAsOfDate
            ? and(eq(ohlcvDaily.ticker, '1306'), gte(ohlcvDaily.date, timeframeCalendarFromDate), lte(ohlcvDaily.date, requestedAsOfDate))
            : and(eq(ohlcvDaily.ticker, '1306'), gte(ohlcvDaily.date, timeframeCalendarFromDate)))
          .orderBy(asc(ohlcvDaily.date))
      : []
    const output = timeframeSpec
      ? requiresTradingSessionCalendar(timeframeSpec)
        ? resampleOhlcvWithTradingSessions(adjustedHistory, timeframeSpec, timeframeMarketRows.map((row) => row.date))
        : resampleOhlcv(adjustedHistory, timeframeSpec)
      : adjustedHistory

    if (wantsTwoYearRegistry) {
      const calendarFromDate = adjustedHistory[0]
        ? twoYearPeriod(twoYearBlockStartYear(adjustedHistory[0].date)).periodStart
        : null
      const marketRows = calendarFromDate
        ? await db
            .select({ date: ohlcvDaily.date })
            .from(ohlcvDaily)
            .where(requestedAsOfDate
              ? and(eq(ohlcvDaily.ticker, '1306'), gte(ohlcvDaily.date, calendarFromDate), lte(ohlcvDaily.date, requestedAsOfDate))
              : and(eq(ohlcvDaily.ticker, '1306'), gte(ohlcvDaily.date, calendarFromDate)))
            .orderBy(asc(ohlcvDaily.date))
        : []
      const marketAsOfDate = (await db
        .select({ date: ohlcvDaily.date })
        .from(ohlcvDaily)
        .where(requestedAsOfDate
          ? and(eq(ohlcvDaily.ticker, '1306'), lte(ohlcvDaily.date, requestedAsOfDate))
          : eq(ohlcvDaily.ticker, '1306'))
        .orderBy(desc(ohlcvDaily.date))
        .limit(1))[0]?.date ?? adjustedHistory.at(-1)?.date ?? null
      if (!marketAsOfDate) {
        return NextResponse.json({ error: 'two_year_registry_unavailable' }, { status: 404 })
      }
      return NextResponse.json(buildTwoYearLineRegistry({
        market: 'JP',
        securityKey: `JP:${ticker}`,
        asOfDate: marketAsOfDate,
        priceBasisVersion: source === 'jquants' ? 'jp-split-normalized-v1' : 'jp-manual-v1',
        history: adjustedHistory,
        exchangeSessions: marketRows.map((row) => row.date),
      }))
    }

    if (searchParams.get('meta') === '1') {
      const wantsCalendar = searchParams.get('calendar') === '1'
      const calendarFromDate = output[0]
        ? twoYearPeriod(twoYearBlockStartYear(output[0].date)).periodStart
        : fromDate
      const marketRows = wantsCalendar && calendarFromDate
        ? await db
            .select({ date: ohlcvDaily.date })
            .from(ohlcvDaily)
            .where(requestedAsOfDate
              ? and(eq(ohlcvDaily.ticker, '1306'), gte(ohlcvDaily.date, calendarFromDate), lte(ohlcvDaily.date, requestedAsOfDate))
              : and(eq(ohlcvDaily.ticker, '1306'), gte(ohlcvDaily.date, calendarFromDate)))
            .orderBy(asc(ohlcvDaily.date))
        : []
      const marketAsOfDate = wantsCalendar
        ? (await db
            .select({ date: ohlcvDaily.date })
            .from(ohlcvDaily)
            .where(requestedAsOfDate
              ? and(eq(ohlcvDaily.ticker, '1306'), lte(ohlcvDaily.date, requestedAsOfDate))
              : eq(ohlcvDaily.ticker, '1306'))
            .orderBy(desc(ohlcvDaily.date))
            .limit(1))[0]?.date ?? null
        : undefined
      return NextResponse.json({
        ticker,
        period,
        timeframe: timeframeSpec ?? { timeframe: 'day', multiplier: 1 },
        interval: timeframeSpec ? specToIntervalCode(timeframeSpec) : 'D',
        source,
        count: output.length,
        rows: output,
        ...(wantsCalendar ? { marketSessions: marketRows.map((row) => row.date), marketAsOfDate } : {}),
      })
    }

    return NextResponse.json(output)
  } catch (error) {
    console.error('History API error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch history', message: (error as Error).message },
      { status: 500 },
    )
  }
}

function parseAsOfDate(value: string | null): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const parsed = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : null
}
