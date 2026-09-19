import { NextResponse } from 'next/server'
import { listRecentCompletedOutcomeJobs } from '@/lib/server/trigger-discovery-outcome-jobs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

export async function GET() {
  try {
    return NextResponse.json({ jobs: await listRecentCompletedOutcomeJobs() }, {
      headers: { 'Cache-Control': 'private, no-store, max-age=0' },
    })
  } catch (error) {
    console.error('[trigger-discovery/outcome-jobs:recent]', error)
    return NextResponse.json({ error: 'outcome_analysis_jobs_unavailable' }, { status: 500 })
  }
}
