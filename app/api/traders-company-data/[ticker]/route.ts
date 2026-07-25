import { NextResponse } from 'next/server'
import {
  getTradersCompanyData,
  normalizeJpTicker,
  TRADERS_COMPANY_SOURCE_NAME,
} from '@/lib/traders-company-data'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ ticker: string }> },
) {
  const { ticker: rawTicker } = await params
  const ticker = normalizeJpTicker(rawTicker)
  if (!ticker) {
    return NextResponse.json({ error: '銘柄コードが不正です。' }, { status: 400 })
  }

  try {
    const data = await getTradersCompanyData(ticker)
    return NextResponse.json(
      {
        available: Boolean(data),
        ticker,
        source: TRADERS_COMPANY_SOURCE_NAME,
        data,
      },
      {
        headers: {
          'Cache-Control': 'public, max-age=300, stale-while-revalidate=3600',
        },
      },
    )
  } catch (error) {
    console.error(`[traders-company-data] ${ticker}`, error)
    return NextResponse.json(
      { available: false, ticker, source: TRADERS_COMPANY_SOURCE_NAME, data: null },
      { status: 200 },
    )
  }
}
