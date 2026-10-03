import { NextResponse } from 'next/server'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { promisify } from 'node:util'
import { execAll, execGet } from '@/lib/db/client'
import {
  execUsAnalyticsAll,
  execUsAnalyticsGet,
  hasUsAnalyticsDb,
  resolveUsAnalyticsDbPath,
} from '@/lib/db/us-analytics'
import { expectedLatestTradingDate } from '@/lib/server/data-freshness'
import { runningJobIsVisible } from '@/lib/server/running-job-health'
import { expectedLatestUsTradingDate } from '@/lib/server/us-data-freshness'
import { supplementalSourcesAreFresh } from '@/lib/status-health'
import { US_ADJUSTED_PRICE_BASIS } from '@/lib/us-adjusted-ohlcv'
import { usInvestableSymbolSql } from '@/lib/us-symbol-quality'

export const dynamic = 'force-dynamic'
export const revalidate = 0

const execFileAsync = promisify(execFile)

type DateRow = { date: string | null }
type EpochRow = { value: number | null }
type RunningJobRow = {
  jobType: string
  startedAt: number
  totalTickers: number | null
  succeeded: number | null
  failed: number | null
  rowsInserted: number | null
  payloadJson?: string | null
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
  payloadJson: string | null
}
type UsSourceCoverageRow = {
  date: string | null
  universe: number | null
  covered: number | null
}
type HealthCoverageRow = {
  expectedDate: string | null
  actualDate: string | null
  eligible: number | null
  covered: number | null
  payloadJson: string | null
}
type FoundationProgress = {
  stage: 'analytics_copy' | 'features_models'
  totalTickers: number
  succeeded: number
  failed: number
  rowsInserted: number
  detailJobType: string | null
  progressBaseline: number
  rateStartedAt: number | null
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

async function activeProcessText(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'command='], {
      timeout: 3_000,
      maxBuffer: 2 * 1024 * 1024,
    })
    return stdout
  } catch {
    return null
  }
}

function runningJobState(job: RunningJobRow, market: 'JP' | 'US') {
  const totalTickers = Number(job.totalTickers ?? 0)
  const succeeded = Number(job.succeeded ?? 0)
  const elapsedMinutes = Math.max(0, (Date.now() / 1000 - job.startedAt) / 60)
  const progressPct = totalTickers > 0
    ? Math.min(100, Math.round((succeeded / totalTickers) * 1_000) / 10)
    : null
  let etaMinutes = succeeded > 0 && totalTickers > succeeded
    ? Math.round((elapsedMinutes / succeeded) * (totalTickers - succeeded))
    : null
  let stage: string | null = null
  let heartbeatAt: string | null = null
  if (job.payloadJson) {
    try {
      const payload = JSON.parse(job.payloadJson) as {
        stage?: unknown
        heartbeatAt?: unknown
        progressBaseline?: unknown
        rateStartedAt?: unknown
      }
      stage = typeof payload.stage === 'string' ? payload.stage : null
      heartbeatAt = typeof payload.heartbeatAt === 'string' ? payload.heartbeatAt : null
      const progressBaseline = Number(payload.progressBaseline ?? 0)
      const rateStartedAtMs = typeof payload.rateStartedAt === 'string'
        ? Date.parse(payload.rateStartedAt)
        : Number.NaN
      const rateElapsedMinutes = Number.isFinite(rateStartedAtMs)
        ? Math.max(0, (Date.now() - rateStartedAtMs) / 60_000)
        : elapsedMinutes
      const progressed = Math.max(0, succeeded - progressBaseline)
      etaMinutes = progressed > 0 && totalTickers > succeeded
        ? Math.round((rateElapsedMinutes / progressed) * (totalTickers - succeeded))
        : null
    } catch {
      // Older run rows may not have structured progress metadata.
    }
  }
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
    stage,
    heartbeatAt,
  }
}

