// scripts/refresh-earnings.ts
//
// JPX公式Excel + J-Quants翌営業日APIの決算予定を軽量更新し、
// 個別銘柄用 serving とダッシュボードキャッシュへ即時反映する。

import { spawn } from 'node:child_process'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { batchRuns } from '@/lib/db/schema'
import { acquireUpdateLock } from '@/lib/server/update-lock'

type RunResult = {
  code: number | null
  signal: NodeJS.Signals | null
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

async function main() {
  const lock = process.env.EARNINGS_REFRESH_SKIP_LOCK === '1'
    ? null
    : await acquireUpdateLock('update_latest', 30 * 60)

  if (!lock && process.env.EARNINGS_REFRESH_SKIP_LOCK !== '1') {
    console.log('Earnings refresh skipped: update_latest lock is already active')
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
    await runRequired('scripts/batch-earnings.ts')
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
