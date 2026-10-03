import { NextRequest, NextResponse } from 'next/server'
import { getSectorEtfDetail } from '@/lib/queries/sector-etfs'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'
export const maxDuration = 30

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ ticker: string }> },
) {
  try {
    const { ticker } = await params
    const detail = await getSectorEtfDetail(ticker)
    if (!detail) {
      return NextResponse.json(
        { error: 'Not found', message: `sector ETF ${ticker} is not in catalog` },
        { status: 404 },
      )
    }
    return NextResponse.json(detail)
  } catch (error) {
    console.error('Sector ETF detail API error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch sector ETF detail', message: (error as Error).message },
      { status: 500 },
    )
  }
}
