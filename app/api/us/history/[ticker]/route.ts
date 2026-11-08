import { NextRequest, NextResponse } from 'next/server'
import { execAll } from '@/lib/db/client'
import { normalizeTickerForMarket } from '@/lib/markets'
import type { OHLCV } from '@/types/stock'
import { US_ADJUSTED_PRICE_BASIS, toAdjustedUsOhlcvRows, type UsRawOhlcvRow } from '@/lib/us-adjusted-ohlcv'
import { buildOhlcvHistoryResponse, parseOhlcvHistoryQuery } from '@/lib/server/ohlcv-history-route'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ ticker: string }> },
) {
  try {
    const { ticker: rawTicker } = await params
    const ticker = normalizeTickerForMarket(rawTicker, 'US')
    const query = parseOhlcvHistoryQuery(request.url)
    if (query instanceof NextResponse) return query
    const { period, requestedAsOfDate } = query
    // only read when period !== 'all', where the parser guarantees a value
    const days = query.days ?? 0
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
    return await buildOhlcvHistoryResponse({
      query,
      ticker,
      market: 'US',
      history: rows,
      priceBasisVersion: US_ADJUSTED_PRICE_BASIS,
      metaCalendarFallbackFromDate: null,
      loadSessionDates: async (calendarFromDate) => (await execAll<{ date: string }>(
        `SELECT date FROM market_ohlcv_daily WHERE market = 'US' AND ticker = 'SPY' AND date >= ? ${requestedAsOfDate ? 'AND date <= ?' : ''} ORDER BY date`,
        [calendarFromDate, ...(requestedAsOfDate ? [requestedAsOfDate] : [])],
      )).map((row) => row.date),
      loadLatestSessionDate: async () => (await execAll<{ date: string }>(
        `SELECT date FROM market_ohlcv_daily WHERE market = 'US' AND ticker = 'SPY' ${requestedAsOfDate ? 'AND date <= ?' : ''} ORDER BY date DESC LIMIT 1`,
        requestedAsOfDate ? [requestedAsOfDate] : [],
      ))[0]?.date ?? null,
    })
  } catch (error) {
    console.error('US history API error:', error)
    return NextResponse.json(
      { error: 'us_history_failed' },
      { status: 500 },
    )
  }
}
