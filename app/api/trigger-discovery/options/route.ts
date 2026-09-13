import { NextResponse } from 'next/server'
import { getTriggerDiscoveryOptions } from '@/lib/server/trigger-discovery-options'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

export async function GET() {
  try {
    return NextResponse.json(await getTriggerDiscoveryOptions(), {
      headers: { 'Cache-Control': 'private, max-age=0, must-revalidate' },
    })
  } catch (error) {
    console.error('[trigger-discovery/options]', error)
    return NextResponse.json({
      error: 'trigger_discovery_options_failed',
      message: '検索条件を取得できませんでした。',
    }, { status: 500 })
  }
}
