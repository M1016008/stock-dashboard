// app/api/hex/route.ts
//
// HEX マップ API。Phase 4 改修以降は J-Quants 由来データ (daily_snapshots + ohlcv_daily +
// ticker_universe + stock_classification) を直接使う。
// TradingView CSV (tv_daily_snapshots) には依存しない。
//
// 入力:
//   - timeframe: 'daily' | 'weekly' | 'monthly' (現状は HexMap が daily を使うだけ)
//   - date: 'YYYY-MM-DD' (未指定なら最新)
// 出力: HexMap が期待する Stock[] 形 + date / count

import { NextRequest, NextResponse } from 'next/server'
import { gzipSync } from 'zlib'
import { execAll, execGet } from '@/lib/db/client'
import { filterRowsByUniverse, parseUniverseFilter, universeSqlCondition, UNIVERSE_FILTER_PARAM } from '@/lib/market-universe'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// HexMap が期待する 1 銘柄分の形 (Phase 4 後はこれが正本)
interface HexStock {
  code: string
  name: string
  sector_large: string
  sector_small: string | null
  sector17_name: string | null
  sector33_name: string | null
  market_segment: string | null
  margin_type: string | null
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
  ml_candidate_direction: 'up' | 'down' | null
  ml_candidate_rank: number | null
  ml_candidate_summary: string | null
}

interface SnapshotRow {
  ticker: string
  date: string
  daily_a_stage: number | null
  daily_b_stage: number | null
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
  ma_5: number | null
  ma_25: number | null
  ma_75: number | null
  ma_300: number | null
}

interface PriceRow {
  ticker: string
  close: number
  perf_1d: number | null
  perf_1w: number | null
  perf_1m: number | null
  perf_3m: number | null
  perf_6m: number | null
  perf_ytd: number | null
}

interface UniRow {
  ticker: string
  name: string | null
  shares_outstanding: number | null
  sector17_name: string | null
  sector33_name: string | null
  market_segment: string | null
  margin_type: string | null
}

interface ClassRow {
  ticker: string
  major_category: string
  sub_industry: string
}

interface MlCandidateRow {
  ticker: string
  direction: 'up' | 'down'
  rank: number
  explanation_json: string | null
}

function jsonResponse(request: NextRequest, payload: unknown): NextResponse {
  const json = JSON.stringify(payload)
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
  })
  const acceptEncoding = request.headers.get('accept-encoding') ?? ''
  if (json.length > 1024 && /\bgzip\b/i.test(acceptEncoding)) {
    headers.set('content-encoding', 'gzip')
    headers.set('vary', 'Accept-Encoding')
    return new NextResponse(gzipSync(json), { headers })
  }
  return new NextResponse(json, { headers })
}

/** 日付より前の最近営業日 */
async function prevSnapshotDate(beforeDate: string): Promise<string | null> {
  const r = await execGet<{ d: string | null }>(
    `SELECT MAX(date) AS d FROM daily_snapshots WHERE date < ?`,
    [beforeDate],
  )
  return r?.d ?? null
}

async function latestSnapshotDate(): Promise<string | null> {
  const row = await execGet<{ d: string | null }>(`SELECT MAX(date) AS d FROM daily_snapshots`)
  return row?.d ?? null
}

async function loadSnapshots(date: string): Promise<SnapshotRow[]> {
  return execAll<SnapshotRow>(
    `SELECT ticker, date,
            daily_a_stage, daily_b_stage, weekly_a_stage, weekly_b_stage, monthly_a_stage, monthly_b_stage,
            ma_5, ma_25, ma_75, ma_300
     FROM daily_snapshots WHERE date = ?`,
    [date],
  )
}

function indexByTicker<T extends { ticker: string }>(rows: T[]): Map<string, T> {
  const m = new Map<string, T>()
  for (const r of rows) m.set(r.ticker, r)
  return m
}

