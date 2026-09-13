import { NextRequest, NextResponse } from 'next/server'
import { TriggerConfigError } from '@/lib/trigger-discovery-engine'
import { getTriggerHistoricalScan } from '@/lib/server/trigger-discovery-historical-scan'
import { parseTriggerHistoricalScanRequest } from '@/lib/server/trigger-discovery-historical-scan-request'
import { TriggerDiscoveryInputError } from '@/lib/server/trigger-discovery-read-model'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'
export const maxDuration = 120

export async function POST(request: NextRequest) {
  try {
    const parsed = parseTriggerHistoricalScanRequest(await request.json())
    const response = await getTriggerHistoricalScan({
      requestedStartDate: parsed.request.startDate,
      requestedEndDate: parsed.request.endDate,
      timeframe: parsed.timeframe,
      criteria: parsed.input,
      eventOffset: parsed.eventOffset,
      eventLimit: parsed.eventLimit,
    }, { signal: request.signal })
    return NextResponse.json(response, {
      headers: {
        'Cache-Control': 'private, max-age=0, must-revalidate',
        'Server-Timing': `trigger-historical-scan;dur=${response.performance.totalMs}`,
      },
    })
  } catch (error) {
    if (error instanceof TriggerDiscoveryInputError || error instanceof TriggerConfigError
      || error instanceof SyntaxError || error instanceof RangeError) {
      return NextResponse.json({
        error: 'invalid_request',
        message: error instanceof SyntaxError ? 'JSON形式が正しくありません。' : (error as Error).message,
      }, { status: 400 })
    }
    if (error instanceof DOMException && error.name === 'AbortError') {
      return NextResponse.json({ error: 'request_aborted', message: '期間スキャンを中断しました。' }, { status: 499 })
    }
    console.error('[trigger-discovery/historical-scan]', error)
    return NextResponse.json({
      error: 'historical_scan_failed',
      message: 'Historical Trigger Scanを実行できませんでした。',
    }, { status: 500 })
  }
}
