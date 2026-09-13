import { NextResponse } from 'next/server'
import { TriggerConfigError } from '@/lib/trigger-discovery-engine'
import {
  createHistoricalScanJob,
  listHistoricalScanJobs,
} from '@/lib/server/trigger-discovery-historical-scan-jobs'
import { TriggerDiscoveryInputError } from '@/lib/server/trigger-discovery-read-model'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

export async function GET(request: Request) {
  try {
    const rawLimit = new URL(request.url).searchParams.get('limit') ?? '20'
    const limit = Number(rawLimit)
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
      return NextResponse.json({ error: 'invalid_request', message: 'limit must be between 1 and 20' }, { status: 400 })
    }
    return NextResponse.json(await listHistoricalScanJobs(limit), {
      headers: { 'Cache-Control': 'private, no-store, max-age=0' },
    })
  } catch (error) {
    console.error('[trigger-discovery/historical-scan/jobs:list]', error)
    return NextResponse.json({
      error: 'historical_scan_jobs_unavailable',
      message: 'Historical Trigger Scan Jobを取得できませんでした。',
    }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    const response = await createHistoricalScanJob(await request.json())
    return NextResponse.json(response, {
      status: response.reused && response.status === 'COMPLETED' ? 200 : 202,
      headers: { 'Cache-Control': 'private, no-store, max-age=0' },
    })
  } catch (error) {
    if (error instanceof TriggerDiscoveryInputError || error instanceof TriggerConfigError
      || error instanceof SyntaxError || error instanceof RangeError) {
      return NextResponse.json({
        error: 'invalid_request',
        message: error instanceof SyntaxError ? 'JSON形式が正しくありません。' : (error as Error).message,
      }, { status: 400 })
    }
    console.error('[trigger-discovery/historical-scan/jobs:start]', error)
    return NextResponse.json({
      error: 'historical_scan_job_start_failed',
      message: 'Historical Trigger Scan Jobを開始できませんでした。',
    }, { status: 500 })
  }
}
