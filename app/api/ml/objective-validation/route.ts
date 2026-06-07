import { NextRequest, NextResponse } from 'next/server'
import {
  getMlObjectiveValidation,
  type MlDirectionFilter,
  type MlObjectiveVariant,
} from '@/lib/queries/ml-insights'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

function direction(value: string | null): MlDirectionFilter {
  return value === 'up' || value === 'down' || value === 'both' ? value : 'both'
}

function split(value: string | null): 'validation' | 'test' | 'all' {
  return value === 'validation' || value === 'test' ? value : 'all'
}

function variant(value: string | null): MlObjectiveVariant {
  return value === 'baseline' || value === 'all' ? value : 'enhanced'
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const horizon = Number(searchParams.get('horizonDays') ?? searchParams.get('horizon') ?? '')
    const result = await getMlObjectiveValidation({
      direction: direction(searchParams.get('direction')),
      split: split(searchParams.get('split')),
      variant: variant(searchParams.get('variant')),
      horizonDays: Number.isFinite(horizon) && horizon > 0 ? horizon : null,
      limit: Math.min(500, Math.max(1, Number(searchParams.get('limit') ?? 80))),
    })
    return NextResponse.json({
      count: result.rows.length,
      validations: result.rows,
    })
  } catch (error) {
    console.error('ML objective validation API error:', error)
    return NextResponse.json(
      { error: 'ML objective validation failed', message: (error as Error).message },
      { status: 500 },
    )
  }
}
