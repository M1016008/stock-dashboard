// scripts/cleanup-stale-batch-runs.ts
//
// Mark old batch_runs rows that are still "running" as failed/stale. This keeps
// dashboards and freshness checks from treating abandoned rows as active jobs.

import { execAll, execRun } from '@/lib/db/client'
import { execSync } from 'node:child_process'

type RunningBatchRun = {
  id: number
  job_type: string
  started_at: number
  error_summary: string | null
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

function activeProcessText(): string {
  try {
    return execSync('ps aux', { encoding: 'utf8', maxBuffer: 1024 * 1024 * 4 })
  } catch {
    return ''
  }
}

function looksActive(row: RunningBatchRun, psText: string): boolean {
  const job = row.job_type.toLowerCase()
  const hints = [
    job,
    job.replace(/_/g, '-'),
    job.replace(/_/g, ''),
    `batch-${job.replace(/^batch[-_]/, '').replace(/_/g, '-')}`,
  ].filter((hint) => hint.length >= 4)
  return hints.some((hint) => psText.toLowerCase().includes(hint))
}

async function main() {
  const ttlHours = Number(process.env.STALE_BATCH_TTL_HOURS ?? 6)
  const dryRun = process.env.DRY_RUN === '1'
  const cutoff = nowSeconds() - Math.max(1, ttlHours) * 3600
  const rows = await execAll<RunningBatchRun>(
    `
    SELECT id, job_type, started_at, error_summary
    FROM batch_runs
    WHERE status = 'running'
      AND started_at < ?
    ORDER BY started_at ASC
    `,
    [cutoff],
  )
  const psText = activeProcessText()
  const stale = rows.filter((row) => !looksActive(row, psText))
  const skipped = rows.filter((row) => looksActive(row, psText))

  if (!dryRun) {
    const finishedAt = nowSeconds()
    for (const row of stale) {
      const note = `[auto-stale] Marked failed at ${new Date(finishedAt * 1000).toISOString()} after ${ttlHours}h TTL; no matching local process was observed.`
      const errorSummary = row.error_summary ? `${row.error_summary}\n${note}` : note
      await execRun(
        `
        UPDATE batch_runs
        SET status = 'failed',
            finished_at = ?,
            error_summary = ?
        WHERE id = ?
          AND status = 'running'
        `,
        [finishedAt, errorSummary, row.id],
      )
    }
  }

  console.log(JSON.stringify({
    dryRun,
    ttlHours,
    candidates: rows.length,
    markedFailed: stale.map((row) => ({ id: row.id, jobType: row.job_type, startedAt: row.started_at })),
    skippedActive: skipped.map((row) => ({ id: row.id, jobType: row.job_type, startedAt: row.started_at })),
  }, null, 2))
}

main().catch((error) => {
  console.error('[cleanup-stale-batch-runs] failed:', error)
  process.exitCode = 1
})
