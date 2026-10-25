import { NextRequest, NextResponse } from 'next/server'
import { queryIntegratedScreener } from '@/lib/server/integrated-screener-serving'
import {
  SCREENING_METRIC_MAP,
  ScreeningConditionValidationError,
  parseScreeningConditions,
  type ScreeningMetricKey,
} from '@/lib/integrated-screener'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

export async function POST(request: NextRequest) {
  const startedAt = Date.now()
  try {
    const body = await request.json() as Record<string, unknown>
    const sort = typeof body.sort === 'string' && SCREENING_METRIC_MAP.has(body.sort as ScreeningMetricKey)
      ? body.sort as ScreeningMetricKey
      : null
    const result = await queryIntegratedScreener({
      asOf: typeof body.asOf === 'string' ? body.asOf : null,
      conditions: parseScreeningConditions(body.conditions),
      sort,
      direction: body.direction === 'asc' ? 'asc' : 'desc',
      limit: Number(body.limit ?? 100),
      offset: Number(body.offset ?? 0),
    })
    return NextResponse.json(result, {
      headers: {
        'Cache-Control': 'private, max-age=0, must-revalidate',
        'Server-Timing': `integrated-screener;dur=${Date.now() - startedAt}`,
      },
    })
  } catch (error) {
    if (error instanceof ScreeningConditionValidationError) {
      return NextResponse.json(
        { error: 'Invalid screening conditions', message: error.message },
        { status: 400 },
      )
    }
    console.error('[integrated-screener]', error)
    return NextResponse.json({ error: 'Integrated screener failed', message: error instanceof Error ? error.message : String(error) }, { status: 500 })
  }
}
