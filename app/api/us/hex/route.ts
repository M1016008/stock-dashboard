import { gzipSync } from 'node:zlib'
import { NextRequest, NextResponse } from 'next/server'
import { execAll, execGet } from '@/lib/db/client'
import { execUsAnalyticsAll, hasUsAnalyticsDb } from '@/lib/db/us-analytics'
import { US_SEC_SIC_TAXONOMY } from '@/lib/us-classification'
import { getUsDisplayName } from '@/lib/us-symbol-aliases'
import { usInvestableSymbolSql, usTestSymbolExclusionSql } from '@/lib/us-symbol-quality'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'
export const maxDuration = 60

type Timeframe = 'daily' | 'weekly' | 'monthly'

type UsHexRow = {
  code: string
  name: string
  sector_large: string
  sector_small: string | null
  sector17_name: string | null
  sector33_name: string | null
  market_segment: string | null
  margin_type: string | null
  market_cap: number
  price: number | null
  daily_change: number | null
  weekly_change: number | null
  monthly_change: number | null
  months3_change: number | null
  months6_change: number | null
  ytd_change: number | null
  data_status: 'ready' | 'partial_stage' | 'snapshot_pending' | 'price_pending'
  stage: number | null
  daily_a_stage: number | null
  daily_b_stage: number | null
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
  sma_angles: {
    sma5: number | null
    sma25: number | null
    sma75: number | null
    sma300: number | null
  }
  prev_sma_angles: {
    sma5: number | null
    sma25: number | null
    sma75: number | null
    sma300: number | null
  }
  ml_candidate_direction: 'up' | 'down' | null
  ml_candidate_rank: number | null
  ml_candidate_summary: string | null
  physical_momentum_score: number | null
}

type RawRow = {
  ticker: string
  snapshot_ticker: string | null
  name: string | null
  exchange: string | null
  asset_type: string | null
  sector: string | null
  industry: string | null
  shares_outstanding: number | null
  price: number | null
  perf_1d: number | null
  perf_1w: number | null
  perf_1m: number | null
  perf_3m: number | null
  perf_6m: number | null
  perf_ytd: number | null
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
  prev_ma_5: number | null
  prev_ma_25: number | null
  prev_ma_75: number | null
  prev_ma_300: number | null
  prev2_ma_5: number | null
  prev2_ma_25: number | null
  prev2_ma_75: number | null
  prev2_ma_300: number | null
}

type CacheValue = {
  expiresAt: number
  payload: {
    success: true
    data: UsHexRow[]
    count: number
    date: string
    timeframe: Timeframe
    source: 'tiingo'
    universe: UsHexUniverse
    coverage: UsHexCoverage
  }
}

type UsHexUniverse = {
  activeAll: number
  productionActive: number
  stocks: number
  etfs: number
  mutualFunds: number
  testSymbols: number
  excludedArtifacts: number
}

type UsHexCoverage = {
  prices: number
  snapshots: number
  dailyAStage: number
  dailyStage: number
  weeklyStage: number
  monthlyStage: number
}

const CACHE_TTL_MS = 15 * 60 * 1_000
const globalForUsHex = globalThis as typeof globalThis & {
  usHexCache?: Map<string, CacheValue>
}
const cache = globalForUsHex.usHexCache ?? new Map<string, CacheValue>()
globalForUsHex.usHexCache = cache

