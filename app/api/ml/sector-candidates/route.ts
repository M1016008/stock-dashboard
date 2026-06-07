import { NextRequest, NextResponse } from 'next/server'
import { getMlSectorCandidates } from '@/lib/queries/ml-insights'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

function sectorType(value: string | null): '17' | '33' {
  return value === '33' ? '33' : '17'
}

function direction(value: string | null): 'up' | 'down' {
  return value === 'down' ? 'down' : 'up'
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const sectorName = searchParams.get('sectorName')?.trim() ?? ''
    if (!sectorName) {
      return NextResponse.json(
        { error: 'sectorName is required', candidates: [], count: 0 },
        { status: 400 },
      )
    }
    const result = await getMlSectorCandidates({
      sectorType: sectorType(searchParams.get('sectorType')),
      sectorName,
      direction: direction(searchParams.get('direction')),
      date: searchParams.get('date')?.trim() || null,
      horizonDays: Number(searchParams.get('horizonDays') ?? process.env.ML_SIMILAR_PHYSICS_HORIZON ?? 10),
      limit: Math.min(500, Math.max(1, Number(searchParams.get('limit') ?? 200))),
    })
    return NextResponse.json({
      asOfDate: result.asOfDate,
      count: result.rows.length,
      candidates: result.rows,
    })
  } catch (error) {
    console.error('ML sector candidates API error:', error)
    return NextResponse.json(
      { error: 'ML sector candidates failed', message: (error as Error).message },
      { status: 500 },
    )
  }
}
