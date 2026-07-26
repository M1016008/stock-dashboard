import { NextRequest, NextResponse } from 'next/server'
import { execAll } from '@/lib/db/client'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

export async function GET(request: NextRequest) {
  try {
    const limit = Math.min(5000, Math.max(1, Number(new URL(request.url).searchParams.get('limit') ?? 500)))
    const dates = await execAll<{ date: string; tickers: number }>(
      `
      SELECT date, COUNT(*) AS tickers
      FROM market_daily_snapshots
      WHERE market = 'US'
      GROUP BY date
      ORDER BY date DESC
      LIMIT ?
      `,
      [limit],
    )
    return NextResponse.json({ market: 'US', dates })
  } catch (error) {
    return NextResponse.json(
      { error: 'US HEX dates failed', message: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}
