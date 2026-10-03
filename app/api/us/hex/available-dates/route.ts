import { NextRequest, NextResponse } from 'next/server'
import { execAll } from '@/lib/db/client'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

export async function GET(request: NextRequest) {
  try {
    const limit = Math.min(5000, Math.max(1, Number(new URL(request.url).searchParams.get('limit') ?? 500)))
    const countWindow = Math.min(limit, 500)
    const dates = await execAll<{ date: string; tickers: number | null }>(
      `
      WITH RECURSIVE recent_dates(date, position) AS (
        SELECT MAX(date), 1
        FROM market_daily_snapshots
        WHERE market = 'US'

        UNION ALL

        SELECT (
          SELECT MAX(snapshot.date)
          FROM market_daily_snapshots snapshot
          WHERE snapshot.market = 'US'
            AND snapshot.date < recent_dates.date
        ), position + 1
        FROM recent_dates
        WHERE date IS NOT NULL
          AND position < ?
      )
      SELECT
        date,
        CASE WHEN position <= ? THEN (
          SELECT COUNT(*)
          FROM market_daily_snapshots snapshot
          WHERE snapshot.market = 'US'
            AND snapshot.date = recent_dates.date
        ) END AS tickers
      FROM recent_dates
      WHERE date IS NOT NULL
      `,
      [limit, countWindow],
    )
    return NextResponse.json({ market: 'US', dates })
  } catch (error) {
    return NextResponse.json(
      { error: 'US HEX dates failed', message: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}
