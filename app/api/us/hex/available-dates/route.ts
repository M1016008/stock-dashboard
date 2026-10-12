import { NextRequest, NextResponse } from 'next/server'
import { execAll } from '@/lib/db/client'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

type AvailableDate = { date: string; tickers: number | null }
type DateCacheValue = { expiresAt: number; dates: AvailableDate[] }

const CACHE_TTL_MS = 15 * 60 * 1_000
const globalForUsHexDates = globalThis as typeof globalThis & {
  usHexDateCache?: Map<number, DateCacheValue>
}
const dateCache = globalForUsHexDates.usHexDateCache ?? new Map<number, DateCacheValue>()
globalForUsHexDates.usHexDateCache = dateCache

export async function GET(request: NextRequest) {
  try {
    const limit = Math.min(5000, Math.max(1, Number(new URL(request.url).searchParams.get('limit') ?? 500)))
    const cached = dateCache.get(limit)
    if (cached && cached.expiresAt > Date.now()) {
      return NextResponse.json({ market: 'US', dates: cached.dates, cache: 'hit' })
    }
    const countWindow = Math.min(limit, 500)
    const dates = await execAll<AvailableDate>(
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
    dateCache.set(limit, { expiresAt: Date.now() + CACHE_TTL_MS, dates })
    return NextResponse.json({ market: 'US', dates, cache: 'miss' })
  } catch (error) {
    return NextResponse.json(
      { error: 'US HEX dates failed', message: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}
