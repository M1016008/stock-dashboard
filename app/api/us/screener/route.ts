import { NextRequest, NextResponse } from 'next/server'
import { execAll, execGet } from '@/lib/db/client'
import { execUsAnalyticsAll, hasUsAnalyticsDb } from '@/lib/db/us-analytics'
import { US_SEC_SIC_TAXONOMY } from '@/lib/us-classification'
import { findUsAliasTickers, getUsDisplayName } from '@/lib/us-symbol-aliases'
import { buildShortTermCheck } from '@/lib/short-term-check'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

const SORT_KEYS = new Set([
  'ticker',
  'name',
  'price',
  'changePct',
  'volume',
  'avgVolume20',
  'marketCap',
  'stageCode',
  'sector',
  'industry',
  'exchange',
  'pms',
  'pfs',
  'pes',
  'shortTermCheckScore',
  'shortTermCheckLabel',
])

function numeric(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

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
    const exchange = searchParams.get('exchange')?.trim()
    const stageCode = searchParams.get('stageCode')?.trim()
    const avgVolumeMinParam = searchParams.get('avgVolumeMin')?.trim()
    const priceMinParam = searchParams.get('priceMin')?.trim()
    const priceMaxParam = searchParams.get('priceMax')?.trim()
    const avgVolumeMin = avgVolumeMinParam ? Number(avgVolumeMinParam) : null
    const avgVolumeFilter = avgVolumeMin != null && Number.isFinite(avgVolumeMin) && avgVolumeMin > 0 ? avgVolumeMin : null
    const priceMin = priceMinParam ? Number(priceMinParam) : null
    const priceMax = priceMaxParam ? Number(priceMaxParam) : null
    const qAliasTickers = q ? findUsAliasTickers(q) : []
    const qAliasPlaceholders = qAliasTickers.map(() => '?').join(',')
    const physicalSort = sort === 'pms' || sort === 'pfs' || sort === 'pes'
    const computedSort = sort === 'shortTermCheckScore' || sort === 'shortTermCheckLabel'
    const useAnalyticsMetricTop =
      physicalSort
      && hasUsAnalyticsDb()
      && !q
      && !sector
      && !industry
      && !exchange
      && !stageCode
      && !avgVolumeFilter
      && !(priceMin != null && Number.isFinite(priceMin))
      && !(priceMax != null && Number.isFinite(priceMax))
    const metricColumn =
      sort === 'pms' ? 'physical_momentum_score'
        : sort === 'pfs' ? 'physical_force_score'
          : 'physical_energy_score'
    const metricTopLimit = Math.max(limit * 2, 50)
    const topMetricRows = useAnalyticsMetricTop
      ? await execUsAnalyticsAll<{
          symbol: string
          physical_momentum_score: number | null
          physical_force_score: number | null
          physical_energy_score: number | null
        }>(
          `
          WITH latest_date AS (
            SELECT MAX(date) AS date
            FROM physical_momentum_metrics
            WHERE market = 'US'
              AND date <= ?
          )
          SELECT
            symbol,
            physical_momentum_score,
            physical_force_score,
            physical_energy_score
          FROM physical_momentum_metrics
          WHERE market = 'US'
            AND date = (SELECT date FROM latest_date)
            AND ${metricColumn} IS NOT NULL
          ORDER BY ${metricColumn} ${dir.toUpperCase()}, symbol ASC
          LIMIT ?
          `,
          [date, metricTopLimit],
        ).catch(() => [])
      : []
    const topMetricTickers = topMetricRows.map((row) => row.symbol).filter(Boolean)
    const metricMap = new Map(topMetricRows.map((row) => [row.symbol, row]))
    const sqlLimit = topMetricTickers.length > 0 ? topMetricTickers.length : physicalSort || computedSort ? Math.max(limit * 30, 5000) : limit
    const whereMetricTop = topMetricTickers.length > 0 ? `AND s.ticker IN (${topMetricTickers.map(() => '?').join(',')})` : ''
    const physicalMetricColumns = useAnalyticsMetricTop
      ? `
        NULL AS physical_momentum_score,
        NULL AS physical_force_score,
        NULL AS physical_energy_score
      `
      : `
        pm.physical_momentum_score,
        pm.physical_force_score,
        pm.physical_energy_score
      `
    const physicalMetricJoin = useAnalyticsMetricTop
      ? ''
      : `
      LEFT JOIN physical_momentum_metrics pm
        ON pm.market = 'US'
       AND pm.symbol = s.ticker
       AND pm.date = s.date
      `
    const whereExchange = exchange ? `AND u.exchange = ?` : ''
    const whereQ = q
      ? `AND (s.ticker LIKE ? OR UPPER(COALESCE(u.name, '')) LIKE ?${qAliasTickers.length ? ` OR s.ticker IN (${qAliasPlaceholders})` : ''})`
      : ''
    const whereSector = sector ? `AND COALESCE(c.sector_name, u.sector) = ?` : ''
    const whereIndustry = industry ? `AND COALESCE(c.industry_name, u.industry) = ?` : ''
    const whereStageCode = stageCode ? `AND (s.daily_a_stage || s.daily_b_stage || s.weekly_a_stage || s.weekly_b_stage || s.monthly_a_stage || s.monthly_b_stage) LIKE ?` : ''
    const whereAvgVolume = avgVolumeFilter ? `AND COALESCE(avg20.avg_volume_20, 0) >= ?` : ''
    const wherePriceMin = priceMin != null && Number.isFinite(priceMin) ? `AND cur.close >= ?` : ''
    const wherePriceMax = priceMax != null && Number.isFinite(priceMax) ? `AND cur.close <= ?` : ''
    const args: Array<string | number> = [date, date, taxonomy, date, date]
    if (q) args.push(`%${q}%`, `%${q.toUpperCase()}%`, ...qAliasTickers)
    if (sector) args.push(sector)
    if (industry) args.push(industry)
    if (exchange) args.push(exchange)
    if (stageCode) args.push(`${stageCode}%`)
    if (avgVolumeFilter) args.push(avgVolumeFilter)
    if (priceMin != null && Number.isFinite(priceMin)) args.push(priceMin)
    if (priceMax != null && Number.isFinite(priceMax)) args.push(priceMax)
    if (topMetricTickers.length > 0) args.push(...topMetricTickers)
    args.push(sqlLimit)

    const orderExpr: Record<string, string> = {
      ticker: 's.ticker',
      name: 'COALESCE(u.name, s.ticker)',
      price: 'cur.close',
      changePct: 'change_pct',
      volume: 'cur.volume',
      avgVolume20: 'avg_volume_20',
      marketCap: 'market_cap',
      stageCode: 'stage_code',
      sector: 'sector',
      industry: 'industry',
      exchange: 'u.exchange',
      pms: 'pm.physical_momentum_score',
      pfs: 'pm.physical_force_score',
      pes: 'pm.physical_energy_score',
      shortTermCheckScore: 's.ticker',
      shortTermCheckLabel: 's.ticker',
    }
    const rows = await execAll<Record<string, unknown>>(
      `
      WITH prev_date AS (
        SELECT MAX(date) AS date
        FROM market_ohlcv_daily INDEXED BY market_ohlcv_market_date_idx
        WHERE market = 'US' AND date < ?
      ),
      avg20 AS (
        SELECT ticker, AVG(volume) AS avg_volume_20
        FROM market_ohlcv_daily
        WHERE market = 'US'
          AND date IN (
            SELECT date
            FROM market_ohlcv_daily
            WHERE market = 'US'
              AND date <= ?
            GROUP BY date
            ORDER BY date DESC
            LIMIT 20
        )
        GROUP BY ticker
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
        avg20.avg_volume_20,
        CASE WHEN cur.volume > 0 AND prev.volume > 0 AND prev.close > 0 THEN 100.0 * (cur.close - prev.close) / prev.close END AS change_pct,
        CASE WHEN u.shares_outstanding IS NOT NULL AND cur.close IS NOT NULL THEN u.shares_outstanding * cur.close END AS market_cap,
        s.daily_a_stage || s.daily_b_stage || s.weekly_a_stage || s.weekly_b_stage || s.monthly_a_stage || s.monthly_b_stage AS stage_code,
        s.daily_a_stage,
        s.daily_b_stage,
        s.weekly_a_stage,
        s.weekly_b_stage,
        s.monthly_a_stage,
        s.monthly_b_stage,
        s.ma_5,
        s.ma_25,
        s.ma_75,
        s.ma_300,
        ${physicalMetricColumns}
      FROM market_daily_snapshots s INDEXED BY market_snapshots_market_date_ticker_idx
      LEFT JOIN market_universe u ON u.market = s.market AND u.ticker = s.ticker
      LEFT JOIN market_classifications c
        ON c.market = s.market
       AND c.ticker = s.ticker
       AND c.taxonomy = ?
       AND c.effective_from = '0000-01-01'
      LEFT JOIN market_ohlcv_daily cur INDEXED BY market_ohlcv_market_ticker_date_idx
        ON cur.market = 'US'
       AND cur.ticker = s.ticker
       AND cur.date = ?
      LEFT JOIN avg20 ON avg20.ticker = s.ticker
      LEFT JOIN market_ohlcv_daily prev INDEXED BY market_ohlcv_market_ticker_date_idx
        ON prev.market = 'US'
       AND prev.ticker = s.ticker
       AND prev.date = (SELECT date FROM prev_date)
      ${physicalMetricJoin}
      WHERE s.market = 'US' AND s.date = ?
        ${whereQ}
        ${whereSector}
        ${whereIndustry}
        ${whereExchange}
        ${whereStageCode}
        ${whereAvgVolume}
        ${wherePriceMin}
        ${wherePriceMax}
        ${whereMetricTop}
      ORDER BY ${useAnalyticsMetricTop ? 's.ticker' : orderExpr[sort]} ${dir.toUpperCase()}, s.ticker ASC
      LIMIT ?
      `,
      args,
    )
    if (hasUsAnalyticsDb() && rows.length > 0) {
      const tickers = rows
        .map((row) => String(row.ticker))
        .filter((ticker) => ticker && !metricMap.has(ticker))
      const placeholders = tickers.map(() => '?').join(',')
      const metrics = tickers.length > 0 ? await execUsAnalyticsAll<{
        symbol: string
        physical_momentum_score: number | null
        physical_force_score: number | null
        physical_energy_score: number | null
      }>(
        `
        WITH latest AS (
          SELECT symbol, market, MAX(date) AS date
          FROM physical_momentum_metrics
          WHERE market IN ('US', 'JP')
            AND date <= ?
            AND symbol IN (${placeholders})
          GROUP BY symbol, market
        ),
        ranked AS (
          SELECT
            pm.symbol,
            pm.physical_momentum_score,
            pm.physical_force_score,
            pm.physical_energy_score,
            ROW_NUMBER() OVER (
              PARTITION BY pm.symbol
              ORDER BY CASE pm.market WHEN 'US' THEN 0 ELSE 1 END, pm.date DESC
            ) AS rn
          FROM physical_momentum_metrics pm
          INNER JOIN latest l ON l.symbol = pm.symbol AND l.market = pm.market AND l.date = pm.date
        )
        SELECT
          symbol,
          physical_momentum_score,
          physical_force_score,
          physical_energy_score
        FROM ranked
        WHERE rn = 1
        `,
        [date, ...tickers],
      ).catch(() => []) : []
      for (const metric of metrics) metricMap.set(metric.symbol, metric)
      for (const row of rows) {
        const metric = metricMap.get(String(row.ticker))
        if (!metric) continue
        row.physical_momentum_score = metric.physical_momentum_score
        row.physical_force_score = metric.physical_force_score
        row.physical_energy_score = metric.physical_energy_score
      }
    }

    if (physicalSort) {
      const key =
        sort === 'pms' ? 'physical_momentum_score'
          : sort === 'pfs' ? 'physical_force_score'
            : 'physical_energy_score'
      rows.sort((a, b) => {
        const av = Number(a[key] ?? (dir === 'desc' ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY))
        const bv = Number(b[key] ?? (dir === 'desc' ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY))
        if (av === bv) return String(a.ticker).localeCompare(String(b.ticker))
        return dir === 'desc' ? bv - av : av - bv
      })
    }

    for (const row of rows) {
      row.name = getUsDisplayName(String(row.ticker), typeof row.name === 'string' ? row.name : null)
      const shortTerm = buildShortTermCheck({
        stages: {
          dailyA: numeric(row.daily_a_stage),
          dailyB: numeric(row.daily_b_stage),
          weeklyA: numeric(row.weekly_a_stage),
          weeklyB: numeric(row.weekly_b_stage),
          monthlyA: numeric(row.monthly_a_stage),
          monthlyB: numeric(row.monthly_b_stage),
        },
        physicalMomentumScore: numeric(row.physical_momentum_score),
        physicalForceScore: numeric(row.physical_force_score),
        changePercent: numeric(row.change_pct),
      })
      row.shortTermCheckLabel = shortTerm.label
      row.shortTermCheckScore = shortTerm.score
      row.shortTermCheckReasons = shortTerm.reasons
      row.shortTermCheckMlText = shortTerm.mlText
    }

    if (computedSort) {
      rows.sort((a, b) => {
        const av = sort === 'shortTermCheckScore' ? numeric(a.shortTermCheckScore) : String(a.shortTermCheckLabel ?? '')
        const bv = sort === 'shortTermCheckScore' ? numeric(b.shortTermCheckScore) : String(b.shortTermCheckLabel ?? '')
        if (typeof av === 'number' && typeof bv === 'number') {
          if (av === bv) return String(a.ticker).localeCompare(String(b.ticker))
          return dir === 'desc' ? bv - av : av - bv
        }
        const cmp = String(av).localeCompare(String(bv), 'ja')
        if (cmp !== 0) return dir === 'desc' ? -cmp : cmp
        return String(a.ticker).localeCompare(String(b.ticker))
      })
    }

    return NextResponse.json({ market: 'US', date, rows: rows.slice(0, limit), count: Math.min(rows.length, limit), source: 'tiingo', mlSource: hasUsAnalyticsDb() ? 'us_analytics' : 'main' })
  } catch (error) {
    console.error('US screener API error:', error)
    return NextResponse.json(
      { error: 'US screener failed', message: (error as Error).message },
      { status: 500 },
    )
  }
}
