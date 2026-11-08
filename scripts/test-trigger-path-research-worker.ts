import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { ensureReady, execGet, execRun } from '@/lib/db/client'
import {
  cancelPathResearchJob, claimNextPathResearchJob, cleanupExpiredPathResearchJobs,
} from '@/lib/server/trigger-path-research-jobs'
import { recoverWorkerJobs } from '@/lib/server/trigger-historical-worker-ownership'

async function main() {
  await ensureReady()
  const ids = [randomUUID(), randomUUID(), randomUUID()]
  const mlBlocker = randomUUID()
  const expired = randomUUID()
  const deadOwner = `worker:99999999:${'0'.repeat(20)}:${randomUUID()}`
  try {
    for (let index = 0; index < ids.length; index += 1) {
      await execRun(`INSERT INTO trigger_path_research_jobs (
        id,status,outcome_job_id,historical_scan_job_id,source_fingerprint,analysis_cutoff_date,
        created_at,expires_at) VALUES (?,'QUEUED',?,?,?,?,?,unixepoch()+3600)`,
      [ids[index], randomUUID(), randomUUID(), 'fixture', '2025-01-03', 100 + index])
    }
    assert.equal(await cancelPathResearchJob('not-a-uuid'), null)
    assert.equal(await cancelPathResearchJob(randomUUID()), null)
    await execRun(`INSERT INTO trigger_ml_dataset_jobs (id,status,path_research_job_id,outcome_job_id,
      historical_scan_job_id,source_fingerprint,split_policy_json,analysis_cutoff_date)
      VALUES (?,'CANCEL_REQUESTED',?,?,?,'fixture','{}','2025-01-03')`, [mlBlocker, randomUUID(), randomUUID(), randomUUID()])
    assert.equal(await claimNextPathResearchJob(deadOwner), null, 'cross-table guard blocks path while ML is active')
    await execRun('DELETE FROM trigger_ml_dataset_jobs WHERE id=?', [mlBlocker])
    const first = await claimNextPathResearchJob(deadOwner)
    assert.equal(first?.id, ids[0])
    assert.equal(first?.status, 'RUNNING')
    assert.equal(first?.owner_token, deadOwner)
    assert.equal(Number(first?.attempt_count), 1)
    assert.equal(Number(first?.cancel_requested), 0)
    assert.equal(first?.completed_at, null)
    assert.equal(first?.result_location, null)
    assert.equal(await claimNextPathResearchJob(deadOwner), null, 'heavy-job concurrency guard')
    assert.equal((await recoverWorkerJobs('trigger_path_research_jobs', 'startup')).requeued, 1)
    assert.equal((await execGet<{ status: string }>('SELECT status FROM trigger_path_research_jobs WHERE id=?', [ids[0]]))?.status, 'QUEUED')
    const resumed = await claimNextPathResearchJob(deadOwner)
    assert.equal(resumed?.id, ids[0])
    assert.equal((await cancelPathResearchJob(ids[0]))?.status, 'CANCEL_REQUESTED')
    assert.equal((await recoverWorkerJobs('trigger_path_research_jobs', 'startup')).cancelled, 1)
    assert.equal((await execGet<{ status: string }>('SELECT status FROM trigger_path_research_jobs WHERE id=?', [ids[0]]))?.status, 'CANCELLED')
    const queuedCancel = await execGet<{ status: string; cancel_requested: number; completed_at: number | null; heartbeat_at: number | null }>(
      'SELECT status,cancel_requested,completed_at,heartbeat_at FROM trigger_path_research_jobs WHERE id=?', [ids[1]])
    assert.equal(queuedCancel?.status, 'QUEUED')
    assert.equal((await cancelPathResearchJob(ids[1]))?.status, 'CANCELLED')
    const cancelledRow = await execGet<{ cancel_requested: number; completed_at: number | null; heartbeat_at: number | null }>(
      'SELECT cancel_requested,completed_at,heartbeat_at FROM trigger_path_research_jobs WHERE id=?', [ids[1]])
    assert.equal(Number(cancelledRow?.cancel_requested), 1)
    assert.ok(cancelledRow?.completed_at != null)
    assert.equal(cancelledRow?.heartbeat_at, queuedCancel?.heartbeat_at, 'path cancel does not touch heartbeat')
    const last = await claimNextPathResearchJob(deadOwner)
    assert.equal(last?.id, ids[2])
    await execRun('UPDATE trigger_path_research_jobs SET attempt_count=2 WHERE id=?', [ids[2]])
    assert.equal((await recoverWorkerJobs('trigger_path_research_jobs', 'startup')).failed, 1)
    await execRun(`INSERT INTO trigger_path_research_jobs (
      id,status,outcome_job_id,historical_scan_job_id,source_fingerprint,analysis_cutoff_date,
      created_at,expires_at) VALUES (?,'COMPLETED',?,?,'fixture','2025-01-03',99,unixepoch()-1)`,
    [expired, randomUUID(), randomUUID()])
    assert.equal(await cleanupExpiredPathResearchJobs(), 1, 'only the expired terminal job is eligible')
    assert.equal(await execGet('SELECT id FROM trigger_path_research_jobs WHERE id=?', [expired]), undefined)
    assert.equal(Number((await execGet<{ count: number }>(
      `SELECT COUNT(*) AS count FROM trigger_path_research_jobs WHERE id IN (?,?,?)`, ids))?.count), 3)
    console.log('trigger-path-research-worker: PASS (single worker, restart, cancel, retry exhaustion)')
  } finally {
    for (const id of [...ids, expired]) await execRun('DELETE FROM trigger_path_research_jobs WHERE id=?', [id])
    await execRun('DELETE FROM trigger_ml_dataset_jobs WHERE id=?', [mlBlocker])
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
