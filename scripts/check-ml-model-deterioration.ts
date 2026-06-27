// scripts/check-ml-model-deterioration.ts
//
// Compare the latest model/RL evaluation with recent historical evaluations and
// record deterioration warnings into ml_feature_health_checks.

import { execAll, execBatch, execGet } from '@/lib/db/client'

type Status = 'ok' | 'warn' | 'fail' | 'missing'

type Check = {
  key: string
  status: Status
  expectedDate: string | null
  actualDate: string | null
  expectedCount: number | null
  actualCount: number | null
  payload?: Record<string, unknown>
}

type ModelEvaluationRow = {
  modelName: string | null
  modelType: string
  direction: string
  horizonDays: number
  evaluationDate: string
  trainEndDate: string | null
  sampleCount: number
  precisionAt20: number | null
  precisionAt50: number | null
  precisionAt80: number | null
  hitRate: number | null
  medianReturnPct: number | null
  avgReturnPct: number | null
  maxDrawdownPct: number | null
  metricsJson: string
}

type RlEvaluationRow = {
  policyName: string
  policyType: string
  horizonDays: number
  evaluationDate: string
  endDate: string | null
  sampleCount: number
  winRate: number | null
  oracleMatchRate: number | null
  avgReward: number | null
  medianReward: number | null
  avgReturnPct: number | null
  maxDrawdownPct: number | null
  metricsJson: string
}

const BASELINE_LIMIT = intEnv('ML_MODEL_DETERIORATION_BASELINE_LIMIT', 6)
const WARN_DROP = numberEnv('ML_MODEL_DETERIORATION_WARN_DROP', 0.03)
const FAIL_DROP = numberEnv('ML_MODEL_DETERIORATION_FAIL_DROP', 0.08)
const WARN_DRAWDOWN_DROP = numberEnv('ML_MODEL_DRAWDOWN_WARN_DROP_PCT', 5)
const FAIL_DRAWDOWN_DROP = numberEnv('ML_MODEL_DRAWDOWN_FAIL_DROP_PCT', 10)
const WARN_SAMPLE_RATIO = numberEnv('ML_MODEL_SAMPLE_WARN_RATIO', 0.7)
const FAIL_SAMPLE_RATIO = numberEnv('ML_MODEL_SAMPLE_FAIL_RATIO', 0.5)
const STRICT = process.env.ML_MODEL_DETERIORATION_STRICT === '1'

function numberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function intEnv(name: string, fallback: number): number {
  return Math.max(1, Math.floor(numberEnv(name, fallback)))
}

function median(values: number[]): number | null {
  const clean = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
  if (clean.length === 0) return null
  const mid = Math.floor(clean.length / 2)
  return clean.length % 2 === 0 ? ((clean[mid - 1] ?? 0) + (clean[mid] ?? 0)) / 2 : clean[mid] ?? null
}

function safeJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function nestedNumber(value: unknown, path: string[]): number | null {
  let current: unknown = value
  for (const key of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return null
    current = (current as Record<string, unknown>)[key]
  }
  return typeof current === 'number' && Number.isFinite(current) ? current : null
}

function modelPrimaryMetric(row: ModelEvaluationRow): { name: string; value: number | null } {
  if (row.precisionAt50 != null) return { name: 'precision_at_50', value: row.precisionAt50 }
  if (row.precisionAt20 != null) return { name: 'precision_at_20', value: row.precisionAt20 }
  if (row.hitRate != null) return { name: 'hit_rate', value: row.hitRate }
  const metrics = safeJson(row.metricsJson)
  const accuracy = nestedNumber(metrics, ['accuracy'])
  if (accuracy != null) return { name: 'accuracy', value: accuracy }
  const top60 = nestedNumber(metrics, ['test', 'top60', 'hitRate'])
  if (top60 != null) return { name: 'test.top60.hitRate', value: top60 }
  return { name: 'missing', value: null }
}

