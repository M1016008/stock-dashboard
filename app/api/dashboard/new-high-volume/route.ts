import { NextResponse } from 'next/server'
import { getCachedMarketMovers } from '@/lib/queries/dashboard-cache'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

export async function GET() {
  try {
    const rows = await getCachedMarketMovers()
    return NextResponse.json(rows)
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 500 },
    )
  }
}
