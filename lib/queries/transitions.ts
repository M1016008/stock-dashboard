// lib/queries/transitions.ts — Phase 4 D /ai/transitions ページ用

import { execAll, execGet } from '@/lib/db/client'
import { type UniverseFilterValue, universeSqlCondition } from '@/lib/market-universe'

function stagesFromCode(code: string): number[] | null {
  if (!/^\d{6}$/.test(code)) return null
  const stages = code.split('').map(Number)
  return stages.every(s => s >= 1 && s <= 6) ? stages : null
}

const STAGE_MATCH_WHERE = `
  daily_a_stage = ? AND daily_b_stage = ?
  AND weekly_a_stage = ? AND weekly_b_stage = ?
  AND monthly_a_stage = ? AND monthly_b_stage = ?
`

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
  const stages = stagesFromCode(code)
  if (!stages) return null
  const row = await execGet<{ count: number; p25: number | null; p50: number | null; p75: number | null }>(
    `SELECT count, p25, p50, p75 FROM pattern_stats WHERE pattern_code = ? AND horizon_days = 60`,
    [code],
  )
  if (!row) return null
  // 直近出現日
  const lastRow = await execGet<{ d: string | null }>(
    `
    SELECT MAX(date) AS d
    FROM daily_snapshots
    WHERE ${STAGE_MATCH_WHERE}
    `,
    stages,
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
  const stages = stagesFromCode(code)
  if (!stages) return { bins: [], total: 0, p25: null, p50: null, p75: null }
  // パターン一致 (ticker, date) を絞り込み、forward_returns 値を取得
  const rows = await execAll<{ return_pct: number }>(
    `
    WITH match AS (
      SELECT ticker, date FROM daily_snapshots
      WHERE ${STAGE_MATCH_WHERE}
      LIMIT 20000
    )
    SELECT fr.return_pct FROM forward_returns fr
    JOIN match USING (ticker, date)
    WHERE fr.horizon_days = ?
    `,
    [...stages, horizonDays],
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
export async function getSectorBreakdown(
  code: string,
  limit = 7,
  universeFilter: UniverseFilterValue = null,
): Promise<SectorBreakdownRow[]> {
  const stages = stagesFromCode(code)
  if (!stages) return []
  const universe = universeSqlCondition('ticker', universeFilter)
  return await execAll<SectorBreakdownRow>(
    `
    WITH match AS (
      SELECT DISTINCT ticker FROM daily_snapshots
      WHERE ${STAGE_MATCH_WHERE}
        ${universe.sql ? `AND ${universe.sql}` : ''}
      LIMIT 5000
    )
    SELECT COALESCE(tu.sector33_name, 'その他') AS sector_name, COUNT(*) AS count
    FROM match
    LEFT JOIN ticker_universe tu USING (ticker)
    GROUP BY tu.sector33_name
    ORDER BY count DESC
    LIMIT ?
    `,
    [...stages, ...universe.params, limit],
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
export async function getSampleCases(
  code: string,
  limit = 10,
  universeFilter: UniverseFilterValue = null,
): Promise<SampleCaseRow[]> {
  const stages = stagesFromCode(code)
  if (!stages) return []

  const maxReturnDate = await execGet<{ date: string | null }>(
    `SELECT MAX(date) AS date FROM forward_returns WHERE horizon_days = 180`,
  )
  if (!maxReturnDate?.date) return []

  const safeLimit = Math.max(1, Math.min(limit, 100))
  const scanLimit = Math.min(Math.max(safeLimit * 50, 500), 5000)
  const universe = universeSqlCondition('ticker', universeFilter)

  return await execAll<SampleCaseRow>(
    `
    WITH match AS (
      SELECT ticker, date FROM daily_snapshots
      WHERE ${STAGE_MATCH_WHERE}
        ${universe.sql ? `AND ${universe.sql}` : ''}
        AND date <= ?
      ORDER BY date DESC, ticker ASC
      LIMIT ?
    ),
    raw AS (
      SELECT m.ticker, tu.name, m.date,
             tu.sector33_name AS sector,
             MAX(CASE WHEN fr.horizon_days = 30  THEN fr.return_pct END) AS r30,
             MAX(CASE WHEN fr.horizon_days = 60  THEN fr.return_pct END) AS r60,
             MAX(CASE WHEN fr.horizon_days = 90  THEN fr.return_pct END) AS r90,
             MAX(CASE WHEN fr.horizon_days = 180 THEN fr.return_pct END) AS r180
      FROM match m
      LEFT JOIN forward_returns fr
        ON fr.ticker = m.ticker
       AND fr.date = m.date
       AND fr.horizon_days IN (30, 60, 90, 180)
      LEFT JOIN ticker_universe tu ON tu.ticker = m.ticker
      GROUP BY m.ticker, m.date
    )
    SELECT * FROM raw
    WHERE r30 IS NOT NULL
      AND r60 IS NOT NULL
      AND r90 IS NOT NULL
      AND r180 IS NOT NULL
    ORDER BY date DESC, ticker ASC
    LIMIT ?
    `,
    [...stages, ...universe.params, maxReturnDate.date, scanLimit, safeLimit],
  )
}
