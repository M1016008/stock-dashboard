import { NextRequest } from 'next/server'
import {
  getTriggerDiscoveryMiniCharts,
  TriggerDiscoveryMiniChartInputError,
} from '@/lib/server/trigger-discovery-mini-charts'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'
export const maxDuration = 60

export async function POST(request: NextRequest) {
  const startedAt = performance.now()
  try {
    const result = await getTriggerDiscoveryMiniCharts(await request.json())
    const serializationStartedAt = performance.now()
    const provisional = JSON.stringify(result)
    const serializationMs = Math.round((performance.now() - serializationStartedAt) * 1000) / 1000
    const body = JSON.stringify({
      ...result,
      performance: {
        ...result.performance,
        serializationMs,
        totalMs: Math.round((performance.now() - startedAt) * 1000) / 1000,
      },
    })
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'private, max-age=0, must-revalidate',
        'Content-Length': String(Buffer.byteLength(body)),
        'Server-Timing': `trigger-mini-charts;dur=${result.performance.totalMs}, serialize;dur=${serializationMs}`,
        'X-Provisional-Bytes': String(Buffer.byteLength(provisional)),
      },
    })
  } catch (error) {
    if (error instanceof SyntaxError) {
      return Response.json({
        error: 'invalid_request',
        message: 'JSON形式が正しくありません。',
      }, { status: 400 })
    }
    if (error instanceof TriggerDiscoveryMiniChartInputError) {
      return Response.json({
        error: 'invalid_request',
        message: error.message,
      }, { status: 400 })
    }
    console.error('[trigger-discovery/mini-charts]', error)
    return Response.json({
      error: 'trigger_discovery_mini_charts_failed',
      message: 'Mini Chartを取得できませんでした。',
    }, { status: 500 })
  }
}
