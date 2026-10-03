// scripts/review-ml-feature-label-design.ts
//
// Weekly ML governance audit for feature/label design.
// This does not rewrite labels or features. It records objective warnings into
// ml_feature_health_checks so the site can surface stale, partial, imbalanced,
// or schema-drifted ML inputs before they silently affect rankings.

import { execAll, execBatch, execGet } from '@/lib/db/client'
import {
  ML_PHYSICS_FEATURE_NAMES,
  ML_PHYSICS_FEATURE_SET,
  ML_PHYSICS_VERSION,
} from '@/lib/backtest/ml-physics'

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

type LabelDateRow = {
  horizonDays: number
  date: string | null
}

type LabelStatsRow = {
  count: number
  upRate: number | null
  downRate: number | null
  waitRate: number | null
  nullReturnRate: number | null
  avgLongReward: number | null
  avgShortReward: number | null
  avgWaitReward: number | null
}

const COVERAGE_WARN = numberEnv('ML_DESIGN_REVIEW_COVERAGE_WARN', 0.95)
const COVERAGE_FAIL = numberEnv('ML_DESIGN_REVIEW_COVERAGE_FAIL', 0.85)
const LABEL_MIN_COUNT = numberEnv('ML_DESIGN_REVIEW_LABEL_MIN_COUNT', 1000)
const LABEL_MIN_CLASS_RATE = numberEnv('ML_DESIGN_REVIEW_LABEL_MIN_CLASS_RATE', 0.03)
const LABEL_MAX_CLASS_RATE = numberEnv('ML_DESIGN_REVIEW_LABEL_MAX_CLASS_RATE', 0.82)

function numberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

async function maxDate(sql: string, args: Array<string | number> = []): Promise<string | null> {
  return (await execGet<{ date: string | null }>(sql, args))?.date ?? null
}

async function count(sql: string, args: Array<string | number> = []): Promise<number> {
  return Number((await execGet<{ count: number }>(sql, args))?.count ?? 0)
}

function coverageStatus(actual: number | null, expected: number | null): Status {
  if (!actual || !expected) return 'missing'
  const ratio = actual / Math.max(1, expected)
  if (ratio < COVERAGE_FAIL) return 'fail'
  if (ratio < COVERAGE_WARN) return 'warn'
  return 'ok'
}

function labelStatus(stats: LabelStatsRow | null): Status {
  if (!stats || stats.count <= 0) return 'missing'
  if (stats.count < LABEL_MIN_COUNT) return 'warn'
  const classRates = [stats.upRate, stats.downRate, stats.waitRate]
    .filter((value): value is number => value != null && Number.isFinite(value))
  if (classRates.length === 0) return 'missing'
  if (classRates.some((rate) => rate < LABEL_MIN_CLASS_RATE || rate > LABEL_MAX_CLASS_RATE)) return 'warn'
  if ((stats.nullReturnRate ?? 0) > 0.02) return 'warn'
  return 'ok'
}

function dimensionStatus(lengths: Map<number, number>, expectedLength: number): Status {
  if (lengths.size === 0) return 'missing'
  if (lengths.size > 1) return 'fail'
  const [onlyLength] = [...lengths.keys()]
  return onlyLength === expectedLength ? 'ok' : 'fail'
}

function safeJsonVectorLength(value: string | null): number | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.length : null
  } catch {
    return null
  }
}

async function collectVectorDimensionCheck(featureDate: string | null): Promise<Check> {
  const expectedLength = ML_PHYSICS_FEATURE_NAMES.length
  const rows = featureDate
    ? await execAll<{ vector_json: string | null }>(
        `
          SELECT vector_json
          FROM ml_feature_vectors_v2
          WHERE feature_set = ? AND date = ?
          LIMIT 500
        `,
        [ML_PHYSICS_FEATURE_SET, featureDate],
      )
    : []
  const lengths = new Map<number, number>()
  let invalid = 0
  for (const row of rows) {
    const length = safeJsonVectorLength(row.vector_json)
    if (length == null) {
      invalid += 1
      continue
    }
    lengths.set(length, (lengths.get(length) ?? 0) + 1)
  }
  const status = invalid > 0 ? 'fail' : dimensionStatus(lengths, expectedLength)
  return {
    key: 'weekly_design_review.physics_vector_dimensions',
    status,
    expectedDate: featureDate,
    actualDate: featureDate,
    expectedCount: expectedLength,
    actualCount: lengths.size === 1 ? [...lengths.keys()][0] ?? null : null,
    payload: {
      featureSet: ML_PHYSICS_FEATURE_SET,
      featureVersion: ML_PHYSICS_VERSION,
      expectedFeatureNames: expectedLength,
      sampledRows: rows.length,
      invalidRows: invalid,
      observedLengths: Object.fromEntries(lengths),
    },
  }
}

