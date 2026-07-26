// scripts/update-us-latest.ts
//
// Tiingo US EODの差分取得から、US用スナップショット・分析DB・日次ML更新までを
// ローカルMacのlaunchdで安全に回すためのオーケストレーター。

import { execFileSync, spawn } from 'node:child_process'
import { execGet } from '@/lib/db/client'
import { execUsAnalyticsGet } from '@/lib/db/us-analytics'
import { acquireExclusiveUpdateLock } from '@/lib/server/update-lock'
import { expectedLatestUsTradingDate } from '@/lib/server/us-data-freshness'
import { waitForMemoryHeadroom, withMemoryGuardEnv } from '@/lib/system/memory-guard'
import { US_ADJUSTED_PRICE_BASIS } from '@/lib/us-adjusted-ohlcv'
import { usInvestableSymbolSql } from '@/lib/us-symbol-quality'

type RunResult = {
  code: number | null
  signal: NodeJS.Signals | null
}

type EnvOverrides = Record<string, string | undefined>
type Heartbeat = () => Promise<void>

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function numberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function hasActiveHeavyMlProcess(): boolean {
  if (process.env.US_UPDATE_IGNORE_ACTIVE_ML === '1') return false
  try {
    const output = execFileSync('pgrep', ['-fl', [
      'batch:us-ml-full',
      'batch:ml-full',
      'batch-forward-extrema',
      'batch-ml-features',
      'batch-ml-physics-features',
      'batch-ml-short-labels',
      'batch-ml-physics-train',
    ].join('|')], { encoding: 'utf8' })
    return output
      .split('\n')
      .filter(Boolean)
      .some((line) => !line.includes('update-us-latest'))
  } catch {
    return false
  }
}

async function latestUsOhlcvDate(): Promise<string | null> {
  const row = await execGet<{ date: string | null }>(
    `SELECT date
     FROM market_ohlcv_daily INDEXED BY market_ohlcv_market_date_idx
     WHERE market = 'US'
     ORDER BY date DESC
     LIMIT 1`,
  )
  return row?.date ?? null
}

async function usOhlcvCoverage(date: string): Promise<{ universe: number; covered: number; coveragePct: number }> {
  const row = await execGet<{ universe: number; covered: number }>(
    `SELECT
       COUNT(*) AS universe,
       SUM(CASE WHEN o.ticker IS NOT NULL THEN 1 ELSE 0 END) AS covered
     FROM market_universe u INDEXED BY market_universe_market_active_idx
     LEFT JOIN market_ohlcv_daily o INDEXED BY market_ohlcv_market_date_ticker_idx
       ON o.market = 'US' AND o.date = ? AND o.ticker = u.ticker
     WHERE u.market = 'US'
       AND u.active = 1
       AND ${usInvestableSymbolSql('u.ticker')}`,
    [date],
  )
  const universe = Number(row?.universe ?? 0)
  const covered = Number(row?.covered ?? 0)
  return {
    universe,
    covered,
    coveragePct: universe > 0 ? 100 * covered / universe : 0,
  }
}

async function usSnapshotCoverage(date: string): Promise<{ universe: number; covered: number; coveragePct: number }> {
  const row = await execGet<{ universe: number; covered: number }>(
    `SELECT
       COUNT(*) AS universe,
       SUM(CASE WHEN s.ticker IS NOT NULL THEN 1 ELSE 0 END) AS covered
     FROM market_universe u INDEXED BY market_universe_market_active_idx
     INNER JOIN market_ohlcv_daily current INDEXED BY market_ohlcv_market_date_ticker_idx
       ON current.market = 'US' AND current.date = ? AND current.ticker = u.ticker
     LEFT JOIN market_daily_snapshots s INDEXED BY market_snapshots_market_date_ticker_idx
       ON s.market = 'US' AND s.date = ? AND s.ticker = u.ticker
     WHERE u.market = 'US'
       AND u.active = 1
       AND ${usInvestableSymbolSql('u.ticker')}
       AND EXISTS (
         SELECT 1
         FROM market_ohlcv_daily history INDEXED BY market_ohlcv_market_ticker_date_idx
         WHERE history.market = 'US' AND history.ticker = u.ticker
         ORDER BY history.date DESC
         LIMIT 1 OFFSET 4
       )`,
    [date, date],
  )
  const universe = Number(row?.universe ?? 0)
  const covered = Number(row?.covered ?? 0)
  return {
    universe,
    covered,
    coveragePct: universe > 0 ? 100 * covered / universe : 0,
  }
}

