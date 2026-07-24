// scripts/update-latest.ts
//
// サイト表示に必要な最新日付を保つためのオーケストレーター。
// J-Quants 差分取得 → スナップショット計算を、重複起動しないようロックして順番に実行する。

import { spawn } from 'node:child_process'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { batchRuns } from '@/lib/db/schema'
import { getDataFreshness } from '@/lib/server/data-freshness'
import { acquireExclusiveUpdateLock } from '@/lib/server/update-lock'
import { waitForMemoryHeadroom, withMemoryGuardEnv } from '@/lib/system/memory-guard'

type RunResult = {
  code: number | null
  signal: NodeJS.Signals | null
}

type EnvOverrides = Record<string, string | undefined>
type Heartbeat = () => Promise<void>

async function runScript(script: string, envOverrides: EnvOverrides = {}, heartbeat?: Heartbeat): Promise<RunResult> {
  await waitForMemoryHeadroom({ label: script })
  return new Promise((resolve, reject) => {
    // The child is the active SQLite writer. Keep the parent out of the DB
    // until the child exits; manual heartbeats run between pipeline steps.
    void heartbeat
    const timeoutMinutes = Number(
      envOverrides.UPDATE_CHILD_TIMEOUT_MINUTES
      ?? process.env.UPDATE_CHILD_TIMEOUT_MINUTES
      ?? '75',
    )
    let timedOut = false
    const child = spawn('npx', ['tsx', '--env-file=.env.local', script], {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: withMemoryGuardEnv({
        ...process.env,
        USE_LOCAL_DB: '1',
        BACKTEST_RECENT_DAYS: process.env.BACKTEST_RECENT_DAYS ?? '0',
        ...envOverrides,
      }),
    })

    const timeoutTimer = Number.isFinite(timeoutMinutes) && timeoutMinutes > 0
      ? setTimeout(() => {
          timedOut = true
          console.error(`${script} timed out after ${timeoutMinutes} minutes; sending SIGTERM`)
          child.kill('SIGTERM')
          setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
          }, 10_000)
        }, timeoutMinutes * 60_000)
      : null

    const clearTimers = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer)
    }

    child.on('close', (code, signal) => {
      clearTimers()
      resolve({ code: timedOut ? 124 : code, signal })
    })
    child.on('error', (err) => {
      clearTimers()
      reject(err)
    })
  })
}

async function runRequired(script: string, envOverrides: EnvOverrides = {}, heartbeat?: Heartbeat) {
  console.log(`\n▶ ${script}`)
  const result = await runScript(script, envOverrides, heartbeat)
  if (result.code !== 0) {
    throw new Error(`${script} failed: code=${result.code}, signal=${result.signal ?? 'none'}`)
  }
}

async function runOptional(
  label: string,
  script: string,
  envOverrides: EnvOverrides = {},
  heartbeat?: Heartbeat,
): Promise<string | null> {
  try {
    await runRequired(script, {
      UPDATE_CHILD_TIMEOUT_MINUTES:
        process.env.UPDATE_OPTIONAL_CHILD_TIMEOUT_MINUTES
        ?? envOverrides.UPDATE_CHILD_TIMEOUT_MINUTES
        ?? '30',
      ...envOverrides,
    }, heartbeat)
    return null
  } catch (err) {
    const message = `${label}: ${errorMessage(err)}`
    console.error(`Optional refresh failed: ${message}`)
    return message
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function currentJstHour(): number {
  const hour = Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Tokyo',
      hour: '2-digit',
      hour12: false,
    }).format(new Date()),
  )
  return Number.isFinite(hour) ? hour % 24 : new Date().getHours()
}

