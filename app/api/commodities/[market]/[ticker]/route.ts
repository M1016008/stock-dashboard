import { NextRequest, NextResponse } from 'next/server'
import { getCommodityDetail } from '@/lib/queries/commodities'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'
export const maxDuration = 30

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ market: string; ticker: string }> },
) {
  try {
    const { market, ticker } = await params
    const detail = await getCommodityDetail(market, ticker)
    if (!detail) {
      return NextResponse.json(
        { error: 'Not found', message: `commodity ${market}/${ticker} is not in catalog` },
        { status: 404 },
      )
    }
    return NextResponse.json(detail)
  } catch (error) {
    console.error('Commodity detail API error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch commodity detail', message: (error as Error).message },
      { status: 500 },
    )
  }
}
