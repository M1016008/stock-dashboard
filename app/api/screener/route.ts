// app/api/screener/route.ts
// マルチ軸スクリーナー API。
// データソース: tv_daily_snapshots テーブル（TradingView CSV取込結果）
//   - market: JP のみ対応（CSVは日本株想定）
//   - segment: プライム/スタンダード/グロース（マスタから絞り込み）
//   - daily_a / daily_b / weekly_a / weekly_b / monthly_a / monthly_b:
//       各系統で 1..6 を指定（カンマ区切りで複数指定可、例: daily_a=1,2,3）
// 軸内は OR、軸間は AND で絞り込む。

import { NextRequest, NextResponse } from 'next/server'
import { sqlite } from '@/lib/db/client'
import { getTickersByMarket } from '@/lib/master/tickers'
import { calculateAllStages, type MaValues } from '@/lib/hex-stage'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

interface SnapshotRow {
  date: string
  ticker: string
  name: string
  price: number | null
  change_percent_1d: number | null
  volume_1d: number | null
  avg_volume_10d: number | null
  market_cap: number | null
  per: number | null
  dividend_yield_pct: number | null
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
  earnings_last_date: string | null
  earnings_next_date: string | null
}

interface ScreenerStockRow {
  ticker: string
  name: string
  market: 'JP' | 'US'
  marketSegment: string
  marginType?: string
  sectorLarge: string
  price: number | null
  changePercent: number | null
  changePercentWeek: number | null
  changePercentMonth: number | null
  perfPct3m: number | null
  perfPct6m: number | null
  perfPctYtd: number | null
  volume: number | null
  marketCap: number | null
  per: number | null
  dividendYield: number | null
  sma25Angle: number | null
  sma75Angle: number | null
  earningsLastDate: string | null
  earningsNextDate: string | null
  daily_a_stage: number | null
  daily_b_stage: number | null
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
}

const STAGE_KEYS = [
  'daily_a_stage',
  'daily_b_stage',
  'weekly_a_stage',
  'weekly_b_stage',
  'monthly_a_stage',
  'monthly_b_stage',
] as const

const STAGE_PARAM_MAP: Record<string, typeof STAGE_KEYS[number]> = {
  daily_a: 'daily_a_stage',
  daily_b: 'daily_b_stage',
  weekly_a: 'weekly_a_stage',
  weekly_b: 'weekly_b_stage',
  monthly_a: 'monthly_a_stage',
  monthly_b: 'monthly_b_stage',
}

function latestSnapshotDate(): string | null {
  const row = sqlite
    .prepare<unknown[], { d: string | null }>(`SELECT MAX(date) AS d FROM tv_daily_snapshots`)
    .get()
  return row?.d ?? null
}

function loadSnapshotByDate(date: string): SnapshotRow[] {
  return sqlite
    .prepare<unknown[], SnapshotRow>(`SELECT * FROM tv_daily_snapshots WHERE date = ?`)
    .all(date)
}

function pctAngle(curr: number | null, prev: number | null): number | null {
  if (curr == null || prev == null || prev === 0) return null
  return ((curr - prev) / prev) * 100
}

function snapshotToMaValues(s: SnapshotRow): MaValues {
  return {
    ma_5: s.sma_5d,
    ma_25: s.sma_25d,
    ma_75: s.sma_75d,
    ma_150: s.sma_150d,
    ma_300: s.sma_300d,
    weekly_ma_5: s.sma_5w,
    weekly_ma_13: s.sma_13w,
    weekly_ma_25: s.sma_25w,
    weekly_ma_50: s.sma_50w,
    weekly_ma_100: s.sma_100w,
    monthly_ma_3: s.sma_3m,
    monthly_ma_5: s.sma_5m,
    monthly_ma_10: s.sma_10m,
    monthly_ma_20: s.sma_20m,
    monthly_ma_25: s.sma_25m,
  }
}

function buildResultRow(s: SnapshotRow): ScreenerStockRow | null {
  const master = getTickersByMarket('JP').find((t) => t.ticker === s.ticker)
  // マスタに無い銘柄も許容（CSVをそのまま使う）。区分等は不明とする。
  const stages = calculateAllStages(snapshotToMaValues(s))
  return {
    ticker: s.ticker,
    name: s.name,
    market: 'JP',
    marketSegment: master?.marketSegment ?? '',
    marginType: master?.marginType,
    sectorLarge: master?.sectorLarge ?? 'その他',
    price: s.price,
    changePercent: s.change_percent_1d,
    changePercentWeek: s.perf_pct_1w,
    changePercentMonth: s.perf_pct_1m,
    perfPct3m: s.perf_pct_3m,
    perfPct6m: s.perf_pct_6m,
    perfPctYtd: s.perf_pct_ytd,
    volume: s.volume_1d,
    marketCap: s.market_cap,
    per: s.per,
    dividendYield: s.dividend_yield_pct,
    // SMA角度: 短期SMAと長期SMAの差を％で表示
    sma25Angle: pctAngle(s.sma_5d, s.sma_25d),
    sma75Angle: pctAngle(s.sma_25d, s.sma_75d),
    earningsLastDate: s.earnings_last_date,
    earningsNextDate: s.earnings_next_date,
    ...stages,
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const market = (searchParams.get('market') ?? 'JP') as 'JP' | 'US' | 'ALL'
    const segment = searchParams.get('segment')
    const requestedDate = searchParams.get('date')

    if (market === 'US') {
      return NextResponse.json({
        results: [],
        total: 0,
        universe: 0,
        date: null,
        cached: true,
        source: 'csv',
        notice: 'US は CSV 未対応です（TradingView から日本株 CSV を取込中）',
        filters: { market, segment },
      })
    }

    const date = requestedDate ?? latestSnapshotDate()
    if (!date) {
      return NextResponse.json({
        results: [],
        total: 0,
        universe: 0,
        date: null,
        cached: false,
        source: 'csv',
        notice: 'CSV未取込です。/admin/import から TradingView の CSV をインポートしてください。',
        filters: { market, segment },
      })
    }

    // 6系統のステージフィルタ（軸内 OR / 軸間 AND）
    const stageFilter: Partial<Record<typeof STAGE_KEYS[number], number[]>> = {}
    for (const [param, key] of Object.entries(STAGE_PARAM_MAP)) {
      const raw = searchParams.get(param)
      if (!raw) continue
      const stages = raw
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= 6)
      if (stages.length > 0) stageFilter[key] = Array.from(new Set(stages)).sort()
    }

    const snapshots = loadSnapshotByDate(date)
    const universe = snapshots.length
    const built = snapshots
      .map(buildResultRow)
      .filter((r): r is ScreenerStockRow => r !== null)

    let filtered = built
    if (segment) filtered = filtered.filter((r) => r.marketSegment === segment)

    for (const [key, vals] of Object.entries(stageFilter)) {
      filtered = filtered.filter((r) => {
        const stage = (r as unknown as Record<string, unknown>)[key]
        return typeof stage === 'number' && (vals as number[]).includes(stage)
      })
    }

    return NextResponse.json({
      results: filtered,
      total: filtered.length,
      universe,
      date,
      cached: true,
      source: 'csv',
      filters: { market, segment, ...stageFilter },
    })
  } catch (error) {
    console.error('Screener API error:', error)
    return NextResponse.json(
      { error: 'Screener failed', message: (error as Error).message },
      { status: 500 },
    )
  }
}
