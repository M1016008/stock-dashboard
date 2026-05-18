// app/api/hex/available-dates/route.ts
// HEX 画面の「日付選択」用に、daily_snapshots に存在する直近 N 日を返す。

import { NextResponse } from 'next/server'
import { execAll } from '@/lib/db/client'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

export async function GET() {
  const rows = await execAll<{ date: string; tickers: number }>(
    `SELECT date, COUNT(*) AS tickers
     FROM daily_snapshots
     GROUP BY date
     ORDER BY date DESC
     LIMIT 30`,
  )
  return NextResponse.json({ success: true, dates: rows })
}
