// app/api/screener/history/route.ts
// screener_snapshots テーブルから過去日付の銘柄一覧を取得する。

import { NextRequest, NextResponse } from 'next/server'
import { execAll } from '@/lib/db/client'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const date = searchParams.get('date') // YYYY-MM-DD

    if (date) {
      const rows = await execAll(`SELECT * FROM screener_snapshots WHERE date = ?`, [date])
      return NextResponse.json({ date, results: rows, total: rows.length })
    }

    const dates = await execAll<{ date: string; count: number }>(
      `SELECT date, COUNT(*) AS count
       FROM screener_snapshots
       GROUP BY date
       ORDER BY date DESC
       LIMIT 50`,
    )

    return NextResponse.json({ dates })
  } catch (error) {
    console.error('Screener history API error:', error)
    return NextResponse.json(
      { error: 'Failed to load history', message: (error as Error).message },
      { status: 500 },
    )
  }
}
