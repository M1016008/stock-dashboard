import { NextResponse } from 'next/server'
import {
  getHistoricalScanJobResult,
  parseHistoricalScanResultPagination,
} from '@/lib/server/trigger-discovery-historical-scan-jobs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

type RouteContext = { params: Promise<{ jobId: string }> }

export async function GET(request: Request, context: RouteContext) {
  try {
    const pagination = parseHistoricalScanResultPagination(request.url)
    const result = await getHistoricalScanJobResult({
      id: (await context.params).jobId,
      ...pagination,
    })
    if (result === null) return NextResponse.json({ error: 'historical_scan_job_not_found' }, { status: 404 })
    if (result === 'NOT_READY') {
      return NextResponse.json({ error: 'historical_scan_job_not_completed' }, { status: 409 })
    }
    if (result === 'EXPIRED') {
      return NextResponse.json({ error: 'historical_scan_job_result_expired' }, { status: 410 })
    }
    return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store, max-age=0' } })
  } catch (error) {
    if (error instanceof RangeError) {
      return NextResponse.json({ error: 'invalid_request', message: error.message }, { status: 400 })
    }
    console.error('[trigger-discovery/historical-scan/jobs:result]', error)
    return NextResponse.json({
      error: 'historical_scan_job_result_unavailable',
      message: 'Historical Trigger Scan Jobの結果を取得できませんでした。',
    }, { status: 500 })
  }
}
