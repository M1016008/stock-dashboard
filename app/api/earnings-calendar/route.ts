// app/api/earnings-calendar/route.ts
// 決算カレンダー API。最新の tv_daily_snapshots から、指定範囲内に決算発表予定のある銘柄を返す。
// クエリ:
//   - days: 何日後までを範囲に含めるか（デフォルト 30）
//   - past: true なら過去の決算（前回決算）も含める（デフォルト false）

import { NextRequest, NextResponse } from 'next/server'
import { sqlite } from '@/lib/db/client'
import { findTicker } from '@/lib/master/tickers'
import { calculateAllStages, type MaValues } from '@/lib/hex-stage'

export const dynamic = 'force-dynamic'

interface SnapshotRow {
  ticker: string
  name: string
  price: number | null
  market_cap: number | null
  earnings_last_date: string | null
  earnings_next_date: string | null
  sma_5d: number | null
  sma_25d: number | null
  sma_75d: number | null
  sma_150d: number | null
  sma_300d: number | null
  sma_5w: number | null
  sma_13w: number | null
  sma_25w: number | null
  sma_50w: number | null
  sma_100w: number | null
  sma_3m: number | null
  sma_5m: number | null
  sma_10m: number | null
  sma_20m: number | null
  sma_25m: number | null
}

export interface EarningsEntry {
  date: string
  ticker: string
  displayCode: string
  name: string
  sectorLarge: string | null
  marketSegment: string | null
  price: number | null
  marketCap: number | null
  daily_a_stage: number | null
  daily_b_stage: number | null
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
}

function todayStr(): string {
  return new Date().toISOString().split('T')[0]
}

function offsetDate(base: string, days: number): string {
  const d = new Date(base)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().split('T')[0]
}

function snapshotToMa(s: SnapshotRow): MaValues {
  return {
    ma_5: s.sma_5d, ma_25: s.sma_25d, ma_75: s.sma_75d, ma_150: s.sma_150d, ma_300: s.sma_300d,
    weekly_ma_5: s.sma_5w, weekly_ma_13: s.sma_13w, weekly_ma_25: s.sma_25w,
    weekly_ma_50: s.sma_50w, weekly_ma_100: s.sma_100w,
    monthly_ma_3: s.sma_3m, monthly_ma_5: s.sma_5m, monthly_ma_10: s.sma_10m,
    monthly_ma_20: s.sma_20m, monthly_ma_25: s.sma_25m,
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const daysFwd = Math.max(1, Math.min(120, Number(searchParams.get('days') ?? 30)))
    const includePast = searchParams.get('past') === 'true'

    const latest = sqlite
      .prepare<unknown[], { d: string | null }>(`SELECT MAX(date) AS d FROM tv_daily_snapshots`)
      .get()
    const baseDate = latest?.d
    if (!baseDate) {
      return NextResponse.json({
        entries: [],
        snapshotDate: null,
        from: null,
        to: null,
        notice: 'CSV未取込です。/admin/import から TradingView の CSV をインポートしてください。',
      })
    }

    const today = todayStr()
    const fromDate = today
    const toDate = offsetDate(today, daysFwd)

    const rows = sqlite
      .prepare<unknown[], SnapshotRow>(
        `SELECT ticker, name, price, market_cap,
                earnings_last_date, earnings_next_date,
                sma_5d, sma_25d, sma_75d, sma_150d, sma_300d,
                sma_5w, sma_13w, sma_25w, sma_50w, sma_100w,
                sma_3m, sma_5m, sma_10m, sma_20m, sma_25m
         FROM tv_daily_snapshots
         WHERE date = ?`,
      )
      .all(baseDate)

    const entries: EarningsEntry[] = []
    for (const r of rows) {
      const stages = calculateAllStages(snapshotToMa(r))
      const master = findTicker(r.ticker)
      const displayCode = r.ticker.replace(/\.T$/, '')

      const candidates: Array<{ date: string | null; kind: 'next' | 'last' }> = [
        { date: r.earnings_next_date, kind: 'next' },
      ]
      if (includePast) candidates.push({ date: r.earnings_last_date, kind: 'last' })

      for (const c of candidates) {
        if (!c.date) continue
        // ISO 形式以外は弾く
        if (!/^\d{4}-\d{2}-\d{2}$/.test(c.date)) continue
        if (c.kind === 'next') {
          if (c.date < fromDate || c.date > toDate) continue
        } else {
          // 過去30日以内
          if (c.date < offsetDate(today, -daysFwd) || c.date > today) continue
        }
        entries.push({
          date: c.date,
          ticker: r.ticker,
          displayCode,
          name: r.name,
          sectorLarge: master?.sectorLarge ?? null,
          marketSegment: master?.marketSegment ?? null,
          price: r.price,
          marketCap: r.market_cap,
          daily_a_stage: stages.daily_a_stage,
          daily_b_stage: stages.daily_b_stage,
          weekly_a_stage: stages.weekly_a_stage,
          weekly_b_stage: stages.weekly_b_stage,
          monthly_a_stage: stages.monthly_a_stage,
          monthly_b_stage: stages.monthly_b_stage,
        })
      }
    }

    entries.sort((a, b) => a.date.localeCompare(b.date) || a.ticker.localeCompare(b.ticker))

    return NextResponse.json({
      entries,
      snapshotDate: baseDate,
      from: fromDate,
      to: toDate,
    })
  } catch (error) {
    console.error('earnings-calendar error:', error)
    return NextResponse.json(
      { error: 'Failed', message: (error as Error).message },
      { status: 500 },
    )
  }
}
