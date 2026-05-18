// lib/queries/sectors.ts — Phase 4 E /sectors ページ用集計
//
// データソース優先順位:
//   1. stock_classification (Yoshio 独自 Excel: 大分類 59 × 業種細分類 476)
//   2. ticker_universe.sector17_name (フォールバック: J-Quants Sector17 = 17 業種)
//
// classification が空のときは Sector17 を「大分類」、Sector33 を「業種細分類」として扱う。

import { execAll, execGet } from '@/lib/db/client'

export interface SectorRow {
  sector_name: string
  n_stocks: number
  avg_change: number
  stage_up_count: number    // Stage 1+2
  stage_down_count: number  // Stage 4+5
}

async function hasClassification(): Promise<boolean> {
  const r = await execGet<{ n: number }>(`SELECT COUNT(*) AS n FROM stock_classification`)
  return (r?.n ?? 0) > 0
}

export async function getSectorRows(): Promise<{ rows: SectorRow[]; source: 'classification' | 'sector17' }> {
  const useClassification = await hasClassification()
  const source = useClassification ? 'classification' : 'sector17'

  // SQL ビルド: 結合元を切り替え
  const sectorExpr = useClassification ? 'sc.major_category' : `COALESCE(tu.sector17_name, '(未分類)')`
  const sectorJoin = useClassification ? 'JOIN stock_classification sc ON sc.ticker = tu.ticker' : ''

  const latest = (await execGet<{ d: string | null }>(`SELECT MAX(date) AS d FROM ohlcv_daily`))?.d
  if (!latest) return { rows: [], source }
  const prev = (await execGet<{ d: string | null }>(`SELECT MAX(date) AS d FROM ohlcv_daily WHERE date < ?`, [latest]))?.d
  if (!prev) return { rows: [], source }
  const latestSnap = (await execGet<{ d: string | null }>(`SELECT MAX(date) AS d FROM daily_snapshots`))?.d ?? latest

  const rows = await execAll<SectorRow>(
    `
    WITH t AS (SELECT ticker, close FROM ohlcv_daily WHERE date = ?),
         y AS (SELECT ticker, close FROM ohlcv_daily WHERE date = ?),
         st AS (SELECT ticker, daily_a_stage FROM daily_snapshots WHERE date = ?)
    SELECT
      ${sectorExpr} AS sector_name,
      COUNT(*) AS n_stocks,
      AVG(100.0 * (t.close - y.close) / y.close) AS avg_change,
      SUM(CASE WHEN st.daily_a_stage IN (1, 2) THEN 1 ELSE 0 END) AS stage_up_count,
      SUM(CASE WHEN st.daily_a_stage IN (4, 5) THEN 1 ELSE 0 END) AS stage_down_count
    FROM ticker_universe tu
    ${sectorJoin}
    JOIN t USING (ticker)
    JOIN y USING (ticker)
    LEFT JOIN st USING (ticker)
    WHERE tu.active = 1
    GROUP BY ${sectorExpr}
    HAVING n_stocks >= 2
    ORDER BY avg_change DESC
    `,
    [latest, prev, latestSnap],
  )
  return { rows, source }
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
  const useClassification = await hasClassification()
  const subExpr = useClassification ? 'sc.sub_industry' : `COALESCE(tu.sector33_name, '(未分類)')`
  const sectorJoin = useClassification ? 'JOIN stock_classification sc ON sc.ticker = tu.ticker' : ''
  const filterExpr = useClassification ? 'sc.major_category = ?' : 'tu.sector17_name = ?'

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
      ${subExpr} AS sub_industry,
      COUNT(*) AS n_stocks,
      AVG(100.0 * (t.close - y.close) / y.close) AS avg_change,
      CAST(SUM(CASE WHEN st.daily_a_stage IN (1, 2) THEN 1 ELSE 0 END) AS REAL) / COUNT(*) AS upRatio,
      GROUP_CONCAT(tu.ticker, ',') AS topTickers
    FROM ticker_universe tu
    ${sectorJoin}
    JOIN t USING (ticker)
    JOIN y USING (ticker)
    LEFT JOIN st USING (ticker)
    WHERE tu.active = 1 AND ${filterExpr}
    GROUP BY ${subExpr}
    HAVING n_stocks >= 1
    ORDER BY avg_change DESC
    `,
    [latest, prev, latestSnap, majorCategory],
  )
}
