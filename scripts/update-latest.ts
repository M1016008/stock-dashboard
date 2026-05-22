// scripts/update-latest.ts
//
// サイト表示に必要な最新日付を保つためのオーケストレーター。
// J-Quants 差分取得 → スナップショット計算を、重複起動しないようロックして順番に実行する。

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
  const lock = await acquireUpdateLock('update_latest')
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

  try {
    console.log('Latest data update started')

    // 軽量な補助データは毎回同期する。主画面の鮮度に直接関わる OHLCV / snapshot は必要時のみ。
    await runRequired('scripts/batch-indices.ts')
    await lock.heartbeat()
    await runRequired('scripts/batch-earnings.ts')
    await lock.heartbeat()

    const before = await getDataFreshness()
    console.log('Freshness before:', before)

    if (before.needsOhlcvUpdate) {
      await runRequired('scripts/batch-ohlcv.ts')
      await lock.heartbeat()
    } else {
      console.log('OHLCV is already fresh')
    }

    const afterOhlcv = await getDataFreshness()
    if (afterOhlcv.needsSnapshotUpdate) {
      await runRequired('scripts/batch-snapshots.ts')
      await lock.heartbeat()
    } else {
      console.log('Snapshots are already fresh')
    }

    await runRequired('scripts/batch-features.ts')
    await lock.heartbeat()
    await runRequired('scripts/build-dashboard-cache.ts')
    await lock.heartbeat()

    const after = await getDataFreshness()
    console.log('Freshness after:', after)
    rowsInserted = Number(after.latestSnapshotDate !== before.latestSnapshotDate)

    await db
      .update(batchRuns)
      .set({
        finishedAt: new Date(),
        status: after.needsUpdate ? 'partial' : 'success',
        succeeded: 1,
        rowsInserted,
        errorSummary: after.needsUpdate ? JSON.stringify(after) : null,
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
    await lock.release()
  }
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
