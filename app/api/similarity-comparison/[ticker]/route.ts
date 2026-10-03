import { NextResponse } from 'next/server'
import { getSimilarityComparisonReadModel } from '@/lib/server/similarity-comparison-read-model'
import { decodePathSegment } from '@/lib/url-path'

export const dynamic = 'force-dynamic'

function validDate(value: string | null): value is string {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)))
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ ticker: string }> },
) {
  const ticker = decodePathSegment((await params).ticker).toUpperCase().replace(/\.T$/i, '')
  if (!/^[0-9A-Z]{4,5}$/.test(ticker)) return NextResponse.json({ error: 'invalid_ticker' }, { status: 400 })
  const searchParams = new URL(request.url).searchParams
  const asOf = searchParams.get('as_of')
  if (asOf && !validDate(asOf)) return NextResponse.json({ error: 'invalid_as_of' }, { status: 400 })
  const selected = (searchParams.get('selected') ?? '')
    .split(',')
    .map((value) => value.trim().toUpperCase().replace(/\.T$/i, ''))
    .filter((value) => /^[0-9A-Z]{4,5}$/.test(value))
    .slice(0, 8)
  try {
    const model = await getSimilarityComparisonReadModel(ticker, asOf, selected)
    return NextResponse.json(model, {
      headers: {
        'Cache-Control': asOf
          ? 'private, max-age=300, stale-while-revalidate=3600'
          : 'private, max-age=60, stale-while-revalidate=300',
      },
    })
  } catch (error) {
    console.error(`[similarity-comparison] ticker=${ticker}`, error)
    return NextResponse.json({ error: 'similarity_comparison_unavailable' }, { status: 500 })
  }
}
