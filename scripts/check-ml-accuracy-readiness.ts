// scripts/check-ml-accuracy-readiness.ts
//
// Prediction-quality guardrails. This records whether the currently served ML
// stack is trained from the intended full-history window, covers all standard
// horizons, and avoids common model/feature mismatches.

import { execAll, execBatch, execGet, execRun } from '@/lib/db/client'
import { ML_PHYSICS_FEATURE_SET, ML_PHYSICS_MODEL_TYPE } from '@/lib/backtest/ml-physics'

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

type ModelRow = {
  modelType: string
  direction: string
  horizonDays: number
  modelName: string
  trainedAt: number
  metricsJson: string | null
}

const REQUIRED_HORIZONS = (process.env.ML_ACCURACY_REQUIRED_HORIZONS ?? '5,10,20,40,60,90')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0)
const FULL_HISTORY_START = process.env.ML_ACCURACY_FULL_START_DATE?.trim()
  || process.env.ML_FULL_START_DATE?.trim()
  || process.env.US_ML_FULL_START_DATE?.trim()
  || '1900-01-01'
const STRICT = process.env.ML_ACCURACY_STRICT === '1'

function safeJson(value: string | null): Record<string, unknown> {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function statusFromCoverage(actual: number, expected: number): Status {
  if (expected <= 0) return actual > 0 ? 'ok' : 'missing'
  const ratio = actual / expected
  if (ratio < 0.85) return 'fail'
  if (ratio < 0.95) return 'warn'
  return 'ok'
}

async function tableExists(table: string): Promise<boolean> {
  const row = await execGet<{ count: number }>(
    `SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?`,
    [table],
  )
  return Number(row?.count ?? 0) > 0
}

async function maxDate(table: string, column = 'date', where = '', args: Array<string | number> = []): Promise<string | null> {
  if (!await tableExists(table)) return null
  return (await execGet<{ date: string | null }>(
    `SELECT MAX(${column}) AS date FROM ${table} ${where}`,
    args,
  ))?.date ?? null
}

async function minDate(table: string, column = 'date', where = '', args: Array<string | number> = []): Promise<string | null> {
  if (!await tableExists(table)) return null
  return (await execGet<{ date: string | null }>(
    `SELECT MIN(${column}) AS date FROM ${table} ${where}`,
    args,
  ))?.date ?? null
}

async function countRows(sql: string, args: Array<string | number> = []): Promise<number> {
  return Number((await execGet<{ count: number }>(sql, args))?.count ?? 0)
}

async function ensureHealthTable(): Promise<void> {
  await execRun(`
    CREATE TABLE IF NOT EXISTS ml_feature_health_checks (
      check_date TEXT NOT NULL,
      check_key TEXT NOT NULL,
      status TEXT NOT NULL,
      expected_date TEXT,
      actual_date TEXT,
      expected_count INTEGER,
      actual_count INTEGER,
      payload_json TEXT NOT NULL DEFAULT '{}',
      computed_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (check_date, check_key)
    )
  `)
}

async function collectCoverageChecks(priceDate: string | null, oldestPriceDate: string | null): Promise<Check[]> {
  const checks: Check[] = []
  const latestClassicFeature = await maxDate('ml_feature_vectors')
  const latestPhysicsFeature = await maxDate('ml_feature_vectors_v2', 'date', 'WHERE feature_set = ?', [ML_PHYSICS_FEATURE_SET])
  const oldestClassicFeature = await minDate('ml_feature_vectors')
  const oldestPhysicsFeature = await minDate('ml_feature_vectors_v2', 'date', 'WHERE feature_set = ?', [ML_PHYSICS_FEATURE_SET])
  const expectedSnapshotCount = priceDate && await tableExists('daily_snapshots')
    ? await countRows(`SELECT COUNT(*) AS count FROM daily_snapshots WHERE date = ?`, [priceDate])
    : 0

  for (const check of [
    {
      key: 'accuracy_readiness.ml_feature_vectors_latest',
      actualDate: latestClassicFeature,
      oldestDate: oldestClassicFeature,
      countTable: 'ml_feature_vectors',
      countWhere: '',
      args: [] as Array<string | number>,
    },
    {
      key: 'accuracy_readiness.ml_feature_vectors_v2_latest',
      actualDate: latestPhysicsFeature,
      oldestDate: oldestPhysicsFeature,
      countTable: 'ml_feature_vectors_v2',
      countWhere: 'AND feature_set = ?',
      args: [ML_PHYSICS_FEATURE_SET] as Array<string | number>,
    },
  ]) {
    const actualCount = check.actualDate
      ? await countRows(
          `SELECT COUNT(*) AS count FROM ${check.countTable} WHERE date = ? ${check.countWhere}`,
          [check.actualDate, ...check.args],
        )
      : 0
    checks.push({
      key: check.key,
      status: check.actualDate === priceDate ? statusFromCoverage(actualCount, expectedSnapshotCount) : 'warn',
      expectedDate: priceDate,
      actualDate: check.actualDate,
      expectedCount: expectedSnapshotCount,
      actualCount,
      payload: {
        oldestPriceDate,
        oldestFeatureDate: check.oldestDate,
        fullHistoryStart: FULL_HISTORY_START,
      },
    })
  }
  return checks
}

async function collectForwardExtremaChecks(): Promise<Check[]> {
  if (!await tableExists('forward_extrema')) {
    return [{
      key: 'accuracy_readiness.forward_extrema',
      status: 'missing',
      expectedDate: null,
      actualDate: null,
      expectedCount: REQUIRED_HORIZONS.length,
      actualCount: 0,
      payload: { requiredHorizons: REQUIRED_HORIZONS },
    }]
  }
  const rows = await execAll<{ horizonDays: number; minDate: string | null; maxDate: string | null; count: number }>(
    `
      SELECT horizon_days AS horizonDays, MIN(date) AS minDate, MAX(date) AS maxDate, COUNT(*) AS count
      FROM forward_extrema
      WHERE horizon_days IN (${REQUIRED_HORIZONS.map(() => '?').join(', ')})
      GROUP BY horizon_days
      ORDER BY horizon_days
    `,
    REQUIRED_HORIZONS,
  )
  const present = new Set(rows.map((row) => row.horizonDays))
  const missing = REQUIRED_HORIZONS.filter((horizon) => !present.has(horizon))
  const latest = rows.map((row) => row.maxDate).filter((value): value is string => !!value).sort().at(-1) ?? null
  const oldest = rows.map((row) => row.minDate).filter((value): value is string => !!value).sort()[0] ?? null
  const count = rows.reduce((sum, row) => sum + Number(row.count ?? 0), 0)
  return [{
    key: 'accuracy_readiness.forward_extrema_horizons',
    status: missing.length > 0 ? 'fail' : 'ok',
    expectedDate: FULL_HISTORY_START,
    actualDate: oldest,
    expectedCount: REQUIRED_HORIZONS.length,
    actualCount: present.size,
    payload: {
      requiredHorizons: REQUIRED_HORIZONS,
      missingHorizons: missing,
      latestDate: latest,
      rows: count,
    },
  }]
}

async function latestModels(modelType: string): Promise<ModelRow[]> {
  if (!await tableExists('ml_models')) return []
  return execAll<ModelRow>(
    `
      SELECT
        m.model_type AS modelType,
        m.direction,
        m.horizon_days AS horizonDays,
        m.model_name AS modelName,
        m.trained_at AS trainedAt,
        m.metrics_json AS metricsJson
      FROM ml_models m
      INNER JOIN (
        SELECT model_type, direction, horizon_days, MAX(trained_at) AS trained_at
        FROM ml_models
        WHERE model_type = ?
        GROUP BY model_type, direction, horizon_days
      ) latest
        ON latest.model_type = m.model_type
       AND latest.direction = m.direction
       AND latest.horizon_days = m.horizon_days
       AND latest.trained_at = m.trained_at
      WHERE m.model_type = ?
      ORDER BY m.horizon_days, m.direction
    `,
    [modelType, modelType],
  )
}

function collectModelChecks(modelType: string, rows: ModelRow[], directions: string[]): Check[] {
  const checks: Check[] = []
  const byKey = new Map(rows.map((row) => [`${row.horizonDays}:${row.direction}`, row]))
  for (const horizon of REQUIRED_HORIZONS) {
    for (const direction of directions) {
      const row = byKey.get(`${horizon}:${direction}`)
      if (!row) {
        checks.push({
          key: `accuracy_readiness.model.${modelType}.h${horizon}.${direction}`,
          status: 'missing',
          expectedDate: FULL_HISTORY_START,
          actualDate: null,
          expectedCount: 1,
          actualCount: 0,
          payload: { modelType, horizonDays: horizon, direction },
        })
        continue
      }
      const metrics = safeJson(row.metricsJson)
      const trainStartDate = asString(metrics.trainStartDate)
      const trainRows = asNumber(metrics.trainRows) ?? asNumber(metrics.samples) ?? 0
      const mode = asString(metrics.mode)
      const fullHistoryMode = mode === 'all_paged' || mode === 'all_paged_multi'
      checks.push({
        key: `accuracy_readiness.model.${modelType}.h${horizon}.${direction}`,
        status: fullHistoryMode && trainStartDate && trainStartDate <= FULL_HISTORY_START && trainRows > 0 ? 'ok' : 'warn',
        expectedDate: FULL_HISTORY_START,
        actualDate: trainStartDate,
        expectedCount: 1,
        actualCount: trainRows > 0 ? 1 : 0,
        payload: {
          modelName: row.modelName,
          modelType,
          horizonDays: horizon,
          direction,
          mode,
          trainRows,
          trainEndDate: metrics.trainEndDate ?? null,
          accuracy: metrics.accuracy ?? null,
          positiveRate: metrics.positiveRate ?? null,
        },
      })
    }
  }
  return checks
}

async function collectServingChecks(): Promise<Check[]> {
  const checks: Check[] = []
  if (await tableExists('serving_ml_candidates')) {
    const latestDate = await maxDate('serving_ml_candidates', 'as_of_date')
    const badModels = latestDate
      ? await countRows(
          `
            SELECT COUNT(*) AS count
            FROM serving_ml_candidates
            WHERE as_of_date = ?
              AND model_name NOT LIKE 'ma_stage_%'
              AND model_name != 'heuristic_fallback'
          `,
          [latestDate],
        )
      : 0
    checks.push({
      key: 'accuracy_readiness.serving_ml_candidates_model_type',
      status: badModels > 0 ? 'fail' : latestDate ? 'ok' : 'missing',
      expectedDate: latestDate,
      actualDate: latestDate,
      expectedCount: 0,
      actualCount: badModels,
      payload: { rule: 'serving_ml_candidates should use ma_stage or heuristic fallback models' },
    })
  }
  if (await tableExists('serving_ml_physics_candidates')) {
    const latestDate = await maxDate('serving_ml_physics_candidates', 'as_of_date')
    const horizonCount = latestDate
      ? await countRows(
          `
            SELECT COUNT(DISTINCT horizon_days) AS count
            FROM serving_ml_physics_candidates
            WHERE as_of_date = ?
              AND horizon_days IN (${REQUIRED_HORIZONS.map(() => '?').join(', ')})
          `,
          [latestDate, ...REQUIRED_HORIZONS],
        )
      : 0
    checks.push({
      key: 'accuracy_readiness.serving_ml_physics_candidates_horizons',
      status: horizonCount >= REQUIRED_HORIZONS.length ? 'ok' : 'warn',
      expectedDate: latestDate,
      actualDate: latestDate,
      expectedCount: REQUIRED_HORIZONS.length,
      actualCount: horizonCount,
      payload: { requiredHorizons: REQUIRED_HORIZONS },
    })
  }
  return checks
}

async function main(): Promise<void> {
  await ensureHealthTable()
  const priceDate = await maxDate('ohlcv_daily')
  const oldestPriceDate = await minDate('ohlcv_daily')
  const checks = [
    ...await collectCoverageChecks(priceDate, oldestPriceDate),
    ...await collectForwardExtremaChecks(),
    ...collectModelChecks('logistic_regression_v1', await latestModels('logistic_regression_v1'), ['up', 'down']),
    ...collectModelChecks(ML_PHYSICS_MODEL_TYPE, await latestModels(ML_PHYSICS_MODEL_TYPE), ['up', 'down', 'wait']),
    ...await collectServingChecks(),
  ]

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

  const summary = checks.map((check) => `${check.key}=${check.status}`).join(', ')
  console.log(`ml accuracy readiness ${checkDate}: ${summary}`)
  if (STRICT && checks.some((check) => check.status === 'fail' || check.status === 'missing')) {
    process.exit(2)
  }
}

main().catch((error) => {
  console.error('check-ml-accuracy-readiness failed:', error)
  process.exit(1)
})
