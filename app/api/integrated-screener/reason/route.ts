import { NextRequest, NextResponse } from 'next/server'
import { SCREENING_METRIC_MAP, type ScreeningCondition, type ScreeningMetricKey } from '@/lib/integrated-screener'
import { getScreenerReason } from '@/lib/server/integrated-screener-reason'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

function parseConditions(value: unknown): ScreeningCondition[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is ScreeningCondition => {
    if (!item || typeof item !== 'object') return false
    const condition = item as Partial<ScreeningCondition>
    if (typeof condition.id !== 'string' || typeof condition.metric !== 'string' || typeof condition.operator !== 'string') return false
    const definition = SCREENING_METRIC_MAP.get(condition.metric as ScreeningMetricKey)
    return Boolean(definition?.operators.includes(condition.operator as ScreeningCondition['operator']))
  }).slice(0, 40)
}

export async function POST(request: NextRequest) {
  const startedAt = Date.now()
  try {
    const body = await request.json() as Record<string, unknown>
    const ticker = typeof body.ticker === 'string' ? body.ticker.trim() : ''
    if (!/^\d{4}[A-Z]?$/.test(ticker)) {
      return NextResponse.json({ error: 'Invalid ticker', message: '有効な日本株コードを指定してください。' }, { status: 400 })
    }
    const result = await getScreenerReason({
      ticker,
      asOf: typeof body.asOf === 'string' ? body.asOf : null,
      conditions: parseConditions(body.conditions),
    })
    if (!result) return NextResponse.json({ error: 'Not found', message: '対象銘柄のServingデータが見つかりません。' }, { status: 404 })
    return NextResponse.json(result, {
      headers: {
        'Cache-Control': 'private, max-age=0, must-revalidate',
        'Server-Timing': `screener-reason;dur=${Date.now() - startedAt}`,
      },
    })
  } catch (error) {
    console.error('[integrated-screener-reason]', error)
    return NextResponse.json({ error: 'Reason generation failed', message: error instanceof Error ? error.message : String(error) }, { status: 500 })
  }
}
