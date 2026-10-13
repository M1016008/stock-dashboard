import { NextRequest, NextResponse } from 'next/server'
import { getUsBacktestDetail, isIsoDate, isUsBacktestHorizon } from '@/lib/server/us-backtest'
import { isUsMarketTradingDate } from '@/lib/server/us-data-freshness'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams
  const ticker = params.get('ticker')?.trim().toUpperCase() ?? ''
  const date = params.get('date')?.trim() ?? ''
  const horizon = Number(params.get('horizon') ?? 40)
  const move = params.get('move') === 'down' ? 'down' : 'up'
  if (!/^[A-Z0-9.\-]{1,15}$/.test(ticker)) return NextResponse.json({ error: 'invalid_ticker' }, { status: 400 })
  if (!isIsoDate(date)) return NextResponse.json({ error: 'invalid_date' }, { status: 400 })
  if (!isUsMarketTradingDate(date)) return NextResponse.json({ error: 'non_trading_date' }, { status: 400 })
  if (!isUsBacktestHorizon(horizon)) return NextResponse.json({ error: 'invalid_horizon' }, { status: 400 })
  try {
    const detail = await getUsBacktestDetail({ ticker, date, horizon, move })
    if (!detail) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    return NextResponse.json(detail, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('US backtest detail failed:', error)
    return NextResponse.json({ error: 'us_backtest_detail_failed' }, { status: 500 })
  }
}
