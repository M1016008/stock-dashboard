// app/api/fundamentals/[ticker]/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { getFundamentals } from '@/lib/yahoo-finance'

export const revalidate = 3600

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ ticker: string }> }
) {
  try {
    const { ticker } = await params
    const fundamentals = await getFundamentals(decodeURIComponent(ticker))
    return NextResponse.json(fundamentals)
  } catch (error) {
    console.error('Fundamentals API error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch fundamentals', message: (error as Error).message },
      { status: 500 }
    )
  }
}
