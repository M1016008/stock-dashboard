import { NextResponse } from 'next/server'
import { getUsTriggerDiscoveryOptions } from '@/lib/server/us-trigger-discovery'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

export async function GET() {
  try {
    return NextResponse.json(await getUsTriggerDiscoveryOptions(), {
      headers: { 'Cache-Control': 'private, max-age=0, must-revalidate' },
    })
  } catch (error) {
    console.error('[us/trigger-discovery/options]', error)
    return NextResponse.json({
      error: 'us_trigger_discovery_options_failed',
      message: 'US条件トリガーの利用可能日を取得できませんでした。',
    }, { status: 500 })
  }
}
