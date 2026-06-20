import { NextRequest, NextResponse } from 'next/server'
import { updateTradeScenario } from '@/lib/trade-scenarios/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type RouteContext = {
  params: Promise<{ id: string }>
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params
    const body = await request.json()
    const scenario = await updateTradeScenario(id, body)
    if (!scenario) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 })
    }
    return NextResponse.json({ ok: true, scenario })
  } catch (error) {
    console.error('Trade scenarios PATCH error:', error)
    return NextResponse.json(
      { error: 'trade_scenario_update_failed', message: (error as Error).message },
      { status: 400 },
    )
  }
}
