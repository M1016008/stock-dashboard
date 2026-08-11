// scripts/run-ml-learning.ts
//
// JP MLの日次serving更新/週次全量再学習の実行ラッパー。
// launchd から直接長い npm chain を起動せず、DB更新ロックの待機と二重起動防止を行う。

import { spawn, type ChildProcess } from 'node:child_process'
import { eq } from 'drizzle-orm'
import { db, execAll } from '@/lib/db/client'
import { batchRuns } from '@/lib/db/schema'
import { acquireJpStockboardUpdateLock, getActiveUpdateLocks } from '@/lib/server/update-lock'
import { waitForMemoryHeadroom, withMemoryGuardEnv } from '@/lib/system/memory-guard'

type RunResult = {
  code: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
}

type ActiveBatchRun = {
  id: number
  jobType: string
  startedAt: number
}

const JOB_TYPE = 'ml_learning'
const DEFAULT_BLOCKING_LOCKS = ['update_latest', 'post_ohlcv_refresh', 'us_update_latest'] as const
const DEFAULT_BLOCKING_BATCH_RUNS = [
  'ml_learning',
  'update_latest',
  'post_ohlcv_refresh',
  'physical_momentum',
  'physical_momentum_us',
  'physical_momentum_us_raw_chunk',
  'physical_momentum_us_normalize_chunk',
  'us_update_latest',
] as const
const MS_PER_DAY = 24 * 60 * 60 * 1000

let activeChild: ChildProcess | null = null
let shutdownSignal: NodeJS.Signals | null = null
let releaseActiveLock: (() => Promise<void>) | null = null
let activeRunId: number | null = null

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function parseCsv(value: string | undefined, fallback: readonly string[]): string[] {
  const parsed = value
    ?.split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  return parsed && parsed.length > 0 ? parsed : [...fallback]
}

function numberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function ymd(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function dateFromYmd(date: string): Date {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day))
}

function formatUtcDate(date: Date): string {
  return ymd(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate())
}

function jstDateString(now = new Date()): string {
  if (process.env.ML_LEARNING_JST_DATE) return process.env.ML_LEARNING_JST_DATE
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

function nthMonday(year: number, month: number, nth: number): string {
  const first = new Date(Date.UTC(year, month - 1, 1))
  const offset = (8 - first.getUTCDay()) % 7
  return ymd(year, month, 1 + offset + (nth - 1) * 7)
}

function vernalEquinoxDay(year: number): number {
  if (year <= 1979) return Math.floor(20.8357 + 0.242194 * (year - 1980) - Math.floor((year - 1983) / 4))
  if (year <= 2099) return Math.floor(20.8431 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4))
  return Math.floor(21.851 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4))
}

function autumnalEquinoxDay(year: number): number {
  if (year <= 1979) return Math.floor(23.2588 + 0.242194 * (year - 1980) - Math.floor((year - 1983) / 4))
  if (year <= 2099) return Math.floor(23.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4))
  return Math.floor(24.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4))
}

function baseJapaneseNationalHolidays(year: number): Set<string> {
  const holidays = new Set<string>([
    ymd(year, 1, 1),
    nthMonday(year, 1, 2),
    ymd(year, 2, 11),
    ymd(year, 3, vernalEquinoxDay(year)),
    ymd(year, 4, 29),
    ymd(year, 5, 3),
    ymd(year, 5, 4),
    ymd(year, 5, 5),
    nthMonday(year, 9, 3),
    ymd(year, 9, autumnalEquinoxDay(year)),
    nthMonday(year, 10, 2),
    ymd(year, 11, 3),
    ymd(year, 11, 23),
  ])

  if (year >= 2020) holidays.add(ymd(year, 2, 23))
  if (year >= 2016) holidays.add(ymd(year, 8, 11))

  // Tokyo Olympics one-off holiday moves.
  if (year === 2020) {
    holidays.delete(nthMonday(year, 7, 3))
    holidays.delete(ymd(year, 8, 11))
    holidays.delete(nthMonday(year, 10, 2))
    holidays.add(ymd(year, 7, 23))
    holidays.add(ymd(year, 7, 24))
    holidays.add(ymd(year, 8, 10))
  } else if (year === 2021) {
    holidays.delete(nthMonday(year, 7, 3))
    holidays.delete(ymd(year, 8, 11))
    holidays.delete(nthMonday(year, 10, 2))
    holidays.add(ymd(year, 7, 22))
    holidays.add(ymd(year, 7, 23))
    holidays.add(ymd(year, 8, 8))
  } else {
    holidays.add(nthMonday(year, 7, 3))
  }

  return holidays
}