function numeric(value: unknown): number | null {
  if (value == null || value === '') return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function percentChange(current: number | null, previous: number | null): number | null {
  if (current == null || previous == null || previous <= 0) return null
  return 100 * (current - previous) / previous
}

function jsonResponse(request: NextRequest, payload: unknown): NextResponse {
  const json = JSON.stringify(payload)
  const headers = new Headers({ 'content-type': 'application/json; charset=utf-8' })
  if (json.length > 1024 && /\bgzip\b/i.test(request.headers.get('accept-encoding') ?? '')) {
    headers.set('content-encoding', 'gzip')
    headers.set('vary', 'Accept-Encoding')
    return new NextResponse(gzipSync(json), { headers })
  }
  return new NextResponse(json, { headers })
}

async function resolveDate(requested: string | null): Promise<string | null> {
  if (requested && /^\d{4}-\d{2}-\d{2}$/.test(requested)) {
    const row = await execGet<{ date: string | null }>(
      `SELECT MAX(date) AS date
       FROM market_daily_snapshots
       WHERE market = 'US' AND date <= ?`,
      [requested],
    )
    if (row?.date) return row.date
  }
  const row = await execGet<{ date: string | null }>(
    `SELECT MAX(date) AS date FROM market_daily_snapshots WHERE market = 'US'`,
  )
  return row?.date ?? null
}

async function loadPhysicalMomentum(date: string): Promise<Map<string, number | null>> {
  if (!hasUsAnalyticsDb()) return new Map()
  const rows = await execUsAnalyticsAll<{ symbol: string; physical_momentum_score: number | null }>(
    `
    WITH latest_date AS (
      SELECT MAX(date) AS date
      FROM physical_momentum_metrics
      WHERE market = 'US' AND date <= ?
    )
    SELECT symbol, physical_momentum_score
    FROM physical_momentum_metrics
    WHERE market = 'US'
      AND date = (SELECT date FROM latest_date)
    `,
    [date],
  ).catch(() => [])
  return new Map(rows.map((row) => [row.symbol, numeric(row.physical_momentum_score)]))
}

function stageForTimeframe(row: RawRow, timeframe: Timeframe): number | null {
  if (timeframe === 'weekly') return numeric(row.weekly_a_stage)
  if (timeframe === 'monthly') return numeric(row.monthly_a_stage)
  return numeric(row.daily_a_stage)
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const requestedDate = searchParams.get('date')
    const timeframe: Timeframe = searchParams.get('timeframe') === 'weekly'
      ? 'weekly'
      : searchParams.get('timeframe') === 'monthly'
        ? 'monthly'
        : 'daily'
    const date = await resolveDate(requestedDate)
    if (!date) {
      return jsonResponse(request, {
        success: true,
        data: [],
        count: 0,
        date: null,
        timeframe,
        source: 'tiingo',
        notice: 'USステージスナップショットが未生成です。',
      })
    }

    const cacheKey = `all-investable-v2:${date}:${timeframe}`
    const cached = cache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) {
      return jsonResponse(request, { ...cached.payload, cache: 'hit' })
    }

    const [rows, physicalMomentum, universe] = await Promise.all([
      execAll<RawRow>(
        `
        WITH anchors AS (
          SELECT
            (SELECT MAX(date) FROM market_daily_snapshots WHERE market = 'US' AND date < ?) AS prev_snapshot,
            (SELECT MAX(date) FROM market_daily_snapshots
              WHERE market = 'US'
                AND date < (SELECT MAX(date) FROM market_daily_snapshots WHERE market = 'US' AND date < ?)
            ) AS prev2_snapshot,
            (SELECT MAX(date) FROM market_ohlcv_daily WHERE market = 'US' AND date < ?) AS day_1,
            (SELECT MAX(date) FROM market_ohlcv_daily WHERE market = 'US' AND date <= date(?, '-7 days')) AS week_1,
            (SELECT MAX(date) FROM market_ohlcv_daily WHERE market = 'US' AND date <= date(?, '-1 month')) AS month_1,
            (SELECT MAX(date) FROM market_ohlcv_daily WHERE market = 'US' AND date <= date(?, '-3 months')) AS month_3,
            (SELECT MAX(date) FROM market_ohlcv_daily WHERE market = 'US' AND date <= date(?, '-6 months')) AS month_6,
            (SELECT MAX(date) FROM market_ohlcv_daily WHERE market = 'US' AND date <= substr(?, 1, 4) || '-01-01') AS year_start
        )
        SELECT
          u.ticker,
          s.ticker AS snapshot_ticker,
          u.name,
          u.exchange,
          u.asset_type,
          COALESCE(c.sector_name, u.sector, 'Unclassified') AS sector,
          COALESCE(c.industry_name, u.industry) AS industry,
          u.shares_outstanding,
          COALESCE(cur.adj_close, cur.close) AS price,
          CASE WHEN COALESCE(p1.adj_close, p1.close) > 0
            THEN 100.0 * (COALESCE(cur.adj_close, cur.close) - COALESCE(p1.adj_close, p1.close)) / COALESCE(p1.adj_close, p1.close)
          END AS perf_1d,
          CASE WHEN COALESCE(w1.adj_close, w1.close) > 0
            THEN 100.0 * (COALESCE(cur.adj_close, cur.close) - COALESCE(w1.adj_close, w1.close)) / COALESCE(w1.adj_close, w1.close)
          END AS perf_1w,
          CASE WHEN COALESCE(m1.adj_close, m1.close) > 0
            THEN 100.0 * (COALESCE(cur.adj_close, cur.close) - COALESCE(m1.adj_close, m1.close)) / COALESCE(m1.adj_close, m1.close)
          END AS perf_1m,
          CASE WHEN COALESCE(m3.adj_close, m3.close) > 0
            THEN 100.0 * (COALESCE(cur.adj_close, cur.close) - COALESCE(m3.adj_close, m3.close)) / COALESCE(m3.adj_close, m3.close)
          END AS perf_3m,
          CASE WHEN COALESCE(m6.adj_close, m6.close) > 0
            THEN 100.0 * (COALESCE(cur.adj_close, cur.close) - COALESCE(m6.adj_close, m6.close)) / COALESCE(m6.adj_close, m6.close)
          END AS perf_6m,
          CASE WHEN COALESCE(ytd.adj_close, ytd.close) > 0
            THEN 100.0 * (COALESCE(cur.adj_close, cur.close) - COALESCE(ytd.adj_close, ytd.close)) / COALESCE(ytd.adj_close, ytd.close)
          END AS perf_ytd,
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
          prev.ma_5 AS prev_ma_5,
          prev.ma_25 AS prev_ma_25,
          prev.ma_75 AS prev_ma_75,
          prev.ma_300 AS prev_ma_300,
          prev2.ma_5 AS prev2_ma_5,
          prev2.ma_25 AS prev2_ma_25,
          prev2.ma_75 AS prev2_ma_75,
          prev2.ma_300 AS prev2_ma_300
        FROM market_universe u INDEXED BY market_universe_market_active_idx
        CROSS JOIN anchors
        LEFT JOIN market_daily_snapshots s INDEXED BY market_snapshots_market_date_ticker_idx
          ON s.market = 'US' AND s.ticker = u.ticker AND s.date = ?
        LEFT JOIN market_classifications c
          ON c.market = 'US'
         AND c.ticker = u.ticker
         AND c.taxonomy = ?
         AND c.effective_from = '0000-01-01'
        LEFT JOIN market_daily_snapshots prev
          ON prev.market = 'US' AND prev.ticker = u.ticker AND prev.date = anchors.prev_snapshot
        LEFT JOIN market_daily_snapshots prev2
          ON prev2.market = 'US' AND prev2.ticker = u.ticker AND prev2.date = anchors.prev2_snapshot
        LEFT JOIN market_ohlcv_daily cur
          ON cur.market = 'US' AND cur.ticker = u.ticker AND cur.date = ?
        LEFT JOIN market_ohlcv_daily p1
          ON p1.market = 'US' AND p1.ticker = u.ticker AND p1.date = anchors.day_1
        LEFT JOIN market_ohlcv_daily w1
          ON w1.market = 'US' AND w1.ticker = u.ticker AND w1.date = anchors.week_1
        LEFT JOIN market_ohlcv_daily m1
          ON m1.market = 'US' AND m1.ticker = u.ticker AND m1.date = anchors.month_1
        LEFT JOIN market_ohlcv_daily m3
          ON m3.market = 'US' AND m3.ticker = u.ticker AND m3.date = anchors.month_3
        LEFT JOIN market_ohlcv_daily m6
          ON m6.market = 'US' AND m6.ticker = u.ticker AND m6.date = anchors.month_6
        LEFT JOIN market_ohlcv_daily ytd
          ON ytd.market = 'US' AND ytd.ticker = u.ticker AND ytd.date = anchors.year_start
        WHERE u.market = 'US'
          AND u.active = 1
          AND ${usInvestableSymbolSql('u.ticker')}
        ORDER BY u.ticker
        `,
        [date, date, date, date, date, date, date, date, date, US_SEC_SIC_TAXONOMY, date],
      ),
      loadPhysicalMomentum(date),
      execGet<UsHexUniverse>(
        `SELECT
           SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END) AS activeAll,
           SUM(CASE WHEN active = 1 AND ${usInvestableSymbolSql('ticker')} THEN 1 ELSE 0 END) AS productionActive,
           SUM(CASE WHEN active = 1 AND ${usInvestableSymbolSql('ticker')} AND asset_type = 'Stock' THEN 1 ELSE 0 END) AS stocks,
           SUM(CASE WHEN active = 1 AND ${usInvestableSymbolSql('ticker')} AND asset_type = 'ETF' THEN 1 ELSE 0 END) AS etfs,
           SUM(CASE WHEN active = 1 AND ${usInvestableSymbolSql('ticker')} AND asset_type = 'Mutual Fund' THEN 1 ELSE 0 END) AS mutualFunds,
           SUM(CASE WHEN active = 1 AND NOT (${usTestSymbolExclusionSql('ticker')}) THEN 1 ELSE 0 END) AS testSymbols,
           SUM(CASE WHEN active = 1 AND ${usTestSymbolExclusionSql('ticker')} AND NOT (${usInvestableSymbolSql('ticker')}) THEN 1 ELSE 0 END) AS excludedArtifacts
         FROM market_universe
         WHERE market = 'US'`,
      ),
    ])

    const data: UsHexRow[] = rows.map((row) => {
      const price = numeric(row.price)
      const sector = row.sector || 'Unclassified'
      const stages = [
        row.daily_a_stage,
        row.daily_b_stage,
        row.weekly_a_stage,
        row.weekly_b_stage,
        row.monthly_a_stage,
        row.monthly_b_stage,
      ]
      const dataStatus: UsHexRow['data_status'] = price == null
        ? 'price_pending'
        : row.snapshot_ticker == null
          ? 'snapshot_pending'
          : stages.some((value) => numeric(value) == null)
            ? 'partial_stage'
            : 'ready'
      return {
        code: row.ticker,
        name: getUsDisplayName(row.ticker, row.name),
        sector_large: sector,
        sector_small: row.industry,
        sector17_name: sector,
        sector33_name: row.industry,
        market_segment: row.exchange,
        margin_type: row.asset_type || 'Stock',
        market_cap: row.shares_outstanding && price != null && price > 0 ? row.shares_outstanding * price : 0,
        price,
        daily_change: numeric(row.perf_1d),
        weekly_change: numeric(row.perf_1w),
        monthly_change: numeric(row.perf_1m),
        months3_change: numeric(row.perf_3m),
        months6_change: numeric(row.perf_6m),
        ytd_change: numeric(row.perf_ytd),
        data_status: dataStatus,
        stage: stageForTimeframe(row, timeframe),
        daily_a_stage: numeric(row.daily_a_stage),
        daily_b_stage: numeric(row.daily_b_stage),
        weekly_a_stage: numeric(row.weekly_a_stage),
        weekly_b_stage: numeric(row.weekly_b_stage),
        monthly_a_stage: numeric(row.monthly_a_stage),
        monthly_b_stage: numeric(row.monthly_b_stage),
        sma_angles: {
          sma5: percentChange(numeric(row.ma_5), numeric(row.prev_ma_5)),
          sma25: percentChange(numeric(row.ma_25), numeric(row.prev_ma_25)),
          sma75: percentChange(numeric(row.ma_75), numeric(row.prev_ma_75)),
          sma300: percentChange(numeric(row.ma_300), numeric(row.prev_ma_300)),
        },
        prev_sma_angles: {
          sma5: percentChange(numeric(row.prev_ma_5), numeric(row.prev2_ma_5)),
          sma25: percentChange(numeric(row.prev_ma_25), numeric(row.prev2_ma_25)),
          sma75: percentChange(numeric(row.prev_ma_75), numeric(row.prev2_ma_75)),
          sma300: percentChange(numeric(row.prev_ma_300), numeric(row.prev2_ma_300)),
        },
        ml_candidate_direction: null,
        ml_candidate_rank: null,
        ml_candidate_summary: null,
        physical_momentum_score: physicalMomentum.get(row.ticker) ?? null,
      }
    })

    const payload: CacheValue['payload'] = {
      success: true,
      data,
      count: data.length,
      date,
      timeframe,
      source: 'tiingo',
      universe: {
        activeAll: Number(universe?.activeAll ?? 0),
        productionActive: Number(universe?.productionActive ?? 0),
        stocks: Number(universe?.stocks ?? 0),
        etfs: Number(universe?.etfs ?? 0),
        mutualFunds: Number(universe?.mutualFunds ?? 0),
        testSymbols: Number(universe?.testSymbols ?? 0),
        excludedArtifacts: Number(universe?.excludedArtifacts ?? 0),
      },
      coverage: {
        prices: data.filter((row) => row.price != null).length,
        snapshots: data.filter((row) => row.data_status !== 'price_pending' && row.data_status !== 'snapshot_pending').length,
        dailyAStage: data.filter((row) => row.daily_a_stage != null).length,
        dailyStage: data.filter((row) => row.daily_a_stage != null && row.daily_b_stage != null).length,
        weeklyStage: data.filter((row) => row.weekly_a_stage != null && row.weekly_b_stage != null).length,
        monthlyStage: data.filter((row) => row.monthly_a_stage != null && row.monthly_b_stage != null).length,
      },
    }
    cache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, payload })
    return jsonResponse(request, { ...payload, cache: 'miss' })
  } catch (error) {
    console.error('US HEX API error:', error)
    return NextResponse.json(
      { error: 'US HEX map fetch failed', message: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}
