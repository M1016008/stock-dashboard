// scripts/run-ml-serving-fast.ts
//
// Fast JP daily ML serving refresh.
// Daily jobs should publish current serving data, not retrain or relabel
// historical datasets. Full training/governance remains in the weekly job.

import { spawn, type ChildProcess } from 'node:child_process'
import { execGet } from '@/lib/db/client'
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
    FROM ohlcv_daily o
    WHERE o.date = ?
      AND (SELECT COUNT(*) FROM ohlcv_daily h WHERE h.ticker = o.ticker) >= ?
      AND NOT EXISTS (
        SELECT 1
        FROM ml_feature_vectors_v2 f
        WHERE f.feature_set = ?
          AND f.ticker = o.ticker
          AND f.date = o.date
      )
    `,
    [priceDate, minHistoryDays, ML_PHYSICS_FEATURE_SET],
  )
  return Number(row?.count ?? 0)
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
  await fillMissingModelFeatures(priceDate)
  await runRequired('batch:ml-candidates')
  await runRequired('batch:ml-predict')
  await fillMissingPhysicsFeatures(priceDate)
  await runRequired('batch:ml-physics-candidates', {
    ML_PHYSICS_HORIZONS: process.env.ML_PHYSICS_HORIZONS ?? ML_PRIMARY_HORIZON_LIST,
  })
  await runRequired('batch:ml-insights')
  await runRequired('batch:historical-universe')
  await runRequired('batch:ml-feature-health', {
    ML_FEATURE_HEALTH_STRICT: '1',
    ML_FEATURE_HEALTH_STRICT_SCOPE: 'serving',
  })
  await runRequired('ml:freshness-check')
  await runRequired('batch:dashboard-cache')

  console.log(`fast ML serving refresh complete: priceDate=${priceDate}`)
}

main().catch((error) => {
  console.error('Fatal:', error)
  process.exit(1)
})
