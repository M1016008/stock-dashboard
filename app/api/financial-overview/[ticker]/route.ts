import { NextResponse } from 'next/server'
import { getFinancialOverviewReadModel } from '@/lib/server/financial-overview-read-model'
import { decodePathSegment } from '@/lib/url-path'

export const dynamic = 'force-dynamic'

function normalizeTicker(raw: string): string {
  return decodePathSegment(raw).replace(/\.T$/i, '')
}

function validAsOf(value: string | null): value is string {
  if (!value) return false
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
  return !Number.isNaN(Date.parse(value))
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ ticker: string }> },
) {
  const ticker = normalizeTicker((await params).ticker)
  if (!/^[0-9A-Z]{4,5}$/i.test(ticker)) {
    return NextResponse.json({ error: 'invalid_ticker' }, { status: 400 })
  }
  const requestedAsOf = new URL(request.url).searchParams.get('as_of')
  if (requestedAsOf && !validAsOf(requestedAsOf)) {
    return NextResponse.json({ error: 'invalid_as_of' }, { status: 400 })
  }

  try {
    const model = await getFinancialOverviewReadModel(ticker, requestedAsOf)
    if (!model.classification.name && model.coverage.facts === 0) {
      return NextResponse.json({ error: 'ticker_not_found' }, { status: 404 })
    }
    return NextResponse.json(model, {
      headers: {
        'Cache-Control': requestedAsOf
          ? 'private, max-age=300, stale-while-revalidate=3600'
          : 'private, max-age=60, stale-while-revalidate=300',
      },
    })
  } catch (error) {
    console.error(`[financial-overview] ticker=${ticker}`, error)
    return NextResponse.json({ error: 'financial_overview_unavailable' }, { status: 500 })
  }
}
