import { NextResponse } from 'next/server'
import { latestFxRateStatus } from '@/lib/custom-charts/server'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

export async function GET() {
  try {
    const status = await latestFxRateStatus()
    return NextResponse.json(status, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'FXレート状態を取得できませんでした。'
    return NextResponse.json({ error: message }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}
