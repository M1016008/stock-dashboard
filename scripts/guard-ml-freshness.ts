// scripts/guard-ml-freshness.ts
//
// Daily safety net for JP ML freshness. It detects stale/partial serving data
// against the latest price date and repairs only the missing lightweight pieces.

import { spawn } from 'node:child_process'
import { execAll, execGet, execRun } from '@/lib/db/client'
import { ML_PHYSICS_FEATURE_SET } from '@/lib/backtest/ml-physics'
import { acquireUpdateLock, getActiveUpdateLocks } from '@/lib/server/update-lock'

type DateCount = {
  date: string | null
  count: number | null
}

type FreshnessCheck = {
  key: string
  date: string | null
  count: number | null
  status: 'ok' | 'stale' | 'partial' | 'missing'
  reason: string | null
}

type RunResult = {
  code: number | null
  signal: NodeJS.Signals | null
}

type LockRow = {
  job_type: string
  owner: string | null
  heartbeat_at: number
}

const JOB_TYPE = 'ml_freshness_guard'
const BLOCKING_LOCKS = ['update_latest', 'post_ohlcv_refresh', 'ml_learning', 'us_update_latest']
const MIN_COVERAGE_PCT = Number(process.env.ML_FRESHNESS_MIN_COVERAGE_PCT ?? 0.85)
const MIN_PHYSICS_CANDIDATES = Number(process.env.ML_FRESHNESS_MIN_PHYSICS_CANDIDATES ?? 600)
const DRY_RUN = process.env.DRY_RUN === '1'
const REPAIR = process.env.ML_FRESHNESS_GUARD_REPAIR !== '0'
const STALE_LOCK_MINUTES = envNumber('ML_FRESHNESS_STALE_LOCK_MINUTES', 30)

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function pidFromOwner(owner: string | null): number | null {
  const raw = owner?.split(':')[1]
  const pid = Number(raw)
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function maxDate(sql: string, args: Array<string | number> = []): Promise<string | null> {
  return (await execGet<{ date: string | null }>(sql, args))?.date ?? null
}

async function count(sql: string, args: Array<string | number> = []): Promise<number | null> {
  const row = await execGet<{ count: number }>(sql, args)
  return row ? Number(row.count ?? 0) : null
}

async function priceDateCount(): Promise<DateCount> {
  const date = await maxDate(`SELECT MAX(date) AS date FROM ohlcv_daily`)
  return {
    date,
    count: date ? await count(`SELECT COUNT(*) AS count FROM ohlcv_daily WHERE date = ?`, [date]) : null,
  }
}

async function tableDateCount(table: string, dateColumn: string, date: string | null, where = '', args: Array<string | number> = []): Promise<DateCount> {
  return {
    date,
    count: date
      ? await count(`SELECT COUNT(*) AS count FROM ${table} WHERE ${dateColumn} = ? ${where}`, [date, ...args])
      : null,
  }
}

function classify(
  key: string,
  expectedDate: string | null,
  expectedCount: number | null,
  actual: DateCount,
  minRows?: number,
): FreshnessCheck {
  if (!expectedDate || !actual.date) {
    return { key, date: actual.date, count: actual.count, status: 'missing', reason: 'date missing' }
  }
  if (actual.date !== expectedDate) {
    return { key, date: actual.date, count: actual.count, status: 'stale', reason: `expected ${expectedDate}` }
  }
  if (minRows != null && Number(actual.count ?? 0) < minRows) {
    return { key, date: actual.date, count: actual.count, status: 'partial', reason: `rows ${actual.count ?? 0} < ${minRows}` }
  }
  if (expectedCount != null && actual.count != null && actual.count < Math.floor(expectedCount * MIN_COVERAGE_PCT)) {
    return {
      key,
      date: actual.date,
      count: actual.count,
      status: 'partial',
      reason: `coverage ${(actual.count / Math.max(1, expectedCount)).toFixed(2)} < ${MIN_COVERAGE_PCT}`,
    }
  }
  return { key, date: actual.date, count: actual.count, status: 'ok', reason: null }
}

async function collectChecks(): Promise<{ price: DateCount; checks: FreshnessCheck[] }> {
  const price = await priceDateCount()
  const priceDate = price.date
  const priceCount = price.count
  const [
    snapshotDate,
    modelFeatureDate,
    physicsFeatureDate,
    currentSimilarDate,
    physicsCandidateDate,
    mlCandidateDate,
    predictionDate,
  ] = await Promise.all([
    maxDate(`SELECT MAX(date) AS date FROM daily_snapshots`),
    maxDate(`SELECT MAX(date) AS date FROM model_features`),
    maxDate(`SELECT MAX(date) AS date FROM ml_feature_vectors_v2 WHERE feature_set = ?`, [ML_PHYSICS_FEATURE_SET]),
    maxDate(`SELECT MAX(as_of_date) AS date FROM serving_current_similars`),
    maxDate(`SELECT MAX(as_of_date) AS date FROM serving_ml_physics_candidates`),
    maxDate(`SELECT MAX(as_of_date) AS date FROM serving_ml_candidates`),
    maxDate(`SELECT MAX(as_of_date) AS date FROM ml_predictions`),
  ])

  const [snapshots, modelFeatures, physicsFeatures, currentSimilars, physicsCandidates, mlCandidates, predictions] = await Promise.all([
    tableDateCount('daily_snapshots', 'date', snapshotDate),
    tableDateCount('model_features', 'date', modelFeatureDate),
    tableDateCount('ml_feature_vectors_v2', 'date', physicsFeatureDate, 'AND feature_set = ?', [ML_PHYSICS_FEATURE_SET]),
    {
      date: currentSimilarDate,
      count: currentSimilarDate
        ? await count(`SELECT COUNT(DISTINCT base_ticker) AS count FROM serving_current_similars WHERE as_of_date = ?`, [currentSimilarDate])
        : null,
    },
    tableDateCount('serving_ml_physics_candidates', 'as_of_date', physicsCandidateDate),
    tableDateCount('serving_ml_candidates', 'as_of_date', mlCandidateDate),
    tableDateCount('ml_predictions', 'as_of_date', predictionDate),
  ])

  return {
    price,
    checks: [
      classify('daily_snapshots', priceDate, priceCount, snapshots),
      classify('model_features', priceDate, priceCount, modelFeatures),
      classify('ml_feature_vectors_v2.physics', priceDate, priceCount, physicsFeatures),
      classify('serving_current_similars', priceDate, priceCount, currentSimilars),
      classify('serving_ml_physics_candidates', priceDate, null, physicsCandidates, MIN_PHYSICS_CANDIDATES),
      classify('serving_ml_candidates', priceDate, null, mlCandidates, 2),
      classify('ml_predictions', priceDate, null, predictions, 2),
    ],
  }
}

function runNpm(script: string, extraEnv: Record<string, string> = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    console.log(`[ml-freshness-guard] npm run ${script}`)
    const child = spawn('npm', ['run', script], {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: {
        ...process.env,
        USE_LOCAL_DB: '1',
        SQLITE_BUSY_RETRIES: process.env.SQLITE_BUSY_RETRIES ?? '240',
        ...extraEnv,
      },
    })
    child.on('error', reject)
    child.on('close', (code, signal) => resolve({ code, signal }))
  })
}

