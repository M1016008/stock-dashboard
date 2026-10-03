import { NextResponse } from 'next/server'
import { getCommodityBoard } from '@/lib/queries/commodities'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'
export const maxDuration = 30

export async function GET() {
  try {
    const board = await getCommodityBoard()
    return NextResponse.json(board)
  } catch (error) {
    console.error('Commodity API error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch commodities', message: (error as Error).message },
      { status: 500 },
    )
  }
}
