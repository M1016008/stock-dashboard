import { NextRequest, NextResponse } from 'next/server'
import { hasUsAnalyticsDb } from '@/lib/db/us-analytics'
import { getUsMlPredictionHistory } from '@/lib/server/us-ml-prediction-history'
import { isIsoDate } from '@/lib/mtf-close-calendar'

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
  const params = request.nextUrl.searchParams
  for (const name of ['ticker', 'date', 'limit']) {
    if (params.getAll(name).length > 1) {
      return NextResponse.json({ error: `duplicate_${name}` }, { status: 400 })
    }
  }
  const ticker = params.get('ticker')?.trim().toUpperCase() ?? ''
  const rawDate = params.get('date')?.trim() ?? ''
  const date = rawDate && isIsoDate(rawDate) ? rawDate : null
  const rawLimit = params.get('limit')
  const requestedLimit = rawLimit == null ? 80 : Number(rawLimit)

  if (!/^[A-Z0-9.^=-]{1,24}$/.test(ticker)) {
    return NextResponse.json({ error: '有効なUS銘柄を指定してください。' }, { status: 400 })
  }
  if (rawDate && !date) {
    return NextResponse.json({ error: '日付はYYYY-MM-DD形式で指定してください。' }, { status: 400 })
  }
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 300) {
    return NextResponse.json({ error: 'limitは1〜300の整数で指定してください。' }, { status: 400 })
  }
  const limit = requestedLimit
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