async function runRequired(script: string, extraEnv: Record<string, string> = {}): Promise<void> {
  const result = await runNpm(script, extraEnv)
  if (result.code !== 0) {
    throw new Error(`${script} failed: code=${result.code}, signal=${result.signal ?? 'none'}`)
  }
}

function hasBad(checks: FreshnessCheck[], keys: string[]): boolean {
  return checks.some((check) => keys.includes(check.key) && check.status !== 'ok')
}

async function repair(checks: FreshnessCheck[]): Promise<string[]> {
  const actions: string[] = []
  if (!REPAIR || DRY_RUN) return actions

  if (hasBad(checks, ['daily_snapshots'])) {
    actions.push('batch:snapshots')
    await runRequired('batch:snapshots')
  }

  if (hasBad(checks, ['model_features', 'daily_snapshots'])) {
    actions.push('batch:ml-features')
    await runRequired('batch:ml-features', {
      ML_RECENT_DAYS: process.env.ML_RECENT_DAYS ?? '260',
      ML_MIN_HISTORY_DAYS: process.env.ML_MIN_HISTORY_DAYS ?? '200',
    })
  }

  if (hasBad(checks, ['serving_ml_candidates', 'ml_predictions', 'model_features', 'daily_snapshots'])) {
    actions.push('batch:ml-candidates')
    await runRequired('batch:ml-candidates')
    actions.push('batch:ml-predict')
    await runRequired('batch:ml-predict')
  }

  if (hasBad(checks, ['ml_feature_vectors_v2.physics', 'model_features', 'daily_snapshots'])) {
    actions.push('batch:ml-context-features')
    await runRequired('batch:ml-context-features', {
      ML_CONTEXT_RECENT_DAYS: process.env.ML_CONTEXT_RECENT_DAYS ?? '260',
    })
    actions.push('batch:ml-physics-features')
    await runRequired('batch:ml-physics-features', {
      ML_PHYSICS_RECENT_DAYS: process.env.ML_PHYSICS_RECENT_DAYS ?? '260',
      ML_PHYSICS_MIN_HISTORY_DAYS: process.env.ML_PHYSICS_MIN_HISTORY_DAYS ?? '220',
    })
  }

  if (hasBad(checks, ['serving_ml_physics_candidates', 'ml_feature_vectors_v2.physics', 'model_features', 'daily_snapshots'])) {
    actions.push('batch:ml-physics-candidates')
    await runRequired('batch:ml-physics-candidates', {
      ML_PHYSICS_HORIZONS: process.env.ML_PHYSICS_HORIZONS ?? '20,40,60,90',
    })
  }

  if (hasBad(checks, ['serving_current_similars', 'serving_ml_physics_candidates', 'ml_feature_vectors_v2.physics', 'model_features', 'daily_snapshots'])) {
    actions.push('batch:ml-insights')
    await runRequired('batch:ml-insights')
  }

  actions.push('batch:historical-universe')
  await runRequired('batch:historical-universe')
  actions.push('batch:ml-feature-health')
  await runRequired('batch:ml-feature-health')
  actions.push('ml:freshness-check')
  await runRequired('ml:freshness-check')

  return actions
}

