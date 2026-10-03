import { NextRequest, NextResponse } from 'next/server'
import { getMlSectorRankings, type MlDirectionFilter } from '@/lib/queries/ml-insights'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

function sectorType(value: string | null): '17' | '33' | 'all' {
  return value === '17' || value === '33' ? value : 'all'
}

function direction(value: string | null): MlDirectionFilter {
  return value === 'up' || value === 'down' || value === 'both' ? value : 'both'
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const result = await getMlSectorRankings({
      sectorType: sectorType(searchParams.get('sectorType')),
      direction: direction(searchParams.get('direction')),
      date: searchParams.get('date')?.trim() || null,
      limit: Math.min(1000, Math.max(1, Number(searchParams.get('limit') ?? 300))),
    })
    return NextResponse.json({
      asOfDate: result.asOfDate,
      count: result.rows.length,
      rankings: result.rows,
    })
  } catch (error) {
    console.error('ML sector rankings API error:', error)
    return NextResponse.json(
      { error: 'ML sector rankings failed', message: (error as Error).message },
      { status: 500 },
    )
  }
}
