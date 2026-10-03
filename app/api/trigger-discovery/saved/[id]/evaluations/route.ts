import { NextResponse } from 'next/server'
import { listSavedTriggerEvaluations } from '@/lib/server/trigger-evaluations'
import { SavedTriggerNotFoundError } from '@/lib/server/saved-trigger-definitions'
import { TRIGGER_EVALUATION_CONTRACT_VERSION } from '@/lib/trigger-evaluation'
import { SavedTriggerValidationError } from '@/lib/trigger-definition'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

type RouteContext = { params: Promise<{ id: string }> }

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params
    return NextResponse.json({
      contractVersion: TRIGGER_EVALUATION_CONTRACT_VERSION,
      evaluations: await listSavedTriggerEvaluations(id),
    }, { headers: { 'Cache-Control': 'private, max-age=0, must-revalidate' } })
  } catch (error) {
    if (error instanceof SavedTriggerValidationError) {
      return NextResponse.json({ error: 'invalid_saved_trigger', message: error.message }, { status: 400 })
    }
    if (error instanceof SavedTriggerNotFoundError) {
      return NextResponse.json({ error: 'saved_trigger_not_found', message: error.message }, { status: 404 })
    }
    console.error('[trigger-discovery/evaluations:list]', error)
    return NextResponse.json({ error: 'trigger_evaluation_list_failed', message: '評価履歴を取得できませんでした。' }, { status: 500 })
  }
}
