// scripts/run-ml-serving-fast.ts
//
// Fast JP daily ML serving refresh.
// Daily jobs should publish current serving data, not retrain or relabel
// historical datasets. Full training/governance remains in the weekly job.

import { spawn, type ChildProcess } from 'node:child_process'
import { execBatch, execGet } from '@/lib/db/client'
import { ML_PHYSICS_FEATURE_SET } from '@/lib/backtest/ml-physics'
import { ML_PRIMARY_HORIZON_LIST } from '@/lib/backtest/ml-horizons'
import { waitForMemoryHeadroom, withMemoryGuardEnv } from '@/lib/system/memory-guard'

type RunResult = {
  code: number | null
  signal: NodeJS.Signals | null
}

type DateRow = {
  date: string | null
}

type CountRow = {
  count: number
}

const FORCE_CURRENT_TICKERS_ENV = 'ML_DAILY_FORCE_CURRENT_TICKERS'

let activeChild: ChildProcess | null = null

function numberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

async function maxDate(table: string, column: string, where = ''): Promise<string | null> {
  const row = await execGet<DateRow>(`SELECT MAX(${column}) AS date FROM ${table} ${where}`)
  return row?.date ?? null
}

async function countMissingModelFeatures(priceDate: string, minHistoryDays: number): Promise<number> {
  const row = await execGet<CountRow>(
    `
    SELECT COUNT(*) AS count
    FROM ohlcv_daily o
    WHERE o.date = ?
      AND (SELECT COUNT(*) FROM ohlcv_daily h WHERE h.ticker = o.ticker) >= ?
      AND NOT EXISTS (
        SELECT 1
        FROM ml_feature_vectors f
        WHERE f.ticker = o.ticker AND f.date = o.date
      )
    `,
    [priceDate, minHistoryDays],
  )
  return Number(row?.count ?? 0)
}

async function countMissingPhysicsFeatures(priceDate: string, minHistoryDays: number): Promise<number> {
  const row = await execGet<CountRow>(
    `
    SELECT COUNT(*) AS count
    FROM daily_snapshots d
    WHERE d.date = ?
      AND (SELECT COUNT(*) FROM ohlcv_daily h WHERE h.ticker = d.ticker) >= ?
      AND NOT EXISTS (
        SELECT 1
        FROM ml_feature_vectors_v2 f
        WHERE f.feature_set = ?
          AND f.ticker = d.ticker
          AND f.date = d.date
      )
    `,
    [priceDate, minHistoryDays, ML_PHYSICS_FEATURE_SET],
  )
  return Number(row?.count ?? 0)
}

function forcedCurrentTickers(): string[] {
  const value = process.env[FORCE_CURRENT_TICKERS_ENV]?.trim()
  if (!value) return []
  const tickers = [...new Set(value.split(',').map((ticker) => ticker.trim()).filter(Boolean))]
  if (tickers.length === 0 || tickers.length > 5_000 || tickers.some((ticker) => !/^[0-9A-Z]{4,5}$/.test(ticker))) {
    throw new Error(`${FORCE_CURRENT_TICKERS_ENV} must contain 1..5000 unique four- or five-character JP ticker codes`)
  }
  if (process.env.STOCKBOARD_PARENT_UPDATE_LOCK_JOB_TYPE !== 'db_maintenance'
      || !process.env.STOCKBOARD_PARENT_UPDATE_LOCK_OWNER?.trim()) {
    throw new Error(`${FORCE_CURRENT_TICKERS_ENV} requires an inherited db_maintenance lease`)
  }
  return tickers
}

async function invalidateCurrentServingFeatures(priceDate: string, tickers: string[]): Promise<void> {
  if (tickers.length === 0) return
  const statements: Array<{ sql: string; args: string[] }> = []
  for (let offset = 0; offset < tickers.length; offset += 400) {
    const chunk = tickers.slice(offset, offset + 400)
    const placeholders = chunk.map(() => '?').join(',')
    statements.push({
      sql: `DELETE FROM ml_feature_vectors WHERE date = ? AND ticker IN (${placeholders})`,
      args: [priceDate, ...chunk],
    })
    statements.push({
      sql: `DELETE FROM ml_feature_vectors_v2
            WHERE date = ? AND feature_set = ? AND ticker IN (${placeholders})`,
      args: [priceDate, ML_PHYSICS_FEATURE_SET, ...chunk],
    })
  }
  await execBatch(statements)

  const remainingClassic = await countCurrentRows('ml_feature_vectors', priceDate, tickers)
  const remainingPhysics = await countCurrentRows('ml_feature_vectors_v2', priceDate, tickers, true)
  if (remainingClassic !== 0 || remainingPhysics !== 0) {
    throw new Error(`forced current feature invalidation was incomplete: classic=${remainingClassic}, physics=${remainingPhysics}`)
  }
  console.log(`invalidated current serving features for ${tickers.length} approved repair tickers`)
}

