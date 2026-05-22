// lib/queries/sectors.ts
//
// Phase 4 業種別 (/sectors) 用集計。
//
// 業種分類のフォールバック規則 (銘柄ごと):
//   1. stock_classification.major_category (Yoshio 独自分類 Excel)
//   2. ticker_universe.sector17_name (J-Quants/JPX Sector17)
//   3. 'その他'
//
// 業種細分類も同様: classification.sub_industry → Sector33 → 'その他'

import { execAll, execGet } from '@/lib/db/client'

export interface SectorRow {
  sector_name: string
  n_stocks: number
  avg_change: number
  stage_up_count: number    // Stage 1+2
  stage_down_count: number  // Stage 4+5
}

// 大分類フォールバック式 (Yoshio 独自 → JPX Sector17 → その他)
const MAJOR_EXPR = `COALESCE(sc.major_category, tu.sector17_name, 'その他')`
// 業種細分類フォールバック式 (Yoshio 独自 → JPX Sector33 → その他)
const SUB_EXPR = `COALESCE(sc.sub_industry, tu.sector33_name, 'その他')`

export async function getSectorRows(): Promise<{ rows: SectorRow[]; classificationCount: number }> {
  const latest = (await execGet<{ d: string | null }>(`SELECT MAX(date) AS d FROM ohlcv_daily`))?.d
  if (!latest) return { rows: [], classificationCount: 0 }
  const prev = (await execGet<{ d: string | null }>(`SELECT MAX(date) AS d FROM ohlcv_daily WHERE date < ?`, [latest]))?.d
  if (!prev) return { rows: [], classificationCount: 0 }
  const latestSnap = (await execGet<{ d: string | null }>(`SELECT MAX(date) AS d FROM daily_snapshots`))?.d ?? latest

  const cntRow = await execGet<{ n: number }>(`SELECT COUNT(*) AS n FROM stock_classification`)
  const classificationCount = cntRow?.n ?? 0

  const rows = await execAll<SectorRow>(
    `
    WITH t AS (SELECT ticker, close FROM ohlcv_daily WHERE date = ?),
         y AS (SELECT ticker, close FROM ohlcv_daily WHERE date = ?),
         st AS (SELECT ticker, daily_a_stage FROM daily_snapshots WHERE date = ?)
    SELECT
      ${MAJOR_EXPR} AS sector_name,
      COUNT(*) AS n_stocks,
      AVG(100.0 * (t.close - y.close) / y.close) AS avg_change,
      SUM(CASE WHEN st.daily_a_stage IN (1, 2) THEN 1 ELSE 0 END) AS stage_up_count,
      SUM(CASE WHEN st.daily_a_stage IN (4, 5) THEN 1 ELSE 0 END) AS stage_down_count
    FROM ticker_universe tu
    LEFT JOIN stock_classification sc ON sc.ticker = tu.ticker
    JOIN t USING (ticker)
    JOIN y USING (ticker)
    LEFT JOIN st USING (ticker)
    WHERE tu.active = 1
    GROUP BY ${MAJOR_EXPR}
    HAVING n_stocks >= 1
    ORDER BY avg_change DESC
    `,
    [latest, prev, latestSnap],
  )
  return { rows, classificationCount }
}

// ─── 選択中の大分類に属する業種細分類一覧 ───
export interface SubSectorRow {
  sub_industry: string
  n_stocks: number
  avg_change: number
  upRatio: number  // Stage 1+2 比率
  topTickers: string  // カンマ区切り 3 銘柄
}
export async function getSubSectorsFor(majorCategory: string): Promise<SubSectorRow[]> {
  const latest = (await execGet<{ d: string | null }>(`SELECT MAX(date) AS d FROM ohlcv_daily`))?.d
  if (!latest) return []
  const prev = (await execGet<{ d: string | null }>(`SELECT MAX(date) AS d FROM ohlcv_daily WHERE date < ?`, [latest]))?.d
  if (!prev) return []
  const latestSnap = (await execGet<{ d: string | null }>(`SELECT MAX(date) AS d FROM daily_snapshots`))?.d ?? latest

  return await execAll<SubSectorRow>(
    `
    WITH t AS (SELECT ticker, close FROM ohlcv_daily WHERE date = ?),
         y AS (SELECT ticker, close FROM ohlcv_daily WHERE date = ?),
         st AS (SELECT ticker, daily_a_stage FROM daily_snapshots WHERE date = ?)
    SELECT
      ${SUB_EXPR} AS sub_industry,
      COUNT(*) AS n_stocks,
      AVG(100.0 * (t.close - y.close) / y.close) AS avg_change,
      CAST(SUM(CASE WHEN st.daily_a_stage IN (1, 2) THEN 1 ELSE 0 END) AS REAL) / COUNT(*) AS upRatio,
      GROUP_CONCAT(tu.ticker, ',') AS topTickers
    FROM ticker_universe tu
    LEFT JOIN stock_classification sc ON sc.ticker = tu.ticker
    JOIN t USING (ticker)
    JOIN y USING (ticker)
    LEFT JOIN st USING (ticker)
    WHERE tu.active = 1 AND ${MAJOR_EXPR} = ?
    GROUP BY ${SUB_EXPR}
    HAVING n_stocks >= 1
    ORDER BY avg_change DESC
    `,
    [latest, prev, latestSnap, majorCategory],
  )
}
