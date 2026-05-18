// lib/queries/transitions.ts — Phase 4 D /ai/transitions ページ用

import { execAll, execGet } from '@/lib/db/client'

export interface PatternMeta {
  pattern_code: string
  count_60d: number
  p50_60d: number | null
  p25_60d: number | null
  p75_60d: number | null
  lastDate: string | null
}

export async function getDefaultPatternCode(): Promise<string | null> {
  const row = await execGet<{ code: string | null }>(
    `SELECT pattern_code AS code FROM pattern_stats WHERE horizon_days = 60 AND count >= 20 ORDER BY count DESC LIMIT 1`,
  )
  return row?.code ?? null
}

export async function getPatternMeta(code: string): Promise<PatternMeta | null> {
  const row = await execGet<{ count: number; p25: number | null; p50: number | null; p75: number | null }>(
    `SELECT count, p25, p50, p75 FROM pattern_stats WHERE pattern_code = ? AND horizon_days = 60`,
    [code],
  )
  if (!row) return null
  // 直近出現日
  const lastRow = await execGet<{ d: string | null }>(
    `
    WITH match AS (
      SELECT date FROM daily_snapshots
      WHERE (CAST(daily_a_stage AS TEXT) || CAST(daily_b_stage AS TEXT) || CAST(weekly_a_stage AS TEXT) || CAST(weekly_b_stage AS TEXT) || CAST(monthly_a_stage AS TEXT) || CAST(monthly_b_stage AS TEXT)) = ?
    )
    SELECT MAX(date) AS d FROM match
    `,
    [code],
  )
  return {
    pattern_code: code,
    count_60d: row.count,
    p25_60d: row.p25,
    p50_60d: row.p50,
    p75_60d: row.p75,
    lastDate: lastRow?.d ?? null,
  }
}

export interface HorizonStatRow {
  horizon_days: number
  count: number
  p25: number | null
  p50: number | null
  p75: number | null
  winRate: number  // 正のリターン割合 = (very_up + up) / count
  meanCategory: number | null
}
export async function getHorizonStats(code: string): Promise<HorizonStatRow[]> {
  const rows = await execAll<{
    horizon_days: number; count: number;
    p25: number | null; p50: number | null; p75: number | null;
    very_up_count: number; up_count: number; flat_count: number; down_count: number; very_down_count: number;
  }>(
    `SELECT horizon_days, count, p25, p50, p75,
            very_up_count, up_count, flat_count, down_count, very_down_count
     FROM pattern_stats WHERE pattern_code = ? ORDER BY horizon_days`,
    [code],
  )
  return rows.map(r => ({
    horizon_days: r.horizon_days,
    count: r.count,
    p25: r.p25,
    p50: r.p50,
    p75: r.p75,
    winRate: r.count > 0 ? (r.very_up_count + r.up_count) / r.count : 0,
    meanCategory: r.p50,
  }))
}

// ─── 上位パターン (count 順、horizon=60) ───
export interface TopPatternRow {
  pattern_code: string
  count: number
  p50: number | null
}
export async function getTopPatterns(limit = 12): Promise<TopPatternRow[]> {
  return await execAll<TopPatternRow>(
    `SELECT pattern_code, count, p50 FROM pattern_stats
     WHERE horizon_days = 60 AND count >= 20
     ORDER BY count DESC LIMIT ?`,
    [limit],
  )
}

