// app/api/stage-history/[ticker]/route.ts
// Phase 3.5 で完全書き換え: Yahoo を呼んで都度 MA 計算する代わりに、
// 既に計算済みの daily_snapshots から直接読み出す。
//
// 動作: 日毎・週毎・月毎の表示粒度に応じて、過去のスナップショットを返す。
// Yahoo の `getHistory` も `buildMaValuesFromOhlcv` も不要。

import { NextRequest, NextResponse } from 'next/server'
import { db, execAll } from '@/lib/db/client'
import { dailySnapshots, ohlcvDaily } from '@/lib/db/schema'
import { getActiveSegmentStart, REQUIRED_ACTIVE_DAYS, stageWithEnoughHistory } from '@/lib/snapshots/continuous-ma'
import { normalizeMarket, normalizeTickerForMarket } from '@/lib/markets'
import { asc, eq } from 'drizzle-orm'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

interface StageHistoryEntry {
  date: string
  daily_a_stage: number | null
  daily_b_stage: number | null
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
  close: number | null
  ma_5: number | null
  ma_25: number | null
  ma_75: number | null
  ma_300: number | null
  weekly_ma_5: number | null
  weekly_ma_13: number | null
  weekly_ma_25: number | null
  monthly_ma_3: number | null
  monthly_ma_5: number | null
  monthly_ma_10: number | null
  monthly_ma_20: number | null
  monthly_ma_25: number | null
}

type Granularity = 'daily' | 'weekly' | 'monthly'
type SnapshotRow = Pick<typeof dailySnapshots.$inferSelect,
  | 'date'
  | 'ma_5'
  | 'ma_25'
  | 'ma_75'
  | 'ma_300'
  | 'weekly_ma_5'
  | 'weekly_ma_13'
  | 'weekly_ma_25'
  | 'monthly_ma_3'
  | 'monthly_ma_5'
  | 'monthly_ma_10'
  | 'monthly_ma_20'
  | 'monthly_ma_25'
  | 'daily_a_stage'
  | 'daily_b_stage'
  | 'weekly_a_stage'
  | 'weekly_b_stage'
  | 'monthly_a_stage'
  | 'monthly_b_stage'
>

const GRANULARITIES = new Set<Granularity>(['daily', 'weekly', 'monthly'])
const DEFAULT_COUNTS: Record<Granularity, number> = {
  daily: 60,
  weekly: 26,
  monthly: 24,
}
const MAX_COUNTS: Record<Granularity, number> = {
  daily: 250,
  weekly: 104,
  monthly: 120,
}
const RANGE_MAX_COUNT = 3000

function parseGranularity(value: string | null): Granularity {
  return value && GRANULARITIES.has(value as Granularity) ? value as Granularity : 'weekly'
}

function parseCount(value: string | null, fallback: number, max: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(Math.floor(parsed), max)
}

function parseIsoDate(value: string | null): string | null {
  if (!value) return null
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null
}

function sampleSnapshots(snapshots: SnapshotRow[], granularity: Granularity, count: number): SnapshotRow[] {
  if (granularity === 'daily') {
    return snapshots.slice(-count)
  }

  if (granularity === 'monthly') {
    const monthEnds: SnapshotRow[] = []
    for (const snap of snapshots) {
      const month = snap.date.slice(0, 7)
      const last = monthEnds[monthEnds.length - 1]
      if (!last || last.date.slice(0, 7) !== month) {
        monthEnds.push(snap)
      } else {
        monthEnds[monthEnds.length - 1] = snap
      }
    }
    return monthEnds.slice(-count)
  }

  const entries: SnapshotRow[] = []
  const stepDays = 5
  for (let idx = snapshots.length - 1 - (count - 1) * stepDays; idx < snapshots.length; idx += stepDays) {
    if (idx >= 0) entries.push(snapshots[idx])
  }
  return entries
}

