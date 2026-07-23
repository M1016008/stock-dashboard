import { execAll, execGet } from '@/lib/db/client'
import { getActiveUpdateLocks } from '@/lib/server/update-lock'
import { MAX_CONTINUOUS_HISTORY_GAP_DAYS, MIN_SNAPSHOT_DATA_POINTS } from '@/lib/snapshots/continuous-ma'

const UPDATE_JOB_TYPES = [
  'update_latest',
  'ohlcv_fetch:jquants',
  'snapshot_compute',
  'post_ohlcv_refresh',
  'feature_compute',
  'technical_signals',
  'ml_features',
  'ml_context_features',
  'ml_physics_features',
  'ml_physics_candidates',
  'ml_current_similars',
  'ml_similarity_evaluate',
  'ml_rl_policy',
  'ml_feature_health',
  'serving_backtest',
  'indices',
  'earnings_calendar',
  'dashboard_cache',
]
const LOCK_MANAGED_JOB_TYPES = new Set(['update_latest', 'post_ohlcv_refresh'])
const RUNNING_JOB_TTL_SECONDS = 45 * 60
const MIN_COVERAGE_RATIO = 1
const JQUANTS_DAILY_READY_MINUTES = 16 * 60 + 30

type MaxDateRow = {
  maxDate: string | null
}

export type RunningJob = {
  id: number
  jobType: string
  startedAt: string | number | Date
  source?: 'batch_runs' | 'update_locks'
}

export type LastRun = {
  id: number
  jobType: string
  status: string
  startedAt: string | number | Date
  finishedAt: string | number | Date | null
  errorSummary: string | null
}

export type DataFreshness = {
  expectedTradingDate: string
  latestOhlcvDate: string | null
  latestSnapshotDate: string | null
  latestIndexDate: string | null
  latestEarningsDate: string | null
  latestDashboardCacheDate: string | null
  latestPhysicalMomentumDate: string | null
  latestPhysicalMomentumScoreDate: string | null
  latestFeatureDate: string | null
  latestModelFeatureDate: string | null
  latestMlFeatureDate: string | null
  latestMlCandidateDate: string | null
  latestMlPredictionDate: string | null
  latestMlPhysicsFeatureDate: string | null
  latestMlPhysicsCandidateDate: string | null
  latestMlSimilarDate: string | null
  latestMlRlPolicyDate: string | null
  activeTickerCount: number
  staleOhlcvTickerCount: number
  staleSnapshotTickerCount: number
  latestOhlcvCount: number
  baselineOhlcvCount: number
  latestSnapshotCount: number
  baselineSnapshotCount: number
  needsOhlcvUpdate: boolean
  needsSnapshotUpdate: boolean
  needsDashboardCacheUpdate: boolean
  needsPhysicalMomentumUpdate: boolean
  needsFeatureUpdate: boolean
  needsModelFeatureUpdate: boolean
  needsMlFeatureUpdate: boolean
  needsMlCandidateUpdate: boolean
  needsMlPredictionUpdate: boolean
  needsMlPhysicsFeatureUpdate: boolean
  needsMlPhysicsCandidateUpdate: boolean
  needsMlSimilarUpdate: boolean
  needsMlRlPolicyUpdate: boolean
  needsUpdate: boolean
  running: boolean
  runningJobs: RunningJob[]
  lastRun: LastRun | null
  checkedAt: string
}

function jstParts(date: Date): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)

  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value)
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
  }
}

