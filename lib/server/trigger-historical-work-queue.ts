import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { execGet, localDbPath } from '@/lib/db/client'
import { guardForDatabase, isStorageIoError, requiresExternalStorageGuard, type ExternalStorageGuard } from '@/lib/storage/external-storage-guard'
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
import {
  claimNextPathResearchJob, cleanupExpiredPathResearchJobs, executePathResearchJob,
  recoverStalePathResearchJobs,
} from '@/lib/server/trigger-path-research-jobs'
import { claimNextMlDatasetJob, executeMlDatasetJob, recoverStaleMlDatasetJobs } from '@/lib/server/trigger-ml-dataset-jobs'
import {
  acquireHistoricalWorker,
  createWorkerIdentity,
  recoverWorkerJobs,
  releaseHistoricalWorker,
  type WorkerIdentity,
} from '@/lib/server/trigger-historical-worker-ownership'

const DEFAULT_POLL_MS = 2_000
const CLEANUP_INTERVAL_MS = 60 * 60 * 1_000

type WorkType = 'HISTORICAL_SCAN' | 'OUTCOME_ANALYSIS' | 'PATH_RESEARCH' | 'ML_DATASET'

function workerStorage(): ExternalStorageGuard | null {
  return requiresExternalStorageGuard(localDbPath) ? guardForDatabase(localDbPath, 'trigger-historical-worker') : null
}

