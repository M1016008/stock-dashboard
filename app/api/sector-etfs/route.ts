import { NextResponse } from 'next/server'
import { getSectorEtfBoard } from '@/lib/queries/sector-etfs'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'
export const maxDuration = 30

export async function GET() {
  try {
    const board = await getSectorEtfBoard()
    return NextResponse.json(board)
  } catch (error) {
    console.error('Sector ETF API error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch sector ETFs', message: (error as Error).message },
      { status: 500 },
    )
  }
}
