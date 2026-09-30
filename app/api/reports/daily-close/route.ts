import { NextResponse } from 'next/server'
import { buildDailyCloseReport } from '@/lib/server/daily-close-report'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams
    const requestedDate = params.get('date')
    const watchlistTickers = (params.get('watchlist') ?? '').split(',').filter(Boolean)
    const report = await buildDailyCloseReport({ requestedDate, watchlistTickers })
    return NextResponse.json(report, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'daily_close_report_unavailable'
    const status = message === 'invalid_report_date' ? 400 : message === 'report_price_date_unavailable' ? 404 : 500
    if (status === 500) console.error('daily_close_report_failed', error)
    return NextResponse.json({ error: status === 500 ? 'daily_close_report_unavailable' : message }, { status })
  }
}
