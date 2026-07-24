import { NextRequest, NextResponse } from 'next/server'
import { execAll, execGet } from '@/lib/db/client'
import { execUsAnalyticsAll, execUsAnalyticsGet } from '@/lib/db/us-analytics'
import { readServingCache, stableCacheKey, writeServingCache } from '@/lib/api/serving-cache'
import { ML_PHYSICS_FEATURE_SET } from '@/lib/backtest/ml-physics'
import {
  diversifyHistoricalAnalogs,
  isHistoricalAnalogHorizon,
  normalizeHistoricalAnalogSort,
  scoreHistoricalAnalog,
  sortHistoricalAnalogs,
  stageNeighborCodes,
  topHistoricalAnalogComponents,
  type HistoricalAnalogCandidate,
} from '@/lib/ml/historical-analogs'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const STAGE_INDEX_NAME = 'ml_feature_vectors_v2_feature_stage_date_ticker_idx'
const ANALOG_BUCKET_INDEX_NAME = 'ml_feature_vectors_v2_analog_bucket_idx'
const DEFAULT_POOL_LIMIT = boundedEnv('HISTORICAL_ANALOG_POOL_LIMIT', 30_000, 3_000, 30_000)
const CACHE_NAMESPACE = 'historical_analogs_v1'
const CACHE_TTL_MS = boundedEnv(
  'HISTORICAL_ANALOG_CACHE_TTL_MS',
  24 * 60 * 60 * 1_000,
  60_000,
  24 * 60 * 60 * 1_000,
)
const CACHE_MAX_ENTRIES = 100
const BUCKET_VECTOR_INDICES = [11, 15, 25, 26] as const
const BUCKET_SCALE = 5
const BUCKET_RADIUS = 1
const responseCache = new Map<string, { generatedAt: number; payload: Record<string, unknown> }>()

function boundedEnv(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name])
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.floor(parsed)))
}

type Market = 'JP' | 'US'
type DbArgs = readonly (string | number | null)[]

type BaseRow = {
  ticker: string
  date: string
  stage_code: string | null
  feature_json: string
  vector_json: string
  name: string | null
  market_segment: string | null
  sector17_name: string | null
  sector33_name: string | null
}

type CandidateRow = {
  ticker: string
  date: string
  stage_code: string | null
  feature_json: string
  vector_json: string
  name: string | null
  market_segment: string | null
  sector17_name: string | null
  sector33_name: string | null
  return_pct: number | null
  max_return_pct: number | null
  min_return_pct: number | null
}

type EvolutionRow = {
  date: string
  stage_code: string | null
  feature_json: string
}

type CoverageRow = {
  coverage_from: string | null
  coverage_to: string | null
}

type LabelCoverageRow = {
  latest_date: string | null
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function subtractCalendarDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() - days)
  return value.toISOString().slice(0, 10)
}

function finiteValues(values: Array<number | null>): number[] {
  return values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
}

function average(values: number[]): number | null {
  if (values.length === 0) return null
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function quantile(values: number[], ratio: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const position = (sorted.length - 1) * ratio
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower]
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
}

function summarizeOutcomes(rows: Array<{
  returnPct: number | null
  maxReturnPct: number | null
  minReturnPct: number | null
}>) {
  const returns = finiteValues(rows.map((row) => row.returnPct))
  const maxReturns = finiteValues(rows.map((row) => row.maxReturnPct))
  const minReturns = finiteValues(rows.map((row) => row.minReturnPct))
  return {
    sampleCount: returns.length,
    upRate: returns.length > 0 ? returns.filter((value) => value > 0).length / returns.length : null,
    averageReturnPct: average(returns),
    medianReturnPct: quantile(returns, 0.5),
    lowerQuartileReturnPct: quantile(returns, 0.25),
    upperQuartileReturnPct: quantile(returns, 0.75),
    averageMaxReturnPct: average(maxReturns),
    averageMinReturnPct: average(minReturns),
  }
}

function normalizeMarket(value: string | null): Market {
  return value?.toUpperCase() === 'US' ? 'US' : 'JP'
}

function normalizeTicker(value: string | null, market: Market): string | null {
  const normalized = value?.trim().toUpperCase().replace(/\.T$/i, '') ?? ''
  if (!normalized) return null
  if (market === 'JP') return /^\d{4}$/.test(normalized) ? normalized : null
  return /^[A-Z0-9.^-]{1,16}$/.test(normalized) ? normalized : null
}

function vectorBucketNeighbors(vector: number[], index: number): number[] {
  const value = vector[index]
  if (typeof value !== 'number' || !Number.isFinite(value)) return []
  const center = Math.round(value * BUCKET_SCALE)
  return Array.from({ length: BUCKET_RADIUS * 2 + 1 }, (_, offset) => center - BUCKET_RADIUS + offset)
}

