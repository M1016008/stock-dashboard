import { NextRequest, NextResponse } from 'next/server'
import { execAll, execGet } from '@/lib/db/client'
import { US_SEC_SIC_TAXONOMY } from '@/lib/us-classification'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

const SORT_KEYS = new Set(['ticker', 'name', 'price', 'changePct', 'volume', 'marketCap', 'stageCode', 'sector', 'industry'])

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const date = searchParams.get('date') ?? (await execGet<{ date: string | null }>(
      `SELECT MAX(date) AS date FROM market_daily_snapshots WHERE market = 'US'`,
    ))?.date
    if (!date) {
      return NextResponse.json({ market: 'US', date: null, rows: [], count: 0, message: 'US snapshots are not generated yet.' })
    }
    const limit = Math.min(500, Math.max(1, Number(searchParams.get('limit') ?? 100)))
    const sort = SORT_KEYS.has(searchParams.get('sort') ?? '') ? searchParams.get('sort')! : 'ticker'
    const dir = searchParams.get('dir') === 'desc' ? 'desc' : 'asc'
    const q = searchParams.get('q')?.trim().toUpperCase() ?? ''
    const taxonomy = searchParams.get('taxonomy') ?? US_SEC_SIC_TAXONOMY
    const sector = searchParams.get('sector')?.trim()
    const industry = searchParams.get('industry')?.trim()
    const whereQ = q ? `AND (s.ticker LIKE ? OR UPPER(COALESCE(u.name, '')) LIKE ?)` : ''
    const whereSector = sector ? `AND COALESCE(c.sector_name, u.sector) = ?` : ''
    const whereIndustry = industry ? `AND COALESCE(c.industry_name, u.industry) = ?` : ''
    const args: Array<string | number> = ['US', date, date, taxonomy, date]
    if (q) args.push(`%${q}%`, `%${q}%`)
    if (sector) args.push(sector)
    if (industry) args.push(industry)
    args.push(limit)

    const orderExpr: Record<string, string> = {
      ticker: 's.ticker',
      name: 'COALESCE(u.name, s.ticker)',
      price: 'cur.close',
      changePct: 'change_pct',
      volume: 'cur.volume',
      marketCap: 'market_cap',
      stageCode: 'stage_code',
      sector: 'sector',
      industry: 'industry',
    }
    const rows = await execAll(
      `
      WITH prev_date AS (
        SELECT MAX(date) AS date FROM market_ohlcv_daily WHERE market = ? AND date < ?
      ),
      cur AS (
        SELECT ticker, close, volume FROM market_ohlcv_daily WHERE market = 'US' AND date = ?
      ),
      prev AS (
        SELECT o.ticker, o.close
        FROM market_ohlcv_daily o, prev_date p
        WHERE o.market = 'US' AND o.date = p.date
      )
      SELECT
        s.ticker,
        COALESCE(u.name, s.ticker) AS name,
        u.exchange,
        COALESCE(c.sector_name, u.sector) AS sector,
        COALESCE(c.industry_name, u.industry) AS industry,
        c.taxonomy AS classification_taxonomy,
        c.source AS classification_source,
        cur.close AS price,
        cur.volume,
        CASE WHEN prev.close > 0 THEN 100.0 * (cur.close - prev.close) / prev.close END AS change_pct,
        CASE WHEN u.shares_outstanding IS NOT NULL AND cur.close IS NOT NULL THEN u.shares_outstanding * cur.close END AS market_cap,
        s.daily_a_stage || s.daily_b_stage || s.weekly_a_stage || s.weekly_b_stage || s.monthly_a_stage || s.monthly_b_stage AS stage_code,
        s.ma_5,
        s.ma_25,
        s.ma_75,
        s.ma_300
      FROM market_daily_snapshots s
      LEFT JOIN market_universe u ON u.market = s.market AND u.ticker = s.ticker
      LEFT JOIN market_classifications c
        ON c.market = s.market
       AND c.ticker = s.ticker
       AND c.taxonomy = ?
       AND c.effective_from = '0000-01-01'
      LEFT JOIN cur ON cur.ticker = s.ticker
      LEFT JOIN prev ON prev.ticker = s.ticker
      WHERE s.market = 'US' AND s.date = ?
        ${whereQ}
        ${whereSector}
        ${whereIndustry}
      ORDER BY ${orderExpr[sort]} ${dir.toUpperCase()}, s.ticker ASC
      LIMIT ?
      `,
      args,
    )
    return NextResponse.json({ market: 'US', date, rows, count: rows.length, source: 'tiingo' })
  } catch (error) {
    console.error('US screener API error:', error)
    return NextResponse.json(
      { error: 'US screener failed', message: (error as Error).message },
      { status: 500 },
    )
  }
}
