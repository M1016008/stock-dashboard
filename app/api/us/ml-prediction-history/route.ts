import { NextRequest, NextResponse } from 'next/server'
import { hasUsAnalyticsDb } from '@/lib/db/us-analytics'
import { getUsMlPredictionHistory } from '@/lib/server/us-ml-prediction-history'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const maxDuration = 30

function empty(ticker: string, reason: string) {
  return {
    ticker,
    source: 'us_analytics.ml_predictions+ohlcv_daily',
    rows: [],
    availability: 'unavailable',
    availabilityReason: reason,
  }
}

export async function GET(request: NextRequest) {
  const ticker = request.nextUrl.searchParams.get('ticker')?.trim().toUpperCase() ?? ''
  const rawDate = request.nextUrl.searchParams.get('date')?.trim() ?? ''
  const date = rawDate && /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : null
  const requestedLimit = Number(request.nextUrl.searchParams.get('limit') ?? 80)
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(300, Math.max(1, Math.trunc(requestedLimit)))
    : 80

  if (!/^[A-Z0-9.^=-]{1,24}$/.test(ticker)) {
    return NextResponse.json({ error: '有効なUS銘柄を指定してください。' }, { status: 400 })
  }
  if (rawDate && !date) {
    return NextResponse.json({ error: '日付はYYYY-MM-DD形式で指定してください。' }, { status: 400 })
  }
  if (!hasUsAnalyticsDb()) return NextResponse.json(empty(ticker, 'us_analytics_not_configured'))

  try {
    return NextResponse.json(await getUsMlPredictionHistory({ ticker, limit, date }))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/SQLITE_BUSY|database is locked|no such table/i.test(message)) {
      return NextResponse.json(empty(ticker, 'us_prediction_history_unavailable'))
    }
    console.error('[api/us/ml-prediction-history]', error)
    return NextResponse.json(
      { ...empty(ticker, 'load_failed'), error: 'US ML予測履歴の取得に失敗しました。' },
      { status: 500 },
    )
  }
}