async function withJobSleepProtection<T>(operation: () => Promise<T>): Promise<T> {
  if (process.platform !== 'darwin') return operation()
  // Hold an idle-sleep assertion only while a claimed write job is running.
  const assertion = spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' })
  assertion.on('error', (error) => console.error('[trigger-historical-worker] caffeinate unavailable', error))
  try { return await operation() }
  finally { assertion.kill('SIGTERM') }
}

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
      UNION ALL
      SELECT 'PATH_RESEARCH' AS job_type, created_at, id
      FROM trigger_path_research_jobs WHERE status='QUEUED'
      UNION ALL
      SELECT 'ML_DATASET' AS job_type, created_at, id
      FROM trigger_ml_dataset_jobs WHERE status='QUEUED'
    ) ORDER BY created_at, id LIMIT 1`)
  return row?.job_type ?? null
}

export async function runTriggerHistoricalWorkOnce(
  identity?: WorkerIdentity,
  shutdownSignal?: AbortSignal,
): Promise<{
  jobType: WorkType
  jobId: string
  status: string
} | null> {
  const type = await nextWorkType()
  if (type === 'HISTORICAL_SCAN') {
    const row = await claimNextHistoricalScanJob(identity?.jobOwner() ?? randomUUID())
    if (!row) return null
    const storage = workerStorage()
    storage?.setOperationContext(type, row.id)
    try {
      return { jobType: type, jobId: row.id, status: await withJobSleepProtection(() => executeHistoricalScanJob(row, { shutdownSignal })) }
    } catch (error) {
      if (isStorageIoError(error)) throw error
      console.error(`[trigger-historical-worker] type=${type} job=${row.id} failed`, error)
      return { jobType: type, jobId: row.id, status: 'FAILED' }
    } finally { storage?.clearOperationContext(row.id) }
  }
  if (type === 'OUTCOME_ANALYSIS') {
    const row = await claimNextOutcomeJob(identity?.jobOwner() ?? randomUUID())
    if (!row) return null
    const storage = workerStorage()
    storage?.setOperationContext(type, row.id)
    try {
      return { jobType: type, jobId: row.id, status: await withJobSleepProtection(() => executeOutcomeAnalysisJob(row, shutdownSignal)) }
    } catch (error) {
      if (isStorageIoError(error)) throw error
      console.error(`[trigger-historical-worker] type=${type} job=${row.id} failed`, error)
      return { jobType: type, jobId: row.id, status: 'FAILED' }
    } finally { storage?.clearOperationContext(row.id) }
  }
  if (type === 'PATH_RESEARCH') {
    const row = await claimNextPathResearchJob(identity?.jobOwner() ?? randomUUID())
    if (!row) return null
    const storage = workerStorage()
    storage?.setOperationContext(type, row.id)
    try {
      return { jobType: type, jobId: row.id, status: await withJobSleepProtection(() => executePathResearchJob(row, shutdownSignal)) }
    } catch (error) {
      if (isStorageIoError(error)) throw error
      console.error(`[trigger-historical-worker] type=${type} job=${row.id} failed`, error)
      return { jobType: type, jobId: row.id, status: 'FAILED' }
    } finally { storage?.clearOperationContext(row.id) }
  }
  if (type === 'ML_DATASET') {
    const row = await claimNextMlDatasetJob(identity?.jobOwner() ?? randomUUID())
    if (!row) return null
    const storage = workerStorage()
    storage?.setOperationContext(type, row.id)
    try {
      return { jobType: type, jobId: row.id, status: await withJobSleepProtection(() => executeMlDatasetJob(row, shutdownSignal)) }
    } catch (error) {
      if (isStorageIoError(error)) throw error
      console.error(`[trigger-historical-worker] type=${type} job=${row.id} failed`, error)
      return { jobType: type, jobId: row.id, status: 'FAILED' }
    } finally { storage?.clearOperationContext(row.id) }
  }
  return null
}

export async function runTriggerHistoricalWorkLoop(): Promise<void> {
  const storage = workerStorage()
  storage?.assertWritable(true)
  const pollMs = boundedIntegerEnv('TRIGGER_HISTORICAL_SCAN_POLL_MS', DEFAULT_POLL_MS, 250, 30_000)
  let stopping = false
  const shutdown = new AbortController()
  const stop = () => { stopping = true; shutdown.abort() }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  const identity = createWorkerIdentity()
  if (!await acquireHistoricalWorker(identity)) {
    process.removeListener('SIGTERM', stop)
    process.removeListener('SIGINT', stop)
    console.log('[trigger-historical-worker] another worker owns the queue; exiting')
    return
  }
  // Cheap device/DB identity checks between long write batches; the guard
  // refreshes the UUID only once per minute and latches any failure.
  const storageHeartbeat = storage ? setInterval(() => {
    try { storage.assertWritable() }
    catch (error) {
      console.error('[trigger-historical-worker] storage failed safe', error)
      stop()
    }
  }, 30_000) : null
  storageHeartbeat?.unref()
  let lastCleanupAt = 0
  let lastRecoveryAt = 0
  try {
    while (!stopping) {
      try {
        const recoveryStartedAt = performance.now()
        const recovered = {
          historical: await recoverWorkerJobs('historical_trigger_scan_jobs', 'startup'),
          outcome: await recoverWorkerJobs('trigger_outcome_analysis_jobs', 'startup'),
          pathResearch: await recoverWorkerJobs('trigger_path_research_jobs', 'startup'),
          mlDataset: await recoverWorkerJobs('trigger_ml_dataset_jobs', 'startup'),
        }
        await cleanupExpiredHistoricalScanJobs()
        await cleanupExpiredOutcomeJobs()
        await cleanupExpiredPathResearchJobs()
        lastCleanupAt = Date.now()
        lastRecoveryAt = lastCleanupAt
        console.log(`[trigger-historical-worker] started concurrency=1 instance=${identity.owner}`
          + ` recoveryMs=${(performance.now() - recoveryStartedAt).toFixed(1)}`
          + ` recovered=${JSON.stringify(recovered)}`)
        break
      } catch (error) {
        if (storage && isStorageIoError(error)) storage.classify(error)
        console.error('[trigger-historical-worker] startup retry', error)
        await new Promise((resolve) => setTimeout(resolve, pollMs))
      }
    }
    while (!stopping) {
      try {
        storage?.assertWritable()
        if (Date.now() - lastCleanupAt >= CLEANUP_INTERVAL_MS) {
          await cleanupExpiredHistoricalScanJobs()
          await cleanupExpiredOutcomeJobs()
          await cleanupExpiredPathResearchJobs()
          lastCleanupAt = Date.now()
        }
        const result = await runTriggerHistoricalWorkOnce(identity, shutdown.signal)
        if (result) {
          console.log(`[trigger-historical-worker] type=${result.jobType} job=${result.jobId} status=${result.status}`)
          continue
        }
        if (Date.now() - lastRecoveryAt >= 30_000) {
          await recoverStaleHistoricalScanJobs()
          await recoverStaleOutcomeJobs()
          await recoverStalePathResearchJobs()
          await recoverStaleMlDatasetJobs()
          await recoverWorkerJobs('historical_trigger_scan_jobs', 'startup')
          await recoverWorkerJobs('trigger_outcome_analysis_jobs', 'startup')
          await recoverWorkerJobs('trigger_path_research_jobs', 'startup')
          await recoverWorkerJobs('trigger_ml_dataset_jobs', 'startup')
          lastRecoveryAt = Date.now()
        }
      } catch (error) {
        if (storage && isStorageIoError(error)) storage.classify(error)
        console.error('[trigger-historical-worker] poll retry', error)
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs))
    }
  } finally {
    if (storageHeartbeat) clearInterval(storageHeartbeat)
    if (!storage?.fatalError) await releaseHistoricalWorker(identity)
    process.removeListener('SIGTERM', stop)
    process.removeListener('SIGINT', stop)
    console.log('[trigger-historical-worker] stopped')
  }
}
