import { NextResponse } from 'next/server'
import { getTriggerPathFollowUp } from '@/lib/server/trigger-path-read-model'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

type RouteContext = { params: Promise<{ jobId: string; eventKey: string }> }

export async function GET(request: Request, context: RouteContext) {
  try {
    const { jobId, eventKey } = await context.params
    const preEventSessions = new URL(request.url).searchParams.get('preEventSessions')
    const result = await getTriggerPathFollowUp({
      jobId, eventKey,
      preEventSessions: preEventSessions == null ? undefined : Number(preEventSessions),
    })
    if (result == null) return NextResponse.json({ error: 'historical_scan_event_not_found' }, { status: 404 })
    if (result === 'NOT_READY') return NextResponse.json({ error: 'historical_scan_job_not_completed' }, { status: 409 })
    if (result === 'EXPIRED') return NextResponse.json({ error: 'historical_scan_job_result_expired' }, { status: 410 })
    if (result === 'NO_MARKET_DATA') return NextResponse.json({ error: 'event_market_session_not_found' }, { status: 422 })
    const serializationStarted = performance.now()
    const body = JSON.stringify(result)
    const serializationMs = Math.round((performance.now() - serializationStarted) * 100) / 100
    return new Response(body, {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'private, no-store, max-age=0',
        'Server-Timing': `path;dur=${result.meta.performance.totalMs},serialize;dur=${serializationMs}`,
      },
    })
  } catch (error) {
    if (error instanceof RangeError) {
      return NextResponse.json({ error: 'invalid_request', message: error.message }, { status: 400 })
    }
    console.error('[trigger-discovery/historical-scan:follow-up]', error)
    return NextResponse.json({ error: 'trigger_path_unavailable' }, { status: 500 })
  }
}
