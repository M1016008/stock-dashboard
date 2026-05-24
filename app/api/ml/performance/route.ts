import { NextRequest, NextResponse } from 'next/server'
import { getMlPerformance, type MlDirectionFilter } from '@/lib/queries/ml-insights'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

function direction(value: string | null): MlDirectionFilter {
  return value === 'up' || value === 'down' || value === 'both' ? value : 'both'
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const horizon = Number(searchParams.get('horizonDays') ?? searchParams.get('horizon') ?? '')
    const result = await getMlPerformance({
      direction: direction(searchParams.get('direction')),
      horizonDays: Number.isFinite(horizon) && horizon > 0 ? horizon : null,
      sectorType: searchParams.get('sectorType')?.trim() || null,
      date: searchParams.get('date')?.trim() || null,
      limit: Math.min(150, Math.max(1, Number(searchParams.get('limit') ?? 40))),
    })
    return NextResponse.json({
      asOfDate: result.asOfDate,
      count: result.rows.length,
      performance: result.rows,
    })
  } catch (error) {
    console.error('ML performance API error:', error)
    return NextResponse.json(
      { error: 'ML performance failed', message: (error as Error).message },
      { status: 500 },
    )
  }
}