async function latestUsSnapshotDate(): Promise<string | null> {
  const row = await execGet<{ date: string | null }>(
    `SELECT date
     FROM market_daily_snapshots INDEXED BY market_snapshots_market_date_idx
     WHERE market = 'US'
     ORDER BY date DESC
     LIMIT 1`,
  )
  return row?.date ?? null
}

async function latestUsOhlcvRunNeedsRetry(): Promise<boolean> {
  const row = await execGet<{ status: string; payloadJson: string }>(
    `
    SELECT status, payload_json AS payloadJson
    FROM market_data_runs
    WHERE market = 'US' AND job_type = 'tiingo_ohlcv'
    ORDER BY started_at DESC
    LIMIT 1
    `,
  )
  if (!row || row.status === 'running') return false
  return row.status === 'failed' || row.status === 'interrupted' || row.status === 'partial'
}

async function usAnalyticsPriceBasis(): Promise<string | null> {
  return execUsAnalyticsGet<{ value: string }>(
    `SELECT value
     FROM us_analytics_metadata
     WHERE key = 'ohlcv_price_basis'`,
  ).then((row) => row?.value ?? null).catch(() => null)
}

async function runCommand(command: string, args: string[], envOverrides: EnvOverrides, heartbeat?: Heartbeat): Promise<RunResult> {
  await waitForMemoryHeadroom({ label: `${command} ${args.join(' ')}` })
  return new Promise((resolve, reject) => {
    // Child steps own the SQLite write window. Refresh the lease only between
    // steps so the coordinator never competes with its own writer.
    void heartbeat
    const timeoutMinutes = Number(
      envOverrides.UPDATE_CHILD_TIMEOUT_MINUTES
      ?? process.env.UPDATE_CHILD_TIMEOUT_MINUTES
      ?? '240',
    )
    let timedOut = false
    const child = spawn(command, args, {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: withMemoryGuardEnv({
        ...process.env,
        USE_LOCAL_DB: '1',
        SQLITE_BUSY_RETRIES: process.env.SQLITE_BUSY_RETRIES ?? '12',
        ...envOverrides,
      }),
    })

    const timeoutTimer = Number.isFinite(timeoutMinutes) && timeoutMinutes > 0
      ? setTimeout(() => {
          timedOut = true
          console.error(`${command} ${args.join(' ')} timed out after ${timeoutMinutes} minutes`)
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
    child.on('error', (error) => {
      clearTimers()
      reject(error)
    })
  })
}

async function runNpm(script: string, envOverrides: EnvOverrides = {}, heartbeat?: Heartbeat): Promise<void> {
  const attempts = numberEnv('US_UPDATE_STEP_MAX_ATTEMPTS', 2)
  const retryDelaySeconds = numberEnv('US_UPDATE_STEP_RETRY_DELAY_SECONDS', 300)

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    console.log(`\n▶ npm run ${script}${attempt > 1 ? ` (retry ${attempt}/${attempts})` : ''}`)
    const result = await runCommand('npm', ['run', script], envOverrides, heartbeat)
    if (result.code === 0) return
    const message = `npm run ${script} failed: code=${result.code}, signal=${result.signal ?? 'none'}`
    if (attempt >= attempts) throw new Error(message)
    console.error(`${message}; retrying after ${retryDelaySeconds} seconds`)
    await sleep(retryDelaySeconds * 1000)
  }
}

async function main() {
  if (hasActiveHeavyMlProcess()) {
    console.log('Heavy US ML is active; source price refresh will continue and analytics publication will be deferred')
  }

  const lockLeaseSeconds = Math.max(
    6 * 60 * 60,
    (numberEnv('UPDATE_CHILD_TIMEOUT_MINUTES', 360) + 60) * 60,
  )
  const lock = await acquireExclusiveUpdateLock('us_update_latest', lockLeaseSeconds)
  if (!lock) {
    console.log('US latest update skipped: us_update_latest lock is already active')
    return
  }

  const heartbeat = () => lock.heartbeat()

  try {
    const expected = process.env.US_EXPECTED_LATEST_DATE?.trim() || expectedLatestUsTradingDate()
    const beforeOhlcv = await latestUsOhlcvDate()
    const beforeSnapshots = await latestUsSnapshotDate()
    console.log(`US latest update started: expected=${expected}, ohlcv=${beforeOhlcv ?? '-'}, snapshots=${beforeSnapshots ?? '-'}`)

    const usAnalyticsDbPath = process.env.US_ANALYTICS_DB_PATH?.trim()
    if (!usAnalyticsDbPath) {
      throw new Error('US_ANALYTICS_DB_PATH is required for US latest update. Point it at the external SSD analytics DB before running.')
    }

    try {
      await runNpm('batch:us-universe', {
        US_INCLUDE_INACTIVE: process.env.US_DAILY_INCLUDE_INACTIVE ?? '0',
        UPDATE_CHILD_TIMEOUT_MINUTES: process.env.US_UNIVERSE_TIMEOUT_MINUTES ?? '30',
      }, heartbeat)
    } catch (error) {
      if (!beforeOhlcv) throw error
      console.warn(`US universe refresh failed; continuing with existing universe because OHLCV already exists: ${errorMessage(error)}`)
    }
    await lock.heartbeat()

    if (process.env.FINNHUB_API_KEY?.trim()) {
      try {
        await runNpm('batch:us-earnings', {
          UPDATE_CHILD_TIMEOUT_MINUTES: process.env.US_EARNINGS_TIMEOUT_MINUTES ?? '15',
        }, heartbeat)
      } catch (error) {
        console.warn(
          `Finnhub earnings refresh failed; price/snapshot/ML update will continue: ${errorMessage(error)}`,
        )
      }
    } else {
      console.warn('Finnhub earnings refresh skipped: FINNHUB_API_KEY is not set')
    }
    await lock.heartbeat()

    const latestBeforeFetch = await latestUsOhlcvDate()
    const minimumCoveragePct = numberEnv('US_DAILY_MIN_PRICE_COVERAGE_PCT', 95)
    const retryCoveragePct = numberEnv('US_DAILY_RETRY_PRICE_COVERAGE_PCT', 99.95)
    const coverageBeforeFetch = latestBeforeFetch
      ? await usOhlcvCoverage(latestBeforeFetch)
      : null
    const coverageNeedsRetry = Boolean(
      latestBeforeFetch
      && latestBeforeFetch >= expected
      && coverageBeforeFetch
      && coverageBeforeFetch.coveragePct < retryCoveragePct,
    )
    const pendingOhlcvRetry = await latestUsOhlcvRunNeedsRetry()
    const dailyHistoryFrom = process.env.US_DAILY_HISTORY_FROM?.trim() || expected
    if (
      !latestBeforeFetch
      || latestBeforeFetch < expected
      || pendingOhlcvRetry
      || coverageNeedsRetry
      || process.env.US_FORCE_OHLCV_REFRESH === '1'
    ) {
      if (pendingOhlcvRetry || coverageNeedsRetry) {
        console.log(
          `US OHLCV retry required: previousPartial=${pendingOhlcvRetry}, `
          + `coverage=${coverageBeforeFetch?.coveragePct.toFixed(2) ?? '-'}%`,
        )
      }
      await runNpm('batch:us-ohlcv', {
        US_INCLUDE_INACTIVE: process.env.US_DAILY_INCLUDE_INACTIVE ?? '0',
        US_HISTORY_FROM: dailyHistoryFrom,
        US_TARGET_END_DATE: expected,
        US_REQUIRE_DATE_RANGE: process.env.US_DAILY_REQUIRE_DATE_RANGE ?? '0',
        US_OHLCV_CONCURRENCY: process.env.US_DAILY_OHLCV_CONCURRENCY ?? '2',
        US_OHLCV_RATE_LIMIT_MS: process.env.US_DAILY_OHLCV_RATE_LIMIT_MS ?? '350',
        US_OHLCV_INSERT_CHUNK: process.env.US_DAILY_OHLCV_INSERT_CHUNK ?? '50',
        UPDATE_CHILD_TIMEOUT_MINUTES: process.env.US_OHLCV_TIMEOUT_MINUTES ?? '240',
      }, heartbeat)
      await lock.heartbeat()
    } else {
      console.log(`US OHLCV is already fresh enough: ${latestBeforeFetch} >= ${expected}`)
    }

    const afterOhlcv = await latestUsOhlcvDate()
    if (!afterOhlcv) {
      console.log('US latest update stopped: OHLCV is still empty after fetch')
      return
    }
    if (afterOhlcv < expected && process.env.US_ALLOW_STALE_DAILY_UPDATE !== '1') {
      console.log(
        `US latest update stopped: Tiingo EOD is not available yet (latest=${afterOhlcv}, expected=${expected}); downstream snapshots/analytics/ML skipped`,
      )
      return
    }

    const coverage = await usOhlcvCoverage(afterOhlcv)
    console.log(
      `US source coverage: ${coverage.covered}/${coverage.universe} (${coverage.coveragePct.toFixed(2)}%), `
      + `publication minimum=${minimumCoveragePct}%, retry target=${retryCoveragePct}%`,
    )
    if (
      coverage.coveragePct < minimumCoveragePct
      && process.env.US_ALLOW_PARTIAL_DAILY_PUBLICATION !== '1'
    ) {
      console.log(
        'US latest update deferred: price coverage is below the publication threshold; '
        + 'the next scheduled run will retry stale tickers before snapshots/ML are published',
      )
      return
    }

    const latestSnapshots = await latestUsSnapshotDate()
    const minimumSnapshotCoveragePct = numberEnv('US_DAILY_MIN_SNAPSHOT_COVERAGE_PCT', 99.5)
    const snapshotCoverageBefore = await usSnapshotCoverage(afterOhlcv)
    const snapshotCoverageNeedsRepair = snapshotCoverageBefore.coveragePct < minimumSnapshotCoveragePct
    console.log(
      `US snapshot coverage: ${snapshotCoverageBefore.covered}/${snapshotCoverageBefore.universe} `
      + `(${snapshotCoverageBefore.coveragePct.toFixed(2)}%), minimum=${minimumSnapshotCoveragePct}%`,
    )
    if (
      latestSnapshots == null
      || latestSnapshots < afterOhlcv
      || snapshotCoverageNeedsRepair
      || process.env.US_FORCE_SNAPSHOT_REFRESH === '1'
    ) {
      if (snapshotCoverageNeedsRepair) {
        console.log('US snapshot repair required: latest date is aligned but eligible ticker coverage is incomplete')
      }
      await runNpm('batch:us-snapshots', {
        US_INCLUDE_INACTIVE: process.env.US_DAILY_INCLUDE_INACTIVE ?? '0',
        US_SNAPSHOT_CONCURRENCY: process.env.US_DAILY_SNAPSHOT_CONCURRENCY ?? '2',
        UPDATE_CHILD_TIMEOUT_MINUTES: process.env.US_SNAPSHOT_TIMEOUT_MINUTES ?? '240',
      }, heartbeat)
      await lock.heartbeat()
    } else {
      console.log(`US snapshots are already aligned: ${latestSnapshots ?? '-'} / OHLCV ${afterOhlcv ?? '-'}`)
    }
    const snapshotCoverageAfter = await usSnapshotCoverage(afterOhlcv)
    console.log(
      `US snapshot coverage after refresh: ${snapshotCoverageAfter.covered}/${snapshotCoverageAfter.universe} `
      + `(${snapshotCoverageAfter.coveragePct.toFixed(2)}%)`,
    )
    if (
      snapshotCoverageAfter.coveragePct < minimumSnapshotCoveragePct
      && process.env.US_ALLOW_PARTIAL_DAILY_PUBLICATION !== '1'
    ) {
      console.log(
        'US latest update deferred: snapshot coverage is below the publication threshold; '
        + 'the next scheduled run will repair missing snapshot rows before analytics/ML are published',
      )
      return
    }

    if (hasActiveHeavyMlProcess()) {
      console.log(
        'US source price and snapshots are current; analytics/ML publication deferred until the active heavy ML process exits',
      )
      return
    }

    await runNpm('batch:us-analytics-db', {
      US_ANALYTICS_DB_PATH: usAnalyticsDbPath,
      US_ANALYTICS_LIMIT: process.env.US_DAILY_ANALYTICS_LIMIT ?? '0',
      UPDATE_CHILD_TIMEOUT_MINUTES: process.env.US_ANALYTICS_TIMEOUT_MINUTES ?? '240',
    }, heartbeat)
    await lock.heartbeat()

    const priceBasis = await usAnalyticsPriceBasis()
    if (priceBasis !== US_ADJUSTED_PRICE_BASIS) {
      console.log(
        `US analytics publication deferred: priceBasis=${priceBasis ?? 'missing'}, `
        + `expected=${US_ADJUSTED_PRICE_BASIS}. The weekly foundation job will rebuild full history safely.`,
      )
      return
    }

    await runNpm('batch:us-analytics-validate', {
      US_ANALYTICS_DB_PATH: usAnalyticsDbPath,
      UPDATE_CHILD_TIMEOUT_MINUTES: process.env.US_ANALYTICS_VALIDATE_TIMEOUT_MINUTES ?? '30',
    }, heartbeat)
    await lock.heartbeat()

    await runNpm('batch:analog-index:us', {
      US_ANALYTICS_DB_PATH: usAnalyticsDbPath,
      UPDATE_CHILD_TIMEOUT_MINUTES: process.env.ANALOG_INDEX_DAILY_TIMEOUT_MINUTES ?? '60',
    }, heartbeat)
    await lock.heartbeat()

    if (process.env.US_SKIP_DAILY_ML === '1') {
      console.log('US daily ML skipped (US_SKIP_DAILY_ML=1)')
    } else {
      await runNpm('batch:us-ml-daily', {
        STOCKBOARD_DB_PATH: usAnalyticsDbPath,
        ML_DAILY_TRAIN_LIMIT: process.env.US_ML_DAILY_TRAIN_LIMIT ?? '80000',
        ML_PHYSICS_DAILY_TRAIN_LIMIT: process.env.US_ML_PHYSICS_DAILY_TRAIN_LIMIT ?? '120000',
        US_PMS_DAILY_RECENT_DAYS: process.env.US_PMS_DAILY_RECENT_DAYS ?? '420',
        US_ML_DAILY_RECENT_DAYS: process.env.US_ML_DAILY_RECENT_DAYS ?? '2',
        US_ML_DAILY_MIN_HISTORY_DAYS: process.env.US_ML_DAILY_MIN_HISTORY_DAYS ?? '220',
        US_ML_DAILY_LABEL_RECENT_DAYS: process.env.US_ML_DAILY_LABEL_RECENT_DAYS ?? '10',
        US_ML_CONTEXT_DAILY_RECENT_DAYS: process.env.US_ML_CONTEXT_DAILY_RECENT_DAYS ?? '2',
        US_ML_PHYSICS_DAILY_RECENT_DAYS: process.env.US_ML_PHYSICS_DAILY_RECENT_DAYS ?? '2',
        US_ML_PHYSICS_DAILY_MIN_HISTORY_DAYS: process.env.US_ML_PHYSICS_DAILY_MIN_HISTORY_DAYS ?? '220',
        US_ML_DAILY_RL_RECENT_DAYS: process.env.US_ML_DAILY_RL_RECENT_DAYS ?? '60',
        US_ML_DAILY_STATUS_RECENT_DAYS: process.env.US_ML_DAILY_STATUS_RECENT_DAYS ?? '60',
        UPDATE_CHILD_TIMEOUT_MINUTES: process.env.US_ML_DAILY_TIMEOUT_MINUTES ?? '1440',
      }, heartbeat)
      await lock.heartbeat()
    }

    await runNpm('batch:dashboard-cache', {
      STOCKBOARD_DB_PATH: usAnalyticsDbPath,
      UPDATE_CHILD_TIMEOUT_MINUTES: process.env.US_DASHBOARD_CACHE_TIMEOUT_MINUTES ?? '30',
    }, heartbeat)
    await lock.heartbeat()

    const finalOhlcv = await latestUsOhlcvDate()
    const finalSnapshots = await latestUsSnapshotDate()
    console.log(`US latest update complete: ohlcv=${finalOhlcv ?? '-'}, snapshots=${finalSnapshots ?? '-'}`)
  } finally {
    await lock.release()
  }
}

main().catch((error) => {
  console.error('US latest update fatal:', error)
  process.exit(1)
})
