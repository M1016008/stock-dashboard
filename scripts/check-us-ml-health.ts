// scripts/check-us-ml-health.ts
//
// US analytics DB is large enough that the JP-wide ML health check can spend a
// long time on broad historical-universe scans. This lightweight check records
// the freshness points needed by the US pages without touching heavyweight
// maintenance tables.

import { createClient, type Client, type InValue } from '@libsql/client'
import path from 'path'
import { ML_PHYSICS_FEATURE_SET } from '@/lib/backtest/ml-physics'
import { ML_PRIMARY_HORIZONS } from '@/lib/backtest/ml-horizons'

const stockboardDbPath = process.env.STOCKBOARD_DB_PATH?.trim()
const stockboardDbLooksUs = stockboardDbPath != null && /stockboard-us\.db$/i.test(stockboardDbPath)
const dbPath = path.resolve(
  process.env.US_ANALYTICS_DB_PATH?.trim()
  || (stockboardDbLooksUs ? stockboardDbPath : undefined)
  || '/Volumes/こうし/stockboard-data/us/stockboard-us.db',
)
const WRITE_HEALTH = process.env.US_ML_HEALTH_WRITE === '1'
const PROFILE_QUERIES = process.env.US_ML_HEALTH_PROFILE === '1'
const MIN_HISTORY_DAYS = Math.max(1, Number(process.env.US_ML_HEALTH_MIN_HISTORY_DAYS ?? 220))

type Args = readonly InValue[]

type HealthRow = {
  key: string
  expectedDate: string | null
  actualDate: string | null
  expectedCount: number | null
  actualCount: number | null
  payload?: Record<string, unknown>
}

const client: Client = createClient({ url: `file:${dbPath}` })

function profileQuery(sql: string, startedAt: number): void {
  if (!PROFILE_QUERIES) return
  const label = sql.replace(/\s+/g, ' ').trim().slice(0, 120)
  console.log(`[us-ml-health] ${Date.now() - startedAt}ms ${label}`)
}

async function get<T = Record<string, unknown>>(sql: string, args: Args = []): Promise<T | undefined> {
  const startedAt = Date.now()
  const res = await client.execute({ sql, args: args as InValue[] })
  profileQuery(sql, startedAt)
  return res.rows[0] ? ({ ...res.rows[0] } as unknown as T) : undefined
}

async function all<T = Record<string, unknown>>(sql: string, args: Args = []): Promise<T[]> {
  const startedAt = Date.now()
  const res = await client.execute({ sql, args: args as InValue[] })
  profileQuery(sql, startedAt)
  return res.rows.map((row) => ({ ...row } as unknown as T))
}

async function run(sql: string, args: Args = []): Promise<void> {
  const startedAt = Date.now()
  await client.execute({ sql, args: args as InValue[] })
  profileQuery(sql, startedAt)
}

async function maxDate(table: string, column = 'date', where = '', args: Args = []): Promise<string | null> {
  const row = await get<{ date: string | null }>(`SELECT MAX(${column}) AS date FROM ${table} ${where}`, args)
  return row?.date ?? null
}

async function countRows(table: string, column: string, date: string | null, where = '', args: Args = []): Promise<number | null> {
  if (!date) return null
  const row = await get<{ count: number }>(
    `SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ? ${where}`,
    [date, ...args],
  )
  return Number(row?.count ?? 0)
}

function statusFor(row: HealthRow): string {
  if (row.payload?.qualityOk === false) return 'invalid'
  if (!row.expectedDate || !row.actualDate) return 'missing'
  if (row.actualDate !== row.expectedDate) return 'stale'
  if (
    row.payload?.strictCoverage === true
    && row.expectedCount != null
    && row.actualCount != null
    && row.actualCount < row.expectedCount
  ) {
    return 'partial'
  }
  if (row.expectedCount && row.actualCount != null && row.actualCount < Math.floor(row.expectedCount * 0.75)) return 'partial'
  return 'ok'
}

