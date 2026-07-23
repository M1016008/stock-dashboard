import { NextRequest, NextResponse } from 'next/server'
import { execAll } from '@/lib/db/client'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

const HORIZONS = [5, 20, 30, 40, 60, 90, 180, 200]

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const requestedHorizon = Number(searchParams.get('horizon') ?? 40)
    const horizon = HORIZONS.includes(requestedHorizon) ? requestedHorizon : 40

    const serving = await execAll<{ date: string; total_tickers: number; signal_tickers: number }>(
      `
      SELECT date, total_tickers, signal_tickers
      FROM serving_backtest_dates
      WHERE EXISTS (
        SELECT 1 FROM serving_backtest_summaries s
        WHERE s.date = serving_backtest_dates.date AND s.horizon_days = ?
      )
        AND EXISTS (
          SELECT 1 FROM serving_backtest_results r
          WHERE r.date = serving_backtest_dates.date AND r.horizon_days = ?
        )
      ORDER BY date DESC
      `,
      [horizon, horizon],
    )
    if (serving.length > 0) {
      return NextResponse.json({ dates: serving, source: 'serving_backtest_dates', count: serving.length, horizon })
    }

    const fallback = await execAll<{ date: string; total_tickers: number; signal_tickers: number }>(
      `
      SELECT
        mf.date,
        COUNT(*) AS total_tickers,
        SUM(CASE WHEN mf.signal_codes IS NOT NULL AND mf.signal_codes <> '' THEN 1 ELSE 0 END) AS signal_tickers
      FROM model_features mf
      WHERE EXISTS (
        SELECT 1 FROM forward_extrema fe
        WHERE fe.ticker = mf.ticker AND fe.date = mf.date AND fe.horizon_days = ?
      )
      GROUP BY mf.date
      ORDER BY mf.date DESC
      `,
      [horizon],
    )
    return NextResponse.json({ dates: fallback, source: 'model_features', count: fallback.length, horizon })
  } catch (error) {
    console.error('Backtest dates API error:', error)
    return NextResponse.json(
      { error: 'Backtest dates failed', message: (error as Error).message },
      { status: 500 },
    )
  }
}
