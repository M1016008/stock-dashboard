import { NextRequest, NextResponse } from 'next/server'
import {
  addCalendarDays,
  getUsEarningsCalendar,
  isUsEarningsDate,
  todayInNewYork,
  type UsEarningsTimeBucket,
} from '@/lib/queries/us-earnings'

export const dynamic = 'force-dynamic'

const BUCKETS = new Set<UsEarningsTimeBucket>([
  'before_open',
  'market_hours',
  'after_close',
  'unknown',
])

function single(params: URLSearchParams, name: string): string | null {
  const values = params.getAll(name)
  return values.length <= 1 ? values[0] ?? null : null
}

function boundedInteger(value: string | null, fallback: number, min: number, max: number): number | null {
  if (value == null || value === '') return fallback
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : null
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams
  const today = todayInNewYork()
  const fromRaw = single(params, 'from')
  const toRaw = single(params, 'to')
  const query = single(params, 'q')
  const bucketRaw = single(params, 'timeBucket')
  const limit = boundedInteger(single(params, 'limit'), 100, 1, 500)
  const offset = boundedInteger(single(params, 'offset'), 0, 0, 100_000)
  if (
    (fromRaw != null && !isUsEarningsDate(fromRaw))
    || (toRaw != null && !isUsEarningsDate(toRaw))
    || (bucketRaw != null && !BUCKETS.has(bucketRaw as UsEarningsTimeBucket))
    || limit == null
    || offset == null
    || params.getAll('from').length > 1
    || params.getAll('to').length > 1
    || params.getAll('q').length > 1
    || params.getAll('timeBucket').length > 1
    || params.getAll('limit').length > 1
    || params.getAll('offset').length > 1
  ) {
    return NextResponse.json({ error: 'invalid_us_earnings_query' }, { status: 400 })
  }
  const from = fromRaw ?? today
  const to = toRaw ?? addCalendarDays(from, 30)
  if (from > to) return NextResponse.json({ error: 'invalid_us_earnings_range' }, { status: 400 })

  const result = await getUsEarningsCalendar({
    from,
    to,
    query,
    timeBucket: bucketRaw as UsEarningsTimeBucket | null,
    limit,
    offset,
  })
  return NextResponse.json(result, {
    status: result.status === 'unavailable' ? 503 : 200,
    headers: { 'cache-control': 'private, no-store' },
  })
}