async function main() {
  await run('PRAGMA busy_timeout=60000')
  await run('PRAGMA synchronous=NORMAL')
  if (WRITE_HEALTH) {
    await run(`
      CREATE TABLE IF NOT EXISTS ml_feature_health_checks (
        check_date TEXT NOT NULL,
        check_key TEXT NOT NULL,
        status TEXT NOT NULL,
        expected_date TEXT,
        actual_date TEXT,
        expected_count INTEGER,
        actual_count INTEGER,
        payload_json TEXT,
        computed_at INTEGER NOT NULL,
        PRIMARY KEY (check_date, check_key)
      )
    `)
  }

  const expectedDate = await maxDate('ohlcv_daily')
  const expectedCount = await countRows('ohlcv_daily', 'date', expectedDate)
  const latestSnapshotDate = await maxDate('daily_snapshots')
  const snapshotLatestCount = await countRows('daily_snapshots', 'date', latestSnapshotDate)
  const checks: HealthRow[] = []

  checks.push({
    key: 'us_daily_snapshots',
    expectedDate,
    actualDate: latestSnapshotDate,
    expectedCount,
    actualCount: snapshotLatestCount,
  })

  const pmsDate = await maxDate(
    'physical_momentum_metrics',
    'date',
    'WHERE market = ?',
    ['US'],
  )
  const pmsQuality = pmsDate
    ? await get<{
        maxAbsPms: number | null
      maxAbsPfs: number | null
      maxAbsPes: number | null
      extremeScoreCount: number
      eligibleCount: number
      coveredCount: number
      rawRowCount: number
      }>(
        `
          SELECT
            MAX(ABS(physical_momentum_score)) AS maxAbsPms,
            MAX(ABS(physical_force_score)) AS maxAbsPfs,
            MAX(ABS(physical_energy_score)) AS maxAbsPes,
            SUM(
              CASE
                WHEN ABS(physical_momentum_score) > 8
                  OR ABS(physical_force_score) > 8
                  OR ABS(physical_energy_score) > 8
                THEN 1 ELSE 0
              END
            ) AS extremeScoreCount,
            COUNT(*) AS rawRowCount,
            SUM(
              CASE
                WHEN velocity IS NOT NULL
                  AND acceleration IS NOT NULL
                  AND momentum IS NOT NULL
                  AND force IS NOT NULL
                  AND ma_angle_avg IS NOT NULL
                  AND energy IS NOT NULL
                THEN 1 ELSE 0
              END
            ) AS eligibleCount,
            SUM(
              CASE
                WHEN velocity IS NOT NULL
                  AND acceleration IS NOT NULL
                  AND momentum IS NOT NULL
                  AND force IS NOT NULL
                  AND ma_angle_avg IS NOT NULL
                  AND energy IS NOT NULL
                  AND physical_momentum_score IS NOT NULL
                  AND physical_force_score IS NOT NULL
                  AND physical_energy_score IS NOT NULL
                THEN 1 ELSE 0
              END
            ) AS coveredCount
          FROM physical_momentum_metrics
          WHERE market = 'US'
            AND date = ?
        `,
        [pmsDate],
      )
    : undefined
  const extremeScoreCount = Number(pmsQuality?.extremeScoreCount ?? 0)
  checks.push({
    key: 'us_physical_momentum_metrics',
    expectedDate,
    actualDate: pmsDate,
    expectedCount: Number(pmsQuality?.eligibleCount ?? 0),
    actualCount: Number(pmsQuality?.coveredCount ?? 0),
    payload: {
      qualityOk: extremeScoreCount === 0,
      strictCoverage: true,
      denominator: 'raw_complete',
      rawRowCount: Number(pmsQuality?.rawRowCount ?? 0),
      maxAbsPms: pmsQuality?.maxAbsPms ?? null,
      maxAbsPfs: pmsQuality?.maxAbsPfs ?? null,
      maxAbsPes: pmsQuality?.maxAbsPes ?? null,
      extremeScoreCount,
      absoluteScoreLimit: 8,
    },
  })

  const physicsDate = await maxDate('ml_feature_vectors_v2', 'date', 'WHERE feature_set = ?', [ML_PHYSICS_FEATURE_SET])
  const physicsCoverage = latestSnapshotDate
    ? await get<{ eligibleCount: number; coveredCount: number }>(
        `
          SELECT
            COUNT(*) AS eligibleCount,
            COUNT(f.ticker) AS coveredCount
          FROM ohlcv_daily current INDEXED BY ohlcv_date_ticker_idx
          INNER JOIN ticker_universe universe
            ON universe.ticker = current.ticker
           AND universe.active = 1
          LEFT JOIN us_analytics_copy_state copy ON copy.ticker = current.ticker
          LEFT JOIN ml_feature_vectors_v2 f INDEXED BY ml_feature_vectors_v2_feature_ticker_date_idx
            ON f.feature_set = ?
           AND f.ticker = current.ticker
           AND f.date = current.date
          WHERE current.date = ?
            AND (
              COALESCE(copy.ohlcv_rows, 0) >= ?
              OR EXISTS (
                SELECT 1
                FROM ohlcv_daily history INDEXED BY sqlite_autoindex_ohlcv_daily_1
                WHERE history.ticker = current.ticker
                ORDER BY history.date
                LIMIT 1 OFFSET ?
              )
            )
        `,
        [
          ML_PHYSICS_FEATURE_SET,
          latestSnapshotDate,
          MIN_HISTORY_DAYS,
          MIN_HISTORY_DAYS - 1,
        ],
      )
    : undefined
  checks.push({
    key: 'us_ml_feature_vectors_v2',
    expectedDate,
    actualDate: physicsDate,
    expectedCount: Number(physicsCoverage?.eligibleCount ?? 0),
    actualCount: Number(physicsCoverage?.coveredCount ?? 0),
    payload: {
      featureSet: ML_PHYSICS_FEATURE_SET,
      strictCoverage: true,
      denominator: 'latest_price_with_hybrid_minimum_history_check',
      minimumHistoryDays: MIN_HISTORY_DAYS,
    },
  })

  const candidateDate = await maxDate('serving_ml_physics_candidates', 'as_of_date')
  checks.push({
    key: 'us_serving_ml_physics_candidates',
    expectedDate,
    actualDate: candidateDate,
    expectedCount: null,
    actualCount: await countRows('serving_ml_physics_candidates', 'as_of_date', candidateDate),
  })

  const similarDate = await maxDate('serving_current_similars', 'as_of_date')
  const similarBases = similarDate
    ? Number((await get<{ count: number }>(
      'SELECT COUNT(DISTINCT base_ticker) AS count FROM serving_current_similars WHERE as_of_date = ?',
      [similarDate],
    ))?.count ?? 0)
    : null
  checks.push({
    key: 'us_serving_current_similars',
    expectedDate,
    actualDate: similarDate,
    expectedCount: snapshotLatestCount ?? expectedCount,
    actualCount: similarBases,
    payload: { metric: 'distinct base_ticker' },
  })

  const shortLabelDate = await maxDate('ml_short_labels')
  const rlStateDate = await maxDate('rl_training_states_v2')
  checks.push({
    key: 'us_rl_training_states_v2',
    expectedDate: shortLabelDate,
    actualDate: rlStateDate,
    expectedCount: null,
    actualCount: await countRows('rl_training_states_v2', 'date', rlStateDate),
    payload: { expectedFrom: 'ml_short_labels.max(date)' },
  })

  const rlPolicyDataDate = await maxDate('ml_rl_policy_evaluations', 'end_date')
  const rlPolicyRunDate = await maxDate('ml_rl_policy_evaluations', 'evaluation_date')
  checks.push({
    key: 'us_ml_rl_policy_evaluations',
    expectedDate: rlStateDate,
    actualDate: rlPolicyDataDate,
    expectedCount: null,
    actualCount: await countRows('ml_rl_policy_evaluations', 'end_date', rlPolicyDataDate),
    payload: { latestEvaluationRunDate: rlPolicyRunDate },
  })

  const physicsStatusRows = await all<{
    horizonDays: number
    runDate: string | null
    endDate: string | null
    latestCount: number
  }>(
    `
      SELECT
        horizon_days AS horizonDays,
        MAX(evaluation_date) AS runDate,
        MAX(end_date) AS endDate,
        SUM(CASE WHEN end_date = latest_end_date THEN 1 ELSE 0 END) AS latestCount
      FROM (
        SELECT
          horizon_days,
          evaluation_date,
          end_date,
          MAX(end_date) OVER (PARTITION BY horizon_days) AS latest_end_date
        FROM ml_physics_status_evaluations
        WHERE feature_set = ?
          AND sample_count > 0
      )
      GROUP BY horizon_days
    `,
    [ML_PHYSICS_FEATURE_SET],
  )
  const physicsStatusByHorizon = new Map(
    physicsStatusRows.map((row) => [Number(row.horizonDays), row]),
  )

  for (const horizon of ML_PRIMARY_HORIZONS) {
    const latestPhysicsStatusLabelDate = await maxDate(
      'ml_short_labels',
      'date',
      'WHERE horizon_days = ?',
      [horizon],
    )
    const status = physicsStatusByHorizon.get(horizon)
    const runDate = status?.runDate ?? null
    const endDate = status?.endDate ?? null
    checks.push({
      key: `us_ml_physics_status_evaluations_h${horizon}`,
      expectedDate: latestPhysicsStatusLabelDate,
      actualDate: endDate,
      expectedCount: null,
      actualCount: status ? Number(status.latestCount) : null,
      payload: { featureSet: ML_PHYSICS_FEATURE_SET, horizonDays: horizon, latestEvaluationRunDate: runDate },
    })
  }

  const checkDate = new Date().toISOString().slice(0, 10)
  if (WRITE_HEALTH) {
    for (const check of checks) {
      await run(
        `
        INSERT OR REPLACE INTO ml_feature_health_checks
          (check_date, check_key, status, expected_date, actual_date, expected_count, actual_count, payload_json, computed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
        `,
        [
          checkDate,
          check.key,
          statusFor(check),
          check.expectedDate,
          check.actualDate,
          check.expectedCount,
          check.actualCount,
          JSON.stringify(check.payload ?? {}),
        ],
      )
    }
  }

  const summary = checks
    .map((check) => `${check.key}=${statusFor(check)}(${check.actualDate ?? '-'} ${check.actualCount ?? '-'})`)
    .join(', ')
  console.log(`us ml health ${checkDate}: ${summary}`)

  const nonOk = checks
    .map((check) => ({ key: check.key, status: statusFor(check) }))
    .filter((check) => check.status !== 'ok')
  if (nonOk.length > 0 && process.env.US_ML_HEALTH_ALLOW_NON_OK !== '1') {
    throw new Error(
      `US ML health gate failed: ${nonOk.map((check) => `${check.key}=${check.status}`).join(', ')}`,
    )
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
