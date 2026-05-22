import { NextRequest, NextResponse } from 'next/server'
import { execAll, execGet } from '@/lib/db/client'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

type SimilarServing = {
  source_ticker: string
  source_date: string
  rank: number
  similar_ticker: string
  similar_date: string
  similarity_score: number
  payload_json: string
  name: string | null
}

function parseJson(value: string): Record<string, unknown> {
  try {
    return JSON.parse(value) as Record<string, unknown>
  } catch {
    return {}
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const ticker = searchParams.get('ticker')
    const date = searchParams.get('date')
    if (!ticker || !date) {
      return NextResponse.json({ cases: [], notice: 'ticker/date are required' })
    }

    const serving = await execAll<SimilarServing>(
      `
      SELECT s.*, u.name
      FROM serving_similar_cases s
      LEFT JOIN ticker_universe u ON u.ticker = s.similar_ticker
      WHERE s.source_ticker = ? AND s.source_date = ?
      ORDER BY s.rank
      LIMIT 12
      `,
      [ticker, date],
    )
    if (serving.length > 0) {
      return NextResponse.json({
        ticker,
        date,
        source: 'serving_similar_cases',
        cases: serving.map((row) => ({
          rank: row.rank,
          ticker: row.similar_ticker,
          name: row.name,
          date: row.similar_date,
          similarity: row.similarity_score,
          payload: parseJson(row.payload_json),
        })),
      })
    }

    const feature = await execGet<{ pattern_code: string | null }>(
      `SELECT pattern_code FROM model_features WHERE ticker = ? AND date = ?`,
      [ticker, date],
    )
    if (!feature?.pattern_code) {
      return NextResponse.json({ ticker, date, source: 'none', cases: [] })
    }

    const fallback = await execAll<{
      ticker: string
      date: string
      name: string | null
      max_return_pct: number | null
      days_to_max: number | null
      return_pct: number | null
    }>(
      `
      SELECT mf.ticker, mf.date, u.name, fe.max_return_pct, fe.days_to_max, fe.return_pct
      FROM model_features mf
      INNER JOIN forward_extrema fe ON fe.ticker = mf.ticker AND fe.date = mf.date AND fe.horizon_days = 40
      LEFT JOIN ticker_universe u ON u.ticker = mf.ticker
      WHERE mf.pattern_code = ?
        AND mf.date < ?
        AND mf.ticker <> ?
      ORDER BY fe.max_return_pct DESC
      LIMIT 12
      `,
      [feature.pattern_code, date, ticker],
    )

    return NextResponse.json({
      ticker,
      date,
      source: 'pattern_fallback',
      cases: fallback.map((row, index) => ({
        rank: index + 1,
        ticker: row.ticker,
        name: row.name,
        date: row.date,
        similarity: null,
        payload: row,
      })),
    })
  } catch (error) {
    console.error('Backtest similar API error:', error)
    return NextResponse.json(
      { error: 'Backtest similar failed', message: (error as Error).message },
      { status: 500 },
    )
  }
}
