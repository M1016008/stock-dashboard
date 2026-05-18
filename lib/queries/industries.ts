// lib/queries/industries.ts — Phase 4 F /industries 用集計

import { execAll, execGet } from '@/lib/db/client'

export interface IndustryRow {
  sub_industry: string
  major_category: string
  n_stocks: number
  avg_change: number
  stage1Count: number
  stage2Count: number
  stage4Count: number
}

async function hasClassification(): Promise<boolean> {
  const r = await execGet<{ n: number }>(`SELECT COUNT(*) AS n FROM stock_classification`)
  return (r?.n ?? 0) > 0
}

export async function getIndustryList(opts: { q?: string; major?: string; sort?: string }): Promise<{
  rows: IndustryRow[]
  source: 'classification' | 'sector33'
}> {
  const useClassification = await hasClassification()
  const source = useClassification ? 'classification' : 'sector33'

  const subExpr = useClassification ? 'sc.sub_industry' : `COALESCE(tu.sector33_name, '(未分類)')`
  const majorExpr = useClassification ? 'sc.major_category' : `COALESCE(tu.sector17_name, '(未分類)')`
  const sectorJoin = useClassification ? 'JOIN stock_classification sc ON sc.ticker = tu.ticker' : ''

  const filters: string[] = ['tu.active = 1']
  const args: (string | number)[] = []
  if (opts.q) {
    filters.push(`${subExpr} LIKE ?`)
    args.push(`%${opts.q}%`)
  }
  if (opts.major) {
    filters.push(`${majorExpr} = ?`)
    args.push(opts.major)
  }

  const orderBy =
    opts.sort === 'change_asc' ? 'avg_change ASC' :
    opts.sort === 'count_desc' ? 'n_stocks DESC, avg_change DESC' :
    opts.sort === 'name_asc' ? 'sub_industry ASC' :
    'avg_change DESC'

  const latest = (await execGet<{ d: string | null }>(`SELECT MAX(date) AS d FROM ohlcv_daily`))?.d
  if (!latest) return { rows: [], source }
  const prev = (await execGet<{ d: string | null }>(`SELECT MAX(date) AS d FROM ohlcv_daily WHERE date < ?`, [latest]))?.d
  if (!prev) return { rows: [], source }
  const latestSnap = (await execGet<{ d: string | null }>(`SELECT MAX(date) AS d FROM daily_snapshots`))?.d ?? latest

  const sql = `
    WITH t AS (SELECT ticker, close FROM ohlcv_daily WHERE date = ?),
         y AS (SELECT ticker, close FROM ohlcv_daily WHERE date = ?),
         st AS (SELECT ticker, daily_a_stage FROM daily_snapshots WHERE date = ?)
    SELECT
      ${subExpr} AS sub_industry,
      ${majorExpr} AS major_category,
      COUNT(*) AS n_stocks,
      AVG(100.0 * (t.close - y.close) / y.close) AS avg_change,
      SUM(CASE WHEN st.daily_a_stage = 1 THEN 1 ELSE 0 END) AS stage1Count,
      SUM(CASE WHEN st.daily_a_stage = 2 THEN 1 ELSE 0 END) AS stage2Count,
      SUM(CASE WHEN st.daily_a_stage = 4 THEN 1 ELSE 0 END) AS stage4Count
    FROM ticker_universe tu
    ${sectorJoin}
    JOIN t USING (ticker)
    JOIN y USING (ticker)
    LEFT JOIN st USING (ticker)
    WHERE ${filters.join(' AND ')}
    GROUP BY ${subExpr}, ${majorExpr}
    HAVING n_stocks >= 1
    ORDER BY ${orderBy}
    LIMIT 200
  `
  const rows = await execAll<IndustryRow>(sql, [latest, prev, latestSnap, ...args])
  return { rows, source }
}

// ─── 大分類一覧 (フィルタ用 chip) ───
export async function getMajorList(): Promise<string[]> {
  const useClassification = await hasClassification()
  const expr = useClassification ? 'major_category' : 'sector17_name'
  const tableJoin = useClassification ? 'stock_classification' : 'ticker_universe'
  const rows = await execAll<{ n: string | null }>(
    `SELECT DISTINCT ${expr} AS n FROM ${tableJoin} WHERE ${expr} IS NOT NULL ORDER BY ${expr}`,
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
  const useClassification = await hasClassification()
  const subExpr = useClassification ? 'sc.sub_industry' : 'tu.sector33_name'
  const sectorJoin = useClassification ? 'JOIN stock_classification sc ON sc.ticker = tu.ticker' : ''

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
    ${sectorJoin}
    LEFT JOIN t USING (ticker)
    LEFT JOIN y USING (ticker)
    LEFT JOIN st USING (ticker)
    WHERE tu.active = 1 AND ${subExpr} = ?
    ORDER BY changePct DESC NULLS LAST
    LIMIT ?
    `,
    [latest, prev, latestSnap, subIndustry, limit],
  )
}
