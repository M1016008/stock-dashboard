import { NextRequest, NextResponse } from 'next/server'
import {
  getMtfCloseCalendar,
  MtfCloseCalendarRequestError,
  parseMtfCloseCalendarQuery,
} from '@/lib/server/mtf-close-calendar-read-model'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

export async function GET(request: NextRequest) {
  try {
    const input = parseMtfCloseCalendarQuery(new URL(request.url).searchParams)
    return NextResponse.json(await getMtfCloseCalendar(input))
  } catch (error) {
    if (error instanceof MtfCloseCalendarRequestError) {
      return NextResponse.json(
        { error: error.code, message: error.message },
        { status: error.status },
      )
    }
    console.error('MTF close calendar API error:', error)
    return NextResponse.json(
      { error: 'MTF_CLOSE_CALENDAR_UNAVAILABLE', message: 'MTF Close Calendarを取得できませんでした。' },
      { status: 503 },
    )
  }
}
