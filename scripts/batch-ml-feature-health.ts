// scripts/batch-ml-feature-health.ts
//
// MLの基準日ズレと部分更新を検出して、画面/APIが不完全な最新日を採用しないための監視情報を保存する。

import { execAll, execBatch, execGet } from '@/lib/db/client'
import { ML_PHYSICS_FEATURE_SET } from '@/lib/backtest/ml-physics'

type Check = {
  key: string
  expectedDate: string | null
  actualDate: string | null
  expectedCount: number | null
  actualCount: number | null
  payload?: Record<string, unknown>
}

function statusFor(check: Check): string {
  if (!check.expectedDate || !check.actualDate) return 'missing'
  if (check.actualDate !== check.expectedDate) return 'stale'
  if (check.expectedCount && check.actualCount != null && check.actualCount < Math.floor(check.expectedCount * 0.85)) return 'partial'
  return 'ok'
}

async function maxDate(table: string, column = 'date', where = '', args: Array<string | number> = []): Promise<string | null> {
  const row = await execGet<{ date: string | null }>(
    `SELECT MAX(${column}) AS date FROM ${table} ${where}`,
    args,
  )
  return row?.date ?? null
}

async function countRows(table: string, dateColumn: string, date: string | null, where = '', args: Array<string | number> = []): Promise<number | null> {
  if (!date) return null
  const row = await execGet<{ count: number }>(
    `SELECT COUNT(*) AS count FROM ${table} WHERE ${dateColumn} = ? ${where}`,
    [date, ...args],
  )
  return Number(row?.count ?? 0)
}

