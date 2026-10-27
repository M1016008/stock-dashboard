import { NextRequest, NextResponse } from 'next/server'
import { loadUsSectorEtfBoard } from '@/lib/server/us-sector-etf-read-model'

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
export async function GET(request: NextRequest) {
  const dates = request.nextUrl.searchParams.getAll('date')
  if (dates.length > 1 || (dates[0] != null && !isIsoCalendarDate(dates[0]))) {
    return NextResponse.json({ success: false, error: 'invalid_date' }, { status: 400 })
  }

  const requestedDate = dates[0] ?? null
  try {
    const data = await loadUsSectorEtfBoard(requestedDate)
    if (requestedDate && data.status === 'empty') {
      return NextResponse.json(
        { success: false, error: 'unavailable_date', data },
        { status: 404 },
      )
    }
    return NextResponse.json({ success: true, data })
  } catch (error) {
    console.error('[api/us/sector-etfs] failed to load sector ETF board', error)
    return NextResponse.json({ success: false, error: 'us_sector_etfs_failed' }, { status: 500 })
  }
}