async function countCurrentRows(
  table: 'ml_feature_vectors' | 'ml_feature_vectors_v2',
  priceDate: string,
  tickers: string[],
  physics = false,
): Promise<number> {
  let count = 0
  for (let offset = 0; offset < tickers.length; offset += 400) {
    const chunk = tickers.slice(offset, offset + 400)
    const placeholders = chunk.map(() => '?').join(',')
    const row = await execGet<CountRow>(
      `SELECT COUNT(*) AS count FROM ${table}
       WHERE date = ? ${physics ? 'AND feature_set = ?' : ''}
         AND ticker IN (${placeholders})`,
      physics ? [priceDate, ML_PHYSICS_FEATURE_SET, ...chunk] : [priceDate, ...chunk],
    )
    count += Number(row?.count ?? 0)
  }
  return count
}

function runNpm(script: string, extraEnv: Record<string, string> = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    console.log(`\n▶ npm run ${script}`)
    activeChild = spawn('npm', ['run', script], {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: withMemoryGuardEnv({
        ...process.env,
        USE_LOCAL_DB: '1',
        SQLITE_BUSY_RETRIES: process.env.SQLITE_BUSY_RETRIES ?? '12',
        ...extraEnv,
      }),
    })
    activeChild.on('error', reject)
    activeChild.on('close', (code, signal) => {
      activeChild = null
      resolve({ code, signal })
    })
  })
}

async function runRequired(script: string, extraEnv: Record<string, string> = {}): Promise<void> {
  await waitForMemoryHeadroom({ label: `npm run ${script}` })
  const result = await runNpm(script, extraEnv)
  if (result.code !== 0) {
    throw new Error(`${script} failed: code=${result.code}, signal=${result.signal ?? 'none'}`)
  }
}

async function ensureSnapshotsFresh(priceDate: string): Promise<void> {
  const snapshotDate = await maxDate('daily_snapshots', 'date')
  if (snapshotDate === priceDate) {
    console.log(`daily_snapshots already fresh: ${snapshotDate}`)
    return
  }
  await runRequired('batch:snapshots')
}

async function fillMissingModelFeatures(priceDate: string): Promise<void> {
  const minHistoryDays = numberEnv('ML_DAILY_MIN_HISTORY_DAYS', 220)
  const maxPasses = numberEnv('ML_DAILY_FEATURE_MAX_PASSES', 20)
  const tickerLimit = String(numberEnv('ML_DAILY_FEATURE_TICKER_LIMIT', 750))

  for (let pass = 1; pass <= maxPasses; pass += 1) {
    const missing = await countMissingModelFeatures(priceDate, minHistoryDays)
    console.log(`model feature missing latest: ${missing} (pass ${pass}/${maxPasses})`)
    if (missing <= 0) return
    await runRequired('batch:ml-features', {
      ML_RECENT_DAYS: process.env.ML_DAILY_FAST_FEATURE_RECENT_DAYS ?? '1',
      ML_MIN_HISTORY_DAYS: String(minHistoryDays),
      ML_START_DATE: process.env.ML_FULL_START_DATE ?? '1900-01-01',
      ML_MISSING_ONLY_DATE: 'latest',
      ML_TICKER_LIMIT: tickerLimit,
    })
  }

  const remaining = await countMissingModelFeatures(priceDate, minHistoryDays)
  if (remaining > 0) throw new Error(`model feature missing latest remains after ${maxPasses} passes: ${remaining}`)
}

