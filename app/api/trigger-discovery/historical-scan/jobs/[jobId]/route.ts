import { NextResponse } from 'next/server'
import {
  cancelHistoricalScanJob,
  getHistoricalScanJob,
} from '@/lib/server/trigger-discovery-historical-scan-jobs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

type RouteContext = { params: Promise<{ jobId: string }> }

export async function GET(_request: Request, context: RouteContext) {
  try {
    const job = await getHistoricalScanJob((await context.params).jobId)
    if (!job) return NextResponse.json({ error: 'historical_scan_job_not_found' }, { status: 404 })
    return NextResponse.json(job, { headers: { 'Cache-Control': 'private, no-store, max-age=0' } })
  } catch (error) {
    console.error('[trigger-discovery/historical-scan/jobs:get]', error)
    return NextResponse.json({
      error: 'historical_scan_job_unavailable',
      message: 'Historical Trigger Scan Jobを取得できませんでした。',
    }, { status: 500 })
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const job = await cancelHistoricalScanJob((await context.params).jobId)
    if (!job) return NextResponse.json({ error: 'historical_scan_job_not_found' }, { status: 404 })
    return NextResponse.json(job, { headers: { 'Cache-Control': 'private, no-store, max-age=0' } })
  } catch (error) {
    console.error('[trigger-discovery/historical-scan/jobs:cancel]', error)
    return NextResponse.json({
      error: 'historical_scan_job_cancel_failed',
      message: 'Historical Trigger Scan Jobをキャンセルできませんでした。',
    }, { status: 500 })
  }
}