function japaneseNationalHolidays(year: number): Set<string> {
  const holidays = new Set<string>()
  for (const date of baseJapaneseNationalHolidays(year - 1)) holidays.add(date)
  for (const date of baseJapaneseNationalHolidays(year)) holidays.add(date)
  for (const date of baseJapaneseNationalHolidays(year + 1)) holidays.add(date)

  const base = new Set(holidays)
  for (const date of base) {
    const day = dateFromYmd(date).getUTCDay()
    if (day !== 0) continue
    let substitute = new Date(dateFromYmd(date).getTime() + MS_PER_DAY)
    while (holidays.has(formatUtcDate(substitute))) {
      substitute = new Date(substitute.getTime() + MS_PER_DAY)
    }
    holidays.add(formatUtcDate(substitute))
  }

  const start = dateFromYmd(`${year}-01-01`)
  const end = dateFromYmd(`${year}-12-31`)
  for (let time = start.getTime(); time <= end.getTime(); time += MS_PER_DAY) {
    const current = new Date(time)
    const day = current.getUTCDay()
    if (day === 0 || day === 6) continue
    const currentDate = formatUtcDate(current)
    if (holidays.has(currentDate)) continue
    const previous = formatUtcDate(new Date(time - MS_PER_DAY))
    const next = formatUtcDate(new Date(time + MS_PER_DAY))
    if (holidays.has(previous) && holidays.has(next)) holidays.add(currentDate)
  }

  return holidays
}

function jpMarketCalendarStatus(date = jstDateString()): { shouldRun: boolean; date: string; reason: string } {
  if (process.env.ML_LEARNING_IGNORE_MARKET_CALENDAR === '1') {
    return { shouldRun: true, date, reason: 'market calendar bypassed' }
  }

  const [year, month, day] = date.split('-').map(Number)
  const utcDate = new Date(Date.UTC(year, month - 1, day))
  const weekday = utcDate.getUTCDay()
  if (weekday === 0 || weekday === 6) {
    return { shouldRun: false, date, reason: 'JP market closed: weekend' }
  }
  if ((month === 1 && day <= 3) || (month === 12 && day === 31)) {
    return { shouldRun: false, date, reason: 'JP market closed: exchange year-end/new-year holiday' }
  }
  if (japaneseNationalHolidays(year).has(date)) {
    return { shouldRun: false, date, reason: 'JP market closed: Japanese national holiday' }
  }
  return { shouldRun: true, date, reason: 'JP market business day' }
}

