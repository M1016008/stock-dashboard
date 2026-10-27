import { NextRequest, NextResponse } from 'next/server'
import { isUsDailyCloseDate, loadUsDailyCloseReport } from '@/lib/server/us-daily-close-report'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'
export const maxDuration = 30

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams
  const unknown = [...new Set(params.keys())].filter((key) => key !== 'date')
  const dates = params.getAll('date')
  if (unknown.length > 0 || dates.length > 1 || (dates.length === 1 && !isUsDailyCloseDate(dates[0]))) {
    return NextResponse.json({ success: false, error: 'invalid_us_daily_close_query' }, {
      status: 400,
      headers: { 'cache-control': 'private, no-store' },
    })
  }

  try {
    const data = await loadUsDailyCloseReport(dates[0] ?? null)
    if (dates[0] && data.status === 'empty') {
      return NextResponse.json({ success: false, error: 'us_daily_close_date_unavailable', data }, {
        status: 404,
        headers: { 'cache-control': 'private, no-store' },
      })
    }
    return NextResponse.json({ success: true, data }, {
      headers: { 'cache-control': 'private, no-store' },
    })
  } catch (error) {
    console.error('[api/us/daily-close] report unavailable', error)
    return NextResponse.json({ success: false, error: 'us_daily_close_unavailable' }, {
      status: 503,
      headers: { 'cache-control': 'private, no-store' },
    })
  }
}
