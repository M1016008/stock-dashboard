import { NextRequest, NextResponse } from 'next/server'
import { getMlPredictionHistory } from '@/lib/queries/ml-insights'

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
    return NextResponse.json(await getMlPredictionHistory({ ticker, limit }))
  } catch (error) {
    console.error('ML prediction history API error:', error)
    return NextResponse.json(
      { error: 'ML prediction history failed', message: (error as Error).message },
      { status: 500 },
    )
  }
}