function formatDate(date: Date): string {
  const y = date.getUTCFullYear()
  const m = String(date.getUTCMonth() + 1).padStart(2, '0')
  const d = String(date.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function previousWeekday(date: Date): Date {
  const d = new Date(date)
  do {
    d.setUTCDate(d.getUTCDate() - 1)
  } while (d.getUTCDay() === 0 || d.getUTCDay() === 6)
  return d
}

export function expectedLatestTradingDate(now = new Date()): string {
  const parts = jstParts(now)
  const jstDate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day))
  const weekday = jstDate.getUTCDay()
  const minuteOfDay = parts.hour * 60 + parts.minute

  if (weekday === 0) return formatDate(previousWeekday(jstDate))
  if (weekday === 6) return formatDate(previousWeekday(jstDate))
  if (minuteOfDay < JQUANTS_DAILY_READY_MINUTES) return formatDate(previousWeekday(jstDate))
  return formatDate(jstDate)
}

async function maxDate(tableName: string, columnName: string): Promise<string | null> {
  const row = await execGet<MaxDateRow>(`SELECT MAX(${columnName}) AS maxDate FROM ${tableName}`)
  return row?.maxDate ?? null
}

async function loadLatestPhysicalMomentumDate(requireScores: boolean): Promise<string | null> {
  const scoreFilter = requireScores
    ? `
        AND physical_momentum_score IS NOT NULL
        AND physical_force_score IS NOT NULL
        AND physical_energy_score IS NOT NULL
      `
    : ''
  const row = await execGet<{ date: string | null }>(
    `
      SELECT date
      FROM physical_momentum_metrics
      WHERE market = 'JP'
        ${scoreFilter}
      ORDER BY date DESC
      LIMIT 1
    `,
  )
  return row?.date ?? null
}

async function dateCoverage(tableName: string): Promise<{ latestCount: number; baselineCount: number }> {
  const rows = await execAll<{ date: string; count: number }>(`
    WITH recent_dates AS (
      SELECT DISTINCT date
      FROM ${tableName}
      ORDER BY date DESC
      LIMIT 5
    )
    SELECT
      rd.date,
      (
        SELECT COUNT(*)
        FROM ${tableName} t
        WHERE t.date = rd.date
      ) AS count
    FROM recent_dates rd
    ORDER BY rd.date DESC
  `)
  const latestCount = Number(rows[0]?.count ?? 0)
  const baselineCount = Math.max(...rows.map(r => Number(r.count ?? 0)), latestCount)
  return { latestCount, baselineCount }
}