function rlPrimaryMetric(row: RlEvaluationRow): { name: string; value: number | null } {
  if (row.avgReward != null) return { name: 'avg_reward', value: row.avgReward }
  if (row.oracleMatchRate != null) return { name: 'oracle_match_rate', value: row.oracleMatchRate }
  if (row.winRate != null) return { name: 'win_rate', value: row.winRate }
  return { name: 'missing', value: null }
}

function deteriorationStatus({
  latestMetric,
  baselineMetric,
  latestDrawdown,
  baselineDrawdown,
  latestSamples,
  baselineSamples,
}: {
  latestMetric: number | null
  baselineMetric: number | null
  latestDrawdown: number | null
  baselineDrawdown: number | null
  latestSamples: number
  baselineSamples: number | null
}): Status {
  if (latestMetric == null) return 'missing'
  let status: Status = 'ok'
  if (baselineMetric != null) {
    const drop = baselineMetric - latestMetric
    if (drop >= FAIL_DROP) status = 'fail'
    else if (drop >= WARN_DROP) status = 'warn'
  }
  if (baselineDrawdown != null && latestDrawdown != null) {
    const worseBy = baselineDrawdown - latestDrawdown
    if (worseBy >= FAIL_DRAWDOWN_DROP) status = 'fail'
    else if (worseBy >= WARN_DRAWDOWN_DROP && status === 'ok') status = 'warn'
  }
  if (baselineSamples != null && baselineSamples > 0) {
    const ratio = latestSamples / baselineSamples
    if (ratio < FAIL_SAMPLE_RATIO) status = 'fail'
    else if (ratio < WARN_SAMPLE_RATIO && status === 'ok') status = 'warn'
  }
  return status
}

function safeKey(value: string | null | undefined): string {
  return (value ?? 'unknown').replace(/[^a-zA-Z0-9_.-]+/g, '_').slice(0, 80)
}

async function latestModelEvaluations(): Promise<ModelEvaluationRow[]> {
  return execAll<ModelEvaluationRow>(
    `
      SELECT
        e.model_name AS modelName,
        e.model_type AS modelType,
        e.direction,
        e.horizon_days AS horizonDays,
        e.evaluation_date AS evaluationDate,
        e.train_end_date AS trainEndDate,
        e.sample_count AS sampleCount,
        e.precision_at_20 AS precisionAt20,
        e.precision_at_50 AS precisionAt50,
        e.precision_at_80 AS precisionAt80,
        e.hit_rate AS hitRate,
        e.median_return_pct AS medianReturnPct,
        e.avg_return_pct AS avgReturnPct,
        e.max_drawdown_pct AS maxDrawdownPct,
        e.metrics_json AS metricsJson
      FROM ml_model_evaluations e
      INNER JOIN (
        SELECT model_type, direction, horizon_days, MAX(evaluation_date) AS evaluation_date
        FROM ml_model_evaluations
        GROUP BY model_type, direction, horizon_days
      ) latest
        ON latest.model_type = e.model_type
       AND latest.direction = e.direction
       AND latest.horizon_days = e.horizon_days
       AND latest.evaluation_date = e.evaluation_date
      ORDER BY e.model_type, e.horizon_days, e.direction
    `,
  )
}

async function modelBaseline(row: ModelEvaluationRow): Promise<ModelEvaluationRow[]> {
  return execAll<ModelEvaluationRow>(
    `
      SELECT
        model_name AS modelName,
        model_type AS modelType,
        direction,
        horizon_days AS horizonDays,
        evaluation_date AS evaluationDate,
        train_end_date AS trainEndDate,
        sample_count AS sampleCount,
        precision_at_20 AS precisionAt20,
        precision_at_50 AS precisionAt50,
        precision_at_80 AS precisionAt80,
        hit_rate AS hitRate,
        median_return_pct AS medianReturnPct,
        avg_return_pct AS avgReturnPct,
        max_drawdown_pct AS maxDrawdownPct,
        metrics_json AS metricsJson
      FROM ml_model_evaluations
      WHERE model_type = ?
        AND direction = ?
        AND horizon_days = ?
        AND evaluation_date < ?
      ORDER BY evaluation_date DESC
      LIMIT ?
    `,
    [row.modelType, row.direction, row.horizonDays, row.evaluationDate, BASELINE_LIMIT],
  )
}