async function fillMissingPhysicsFeatures(priceDate: string): Promise<void> {
  const minHistoryDays = numberEnv('ML_PHYSICS_DAILY_MIN_HISTORY_DAYS', 220)
  const maxPasses = numberEnv('ML_DAILY_PHYSICS_MAX_PASSES', 20)
  const tickerLimit = String(numberEnv('ML_DAILY_PHYSICS_TICKER_LIMIT', 500))

  for (let pass = 1; pass <= maxPasses; pass += 1) {
    const missing = await countMissingPhysicsFeatures(priceDate, minHistoryDays)
    console.log(`physics feature missing latest: ${missing} (pass ${pass}/${maxPasses})`)
    if (missing <= 0) return
    await runRequired('batch:ml-physics-features', {
      ML_PHYSICS_RECENT_DAYS: process.env.ML_DAILY_FAST_PHYSICS_RECENT_DAYS ?? '1',
      ML_PHYSICS_MIN_HISTORY_DAYS: String(minHistoryDays),
      ML_PHYSICS_HISTORY_LOOKBACK_DAYS: process.env.ML_PHYSICS_DAILY_HISTORY_LOOKBACK_DAYS ?? '520',
      ML_PHYSICS_START_DATE: process.env.ML_FULL_START_DATE ?? '1900-01-01',
      ML_PHYSICS_MISSING_ONLY_DATE: 'latest',
      ML_PHYSICS_TICKER_LIMIT: tickerLimit,
    })
  }

  const remaining = await countMissingPhysicsFeatures(priceDate, minHistoryDays)
  if (remaining > 0) throw new Error(`physics feature missing latest remains after ${maxPasses} passes: ${remaining}`)
}

async function refreshDailyRlAndPhysicsStatus(priceDate: string): Promise<void> {
  const policyDate = await maxDate('ml_rl_policy_evaluations', 'evaluation_date')
  if (!policyDate || policyDate < priceDate) {
    await runRequired('batch:ml-short-labels', {
      ML_SHORT_HORIZONS: process.env.ML_SHORT_HORIZONS ?? ML_PRIMARY_HORIZON_LIST,
      ML_SHORT_LABEL_RECENT_DAYS: process.env.ML_SHORT_LABEL_RECENT_DAYS ?? process.env.ML_DAILY_RL_RECENT_DAYS ?? '60',
      ML_SHORT_LABEL_START_DATE: process.env.ML_FULL_START_DATE ?? '1900-01-01',
      ML_SHORT_WRITE_RL_STATES: '1',
    })
    await runRequired('batch:ml-rl-policy', {
      ML_RL_HORIZONS: process.env.ML_RL_HORIZONS ?? ML_PRIMARY_HORIZON_LIST,
      ML_RL_RECENT_DAYS: process.env.ML_RL_RECENT_DAYS ?? process.env.ML_DAILY_RL_RECENT_DAYS ?? '60',
      ML_RL_START_DATE: process.env.ML_FULL_START_DATE ?? '1900-01-01',
    })
  }

  if (process.env.ML_DAILY_REFRESH_PHYSICS_STATUS !== '0') {
    await runRequired('batch:ml-physics-status-evaluate', {
      ML_PHYSICS_STATUS_HORIZONS: process.env.ML_PHYSICS_STATUS_HORIZONS ?? ML_PRIMARY_HORIZON_LIST,
      ML_PHYSICS_STATUS_RECENT_DAYS: process.env.ML_PHYSICS_STATUS_RECENT_DAYS ?? process.env.ML_DAILY_STATUS_RECENT_DAYS ?? '60',
      ML_PHYSICS_STATUS_START_DATE: process.env.ML_FULL_START_DATE ?? '1900-01-01',
    })
  }
}

async function rebuildRepairHistory(priceDate: string, repairTickers: string[]): Promise<void> {
  if (repairTickers.length === 0) return
  const fromDate = process.env.ML_DAILY_HISTORY_RECOMPUTE_FROM_DATE?.trim()
  if (!fromDate || !/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || fromDate > priceDate) {
    throw new Error('repair mode requires a valid ML_DAILY_HISTORY_RECOMPUTE_FROM_DATE at or before the price date')
  }
  await runRequired('batch:ml-features', {
    ML_START_DATE: fromDate,
    ML_END_DATE: priceDate,
    ML_RECENT_DAYS: '0',
    ML_MIN_HISTORY_DAYS: process.env.ML_DAILY_MIN_HISTORY_DAYS ?? '220',
    ML_FEATURE_INCREMENTAL_UPSERT: '1',
    ML_FEATURE_WRITE_LABELS: '0',
    ML_FEATURE_WRITE_RL_STATES: '0',
  })
  await runRequired('batch:ml-physics-features', {
    ML_PHYSICS_START_DATE: fromDate,
    ML_PHYSICS_END_DATE: priceDate,
    ML_PHYSICS_RECENT_DAYS: '0',
    ML_PHYSICS_MIN_HISTORY_DAYS: process.env.ML_PHYSICS_DAILY_MIN_HISTORY_DAYS ?? '220',
    ML_PHYSICS_INCREMENTAL_UPSERT: '1',
    ML_PHYSICS_HISTORY_LOOKBACK_DAYS: process.env.ML_PHYSICS_DAILY_HISTORY_LOOKBACK_DAYS ?? '520',
  })
}