async function clearStaleLocalLocks(jobTypes: readonly string[]): Promise<string[]> {
  const rows = await execAll<LockRow>(
    `
    SELECT job_type, owner, heartbeat_at
    FROM update_locks
    WHERE status = 'running'
      AND lease_expires_at > unixepoch()
      AND job_type IN (${jobTypes.map(() => '?').join(', ')})
    `,
    [...jobTypes],
  )
  const cutoff = nowSeconds() - STALE_LOCK_MINUTES * 60
  const cleared: string[] = []
  for (const row of rows) {
    const pid = pidFromOwner(row.owner)
    if (!pid || pidExists(pid) || row.heartbeat_at >= cutoff) continue
    if (!DRY_RUN) {
      await execRun(
        `
        UPDATE update_locks
        SET status = 'idle',
            owner = NULL,
            heartbeat_at = unixepoch(),
            lease_expires_at = unixepoch()
        WHERE job_type = ?
          AND owner = ?
          AND status = 'running'
        `,
        [row.job_type, row.owner],
      )
    }
    cleared.push(`${row.job_type}:pid=${pid}:heartbeat=${new Date(row.heartbeat_at * 1000).toISOString()}`)
  }
  return cleared
}

async function recordRun(status: string, startedAt: number, actions: string[], errorSummary: string | null): Promise<void> {
  await execRun(
    `
    INSERT INTO batch_runs (
      job_type,
      started_at,
      finished_at,
      status,
      total_tickers,
      succeeded,
      failed,
      rows_inserted,
      error_summary
    )
    VALUES (?, ?, unixepoch(), ?, ?, ?, ?, ?, ?)
    `,
    [
      JOB_TYPE,
      startedAt,
      status,
      actions.length,
      status === 'success' ? 1 : 0,
      status === 'success' ? 0 : 1,
      actions.length,
      errorSummary,
    ],
  )
}