function configureDefaults(): void {
  process.env.USE_LOCAL_DB = process.env.USE_LOCAL_DB ?? '1'
  process.env.SQLITE_BUSY_RETRIES = process.env.SQLITE_BUSY_RETRIES ?? '12'
  process.env.UPDATE_CHILD_TIMEOUT_MINUTES = process.env.UPDATE_CHILD_TIMEOUT_MINUTES ?? '240'
  process.env.PMS_DAILY_RECENT_DAYS = process.env.PMS_DAILY_RECENT_DAYS ?? '30'
  process.env.ML_DAILY_RECENT_DAYS = process.env.ML_DAILY_RECENT_DAYS ?? '5'
  process.env.ML_DAILY_MIN_HISTORY_DAYS = process.env.ML_DAILY_MIN_HISTORY_DAYS ?? '220'
  process.env.ML_DAILY_LABEL_RECENT_DAYS = process.env.ML_DAILY_LABEL_RECENT_DAYS ?? '30'
  process.env.ML_DAILY_EXTREMA_RECENT_DAYS = process.env.ML_DAILY_EXTREMA_RECENT_DAYS ?? '60'
  process.env.ML_DAILY_RL_RECENT_DAYS = process.env.ML_DAILY_RL_RECENT_DAYS ?? '60'
  process.env.ML_DAILY_STATUS_RECENT_DAYS = process.env.ML_DAILY_STATUS_RECENT_DAYS ?? '60'
  process.env.ML_CONTEXT_DAILY_RECENT_DAYS = process.env.ML_CONTEXT_DAILY_RECENT_DAYS ?? '5'
  process.env.ML_PHYSICS_DAILY_RECENT_DAYS = process.env.ML_PHYSICS_DAILY_RECENT_DAYS ?? '5'
  process.env.ML_PHYSICS_DAILY_MIN_HISTORY_DAYS = process.env.ML_PHYSICS_DAILY_MIN_HISTORY_DAYS ?? '220'
  process.env.ML_LEARNING_MAX_ATTEMPTS = process.env.ML_LEARNING_MAX_ATTEMPTS ?? '2'
  process.env.ML_LEARNING_RETRY_DELAY_SECONDS = process.env.ML_LEARNING_RETRY_DELAY_SECONDS ?? '300'
  process.env.ML_LEARNING_LOCK_WAIT_MINUTES = process.env.ML_LEARNING_LOCK_WAIT_MINUTES ?? '60'
  process.env.ML_LEARNING_BATCH_WAIT_MINUTES = process.env.ML_LEARNING_BATCH_WAIT_MINUTES ?? '60'
}

function installSignalHandlers(): void {
  const handler = (signal: NodeJS.Signals) => {
    shutdownSignal = signal
    console.error(`Received ${signal}; stopping ML learning child process`)
    releaseActiveLock?.().catch((error) => {
      console.warn(`Failed to release ML learning lock on ${signal}: ${errorMessage(error)}`)
    })
    if (activeRunId != null) {
      db
        .update(batchRuns)
        .set({
          finishedAt: new Date(),
          status: 'failed',
          failed: 1,
          errorSummary: `interrupted by ${signal}`,
        })
        .where(eq(batchRuns.id, activeRunId))
        .catch((error) => {
          console.warn(`Failed to mark ML learning batch run interrupted: ${errorMessage(error)}`)
        })
    }
    if (activeChild && activeChild.exitCode === null && activeChild.signalCode === null) {
      activeChild.kill('SIGTERM')
      setTimeout(() => {
        if (activeChild && activeChild.exitCode === null && activeChild.signalCode === null) {
          activeChild.kill('SIGKILL')
        }
      }, 10_000)
    }
  }
  process.once('SIGINT', handler)
  process.once('SIGTERM', handler)
}

async function waitForBlockingLocks(jobTypes: readonly string[]): Promise<void> {
  const waitMinutes = numberEnv('ML_LEARNING_LOCK_WAIT_MINUTES', 360)
  const pollSeconds = numberEnv('ML_LEARNING_LOCK_POLL_SECONDS', 30)
  const startedAt = Date.now()
  let lastLogAt = 0

  for (;;) {
    if (shutdownSignal) throw new Error(`Interrupted while waiting for DB locks: ${shutdownSignal}`)

    const activeLocks = await getActiveUpdateLocks(jobTypes)
    if (activeLocks.length === 0) return

    const elapsedMs = Date.now() - startedAt
    if (elapsedMs > waitMinutes * 60_000) {
      const names = activeLocks.map((lock) => lock.jobType).join(', ')
      throw new Error(`Timed out waiting ${waitMinutes} minutes for active DB locks: ${names}`)
    }

    if (Date.now() - lastLogAt > 60_000) {
      lastLogAt = Date.now()
      const details = activeLocks
        .map((lock) => `${lock.jobType}(heartbeat=${new Date(lock.heartbeatAt * 1000).toISOString()})`)
        .join(', ')
      console.log(`Waiting for DB writer locks before ML learning: ${details}`)
    }

    await sleep(pollSeconds * 1000)
  }
}

