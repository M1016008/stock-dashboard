import { NextRequest, NextResponse } from 'next/server'
import { getMlModelStatus } from '@/lib/queries/ml-insights'
import { summarizeJpMlReliabilityStatus } from '@/lib/ml/reliability-status'
import { getJpMlPitAvailability } from '@/lib/server/ml-pit'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

export async function GET(request: NextRequest) {
  try {
    const rawDate = new URL(request.url).searchParams.get('date')?.trim() ?? ''
    const date = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : null
    if (date) return NextResponse.json(await getJpMlPitAvailability(date))
    return NextResponse.json(summarizeJpMlReliabilityStatus(await getMlModelStatus()))
  } catch (error) {
    console.error('ML reliability status API error:', error)
    return NextResponse.json(
      { error: 'ML reliability status failed' },
      { status: 500 },
    )
  }
}
