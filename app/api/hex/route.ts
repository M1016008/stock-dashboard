// app/api/hex/route.ts
// HEX-app 互換 API。tv_daily_snapshots（CSV取込結果）からステージを算出して返す。
// 前週/前々週のステージとSMA角度は、過去のCSVスナップショットがDBに存在すれば自動的に埋まる。

import { NextRequest, NextResponse } from 'next/server'
import { execAll, execGet } from '@/lib/db/client'
import { findTicker, getSectorLarge } from '@/lib/master/tickers'
import {
  calculateAllStages,
  calculateAngle,
  type MaValues,
  type StageResult,
} from '@/lib/hex-stage'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

interface SnapshotRow {
  date: string
  ticker: string
  name: string
  price: number | null
  market_cap: number | null
  change_percent_1d: number | null
  perf_pct_1w: number | null
  perf_pct_1m: number | null
  perf_pct_3m: number | null
  perf_pct_6m: number | null
  perf_pct_ytd: number | null
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

interface HexStock {
  code: string
  name: string
  sector_large: string
  sector_small: string | null
  market_cap: number
  price: number
  daily_change: number
  weekly_change: number
  monthly_change: number
  months3_change: number
  months6_change: number
  ytd_change: number
  stage: number
  stage_a: number | null
  stage_b: number | null
  daily_a_stage: number | null
  daily_b_stage: number | null
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
  prev_daily_a_stage: number | null
  prev_daily_b_stage: number | null
  prev_weekly_a_stage: number | null
  prev_weekly_b_stage: number | null
  prev_monthly_a_stage: number | null
  prev_monthly_b_stage: number | null
  prev_prev_daily_a_stage: number | null
  prev_prev_daily_b_stage: number | null
  prev_prev_weekly_a_stage: number | null
  prev_prev_weekly_b_stage: number | null
  prev_prev_monthly_a_stage: number | null
  prev_prev_monthly_b_stage: number | null
  sma_angles: { sma5: number | null; sma25: number | null; sma75: number | null; sma300: number | null }
  prev_sma_angles: { sma5: number | null; sma25: number | null; sma75: number | null; sma300: number | null }
  prev_prev_sma_angles: { sma5: number | null; sma25: number | null; sma75: number | null; sma300: number | null }
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

function applyTimeframeStage(rows: HexStock[], timeframe: 'daily' | 'weekly' | 'monthly'): HexStock[] {
  return rows.map((r) => {
    let stage = r.stage
    if (timeframe === 'weekly') stage = r.weekly_a_stage ?? r.stage
    else if (timeframe === 'monthly') stage = r.monthly_a_stage ?? r.stage
    else stage = r.daily_a_stage ?? r.stage
    return { ...r, stage }
  })
}

const ALL_FIELDS = `
  date, ticker, name, price, market_cap, change_percent_1d,
  perf_pct_1w, perf_pct_1m, perf_pct_3m, perf_pct_6m, perf_pct_ytd,
  sma_5d, sma_25d, sma_75d, sma_150d, sma_300d,
  sma_5w, sma_13w, sma_25w, sma_50w, sma_100w,
  sma_3m, sma_5m, sma_10m, sma_20m, sma_25m
`

async function loadSnapshotsForDate(date: string): Promise<SnapshotRow[]> {
  return execAll<SnapshotRow>(`SELECT ${ALL_FIELDS} FROM tv_daily_snapshots WHERE date = ?`, [date])
}

/** date より前にある日付のうち最も近いものを返す。無ければ null。 */
async function prevDate(beforeDate: string): Promise<string | null> {
  const r = await execGet<{ d: string | null }>(
    `SELECT date AS d FROM tv_daily_snapshots WHERE date < ? GROUP BY date ORDER BY date DESC LIMIT 1`,
    [beforeDate],
  )
  return r?.d ?? null
}

async function latestSnapshotDate(): Promise<string | null> {
  const row = await execGet<{ d: string | null }>(`SELECT MAX(date) AS d FROM tv_daily_snapshots`)
  return row?.d ?? null
}

function indexByTicker(rows: SnapshotRow[]): Map<string, SnapshotRow> {
  const m = new Map<string, SnapshotRow>()
  for (const r of rows) m.set(r.ticker, r)
  return m
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const market = (searchParams.get('market') ?? 'JP') as 'JP' | 'US' | 'ALL'
    const timeframe = (searchParams.get('timeframe') ?? 'daily') as 'daily' | 'weekly' | 'monthly'
    const requestedDate = searchParams.get('date')

    if (market === 'US') {
      return NextResponse.json({
        success: true,
        data: [],
        count: 0,
        cached: true,
        date: null,
        timeframe,
        market,
        notice: 'US は CSV 未対応です（TradingView から日本株 CSV を取込中）',
      })
    }

    const date = requestedDate ?? (await latestSnapshotDate())
    if (!date) {
      return NextResponse.json({
        success: true,
        data: [],
        count: 0,
        cached: false,
        date: null,
        timeframe,
        market,
        notice: 'CSV未取込です。/admin/import から TradingView の CSV をインポートしてください。',
      })
    }

    const current = await loadSnapshotsForDate(date)
    const prev1Date = await prevDate(date)
    const prev2Date = prev1Date ? await prevDate(prev1Date) : null
    const [prev1Map, prev2Map, sectorRows] = await Promise.all([
      prev1Date ? loadSnapshotsForDate(prev1Date).then(indexByTicker) : Promise.resolve(new Map<string, SnapshotRow>()),
      prev2Date ? loadSnapshotsForDate(prev2Date).then(indexByTicker) : Promise.resolve(new Map<string, SnapshotRow>()),
      execAll<{ ticker: string; sector_large: string | null; sector_small: string | null }>(
        `SELECT ticker, sector_large, sector_small FROM sector_master`,
      ),
    ])
    const sectorMap = new Map<string, { large: string | null; small: string | null }>()
    for (const r of sectorRows) sectorMap.set(r.ticker, { large: r.sector_large, small: r.sector_small })

    const rows: HexStock[] = current.map((s) => {
      const master = findTicker(s.ticker)
      const stages = calculateAllStages(snapshotToMa(s))
      const p1 = prev1Map.get(s.ticker)
      const p2 = prev2Map.get(s.ticker)
      const stagesPrev: StageResult = p1
        ? calculateAllStages(snapshotToMa(p1))
        : { daily_a_stage: null, daily_b_stage: null, weekly_a_stage: null, weekly_b_stage: null, monthly_a_stage: null, monthly_b_stage: null }
      const stagesPrevPrev: StageResult = p2
        ? calculateAllStages(snapshotToMa(p2))
        : { daily_a_stage: null, daily_b_stage: null, weekly_a_stage: null, weekly_b_stage: null, monthly_a_stage: null, monthly_b_stage: null }

      // SMA角度: 直近の SMA と (この snapshot に対する) 過去の SMA を比較。
      // 期間は HEX-app と合わせる（3 / 10 / 20 営業日のオフセット）
      const angle = (curr: number | null, past: number | null | undefined, days: number) =>
        calculateAngle(curr, past ?? null, days)
      const smaAngles = {
        sma5: angle(s.sma_5d, p1?.sma_5d, 3),
        sma25: angle(s.sma_25d, p1?.sma_25d, 3),
        sma75: angle(s.sma_75d, p1?.sma_75d, 3),
        sma300: angle(s.sma_300d, p1?.sma_300d, 3),
      }
      const prevSmaAngles = {
        sma5: angle(s.sma_5d, p2?.sma_5d, 10),
        sma25: angle(s.sma_25d, p2?.sma_25d, 10),
        sma75: angle(s.sma_75d, p2?.sma_75d, 10),
        sma300: angle(s.sma_300d, p2?.sma_300d, 10),
      }

      const fromDb = sectorMap.get(s.ticker)
      const sectorLarge = fromDb?.large ?? (master ? getSectorLarge(master) : 'その他')
      let sectorSmall: string | null = fromDb?.small ?? master?.sectorSmall ?? null
      // 大分類が 'その他' なら小分類も 'その他' に揃える（空欄回避）。
      if (sectorLarge === 'その他' && !sectorSmall) sectorSmall = 'その他'
      return {
        code: s.ticker,
        name: s.name,
        sector_large: sectorLarge,
        sector_small: sectorSmall,
        market_cap: s.market_cap ?? 0,
        price: s.price ?? 0,
        daily_change: s.change_percent_1d ?? 0,
        weekly_change: s.perf_pct_1w ?? 0,
        monthly_change: s.perf_pct_1m ?? 0,
        months3_change: s.perf_pct_3m ?? 0,
        months6_change: s.perf_pct_6m ?? 0,
        ytd_change: s.perf_pct_ytd ?? 0,
        stage: stages.daily_a_stage ?? 1,
        stage_a: stages.daily_a_stage,
        stage_b: stages.daily_b_stage,
        daily_a_stage: stages.daily_a_stage,
        daily_b_stage: stages.daily_b_stage,
        weekly_a_stage: stages.weekly_a_stage,
        weekly_b_stage: stages.weekly_b_stage,
        monthly_a_stage: stages.monthly_a_stage,
        monthly_b_stage: stages.monthly_b_stage,
        prev_daily_a_stage: stagesPrev.daily_a_stage,
        prev_daily_b_stage: stagesPrev.daily_b_stage,
        prev_weekly_a_stage: stagesPrev.weekly_a_stage,
        prev_weekly_b_stage: stagesPrev.weekly_b_stage,
        prev_monthly_a_stage: stagesPrev.monthly_a_stage,
        prev_monthly_b_stage: stagesPrev.monthly_b_stage,
        prev_prev_daily_a_stage: stagesPrevPrev.daily_a_stage,
        prev_prev_daily_b_stage: stagesPrevPrev.daily_b_stage,
        prev_prev_weekly_a_stage: stagesPrevPrev.weekly_a_stage,
        prev_prev_weekly_b_stage: stagesPrevPrev.weekly_b_stage,
        prev_prev_monthly_a_stage: stagesPrevPrev.monthly_a_stage,
        prev_prev_monthly_b_stage: stagesPrevPrev.monthly_b_stage,
        sma_angles: smaAngles,
        prev_sma_angles: prevSmaAngles,
        prev_prev_sma_angles: prevSmaAngles, // データが無い場合に備えて一旦同じ値
      }
    })

    const data = applyTimeframeStage(rows, timeframe)

    return NextResponse.json({
      success: true,
      data,
      count: data.length,
      cached: true,
      date,
      timeframe,
      market,
      source: 'csv',
    })
  } catch (error) {
    console.error('Hex API error:', error)
    return NextResponse.json(
      { error: 'Hex map fetch failed', message: (error as Error).message },
      { status: 500 },
    )
  }
}