/** SMA 比較で角度を計算 (HEX-app 互換: %変化を 100 倍で 0-90 度域に圧縮) */
function smaAngle(curr: number | null, past: number | null): number | null {
  if (curr == null || past == null || past <= 0) return null
  const ratio = (curr - past) / past
  return ratio * 100
}

function parseMlSummary(raw: string | null): string | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { summary?: string; watchPoints?: string[] }
    return parsed.summary ?? parsed.watchPoints?.[0] ?? null
  } catch {
    return null
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const timeframe = (searchParams.get('timeframe') ?? 'daily') as 'daily' | 'weekly' | 'monthly'
    const requestedDate = searchParams.get('date')
    const view = searchParams.get('view')
    const universeFilter = parseUniverseFilter(searchParams.get(UNIVERSE_FILTER_PARAM))

    const date = requestedDate ?? (await latestSnapshotDate())
    if (!date) {
      return jsonResponse(request, {
        success: true,
        data: [],
        count: 0,
        cached: false,
        date: null,
        timeframe,
        filters: { universe: universeFilter },
        notice: 'OHLCV データ未取り込み。npm run batch:ohlcv を先に実行してください。',
      })
    }

    if (view === 'summary') {
      const universe = universeSqlCondition('ds.ticker', universeFilter)
      const rows = await execAll<{
        code: string
        sector_large: string | null
        daily_a_stage: number | null
        weekly_a_stage: number | null
        monthly_a_stage: number | null
      }>(
        `
        SELECT
          ds.ticker AS code,
          COALESCE(tu.sector17_name, sc.major_category, 'その他') AS sector_large,
          ds.daily_a_stage,
          ds.weekly_a_stage,
          ds.monthly_a_stage
        FROM daily_snapshots ds
        LEFT JOIN ticker_universe tu ON tu.ticker = ds.ticker
        LEFT JOIN stock_classification sc ON sc.ticker = ds.ticker
        WHERE ds.date = ?
        ${universe.sql ? `AND ${universe.sql}` : ''}
        `,
        [date, ...universe.params],
      )
      return jsonResponse(request, {
        success: true,
        data: rows,
        count: rows.length,
        cached: true,
        date,
        timeframe,
        source: 'jquants',
        view,
        filters: { universe: universeFilter },
      })
    }

    const prev1 = await prevSnapshotDate(date)
    const prev2 = prev1 ? await prevSnapshotDate(prev1) : null

    // 並列ロード
    const [currAll, prev1Snap, prev2Snap, prices, prices1Y, uni, klass, mlCandidates] = await Promise.all([
      loadSnapshots(date),
      prev1 ? loadSnapshots(prev1) : Promise.resolve([] as SnapshotRow[]),
      prev2 ? loadSnapshots(prev2) : Promise.resolve([] as SnapshotRow[]),
      // 直近 + 各 perf 計算用の close (約 1 年範囲)
      execAll<PriceRow>(
        `
        WITH t AS (SELECT ticker, close FROM ohlcv_daily WHERE date = ?),
             d1 AS (SELECT ticker, close FROM ohlcv_daily WHERE date = (SELECT MAX(date) FROM ohlcv_daily WHERE date < ?)),
             w1 AS (SELECT ticker, close FROM ohlcv_daily WHERE date = (SELECT MAX(date) FROM ohlcv_daily WHERE date <= date(?, '-7 days'))),
             m1 AS (SELECT ticker, close FROM ohlcv_daily WHERE date = (SELECT MAX(date) FROM ohlcv_daily WHERE date <= date(?, '-1 month'))),
             m3 AS (SELECT ticker, close FROM ohlcv_daily WHERE date = (SELECT MAX(date) FROM ohlcv_daily WHERE date <= date(?, '-3 months'))),
             m6 AS (SELECT ticker, close FROM ohlcv_daily WHERE date = (SELECT MAX(date) FROM ohlcv_daily WHERE date <= date(?, '-6 months'))),
             ytd AS (SELECT ticker, close FROM ohlcv_daily WHERE date = (SELECT MAX(date) FROM ohlcv_daily WHERE date <= substr(?, 1, 4) || '-01-01'))
        SELECT
          t.ticker,
          t.close,
          CASE WHEN d1.close > 0 THEN 100.0 * (t.close - d1.close) / d1.close END AS perf_1d,
          CASE WHEN w1.close > 0 THEN 100.0 * (t.close - w1.close) / w1.close END AS perf_1w,
          CASE WHEN m1.close > 0 THEN 100.0 * (t.close - m1.close) / m1.close END AS perf_1m,
          CASE WHEN m3.close > 0 THEN 100.0 * (t.close - m3.close) / m3.close END AS perf_3m,
          CASE WHEN m6.close > 0 THEN 100.0 * (t.close - m6.close) / m6.close END AS perf_6m,
          CASE WHEN ytd.close > 0 THEN 100.0 * (t.close - ytd.close) / ytd.close END AS perf_ytd
        FROM t
        LEFT JOIN d1 USING (ticker)
        LEFT JOIN w1 USING (ticker)
        LEFT JOIN m1 USING (ticker)
        LEFT JOIN m3 USING (ticker)
        LEFT JOIN m6 USING (ticker)
        LEFT JOIN ytd USING (ticker)
        `,
        [date, date, date, date, date, date, date],
      ),
      // 念のため変数として残す
      Promise.resolve(null),
      execAll<UniRow>(
        `SELECT ticker, name, shares_outstanding, sector17_name, sector33_name, market_segment, margin_type
         FROM ticker_universe WHERE active = 1`,
      ),
      execAll<ClassRow>(
        `SELECT ticker, major_category, sub_industry FROM stock_classification`,
      ),
      execAll<MlCandidateRow>(
        `
        WITH d AS (
          SELECT MAX(as_of_date) AS as_of_date
          FROM serving_ml_candidates
          WHERE as_of_date <= ?
        )
        SELECT ticker, direction, rank, explanation_json
        FROM serving_ml_candidates
        WHERE as_of_date = (SELECT as_of_date FROM d)
          AND rank <= 160
        `,
        [date],
      ),
    ])
    void prices1Y
    const curr = filterRowsByUniverse(currAll, universeFilter)

    const prev1Map = indexByTicker(prev1Snap)
    const prev2Map = indexByTicker(prev2Snap)
    const priceMap = indexByTicker(prices)
    const uniMap = indexByTicker(uni)
    const klassMap = indexByTicker(klass)
    const mlMap = new Map<string, { direction: 'up' | 'down'; rank: number; summary: string | null }>()
    for (const row of mlCandidates) {
      const existing = mlMap.get(row.ticker)
      if (!existing || row.rank < existing.rank) {
        mlMap.set(row.ticker, {
          direction: row.direction,
          rank: row.rank,
          summary: parseMlSummary(row.explanation_json),
        })
      }
    }

    const rows: HexStock[] = curr.map((s) => {
      const p1 = prev1Map.get(s.ticker)
      const p2 = prev2Map.get(s.ticker)
      const px = priceMap.get(s.ticker)
      const u = uniMap.get(s.ticker)
      const k = klassMap.get(s.ticker)
      const ml = mlMap.get(s.ticker)

      // 銘柄ごとフォールバック: Yoshio 独自分類 → JPX Sector17/33 → 'その他'
      const sectorLarge =
        u?.sector17_name ??
        k?.major_category ??
        'その他'
      const sectorSmall =
        u?.sector33_name ??
        k?.sub_industry ??
        'その他'

      const close = px?.close ?? 0
      const marketCap = u?.shares_outstanding && close > 0 ? close * u.shares_outstanding : 0

      // SMA 角度: 直近 vs prev1 (3日前)、prev1 vs prev2 (10日前相当の差分)
      const smaAngles = {
        sma5:  smaAngle(s.ma_5,   p1?.ma_5   ?? null),
        sma25: smaAngle(s.ma_25,  p1?.ma_25  ?? null),
        sma75: smaAngle(s.ma_75,  p1?.ma_75  ?? null),
        sma300: smaAngle(s.ma_300, p1?.ma_300 ?? null),
      }
      const prevSmaAngles = {
        sma5:  smaAngle(p1?.ma_5   ?? null, p2?.ma_5   ?? null),
        sma25: smaAngle(p1?.ma_25  ?? null, p2?.ma_25  ?? null),
        sma75: smaAngle(p1?.ma_75  ?? null, p2?.ma_75  ?? null),
        sma300: smaAngle(p1?.ma_300 ?? null, p2?.ma_300 ?? null),
      }

      const daily_a = s.daily_a_stage
      const daily_b = s.daily_b_stage
      const weekly_a = s.weekly_a_stage
      const weekly_b = s.weekly_b_stage
      const monthly_a = s.monthly_a_stage
      const monthly_b = s.monthly_b_stage

      const stageNow =
        timeframe === 'weekly' ? (weekly_a ?? 1) :
        timeframe === 'monthly' ? (monthly_a ?? 1) :
        (daily_a ?? 1)

      return {
        code: s.ticker,
        name: u?.name ?? s.ticker,
        sector_large: sectorLarge,
        sector_small: sectorSmall,
        sector17_name: u?.sector17_name ?? null,
        sector33_name: u?.sector33_name ?? null,
        market_segment: u?.market_segment ?? null,
        margin_type: u?.margin_type ?? null,
        market_cap: marketCap,
        price: close,
        daily_change: px?.perf_1d ?? 0,
        weekly_change: px?.perf_1w ?? 0,
        monthly_change: px?.perf_1m ?? 0,
        months3_change: px?.perf_3m ?? 0,
        months6_change: px?.perf_6m ?? 0,
        ytd_change: px?.perf_ytd ?? 0,
        stage: stageNow,
        stage_a: daily_a,
        stage_b: daily_b,
        daily_a_stage: daily_a,
        daily_b_stage: daily_b,
        weekly_a_stage: weekly_a,
        weekly_b_stage: weekly_b,
        monthly_a_stage: monthly_a,
        monthly_b_stage: monthly_b,
        prev_daily_a_stage:   p1?.daily_a_stage   ?? null,
        prev_daily_b_stage:   p1?.daily_b_stage   ?? null,
        prev_weekly_a_stage:  p1?.weekly_a_stage  ?? null,
        prev_weekly_b_stage:  p1?.weekly_b_stage  ?? null,
        prev_monthly_a_stage: p1?.monthly_a_stage ?? null,
        prev_monthly_b_stage: p1?.monthly_b_stage ?? null,
        prev_prev_daily_a_stage:   p2?.daily_a_stage   ?? null,
        prev_prev_daily_b_stage:   p2?.daily_b_stage   ?? null,
        prev_prev_weekly_a_stage:  p2?.weekly_a_stage  ?? null,
        prev_prev_weekly_b_stage:  p2?.weekly_b_stage  ?? null,
        prev_prev_monthly_a_stage: p2?.monthly_a_stage ?? null,
        prev_prev_monthly_b_stage: p2?.monthly_b_stage ?? null,
        sma_angles: smaAngles,
        prev_sma_angles: prevSmaAngles,
        prev_prev_sma_angles: prevSmaAngles,
        ml_candidate_direction: ml?.direction ?? null,
        ml_candidate_rank: ml?.rank ?? null,
        ml_candidate_summary: ml?.summary ?? null,
      }
    })

    return jsonResponse(request, {
      success: true,
      data: rows,
      count: rows.length,
      cached: true,
      date,
      timeframe,
      source: 'jquants',
      filters: { universe: universeFilter },
    })
  } catch (error) {
    console.error('Hex API error:', error)
    return NextResponse.json(
      { error: 'Hex map fetch failed', message: (error as Error).message },
      { status: 500 },
    )
  }
}
