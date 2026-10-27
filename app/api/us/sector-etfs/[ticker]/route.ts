import { NextRequest, NextResponse } from 'next/server'
import {
  loadUsSectorEtfDetail,
  resolveUsSectorEtfTicker,
} from '@/lib/server/us-sector-etf-detail-read-model'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'
export const maxDuration = 30

function isIsoCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ ticker: string }> },
) {
  const unknownKeys = [...new Set(request.nextUrl.searchParams.keys())].filter((key) => key !== 'date')
  if (unknownKeys.length > 0) {
    return NextResponse.json(
      { success: false, error: 'unsupported_query_parameter', parameters: unknownKeys },
      { status: 400 },
    )
  }

  const dates = request.nextUrl.searchParams.getAll('date')
  if (dates.length > 1 || (dates[0] != null && !isIsoCalendarDate(dates[0]))) {
    return NextResponse.json({ success: false, error: 'invalid_date' }, { status: 400 })
  }

  const { ticker: rawTicker } = await params
  const resolution = resolveUsSectorEtfTicker(rawTicker)
  if (resolution.status === 'invalid') {
    return NextResponse.json({ success: false, error: 'invalid_ticker' }, { status: 400 })
  }
  if (resolution.status === 'unsupported') {
    return NextResponse.json(
      { success: false, error: 'unsupported_sector_etf', ticker: resolution.ticker },
      { status: 404 },
    )
  }

  const requestedDate = dates[0] ?? null
  try {
    const data = await loadUsSectorEtfDetail(resolution.ticker, requestedDate)
    if (!data) {
      return NextResponse.json(
        { success: false, error: requestedDate ? 'unavailable_date' : 'sector_etf_data_unavailable' },
        { status: 404 },
      )
    }
    return NextResponse.json({ success: true, data })
  } catch (error) {
    console.error('[api/us/sector-etfs/:ticker] failed to load sector ETF detail', error)
    return NextResponse.json({ success: false, error: 'us_sector_etf_detail_failed' }, { status: 500 })
  }
}
