import { NextRequest, NextResponse } from 'next/server'
import { queryIntegratedScreener } from '@/lib/server/integrated-screener-serving'
import { SCREENING_METRIC_MAP, type ScreeningCondition, type ScreeningMetricKey } from '@/lib/integrated-screener'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

function parseConditions(value: unknown): ScreeningCondition[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is ScreeningCondition => {
    if (!item || typeof item !== 'object') return false
    const condition = item as Partial<ScreeningCondition>
    return typeof condition.id === 'string'
      && typeof condition.metric === 'string'
      && SCREENING_METRIC_MAP.has(condition.metric as ScreeningMetricKey)
      && typeof condition.operator === 'string'
  }).slice(0, 40)
}
export async function POST(request: NextRequest) {
  const startedAt = Date.now()
  try {
    const body = await request.json() as Record<string, unknown>
    const sort = typeof body.sort === 'string' && SCREENING_METRIC_MAP.has(body.sort as ScreeningMetricKey)
      ? body.sort as ScreeningMetricKey
      : null
    const result = await queryIntegratedScreener({
      asOf: typeof body.asOf === 'string' ? body.asOf : null,
      conditions: parseConditions(body.conditions),
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
    console.error('[integrated-screener]', error)
    return NextResponse.json({ error: 'Integrated screener failed', message: error instanceof Error ? error.message : String(error) }, { status: 500 })
  }
}
