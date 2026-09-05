import { NextRequest, NextResponse } from 'next/server'
import { getMlPredictionHistory } from '@/lib/queries/ml-insights'
import { getJpMlPitAvailability } from '@/lib/server/ml-pit'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const ticker = searchParams.get('ticker')?.trim()
    if (!ticker) {
      return NextResponse.json({ error: 'ticker is required' }, { status: 400 })
    }
    const limit = Math.min(300, Math.max(1, Number(searchParams.get('limit') ?? 80)))
    const rawDate = searchParams.get('date')?.trim() ?? ''
    const date = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : null
    if (date) {
      const pit = await getJpMlPitAvailability(date)
      if (pit.availability === 'unavailable') {
        return NextResponse.json({ ticker, rows: [], availability: pit.availability, availabilityReason: pit.availabilityReason })
      }
    }
    return NextResponse.json(await getMlPredictionHistory({ ticker, limit, date }))
  } catch (error) {
    console.error('ML prediction history API error:', error)
    return NextResponse.json(
      { error: 'ML prediction history failed', message: (error as Error).message },
      { status: 500 },
    )
  }
}