async function waitForBlockingBatchRuns(jobTypes: readonly string[], currentRunId: number): Promise<void> {
  if (jobTypes.length === 0) return

  const waitMinutes = numberEnv('ML_LEARNING_BATCH_WAIT_MINUTES', 360)
  const pollSeconds = numberEnv('ML_LEARNING_LOCK_POLL_SECONDS', 30)
  const startedAt = Date.now()
  let lastLogAt = 0
  const placeholders = jobTypes.map(() => '?').join(', ')

  for (;;) {
    if (shutdownSignal) throw new Error(`Interrupted while waiting for batch runs: ${shutdownSignal}`)

    const activeRuns = await execAll<ActiveBatchRun>(
      `
      SELECT
        id,
        job_type AS jobType,
        started_at AS startedAt
      FROM batch_runs
      WHERE status = 'running'
        AND id <> ?
        AND job_type IN (${placeholders})
      ORDER BY started_at ASC
      `,
      [currentRunId, ...jobTypes],
    )

    if (activeRuns.length === 0) return

    const elapsedMs = Date.now() - startedAt
    if (elapsedMs > waitMinutes * 60_000) {
      const details = activeRuns.map((run) => `${run.jobType}#${run.id}`).join(', ')
      throw new Error(`Timed out waiting ${waitMinutes} minutes for active batch runs: ${details}`)
    }

    if (Date.now() - lastLogAt > 60_000) {
      lastLogAt = Date.now()
      const details = activeRuns
        .map((run) => `${run.jobType}#${run.id}(started=${new Date(run.startedAt * 1000).toISOString()})`)
        .join(', ')
      console.log(`Waiting for active batch runs before ML learning: ${details}`)
    }

    await sleep(pollSeconds * 1000)
  }
}

function startHeartbeatLoop(
  heartbeat: () => Promise<void>,
  label: string,
): () => void {
  let heartbeatInFlight = false
  const timer = setInterval(() => {
    if (heartbeatInFlight) return
    heartbeatInFlight = true
    heartbeat()
      .catch((error) => {
        console.warn(`Failed to refresh ML learning lock during ${label}: ${errorMessage(error)}`)
      })
      .finally(() => {
        heartbeatInFlight = false
      })
  }, 60_000)
  timer.unref()
  return () => clearInterval(timer)
}

async function sleepWithHeartbeat(
  milliseconds: number,
  heartbeat: () => Promise<void>,
): Promise<void> {
  const deadline = Date.now() + milliseconds
  while (Date.now() < deadline) {
    if (shutdownSignal) return
    await sleep(Math.min(60_000, deadline - Date.now()))
    await heartbeat()
  }
}

async function runNpmUtility(
  script: string,
  heartbeat: () => Promise<void>,
  timeoutMinutes = 30,
  envOverrides: Record<string, string | undefined> = {},
): Promise<RunResult> {
  await waitForMemoryHeadroom({ label: `npm run ${script}` })
  return new Promise((resolve, reject) => {
    const stopHeartbeat = startHeartbeatLoop(heartbeat, script)
    let timedOut = false
    const child = spawn('npm', ['run', script], {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: withMemoryGuardEnv({
        ...process.env,
        USE_LOCAL_DB: '1',
        SQLITE_BUSY_RETRIES: process.env.SQLITE_BUSY_RETRIES ?? '12',
        UPDATE_CHILD_TIMEOUT_MINUTES: String(timeoutMinutes),
        ...envOverrides,
      }),
    })

    const timeoutTimer = setTimeout(() => {
      timedOut = true
      console.error(`${script} timed out after ${timeoutMinutes} minutes; sending SIGTERM`)
      child.kill('SIGTERM')
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }, 10_000)
    }, timeoutMinutes * 60_000)

    const clearTimers = () => {
      clearTimeout(timeoutTimer)
      stopHeartbeat()
    }

    child.on('error', (err) => {
      clearTimers()
      reject(err)
    })
    child.on('close', (code, signal) => {
      clearTimers()
      resolve({ code: timedOut ? 124 : code, signal, timedOut })
    })
  })
}

