// app/api/screener/history/route.ts
// screener_snapshots テーブルから過去日付の銘柄一覧を取得する。

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db/client'
import { screenerSnapshots } from '@/lib/db/schema'
import { eq, sql } from 'drizzle-orm'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const date = searchParams.get('date') // YYYY-MM-DD

    if (date) {
      // 指定日のスナップショット
      const rows = db
        .select()
        .from(screenerSnapshots)
        .where(eq(screenerSnapshots.date, date))
        .all()
      return NextResponse.json({ date, results: rows, total: rows.length })
    }

    // 利用可能な日付一覧（DESC、最新50件まで）
    const dates = (db
      .select({ date: screenerSnapshots.date, count: sql<number>`count(*)` })
      .from(screenerSnapshots)
      .groupBy(screenerSnapshots.date)
      .orderBy(sql`${screenerSnapshots.date} desc`)
      .limit(50)
      .all() as { date: string; count: number }[])

    return NextResponse.json({ dates })
  } catch (error) {
    console.error('Screener history API error:', error)
    return NextResponse.json(
      { error: 'Failed to load history', message: (error as Error).message },
      { status: 500 },
    )
  }
}
