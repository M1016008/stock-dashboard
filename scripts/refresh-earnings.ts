// scripts/refresh-earnings.ts
//
// JPX公式Excel + J-Quants翌営業日APIの決算予定を軽量更新し、
// 個別銘柄用 serving とダッシュボードキャッシュへ即時反映する。

import { spawn } from 'node:child_process'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { batchRuns } from '@/lib/db/schema'
import {
  acquireJpStockboardUpdateLock,
  type UpdateLockHandle,
} from '@/lib/server/update-lock'

type RunResult = {
  code: number | null
  signal: NodeJS.Signals | null
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function numberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

async function acquireEarningsUpdateLock(): Promise<UpdateLockHandle | null> {
  const leaseSeconds = numberEnv('EARNINGS_REFRESH_LOCK_SECONDS', 2 * 60 * 60)
  const waitSeconds = numberEnv('EARNINGS_REFRESH_WAIT_FOR_LOCK_SECONDS', 45 * 60)
  const pollSeconds = numberEnv('EARNINGS_REFRESH_LOCK_POLL_SECONDS', 30)
  const startedAt = Date.now()
  let lastLogAt = 0

  for (;;) {
    const lock = await acquireJpStockboardUpdateLock('earnings_refresh', leaseSeconds)
    if (lock) return lock

    const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000)
    if (elapsedSeconds >= waitSeconds) return null
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

    child.on('error', reject)
    child.on('close', (code, signal) => resolve({ code, signal }))
  })
}

async function runRequired(script: string) {
  console.log(`\n▶ ${script}`)
  const result = await runScript(script)
  if (result.code !== 0) {
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
      if (attempt >= maxAttempts) break
      console.warn(`${script} failed; retrying in ${delaySeconds}s: ${error instanceof Error ? error.message : String(error)}`)
      await sleep(delaySeconds * 1000)
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

async function main() {
  const lock = process.env.EARNINGS_REFRESH_SKIP_LOCK === '1'
    ? null
    : await acquireEarningsUpdateLock()

  if (!lock && process.env.EARNINGS_REFRESH_SKIP_LOCK !== '1') {
    console.error('Earnings refresh could not acquire the JP DB writer lock before the timeout')
    process.exitCode = 75
    return
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
