import { gzipSync } from 'node:zlib'
import { NextRequest, NextResponse } from 'next/server'
import { execAll, execGet } from '@/lib/db/client'
import { execUsAnalyticsAll, hasUsAnalyticsDb } from '@/lib/db/us-analytics'
import {
  US_HEX_HISTORICAL_ROWS_SQL,
  US_HEX_ROWS_SQL,
  buildUsHexRow,
  compactUsHexRow,
  numeric,
  usHexRowsParams,
  type UsHexRawRow,
  type UsHexRow,
} from '@/lib/server/us-hex-serving'
import {
  US_HEX_WIRE_PARAM,
  US_HEX_WIRE_REQUEST,
  encodeUsHexColumnar,
  type UsHexColumnarBody,
  type UsHexAttributeBasis,
  type UsHexCoverage,
  type UsHexTimeframe,
  type UsHexUniverse,
} from '@/lib/us-hex-wire'
import { usInvestableSymbolSql, usTestSymbolExclusionSql } from '@/lib/us-symbol-quality'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'
export const maxDuration = 60

type Timeframe = UsHexTimeframe

// legacy-v1: 既定 / compact-v1: ?compact=1 / columnar-v1: versioned wire (US Stage Screener 専用)
type ResponseFormat = 'legacy-v1' | 'compact-v1' | 'columnar-v1'

type CacheValue = {
  expiresAt: number
  hitResponse?: SerializedJson
  payload: {
    success: true
    count: number
    date: string
    timeframe: Timeframe
    source: 'tiingo'
    universe: UsHexUniverse | null
    coverage: UsHexCoverage
    attributeBasis: UsHexAttributeBasis
    notice?: string
  } & ({ data: UsHexRow[] } | UsHexColumnarBody)
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

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day
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

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const requestedDates = searchParams.getAll('date')
    if (requestedDates.length > 1 || (requestedDates[0] != null && !isCalendarDate(requestedDates[0]))) {
      return NextResponse.json({ error: 'invalid_date' }, { status: 400 })
    }
    const requestedDate = requestedDates[0] ?? null
    const compact = searchParams.get('compact') === '1'
    const wire = searchParams.get(US_HEX_WIRE_PARAM)
    if (wire != null && wire !== US_HEX_WIRE_REQUEST) {
      // 未知の wire version は旧形式へ黙ってフォールバックせず、クライアントを fail closed させる
      return NextResponse.json(
        { error: 'Unsupported US HEX wire format', supported: [US_HEX_WIRE_REQUEST] },
        { status: 400 },
      )
    }
    const format: ResponseFormat = wire != null ? 'columnar-v1' : compact ? 'compact-v1' : 'legacy-v1'
    const timeframe: Timeframe = searchParams.get('timeframe') === 'weekly'
      ? 'weekly'
      : searchParams.get('timeframe') === 'monthly'
        ? 'monthly'
        : 'daily'
    const date = await resolveDate(requestedDate)
    if (!date) {
      return NextResponse.json(
        {
          error: requestedDate ? 'unavailable_date' : 'snapshot_unavailable',
          notice: requestedDate
            ? 'No US market data is available on or before the requested date.'
            : 'USステージスナップショットが未生成です。',
        },
        { status: 404 },
      )
    }

    const latest = await execGet<{ date: string | null }>(
      `SELECT MAX(date) AS date FROM market_daily_snapshots WHERE market = 'US'`,
    )
    const historical = latest?.date != null && date !== latest.date

    const cacheKey = `all-investable-v4:${historical ? 'historical' : 'current'}:${date}:${timeframe}:${format}`
    const cached = cache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) {
      cached.hitResponse ??= serializeJson({ ...cached.payload, cache: 'hit' })
      return serializedJsonResponse(request, cached.hitResponse)
    }

    const [rows, physicalMomentum, currentUniverse] = await Promise.all([
      execAll<UsHexRawRow>(
        historical ? US_HEX_HISTORICAL_ROWS_SQL : US_HEX_ROWS_SQL,
        usHexRowsParams(date, historical),
      ),
      loadPhysicalMomentum(date),
      historical ? Promise.resolve(null) : execGet<UsHexUniverse>(
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

    const data: UsHexRow[] = rows.map((row) => buildUsHexRow(row, timeframe, physicalMomentum))
    const attributeBasis: UsHexAttributeBasis = historical
      ? {
          membership: 'SNAPSHOT_DATE',
          profiles: 'CURRENT_REFERENCE',
          classifications: 'UNAVAILABLE',
          shares: 'UNAVAILABLE',
        }
      : {
          membership: 'CURRENT_UNIVERSE',
          profiles: 'CURRENT_REFERENCE',
          classifications: 'CURRENT_REFERENCE',
          shares: 'CURRENT_REFERENCE',
        }

    const payload: CacheValue['payload'] = {
      success: true,
      ...(format === 'columnar-v1'
        ? encodeUsHexColumnar(data)
        : { data: format === 'compact-v1' ? data.map(compactUsHexRow) : data }),
      count: data.length,
      date,
      timeframe,
      source: 'tiingo',
      universe: currentUniverse == null ? null : {
        activeAll: Number(currentUniverse.activeAll ?? 0),
        productionActive: Number(currentUniverse.productionActive ?? 0),
        stocks: Number(currentUniverse.stocks ?? 0),
        etfs: Number(currentUniverse.etfs ?? 0),
        mutualFunds: Number(currentUniverse.mutualFunds ?? 0),
        testSymbols: Number(currentUniverse.testSymbols ?? 0),
        excludedArtifacts: Number(currentUniverse.excludedArtifacts ?? 0),
      },
      attributeBasis,
      ...(historical
        ? { notice: 'Historical membership uses the requested Stage snapshot. Historical classifications and shares are unavailable.' }
        : {}),
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
      { error: 'us_hex_failed' },
      { status: 500 },
    )
  }
}