function toStageHistoryEntry(snap: SnapshotRow, activeDays: number | null, close: number | null): StageHistoryEntry {
  return {
    date:             snap.date,
    daily_a_stage:    stageWithEnoughHistory(snap.daily_a_stage, activeDays, REQUIRED_ACTIVE_DAYS.daily_a_stage),
    daily_b_stage:    stageWithEnoughHistory(snap.daily_b_stage, activeDays, REQUIRED_ACTIVE_DAYS.daily_b_stage),
    weekly_a_stage:   stageWithEnoughHistory(snap.weekly_a_stage, activeDays, REQUIRED_ACTIVE_DAYS.weekly_a_stage),
    weekly_b_stage:   stageWithEnoughHistory(snap.weekly_b_stage, activeDays, REQUIRED_ACTIVE_DAYS.weekly_b_stage),
    monthly_a_stage:  stageWithEnoughHistory(snap.monthly_a_stage, activeDays, REQUIRED_ACTIVE_DAYS.monthly_a_stage),
    monthly_b_stage:  stageWithEnoughHistory(snap.monthly_b_stage, activeDays, REQUIRED_ACTIVE_DAYS.monthly_b_stage),
    close,
    ma_5:             snap.ma_5,
    ma_25:            snap.ma_25,
    ma_75:            snap.ma_75,
    ma_300:           snap.ma_300,
    weekly_ma_5:      snap.weekly_ma_5,
    weekly_ma_13:     snap.weekly_ma_13,
    weekly_ma_25:     snap.weekly_ma_25,
    monthly_ma_3:     snap.monthly_ma_3,
    monthly_ma_5:     snap.monthly_ma_5,
    monthly_ma_10:    snap.monthly_ma_10,
    monthly_ma_20:    snap.monthly_ma_20,
    monthly_ma_25:    snap.monthly_ma_25,
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ ticker: string }> },
) {
  try {
    const { ticker: rawTicker } = await params
    const { searchParams } = new URL(request.url)
    const market = normalizeMarket(searchParams.get('market'))
    const ticker = normalizeTickerForMarket(rawTicker, market)
    const granularity = parseGranularity(searchParams.get('granularity'))
    const rawStartDate = searchParams.get('startDate')
    const rawEndDate = searchParams.get('endDate')
    const startDate = parseIsoDate(rawStartDate)
    const endDate = parseIsoDate(rawEndDate)
    if ((rawStartDate && !startDate) || (rawEndDate && !endDate)) {
      return NextResponse.json({ error: 'invalid_date', message: 'startDate/endDate must be YYYY-MM-DD' }, { status: 400 })
    }
    if (startDate && endDate && startDate > endDate) {
      return NextResponse.json({ error: 'invalid_range', message: 'startDate must be before endDate' }, { status: 400 })
    }
    const hasDateRange = Boolean(startDate && endDate)
    const countParam = searchParams.get('count') ?? (granularity === 'weekly' ? searchParams.get('weeks') : null)
    const count = parseCount(
      countParam,
      hasDateRange ? RANGE_MAX_COUNT : DEFAULT_COUNTS[granularity],
      hasDateRange ? RANGE_MAX_COUNT : MAX_COUNTS[granularity],
    )

    // 該当銘柄の snapshot を日付昇順で全件取得
    const all: SnapshotRow[] = market === 'US'
      ? await execAll<SnapshotRow>(
        `
          SELECT
            date,
            ma_5,
            ma_25,
            ma_75,
            ma_300,
            weekly_ma_5,
            weekly_ma_13,
            weekly_ma_25,
            monthly_ma_3,
            monthly_ma_5,
            monthly_ma_10,
            monthly_ma_20,
            monthly_ma_25,
            daily_a_stage,
            daily_b_stage,
            weekly_a_stage,
            weekly_b_stage,
            monthly_a_stage,
            monthly_b_stage
          FROM market_daily_snapshots
          WHERE market = 'US'
            AND ticker = ?
          ORDER BY date
        `,
        [ticker],
      )
      : await db
        .select({
          date: dailySnapshots.date,
          ma_5: dailySnapshots.ma_5,
          ma_25: dailySnapshots.ma_25,
          ma_75: dailySnapshots.ma_75,
          ma_300: dailySnapshots.ma_300,
          weekly_ma_5: dailySnapshots.weekly_ma_5,
          weekly_ma_13: dailySnapshots.weekly_ma_13,
          weekly_ma_25: dailySnapshots.weekly_ma_25,
          monthly_ma_3: dailySnapshots.monthly_ma_3,
          monthly_ma_5: dailySnapshots.monthly_ma_5,
          monthly_ma_10: dailySnapshots.monthly_ma_10,
          monthly_ma_20: dailySnapshots.monthly_ma_20,
          monthly_ma_25: dailySnapshots.monthly_ma_25,
          daily_a_stage: dailySnapshots.daily_a_stage,
          daily_b_stage: dailySnapshots.daily_b_stage,
          weekly_a_stage: dailySnapshots.weekly_a_stage,
          weekly_b_stage: dailySnapshots.weekly_b_stage,
          monthly_a_stage: dailySnapshots.monthly_a_stage,
          monthly_b_stage: dailySnapshots.monthly_b_stage,
        })
        .from(dailySnapshots)
        .where(eq(dailySnapshots.ticker, ticker))
        .orderBy(asc(dailySnapshots.date))

    if (all.length === 0) {
      return NextResponse.json({ ticker, history: [], total: 0 })
    }

    // コード再利用・再上場などで長い空白がある銘柄は、直近の連続データだけで表示する。
    // 例: 5016 は 2010 年から 2025 年まで大きなギャップがあり、旧データを混ぜると長期MAが過大に埋まる。
    const priceRows = market === 'US'
      ? await execAll<{ date: string; close: number }>(
        `
          SELECT date, COALESCE(adj_close, close) AS close
          FROM market_ohlcv_daily
          WHERE market = 'US'
            AND ticker = ?
          ORDER BY date
        `,
        [ticker],
      )
      : await db
        .select({ date: ohlcvDaily.date, close: ohlcvDaily.close })
        .from(ohlcvDaily)
        .where(eq(ohlcvDaily.ticker, ticker))
        .orderBy(asc(ohlcvDaily.date))

    const priceDates = priceRows.map((row) => ({ date: row.date }))
    const closeByDate = new Map(priceRows.map((row) => [row.date, row.close]))
    const firstPriceDate = priceRows[0]?.date ?? null
    const activeStartDate = getActiveSegmentStart(priceRows)
    const displayActiveStartDate =
      activeStartDate && firstPriceDate && activeStartDate !== firstPriceDate
        ? activeStartDate
        : null
    const activePriceDates = activeStartDate
      ? priceDates.filter((row) => row.date >= activeStartDate)
      : priceDates
    const activeDayByDate = new Map(activePriceDates.map((row, index) => [row.date, index + 1]))
    const snapshots = activeStartDate
      ? all.filter((snap) => snap.date >= activeStartDate)
      : all

    if (snapshots.length === 0) {
      return NextResponse.json({ ticker, history: [], total: 0, activeStartDate: displayActiveStartDate })
    }

    const selectedSnapshots = hasDateRange && startDate && endDate
      ? snapshots.filter((snap) => snap.date >= startDate && snap.date <= endDate).slice(-count)
      : sampleSnapshots(snapshots, granularity, count)

    const entries = selectedSnapshots.map((snap) => {
      const activeDays = activeDayByDate.get(snap.date) ?? null
      return toStageHistoryEntry(snap, activeDays, closeByDate.get(snap.date) ?? null)
    })

    return NextResponse.json({
      ticker,
      market,
      history: entries,
      total: entries.length,
      granularity,
      count,
      requestedRange: hasDateRange ? { startDate, endDate } : null,
      activeStartDate: displayActiveStartDate,
    })
  } catch (error) {
    console.error('Stage history API error:', error)
    return NextResponse.json(
      { error: 'failed', message: (error as Error).message },
      { status: 500 },
    )
  }
}
