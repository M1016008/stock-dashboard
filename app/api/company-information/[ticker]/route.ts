import { NextResponse } from 'next/server'
import { getCompanyInformationReadModel } from '@/lib/server/company-information-read-model'
import { decodePathSegment } from '@/lib/url-path'

export const dynamic = 'force-dynamic'

function validAsOf(value: string | null): value is string {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)))
}
export async function GET(
  request: Request,
  { params }: { params: Promise<{ ticker: string }> },
) {
  const ticker = decodePathSegment((await params).ticker).replace(/\.T$/i, '')
  if (!/^[0-9A-Z]{4,5}$/i.test(ticker)) {
    return NextResponse.json({ error: 'invalid_ticker' }, { status: 400 })
  }
  const asOf = new URL(request.url).searchParams.get('as_of')
  if (asOf && !validAsOf(asOf)) {
    return NextResponse.json({ error: 'invalid_as_of' }, { status: 400 })
  }
  try {
    const model = await getCompanyInformationReadModel(ticker, asOf)
    if (!model) return NextResponse.json({ error: 'company_information_not_found' }, { status: 404 })
    return NextResponse.json(model, {
      headers: {
        'Cache-Control': asOf
          ? 'private, max-age=300, stale-while-revalidate=3600'
          : 'private, max-age=60, stale-while-revalidate=300',
      },
    })
  } catch (error) {
    console.error(`[company-information] ticker=${ticker}`, error)
    return NextResponse.json({ error: 'company_information_unavailable' }, { status: 500 })
  }
}