function createDbAdapter(market: Market) {
  return market === 'US'
    ? {
        all: <T>(sql: string, args: DbArgs = []) => execUsAnalyticsAll<T>(sql, args),
        get: <T>(sql: string, args: DbArgs = []) => execUsAnalyticsGet<T>(sql, args),
      }
    : {
        all: <T>(sql: string, args: DbArgs = []) => execAll<T>(sql, args),
        get: <T>(sql: string, args: DbArgs = []) => execGet<T>(sql, args),
      }
}

async function loadEvolution(
  db: ReturnType<typeof createDbAdapter>,
  ticker: string,
  caseDate: string,
  horizon: number,
) {
  const rows = await db.all<EvolutionRow>(
    `
    SELECT date, stage_code, feature_json
    FROM ml_feature_vectors_v2 INDEXED BY ml_feature_vectors_v2_feature_ticker_date_idx
    WHERE feature_set = ?
      AND ticker = ?
      AND date >= ?
    ORDER BY date
    LIMIT ?
    `,
    [ML_PHYSICS_FEATURE_SET, ticker, caseDate, Math.max(61, horizon + 1)],
  )
  const points = rows.slice(0, horizon + 1).map((row, index) => {
    const profile = parseJson<Record<string, any>>(row.feature_json, {})
    const close = typeof profile.close === 'number' && Number.isFinite(profile.close) ? profile.close : null
    return {
      afterDays: index,
      date: row.date,
      close,
      stageCode: typeof profile.stageCode === 'string' ? profile.stageCode : row.stage_code,
    }
  })
  const baseClose = points.find((point) => point.close != null)?.close ?? null
  const path = points
    .filter((point) => point.close != null && baseClose != null && baseClose !== 0)
    .map((point) => ({
      afterDays: point.afterDays,
      date: point.date,
      value: Number(((point.close! / baseClose!) * 100).toFixed(3)),
      stageCode: point.stageCode,
    }))
  const stagePath = points
    .map((point) => point.stageCode)
    .filter((code): code is string => typeof code === 'string' && code.length > 0)
    .filter((code, index, codes) => index === 0 || codes[index - 1] !== code)
  return { path, stagePath }
}

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams
    const market = normalizeMarket(params.get('market'))
    const ticker = normalizeTicker(params.get('ticker'), market)
    if (!ticker) {
      return NextResponse.json({ error: '有効な銘柄コードを指定してください。' }, { status: 400 })
    }

    const requestedHorizon = Number(params.get('horizon') ?? 20)
    const horizon = isHistoricalAnalogHorizon(requestedHorizon) ? requestedHorizon : 20
    const sort = normalizeHistoricalAnalogSort(params.get('sort'))
    const limit = Math.min(20, Math.max(3, Number(params.get('limit') ?? 10)))
    const minScore = Math.min(0.95, Math.max(0.5, Number(params.get('minScore') ?? 0.7)))
    const requestedDate = /^\d{4}-\d{2}-\d{2}$/.test(params.get('date') ?? '') ? params.get('date') : null
    const db = createDbAdapter(market)

    const indexes = await db.all<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='index' AND name IN (?, ?)`,
      [STAGE_INDEX_NAME, ANALOG_BUCKET_INDEX_NAME],
    )
    const installedIndexes = new Set(indexes.map((row) => row.name))
    if (!installedIndexes.has(STAGE_INDEX_NAME) || !installedIndexes.has(ANALOG_BUCKET_INDEX_NAME)) {
      return NextResponse.json({
        error: '全履歴検索インデックスが未作成です。',
        code: 'HISTORICAL_ANALOG_INDEX_REQUIRED',
      }, { status: 503 })
    }

    const base = await db.get<BaseRow>(
      `
      SELECT f.ticker, f.date, f.stage_code, f.feature_json, f.vector_json,
             u.name, u.market_segment, u.sector17_name, u.sector33_name
      FROM ml_feature_vectors_v2 f
      LEFT JOIN ticker_universe u ON u.ticker = f.ticker
      WHERE f.feature_set = ?
        AND f.ticker = ?
        ${requestedDate ? 'AND f.date <= ?' : ''}
      ORDER BY f.date DESC
      LIMIT 1
      `,
      requestedDate ? [ML_PHYSICS_FEATURE_SET, ticker, requestedDate] : [ML_PHYSICS_FEATURE_SET, ticker],
    )
    if (!base) {
      return NextResponse.json({ error: `${ticker} の物理ML特徴量がありません。` }, { status: 404 })
    }
    const availableCoverage = await db.get<CoverageRow>(
      `
      SELECT
        (
          SELECT date
          FROM ml_feature_vectors_v2 INDEXED BY ml_feature_vectors_v2_date_idx
          WHERE feature_set = ? AND date < ?
          ORDER BY date ASC
          LIMIT 1
        ) AS coverage_from,
        (
          SELECT date
          FROM ml_feature_vectors_v2 INDEXED BY ml_feature_vectors_v2_date_idx
          WHERE feature_set = ? AND date < ?
          ORDER BY date DESC
          LIMIT 1
        ) AS coverage_to
      `,
      [ML_PHYSICS_FEATURE_SET, base.date, ML_PHYSICS_FEATURE_SET, base.date],
    )

    const stageCodes = stageNeighborCodes(base.stage_code, 1)
    if (stageCodes.length === 0) {
      return NextResponse.json({ error: `${ticker} の6ステージが未判定です。` }, { status: 422 })
    }
    const placeholders = stageCodes.map(() => '?').join(', ')
    const selfCutoff = subtractCalendarDays(base.date, 90)
    const baseProfile = parseJson<Record<string, any>>(base.feature_json, {})
    const baseVector = parseJson<number[]>(base.vector_json, [])
    const bucketGroups = BUCKET_VECTOR_INDICES.map((index) => vectorBucketNeighbors(baseVector, index))
    if (bucketGroups.some((group) => group.length === 0)) {
      return NextResponse.json({ error: `${ticker} の近傍検索用特徴量が不足しています。` }, { status: 422 })
    }
    const labelCoverage = await db.get<LabelCoverageRow>(
      `
      SELECT MAX(date) AS latest_date
      FROM ml_short_labels
      WHERE horizon_days = ?
      `,
      [horizon],
    )
    if (!labelCoverage?.latest_date) {
      return NextResponse.json({
        error: `${horizon}営業日後の結果ラベルがありません。`,
        code: 'HISTORICAL_ANALOG_LABELS_REQUIRED',
      }, { status: 503 })
    }
    const cacheKey = stableCacheKey({
      market,
      ticker,
      asOfDate: base.date,
      labelDate: labelCoverage.latest_date,
      horizon,
      sort,
      limit,
      minScore,
      featureSet: ML_PHYSICS_FEATURE_SET,
      poolLimit: DEFAULT_POOL_LIMIT,
    })
    const memoryCached = responseCache.get(cacheKey)
    if (memoryCached && Date.now() - memoryCached.generatedAt < CACHE_TTL_MS) {
      return NextResponse.json({
        ...memoryCached.payload,
        cache: { hit: true, generatedAt: new Date(memoryCached.generatedAt).toISOString() },
      })
    }
    const stored = await readServingCache<Record<string, unknown>>(CACHE_NAMESPACE, cacheKey, CACHE_TTL_MS)
    if (stored) {
      responseCache.set(cacheKey, stored)
      return NextResponse.json({
        ...stored.payload,
        cache: { hit: true, generatedAt: new Date(stored.generatedAt).toISOString() },
      })
    }
    const bucketPlaceholders = bucketGroups.slice(0, 2).map((group) => group.map(() => '?').join(', '))
    const candidateRows = await db.all<CandidateRow>(
      `
      WITH candidate_ids AS (
        SELECT
          f.rowid AS feature_rowid,
          l.return_pct,
          l.max_return_pct,
          l.min_return_pct
        FROM ml_feature_vectors_v2 AS f INDEXED BY ${ANALOG_BUCKET_INDEX_NAME}
        INNER JOIN ml_short_labels l
          ON l.ticker = f.ticker
         AND l.date = f.date
         AND l.horizon_days = ?
        WHERE f.feature_set = ?
          AND f.stage_code IN (${placeholders})
          AND CAST(ROUND(json_extract(f.vector_json, '$[11]') * ${BUCKET_SCALE}) AS INTEGER) IN (${bucketPlaceholders[0]})
          AND CAST(ROUND(json_extract(f.vector_json, '$[15]') * ${BUCKET_SCALE}) AS INTEGER) IN (${bucketPlaceholders[1]})
          AND CAST(ROUND(json_extract(f.vector_json, '$[25]') * ${BUCKET_SCALE}) AS INTEGER) BETWEEN ? AND ?
          AND CAST(ROUND(json_extract(f.vector_json, '$[26]') * ${BUCKET_SCALE}) AS INTEGER) BETWEEN ? AND ?
          AND f.date < ?
          AND f.date <= ?
          AND NOT (f.ticker = ? AND f.date >= ?)
          AND l.return_pct IS NOT NULL
        LIMIT ?
      )
      SELECT f.ticker, f.date, f.stage_code, f.feature_json, f.vector_json,
             u.name, u.market_segment, u.sector17_name, u.sector33_name,
             s.return_pct, s.max_return_pct, s.min_return_pct
      FROM candidate_ids s
      INNER JOIN ml_feature_vectors_v2 f ON f.rowid = s.feature_rowid
      LEFT JOIN ticker_universe u ON u.ticker = f.ticker
      `,
      [
        horizon,
        ML_PHYSICS_FEATURE_SET,
        ...stageCodes,
        ...bucketGroups[0],
        ...bucketGroups[1],
        bucketGroups[2][0],
        bucketGroups[2].at(-1)!,
        bucketGroups[3][0],
        bucketGroups[3].at(-1)!,
        base.date,
        labelCoverage.latest_date,
        ticker,
        selfCutoff,
        DEFAULT_POOL_LIMIT,
      ],
    )

    const scored = candidateRows
      .map((row) => scoreHistoricalAnalog(
        { stageCode: base.stage_code, profile: baseProfile, vector: baseVector },
        {
          ticker: row.ticker,
          date: row.date,
          stageCode: row.stage_code,
          featureJson: row.feature_json,
          vectorJson: row.vector_json,
          name: row.name,
          marketSegment: row.market_segment,
          sector17Name: row.sector17_name,
          sector33Name: row.sector33_name,
          returnPct: row.return_pct,
          maxReturnPct: row.max_return_pct,
          minReturnPct: row.min_return_pct,
        } satisfies HistoricalAnalogCandidate,
      ))
      .filter((row): row is NonNullable<typeof row> => row != null && row.similarityScore >= minScore)
    const selected = diversifyHistoricalAnalogs(sortHistoricalAnalogs(scored, sort), limit)
    const analogs = await Promise.all(selected.map(async (row, index) => {
      const evolution = await loadEvolution(db, row.ticker, row.date, horizon)
      return {
        rank: index + 1,
        ticker: row.ticker,
        name: row.name,
        marketSegment: row.marketSegment,
        sector17Name: row.sector17Name,
        sector33Name: row.sector33Name,
        caseDate: row.date,
        stageCode: row.stageCode,
        similarityScore: row.similarityScore,
        structuralScore: row.structuralScore,
        vectorScore: row.vectorScore,
        outcome: {
          horizonDays: horizon,
          returnPct: row.returnPct,
          maxReturnPct: row.maxReturnPct,
          minReturnPct: row.minReturnPct,
        },
        components: topHistoricalAnalogComponents(row.components),
        reason: row.reason,
        ...evolution,
      }
    }))

    const dates = candidateRows.map((row) => row.date).sort()
    const generatedAt = Date.now()
    const payload = {
      market,
      ticker,
      asOfDate: base.date,
      featureSet: ML_PHYSICS_FEATURE_SET,
      base: {
        ticker: base.ticker,
        name: base.name,
        date: base.date,
        stageCode: base.stage_code,
        marketSegment: base.market_segment,
        sector17Name: base.sector17_name,
        sector33Name: base.sector33_name,
      },
      horizon,
      sort,
      minScore,
      summary: summarizeOutcomes(scored),
      analogs,
      search: {
        method: 'quantized-ma-neighborhood + weighted-physics + standardized-vector',
        stageDistance: 1,
        stageNeighborCount: stageCodes.length,
        candidateCount: candidateRows.length,
        scoredCount: scored.length,
        coverageFrom: availableCoverage?.coverage_from ?? null,
        coverageTo: availableCoverage?.coverage_to ?? null,
        matchedFrom: dates[0] ?? null,
        matchedTo: dates.at(-1) ?? null,
        poolLimit: DEFAULT_POOL_LIMIT,
        truncated: candidateRows.length >= DEFAULT_POOL_LIMIT,
      },
      cache: { hit: false, generatedAt: new Date(generatedAt).toISOString() },
    }
    responseCache.set(cacheKey, { generatedAt, payload })
    if (responseCache.size > CACHE_MAX_ENTRIES) {
      const oldestKey = responseCache.keys().next().value
      if (oldestKey) responseCache.delete(oldestKey)
    }
    writeServingCache(CACHE_NAMESPACE, cacheKey, payload, CACHE_TTL_MS, generatedAt).catch((error) => {
      console.warn('historical analog cache write failed:', error)
    })
    return NextResponse.json(payload)
  } catch (error) {
    console.error('historical analog search failed:', error)
    return NextResponse.json({
      error: '過去局面検索に失敗しました。',
      message: error instanceof Error ? error.message : String(error),
    }, { status: 500 })
  }
}