function installSignalHandlers(): void {
  const stop = (signal: NodeJS.Signals) => {
    console.error(`Received ${signal}; stopping fast ML serving child process`)
    activeChild?.kill('SIGTERM')
    setTimeout(() => {
      if (activeChild && activeChild.exitCode === null && activeChild.signalCode === null) activeChild.kill('SIGKILL')
    }, 10_000)
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}

async function main(): Promise<void> {
  installSignalHandlers()
  process.env.USE_LOCAL_DB = process.env.USE_LOCAL_DB ?? '1'
  process.env.SQLITE_BUSY_RETRIES = process.env.SQLITE_BUSY_RETRIES ?? '12'

  const priceDate = await maxDate('ohlcv_daily', 'date')
  if (!priceDate) throw new Error('ohlcv_daily has no price date')
  console.log(`fast ML serving refresh start: priceDate=${priceDate}`)

  await runRequired('batch:ml-pipeline-state', {
    ML_PIPELINE_ACTION: 'verify-or-adopt',
    ML_PIPELINE_MARKET: 'JP',
  })
  await runRequired('batch:cleanup-stale-runs', {
    STALE_BATCH_TTL_HOURS: process.env.ML_STALE_BATCH_TTL_HOURS ?? '1',
  })
  await ensureSnapshotsFresh(priceDate)
  await runRequired('batch:physical-momentum', {
    PMS_RECENT_DAYS: process.env.PMS_DAILY_RECENT_DAYS ?? '30',
  })
  await runRequired('batch:ml-context-features', {
    ML_CONTEXT_RECENT_DAYS: process.env.ML_CONTEXT_DAILY_RECENT_DAYS ?? '5',
    ML_CONTEXT_START_DATE: process.env.ML_FULL_START_DATE ?? '1900-01-01',
  })
  const repairTickers = forcedCurrentTickers()
  await rebuildRepairHistory(priceDate, repairTickers)
  await invalidateCurrentServingFeatures(priceDate, repairTickers)
  await fillMissingModelFeatures(priceDate)
  await runRequired('batch:ml-candidates')
  await runRequired('batch:ml-predict')
  await fillMissingPhysicsFeatures(priceDate)
  await runRequired('batch:ml-physics-candidates', {
    ML_PHYSICS_HORIZONS: process.env.ML_PHYSICS_HORIZONS ?? ML_PRIMARY_HORIZON_LIST,
  })
  await runRequired('batch:ml-insights')
  if (repairTickers.length > 0) {
    if (process.env.ML_DAILY_REFRESH_PHYSICS_STATUS !== '0') {
      throw new Error('repair mode requires ML_DAILY_REFRESH_PHYSICS_STATUS=0')
    }
    console.log('repair mode: sealed RL/physics research refresh is disabled')
  } else {
    await refreshDailyRlAndPhysicsStatus(priceDate)
  }
  await runRequired('batch:historical-universe')
  await runRequired('batch:ml-feature-health', {
    ML_FEATURE_HEALTH_STRICT: '1',
    ML_FEATURE_HEALTH_STRICT_SCOPE: process.env.ML_DAILY_HEALTH_SCOPE ?? 'serving',
  })
  await runRequired('ml:freshness-check')
  await runRequired('batch:dashboard-cache')
  await runRequired('batch:ml-pipeline-state', {
    ML_PIPELINE_ACTION: 'mark-delta',
    ML_PIPELINE_MARKET: 'JP',
  })

  console.log(`fast ML serving refresh complete: priceDate=${priceDate}`)
}

main().catch((error) => {
  console.error('Fatal:', error)
  process.exit(1)
})
