import { NextResponse } from 'next/server'
import { getUsFundamentals } from '@/lib/server/us-fundamentals'
import { decodePathSegment } from '@/lib/url-path'

export const dynamic = 'force-dynamic'
export const revalidate = 0

function validDate(value: string | null): value is string {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)))
}

export async function GET(request: Request, { params }: { params: Promise<{ ticker: string }> }) {
  const ticker = decodePathSegment((await params).ticker).trim().toUpperCase()
  if (!/^[A-Z0-9.-]{1,12}$/.test(ticker)) {
    return NextResponse.json({ error: 'invalid_ticker' }, { status: 400 })
  }
  const requested = new URL(request.url).searchParams.get('as_of')
  if (requested && !validDate(requested)) {
    return NextResponse.json({ error: 'invalid_as_of' }, { status: 400 })
  }
  try {
    const model = await getUsFundamentals(ticker, requested)
    return NextResponse.json(model, {
      headers: { 'Cache-Control': requested ? 'private, max-age=300' : 'private, max-age=60, stale-while-revalidate=300' },
    })
  } catch (error) {
    console.error(`[us/fundamentals] ticker=${ticker}`, error)
    return NextResponse.json({ error: 'us_fundamentals_unavailable' }, { status: 500 })
  }
}