async function main() {
  const runStartedJstHour = currentJstHour()
  const configuredLockLeaseSeconds = Number(process.env.UPDATE_LATEST_LOCK_SECONDS)
  const lockLeaseSeconds = Number.isFinite(configuredLockLeaseSeconds) && configuredLockLeaseSeconds > 0
    ? Math.max(60 * 60, configuredLockLeaseSeconds)
    : 3 * 60 * 60
  const lock = await acquireExclusiveUpdateLock('update_latest', lockLeaseSeconds)
  if (!lock) {
    console.log('Latest data update skipped: update_latest lock is already active')
    return
  }

  const [run] = await db
    .insert(batchRuns)
    .values({
      jobType: 'update_latest',
      startedAt: new Date(),
      status: 'running',
    })
    .returning({ id: batchRuns.id })

  const runId = run.id
  let rowsInserted = 0
  const optionalErrors: string[] = []
  const heartbeat = () => lock.heartbeat()
  const refreshAfterOhlcvEnv: EnvOverrides = {
    REFRESH_AFTER_OHLCV_SKIP_LOCK: '1',
    REFRESH_AFTER_OHLCV_CRITICAL_ONLY: '1',
    UPDATE_CHILD_TIMEOUT_MINUTES: process.env.REFRESH_AFTER_OHLCV_TIMEOUT_MINUTES ?? '180',
  }

  try {
    console.log('Latest data update started')

    const listedInfoError = await runOptional('listed-info', 'scripts/batch-listed-info.ts', {}, heartbeat)
    if (listedInfoError) optionalErrors.push(listedInfoError)
    await lock.heartbeat()

    const before = await getDataFreshness()
    console.log('Freshness before:', before)

    if (before.needsOhlcvUpdate) {
      await runRequired('scripts/batch-ohlcv.ts', { POST_OHLCV_REFRESH: '0' }, heartbeat)
      await lock.heartbeat()
      await runRequired('scripts/refresh-after-ohlcv.ts', refreshAfterOhlcvEnv, heartbeat)
      await lock.heartbeat()
    } else if (
      before.needsSnapshotUpdate
      || before.needsPhysicalMomentumUpdate
      || before.needsFeatureUpdate
      || before.needsModelFeatureUpdate
      || before.needsDashboardCacheUpdate
    ) {
      await runRequired('scripts/refresh-after-ohlcv.ts', refreshAfterOhlcvEnv, heartbeat)
      await lock.heartbeat()
    } else {
      console.log('Critical market data is already fresh')
    }

    await runRequired('scripts/build-dashboard-cache.ts', {}, heartbeat)
    await lock.heartbeat()

    const analogIndexError = await runOptional(
      'analog-sequence-index',
      'scripts/build-analog-sequence-index.ts',
      {
        ANALOG_INDEX_MARKET: 'JP',
        ANALOG_INDEX_MODE: 'incremental',
        UPDATE_CHILD_TIMEOUT_MINUTES: process.env.ANALOG_INDEX_DAILY_TIMEOUT_MINUTES ?? '30',
      },
      heartbeat,
    )
    if (analogIndexError) optionalErrors.push(analogIndexError)
    await lock.heartbeat()

    const afterCritical = await getDataFreshness()
    console.log('Critical freshness after:', afterCritical)
    if (
      afterCritical.needsOhlcvUpdate
      || afterCritical.needsSnapshotUpdate
      || afterCritical.needsPhysicalMomentumUpdate
      || afterCritical.needsFeatureUpdate
      || afterCritical.needsModelFeatureUpdate
      || afterCritical.needsDashboardCacheUpdate
    ) {
      throw new Error('Critical market data refresh did not reach the expected trading date')
    }

    const optionalAfterHour = Number(process.env.UPDATE_LATEST_OPTIONAL_AFTER_HOUR ?? '0')
    const beforeOptionalWindow = Number.isFinite(optionalAfterHour)
      && optionalAfterHour > 0
      && runStartedJstHour < optionalAfterHour
    if (process.env.UPDATE_LATEST_CRITICAL_ONLY === '1' || beforeOptionalWindow) {
      const reason = beforeOptionalWindow
        ? `scheduled heavy refresh window starts at ${optionalAfterHour}:00 JST (run started at ${runStartedJstHour}:xx)`
        : 'UPDATE_LATEST_CRITICAL_ONLY=1'
      console.log(`Optional market data and ML refresh skipped (${reason})`)
    } else {
      const optionalScripts: Array<[string, string, EnvOverrides]> = [
        ['indices', 'scripts/batch-indices.ts', {}],
        ['earnings-calendar', 'scripts/batch-earnings.ts', {}],
        ['earnings-history', 'scripts/batch-earnings-history.ts', { EARNINGS_HISTORY_LIMIT: process.env.EARNINGS_HISTORY_LIMIT ?? '40' }],
        ['credit-short', 'scripts/batch-credit-short.ts', {}],
        ['serving-margin', 'scripts/build-serving-margin.ts', {}],
        ['forward-extrema', 'scripts/batch-forward-extrema.ts', {
          FORWARD_EXTREMA_HORIZONS:
            process.env.UPDATE_LATEST_FORWARD_EXTREMA_HORIZONS
            ?? process.env.ML_PHYSICS_EXTREMA_HORIZONS
            ?? '5,10,15,20,30,40,60,90,180,200',
          BACKTEST_RECENT_DAYS: process.env.UPDATE_LATEST_FORWARD_EXTREMA_RECENT_DAYS ?? process.env.BACKTEST_RECENT_DAYS ?? '60',
          FORWARD_EXTREMA_START_DATE: process.env.ML_FULL_START_DATE ?? '1900-01-01',
        }],
        ['serving-backtest', 'scripts/build-serving-backtest.ts', {}],
        ['serving-stock', 'scripts/build-serving-stock.ts', {}],
      ]

      for (const [label, script, env] of optionalScripts) {
        if (label === 'serving-backtest' && process.env.SKIP_SERVING_BACKTEST === '1') {
          console.log('serving-backtest skipped (SKIP_SERVING_BACKTEST=1)')
          continue
        }
        const error = await runOptional(label, script, env, heartbeat)
        if (error) optionalErrors.push(error)
        await lock.heartbeat()
      }

      if (process.env.BACKTEST_REBUILD_STATS === '1') {
        const error = await runOptional('signal-stats', 'scripts/batch-signal-stats.ts', {}, heartbeat)
        if (error) optionalErrors.push(error)
        await lock.heartbeat()
      } else {
        console.log('Backtest signal_stats rebuild skipped (set BACKTEST_REBUILD_STATS=1 for full/stat refresh)')
      }

      if (process.env.SKIP_DAILY_ML === '1' || process.env.UPDATE_LATEST_RUN_DAILY_ML !== '1') {
        console.log('Daily ML refresh skipped by update-latest. Use npm run batch:ml-learning-daily for the scheduled early-morning ML serving refresh, or set UPDATE_LATEST_RUN_DAILY_ML=1 for a manual combined run.')
      } else {
        try {
          await runRequired('scripts/batch-ml-features.ts', {
            ML_RECENT_DAYS: process.env.ML_DAILY_RECENT_DAYS ?? '5',
            ML_MIN_HISTORY_DAYS: process.env.ML_DAILY_MIN_HISTORY_DAYS ?? '220',
            ML_START_DATE: process.env.ML_FULL_START_DATE ?? '1900-01-01',
          }, heartbeat)
          await lock.heartbeat()
          await runRequired('scripts/batch-ml-labels.ts', {}, heartbeat)
          await lock.heartbeat()
          await runRequired('scripts/batch-ml-outcomes.ts', {}, heartbeat)
          await lock.heartbeat()
          await runRequired('scripts/batch-ml-train.ts', {
            ML_TRAIN_START_DATE: process.env.ML_DAILY_TRAIN_START_DATE ?? '1900-01-01',
            ML_TRAIN_SAMPLE_MODE: process.env.ML_DAILY_TRAIN_SAMPLE_MODE ?? 'all_paged',
            ML_TRAIN_LABEL_SOURCE: process.env.ML_DAILY_TRAIN_LABEL_SOURCE ?? 'extrema',
            ML_TRAIN_LIMIT: process.env.ML_DAILY_TRAIN_LIMIT ?? process.env.ML_TRAIN_LIMIT ?? '0',
          }, heartbeat)
          await lock.heartbeat()
          await runRequired('scripts/batch-ml-candidates.ts', {}, heartbeat)
          await lock.heartbeat()
          await runRequired('scripts/batch-ml-predict.ts', {}, heartbeat)
          await lock.heartbeat()
          if (process.env.ML_DAILY_EVALUATE === '1') {
            await runRequired('scripts/batch-ml-evaluate.ts', {}, heartbeat)
            await lock.heartbeat()
          } else {
            console.log('Daily ML walk-forward evaluation skipped (set ML_DAILY_EVALUATE=1 for weekly/manual evaluation)')
          }
          await runRequired('scripts/batch-ml-context-features.ts', {
            ML_CONTEXT_RECENT_DAYS: process.env.ML_CONTEXT_DAILY_RECENT_DAYS ?? '5',
            ML_CONTEXT_START_DATE: process.env.ML_FULL_START_DATE ?? '1900-01-01',
          }, heartbeat)
          await lock.heartbeat()
          await runRequired('scripts/batch-ml-physics-features.ts', {
            ML_PHYSICS_RECENT_DAYS: process.env.ML_PHYSICS_DAILY_RECENT_DAYS ?? '5',
            ML_PHYSICS_MIN_HISTORY_DAYS: process.env.ML_PHYSICS_DAILY_MIN_HISTORY_DAYS ?? '220',
            ML_PHYSICS_START_DATE: process.env.ML_FULL_START_DATE ?? '1900-01-01',
          }, heartbeat)
          await lock.heartbeat()
          await runRequired('scripts/batch-ml-short-labels.ts', {
            ML_SHORT_WRITE_RL_STATES: process.env.ML_SHORT_DAILY_WRITE_RL_STATES ?? '1',
          }, heartbeat)
          await lock.heartbeat()
          await runRequired('scripts/batch-ml-physics-train.ts', {
            ML_PHYSICS_TRAIN_START_DATE: process.env.ML_PHYSICS_DAILY_TRAIN_START_DATE ?? '1900-01-01',
            ML_PHYSICS_TRAIN_SAMPLE_MODE: process.env.ML_PHYSICS_DAILY_TRAIN_SAMPLE_MODE ?? 'all_paged',
            ML_PHYSICS_TRAIN_LIMIT: process.env.ML_PHYSICS_DAILY_TRAIN_LIMIT ?? process.env.ML_PHYSICS_TRAIN_LIMIT ?? '0',
          }, heartbeat)
          await lock.heartbeat()
          await runRequired('scripts/batch-ml-physics-candidates.ts', {}, heartbeat)
          await lock.heartbeat()
          await runRequired('scripts/build-serving-ml-insights.ts', {}, heartbeat)
          await lock.heartbeat()
          await runRequired('scripts/batch-ml-similarity-evaluate.ts', {}, heartbeat)
          await lock.heartbeat()
          await runRequired('scripts/batch-ml-rl-policy.ts', {}, heartbeat)
          await lock.heartbeat()
          await runRequired('scripts/build-historical-universe.ts', {}, heartbeat)
          await lock.heartbeat()
          await runRequired('scripts/batch-ml-feature-health.ts', {}, heartbeat)
          await lock.heartbeat()
          if (process.env.ML_PHYSICS_DAILY_EVALUATE === '1') {
            await runRequired('scripts/batch-ml-physics-evaluate.ts', {}, heartbeat)
            await lock.heartbeat()
          } else {
            console.log('Daily ML physics walk-forward evaluation skipped (set ML_PHYSICS_DAILY_EVALUATE=1 for weekly/manual evaluation)')
          }
        } catch (err) {
          const mlError = `daily-ml: ${errorMessage(err)}`
          optionalErrors.push(mlError)
          console.error('Daily ML refresh failed; dashboard freshness is already protected:', mlError)
        }
      }
    }

    await runRequired('scripts/build-dashboard-cache.ts', {}, heartbeat)
    await lock.heartbeat()

    const after = await getDataFreshness()
    console.log('Freshness after:', after)
    rowsInserted = Number(after.latestSnapshotDate !== before.latestSnapshotDate)

    await db
      .update(batchRuns)
      .set({
        finishedAt: new Date(),
        status: after.needsUpdate || optionalErrors.length > 0 ? 'partial' : 'success',
        succeeded: 1,
        failed: optionalErrors.length,
        rowsInserted,
        errorSummary: after.needsUpdate || optionalErrors.length > 0
          ? JSON.stringify({ freshness: after.needsUpdate ? after : null, optionalErrors })
          : null,
      })
      .where(eq(batchRuns.id, runId))
  } catch (err) {
    await db
      .update(batchRuns)
      .set({
        finishedAt: new Date(),
        status: 'failed',
        failed: 1,
        errorSummary: errorMessage(err),
      })
      .where(eq(batchRuns.id, runId))
    throw err
  } finally {
    await lock.release()
  }
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
