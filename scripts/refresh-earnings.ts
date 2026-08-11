// scripts/refresh-earnings.ts
//
// JPX公式Excel + J-Quants翌営業日APIの決算予定を軽量更新し、
// 個別銘柄用 serving とダッシュボードキャッシュへ即時反映する。

import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { db, execGet } from '@/lib/db/client'
import { batchRuns } from '@/lib/db/schema'
import {
  acquireJpStockboardUpdateLock,
  type UpdateLockHandle,
} from '@/lib/server/update-lock'

type RunResult = {
  code: number | null
  signal: NodeJS.Signals | null
}

const deferredPath = path.resolve(
  process.env.EARNINGS_REFRESH_DEFERRED_PATH?.trim()
    || path.join(os.homedir(), 'Library', 'Application Support', 'StockBoard', 'earnings-refresh-deferred'),
)
let shutdownSignal: NodeJS.Signals | null = null
let activeChild: ChildProcess | null = null

function requestShutdown(signal: NodeJS.Signals): void {
  if (shutdownSignal) return
  shutdownSignal = signal
  console.warn(`Earnings refresh received ${signal}; stopping the active child cleanly.`)
  activeChild?.kill(signal)
  const forceExit = setTimeout(() => process.exit(signal === 'SIGINT' ? 130 : 143), 30_000)
  forceExit.unref()
}

process.once('SIGINT', () => requestShutdown('SIGINT'))
process.once('SIGTERM', () => requestShutdown('SIGTERM'))

function markDeferred(): void {
  fs.mkdirSync(path.dirname(deferredPath), { recursive: true })
  const temporaryPath = `${deferredPath}.${process.pid}.tmp`
  fs.writeFileSync(temporaryPath, `${new Date().toISOString()}\n`, { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(temporaryPath, deferredPath)
}

function clearDeferred(): void {
  try {
    fs.unlinkSync(deferredPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function numberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

async function acquireEarningsUpdateLock(): Promise<{
  lock: UpdateLockHandle | null
  waited: boolean
}> {
  const leaseSeconds = numberEnv('EARNINGS_REFRESH_LOCK_SECONDS', 2 * 60 * 60)
  const waitSeconds = numberEnv('EARNINGS_REFRESH_WAIT_FOR_LOCK_SECONDS', 45 * 60)
  const pollSeconds = numberEnv('EARNINGS_REFRESH_LOCK_POLL_SECONDS', 30)
  const startedAt = Date.now()
  let lastLogAt = 0
  let waited = false

  for (;;) {
    if (shutdownSignal) throw new Error(`Earnings refresh interrupted by ${shutdownSignal}.`)
    const lock = await acquireJpStockboardUpdateLock('earnings_refresh', leaseSeconds)
    if (lock) {
      clearDeferred()
      return { lock, waited }
    }
    waited = true
    markDeferred()

    const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000)
    if (elapsedSeconds >= waitSeconds) return { lock: null, waited }
    if (lastLogAt === 0 || Date.now() - lastLogAt >= 60_000) {
      lastLogAt = Date.now()
      console.log(
        `Earnings refresh waiting for a JP StockBoard writer: `
        + `elapsed=${elapsedSeconds}s, timeout=${waitSeconds}s`,
      )
    }
    await sleep(Math.min(pollSeconds, Math.max(1, waitSeconds - elapsedSeconds)) * 1000)
  }
}

function runScript(script: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['tsx', '--env-file=.env.local', script], {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: {
        ...process.env,
        USE_LOCAL_DB: '1',
      },
    })
    activeChild = child

    child.on('error', (error) => {
      if (activeChild === child) activeChild = null
      reject(error)
    })
    child.on('close', (code, signal) => {
      if (activeChild === child) activeChild = null
      resolve({ code, signal })
    })
  })
}

async function runRequired(script: string) {
  if (shutdownSignal) throw new Error(`${script} skipped after ${shutdownSignal}.`)
  console.log(`\n▶ ${script}`)
  const result = await runScript(script)
  if (result.code !== 0 || result.signal || shutdownSignal) {
    throw new Error(`${script} failed: code=${result.code}, signal=${result.signal ?? 'none'}`)
  }
}

async function runRequiredWithRetry(script: string): Promise<void> {
  const maxAttempts = numberEnv('EARNINGS_REFRESH_MAX_ATTEMPTS', 3)
  const delaySeconds = numberEnv('EARNINGS_REFRESH_RETRY_DELAY_SECONDS', 300)
  let lastError: unknown = null

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      if (attempt > 1) console.log(`Retrying ${script}: attempt ${attempt}/${maxAttempts}`)
      await runRequired(script)
      return
    } catch (error) {
      lastError = error
      if (shutdownSignal) throw error
      if (attempt >= maxAttempts) break
      console.warn(`${script} failed; retrying in ${delaySeconds}s: ${error instanceof Error ? error.message : String(error)}`)
      await sleep(delaySeconds * 1000)
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

async function main() {
  const processStartedAt = Math.floor(Date.now() / 1000)
  const skipLock = process.env.EARNINGS_REFRESH_SKIP_LOCK === '1'
  if (skipLock) clearDeferred()
  const acquisition = skipLock
    ? { lock: null, waited: false }
    : await acquireEarningsUpdateLock()
  const lock = acquisition.lock

  if (!lock && !skipLock) {
    console.warn('Earnings refresh deferred; launchd will retry while the JP writer is active')
    process.exitCode = 75
    return
  }

  if (lock && acquisition.waited) {
    const completedWhileWaiting = await execGet<{ id: number }>(
      `SELECT id
       FROM batch_runs
       WHERE job_type = 'earnings_refresh'
         AND status = 'success'
         AND finished_at >= ?
       ORDER BY finished_at DESC
       LIMIT 1`,
      [processStartedAt],
    )
    if (completedWhileWaiting) {
      console.log('Earnings refresh skipped because another refresh completed while this job waited.')
      await lock.release()
      return
    }
  }

  const [run] = await db
    .insert(batchRuns)
    .values({
      jobType: 'earnings_refresh',
      startedAt: new Date(),
      status: 'running',
    })
    .returning({ id: batchRuns.id })

  const runId = run.id

  try {
    await runRequiredWithRetry('scripts/batch-earnings.ts')
    await lock?.heartbeat()
    await runRequiredWithRetry('scripts/batch-earnings-times.ts')
    await lock?.heartbeat()
    await runRequired('scripts/build-serving-stock.ts')
    await lock?.heartbeat()
    await runRequired('scripts/build-dashboard-cache.ts')

    await db
      .update(batchRuns)
      .set({
        finishedAt: new Date(),
        status: 'success',
        succeeded: 1,
        rowsInserted: 1,
      })
      .where(eq(batchRuns.id, runId))
  } catch (err) {
    await db
      .update(batchRuns)
      .set({
        finishedAt: new Date(),
        status: 'failed',
        failed: 1,
        errorSummary: err instanceof Error ? err.message : String(err),
      })
      .where(eq(batchRuns.id, runId))
    throw err
  } finally {
    await lock?.release()
  }
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
