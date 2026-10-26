import { NextRequest, NextResponse } from 'next/server'
import { ML_PHYSICS_FEATURE_SET, type PhysicsFeatureProfile } from '@/lib/backtest/ml-physics'
import {
  execUsAnalyticsAll,
  execUsAnalyticsGet,
  hasUsAnalyticsDb,
} from '@/lib/db/us-analytics'
import { analyzePhysicsProfile } from '@/lib/ml/physics-analysis'
import { MIN_DISPLAY_SIMILARITY_SCORE } from '@/lib/ml/similarity-threshold'
import { isIsoDate } from '@/lib/mtf-close-calendar'
import { getUsSecondaryName } from '@/lib/us-symbol-aliases'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const maxDuration = 30

type SimilarRow = {
  rank: number
  similarTicker: string
  similarityScore: number
  similarDirection: 'up' | 'down' | null
  payloadJson: string
  reasonJson: string
  name: string | null
  sector17Name: string | null
  sector33Name: string | null
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  try {
    return value ? JSON.parse(value) as T : fallback
  } catch {
    return fallback
  }
}

function emptyResponse(
  availability: 'ready' | 'unavailable' = 'ready',
  availabilityReason: string | null = null,
) {
  return {
    asOfDate: null,
    featureAsOfDate: null,
    source: 'us_analytics.serving_current_similars',
    physicsAnalysis: null,
    similars: [],
    caseStudies: [],
    availability,
    availabilityReason,
  }
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams
  for (const name of ['ticker', 'date', 'limit']) {
    if (params.getAll(name).length > 1) {
      return NextResponse.json({ ...emptyResponse(), error: `duplicate_${name}` }, { status: 400 })
    }
  }
  const ticker = params.get('ticker')?.trim().toUpperCase() ?? ''
  const requestedDate = params.get('date')?.trim() ?? ''
  const rawLimit = params.get('limit')
  const parsedLimit = rawLimit == null ? 6 : Number(rawLimit)

  if (!/^[A-Z0-9.^=-]{1,24}$/.test(ticker)) {
    return NextResponse.json({ ...emptyResponse(), error: '有効なUS銘柄を指定してください。' }, { status: 400 })
  }
  if (requestedDate && !isIsoDate(requestedDate)) {
    return NextResponse.json({ ...emptyResponse(), error: '日付はYYYY-MM-DD形式で指定してください。' }, { status: 400 })
  }
  if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 12) {
    return NextResponse.json({ ...emptyResponse(), error: 'limitは1〜12の整数で指定してください。' }, { status: 400 })
  }
  const limit = parsedLimit
  if (!hasUsAnalyticsDb()) {
    return NextResponse.json(emptyResponse('unavailable', 'us_analytics_not_configured'), { status: 503 })
  }

  try {
    const asOfDate = (await execUsAnalyticsGet<{ date: string | null }>(
      `
        SELECT MAX(as_of_date) AS date
        FROM serving_current_similars
        WHERE base_ticker = ?
          ${requestedDate ? 'AND as_of_date <= ?' : ''}
      `,
      requestedDate ? [ticker, requestedDate] : [ticker],
    ))?.date ?? null

    const featureAsOfDate = (await execUsAnalyticsGet<{ date: string | null }>(
      `
        SELECT MAX(date) AS date
        FROM ml_feature_vectors_v2
        WHERE feature_set = ?
          AND ticker = ?
          ${requestedDate ? 'AND date <= ?' : ''}
      `,
      requestedDate
        ? [ML_PHYSICS_FEATURE_SET, ticker, requestedDate]
        : [ML_PHYSICS_FEATURE_SET, ticker],
    ))?.date ?? null

    const [featureRow, rows] = await Promise.all([
      featureAsOfDate
        ? execUsAnalyticsGet<{ featureJson: string }>(
          `
            SELECT feature_json AS featureJson
            FROM ml_feature_vectors_v2
            WHERE feature_set = ? AND ticker = ? AND date = ?
            LIMIT 1
          `,
          [ML_PHYSICS_FEATURE_SET, ticker, featureAsOfDate],
        )
        : Promise.resolve(undefined),
      asOfDate
        ? execUsAnalyticsAll<SimilarRow>(
          `
            SELECT
              s.rank,
              s.similar_ticker AS similarTicker,
              s.similarity_score AS similarityScore,
              s.similar_direction AS similarDirection,
              s.payload_json AS payloadJson,
              s.reason_json AS reasonJson,
              u.name,
              u.sector17_name AS sector17Name,
              u.sector33_name AS sector33Name
            FROM serving_current_similars s
            LEFT JOIN ticker_universe u ON u.ticker = s.similar_ticker
            WHERE s.as_of_date = ?
              AND s.base_ticker = ?
              AND s.similarity_score >= ?
            ORDER BY s.rank
            LIMIT ?
          `,
          [asOfDate, ticker, MIN_DISPLAY_SIMILARITY_SCORE, limit],
        )
        : Promise.resolve([]),
    ])

    const profile = parseJson<PhysicsFeatureProfile | null>(featureRow?.featureJson, null)
    const similars = rows.map((row) => {
      const payload = parseJson<Record<string, unknown>>(row.payloadJson, {})
      const payloadSimilar = payload.similar && typeof payload.similar === 'object'
        ? payload.similar as Record<string, unknown>
        : {}
      const name = getUsSecondaryName(
        row.similarTicker,
        typeof payloadSimilar.name === 'string' ? payloadSimilar.name : row.name,
      )
      return {
        rank: Number(row.rank),
        similarTicker: row.similarTicker,
        similarityScore: Number(row.similarityScore),
        similarDirection: row.similarDirection,
        payload: {
          ...payload,
          similar: {
            ...payloadSimilar,
            name,
            sector17Name: typeof payloadSimilar.sector17Name === 'string'
              ? payloadSimilar.sector17Name
              : row.sector17Name,
            sector33Name: typeof payloadSimilar.sector33Name === 'string'
              ? payloadSimilar.sector33Name
              : row.sector33Name,
          },
        },
        reason: parseJson<Record<string, string>>(row.reasonJson, {}),
      }
    })

    return NextResponse.json({
      asOfDate,
      featureAsOfDate,
      source: 'us_analytics.serving_current_similars',
      physicsAnalysis: analyzePhysicsProfile(profile),
      similars,
      caseStudies: [],
      availability: 'ready',
      availabilityReason: null,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/SQLITE_BUSY|database is locked|no such table/i.test(message)) {
      return NextResponse.json(
        emptyResponse('unavailable', /no such table/i.test(message) ? 'schema_unavailable' : 'database_busy'),
        { status: 503 },
      )
    }
    console.error('[api/us/ml-current-similars]', error)
    return NextResponse.json({ ...emptyResponse(), error: 'US類似候補の取得に失敗しました。' }, { status: 500 })
  }
}
