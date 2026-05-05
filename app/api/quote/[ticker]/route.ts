// app/api/quote/[ticker]/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { getQuote } from '@/lib/yahoo-finance'

export const revalidate = 60

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ ticker: string }> }
) {
  try {
    const { ticker } = await params
    const quote = await getQuote(decodeURIComponent(ticker))
    return NextResponse.json(quote)
  } catch (error) {
    console.error('Quote API error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch quote', message: (error as Error).message },
      { status: 500 }
    )
  }
}