async function latestRlEvaluations(): Promise<RlEvaluationRow[]> {
  return execAll<RlEvaluationRow>(
    `
      SELECT
        e.policy_name AS policyName,
        e.policy_type AS policyType,
        e.horizon_days AS horizonDays,
        e.evaluation_date AS evaluationDate,
        e.end_date AS endDate,
        e.sample_count AS sampleCount,
        e.win_rate AS winRate,
        e.oracle_match_rate AS oracleMatchRate,
        e.avg_reward AS avgReward,
        e.median_reward AS medianReward,
        e.avg_return_pct AS avgReturnPct,
        e.max_drawdown_pct AS maxDrawdownPct,
        e.metrics_json AS metricsJson
      FROM ml_rl_policy_evaluations e
      INNER JOIN (
        SELECT policy_name, horizon_days, MAX(evaluation_date) AS evaluation_date
        FROM ml_rl_policy_evaluations
        GROUP BY policy_name, horizon_days
      ) latest
        ON latest.policy_name = e.policy_name
       AND latest.horizon_days = e.horizon_days
       AND latest.evaluation_date = e.evaluation_date
      ORDER BY e.policy_name, e.horizon_days
    `,
  )
}

async function rlBaseline(row: RlEvaluationRow): Promise<RlEvaluationRow[]> {
  return execAll<RlEvaluationRow>(
    `
      SELECT
        policy_name AS policyName,
        policy_type AS policyType,
        horizon_days AS horizonDays,
        evaluation_date AS evaluationDate,
        end_date AS endDate,
        sample_count AS sampleCount,
        win_rate AS winRate,
        oracle_match_rate AS oracleMatchRate,
        avg_reward AS avgReward,
        median_reward AS medianReward,
        avg_return_pct AS avgReturnPct,
        max_drawdown_pct AS maxDrawdownPct,
        metrics_json AS metricsJson
      FROM ml_rl_policy_evaluations
      WHERE policy_name = ?
        AND horizon_days = ?
        AND evaluation_date < ?
      ORDER BY evaluation_date DESC
      LIMIT ?
    `,
    [row.policyName, row.horizonDays, row.evaluationDate, BASELINE_LIMIT],
  )
}

async function modelChecks(): Promise<Check[]> {
  const latest = await latestModelEvaluations()
  const checks: Check[] = []
  for (const row of latest) {
    const baseline = await modelBaseline(row)
    const latestMetric = modelPrimaryMetric(row)
    const baselineValues = baseline
      .map((item) => modelPrimaryMetric(item).value)
      .filter((value): value is number => value != null && Number.isFinite(value))
    const baselineMetric = median(baselineValues)
    const baselineDrawdown = median(baseline.map((item) => item.maxDrawdownPct).filter((value): value is number => value != null && Number.isFinite(value)))
    const baselineSamples = median(baseline.map((item) => Number(item.sampleCount ?? 0)).filter((value) => value > 0))
    const status = baseline.length === 0
      ? 'ok'
      : deteriorationStatus({
          latestMetric: latestMetric.value,
          baselineMetric,
          latestDrawdown: row.maxDrawdownPct,
          baselineDrawdown,
          latestSamples: Number(row.sampleCount ?? 0),
          baselineSamples,
        })
    checks.push({
      key: `model_deterioration.${safeKey(row.modelType)}.${safeKey(row.direction)}.h${row.horizonDays}`,
      status,
      expectedDate: baseline[0]?.evaluationDate ?? row.evaluationDate,
      actualDate: row.evaluationDate,
      expectedCount: baselineSamples == null ? null : Math.round(baselineSamples),
      actualCount: Number(row.sampleCount ?? 0),
      payload: {
        modelName: row.modelName,
        modelType: row.modelType,
        direction: row.direction,
        horizonDays: row.horizonDays,
        trainEndDate: row.trainEndDate,
        metricName: latestMetric.name,
        latestMetric: latestMetric.value,
        baselineMetric,
        metricDrop: baselineMetric != null && latestMetric.value != null ? baselineMetric - latestMetric.value : null,
        latestDrawdown: row.maxDrawdownPct,
        baselineDrawdown,
        baselineDates: baseline.map((item) => item.evaluationDate),
        thresholds: {
          warnDrop: WARN_DROP,
          failDrop: FAIL_DROP,
          warnDrawdownDropPct: WARN_DRAWDOWN_DROP,
          failDrawdownDropPct: FAIL_DRAWDOWN_DROP,
          warnSampleRatio: WARN_SAMPLE_RATIO,
          failSampleRatio: FAIL_SAMPLE_RATIO,
        },
      },
    })
  }
  if (checks.length === 0) {
    checks.push({
      key: 'model_deterioration.ml_model_evaluations',
      status: 'missing',
      expectedDate: null,
      actualDate: null,
      expectedCount: null,
      actualCount: 0,
      payload: { reason: 'ml_model_evaluations has no rows' },
    })
  }
  return checks
}

