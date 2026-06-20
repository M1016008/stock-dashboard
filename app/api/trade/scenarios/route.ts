import { NextRequest, NextResponse } from 'next/server'
import { createTradeScenario, listTradeScenarios } from '@/lib/trade-scenarios/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

export async function GET(request: NextRequest) {
  try {
    const ticker = request.nextUrl.searchParams.get('ticker')
    if (!ticker) {
      return NextResponse.json({ error: 'ticker_required' }, { status: 400 })
    }
    const market = request.nextUrl.searchParams.get('market') ?? 'JP'
    const includeArchived = request.nextUrl.searchParams.get('includeArchived') === '1'
    const scenarios = await listTradeScenarios({ ticker, market, includeArchived })
    return NextResponse.json({ ok: true, scenarios })
  } catch (error) {
    console.error('Trade scenarios GET error:', error)
    return NextResponse.json(
      { error: 'trade_scenarios_failed', message: (error as Error).message },
      { status: 500 },
    )
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const scenario = await createTradeScenario(body)
    return NextResponse.json({ ok: true, scenario })
  } catch (error) {
    console.error('Trade scenarios POST error:', error)
    return NextResponse.json(
      { error: 'trade_scenario_create_failed', message: (error as Error).message },
      { status: 400 },
    )
  }
}
