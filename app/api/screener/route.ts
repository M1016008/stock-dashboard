// app/api/screener/route.ts
// マルチ軸スクリーナー API。
// データソース: tv_daily_snapshots テーブル（TradingView CSV取込結果）
//   - market: JP のみ対応（CSVは日本株想定）
//   - segment: プライム/スタンダード/グロース（マスタから絞り込み）
//   - daily_a / daily_b / weekly_a / weekly_b / monthly_a / monthly_b:
//       各系統で 1..6 を指定（カンマ区切りで複数指定可、例: daily_a=1,2,3）
// 軸内は OR、軸間は AND で絞り込む。

import { NextRequest, NextResponse } from 'next/server'
import { execAll, execGet } from '@/lib/db/client'
import { getTickersByMarket } from '@/lib/master/tickers'
import { calculateAllStages, type MaValues } from '@/lib/hex-stage'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

interface SnapshotRow {
  date: string
  ticker: string
  name: string
  price: number | null
  currency: string | null
  change_percent_1d: number | null
  volume_1d: number | null
  avg_volume_10d: number | null
  avg_volume_30d: number | null
  market_cap: number | null
  market_cap_currency: string | null
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
  market: 'JP'
  marketSegment: string
  marginType?: string
  sectorLarge: string
  sectorSmall: string | null
  sector33: string | null
  price: number | null
  currency: string | null
  changePercent: number | null
  changePercentWeek: number | null
  changePercentMonth: number | null
  perfPct3m: number | null
  perfPct6m: number | null
  perfPctYtd: number | null
  volume: number | null
  avgVolume10d: number | null
  avgVolume30d: number | null
  marketCap: number | null
  marketCapCurrency: string | null
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

async function latestSnapshotDate(): Promise<string | null> {
  const row = await execGet<{ d: string | null }>(`SELECT MAX(date) AS d FROM tv_daily_snapshots`)
  return row?.d ?? null
}

async function loadSnapshotByDate(date: string): Promise<SnapshotRow[]> {
  return execAll<SnapshotRow>(`SELECT * FROM tv_daily_snapshots WHERE date = ?`, [date])
}

/**
 * 短期SMAと長期SMAの差から「角度」を算出する。
 * 直角三角形を考え、隣辺=長期SMA、対辺=(短期SMA-長期SMA) として
 * 傾き = (短期 - 長期) / 長期 を求め、atan() で角度（度）に変換する。
 *  例) 5% 上向き → atan(0.05) ≒ 2.86°
 *      30% 上向き → atan(0.30) ≒ 16.7°
 */
function smaAngleDegrees(shortSma: number | null, longSma: number | null): number | null {
  if (shortSma == null || longSma == null || longSma === 0) return null
  const slope = (shortSma - longSma) / longSma
  return Math.atan(slope) * (180 / Math.PI)
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

interface SectorEntry {
  sectorLarge: string | null
  sectorSmall: string | null
  sector33: string | null
  marketSegment: string | null
  marginType: string | null
}

async function loadSectorMap(): Promise<Map<string, SectorEntry>> {
  const rows = await execAll<{
    ticker: string
    sector_large: string | null
    sector_small: string | null
    sector33: string | null
    market_segment: string | null
    margin_type: string | null
  }>(
    `SELECT ticker, sector_large, sector_small, sector33, market_segment, margin_type FROM sector_master`,
  )
  const map = new Map<string, SectorEntry>()
  for (const r of rows) {
    map.set(r.ticker, {
      sectorLarge: r.sector_large,
      sectorSmall: r.sector_small,
      sector33: r.sector33,
      marketSegment: r.market_segment,
      marginType: r.margin_type,
    })
  }
  return map
}

function buildResultRow(s: SnapshotRow, sectorMap: Map<string, SectorEntry>): ScreenerStockRow | null {
  const master = getTickersByMarket('JP').find((t) => t.ticker === s.ticker)
  const fromDb = sectorMap.get(s.ticker)
  // セクター情報は sector_master DB → ハードコード master → 'その他' の順で参照する。
  // 大分類が 'その他' に落ちた場合は小分類も 'その他' で埋める（空欄回避）。
  const stages = calculateAllStages(snapshotToMaValues(s))
  const sectorLarge = fromDb?.sectorLarge ?? master?.sectorLarge ?? 'その他'
  let sectorSmall = fromDb?.sectorSmall ?? master?.sectorSmall ?? null
  if (sectorLarge === 'その他' && !sectorSmall) sectorSmall = 'その他'
  const sector33 = fromDb?.sector33 ?? null
  const marketSegment = fromDb?.marketSegment ?? master?.marketSegment ?? ''
  return {
    ticker: s.ticker,
    name: s.name,
    market: 'JP',
    marketSegment,
    marginType: fromDb?.marginType ?? master?.marginType,
    sectorLarge,
    sectorSmall,
    sector33,
    price: s.price,
    currency: s.currency,
    changePercent: s.change_percent_1d,
    changePercentWeek: s.perf_pct_1w,
    changePercentMonth: s.perf_pct_1m,
    perfPct3m: s.perf_pct_3m,
    perfPct6m: s.perf_pct_6m,
    perfPctYtd: s.perf_pct_ytd,
    volume: s.volume_1d,
    avgVolume10d: s.avg_volume_10d,
    avgVolume30d: s.avg_volume_30d,
    marketCap: s.market_cap,
    marketCapCurrency: s.market_cap_currency,
    per: s.per,
    dividendYield: s.dividend_yield_pct,
    // SMA角度: atan で実際の角度（度）に変換
    sma25Angle: smaAngleDegrees(s.sma_5d, s.sma_25d),
    sma75Angle: smaAngleDegrees(s.sma_25d, s.sma_75d),
    earningsLastDate: s.earnings_last_date,
    earningsNextDate: s.earnings_next_date,
    ...stages,
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    // 当ダッシュボードは日本株専用。market パラメタは互換のため受け取るだけ。
    const segment = searchParams.get('segment')
    const requestedDate = searchParams.get('date')

    const date = requestedDate ?? (await latestSnapshotDate())
    if (!date) {
      return NextResponse.json({
        results: [],
        total: 0,
        universe: 0,
        date: null,
        cached: false,
        source: 'csv',
        notice: 'CSV未取込です。/admin/import から TradingView の CSV をインポートしてください。',
        filters: { segment },
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

    const [snapshots, sectorMap] = await Promise.all([
      loadSnapshotByDate(date),
      loadSectorMap(),
    ])
    const universe = snapshots.length
    const built = snapshots
      .map((s) => buildResultRow(s, sectorMap))
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
      filters: { segment, ...stageFilter },
    })
  } catch (error) {
    console.error('Screener API error:', error)
    return NextResponse.json(
      { error: 'Screener failed', message: (error as Error).message },
      { status: 500 },
    )
  }
}
