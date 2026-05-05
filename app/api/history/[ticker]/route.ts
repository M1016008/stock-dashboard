// app/api/history/[ticker]/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { getHistory } from '@/lib/yahoo-finance'

export const revalidate = 3600

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ ticker: string }> }
) {
  try {
    const { ticker } = await params
    const { searchParams } = new URL(request.url)
    const period = (searchParams.get('period') ?? '1y') as '1mo' | '3mo' | '6mo' | '1y' | '2y'

    const validPeriods = ['1mo', '3mo', '6mo', '1y', '2y']
    if (!validPeriods.includes(period)) {
      return NextResponse.json(
        { error: 'Invalid period. Must be one of: 1mo, 3mo, 6mo, 1y, 2y' },
        { status: 400 }
      )
    }

    const history = await getHistory(decodeURIComponent(ticker), period)
    return NextResponse.json(history)
  } catch (error) {
    console.error('History API error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch history', message: (error as Error).message },
      { status: 500 }
    )
  }
}
