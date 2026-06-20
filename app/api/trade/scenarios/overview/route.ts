import { NextRequest, NextResponse } from 'next/server'
import { getTradeScenarioOverview } from '@/lib/trade-scenarios/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

export async function GET(request: NextRequest) {
  try {
    const limit = Number(request.nextUrl.searchParams.get('limit') ?? 8)
    const overview = await getTradeScenarioOverview(Number.isFinite(limit) ? limit : 8)
    return NextResponse.json({ ok: true, ...overview })
  } catch (error) {
    console.error('Trade scenario overview API error:', error)
    return NextResponse.json(
      { error: 'trade_scenario_overview_failed', message: (error as Error).message },
      { status: 500 },
    )
  }
}