async function collectFeatureCoverageCheck(priceDate: string | null): Promise<Check> {
  const featureDate = await maxDate(
    `SELECT MAX(date) AS date FROM ml_feature_vectors_v2 WHERE feature_set = ?`,
    [ML_PHYSICS_FEATURE_SET],
  )
  const expectedCount = priceDate
    ? await count(`SELECT COUNT(*) AS count FROM daily_snapshots WHERE date = ?`, [priceDate])
    : 0
  const actualCount = featureDate
    ? await count(
        `SELECT COUNT(*) AS count FROM ml_feature_vectors_v2 WHERE feature_set = ? AND date = ?`,
        [ML_PHYSICS_FEATURE_SET, featureDate],
      )
    : 0
  return {
    key: 'weekly_design_review.physics_feature_coverage',
    status: featureDate === priceDate ? coverageStatus(actualCount, expectedCount) : 'warn',
    expectedDate: priceDate,
    actualDate: featureDate,
    expectedCount,
    actualCount,
    payload: {
      featureSet: ML_PHYSICS_FEATURE_SET,
      minCoverageWarn: COVERAGE_WARN,
      minCoverageFail: COVERAGE_FAIL,
    },
  }
}

async function collectLabelChecks(): Promise<Check[]> {
  const rows = await execAll<LabelDateRow>(
    `
      SELECT horizon_days AS horizonDays, MAX(date) AS date
      FROM ml_short_labels
      GROUP BY horizon_days
      ORDER BY horizon_days
    `,
  )
  const checks: Check[] = []
  for (const row of rows) {
    const stats = row.date
      ? await execGet<LabelStatsRow>(
          `
            SELECT
              COUNT(*) AS count,
              AVG(up_label) AS upRate,
              AVG(down_label) AS downRate,
              AVG(wait_label) AS waitRate,
              AVG(CASE WHEN return_pct IS NULL THEN 1.0 ELSE 0.0 END) AS nullReturnRate,
              AVG(reward_long) AS avgLongReward,
              AVG(reward_short) AS avgShortReward,
              AVG(reward_wait) AS avgWaitReward
            FROM ml_short_labels
            WHERE horizon_days = ? AND date = ?
          `,
          [row.horizonDays, row.date],
        )
      : null
    const featureJoinCount = row.date
      ? await count(
          `
            SELECT COUNT(*) AS count
            FROM ml_short_labels l
            INNER JOIN ml_feature_vectors_v2 f
              ON f.ticker = l.ticker
             AND f.date = l.date
             AND f.feature_set = ?
            WHERE l.horizon_days = ? AND l.date = ?
          `,
          [ML_PHYSICS_FEATURE_SET, row.horizonDays, row.date],
        )
      : 0
    const labelCount = Number(stats?.count ?? 0)
    checks.push({
      key: `weekly_design_review.short_label_balance_h${row.horizonDays}`,
      status: labelStatus(stats ?? null),
      expectedDate: row.date,
      actualDate: row.date,
      expectedCount: LABEL_MIN_COUNT,
      actualCount: labelCount,
      payload: {
        horizonDays: row.horizonDays,
        upRate: stats?.upRate ?? null,
        downRate: stats?.downRate ?? null,
        waitRate: stats?.waitRate ?? null,
        nullReturnRate: stats?.nullReturnRate ?? null,
        avgLongReward: stats?.avgLongReward ?? null,
        avgShortReward: stats?.avgShortReward ?? null,
        avgWaitReward: stats?.avgWaitReward ?? null,
        minClassRate: LABEL_MIN_CLASS_RATE,
        maxClassRate: LABEL_MAX_CLASS_RATE,
      },
    })
    checks.push({
      key: `weekly_design_review.feature_label_join_h${row.horizonDays}`,
      status: coverageStatus(featureJoinCount, labelCount),
      expectedDate: row.date,
      actualDate: row.date,
      expectedCount: labelCount,
      actualCount: featureJoinCount,
      payload: {
        horizonDays: row.horizonDays,
        featureSet: ML_PHYSICS_FEATURE_SET,
        minCoverageWarn: COVERAGE_WARN,
        minCoverageFail: COVERAGE_FAIL,
      },
    })
  }
  if (checks.length === 0) {
    checks.push({
      key: 'weekly_design_review.short_labels',
      status: 'missing',
      expectedDate: null,
      actualDate: null,
      expectedCount: null,
      actualCount: 0,
      payload: { reason: 'ml_short_labels has no rows' },
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
  const priceDate = await maxDate(`SELECT MAX(date) AS date FROM ohlcv_daily`)
  const featureCoverage = await collectFeatureCoverageCheck(priceDate)
  const vectorDimensions = await collectVectorDimensionCheck(featureCoverage.actualDate)
  const labelChecks = await collectLabelChecks()
  const checks = [featureCoverage, vectorDimensions, ...labelChecks]
  await saveChecks(checks)

  const summary = checks.map((check) => `${check.key}=${check.status}`).join(', ')
  console.log(`ml feature/label design review: ${summary}`)
  const warnings = checks.filter((check) => check.status !== 'ok')
  if (warnings.length > 0) {
    console.warn(`ml feature/label design review warnings=${warnings.length}`)
    for (const warning of warnings) {
      console.warn(`- ${warning.key}: ${warning.status}`)
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('[review-ml-feature-label-design] failed:', error)
    process.exit(1)
  })
