import { NextRequest, NextResponse } from 'next/server'
import { getUsBacktestDates, isUsBacktestHorizon } from '@/lib/server/us-backtest'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function GET(request: NextRequest) {
  const horizon = Number(request.nextUrl.searchParams.get('horizon') ?? 40)
  if (!isUsBacktestHorizon(horizon)) {
    return NextResponse.json({ error: 'invalid_horizon' }, { status: 400 })
  }
  try {
    const result = await getUsBacktestDates(horizon)
    return NextResponse.json({ ...result, source: 'US_ANALYTICS_SERVING', pit: true }, {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    console.error('US backtest dates failed:', error)
    return NextResponse.json({ error: 'us_backtest_dates_failed' }, { status: 500 })
  }
}
