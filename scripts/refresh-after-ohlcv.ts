// scripts/refresh-after-ohlcv.ts
//
// OHLCV 取得後に、画面が参照する daily_snapshots と dashboard_cache を即時更新する。
// 株価だけ 1 日進んでステージ/ダッシュボードが前営業日のまま残る状態を防ぐ。

import { spawn } from 'node:child_process'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { batchRuns } from '@/lib/db/schema'
import { getDataFreshness } from '@/lib/server/data-freshness'
import { acquireUpdateLock } from '@/lib/server/update-lock'

type RunResult = {
  code: number | null
  signal: NodeJS.Signals | null
}

type FreshnessSummary = {
  expectedTradingDate: string
  latestOhlcvDate: string | null
  latestSnapshotDate: string | null
  latestDashboardCacheDate: string | null
  needsSnapshotUpdate: boolean
  needsDashboardCacheUpdate: boolean
}

function summarizeFreshness(freshness: Awaited<ReturnType<typeof getDataFreshness>>): FreshnessSummary {
  return {
    expectedTradingDate: freshness.expectedTradingDate,
    latestOhlcvDate: freshness.latestOhlcvDate,
    latestSnapshotDate: freshness.latestSnapshotDate,
    latestDashboardCacheDate: freshness.latestDashboardCacheDate,
    needsSnapshotUpdate: freshness.needsSnapshotUpdate,
    needsDashboardCacheUpdate: freshness.needsDashboardCacheUpdate,
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

async function runRequired(script: string): Promise<void> {
  console.log(`\n▶ ${script}`)
  const result = await runScript(script)
  if (result.code !== 0) {
    throw new Error(`${script} failed: code=${result.code}, signal=${result.signal ?? 'none'}`)
  }
}

async function main(): Promise<void> {
  if (process.env.POST_OHLCV_REFRESH === '0') {
    console.log('Post-OHLCV refresh skipped: POST_OHLCV_REFRESH=0')
    return
  }

  const skipLock = process.env.REFRESH_AFTER_OHLCV_SKIP_LOCK === '1'
  const lock = skipLock ? null : await acquireUpdateLock('post_ohlcv_refresh')
  if (!skipLock && !lock) {
    console.log('Post-OHLCV refresh skipped: post_ohlcv_refresh lock is already active')
    return
  }

  const [run] = await db
    .insert(batchRuns)
    .values({
      jobType: 'post_ohlcv_refresh',
      startedAt: new Date(),
      status: 'running',
    })
    .returning({ id: batchRuns.id })

  const runId = run.id

  try {
    const before = await getDataFreshness()
    console.log('Post-OHLCV freshness before:', summarizeFreshness(before))

    if (before.needsSnapshotUpdate) {
      await runRequired('scripts/batch-snapshots.ts')
      await lock?.heartbeat()
    } else {
      console.log('Snapshots are already fresh after OHLCV fetch')
    }

    const afterSnapshots = await getDataFreshness()
    if (afterSnapshots.needsDashboardCacheUpdate) {
      await runRequired('scripts/build-dashboard-cache.ts')
      await lock?.heartbeat()
    } else {
      console.log('Dashboard cache is already fresh after OHLCV fetch')
    }

    const after = await getDataFreshness()
    console.log('Post-OHLCV freshness after:', summarizeFreshness(after))

    if (after.needsSnapshotUpdate || after.needsDashboardCacheUpdate) {
      throw new Error('Post-OHLCV refresh did not complete snapshot/cache freshness')
    }

    await db
      .update(batchRuns)
      .set({
        finishedAt: new Date(),
        status: 'success',
        succeeded: 1,
        rowsInserted: Number(before.latestSnapshotDate !== after.latestSnapshotDate),
        errorSummary: null,
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
