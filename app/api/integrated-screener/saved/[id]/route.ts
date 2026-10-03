import { NextRequest, NextResponse } from 'next/server'
import type { SavedScreenEvaluationStatus } from '@/lib/screener-evaluation'
import {
  deactivateSavedScreeningDefinition,
  evaluateSavedScreeningDefinition,
  getSavedScreeningEvaluationDetail,
} from '@/lib/server/saved-screening-evaluations'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

type RouteContext = { params: Promise<{ id: string }> }

export async function GET(request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const statusValue = request.nextUrl.searchParams.get('status')?.toUpperCase()
  const status = statusValue && ['NEW', 'STAY', 'OUT'].includes(statusValue)
    ? statusValue as SavedScreenEvaluationStatus
    : 'NEW'
  try {
    const detail = await getSavedScreeningEvaluationDetail({
      definitionId: id,
      evaluationId: request.nextUrl.searchParams.get('evaluation_id'),
      status,
      limit: Number(request.nextUrl.searchParams.get('limit') ?? 50),
      offset: Number(request.nextUrl.searchParams.get('offset') ?? 0),
    })
    if (!detail) return NextResponse.json({ error: 'saved_screen_evaluation_not_found', message: '評価履歴がありません。' }, { status: 404 })
    return NextResponse.json(detail, { headers: { 'Cache-Control': 'private, max-age=0, must-revalidate' } })
  } catch (error) {
    console.error('[saved-screening-detail]', error)
    return NextResponse.json({ error: 'saved_screen_evaluation_failed', message: error instanceof Error ? error.message : String(error) }, { status: 500 })
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  try {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>
    const evaluation = await evaluateSavedScreeningDefinition(id, typeof body.asOf === 'string' ? body.asOf : null)
    return NextResponse.json({ contractVersion: 'saved-screen-evaluation-v1', evaluation }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('[saved-screening-evaluate]', error)
    return NextResponse.json({ error: 'saved_screen_evaluate_failed', message: error instanceof Error ? error.message : String(error) }, { status: 500 })
  }
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  try {
    await deactivateSavedScreeningDefinition(id)
    return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    return NextResponse.json({ error: 'saved_screen_delete_failed', message: error instanceof Error ? error.message : String(error) }, { status: 500 })
  }
}
