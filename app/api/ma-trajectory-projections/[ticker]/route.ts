import { NextRequest, NextResponse } from 'next/server'
import { normalizeMaTrajectoryHorizon, type MaTrajectoryMarket } from '@/lib/ma-trajectory/core'
import { readMaTrajectoryProjection } from '@/lib/ma-trajectory/shadow-store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 15

function normalizeMarket(value: string | null): MaTrajectoryMarket {
  return value?.trim().toUpperCase() === 'US' ? 'US' : 'JP'
}

function parseAsOfDate(value: string | null): string | null {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ ticker: string }> },
) {
  try {
    const { ticker } = await context.params
    const market = normalizeMarket(request.nextUrl.searchParams.get('market'))
    const horizon = normalizeMaTrajectoryHorizon(request.nextUrl.searchParams.get('horizon'))
    const asOfDate = parseAsOfDate(request.nextUrl.searchParams.get('date'))
    const projection = await readMaTrajectoryProjection({ market, ticker, horizon, asOfDate })
    return NextResponse.json(projection, {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    console.error('MA trajectory projection API error:', error)
    return NextResponse.json(
      { ok: false, error: 'ma_trajectory_projection_failed' },
      { status: 500 },
    )
  }
}
