// lib/queries/industries.ts
//
// Phase 4 業界別 (/industries) 用集計。
//
// 業種分類のフォールバック規則 (銘柄ごと):
//   1. stock_classification (Yoshio 独自分類 Excel)
//   2. ticker_universe.sector17_name / sector33_name (J-Quants/JPX)
//   3. 'その他'

import { execAll, execGet } from '@/lib/db/client'

const MAJOR_EXPR = `COALESCE(sc.major_category, tu.sector17_name, 'その他')`
const SUB_EXPR = `COALESCE(sc.sub_industry, tu.sector33_name, 'その他')`

export interface IndustryRow {
  sub_industry: string
  major_category: string
  n_stocks: number
  avg_change: number
  stage1Count: number
  stage2Count: number
  stage4Count: number
}

export async function getIndustryList(opts: { q?: string; major?: string; sort?: string }): Promise<{
  rows: IndustryRow[]
  classificationCount: number
}> {
  const filters: string[] = ['tu.active = 1']
  const args: (string | number)[] = []
  if (opts.q) {
    filters.push(`${SUB_EXPR} LIKE ?`)
    args.push(`%${opts.q}%`)
  }
  if (opts.major) {
    filters.push(`${MAJOR_EXPR} = ?`)
    args.push(opts.major)
  }

  const orderBy =
    opts.sort === 'change_asc' ? 'avg_change ASC' :
    opts.sort === 'count_desc' ? 'n_stocks DESC, avg_change DESC' :
    opts.sort === 'name_asc' ? 'sub_industry ASC' :
    'avg_change DESC'

  const latest = (await execGet<{ d: string | null }>(`SELECT MAX(date) AS d FROM ohlcv_daily`))?.d
  if (!latest) return { rows: [], classificationCount: 0 }
  const prev = (await execGet<{ d: string | null }>(`SELECT MAX(date) AS d FROM ohlcv_daily WHERE date < ?`, [latest]))?.d
  if (!prev) return { rows: [], classificationCount: 0 }
  const latestSnap = (await execGet<{ d: string | null }>(`SELECT MAX(date) AS d FROM daily_snapshots`))?.d ?? latest

  const cntRow = await execGet<{ n: number }>(`SELECT COUNT(*) AS n FROM stock_classification`)
  const classificationCount = cntRow?.n ?? 0

  const sql = `
    WITH t AS (SELECT ticker, close FROM ohlcv_daily WHERE date = ?),
         y AS (SELECT ticker, close FROM ohlcv_daily WHERE date = ?),
         st AS (SELECT ticker, daily_a_stage FROM daily_snapshots WHERE date = ?)
    SELECT
      ${SUB_EXPR} AS sub_industry,
      ${MAJOR_EXPR} AS major_category,
      COUNT(*) AS n_stocks,
      AVG(100.0 * (t.close - y.close) / y.close) AS avg_change,
      SUM(CASE WHEN st.daily_a_stage = 1 THEN 1 ELSE 0 END) AS stage1Count,
      SUM(CASE WHEN st.daily_a_stage = 2 THEN 1 ELSE 0 END) AS stage2Count,
      SUM(CASE WHEN st.daily_a_stage = 4 THEN 1 ELSE 0 END) AS stage4Count
    FROM ticker_universe tu
    LEFT JOIN stock_classification sc ON sc.ticker = tu.ticker
    JOIN t USING (ticker)
    JOIN y USING (ticker)
    LEFT JOIN st USING (ticker)
    WHERE ${filters.join(' AND ')}
    GROUP BY ${SUB_EXPR}, ${MAJOR_EXPR}
    HAVING n_stocks >= 1
    ORDER BY ${orderBy}
    LIMIT 600
  `
  const rows = await execAll<IndustryRow>(sql, [latest, prev, latestSnap, ...args])
  return { rows, classificationCount }
}

// ─── 大分類一覧 (フィルタ用 chip) ───
//   独自分類とJPX Sector17 を UNION で結合して銘柄数を集計
export async function getMajorList(): Promise<string[]> {
  const rows = await execAll<{ n: string | null }>(
    `
    SELECT DISTINCT ${MAJOR_EXPR} AS n
    FROM ticker_universe tu
    LEFT JOIN stock_classification sc ON sc.ticker = tu.ticker
    WHERE tu.active = 1
    ORDER BY n
    `,
  )
  return rows.map(r => r.n).filter((s): s is string => !!s)
}

// ─── 業種細分類に属する銘柄 ───
export interface IndustryStockRow {
  ticker: string
  name: string | null
  daily_a: number | null
  daily_b: number | null
  weekly_a: number | null
  weekly_b: number | null
  monthly_a: number | null
  monthly_b: number | null
  price: number | null
  changePct: number | null
  marketCap: number | null
}
export async function getIndustryStocks(subIndustry: string, limit = 80): Promise<IndustryStockRow[]> {
  const latest = (await execGet<{ d: string | null }>(`SELECT MAX(date) AS d FROM ohlcv_daily`))?.d
  if (!latest) return []
  const prev = (await execGet<{ d: string | null }>(`SELECT MAX(date) AS d FROM ohlcv_daily WHERE date < ?`, [latest]))?.d
  if (!prev) return []
  const latestSnap = (await execGet<{ d: string | null }>(`SELECT MAX(date) AS d FROM daily_snapshots`))?.d ?? latest

  return await execAll<IndustryStockRow>(
    `
    WITH t AS (SELECT ticker, close FROM ohlcv_daily WHERE date = ?),
         y AS (SELECT ticker, close FROM ohlcv_daily WHERE date = ?),
         st AS (SELECT * FROM daily_snapshots WHERE date = ?)
    SELECT
      tu.ticker, tu.name,
      st.daily_a_stage   AS daily_a,
      st.daily_b_stage   AS daily_b,
      st.weekly_a_stage  AS weekly_a,
      st.weekly_b_stage  AS weekly_b,
      st.monthly_a_stage AS monthly_a,
      st.monthly_b_stage AS monthly_b,
      t.close AS price,
      CASE WHEN y.close > 0 THEN 100.0 * (t.close - y.close) / y.close END AS changePct,
      CASE WHEN tu.shares_outstanding IS NOT NULL THEN t.close * tu.shares_outstanding END AS marketCap
    FROM ticker_universe tu
    LEFT JOIN stock_classification sc ON sc.ticker = tu.ticker
    LEFT JOIN t USING (ticker)
    LEFT JOIN y USING (ticker)
    LEFT JOIN st USING (ticker)
    WHERE tu.active = 1 AND ${SUB_EXPR} = ?
    ORDER BY changePct DESC NULLS LAST
    LIMIT ?
    `,
    [latest, prev, latestSnap, subIndustry, limit],
  )
}
