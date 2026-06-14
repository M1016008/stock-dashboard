// scripts/check-ml-freshness.ts
//
// Exit non-zero when ML feature/candidate dates lag behind the latest JP price
// date beyond configured thresholds. Intended for daily scheduler health checks.

import { execGet } from '@/lib/db/client'
import { ML_PHYSICS_FEATURE_SET } from '@/lib/backtest/ml-physics'

type DateRow = { date: string | null }

async function maxDate(sql: string, args: Array<string | number> = []): Promise<string | null> {
  return (await execGet<DateRow>(sql, args))?.date ?? null
}

function calendarGapDays(latest: string | null, current: string | null): number | null {
  if (!latest || !current) return null
  const a = new Date(`${latest}T00:00:00Z`).getTime()
  const b = new Date(`${current}T00:00:00Z`).getTime()
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  return Math.floor((a - b) / 86400000)
}

function statusFor(gap: number | null, warnDays: number, failDays: number): 'ok' | 'warn' | 'fail' | 'missing' {
  if (gap == null) return 'missing'
  if (gap >= failDays) return 'fail'
  if (gap >= warnDays) return 'warn'
  return 'ok'
}

async function main() {
  const warnDays = Number(process.env.ML_FRESHNESS_WARN_DAYS ?? 3)
  const failDays = Number(process.env.ML_FRESHNESS_FAIL_DAYS ?? 7)
  const priceDate = await maxDate(`SELECT MAX(date) AS date FROM ohlcv_daily`)
  const checks = [
    {
      key: 'daily_snapshots',
      date: await maxDate(`SELECT MAX(date) AS date FROM daily_snapshots`),
    },
    {
      key: 'model_features',
      date: await maxDate(`SELECT MAX(date) AS date FROM model_features`),
    },
    {
      key: 'ml_feature_vectors_v2.physics',
      date: await maxDate(
        `SELECT MAX(date) AS date FROM ml_feature_vectors_v2 WHERE feature_set = ?`,
        [ML_PHYSICS_FEATURE_SET],
      ),
    },
    {
      key: 'serving_ml_physics_candidates',
      date: await maxDate(`SELECT MAX(as_of_date) AS date FROM serving_ml_physics_candidates`),
    },
    {
      key: 'serving_current_similars',
      date: await maxDate(`SELECT MAX(as_of_date) AS date FROM serving_current_similars`),
    },
    {
      key: 'serving_ml_candidates',
      date: await maxDate(`SELECT MAX(as_of_date) AS date FROM serving_ml_candidates`),
    },
    {
      key: 'ml_predictions',
      date: await maxDate(`SELECT MAX(as_of_date) AS date FROM ml_predictions`),
    },
    {
      key: 'ml_feature_health_checks',
      date: await maxDate(`SELECT MAX(check_date) AS date FROM ml_feature_health_checks`),
    },
  ].map((check) => {
    const gapDays = calendarGapDays(priceDate, check.date)
    return {
      ...check,
      expectedDate: priceDate,
      gapDays,
      status: statusFor(gapDays, warnDays, failDays),
    }
  })

  const result = {
    priceDate,
    warnDays,
    failDays,
    checks,
  }
  console.log(JSON.stringify(result, null, 2))

  if (checks.some((check) => check.status === 'fail' || check.status === 'missing')) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error('[check-ml-freshness] failed:', error)
  process.exitCode = 1
})
