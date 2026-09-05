import { NextRequest, NextResponse } from 'next/server'
import {
  DEFAULT_SCREENING_COLUMNS,
  SCREENING_METRIC_MAP,
  type ScreeningCondition,
  type ScreeningMetricKey,
} from '@/lib/integrated-screener'
import type { SavedScreenStateContract } from '@/lib/screener-evaluation'
import {
  listSavedScreeningDefinitions,
  upsertSavedScreeningDefinition,
} from '@/lib/server/saved-screening-evaluations'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

function parseConditions(value: unknown): ScreeningCondition[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is ScreeningCondition => {
    if (!item || typeof item !== 'object') return false
    const condition = item as Partial<ScreeningCondition>
    if (typeof condition.id !== 'string' || typeof condition.metric !== 'string' || typeof condition.operator !== 'string') return false
    return Boolean(SCREENING_METRIC_MAP.get(condition.metric as ScreeningMetricKey)?.operators.includes(condition.operator as ScreeningCondition['operator']))
  }).slice(0, 40)
}

function parseState(value: unknown): SavedScreenStateContract | null {
  if (!value || typeof value !== 'object') return null
  const state = value as Partial<SavedScreenStateContract>
  const sort = typeof state.sort === 'string' && SCREENING_METRIC_MAP.has(state.sort as ScreeningMetricKey)
    ? state.sort as ScreeningMetricKey
    : 'marketCap'
  const columns = Array.isArray(state.columns)
    ? state.columns.filter((metric): metric is ScreeningMetricKey => typeof metric === 'string' && SCREENING_METRIC_MAP.has(metric as ScreeningMetricKey))
    : DEFAULT_SCREENING_COLUMNS
  return {
    asOf: typeof state.asOf === 'string' ? state.asOf : '',
    conditions: parseConditions(state.conditions),
    sort,
    direction: state.direction === 'asc' ? 'asc' : 'desc',
    columns: columns.length > 0 ? columns : DEFAULT_SCREENING_COLUMNS,
    page: 0,
  }
}

export async function GET() {
  try {
    return NextResponse.json({ contractVersion: 'saved-screen-definitions-v1', definitions: await listSavedScreeningDefinitions() }, {
      headers: { 'Cache-Control': 'private, max-age=0, must-revalidate' },
    })
  } catch (error) {
    console.error('[saved-screening-list]', error)
    return NextResponse.json({ error: 'saved_screen_list_failed', message: error instanceof Error ? error.message : String(error) }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const startedAt = Date.now()
  try {
    const body = await request.json() as Record<string, unknown>
    const state = parseState(body.state)
    if (!state || typeof body.name !== 'string' || !body.name.trim()) {
      return NextResponse.json({ error: 'invalid_saved_screen', message: '条件名と有効な条件を指定してください。' }, { status: 400 })
    }
    const definition = await upsertSavedScreeningDefinition({
      id: typeof body.id === 'string' ? body.id : null,
      name: body.name,
      state,
      evaluate: body.evaluate !== false,
      evaluateAsOf: typeof body.asOf === 'string' ? body.asOf : null,
    })
    return NextResponse.json({ contractVersion: 'saved-screen-definitions-v1', definition }, {
      headers: { 'Cache-Control': 'no-store', 'Server-Timing': `saved-screen;dur=${Date.now() - startedAt}` },
    })
  } catch (error) {
    console.error('[saved-screening-save]', error)
    return NextResponse.json({ error: 'saved_screen_save_failed', message: error instanceof Error ? error.message : String(error) }, { status: 500 })
  }
}
