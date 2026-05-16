// app/api/stage-history/[ticker]/route.ts
// Phase 3.5 で完全書き換え: Yahoo を呼んで都度 MA 計算する代わりに、
// 既に計算済みの daily_snapshots から直接読み出す。
//
// 動作: 過去 N 週分について、各週末 (= 5 営業日刻みで遡って) のスナップショットを返す。
// Yahoo の `getHistory` も `buildMaValuesFromOhlcv` も不要。

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db/client'
import { dailySnapshots } from '@/lib/db/schema'
import { asc, eq } from 'drizzle-orm'

export const revalidate = 3600

interface StageHistoryEntry {
  date: string
  daily_a_stage: number | null
  daily_b_stage: number | null
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
  close: number | null  // 互換性のため残すが、daily_snapshots には close 列がない
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ ticker: string }> },
) {
  try {
    const { ticker: rawTicker } = await params
    const ticker = decodeURIComponent(rawTicker).replace(/\.T$/i, '')
    const { searchParams } = new URL(request.url)
    const weeks = Math.min(Number(searchParams.get('weeks') ?? '26'), 52)

    // 該当銘柄の snapshot を日付昇順で全件取得
    const all = await db
      .select()
      .from(dailySnapshots)
      .where(eq(dailySnapshots.ticker, ticker))
      .orderBy(asc(dailySnapshots.date))

    if (all.length === 0) {
      return NextResponse.json({ ticker, history: [], total: 0 })
    }

    // 末尾 weeks * 5 営業日ぶんを 5 日刻みで抽出
    const stepDays = 5
    const entries: StageHistoryEntry[] = []
    for (let weekIdx = weeks - 1; weekIdx >= 0; weekIdx--) {
      const idx = all.length - 1 - weekIdx * stepDays
      if (idx < 0) continue
      const snap = all[idx]
      entries.push({
        date:             snap.date,
        daily_a_stage:    snap.daily_a_stage,
        daily_b_stage:    snap.daily_b_stage,
        weekly_a_stage:   snap.weekly_a_stage,
        weekly_b_stage:   snap.weekly_b_stage,
        monthly_a_stage:  snap.monthly_a_stage,
        monthly_b_stage:  snap.monthly_b_stage,
        close:            null,
      })
    }

    return NextResponse.json({
      ticker,
      history: entries,
      total: entries.length,
    })
  } catch (error) {
    console.error('Stage history API error:', error)
    return NextResponse.json(
      { error: 'failed', message: (error as Error).message },
      { status: 500 },
    )
  }
}
