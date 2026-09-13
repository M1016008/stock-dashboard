import { NextResponse } from 'next/server'
import {
  createOutcomeAnalysisJob,
  TriggerOutcomeInputError,
  TriggerOutcomeSourceError,
} from '@/lib/server/trigger-discovery-outcome-jobs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

type RouteContext = { params: Promise<{ jobId: string }> }

export async function POST(request: Request, context: RouteContext) {
  try {
    const response = await createOutcomeAnalysisJob(
      await request.json(),
      (await context.params).jobId,
    )
    return NextResponse.json(response, {
      status: response.reused && response.status === 'COMPLETED' ? 200 : 202,
      headers: { 'Cache-Control': 'private, no-store, max-age=0' },
    })
  } catch (error) {
    if (error instanceof TriggerOutcomeSourceError) {
      const status = error.code === 'historical_scan_job_not_found'
        ? 404
        : error.code === 'historical_scan_job_result_expired' ? 410 : 409
      return NextResponse.json({ error: error.code }, { status })
    }
    if (error instanceof TriggerOutcomeInputError || error instanceof SyntaxError) {
      return NextResponse.json({
        error: 'invalid_request',
        message: error instanceof SyntaxError ? 'JSON形式が正しくありません。' : (error as Error).message,
      }, { status: 400 })
    }
    console.error('[trigger-discovery/outcomes:start]', error)
    return NextResponse.json({
      error: 'outcome_analysis_job_start_failed',
      message: 'Outcome Analysis Jobを開始できませんでした。',
    }, { status: 500 })
  }
}
