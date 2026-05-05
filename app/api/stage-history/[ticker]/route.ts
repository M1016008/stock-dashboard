// app/api/stage-history/[ticker]/route.ts
// 指定銘柄について、過去 N 週分の各週末時点のステージを算出して返す。
// OHLCV を週末でスライスして MA を計算 → 6ステージ判定。

import { NextRequest, NextResponse } from 'next/server'
import { getHistory } from '@/lib/yahoo-finance'
import { buildMaValuesFromOhlcv, calculateAllStages } from '@/lib/hex-stage'

export const revalidate = 3600

interface StageHistoryEntry {
  date: string
  daily_a_stage: number | null
  daily_b_stage: number | null
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
  close: number
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ ticker: string }> },
) {
  try {
    const { ticker } = await params
    const decoded = decodeURIComponent(ticker)
    const { searchParams } = new URL(request.url)
    const weeks = Math.min(Number(searchParams.get('weeks') ?? '26'), 52)

    const history = await getHistory(decoded, '2y')
    if (history.length === 0) {
      return NextResponse.json({ ticker: decoded, history: [] })
    }

    const entries: StageHistoryEntry[] = []
    // 5営業日 = 1週、最新から weeks 週ぶん遡って各週末でスライス
    const stepDays = 5
    for (let weekIdx = weeks - 1; weekIdx >= 0; weekIdx--) {
      const offset = weekIdx * stepDays
      if (history.length <= offset) continue
      const sliced = history.slice(0, history.length - offset)
      if (sliced.length < 25) continue
      const ma = buildMaValuesFromOhlcv(sliced)
      const stages = calculateAllStages(ma)
      const last = sliced[sliced.length - 1]
      entries.push({
        date: last.date,
        close: last.close,
        ...stages,
      })
    }

    return NextResponse.json({
      ticker: decoded,
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
