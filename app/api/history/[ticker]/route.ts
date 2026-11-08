// app/api/history/[ticker]/route.ts
// 履歴 OHLCV を「ローカル DB の ohlcv_daily」から返す (Phase 3.5 で Yahoo から置換)。
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db/client'
import { ohlcvDaily } from '@/lib/db/schema'
import { and, asc, desc, eq, gte, lte } from 'drizzle-orm'
import type { OHLCV } from '@/types/stock'
import { loadManualOhlcvRows } from '@/lib/manual-ohlcv'
import { decodePathSegment } from '@/lib/url-path'
import { adjustLikelySplitOhlcv } from '@/lib/physical-momentum'
import {
  HISTORY_PERIOD_DAYS,
  buildOhlcvHistoryResponse,
  parseOhlcvHistoryQuery,
} from '@/lib/server/ohlcv-history-route'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ ticker: string }> },
) {
  try {
    const { ticker: rawTicker } = await params
    const ticker = decodePathSegment(rawTicker).replace(/\.T$/i, '')
    const query = parseOhlcvHistoryQuery(request.url)
    if (query instanceof NextResponse) return query
    const { period, requestedAsOfDate } = query
    const safeDays = query.days ?? HISTORY_PERIOD_DAYS['1y']

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
    return await buildOhlcvHistoryResponse({
      query,
      ticker,
      market: 'JP',
      history: adjustedHistory,
      priceBasisVersion: source === 'jquants' ? 'jp-split-normalized-v1' : 'jp-manual-v1',
      source,
      metaCalendarFallbackFromDate: fromDate,
      loadSessionDates: async (calendarFromDate) => (await db
        .select({ date: ohlcvDaily.date })
        .from(ohlcvDaily)
        .where(requestedAsOfDate
          ? and(eq(ohlcvDaily.ticker, '1306'), gte(ohlcvDaily.date, calendarFromDate), lte(ohlcvDaily.date, requestedAsOfDate))
          : and(eq(ohlcvDaily.ticker, '1306'), gte(ohlcvDaily.date, calendarFromDate)))
        .orderBy(asc(ohlcvDaily.date))).map((row) => row.date),
      loadLatestSessionDate: async () => (await db
        .select({ date: ohlcvDaily.date })
        .from(ohlcvDaily)
        .where(requestedAsOfDate
          ? and(eq(ohlcvDaily.ticker, '1306'), lte(ohlcvDaily.date, requestedAsOfDate))
          : eq(ohlcvDaily.ticker, '1306'))
        .orderBy(desc(ohlcvDaily.date))
        .limit(1))[0]?.date ?? null,
    })
  } catch (error) {
    console.error('History API error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch history', message: (error as Error).message },
      { status: 500 },
    )
  }
}
