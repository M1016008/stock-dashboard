import { NextResponse } from 'next/server'
import { ensureReady, execGet } from '@/lib/db/client'
import { decodePathSegment } from '@/lib/url-path'

export const dynamic = 'force-dynamic'
export const revalidate = 0

type ShikihoProfileRow = {
  ticker: string
  forecastPer: number | null
  actualPbr: number | null
  forecastRoe: number | null
  dividendYield: number | null
  headline1: string | null
  description1: string | null
  headline2: string | null
  description2: string | null
  issueLabel: string | null
  releaseDate: string | null
  companyFeature: string | null
  consolidatedBusiness: string | null
  updatedAt: number
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ ticker: string }> },
) {
  try {
    await ensureReady()
    const { ticker: rawTicker } = await params
    const ticker = decodePathSegment(rawTicker).replace(/\.T$/i, '').toUpperCase()
    const profile = await execGet<ShikihoProfileRow>(
      `
      SELECT
        ticker,
        forecast_per AS forecastPer,
        actual_pbr AS actualPbr,
        forecast_roe AS forecastRoe,
        dividend_yield AS dividendYield,
        headline_1 AS headline1,
        description_1 AS description1,
        headline_2 AS headline2,
        description_2 AS description2,
        issue_label AS issueLabel,
        release_date AS releaseDate,
        company_feature AS companyFeature,
        consolidated_business AS consolidatedBusiness,
        updated_at AS updatedAt
      FROM stock_shikiho_profiles
      WHERE ticker = ?
      LIMIT 1
      `,
      [ticker],
    )

    return NextResponse.json({
      ticker,
      profile: profile ?? null,
      source: '会社四季報CSV',
    })
  } catch (error) {
    return NextResponse.json(
      { error: 'Shikiho profile failed', message: (error as Error).message },
      { status: 500 },
    )
  }
}
