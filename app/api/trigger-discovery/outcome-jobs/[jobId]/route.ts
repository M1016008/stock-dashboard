import { NextResponse } from 'next/server'
import {
  cancelOutcomeAnalysisJob,
  getOutcomeAnalysisJob,
} from '@/lib/server/trigger-discovery-outcome-jobs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

type RouteContext = { params: Promise<{ jobId: string }> }

export async function GET(_request: Request, context: RouteContext) {
  try {
    const job = await getOutcomeAnalysisJob((await context.params).jobId)
    if (!job) return NextResponse.json({ error: 'outcome_analysis_job_not_found' }, { status: 404 })
    return NextResponse.json(job, { headers: { 'Cache-Control': 'private, no-store, max-age=0' } })
  } catch (error) {
    console.error('[trigger-discovery/outcome-jobs:get]', error)
    return NextResponse.json({ error: 'outcome_analysis_job_unavailable' }, { status: 500 })
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const job = await cancelOutcomeAnalysisJob((await context.params).jobId)
    if (!job) return NextResponse.json({ error: 'outcome_analysis_job_not_found' }, { status: 404 })
    return NextResponse.json(job, { headers: { 'Cache-Control': 'private, no-store, max-age=0' } })
  } catch (error) {
    console.error('[trigger-discovery/outcome-jobs:cancel]', error)
    return NextResponse.json({ error: 'outcome_analysis_job_cancel_failed' }, { status: 500 })
  }
}