// ─── リターン分布 (9 bin ヒストグラム + 25/50/75) ───
export interface ReturnBin { lower: number; upper: number; count: number }
export interface ReturnDistribution {
  bins: ReturnBin[]
  total: number
  p25: number | null
  p50: number | null
  p75: number | null
}
export async function getReturnDistribution(code: string, horizonDays = 60): Promise<ReturnDistribution> {
  // パターン一致 (ticker, date) を絞り込み、forward_returns 値を取得
  const rows = await execAll<{ return_pct: number }>(
    `
    WITH match AS (
      SELECT ticker, date FROM daily_snapshots
      WHERE (CAST(daily_a_stage AS TEXT) || CAST(daily_b_stage AS TEXT) || CAST(weekly_a_stage AS TEXT) || CAST(weekly_b_stage AS TEXT) || CAST(monthly_a_stage AS TEXT) || CAST(monthly_b_stage AS TEXT)) = ?
      LIMIT 20000
    )
    SELECT fr.return_pct FROM forward_returns fr
    JOIN match USING (ticker, date)
    WHERE fr.horizon_days = ?
    `,
    [code, horizonDays],
  )
  const vals = rows.map(r => r.return_pct).filter(v => Number.isFinite(v))
  vals.sort((a, b) => a - b)
  const total = vals.length

  // 9 bin: -30%, -20%, -10%, 0, +10%, +20%, +30% を埋める
  const edges = [-Infinity, -30, -20, -10, 0, 10, 20, 30, Infinity]
  const bins: ReturnBin[] = []
  for (let i = 0; i < edges.length - 1; i++) {
    const lower = edges[i] === -Infinity ? -40 : edges[i]
    const upper = edges[i + 1] === Infinity ? 40 : edges[i + 1]
    const count = vals.filter(v => v >= edges[i] && v < edges[i + 1]).length
    bins.push({ lower, upper, count })
  }
  // 分位 (前計算が無くても vals から計算可能、上では pattern_stats の p25/p50/p75 を信用)
  const pct = (p: number) => total === 0 ? null : vals[Math.min(total - 1, Math.floor(total * p))]

  return {
    bins,
    total,
    p25: pct(0.25),
    p50: pct(0.50),
    p75: pct(0.75),
  }
}

// ─── 業種分布 (J-Quants Sector33) ───
export interface SectorBreakdownRow {
  sector_name: string
  count: number
}
export async function getSectorBreakdown(code: string, limit = 7): Promise<SectorBreakdownRow[]> {
  return await execAll<SectorBreakdownRow>(
    `
    WITH match AS (
      SELECT DISTINCT ticker FROM daily_snapshots
      WHERE (CAST(daily_a_stage AS TEXT) || CAST(daily_b_stage AS TEXT) || CAST(weekly_a_stage AS TEXT) || CAST(weekly_b_stage AS TEXT) || CAST(monthly_a_stage AS TEXT) || CAST(monthly_b_stage AS TEXT)) = ?
      LIMIT 5000
    )
    SELECT COALESCE(tu.sector33_name, 'その他') AS sector_name, COUNT(*) AS count
    FROM match
    LEFT JOIN ticker_universe tu USING (ticker)
    GROUP BY tu.sector33_name
    ORDER BY count DESC
    LIMIT ?
    `,
    [code, limit],
  )
}

// ─── サンプルケース (出現日 / 4 ホライゾン) ───
export interface SampleCaseRow {
  ticker: string
  name: string | null
  date: string
  sector: string | null
  r30: number | null
  r60: number | null
  r90: number | null
  r180: number | null
}
export async function getSampleCases(code: string, limit = 10): Promise<SampleCaseRow[]> {
  return await execAll<SampleCaseRow>(
    `
    WITH match AS (
      SELECT ticker, date FROM daily_snapshots
      WHERE (CAST(daily_a_stage AS TEXT) || CAST(daily_b_stage AS TEXT) || CAST(weekly_a_stage AS TEXT) || CAST(weekly_b_stage AS TEXT) || CAST(monthly_a_stage AS TEXT) || CAST(monthly_b_stage AS TEXT)) = ?
      ORDER BY date DESC
      LIMIT 200
    ),
    r AS (
      SELECT ticker, date, horizon_days, return_pct FROM forward_returns
    )
    SELECT m.ticker, tu.name, m.date,
           tu.sector33_name AS sector,
           MAX(CASE WHEN r.horizon_days = 30  THEN r.return_pct END) AS r30,
           MAX(CASE WHEN r.horizon_days = 60  THEN r.return_pct END) AS r60,
           MAX(CASE WHEN r.horizon_days = 90  THEN r.return_pct END) AS r90,
           MAX(CASE WHEN r.horizon_days = 180 THEN r.return_pct END) AS r180
    FROM match m
    LEFT JOIN r USING (ticker, date)
    LEFT JOIN ticker_universe tu ON tu.ticker = m.ticker
    GROUP BY m.ticker, m.date
    ORDER BY m.date DESC
    LIMIT ?
    `,
    [code, limit],
  )
}
