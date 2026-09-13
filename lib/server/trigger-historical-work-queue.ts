import { randomUUID } from 'node:crypto'
import { execGet } from '@/lib/db/client'
import {
  cleanupExpiredHistoricalScanJobs,
  claimNextHistoricalScanJob,
  executeHistoricalScanJob,
  recoverStaleHistoricalScanJobs,
} from '@/lib/server/trigger-discovery-historical-scan-jobs'
import {
  cleanupExpiredOutcomeJobs,
  claimNextOutcomeJob,
  executeOutcomeAnalysisJob,
  recoverStaleOutcomeJobs,
} from '@/lib/server/trigger-discovery-outcome-jobs'

const DEFAULT_POLL_MS = 2_000
const CLEANUP_INTERVAL_MS = 60 * 60 * 1_000

type WorkType = 'HISTORICAL_SCAN' | 'OUTCOME_ANALYSIS'

function boundedIntegerEnv(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name])
  if (!Number.isInteger(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

async function nextWorkType(): Promise<WorkType | null> {
  const row = await execGet<{ job_type: WorkType }>(`SELECT job_type FROM (
      SELECT 'HISTORICAL_SCAN' AS job_type, created_at, id
      FROM historical_trigger_scan_jobs WHERE status='QUEUED'
      UNION ALL
      SELECT 'OUTCOME_ANALYSIS' AS job_type, created_at, id
      FROM trigger_outcome_analysis_jobs WHERE status='QUEUED'
    ) ORDER BY created_at, id LIMIT 1`)
  return row?.job_type ?? null
}

export async function runTriggerHistoricalWorkOnce(): Promise<{
  jobType: WorkType
  jobId: string
  status: string
} | null> {
  const type = await nextWorkType()
  if (type === 'HISTORICAL_SCAN') {
    const row = await claimNextHistoricalScanJob(randomUUID())
    if (!row) return null
    try {
      return { jobType: type, jobId: row.id, status: await executeHistoricalScanJob(row) }
    } catch (error) {
      console.error(`[trigger-historical-worker] type=${type} job=${row.id} failed`, error)
      return { jobType: type, jobId: row.id, status: 'FAILED' }
    }
  }
  if (type === 'OUTCOME_ANALYSIS') {
    const row = await claimNextOutcomeJob(randomUUID())
    if (!row) return null
    try {
      return { jobType: type, jobId: row.id, status: await executeOutcomeAnalysisJob(row) }
    } catch (error) {
      console.error(`[trigger-historical-worker] type=${type} job=${row.id} failed`, error)
      return { jobType: type, jobId: row.id, status: 'FAILED' }
    }
  }
  return null
}

export async function runTriggerHistoricalWorkLoop(): Promise<void> {
  const pollMs = boundedIntegerEnv('TRIGGER_HISTORICAL_SCAN_POLL_MS', DEFAULT_POLL_MS, 250, 30_000)
  let stopping = false
  const stop = () => { stopping = true }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  let lastCleanupAt = 0
  while (!stopping) {
    try {
      await cleanupExpiredHistoricalScanJobs()
      await cleanupExpiredOutcomeJobs()
      lastCleanupAt = Date.now()
      const recovered = {
        historical: await recoverStaleHistoricalScanJobs(),
        outcome: await recoverStaleOutcomeJobs(),
      }
      console.log(`[trigger-historical-worker] started concurrency=1 recovered=${JSON.stringify(recovered)}`)
      break
    } catch (error) {
      console.error('[trigger-historical-worker] startup retry', error)
      await new Promise((resolve) => setTimeout(resolve, pollMs))
    }
  }
  while (!stopping) {
    try {
      if (Date.now() - lastCleanupAt >= CLEANUP_INTERVAL_MS) {
        await cleanupExpiredHistoricalScanJobs()
        await cleanupExpiredOutcomeJobs()
        lastCleanupAt = Date.now()
      }
      const result = await runTriggerHistoricalWorkOnce()
      if (result) {
        console.log(`[trigger-historical-worker] type=${result.jobType} job=${result.jobId} status=${result.status}`)
        continue
      }
    } catch (error) {
      console.error('[trigger-historical-worker] poll retry', error)
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
  console.log('[trigger-historical-worker] stopped')
}
