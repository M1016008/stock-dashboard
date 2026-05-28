import { NextRequest, NextResponse } from 'next/server'
import { execAll } from '@/lib/db/client'
import { normalizeTickerForMarket } from '@/lib/markets'
import type { OHLCV } from '@/types/stock'

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
    const period = searchParams.get('period') ?? '1y'
    const days = PERIOD_DAYS[period]
    if (!days && period !== 'all') {
      return NextResponse.json(
        { error: `Invalid period. Must be one of: ${[...Object.keys(PERIOD_DAYS), 'all'].join(', ')}` },
        { status: 400 },
      )
    }
    const rows = await execAll<OHLCV>(
      `
      SELECT date, open, high, low, close, volume, adj_close AS adjustedClose
      FROM market_ohlcv_daily
      WHERE market = 'US' AND ticker = ?
        ${period === 'all' ? '' : `AND date >= date((SELECT MAX(date) FROM market_ohlcv_daily WHERE market = 'US' AND ticker = ?), '-' || ? || ' days')`}
      ORDER BY date
      `,
      period === 'all' ? [ticker] : [ticker, ticker, days],
    )
    return NextResponse.json(rows)
  } catch (error) {
    console.error('US history API error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch US history', message: (error as Error).message },
      { status: 500 },
    )
  }
}