async function main() {
  process.env.USE_LOCAL_DB = process.env.USE_LOCAL_DB ?? '1'
  process.env.SQLITE_BUSY_RETRIES = process.env.SQLITE_BUSY_RETRIES ?? '240'
  const startedAt = nowSeconds()
  const lock = await acquireUpdateLock(JOB_TYPE, envNumber('ML_FRESHNESS_GUARD_LOCK_SECONDS', 6 * 60 * 60))
  if (!lock) {
    console.log('[ml-freshness-guard] skipped: guard lock is already active')
    return
  }

  const heartbeat = setInterval(() => {
    lock.heartbeat().catch((error) => {
      console.warn(`[ml-freshness-guard] heartbeat failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }, 60_000)

  const actions: string[] = []
  try {
    actions.push('batch:cleanup-stale-runs')
    await runRequired('batch:cleanup-stale-runs', {
      STALE_BATCH_TTL_HOURS: process.env.STALE_BATCH_TTL_HOURS ?? '2',
    })

    const clearedLocks = await clearStaleLocalLocks(BLOCKING_LOCKS)
    if (clearedLocks.length > 0) {
      actions.push('clear-stale-update-locks')
      console.log(`[ml-freshness-guard] cleared stale local locks: ${clearedLocks.join(', ')}`)
    }

    const activeLocks = await getActiveUpdateLocks(BLOCKING_LOCKS)
    if (activeLocks.length > 0) {
      const summary = activeLocks.map((row) => `${row.jobType}@${new Date(row.heartbeatAt * 1000).toISOString()}`).join(', ')
      console.log(`[ml-freshness-guard] skipped: active writer/ML locks observed: ${summary}`)
      await recordRun('success', startedAt, actions, `skipped: active locks ${summary}`)
      return
    }

    const before = await collectChecks()
    console.log(JSON.stringify({ phase: 'before', repair: REPAIR, dryRun: DRY_RUN, price: before.price, checks: before.checks }, null, 2))
    const bad = before.checks.filter((check) => check.status !== 'ok')
    if (bad.length === 0) {
      actions.push('batch:ml-feature-health')
      await runRequired('batch:ml-feature-health')
      actions.push('ml:freshness-check')
      await runRequired('ml:freshness-check')
      await recordRun('success', startedAt, actions, 'fresh')
      console.log('[ml-freshness-guard] finished: fresh')
      return
    }

    actions.push(...await repair(before.checks))
    const after = await collectChecks()
    console.log(JSON.stringify({ phase: 'after', price: after.price, checks: after.checks }, null, 2))
    const remaining = after.checks.filter((check) => check.status !== 'ok')
    if (remaining.length > 0) {
      throw new Error(`ML freshness repair incomplete: ${remaining.map((check) => `${check.key}:${check.status}`).join(', ')}`)
    }
    await recordRun('success', startedAt, actions, `repaired: ${bad.map((check) => check.key).join(', ')}`)
    console.log('[ml-freshness-guard] finished: repaired')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await recordRun('failed', startedAt, actions, message)
    throw error
  } finally {
    clearInterval(heartbeat)
    await lock.release()
  }
}

main().catch((error) => {
  console.error('[ml-freshness-guard] failed:', error)
  process.exit(1)
})
