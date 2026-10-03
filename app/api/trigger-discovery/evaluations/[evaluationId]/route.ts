import { NextRequest, NextResponse } from 'next/server'
import {
  TriggerEvaluationNotFoundError,
  getTriggerEvaluationDetail,
} from '@/lib/server/trigger-evaluations'
import { SavedTriggerValidationError } from '@/lib/trigger-definition'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

type RouteContext = { params: Promise<{ evaluationId: string }> }

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { evaluationId } = await context.params
    const response = await getTriggerEvaluationDetail({
      evaluationId,
      limit: Number(request.nextUrl.searchParams.get('limit') ?? 100),
      offset: Number(request.nextUrl.searchParams.get('offset') ?? 0),
    })
    return NextResponse.json(response, {
      headers: { 'Cache-Control': 'private, max-age=0, must-revalidate' },
    })
  } catch (error) {
    if (error instanceof SavedTriggerValidationError) {
      return NextResponse.json({ error: 'invalid_trigger_evaluation', message: error.message }, { status: 400 })
    }
    if (error instanceof TriggerEvaluationNotFoundError) {
      return NextResponse.json({ error: 'trigger_evaluation_not_found', message: error.message }, { status: 404 })
    }
    console.error('[trigger-discovery/evaluations:detail]', error)
    return NextResponse.json({ error: 'trigger_evaluation_read_failed', message: '評価Snapshotを取得できませんでした。' }, { status: 500 })
  }
}
