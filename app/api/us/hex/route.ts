import { gzipSync } from 'node:zlib'
import { NextRequest, NextResponse } from 'next/server'
import { execAll, execGet } from '@/lib/db/client'
import { execUsAnalyticsAll, hasUsAnalyticsDb } from '@/lib/db/us-analytics'
import { US_HEX_ROWS_SQL, usHexRowsParams, type UsHexRawRow } from '@/lib/server/us-hex-serving'
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
  sector17_name?: string | null
  sector33_name?: string | null
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
  ml_candidate_direction?: 'up' | 'down' | null
  ml_candidate_rank?: number | null
  ml_candidate_summary?: string | null
  physical_momentum_score: number | null
}

type CacheValue = {
  expiresAt: number
  hitResponse?: SerializedJson
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

type SerializedJson = {
  plain: string
  gzip: Uint8Array<ArrayBuffer> | null
}

function numeric(value: unknown): number | null {
  if (value == null || value === '') return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function percentChange(current: number | null, previous: number | null): number | null {
  if (current == null || previous == null || previous <= 0) return null
  return 100 * (current - previous) / previous
}

function serializeJson(payload: unknown): SerializedJson {
  const plain = JSON.stringify(payload)
  return {
    plain,
    gzip: plain.length > 1024 ? Uint8Array.from(gzipSync(plain)) : null,
  }
}

function serializedJsonResponse(request: NextRequest, serialized: SerializedJson): NextResponse {
  const headers = new Headers({ 'content-type': 'application/json; charset=utf-8' })
  if (serialized.gzip && /\bgzip\b/i.test(request.headers.get('accept-encoding') ?? '')) {
    headers.set('content-encoding', 'gzip')
    headers.set('vary', 'Accept-Encoding')
    return new NextResponse(serialized.gzip, { headers })
  }
  return new NextResponse(serialized.plain, { headers })
}

function jsonResponse(request: NextRequest, payload: unknown): NextResponse {
  return serializedJsonResponse(request, serializeJson(payload))
}

function compactUsHexRow(row: UsHexRow): UsHexRow {
  const compact = { ...row }
  delete compact.sector17_name
  delete compact.sector33_name
  delete compact.ml_candidate_direction
  delete compact.ml_candidate_rank
  delete compact.ml_candidate_summary
  return compact
}

async function resolveDate(requested: string | null): Promise<string | null> {
  if (requested && /^\d{4}-\d{2}-\d{2}$/.test(requested)) {
    const row = await execGet<{ date: string | null }>(
      `SELECT MAX(date) AS date
       FROM market_daily_snapshots
       WHERE market = 'US' AND date <= ?`,
      [requested],
    )
    return row?.date ?? null
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

function stageForTimeframe(row: UsHexRawRow, timeframe: Timeframe): number | null {
  if (timeframe === 'weekly') return numeric(row.weekly_a_stage)
  if (timeframe === 'monthly') return numeric(row.monthly_a_stage)
  return numeric(row.daily_a_stage)
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const requestedDate = searchParams.get('date')
    const compact = searchParams.get('compact') === '1'
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
        notice: requestedDate
          ? 'No US market data is available on or before the requested date.'
          : 'USステージスナップショットが未生成です。',
      })
    }

    const cacheKey = `all-investable-v3:${date}:${timeframe}:${compact ? 'compact-v1' : 'legacy-v1'}`
    const cached = cache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) {
      cached.hitResponse ??= serializeJson({ ...cached.payload, cache: 'hit' })
      return serializedJsonResponse(request, cached.hitResponse)
    }

    const [rows, physicalMomentum, universe] = await Promise.all([
      execAll<UsHexRawRow>(US_HEX_ROWS_SQL, usHexRowsParams(date)),
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
      data: compact ? data.map(compactUsHexRow) : data,
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
