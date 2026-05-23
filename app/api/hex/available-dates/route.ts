// app/api/hex/available-dates/route.ts
// HEX / ダッシュボードの「日付選択」用に、daily_snapshots に存在する日付を返す。

import { NextRequest, NextResponse } from 'next/server'
import { execAll } from '@/lib/db/client'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

export async function GET(request: NextRequest) {
  const limitParam = Number(new URL(request.url).searchParams.get('limit') ?? 5000)
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(Math.floor(limitParam), 1), 10000) : 5000
  const rows = await execAll<{ date: string; tickers: number }>(
    `SELECT date, COUNT(*) AS tickers
     FROM daily_snapshots
     GROUP BY date
     ORDER BY date DESC
     LIMIT ?`,
    [limit],
  )
  return NextResponse.json({ success: true, dates: rows })
}
