// scripts/update-us-latest.ts
//
// Tiingo US EODの差分取得から、US用スナップショット・分析DB・日次ML更新までを
// ローカルMacのlaunchdで安全に回すためのオーケストレーター。

import { execFileSync, spawn } from 'node:child_process'
import { execGet } from '@/lib/db/client'
import { acquireUpdateLock } from '@/lib/server/update-lock'
import { waitForMemoryHeadroom, withMemoryGuardEnv } from '@/lib/system/memory-guard'

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

function dateInTokyo(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const byType = new Map(parts.map((part) => [part.type, part.value]))
  return `${byType.get('year')}-${byType.get('month')}-${byType.get('day')}`
}

function addDays(dateString: string, days: number): string {
  const date = new Date(`${dateString}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function weekday(dateString: string): number {
  return new Date(`${dateString}T00:00:00Z`).getUTCDay()
}

function rollBackWeekend(dateString: string): string {
  let date = dateString
  while (weekday(date) === 0 || weekday(date) === 6) date = addDays(date, -1)
  return date
}

function expectedLatestUsTradingDate(): string {
  // JST朝には、通常「前日NY営業日」のEODが最新候補になる。
  // 祝日はTiingo側で0件になり得るため、ここでは週末だけを保守的に戻す。
  return rollBackWeekend(addDays(dateInTokyo(), -1))
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

async function runCommand(command: string, args: string[], envOverrides: EnvOverrides, heartbeat?: Heartbeat): Promise<RunResult> {
  await waitForMemoryHeadroom({ label: `${command} ${args.join(' ')}` })
  return new Promise((resolve, reject) => {
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
        SQLITE_BUSY_RETRIES: process.env.SQLITE_BUSY_RETRIES ?? '720',
        ...envOverrides,
      }),
    })

    const heartbeatTimer = heartbeat
      ? setInterval(() => {
          heartbeat().catch((error) => {
            console.warn(`US update heartbeat failed while running ${args.join(' ')}:`, errorMessage(error))
          })
        }, 60_000)
      : null
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
      if (heartbeatTimer) clearInterval(heartbeatTimer)
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
    console.log('US latest update skipped: heavy ML/backfill process is active')
    return
  }

  const lock = await acquireUpdateLock('us_update_latest', 6 * 60 * 60)
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

    await runNpm('batch:us-universe', {
      US_INCLUDE_INACTIVE: process.env.US_DAILY_INCLUDE_INACTIVE ?? '0',
      UPDATE_CHILD_TIMEOUT_MINUTES: process.env.US_UNIVERSE_TIMEOUT_MINUTES ?? '30',
    }, heartbeat)
    await lock.heartbeat()

    const latestBeforeFetch = await latestUsOhlcvDate()
    if (!latestBeforeFetch || latestBeforeFetch < expected || process.env.US_FORCE_OHLCV_REFRESH === '1') {
      await runNpm('batch:us-ohlcv', {
        US_INCLUDE_INACTIVE: process.env.US_DAILY_INCLUDE_INACTIVE ?? '0',
        US_HISTORY_FROM: process.env.US_DAILY_HISTORY_FROM ?? '1900-01-01',
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

    const latestSnapshots = await latestUsSnapshotDate()
    if (afterOhlcv && (latestSnapshots == null || latestSnapshots < afterOhlcv || process.env.US_FORCE_SNAPSHOT_REFRESH === '1')) {
      await runNpm('batch:us-snapshots', {
        US_INCLUDE_INACTIVE: process.env.US_DAILY_INCLUDE_INACTIVE ?? '0',
        US_SNAPSHOT_CONCURRENCY: process.env.US_DAILY_SNAPSHOT_CONCURRENCY ?? '2',
        UPDATE_CHILD_TIMEOUT_MINUTES: process.env.US_SNAPSHOT_TIMEOUT_MINUTES ?? '240',
      }, heartbeat)
      await lock.heartbeat()
    } else {
      console.log(`US snapshots are already aligned: ${latestSnapshots ?? '-'} / OHLCV ${afterOhlcv ?? '-'}`)
    }

    await runNpm('batch:us-analytics-db', {
      US_ANALYTICS_DB_PATH: usAnalyticsDbPath,
      US_ANALYTICS_LIMIT: process.env.US_DAILY_ANALYTICS_LIMIT ?? '0',
      UPDATE_CHILD_TIMEOUT_MINUTES: process.env.US_ANALYTICS_TIMEOUT_MINUTES ?? '240',
    }, heartbeat)
    await lock.heartbeat()

    await runNpm('batch:us-analytics-validate', {
      US_ANALYTICS_DB_PATH: usAnalyticsDbPath,
      UPDATE_CHILD_TIMEOUT_MINUTES: process.env.US_ANALYTICS_VALIDATE_TIMEOUT_MINUTES ?? '30',
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
        US_ML_DAILY_RL_RECENT_DAYS: process.env.US_ML_DAILY_RL_RECENT_DAYS ?? '260',
        US_ML_DAILY_STATUS_RECENT_DAYS: process.env.US_ML_DAILY_STATUS_RECENT_DAYS ?? '260',
        UPDATE_CHILD_TIMEOUT_MINUTES: process.env.US_ML_DAILY_TIMEOUT_MINUTES ?? '1440',
      }, heartbeat)
      await lock.heartbeat()
    }

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
