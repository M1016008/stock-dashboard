import { NextResponse } from 'next/server'
import { execAll, execGet } from '@/lib/db/client'
import { execUsAnalyticsAll, execUsAnalyticsGet, hasUsAnalyticsDb } from '@/lib/db/us-analytics'
import { expectedLatestTradingDate } from '@/lib/server/data-freshness'
import { expectedLatestUsTradingDate } from '@/lib/server/us-data-freshness'
import { US_ADJUSTED_PRICE_BASIS } from '@/lib/us-adjusted-ohlcv'

export const dynamic = 'force-dynamic'
export const revalidate = 0

type DateRow = { date: string | null }
type EpochRow = { value: number | null }
type RunningJobRow = {
  jobType: string
  startedAt: number
  totalTickers: number | null
  succeeded: number | null
  failed: number | null
  rowsInserted: number | null
}
type CountRow = { count: number | null }
type UsRunRow = {
  status: string
  totalTickers: number
  succeeded: number
  failed: number
  rowsInserted: number
  startedAt: number
  finishedAt: number | null
}
type UsSourceCoverageRow = {
  date: string | null
  universe: number | null
  covered: number | null
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

function runningJobState(job: RunningJobRow, market: 'JP' | 'US') {
  const totalTickers = Number(job.totalTickers ?? 0)
  const succeeded = Number(job.succeeded ?? 0)
  const elapsedMinutes = Math.max(0, (Date.now() / 1000 - job.startedAt) / 60)
  const progressPct = totalTickers > 0
    ? Math.min(100, Math.round((succeeded / totalTickers) * 1_000) / 10)
    : null
  const etaMinutes = succeeded > 0 && totalTickers > succeeded
    ? Math.round((elapsedMinutes / succeeded) * (totalTickers - succeeded))
    : null
  return {
    market,
    jobType: job.jobType,
    startedAt: new Date(job.startedAt * 1000).toISOString(),
    totalTickers,
    succeeded,
    failed: Number(job.failed ?? 0),
    rowsInserted: Number(job.rowsInserted ?? 0),
    progressPct,
    elapsedMinutes: Math.round(elapsedMinutes),
    etaMinutes,
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
      usRunningJobs,
      usIngestionRun,
      usSourceCoverage,
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
            execUsAnalyticsGet<CountRow>('SELECT COUNT(*) AS count FROM ticker_universe WHERE active = 1'),
            execUsAnalyticsGet<CountRow>(
              'SELECT COUNT(DISTINCT ticker) AS count FROM ohlcv_daily WHERE date = (SELECT MAX(date) FROM ohlcv_daily)',
            ),
            execUsAnalyticsGet<CountRow>(
              `SELECT COUNT(DISTINCT symbol) AS count
               FROM physical_momentum_metrics
               WHERE market = 'US'
                 AND date = (SELECT MAX(date) FROM physical_momentum_metrics WHERE market = 'US')
                 AND physical_momentum_score IS NOT NULL`,
            ),
            execUsAnalyticsGet<CountRow>(
              'SELECT COUNT(DISTINCT ticker) AS count FROM ml_feature_vectors_v2 WHERE date = (SELECT MAX(date) FROM ml_feature_vectors_v2)',
            ),
            execUsAnalyticsGet<{ value: string }>(
              `SELECT value
               FROM us_analytics_metadata
               WHERE key = 'ohlcv_price_basis'`,
            ).catch(() => null),
            execUsAnalyticsGet<{ value: string }>(
              `SELECT value
               FROM us_analytics_metadata
               WHERE key = 'derived_price_basis'`,
            ).catch(() => null),
            execUsAnalyticsGet<{ value: string }>(
              `SELECT value
               FROM us_analytics_metadata
               WHERE key = 'analog_index_price_basis'`,
            ).catch(() => null),
          ])
        : Promise.resolve([null, null, null, null, null, null, null, null, null, null, null, null, null, null, null]),
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
          SELECT
            job_type AS jobType,
            started_at AS startedAt,
            total_tickers AS totalTickers,
            succeeded,
            failed,
            rows_inserted AS rowsInserted
          FROM batch_runs
          WHERE status = 'running'
            AND started_at >= unixepoch('now', '-24 hours')
          ORDER BY started_at DESC
          LIMIT 6
        `,
      ),
      hasUsAnalyticsDb()
        ? execUsAnalyticsAll<RunningJobRow>(
            `
              SELECT
                job_type AS jobType,
                started_at AS startedAt,
                total_tickers AS totalTickers,
                succeeded,
                failed,
                rows_inserted AS rowsInserted
              FROM batch_runs
              WHERE status = 'running'
                AND started_at >= unixepoch('now', '-48 hours')
              ORDER BY started_at DESC
              LIMIT 6
            `,
          ).catch(() => [])
        : Promise.resolve([]),
      execGet<UsRunRow>(
        `
          SELECT
            status,
            total_tickers AS totalTickers,
            succeeded,
            failed,
            rows_inserted AS rowsInserted,
            started_at AS startedAt,
            finished_at AS finishedAt
          FROM market_data_runs
          WHERE market = 'US' AND job_type = 'tiingo_ohlcv'
          ORDER BY started_at DESC
          LIMIT 1
        `,
      ).catch(() => undefined),
      execGet<UsSourceCoverageRow>(
        `
          WITH latest AS (
            SELECT date
            FROM market_ohlcv_daily INDEXED BY market_ohlcv_market_date_idx
            WHERE market = 'US'
            ORDER BY date DESC
            LIMIT 1
          )
          SELECT
            latest.date,
            (
              SELECT COUNT(*)
              FROM market_universe
              WHERE market = 'US' AND active = 1
            ) AS universe,
            (
              SELECT COUNT(DISTINCT ticker)
              FROM market_ohlcv_daily INDEXED BY market_ohlcv_market_date_ticker_idx
              WHERE market = 'US' AND date = latest.date
            ) AS covered
          FROM latest
        `,
      ).catch(() => undefined),
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
      usUniverseCount,
      usPriceCount,
      usPmsCount,
      usFeatureCount,
      usPriceBasisRow,
      usDerivedPriceBasisRow,
      usAnalogPriceBasisRow,
    ] = usDates
    const usPriceBasis = (usPriceBasisRow as { value?: string } | null)?.value ?? null
    const usDerivedPriceBasis = (usDerivedPriceBasisRow as { value?: string } | null)?.value ?? null
    const usAnalogPriceBasis = (usAnalogPriceBasisRow as { value?: string } | null)?.value ?? null
    const usAnalyticsUniverse = Number((usUniverseCount as CountRow | null)?.count ?? 0)
    const usUniverse = Number(usSourceCoverage?.universe ?? usAnalyticsUniverse)
    const sourcePriceCount = Number(usSourceCoverage?.covered ?? 0)
    const analyticsPriceCount = Number((usPriceCount as CountRow | null)?.count ?? 0)
    const ratio = (count: number) => usUniverse > 0
      ? Math.round((count / usUniverse) * 10_000) / 100
      : null
    const countFrom = (value: unknown) => Number((value as CountRow | null)?.count ?? 0)
    const usCoverage = {
      universe: usUniverse,
      price: sourcePriceCount,
      pricePct: ratio(sourcePriceCount),
      analyticsUniverse: usAnalyticsUniverse,
      analyticsPrice: analyticsPriceCount,
      analyticsPricePct: ratio(analyticsPriceCount),
      pms: countFrom(usPmsCount),
      pmsPct: ratio(countFrom(usPmsCount)),
      features: countFrom(usFeatureCount),
      featuresPct: ratio(countFrom(usFeatureCount)),
      partial: usUniverse > 0 && sourcePriceCount / usUniverse < 0.95,
      analyticsPartial: usUniverse > 0 && analyticsPriceCount / usUniverse < 0.95,
    }
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
      usSourceCoverage?.date
      && usSourceCoverage.date >= expectedUs
      && usPrice === usSourceCoverage.date
      && usPms === usSourceCoverage.date
      && usFeatures === usSourceCoverage.date
      && usCandidates === usSourceCoverage.date
      && usPhysicsCandidates === usSourceCoverage.date
      && usDashboardCache === usSourceCoverage.date
      && usPredictions === usSourceCoverage.date
      && usSimilars === usSourceCoverage.date
      && !usCoverage.partial
      && !usCoverage.analyticsPartial
      && usPriceBasis === US_ADJUSTED_PRICE_BASIS
      && usDerivedPriceBasis === US_ADJUSTED_PRICE_BASIS
      && usAnalogPriceBasis === US_ADJUSTED_PRICE_BASIS
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
        price: usSourceCoverage?.date ?? usPrice,
        analyticsPrice: usPrice,
        pms: usPms,
        features: usFeatures,
        candidates: usCandidates,
        physicsCandidates: usPhysicsCandidates,
        dashboardCache: usDashboardCache,
        predictions: usPredictions,
        similars: usSimilars,
        priceBasis: usPriceBasis,
        derivedPriceBasis: usDerivedPriceBasis,
        analogPriceBasis: usAnalogPriceBasis,
        expectedPriceBasis: US_ADJUSTED_PRICE_BASIS,
        coverage: usCoverage,
        ingestionRun: usIngestionRun ? {
          status: usIngestionRun.status,
          totalTickers: usIngestionRun.totalTickers,
          succeeded: usIngestionRun.succeeded,
          failed: usIngestionRun.failed,
          rowsInserted: usIngestionRun.rowsInserted,
          startedAt: new Date(usIngestionRun.startedAt * 1000).toISOString(),
          finishedAt: usIngestionRun.finishedAt
            ? new Date(usIngestionRun.finishedAt * 1000).toISOString()
            : null,
        } : null,
        fresh: usFresh,
      },
      sources,
      runningJobs: [
        ...runningJobs.map((job) => runningJobState(job, 'JP')),
        ...usRunningJobs.map((job) => runningJobState(job, 'US')),
      ]
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, 8),
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
