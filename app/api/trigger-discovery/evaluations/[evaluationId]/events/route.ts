import { NextResponse } from 'next/server'
import {
  TriggerLifecycleEvaluationNotFoundError,
  getTriggerLifecycleEvents,
} from '@/lib/server/trigger-lifecycle'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

type RouteContext = { params: Promise<{ evaluationId: string }> }

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { evaluationId } = await context.params
    return NextResponse.json(await getTriggerLifecycleEvents(evaluationId), {
      headers: { 'Cache-Control': 'private, max-age=0, must-revalidate' },
    })
  } catch (error) {
    if (error instanceof TriggerLifecycleEvaluationNotFoundError) {
      return NextResponse.json({ error: 'trigger_evaluation_not_found', message: error.message }, { status: 404 })
    }
    console.error('[trigger-discovery/evaluations:events]', error)
    return NextResponse.json({ error: 'trigger_lifecycle_read_failed', message: 'Lifecycle差分を取得できませんでした。' }, { status: 500 })
  }
}
