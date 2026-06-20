import { NextResponse } from 'next/server'
import { getCachedMarketMovers } from '@/lib/queries/dashboard-cache'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

export async function GET(request: Request) {
  try {
    const date = new URL(request.url).searchParams.get('date')
    const requestedDate = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null
    const rows = await getCachedMarketMovers(requestedDate)
    return NextResponse.json(rows)
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 500 },
    )
  }
}