export async function getDataFreshness(now = new Date()): Promise<DataFreshness> {
  const expectedTradingDate = expectedLatestTradingDate(now)
  const [
    latestOhlcvDate,
    latestSnapshotDate,
    latestIndexDate,
    latestEarningsDate,
    latestDashboardCacheDate,
    latestPhysicalMomentumDate,
    latestPhysicalMomentumScoreDate,
    latestFeatureDate,
    latestModelFeatureDate,
    latestMlFeatureDate,
    latestMlCandidateDate,
    latestMlPredictionDate,
    latestMlPhysicsFeatureDate,
    latestMlPhysicsCandidateDate,
    latestMlSimilarDate,
    latestMlRlPolicyDate,
    ohlcvCoverage,
    snapshotCoverage,
    snapshotEligibleCoverage,
    jquantsCoverage,
    tickerCoverage,
  ] = await Promise.all([
    maxDate('ohlcv_daily', 'date'),
    maxDate('daily_snapshots', 'date'),
    maxDate('indices_daily', 'date'),
    maxDate('earnings_calendar', 'announce_date'),
    maxDate('dashboard_cache', 'date'),
    loadLatestPhysicalMomentumDate(false),
    loadLatestPhysicalMomentumDate(true),
    maxDate('feature_snapshots', 'date'),
    maxDate('model_features', 'date'),
    maxDate('ml_feature_vectors', 'date'),
    maxDate('serving_ml_candidates', 'as_of_date'),
    maxDate('ml_predictions', 'as_of_date'),
    maxDate('ml_feature_vectors_v2', 'date'),
    maxDate('serving_ml_physics_candidates', 'as_of_date'),
    maxDate('serving_current_similars', 'as_of_date'),
    maxDate('ml_rl_policy_evaluations', 'evaluation_date'),
    dateCoverage('ohlcv_daily'),
    dateCoverage('daily_snapshots'),
    execGet<{ eligibleSnapshotRows: number }>(
      `
        SELECT COUNT(*) AS eligibleSnapshotRows
        FROM ticker_universe u
        WHERE u.active = 1
          AND EXISTS (
            SELECT 1
            FROM ohlcv_daily o
            WHERE o.ticker = u.ticker
              AND o.date = ?
          )
          AND (
            SELECT COUNT(*)
            FROM (
              SELECT h.date
              FROM ohlcv_daily h
              WHERE h.ticker = u.ticker
                AND h.date <= ?
              ORDER BY h.date DESC
              LIMIT ?
            )
          ) >= ?
          AND NOT EXISTS (
            SELECT 1
            FROM (
              SELECT
                date,
                LEAD(date) OVER (ORDER BY date) AS next_date
              FROM (
                SELECT h.date
                FROM ohlcv_daily h
                WHERE h.ticker = u.ticker
                  AND h.date <= ?
                ORDER BY h.date DESC
                LIMIT ?
              )
            )
            WHERE next_date IS NOT NULL
              AND julianday(next_date) - julianday(date) > ?
          )
      `,
      [
        expectedTradingDate,
        expectedTradingDate,
        MIN_SNAPSHOT_DATA_POINTS,
        MIN_SNAPSHOT_DATA_POINTS,
        expectedTradingDate,
        MIN_SNAPSHOT_DATA_POINTS,
        MAX_CONTINUOUS_HISTORY_GAP_DAYS,
      ],
    ),
    execGet<{ expectedRows: number }>(
      `SELECT expected_rows AS expectedRows FROM jquants_daily_coverage WHERE date = ?`,
      [expectedTradingDate],
    ),
    execGet<{
      activeTickerCount: number
      staleOhlcvTickerCount: number
      staleSnapshotTickerCount: number
    }>(
      `
        SELECT
          COUNT(*) AS activeTickerCount,
          SUM(CASE
            WHEN NOT EXISTS (
              SELECT 1
              FROM ohlcv_daily o
              WHERE o.ticker = u.ticker
                AND o.date = ?
            )
            THEN 1 ELSE 0
          END) AS staleOhlcvTickerCount,
          SUM(CASE
            WHEN EXISTS (
              SELECT 1
              FROM ohlcv_daily o
              WHERE o.ticker = u.ticker
                AND o.date = ?
            )
            AND (
              SELECT COUNT(*)
              FROM (
                SELECT h.date
                FROM ohlcv_daily h
                WHERE h.ticker = u.ticker
                  AND h.date <= ?
                ORDER BY h.date DESC
                LIMIT ?
              )
            ) >= ?
            AND NOT EXISTS (
              SELECT 1
              FROM (
                SELECT
                  date,
                  LEAD(date) OVER (ORDER BY date) AS next_date
                FROM (
                  SELECT h.date
                  FROM ohlcv_daily h
                  WHERE h.ticker = u.ticker
                    AND h.date <= ?
                  ORDER BY h.date DESC
                  LIMIT ?
                )
              )
              WHERE next_date IS NOT NULL
                AND julianday(next_date) - julianday(date) > ?
            )
            AND NOT EXISTS (
              SELECT 1
              FROM daily_snapshots s
              WHERE s.ticker = u.ticker
                AND s.date = ?
            )
            THEN 1 ELSE 0
          END) AS staleSnapshotTickerCount
        FROM ticker_universe u
        WHERE u.active = 1
      `,
      [
        expectedTradingDate,
        expectedTradingDate,
        expectedTradingDate,
        MIN_SNAPSHOT_DATA_POINTS,
        MIN_SNAPSHOT_DATA_POINTS,
        expectedTradingDate,
        MIN_SNAPSHOT_DATA_POINTS,
        MAX_CONTINUOUS_HISTORY_GAP_DAYS,
        expectedTradingDate,
      ],
    ),
  ])

  const placeholders = UPDATE_JOB_TYPES.map(() => '?').join(', ')
  const [batchRunningJobs, activeLocks, lastRun] = await Promise.all([
    execAll<RunningJob>(
      `
        SELECT id, job_type AS jobType, started_at AS startedAt, 'batch_runs' AS source
        FROM batch_runs
        WHERE status = 'running'
          AND job_type IN (${placeholders})
          AND started_at >= unixepoch() - ?
        ORDER BY id DESC
      `,
      [...UPDATE_JOB_TYPES, RUNNING_JOB_TTL_SECONDS],
    ),
    getActiveUpdateLocks(UPDATE_JOB_TYPES),
    execGet<LastRun>(
      `
        SELECT
          id,
          job_type AS jobType,
          status,
          started_at AS startedAt,
          finished_at AS finishedAt,
          error_summary AS errorSummary
        FROM batch_runs
        WHERE job_type IN (${placeholders})
        ORDER BY id DESC
        LIMIT 1
      `,
      UPDATE_JOB_TYPES,
    ),
  ])

  const lockRunningJobs: RunningJob[] = activeLocks.map((lock, index) => ({
    id: -1 - index,
    jobType: lock.jobType,
    startedAt: lock.startedAt,
    source: 'update_locks',
  }))
  const activeLockJobTypes = new Set(activeLocks.map((lock) => lock.jobType))
  const reliableBatchRunningJobs = batchRunningJobs.filter((job) => {
    if (!LOCK_MANAGED_JOB_TYPES.has(job.jobType)) return true
    return activeLockJobTypes.has(job.jobType)
  })
  const runningJobs = [...lockRunningJobs, ...reliableBatchRunningJobs]

  const activeTickerCount = Number(tickerCoverage?.activeTickerCount ?? 0)
  const staleOhlcvTickerCount = Number(tickerCoverage?.staleOhlcvTickerCount ?? activeTickerCount)
  const staleSnapshotTickerCount = Number(tickerCoverage?.staleSnapshotTickerCount ?? activeTickerCount)
  const latestOhlcvCount = ohlcvCoverage.latestCount
  const baselineOhlcvCount = Number(jquantsCoverage?.expectedRows ?? ohlcvCoverage.baselineCount)
  const latestSnapshotCount = snapshotCoverage.latestCount
  const eligibleSnapshotRows = Number(snapshotEligibleCoverage?.eligibleSnapshotRows ?? 0)
  const baselineSnapshotCount = eligibleSnapshotRows > 0
    ? eligibleSnapshotRows
    : Number(jquantsCoverage?.expectedRows ?? snapshotCoverage.baselineCount)
  const ohlcvCoverageFresh =
    baselineOhlcvCount === 0 || latestOhlcvCount >= Math.floor(baselineOhlcvCount * MIN_COVERAGE_RATIO)
  const snapshotCoverageFresh =
    baselineSnapshotCount === 0 || latestSnapshotCount >= Math.floor(baselineSnapshotCount * MIN_COVERAGE_RATIO)

  const needsOhlcvUpdate =
    !latestOhlcvDate
    || latestOhlcvDate < expectedTradingDate
    || !ohlcvCoverageFresh
  const needsSnapshotUpdate =
    !latestSnapshotDate
    || (!!latestOhlcvDate && latestSnapshotDate < latestOhlcvDate)
    || latestSnapshotDate < expectedTradingDate
    || !snapshotCoverageFresh
  const needsDashboardCacheUpdate =
    !!latestSnapshotDate
    && (!latestDashboardCacheDate || latestDashboardCacheDate < latestSnapshotDate)
  const needsPhysicalMomentumUpdate =
    !!latestOhlcvDate
    && (
      !latestPhysicalMomentumDate
      || latestPhysicalMomentumDate < latestOhlcvDate
      || !latestPhysicalMomentumScoreDate
      || latestPhysicalMomentumScoreDate < latestOhlcvDate
    )
  const needsFeatureUpdate =
    !!latestSnapshotDate
    && (!latestFeatureDate || latestFeatureDate < latestSnapshotDate)
  const needsModelFeatureUpdate =
    !!latestSnapshotDate
    && (!latestModelFeatureDate || latestModelFeatureDate < latestSnapshotDate)
  const needsMlFeatureUpdate =
    !!latestSnapshotDate
    && (!latestMlFeatureDate || latestMlFeatureDate < latestSnapshotDate)
  const needsMlCandidateUpdate =
    !!latestMlFeatureDate
    && (!latestMlCandidateDate || latestMlCandidateDate < latestMlFeatureDate)
  const needsMlPredictionUpdate =
    !!latestMlCandidateDate
    && (!latestMlPredictionDate || latestMlPredictionDate < latestMlCandidateDate)
  const needsMlPhysicsFeatureUpdate =
    !!latestSnapshotDate
    && (!latestMlPhysicsFeatureDate || latestMlPhysicsFeatureDate < latestSnapshotDate)
  const needsMlPhysicsCandidateUpdate =
    !!latestMlPhysicsFeatureDate
    && (!latestMlPhysicsCandidateDate || latestMlPhysicsCandidateDate < latestMlPhysicsFeatureDate)
  const needsMlSimilarUpdate =
    !!latestMlPhysicsFeatureDate
    && (!latestMlSimilarDate || latestMlSimilarDate < latestMlPhysicsFeatureDate)
  const needsMlRlPolicyUpdate =
    !!latestMlPhysicsFeatureDate
    && (!latestMlRlPolicyDate || latestMlRlPolicyDate < latestMlPhysicsFeatureDate)

  return {
    expectedTradingDate,
    latestOhlcvDate,
    latestSnapshotDate,
    latestIndexDate,
    latestEarningsDate,
    latestDashboardCacheDate,
    latestPhysicalMomentumDate,
    latestPhysicalMomentumScoreDate,
    latestFeatureDate,
    latestModelFeatureDate,
    latestMlFeatureDate,
    latestMlCandidateDate,
    latestMlPredictionDate,
    latestMlPhysicsFeatureDate,
    latestMlPhysicsCandidateDate,
    latestMlSimilarDate,
    latestMlRlPolicyDate,
    activeTickerCount,
    staleOhlcvTickerCount,
    staleSnapshotTickerCount,
    latestOhlcvCount,
    baselineOhlcvCount,
    latestSnapshotCount,
    baselineSnapshotCount,
    needsOhlcvUpdate,
    needsSnapshotUpdate,
    needsDashboardCacheUpdate,
    needsPhysicalMomentumUpdate,
    needsFeatureUpdate,
    needsModelFeatureUpdate,
    needsMlFeatureUpdate,
    needsMlCandidateUpdate,
    needsMlPredictionUpdate,
    needsMlPhysicsFeatureUpdate,
    needsMlPhysicsCandidateUpdate,
    needsMlSimilarUpdate,
    needsMlRlPolicyUpdate,
    needsUpdate:
      needsOhlcvUpdate
      || needsSnapshotUpdate
      || needsDashboardCacheUpdate
      || needsPhysicalMomentumUpdate
      || needsFeatureUpdate
      || needsModelFeatureUpdate
      || needsMlFeatureUpdate
      || needsMlCandidateUpdate
      || needsMlPredictionUpdate
      || needsMlPhysicsFeatureUpdate
      || needsMlPhysicsCandidateUpdate
      || needsMlSimilarUpdate
      || needsMlRlPolicyUpdate,
    running: runningJobs.length > 0,
    runningJobs,
    lastRun: lastRun ?? null,
    checkedAt: now.toISOString(),
  }
}
