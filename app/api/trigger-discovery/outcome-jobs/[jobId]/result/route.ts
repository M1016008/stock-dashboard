import { NextResponse } from 'next/server'
import {
  getOutcomeAnalysisResult,
  parseOutcomeResultQuery,
  TriggerOutcomeInputError,
} from '@/lib/server/trigger-discovery-outcome-jobs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

type RouteContext = { params: Promise<{ jobId: string }> }

export async function GET(request: Request, context: RouteContext) {
  try {
    const result = await getOutcomeAnalysisResult({
      id: (await context.params).jobId,
      query: parseOutcomeResultQuery(request.url),
    })
    if (result === null) return NextResponse.json({ error: 'outcome_analysis_job_not_found' }, { status: 404 })
    if (result === 'NOT_READY') {
      return NextResponse.json({ error: 'outcome_analysis_job_not_completed' }, { status: 409 })
    }
    if (result === 'EXPIRED') {
      return NextResponse.json({ error: 'outcome_analysis_job_result_expired' }, { status: 410 })
    }
    return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store, max-age=0' } })
  } catch (error) {
    if (error instanceof TriggerOutcomeInputError) {
      return NextResponse.json({ error: 'invalid_request', message: error.message }, { status: 400 })
    }
    console.error('[trigger-discovery/outcome-jobs:result]', error)
    return NextResponse.json({ error: 'outcome_analysis_result_unavailable' }, { status: 500 })
  }
}
