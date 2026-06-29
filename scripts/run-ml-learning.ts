// scripts/run-ml-learning.ts
//
// JP MLの日次serving更新/週次全量再学習の実行ラッパー。
// launchd から直接長い npm chain を起動せず、DB更新ロックの待機と二重起動防止を行う。

import { spawn, type ChildProcess } from 'node:child_process'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { batchRuns } from '@/lib/db/schema'
import { acquireUpdateLock, getActiveUpdateLocks } from '@/lib/server/update-lock'

type RunResult = {
  code: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
}

const JOB_TYPE = 'ml_learning'
const DEFAULT_BLOCKING_LOCKS = ['update_latest', 'post_ohlcv_refresh', 'us_update_latest'] as const
const MS_PER_DAY = 24 * 60 * 60 * 1000

let activeChild: ChildProcess | null = null
let shutdownSignal: NodeJS.Signals | null = null

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
  process.env.SQLITE_BUSY_RETRIES = process.env.SQLITE_BUSY_RETRIES ?? '240'
  process.env.UPDATE_CHILD_TIMEOUT_MINUTES = process.env.UPDATE_CHILD_TIMEOUT_MINUTES ?? '720'
}

function installSignalHandlers(): void {
  const handler = (signal: NodeJS.Signals) => {
    shutdownSignal = signal
    console.error(`Received ${signal}; stopping ML learning child process`)
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

function runHeavyMlChain(heartbeat: () => Promise<void>): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const timeoutMinutes = numberEnv('UPDATE_CHILD_TIMEOUT_MINUTES', 720)
    let timedOut = false

    const npmScript = process.env.ML_LEARNING_NPM_SCRIPT?.trim() || 'batch:ml-daily'
    activeChild = spawn('npm', ['run', npmScript], {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: {
        ...process.env,
        USE_LOCAL_DB: '1',
        SQLITE_BUSY_RETRIES: process.env.SQLITE_BUSY_RETRIES ?? '240',
        UPDATE_CHILD_TIMEOUT_MINUTES: process.env.UPDATE_CHILD_TIMEOUT_MINUTES ?? '720',
      },
    })

    const heartbeatTimer = setInterval(() => {
      heartbeat().catch((err) => {
        console.warn(`ML learning heartbeat failed: ${errorMessage(err)}`)
      })
    }, 60_000)

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
      clearInterval(heartbeatTimer)
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

  const leaseSeconds = numberEnv('ML_LEARNING_LOCK_LEASE_SECONDS', 18 * 60 * 60)
  const lock = await acquireUpdateLock(JOB_TYPE, leaseSeconds)
  if (!lock) {
    console.log('ML learning skipped: ml_learning lock is already active')
    return
  }

  const [run] = await db
    .insert(batchRuns)
    .values({
      jobType: JOB_TYPE,
      startedAt: new Date(),
      status: 'running',
    })
    .returning({ id: batchRuns.id })

  const runId = run.id
  const blockingLocks = parseCsv(process.env.ML_LEARNING_BLOCKING_LOCKS, DEFAULT_BLOCKING_LOCKS)

  try {
    console.log('ML learning daily wrapper started')
    console.log(`blocking locks: ${blockingLocks.join(', ')}`)
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

    await waitForBlockingLocks(blockingLocks)
    await lock.heartbeat()

    if (process.env.ML_LEARNING_PREFLIGHT_ONLY === '1') {
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

    const result = await runHeavyMlChain(() => lock.heartbeat())
    if (result.code !== 0) {
      throw new Error(`${process.env.ML_LEARNING_NPM_SCRIPT?.trim() || 'batch:ml-daily'} failed: code=${result.code}, signal=${result.signal ?? 'none'}`)
    }
    if (shutdownSignal) {
      throw new Error(`ML learning interrupted: ${shutdownSignal}`)
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
  }
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
