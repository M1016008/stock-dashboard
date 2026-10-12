import { NextRequest } from 'next/server'
import {
  getTriggerDiscoveryMiniCharts,
  TriggerDiscoveryMiniChartInputError,
} from '@/lib/server/trigger-discovery-mini-charts'
import { createUsTriggerDiscoveryMiniChartDataSource } from '@/lib/server/us-trigger-discovery'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'
export const maxDuration = 60

export async function POST(request: NextRequest) {
  const startedAt = performance.now()
  try {
    const result = await getTriggerDiscoveryMiniCharts(await request.json(), {
      dataSource: createUsTriggerDiscoveryMiniChartDataSource(),
    })
    const body = JSON.stringify({
      ...result,
      market: 'US',
      currency: 'USD',
      performance: {
        ...result.performance,
        totalMs: Math.round((performance.now() - startedAt) * 1_000) / 1_000,
      },
    })
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'private, max-age=0, must-revalidate',
        'Content-Length': String(Buffer.byteLength(body)),
      },
    })
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TriggerDiscoveryMiniChartInputError) {
      return Response.json({
        error: 'invalid_request',
        message: error instanceof SyntaxError ? 'JSON形式が正しくありません。' : (error as Error).message,
      }, { status: 400 })
    }
    console.error('[us/trigger-discovery/mini-charts]', error)
    return Response.json({
      error: 'us_trigger_discovery_mini_charts_failed',
      message: 'US Mini Chartを取得できませんでした。',
    }, { status: 500 })
  }
}