async function main() {
  const expectedDate = await maxDate('ohlcv_daily')
  const expectedCount = await countRows('ohlcv_daily', 'date', expectedDate)
  const checks: Check[] = []

  const snapshotDate = await maxDate('daily_snapshots')
  checks.push({
    key: 'daily_snapshots',
    expectedDate,
    actualDate: snapshotDate,
    expectedCount,
    actualCount: await countRows('daily_snapshots', 'date', snapshotDate),
  })

  const modelFeatureDate = await maxDate('model_features')
  checks.push({
    key: 'model_features',
    expectedDate,
    actualDate: modelFeatureDate,
    expectedCount,
    actualCount: await countRows('model_features', 'date', modelFeatureDate),
  })

  const physicsDate = await maxDate('ml_feature_vectors_v2', 'date', 'WHERE feature_set = ?', [ML_PHYSICS_FEATURE_SET])
  checks.push({
    key: 'ml_feature_vectors_v2',
    expectedDate,
    actualDate: physicsDate,
    expectedCount,
    actualCount: await countRows('ml_feature_vectors_v2', 'date', physicsDate, 'AND feature_set = ?', [ML_PHYSICS_FEATURE_SET]),
    payload: { featureSet: ML_PHYSICS_FEATURE_SET },
  })

  const historicalUniverseDate = await maxDate('historical_universe', 'latest_ohlcv_date')
  const historicalUniverseCount = (await execGet<{ count: number }>(
    `SELECT COUNT(*) AS count FROM historical_universe`,
  ))?.count ?? null
  const historicalUniverseExpectedCount = (await execGet<{ count: number }>(
    `SELECT COUNT(*) AS count FROM (SELECT ticker FROM ohlcv_daily GROUP BY ticker)`,
  ))?.count ?? null
  const historicalUniversePayload = await execGet<{
    current_count: number
    historical_only_count: number
    missing_ticker_universe_count: number
    ml_incomplete_count: number
  }>(
    `
    SELECT
      SUM(CASE WHEN is_latest_member = 1 THEN 1 ELSE 0 END) AS current_count,
      SUM(CASE WHEN is_latest_member = 0 THEN 1 ELSE 0 END) AS historical_only_count,
      SUM(missing_from_ticker_universe) AS missing_ticker_universe_count,
      SUM(CASE WHEN has_ml_physics_v2 = 0 THEN 1 ELSE 0 END) AS ml_incomplete_count
    FROM historical_universe
    `,
  )
  checks.push({
    key: 'historical_universe',
    expectedDate,
    actualDate: historicalUniverseDate,
    expectedCount: historicalUniverseExpectedCount,
    actualCount: historicalUniverseCount,
    payload: {
      source: 'ohlcv_daily distinct ticker',
      currentCount: Number(historicalUniversePayload?.current_count ?? 0),
      historicalOnlyCount: Number(historicalUniversePayload?.historical_only_count ?? 0),
      missingTickerUniverseCount: Number(historicalUniversePayload?.missing_ticker_universe_count ?? 0),
      mlIncompleteCount: Number(historicalUniversePayload?.ml_incomplete_count ?? 0),
    },
  })

  const similarDate = await maxDate('serving_current_similars', 'as_of_date')
  const similarBases = similarDate
    ? (await execGet<{ count: number }>(
        `SELECT COUNT(DISTINCT base_ticker) AS count FROM serving_current_similars WHERE as_of_date = ?`,
        [similarDate],
      ))?.count ?? 0
    : null
  checks.push({
    key: 'serving_current_similars',
    expectedDate,
    actualDate: similarDate,
    expectedCount,
    actualCount: similarBases,
    payload: { metric: 'distinct base_ticker' },
  })

  const physicsCandidateDate = await maxDate('serving_ml_physics_candidates', 'as_of_date')
  checks.push({
    key: 'serving_ml_physics_candidates',
    expectedDate,
    actualDate: physicsCandidateDate,
    expectedCount: null,
    actualCount: await countRows('serving_ml_physics_candidates', 'as_of_date', physicsCandidateDate),
  })

  const latestShortLabelDate = await maxDate('ml_short_labels')
  const rlStateDate = await maxDate('rl_training_states_v2')
  checks.push({
    key: 'rl_training_states_v2',
    expectedDate: latestShortLabelDate,
    actualDate: rlStateDate,
    expectedCount: null,
    actualCount: await countRows('rl_training_states_v2', 'date', rlStateDate),
    payload: { expectedFrom: 'ml_short_labels.max(date)' },
  })

  const rlPolicyDataDate = await maxDate('ml_rl_policy_evaluations', 'end_date')
  const rlPolicyRunDate = await maxDate('ml_rl_policy_evaluations', 'evaluation_date')
  checks.push({
    key: 'ml_rl_policy_evaluations',
    expectedDate: rlStateDate,
    actualDate: rlPolicyDataDate,
    expectedCount: null,
    actualCount: await countRows('ml_rl_policy_evaluations', 'end_date', rlPolicyDataDate),
    payload: { expectedFrom: 'rl_training_states_v2.max(date)', latestEvaluationRunDate: rlPolicyRunDate },
  })

  const physicsStatusHorizons = [5, 10, 20, 40, 60, 90]
  for (const horizon of physicsStatusHorizons) {
    const latestPhysicsStatusLabelDate = await execGet<{ date: string | null }>(
      `SELECT MAX(date) AS date FROM ml_short_labels WHERE horizon_days = ?`,
      [horizon],
    ).then((row) => row?.date ?? null)
    const physicsStatusEvaluationDataDate = await maxDate(
      'ml_physics_status_evaluations',
      'end_date',
      'WHERE feature_set = ? AND horizon_days = ? AND sample_count > 0',
      [ML_PHYSICS_FEATURE_SET, horizon],
    )
    const physicsStatusEvaluationRunDate = await maxDate(
      'ml_physics_status_evaluations',
      'evaluation_date',
      'WHERE feature_set = ? AND horizon_days = ? AND sample_count > 0',
      [ML_PHYSICS_FEATURE_SET, horizon],
    )
    checks.push({
      key: `ml_physics_status_evaluations_h${horizon}`,
      expectedDate: latestPhysicsStatusLabelDate,
      actualDate: physicsStatusEvaluationDataDate,
      expectedCount: null,
      actualCount: await countRows(
        'ml_physics_status_evaluations',
        'end_date',
        physicsStatusEvaluationDataDate,
        'AND feature_set = ? AND horizon_days = ? AND sample_count > 0',
        [ML_PHYSICS_FEATURE_SET, horizon],
      ),
      payload: {
        expectedFrom: `ml_short_labels.max(date) for horizon ${horizon}`,
        featureSet: ML_PHYSICS_FEATURE_SET,
        horizonDays: horizon,
        latestEvaluationRunDate: physicsStatusEvaluationRunDate,
      },
    })
  }

  const checkDate = new Date().toISOString().slice(0, 10)
  await execBatch(checks.map((check) => ({
    sql: `
      INSERT OR REPLACE INTO ml_feature_health_checks
        (check_date, check_key, status, expected_date, actual_date, expected_count, actual_count, payload_json, computed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
    `,
    args: [
      checkDate,
      check.key,
      statusFor(check),
      check.expectedDate,
      check.actualDate,
      check.expectedCount,
      check.actualCount,
      JSON.stringify(check.payload ?? {}),
    ],
  })))

  const summary = checks.map((check) => `${check.key}=${statusFor(check)}(${check.actualDate ?? '-'} ${check.actualCount ?? '-'})`).join(', ')
  console.log(`ml feature health ${checkDate}: ${summary}`)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
