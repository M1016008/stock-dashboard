// app/api/history/[ticker]/route.ts
// 履歴 OHLCV を「ローカル DB の ohlcv_daily」から返す (Phase 3.5 で Yahoo から置換)。
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db/client'
import { ohlcvDaily } from '@/lib/db/schema'
import { and, asc, eq, gte } from 'drizzle-orm'
import type { OHLCV } from '@/types/stock'
import { parseTimeframeSpec, resampleOhlcv, specToIntervalCode } from '@/lib/timeframes'
import { loadManualOhlcvRows } from '@/lib/manual-ohlcv'
import { decodePathSegment } from '@/lib/url-path'

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
    const period = searchParams.get('period') ?? '1y'
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

    const fromDate = period === 'all'
      ? null
      : new Date(Date.now() - safeDays * 86_400_000).toISOString().slice(0, 10)
    let source: 'jquants' | 'manual_ohlcv' = 'jquants'
    const rows = await db
      .select()
      .from(ohlcvDaily)
      .where(fromDate === null
        ? eq(ohlcvDaily.ticker, ticker)
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
      history = await loadManualOhlcvRows(ticker, { fromDate })
      if (history.length > 0) {
        source = 'manual_ohlcv'
      }
    }

    const output = timeframeSpec ? resampleOhlcv(history, timeframeSpec) : history

    if (searchParams.get('meta') === '1') {
      return NextResponse.json({
        ticker,
        period,
        timeframe: timeframeSpec ?? { timeframe: 'day', multiplier: 1 },
        interval: timeframeSpec ? specToIntervalCode(timeframeSpec) : 'D',
        source,
        count: output.length,
        rows: output,
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
