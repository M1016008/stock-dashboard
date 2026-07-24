import { NextResponse } from 'next/server'
import { execGet } from '@/lib/db/client'
import { execUsAnalyticsGet, hasUsAnalyticsDb } from '@/lib/db/us-analytics'

export const dynamic = 'force-dynamic'
export const revalidate = 0

type DateRow = { date: string | null }

async function latestDate(
  query: (sql: string, args?: readonly (string | number | null)[]) => Promise<DateRow | undefined>,
  table: string,
  column: 'date' | 'as_of_date',
  where = '',
): Promise<string | null> {
  const row = await query(
    `SELECT ${column} AS date FROM ${table} ${where} ORDER BY ${column} DESC LIMIT 1`,
  )
  return row?.date ?? null
}

export async function GET() {
  try {
    const jpQuery = (sql: string, args: readonly (string | number | null)[] = []) => execGet<DateRow>(sql, args)
    const usQuery = (sql: string, args: readonly (string | number | null)[] = []) => execUsAnalyticsGet<DateRow>(sql, args)
    const [
      jpPrice,
      jpPms,
      jpFeatures,
      jpCandidates,
      jpPhysicsCandidates,
      usDates,
    ] = await Promise.all([
      latestDate(jpQuery, 'ohlcv_daily', 'date'),
      latestDate(jpQuery, 'physical_momentum_metrics', 'date', "WHERE market = 'JP'"),
      latestDate(jpQuery, 'ml_feature_vectors_v2', 'date'),
      latestDate(jpQuery, 'serving_ml_candidates', 'as_of_date'),
      latestDate(jpQuery, 'serving_ml_physics_candidates', 'as_of_date'),
      hasUsAnalyticsDb()
        ? Promise.all([
            latestDate(usQuery, 'ohlcv_daily', 'date'),
            latestDate(usQuery, 'physical_momentum_metrics', 'date', "WHERE market = 'US'"),
            latestDate(usQuery, 'ml_feature_vectors_v2', 'date'),
            latestDate(usQuery, 'serving_ml_candidates', 'as_of_date'),
            latestDate(usQuery, 'serving_ml_physics_candidates', 'as_of_date'),
          ])
        : Promise.resolve([null, null, null, null, null]),
    ])

    const [usPrice, usPms, usFeatures, usCandidates, usPhysicsCandidates] = usDates
    const jpFresh = Boolean(
      jpPrice
      && jpPms === jpPrice
      && jpFeatures === jpPrice
      && jpCandidates === jpPrice
      && jpPhysicsCandidates === jpPrice,
    )
    const usFresh = Boolean(
      usPrice
      && usPms === usPrice
      && usFeatures === usPrice
      && usCandidates === usPrice
      && usPhysicsCandidates === usPrice,
    )

    return NextResponse.json({
      status: jpFresh && usFresh ? 'ok' : 'attention',
      checkedAt: new Date().toISOString(),
      jp: {
        price: jpPrice,
        pms: jpPms,
        features: jpFeatures,
        candidates: jpCandidates,
        physicsCandidates: jpPhysicsCandidates,
        fresh: jpFresh,
      },
      us: {
        price: usPrice,
        pms: usPms,
        features: usFeatures,
        candidates: usCandidates,
        physicsCandidates: usPhysicsCandidates,
        fresh: usFresh,
      },
    })
  } catch (error) {
    console.error('status overview failed:', error)
    return NextResponse.json({
      status: 'unavailable',
      checkedAt: new Date().toISOString(),
      message: 'データ鮮度を取得できませんでした。',
    }, { status: 503 })
  }
}
