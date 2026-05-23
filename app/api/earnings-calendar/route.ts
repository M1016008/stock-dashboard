// app/api/earnings-calendar/route.ts
// 決算カレンダー API。J-Quants/JPX公式から取り込んだ earnings_calendar を返す。
// クエリ:
//   - days: 何日後までを範囲に含めるか（デフォルト 30）
//   - past: true なら過去の決算（前回決算）も含める（デフォルト false）

import { NextRequest, NextResponse } from 'next/server'
import { execAll, execGet } from '@/lib/db/client'
import {
  attachEarningsSignalDecorations,
  loadEarningsSignalDecorations,
  type EarningsSignalDecoration,
} from '@/lib/signals/earnings-labels'

export const dynamic = 'force-dynamic'

export interface EarningsEntry extends EarningsSignalDecoration {
  date: string
  daysLeft: number
  kind: 'upcoming' | 'completed'
  ticker: string
  displayCode: string
  name: string
  sectorLarge: string | null
  marketSegment: string | null
  marginType: string | null
  marginAsOfDate: string | null
  longMargin: number | null
  shortMargin: number | null
  creditRatio: number | null
  shortRatio: number | null
  price: number | null
  marketCap: number | null
  postEarningsBaseDate: string | null
  postEarningsBasePrice: number | null
  postEarningsChangePct: number | null
  postEarningsTradingDays: number | null
  daily_a_stage: number | null
  daily_b_stage: number | null
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
}
type EarningsEntryBase = Omit<EarningsEntry, keyof EarningsSignalDecoration>

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const daysFwd = Math.max(1, Math.min(120, Number(searchParams.get('days') ?? 30)))
    const includePast = searchParams.get('past') === 'true'

    const latest = await execGet<{ d: string | null }>(`SELECT MAX(date) AS d FROM daily_snapshots`)
    const baseDate = latest?.d
    if (!baseDate) {
      return NextResponse.json({
        entries: [],
        snapshotDate: null,
        from: null,
        to: null,
        notice: 'J-Quants 由来の決算カレンダーまたは日次データが未取得です。最新化バッチを実行してください。',
      })
    }

    const range = await execGet<{ fromDate: string; toDate: string }>(
      `
      SELECT
        ${includePast ? `date(?, '-' || ? || ' days')` : '?'} AS fromDate,
        date(?, '+' || ? || ' days') AS toDate
      `,
      includePast ? [baseDate, daysFwd, baseDate, daysFwd] : [baseDate, baseDate, daysFwd],
    )
    const fromDate = range?.fromDate ?? baseDate
    const toDate = range?.toDate ?? baseDate

    const entries = await execAll<EarningsEntryBase>(
      `
      WITH cal AS (
        SELECT ticker, announce_date, company_name, sector_name, market_segment,
               CAST(julianday(announce_date) - julianday(?) AS INTEGER) AS daysLeft
        FROM earnings_calendar
        WHERE announce_date BETWEEN ? AND ?
      ),
      px AS (SELECT ticker, close FROM ohlcv_daily WHERE date = ?),
      st AS (SELECT * FROM daily_snapshots WHERE date = ?),
      first_trade AS (
        SELECT cal.ticker, MIN(od.date) AS base_date
        FROM cal
        JOIN ohlcv_daily od ON od.ticker = cal.ticker AND od.date >= cal.announce_date AND od.date <= ?
        WHERE cal.announce_date < ?
        GROUP BY cal.ticker
      ),
      first_px AS (
        SELECT ft.ticker, ft.base_date, od.close AS base_close
        FROM first_trade ft
        LEFT JOIN ohlcv_daily od ON od.ticker = ft.ticker AND od.date = ft.base_date
      )
      SELECT
        cal.announce_date AS date,
        cal.daysLeft,
        CASE WHEN cal.announce_date < ? THEN 'completed' ELSE 'upcoming' END AS kind,
        cal.ticker,
        cal.ticker AS displayCode,
        COALESCE(tu.name, cal.company_name, cal.ticker) AS name,
        COALESCE(tu.sector17_name, cal.sector_name) AS sectorLarge,
        COALESCE(tu.market_segment, cal.market_segment) AS marketSegment,
        COALESCE(tu.margin_type, sml.margin_type) AS marginType,
        sml.as_of_date AS marginAsOfDate,
        sml.long_margin AS longMargin,
        sml.short_margin AS shortMargin,
        sml.credit_ratio AS creditRatio,
        sml.short_ratio AS shortRatio,
        px.close AS price,
        CASE WHEN tu.shares_outstanding IS NOT NULL AND px.close IS NOT NULL THEN tu.shares_outstanding * px.close END AS marketCap,
        fp.base_date AS postEarningsBaseDate,
        fp.base_close AS postEarningsBasePrice,
        CASE WHEN fp.base_close > 0 THEN 100.0 * (px.close - fp.base_close) / fp.base_close END AS postEarningsChangePct,
        (
          SELECT COUNT(*) - 1
          FROM ohlcv_daily od
          WHERE od.ticker = cal.ticker AND fp.base_date IS NOT NULL AND od.date BETWEEN fp.base_date AND ?
        ) AS postEarningsTradingDays,
        st.daily_a_stage,
        st.daily_b_stage,
        st.weekly_a_stage,
        st.weekly_b_stage,
        st.monthly_a_stage,
        st.monthly_b_stage
      FROM cal
      LEFT JOIN ticker_universe tu ON tu.ticker = cal.ticker
      LEFT JOIN serving_margin_latest sml ON sml.ticker = cal.ticker
      LEFT JOIN px USING (ticker)
      LEFT JOIN st USING (ticker)
      LEFT JOIN first_px fp USING (ticker)
      ORDER BY cal.announce_date ASC, cal.ticker
      `,
      [baseDate, fromDate, toDate, baseDate, baseDate, baseDate, baseDate, baseDate, baseDate],
    )

    entries.sort((a, b) => a.date.localeCompare(b.date) || a.ticker.localeCompare(b.ticker))
    const signalDecorations = await loadEarningsSignalDecorations(entries.map((entry) => entry.ticker), baseDate)
    const decoratedEntries = attachEarningsSignalDecorations(entries, signalDecorations)

    return NextResponse.json({
      entries: decoratedEntries,
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
