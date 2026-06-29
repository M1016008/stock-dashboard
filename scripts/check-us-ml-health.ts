// scripts/check-us-ml-health.ts
//
// US analytics DB is large enough that the JP-wide ML health check can spend a
// long time on broad historical-universe scans. This lightweight check records
// the freshness points needed by the US pages without touching heavyweight
// maintenance tables.

import { createClient, type Client, type InValue } from '@libsql/client'
import path from 'path'
import { ML_PHYSICS_FEATURE_SET } from '@/lib/backtest/ml-physics'

const stockboardDbPath = process.env.STOCKBOARD_DB_PATH?.trim()
const stockboardDbLooksUs = stockboardDbPath != null && /stockboard-us\.db$/i.test(stockboardDbPath)
const dbPath = path.resolve(
  process.env.US_ANALYTICS_DB_PATH?.trim()
  || (stockboardDbLooksUs ? stockboardDbPath : undefined)
  || '/Volumes/OWC Express 1M2 80G/stockboard-data/us/stockboard-us.db',
)
const WRITE_HEALTH = process.env.US_ML_HEALTH_WRITE === '1'

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

async function get<T = Record<string, unknown>>(sql: string, args: Args = []): Promise<T | undefined> {
  const res = await client.execute({ sql, args: args as InValue[] })
  return res.rows[0] ? ({ ...res.rows[0] } as unknown as T) : undefined
}

async function run(sql: string, args: Args = []): Promise<void> {
  await client.execute({ sql, args: args as InValue[] })
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
  if (!row.expectedDate || !row.actualDate) return 'missing'
  if (row.actualDate !== row.expectedDate) return 'stale'
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

  const pmsDate = await maxDate('physical_momentum_metrics')
  checks.push({
    key: 'us_physical_momentum_metrics',
    expectedDate,
    actualDate: pmsDate,
    expectedCount: snapshotLatestCount ?? expectedCount,
    actualCount: await countRows('physical_momentum_metrics', 'date', pmsDate),
  })

  const physicsDate = await maxDate('ml_feature_vectors_v2', 'date', 'WHERE feature_set = ?', [ML_PHYSICS_FEATURE_SET])
  checks.push({
    key: 'us_ml_feature_vectors_v2',
    expectedDate,
    actualDate: physicsDate,
    expectedCount: snapshotLatestCount ?? expectedCount,
    actualCount: await countRows('ml_feature_vectors_v2', 'date', physicsDate, 'AND feature_set = ?', [ML_PHYSICS_FEATURE_SET]),
    payload: { featureSet: ML_PHYSICS_FEATURE_SET },
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

  for (const horizon of [5, 10, 20, 40, 60, 90]) {
    const latestPhysicsStatusLabelDate = await maxDate(
      'ml_short_labels',
      'date',
      'WHERE horizon_days = ?',
      [horizon],
    )
    const runDate = await maxDate(
      'ml_physics_status_evaluations',
      'evaluation_date',
      'WHERE feature_set = ? AND horizon_days = ?',
      [ML_PHYSICS_FEATURE_SET, horizon],
    )
    const endDate = await maxDate(
      'ml_physics_status_evaluations',
      'end_date',
      'WHERE feature_set = ? AND horizon_days = ?',
      [ML_PHYSICS_FEATURE_SET, horizon],
    )
    checks.push({
      key: `us_ml_physics_status_evaluations_h${horizon}`,
      expectedDate: latestPhysicsStatusLabelDate,
      actualDate: endDate,
      expectedCount: null,
      actualCount: await countRows(
        'ml_physics_status_evaluations',
        'end_date',
        endDate,
        'AND feature_set = ? AND horizon_days = ?',
        [ML_PHYSICS_FEATURE_SET, horizon],
      ),
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
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
