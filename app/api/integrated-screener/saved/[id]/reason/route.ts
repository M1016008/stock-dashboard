import { NextRequest, NextResponse } from 'next/server'
import { getSavedScreeningChangeReason } from '@/lib/server/saved-screening-evaluations'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

type RouteContext = { params: Promise<{ id: string }> }

export async function GET(request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const evaluationId = request.nextUrl.searchParams.get('evaluation_id')?.trim() ?? ''
  const ticker = request.nextUrl.searchParams.get('ticker')?.trim() ?? ''
  if (!evaluationId || !/^\d{4}[A-Z]?$/.test(ticker)) {
    return NextResponse.json({ error: 'invalid_change_reason_request', message: '評価IDと銘柄コードを指定してください。' }, { status: 400 })
  }
  try {
    const reason = await getSavedScreeningChangeReason({ definitionId: id, evaluationId, ticker })
    if (!reason) return NextResponse.json({ error: 'change_reason_not_found', message: 'NEW/OUTの変化理由がありません。' }, { status: 404 })
    return NextResponse.json(reason, { headers: { 'Cache-Control': 'private, max-age=60, stale-while-revalidate=300' } })
  } catch (error) {
    console.error('[saved-screening-change-reason]', error)
    return NextResponse.json({ error: 'change_reason_failed', message: error instanceof Error ? error.message : String(error) }, { status: 500 })
  }
}
