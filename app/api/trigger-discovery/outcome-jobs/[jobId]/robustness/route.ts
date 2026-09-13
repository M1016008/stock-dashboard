import { NextResponse } from 'next/server'
import {
  getOutcomeRobustness,
  parseOutcomeRobustnessUrl,
  TriggerOutcomeSegmentationInputError,
  TriggerOutcomeSegmentationSourceError,
} from '@/lib/server/trigger-discovery-outcome-robustness'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

type RouteContext = { params: Promise<{ jobId: string }> }

function sourceStatus(error: TriggerOutcomeSegmentationSourceError): number {
  if (error.code === 'outcome_analysis_job_not_found') return 404
  if (error.code === 'outcome_analysis_job_not_completed') return 409
  return 410
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const result = await getOutcomeRobustness({
      outcomeJobId: (await context.params).jobId,
      dimensions: parseOutcomeRobustnessUrl(request.url),
    })
    return NextResponse.json(result, {
      headers: { 'Cache-Control': 'private, no-store, max-age=0' },
    })
  } catch (error) {
    if (error instanceof TriggerOutcomeSegmentationInputError) {
      return NextResponse.json({ error: 'invalid_request', message: error.message }, { status: 400 })
    }
    if (error instanceof TriggerOutcomeSegmentationSourceError) {
      return NextResponse.json({ error: error.code }, { status: sourceStatus(error) })
    }
    console.error('[trigger-discovery/outcome-robustness:get]', error)
    return NextResponse.json({ error: 'outcome_robustness_unavailable' }, { status: 500 })
  }
}
