import { NextRequest, NextResponse } from 'next/server'
import { normalizeTickerForMarket } from '@/lib/markets'
import { getUsQuote } from '@/lib/us-market-data'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ ticker: string }> },
) {
  try {
    const { ticker: rawTicker } = await params
    const ticker = normalizeTickerForMarket(rawTicker, 'US')
    const quote = await getUsQuote(ticker)
    if (!quote) {
      return NextResponse.json(
        { error: 'No data', message: `US ticker ${ticker} not found in market_ohlcv_daily` },
        { status: 404 },
      )
    }
    return NextResponse.json(quote)
  } catch (error) {
    console.error('US quote API error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch US quote', message: (error as Error).message },
      { status: 500 },
    )
  }
}