async function rlChecks(): Promise<Check[]> {
  const latest = await latestRlEvaluations()
  const checks: Check[] = []
  for (const row of latest) {
    const baseline = await rlBaseline(row)
    const latestMetric = rlPrimaryMetric(row)
    const baselineValues = baseline
      .map((item) => rlPrimaryMetric(item).value)
      .filter((value): value is number => value != null && Number.isFinite(value))
    const baselineMetric = median(baselineValues)
    const baselineDrawdown = median(baseline.map((item) => item.maxDrawdownPct).filter((value): value is number => value != null && Number.isFinite(value)))
    const baselineSamples = median(baseline.map((item) => Number(item.sampleCount ?? 0)).filter((value) => value > 0))
    const status = baseline.length === 0
      ? 'ok'
      : deteriorationStatus({
          latestMetric: latestMetric.value,
          baselineMetric,
          latestDrawdown: row.maxDrawdownPct,
          baselineDrawdown,
          latestSamples: Number(row.sampleCount ?? 0),
          baselineSamples,
        })
    checks.push({
      key: `model_deterioration.rl.${safeKey(row.policyName)}.h${row.horizonDays}`,
      status,
      expectedDate: baseline[0]?.evaluationDate ?? row.evaluationDate,
      actualDate: row.evaluationDate,
      expectedCount: baselineSamples == null ? null : Math.round(baselineSamples),
      actualCount: Number(row.sampleCount ?? 0),
      payload: {
        policyName: row.policyName,
        policyType: row.policyType,
        horizonDays: row.horizonDays,
        endDate: row.endDate,
        metricName: latestMetric.name,
        latestMetric: latestMetric.value,
        baselineMetric,
        metricDrop: baselineMetric != null && latestMetric.value != null ? baselineMetric - latestMetric.value : null,
        latestDrawdown: row.maxDrawdownPct,
        baselineDrawdown,
        baselineDates: baseline.map((item) => item.evaluationDate),
      },
    })
  }
  return checks
}

async function saveChecks(checks: Check[]): Promise<void> {
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
      check.status,
      check.expectedDate,
      check.actualDate,
      check.expectedCount,
      check.actualCount,
      JSON.stringify(check.payload ?? {}),
    ],
  })))
}

async function main() {
  const checks = [...(await modelChecks()), ...(await rlChecks())]
  await saveChecks(checks)

  const warnings = checks.filter((check) => check.status === 'warn' || check.status === 'fail' || check.status === 'missing')
  console.log(`ml model deterioration check: checks=${checks.length}, warnings=${warnings.length}`)
  for (const check of warnings) {
    console.warn(`- ${check.key}: ${check.status}`)
  }
  if (STRICT && warnings.some((check) => check.status === 'fail' || check.status === 'missing')) {
    process.exitCode = 1
  }

  const latestRun = await execGet<{ date: string | null }>(
    `SELECT MAX(check_date) AS date FROM ml_feature_health_checks WHERE check_key LIKE 'model_deterioration.%'`,
  )
  console.log(`ml model deterioration check saved: ${latestRun?.date ?? '-'}`)
}

main().catch((error) => {
  console.error('[check-ml-model-deterioration] failed:', error)
  process.exitCode = 1
})
