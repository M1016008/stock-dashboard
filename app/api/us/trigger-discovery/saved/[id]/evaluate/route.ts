import { NextRequest, NextResponse } from 'next/server'
import { TriggerDiscoveryInputError } from '@/lib/server/trigger-discovery-read-model'
import {
  TriggerEvaluationInProgressError,
  evaluateSavedTriggerDefinition,
} from '@/lib/server/trigger-evaluations'
import { SavedTriggerNotFoundError } from '@/lib/server/saved-trigger-definitions'
import { SavedTriggerValidationError } from '@/lib/trigger-definition'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'
export const maxDuration = 120
type RouteContext = { params: Promise<{ id: string }> }

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params
    const body = await request.json() as Record<string, unknown>
    if (typeof body.requestedAsOf !== 'string') throw new SavedTriggerValidationError('requestedAsOf is required')
    return NextResponse.json(await evaluateSavedTriggerDefinition(id, body.requestedAsOf, { market: 'US' }), {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof SavedTriggerValidationError || error instanceof TriggerDiscoveryInputError) {
      return NextResponse.json({ error: 'invalid_trigger_evaluation', message: error instanceof Error ? error.message : 'Invalid request' }, { status: 400 })
    }
    if (error instanceof SavedTriggerNotFoundError) {
      return NextResponse.json({ error: 'saved_trigger_not_found', message: error.message }, { status: 404 })
    }
    if (error instanceof TriggerEvaluationInProgressError) {
      return NextResponse.json({ error: 'trigger_evaluation_in_progress', message: error.message }, { status: 409 })
    }
    console.error('[us/trigger-discovery/evaluate]', error)
    return NextResponse.json({ error: 'trigger_evaluation_failed', message: 'Trigger評価を完了できませんでした。' }, { status: 500 })
  }
}
