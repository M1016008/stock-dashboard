import { NextResponse } from 'next/server'
import { execAll, execGet } from '@/lib/db/client'
import { execUsAnalyticsGet, hasUsAnalyticsDb } from '@/lib/db/us-analytics'
import { expectedLatestTradingDate } from '@/lib/server/data-freshness'
import { expectedLatestUsTradingDate } from '@/lib/server/us-data-freshness'

export const dynamic = 'force-dynamic'
export const revalidate = 0

type DateRow = { date: string | null }
type EpochRow = { value: number | null }
type RunningJobRow = {
  jobType: string
  startedAt: number
}

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

function sourceState(value: number | null, maxAgeHours: number) {
  const ageHours = value ? Math.max(0, (Date.now() / 1000 - value) / 3600) : null
  return {
    updatedAt: value ? new Date(value * 1000).toISOString() : null,
    ageHours: ageHours == null ? null : Math.round(ageHours * 10) / 10,
    fresh: ageHours != null && ageHours <= maxAgeHours,
  }
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
      jpDashboardCache,
      jpPredictions,
      jpSimilars,
      usDates,
      themeEpoch,
      materialEpoch,
      earningsEpoch,
      runningJobs,
    ] = await Promise.all([
      latestDate(jpQuery, 'ohlcv_daily', 'date'),
      latestDate(
        jpQuery,
        'physical_momentum_metrics',
        'date',
        `WHERE market = 'JP'
          AND physical_momentum_score IS NOT NULL
          AND physical_force_score IS NOT NULL
          AND physical_energy_score IS NOT NULL`,
      ),
      latestDate(jpQuery, 'ml_feature_vectors_v2', 'date'),
      latestDate(jpQuery, 'serving_ml_candidates', 'as_of_date'),
      latestDate(jpQuery, 'serving_ml_physics_candidates', 'as_of_date'),
      latestDate(jpQuery, 'dashboard_cache', 'date'),
      latestDate(jpQuery, 'ml_predictions', 'as_of_date'),
      latestDate(jpQuery, 'serving_current_similars', 'as_of_date'),
      hasUsAnalyticsDb()
        ? Promise.all([
            latestDate(usQuery, 'ohlcv_daily', 'date'),
            latestDate(
              usQuery,
              'physical_momentum_metrics',
              'date',
              `WHERE market = 'US'
                AND physical_momentum_score IS NOT NULL
                AND physical_force_score IS NOT NULL
                AND physical_energy_score IS NOT NULL`,
            ),
            latestDate(usQuery, 'ml_feature_vectors_v2', 'date'),
            latestDate(usQuery, 'serving_ml_candidates', 'as_of_date'),
            latestDate(usQuery, 'serving_ml_physics_candidates', 'as_of_date'),
            latestDate(usQuery, 'dashboard_cache', 'date'),
            latestDate(usQuery, 'ml_predictions', 'as_of_date'),
            latestDate(usQuery, 'serving_current_similars', 'as_of_date'),
          ])
        : Promise.resolve([null, null, null, null, null, null, null, null]),
      execGet<EpochRow>(
        "SELECT MAX(finished_at) AS value FROM kabutan_theme_runs WHERE status = 'success'",
      ),
      execGet<EpochRow>(
        "SELECT MAX(finished_at) AS value FROM kabutan_material_news_runs WHERE status = 'success'",
      ),
      execGet<EpochRow>(
        "SELECT MAX(finished_at) AS value FROM batch_runs WHERE job_type = 'earnings_refresh' AND status = 'success'",
      ),
      execAll<RunningJobRow>(
        `
          SELECT job_type AS jobType, started_at AS startedAt
          FROM batch_runs
          WHERE status = 'running'
            AND started_at >= unixepoch('now', '-24 hours')
          ORDER BY started_at DESC
          LIMIT 6
        `,
      ),
    ])

    const expectedJp = expectedLatestTradingDate()
    const expectedUs = expectedLatestUsTradingDate()
    const [
      usPrice,
      usPms,
      usFeatures,
      usCandidates,
      usPhysicsCandidates,
      usDashboardCache,
      usPredictions,
      usSimilars,
    ] = usDates
    const jpFresh = Boolean(
      jpPrice
      && jpPrice >= expectedJp
      && jpPms === jpPrice
      && jpFeatures === jpPrice
      && jpCandidates === jpPrice
      && jpPhysicsCandidates === jpPrice
      && jpDashboardCache === jpPrice
      && jpPredictions === jpPrice
      && jpSimilars === jpPrice,
    )
    const usFresh = Boolean(
      usPrice
      && usPrice >= expectedUs
      && usPms === usPrice
      && usFeatures === usPrice
      && usCandidates === usPrice
      && usPhysicsCandidates === usPrice
      && usDashboardCache === usPrice
      && usPredictions === usPrice
      && usSimilars === usPrice,
    )
    const sources = {
      themes: sourceState(themeEpoch?.value ?? null, 36),
      materials: sourceState(materialEpoch?.value ?? null, 3),
      earnings: sourceState(earningsEpoch?.value ?? null, 36),
    }
    const sourcesFresh = Object.values(sources).every((source) => source.fresh)

    return NextResponse.json({
      status: jpFresh && usFresh && sourcesFresh ? 'ok' : 'attention',
      checkedAt: new Date().toISOString(),
      jp: {
        expected: expectedJp,
        price: jpPrice,
        pms: jpPms,
        features: jpFeatures,
        candidates: jpCandidates,
        physicsCandidates: jpPhysicsCandidates,
        dashboardCache: jpDashboardCache,
        predictions: jpPredictions,
        similars: jpSimilars,
        fresh: jpFresh,
      },
      us: {
        expected: expectedUs,
        price: usPrice,
        pms: usPms,
        features: usFeatures,
        candidates: usCandidates,
        physicsCandidates: usPhysicsCandidates,
        dashboardCache: usDashboardCache,
        predictions: usPredictions,
        similars: usSimilars,
        fresh: usFresh,
      },
      sources,
      runningJobs: runningJobs.map((job) => ({
        jobType: job.jobType,
        startedAt: new Date(job.startedAt * 1000).toISOString(),
      })),
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
