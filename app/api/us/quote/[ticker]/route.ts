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
        { error: 'us_quote_not_found', ticker },
        { status: 404 },
      )
    }
    return NextResponse.json(quote)
  } catch (error) {
    console.error('US quote API error:', error)
    return NextResponse.json(
      { error: 'us_quote_failed' },
      { status: 500 },
    )
  }
}
