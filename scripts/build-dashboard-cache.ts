// scripts/build-dashboard-cache.ts
//
// Dashboard Server Components が巨大テーブルを毎回集計しないよう、最新日用の
// 表示データを 1 JSON payload として dashboard_cache に保存する。

import { db } from '@/lib/db/client'
import { batchRuns } from '@/lib/db/schema'
import { buildDashboardCache } from '@/lib/queries/dashboard-cache'
import { eq } from 'drizzle-orm'

async function main() {
  const [run] = await db
    .insert(batchRuns)
    .values({
      jobType: 'dashboard_cache',
      startedAt: new Date(),
      status: 'running',
    })
    .returning({ id: batchRuns.id })

  const runId = run.id

  try {
    const payload = await buildDashboardCache()
    await db
      .update(batchRuns)
      .set({
        finishedAt: new Date(),
        status: payload ? 'success' : 'partial',
        succeeded: payload ? 1 : 0,
        rowsInserted: payload ? 1 : 0,
        errorSummary: payload ? null : 'No daily_snapshots date is available',
      })
      .where(eq(batchRuns.id, runId))

    console.log(payload
      ? `Dashboard cache updated: ${payload.latestDate}`
      : 'Dashboard cache skipped: no latest date')
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
  }
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