async function loadUsFoundationProgress(
  foundationStartedAt: number | null,
): Promise<FoundationProgress | null> {
  const configuredPath = resolveUsAnalyticsDbPath()
  const activePath = fs.existsSync(configuredPath)
    ? fs.realpathSync(configuredPath)
    : configuredPath
  const shadowPath = `${activePath}.${US_ADJUSTED_PRICE_BASIS}.building`
  if (!fs.existsSync(shadowPath)) return null
  try {
    const basis = US_ADJUSTED_PRICE_BASIS.replace(/'/g, "''")
    const startedAt = foundationStartedAt == null
      ? 'NULL'
      : String(Math.max(0, Math.floor(foundationStartedAt)))
    const sql = `
      PRAGMA busy_timeout=3000;
      PRAGMA query_only=ON;
      SELECT json_object(
        'tableCount', (
          SELECT COUNT(*)
          FROM sqlite_master
          WHERE type = 'table'
            AND name IN ('ticker_universe', 'us_analytics_copy_state', 'batch_runs')
        ),
        'totalTickers', (SELECT COUNT(*) FROM ticker_universe),
        'succeeded', (
          SELECT COUNT(*)
          FROM us_analytics_copy_state
          WHERE status = 'done' AND price_basis = '${basis}'
        ),
        'activeJobType', COALESCE((
          SELECT job_type
          FROM batch_runs
          WHERE status = 'running'
          ORDER BY started_at DESC
          LIMIT 1
        ), ''),
        'activeTotalTickers', COALESCE((
          SELECT total_tickers
          FROM batch_runs
          WHERE status = 'running'
          ORDER BY started_at DESC
          LIMIT 1
        ), 0),
        'activeSucceeded', COALESCE((
          SELECT succeeded
          FROM batch_runs
          WHERE status = 'running'
          ORDER BY started_at DESC
          LIMIT 1
        ), 0),
        'activeFailed', COALESCE((
          SELECT failed
          FROM batch_runs
          WHERE status = 'running'
          ORDER BY started_at DESC
          LIMIT 1
        ), 0),
        'activeRowsInserted', COALESCE((
          SELECT rows_inserted
          FROM batch_runs
          WHERE status = 'running'
          ORDER BY started_at DESC
          LIMIT 1
        ), 0),
        'progressed', CASE
          WHEN ${startedAt} IS NULL THEN NULL
          ELSE (
            SELECT COUNT(*)
            FROM us_analytics_copy_state
            WHERE status = 'done'
              AND price_basis = '${basis}'
              AND updated_at >= ${startedAt}
          )
        END,
        'rateStartedAt', CASE
          WHEN ${startedAt} IS NULL THEN NULL
          ELSE (
            SELECT MIN(updated_at)
            FROM us_analytics_copy_state
            WHERE status = 'done'
              AND price_basis = '${basis}'
              AND updated_at >= ${startedAt}
          )
        END
      );
    `
    const { stdout } = await execFileAsync('sqlite3', ['-batch', shadowPath, sql], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      timeout: 5_000,
    })
    const jsonLine = stdout.trim().split(/\r?\n/).at(-1)
    if (!jsonLine) return null
    const snapshot = JSON.parse(jsonLine) as {
      tableCount?: number
      totalTickers?: number
      succeeded?: number
      activeJobType?: string
      activeTotalTickers?: number
      activeSucceeded?: number
      activeFailed?: number
      activeRowsInserted?: number
      progressed?: number | null
      rateStartedAt?: number | null
    }
    if (Number(snapshot.tableCount ?? 0) < 3) return null
    const activeJobType = String(snapshot.activeJobType ?? '')
    if (activeJobType) {
      return {
        stage: 'features_models',
        totalTickers: Number(snapshot.activeTotalTickers ?? 0),
        succeeded: Number(snapshot.activeSucceeded ?? 0),
        failed: Number(snapshot.activeFailed ?? 0),
        rowsInserted: Number(snapshot.activeRowsInserted ?? 0),
        detailJobType: activeJobType,
        progressBaseline: 0,
        rateStartedAt: null,
      }
    }
    const totalTickers = Number(snapshot.totalTickers ?? 0)
    const copiedTickers = Number(snapshot.succeeded ?? 0)
    const progressed = Number(snapshot.progressed ?? copiedTickers)
    return {
      stage: 'analytics_copy',
      totalTickers,
      succeeded: copiedTickers,
      failed: 0,
      rowsInserted: 0,
      detailJobType: null,
      progressBaseline: Math.max(0, copiedTickers - progressed),
      rateStartedAt: Number(snapshot.rateStartedAt ?? foundationStartedAt ?? 0) || null,
    }
  } catch {
    return null
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
      usEarningsEpoch,
      runningJobs,
      usSourceRunningJobs,
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
              `SELECT COUNT(DISTINCT o.ticker) AS count
               FROM ohlcv_daily o
               INNER JOIN ticker_universe u ON u.ticker = o.ticker AND u.active = 1
               WHERE o.date = (SELECT MAX(date) FROM ohlcv_daily)`,
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
            execUsAnalyticsGet<HealthCoverageRow>(
              `SELECT
                 expected_date AS expectedDate,
                 actual_date AS actualDate,
                 expected_count AS eligible,
                 actual_count AS covered,
                 payload_json AS payloadJson
               FROM ml_feature_health_checks
               WHERE check_key = 'us_physical_momentum_metrics'
               ORDER BY computed_at DESC
               LIMIT 1`,
            ).catch(() => null),
            execUsAnalyticsGet<HealthCoverageRow>(
              `SELECT
                 expected_date AS expectedDate,
                 actual_date AS actualDate,
                 expected_count AS eligible,
                 actual_count AS covered,
                 payload_json AS payloadJson
               FROM ml_feature_health_checks
               WHERE check_key = 'us_ml_feature_vectors_v2'
               ORDER BY computed_at DESC
               LIMIT 1`,
            ).catch(() => null),
          ])
        : Promise.resolve([null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null]),
      execGet<EpochRow>(
        "SELECT MAX(finished_at) AS value FROM kabutan_theme_runs WHERE status = 'success'",
      ),
      execGet<EpochRow>(
        "SELECT MAX(finished_at) AS value FROM kabutan_material_news_runs WHERE status = 'success'",
      ),
      execGet<EpochRow>(
        "SELECT MAX(finished_at) AS value FROM batch_runs WHERE job_type = 'earnings_refresh' AND status = 'success'",
      ),
      execGet<EpochRow>(
        "SELECT MAX(finished_at) AS value FROM market_data_runs WHERE market = 'US' AND job_type = 'finnhub_earnings' AND status = 'success'",
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
      execAll<RunningJobRow>(
        `
          SELECT
            job_type AS jobType,
            started_at AS startedAt,
            total_tickers AS totalTickers,
            succeeded,
            failed,
            rows_inserted AS rowsInserted,
            payload_json AS payloadJson
          FROM market_data_runs
          WHERE market = 'US'
            AND status = 'running'
            AND started_at >= unixepoch('now', '-48 hours')
          ORDER BY started_at DESC
          LIMIT 6
        `,
      ).catch(() => []),
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
            finished_at AS finishedAt,
            payload_json AS payloadJson
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
              WHERE market = 'US'
                AND active = 1
                AND ${usInvestableSymbolSql('ticker')}
            ) AS universe,
            (
              SELECT COUNT(*)
              FROM market_universe u INDEXED BY market_universe_market_active_idx
              INNER JOIN market_ohlcv_daily o INDEXED BY market_ohlcv_market_date_ticker_idx
                ON o.market = 'US'
               AND o.date = latest.date
               AND o.ticker = u.ticker
              WHERE u.market = 'US'
                AND u.active = 1
                AND ${usInvestableSymbolSql('u.ticker')}
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
      usPmsCoverageRow,
      usFeatureCoverageRow,
    ] = usDates
    const usPriceBasis = (usPriceBasisRow as { value?: string } | null)?.value ?? null
    const usDerivedPriceBasis = (usDerivedPriceBasisRow as { value?: string } | null)?.value ?? null
    const usAnalogPriceBasis = (usAnalogPriceBasisRow as { value?: string } | null)?.value ?? null
    const usAnalyticsUniverse = Number((usUniverseCount as CountRow | null)?.count ?? 0)
    const usUniverse = Number(usSourceCoverage?.universe ?? usAnalyticsUniverse)
    const sourcePriceCount = Number(usSourceCoverage?.covered ?? 0)
    const analyticsPriceCount = Number((usPriceCount as CountRow | null)?.count ?? 0)
    const ratio = (count: number, denominator: number) => denominator > 0
      ? Math.round((count / denominator) * 10_000) / 100
      : null
    const countFrom = (value: unknown) => Number((value as CountRow | null)?.count ?? 0)
    const validHealthCoverage = (value: unknown, targetDate: string | null) => {
      const row = value as HealthCoverageRow | null
      if (!row || !targetDate || row.expectedDate !== targetDate || row.actualDate !== targetDate) {
        return null
      }
      return {
        eligible: Number(row.eligible ?? 0),
        covered: Number(row.covered ?? 0),
      }
    }
    const pmsHealth = validHealthCoverage(usPmsCoverageRow, usPrice)
    const featureHealth = validHealthCoverage(usFeatureCoverageRow, usPrice)
    const pmsCount = pmsHealth?.covered ?? countFrom(usPmsCount)
    const pmsEligible = pmsHealth?.eligible ?? usUniverse
    const featureCount = featureHealth?.covered ?? countFrom(usFeatureCount)
    const featureEligible = featureHealth?.eligible ?? usUniverse
    let ingestionUnavailable = 0
    let ingestionDeferred = 0
    if (usIngestionRun?.payloadJson) {
      try {
        const payload = JSON.parse(usIngestionRun.payloadJson) as {
          unavailable?: unknown
          deferred?: unknown
        }
        ingestionUnavailable = Number(payload.unavailable ?? 0)
        ingestionDeferred = Number(payload.deferred ?? 0)
      } catch {
        // Keep counters at zero for legacy rows.
      }
    }
    const ingestionProcessed = usIngestionRun
      ? Number(usIngestionRun.succeeded ?? 0)
        + Number(usIngestionRun.failed ?? 0)
        + ingestionUnavailable
      : 0
    const ingestionComplete = Boolean(
      usIngestionRun
      && usIngestionRun.status === 'success'
      && Number(usIngestionRun.failed ?? 0) === 0
      && ingestionDeferred === 0
      && ingestionProcessed >= Number(usIngestionRun.totalTickers ?? 0),
    )
    const usCoverage = {
      universe: usUniverse,
      price: sourcePriceCount,
      pricePct: ratio(sourcePriceCount, usUniverse),
      priceProcessed: ingestionProcessed,
      priceProcessedPct: ratio(ingestionProcessed, Number(usIngestionRun?.totalTickers ?? usUniverse)),
      priceUnavailable: ingestionUnavailable,
      priceDeferred: ingestionDeferred,
      priceProcessingComplete: ingestionComplete,
      analyticsUniverse: usAnalyticsUniverse,
      analyticsPrice: analyticsPriceCount,
      analyticsEligible: sourcePriceCount,
      analyticsPricePct: ratio(analyticsPriceCount, sourcePriceCount),
      pms: pmsCount,
      pmsEligible,
      pmsPct: ratio(pmsCount, pmsEligible),
      features: featureCount,
      featuresEligible: featureEligible,
      featuresPct: ratio(featureCount, featureEligible),
      partial: usUniverse > 0 && sourcePriceCount / usUniverse < 0.95,
      analyticsPartial: sourcePriceCount > 0 && analyticsPriceCount / sourcePriceCount < 0.995,
      pmsComplete: pmsEligible > 0 && pmsCount >= pmsEligible,
      featuresComplete: featureEligible > 0 && featureCount >= featureEligible,
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
      && usCoverage.priceProcessingComplete
      && usCoverage.pmsComplete
      && usCoverage.featuresComplete
      && usPriceBasis === US_ADJUSTED_PRICE_BASIS
      && usDerivedPriceBasis === US_ADJUSTED_PRICE_BASIS
      && usAnalogPriceBasis === US_ADJUSTED_PRICE_BASIS
    )
    const sources = {
      themes: sourceState(themeEpoch?.value ?? null, 36),
      materials: sourceState(materialEpoch?.value ?? null, 3),
      earnings: sourceState(earningsEpoch?.value ?? null, 36),
      usEarnings: {
        ...sourceState(usEarningsEpoch?.value ?? null, 36),
        provider: 'finnhub',
        configured: Boolean(process.env.FINNHUB_API_KEY?.trim()),
        optional: true,
      },
    }
    const sourcesFresh = supplementalSourcesAreFresh(sources)
    const processText = await activeProcessText()
    const visibleJpJobs = runningJobs.filter((job) => runningJobIsVisible(job, processText))
    const latestUsSourceJobs = usSourceRunningJobs
      .filter((job) => runningJobIsVisible(job, processText))
      .filter(
        (job, index, jobs) => jobs.findIndex((candidate) => candidate.jobType === job.jobType) === index,
      )
    const visibleUsJobs = usRunningJobs.filter((job) => runningJobIsVisible(job, processText))
    const foundationSourceRun = latestUsSourceJobs.find(
      (job) => job.jobType === 'us_adjusted_foundation',
    )
    const usFoundationProgress = await loadUsFoundationProgress(
      foundationSourceRun?.startedAt ?? null,
    )
    const foundationProgressJob: RunningJobRow[] = usFoundationProgress && foundationSourceRun
      ? [{
          jobType: usFoundationProgress.detailJobType
            ? `us_adjusted_foundation:${usFoundationProgress.detailJobType}`
            : 'us_adjusted_foundation:shadow',
          startedAt: foundationSourceRun.startedAt,
          totalTickers: usFoundationProgress.totalTickers,
          succeeded: usFoundationProgress.succeeded,
          failed: usFoundationProgress.failed,
          rowsInserted: usFoundationProgress.rowsInserted,
          payloadJson: JSON.stringify({
            stage: usFoundationProgress.stage,
            heartbeatAt: new Date().toISOString(),
            progressBaseline: usFoundationProgress.progressBaseline,
            rateStartedAt: usFoundationProgress.rateStartedAt
              ? new Date(usFoundationProgress.rateStartedAt * 1000).toISOString()
              : null,
          }),
        }]
      : []
    const visibleUsSourceJobs = usFoundationProgress
      ? latestUsSourceJobs.filter((job) => job.jobType !== 'us_adjusted_foundation')
      : latestUsSourceJobs

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
          unavailable: ingestionUnavailable,
          deferred: ingestionDeferred,
          startedAt: new Date(usIngestionRun.startedAt * 1000).toISOString(),
          finishedAt: usIngestionRun.finishedAt
            ? new Date(usIngestionRun.finishedAt * 1000).toISOString()
            : null,
        } : null,
        fresh: usFresh,
      },
      sources,
      runningJobs: [
        ...visibleJpJobs.map((job) => runningJobState(job, 'JP')),
        ...foundationProgressJob.map((job) => runningJobState(job, 'US')),
        ...visibleUsSourceJobs.map((job) => runningJobState(job, 'US')),
        ...visibleUsJobs.map((job) => runningJobState(job, 'US')),
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