async function cleanupStaleBatchRuns(heartbeat: () => Promise<void>): Promise<void> {
  console.log('\n▶ npm run batch:cleanup-stale-runs')
  const result = await runNpmUtility('batch:cleanup-stale-runs', heartbeat, 30, {
    STALE_BATCH_TTL_HOURS: process.env.ML_STALE_BATCH_TTL_HOURS ?? '1',
  })
  if (result.code !== 0) {
    throw new Error(`batch:cleanup-stale-runs failed: code=${result.code}, signal=${result.signal ?? 'none'}`)
  }
}

async function runHeavyMlChain(): Promise<RunResult> {
  const npmScript = process.env.ML_LEARNING_NPM_SCRIPT?.trim() || 'batch:ml-daily'
  await waitForMemoryHeadroom({ label: `npm run ${npmScript}` })
  return new Promise((resolve, reject) => {
    const timeoutMinutes = numberEnv('UPDATE_CHILD_TIMEOUT_MINUTES', 720)
    let timedOut = false

    activeChild = spawn('npm', ['run', npmScript], {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: withMemoryGuardEnv({
        ...process.env,
        USE_LOCAL_DB: '1',
        SQLITE_BUSY_RETRIES: process.env.SQLITE_BUSY_RETRIES ?? '12',
        UPDATE_CHILD_TIMEOUT_MINUTES: process.env.UPDATE_CHILD_TIMEOUT_MINUTES ?? '2880',
      }),
    })

    const timeoutTimer = setTimeout(() => {
      timedOut = true
      console.error(`ML learning timed out after ${timeoutMinutes} minutes; sending SIGTERM`)
      activeChild?.kill('SIGTERM')
      setTimeout(() => {
        if (activeChild && activeChild.exitCode === null && activeChild.signalCode === null) {
          activeChild.kill('SIGKILL')
        }
      }, 10_000)
    }, timeoutMinutes * 60_000)

    const clearTimers = () => {
      clearTimeout(timeoutTimer)
    }

    activeChild.on('error', (err) => {
      clearTimers()
      activeChild = null
      reject(err)
    })
    activeChild.on('close', (code, signal) => {
      clearTimers()
      activeChild = null
      resolve({ code: timedOut ? 124 : code, signal, timedOut })
    })
  })
}

async function main(): Promise<void> {
  configureDefaults()
  installSignalHandlers()

  const childTimeoutMinutes = numberEnv('UPDATE_CHILD_TIMEOUT_MINUTES', 240)
  const leaseSeconds = numberEnv(
    'ML_LEARNING_LOCK_LEASE_SECONDS',
    Math.max(5 * 60 * 60, (childTimeoutMinutes + 60) * 60),
  )
  const lock = await acquireJpStockboardUpdateLock(JOB_TYPE, leaseSeconds)
  if (!lock) {
    console.log('ML learning skipped: ml_learning lock is already active')
    return
  }
  releaseActiveLock = lock.release

  const [run] = await db
    .insert(batchRuns)
    .values({
      jobType: JOB_TYPE,
      startedAt: new Date(),
      status: 'running',
    })
    .returning({ id: batchRuns.id })

  const runId = run.id
  activeRunId = runId
  const blockingLocks = parseCsv(process.env.ML_LEARNING_BLOCKING_LOCKS, DEFAULT_BLOCKING_LOCKS)
  const blockingBatchRuns = parseCsv(process.env.ML_LEARNING_BLOCKING_BATCH_RUNS, DEFAULT_BLOCKING_BATCH_RUNS)

  try {
    console.log('ML learning daily wrapper started')
    console.log(`blocking locks: ${blockingLocks.join(', ')}`)
    console.log(`blocking batch runs: ${blockingBatchRuns.join(', ')}`)
    console.log(`timeout minutes: ${process.env.UPDATE_CHILD_TIMEOUT_MINUTES}`)

    const marketStatus = jpMarketCalendarStatus()
    console.log(`JP market calendar: ${marketStatus.date} / ${marketStatus.reason}`)
    if (!marketStatus.shouldRun) {
      await db
        .update(batchRuns)
        .set({
          finishedAt: new Date(),
          status: 'success',
          succeeded: 1,
          rowsInserted: 0,
          errorSummary: `skipped: ${marketStatus.reason}`,
        })
        .where(eq(batchRuns.id, runId))
      console.log(`ML learning skipped: ${marketStatus.reason}`)
      return
    }

    if (process.env.ML_LEARNING_PREFLIGHT_ONLY === '1') {
      await cleanupStaleBatchRuns(() => lock.heartbeat())
      await waitForBlockingLocks(blockingLocks)
      await waitForBlockingBatchRuns(blockingBatchRuns, runId)
      await lock.heartbeat()
      console.log('ML learning preflight succeeded; heavy chain skipped')
      await db
        .update(batchRuns)
        .set({
          finishedAt: new Date(),
          status: 'success',
          succeeded: 1,
          rowsInserted: 0,
          errorSummary: 'preflight only',
        })
        .where(eq(batchRuns.id, runId))
      return
    }

    const maxAttempts = numberEnv('ML_LEARNING_MAX_ATTEMPTS', 3)
    const retryDelaySeconds = numberEnv('ML_LEARNING_RETRY_DELAY_SECONDS', 900)
    const npmScript = process.env.ML_LEARNING_NPM_SCRIPT?.trim() || 'batch:ml-daily'
    let lastError: Error | null = null

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (shutdownSignal) throw new Error(`ML learning interrupted before attempt ${attempt}: ${shutdownSignal}`)

      console.log(`\nML learning attempt ${attempt}/${maxAttempts}: ${npmScript}`)
      await cleanupStaleBatchRuns(() => lock.heartbeat())
      await waitForBlockingLocks(blockingLocks)
      await waitForBlockingBatchRuns(blockingBatchRuns, runId)
      await lock.heartbeat()

      const result = await runHeavyMlChain()
      if (result.code === 0) {
        lastError = null
        break
      }

      lastError = new Error(`${npmScript} failed: code=${result.code}, signal=${result.signal ?? 'none'}`)
      console.error(`ML learning attempt ${attempt}/${maxAttempts} failed: ${lastError.message}`)
      if (shutdownSignal) throw new Error(`ML learning interrupted: ${shutdownSignal}`)
      if (attempt >= maxAttempts) break

      console.log(`Retrying ML learning after ${retryDelaySeconds} seconds`)
      await sleepWithHeartbeat(retryDelaySeconds * 1000, () => lock.heartbeat())
    }

    if (lastError) {
      throw lastError
    }
    if (shutdownSignal) {
      throw new Error(`ML learning interrupted: ${shutdownSignal}`)
    }

    const generationAction = /(?:^|:)ml-full(?:$|:)/.test(npmScript)
      ? 'mark-baseline'
      : 'mark-delta'
    const generationResult = await runNpmUtility(
      'batch:ml-pipeline-state',
      () => lock.heartbeat(),
      60,
      {
        ML_PIPELINE_ACTION: generationAction,
        ML_PIPELINE_MARKET: 'JP',
      },
    )
    if (generationResult.code !== 0) {
      throw new Error(
        `batch:ml-pipeline-state failed: code=${generationResult.code}, signal=${generationResult.signal ?? 'none'}`,
      )
    }

    await db
      .update(batchRuns)
      .set({
        finishedAt: new Date(),
        status: 'success',
        succeeded: 1,
        rowsInserted: 0,
        errorSummary: null,
      })
      .where(eq(batchRuns.id, runId))

    console.log('ML learning daily wrapper finished successfully')
  } catch (error) {
    await db
      .update(batchRuns)
      .set({
        finishedAt: new Date(),
        status: 'failed',
        failed: 1,
        errorSummary: errorMessage(error),
      })
      .where(eq(batchRuns.id, runId))
    throw error
  } finally {
    await lock.release()
    releaseActiveLock = null
    activeRunId = null
  }
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
