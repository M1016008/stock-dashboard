import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { ensureReady, execGet, execRun } from '@/lib/db/client'
import { cancelPathResearchJob, claimNextPathResearchJob } from '@/lib/server/trigger-path-research-jobs'
import { recoverWorkerJobs } from '@/lib/server/trigger-historical-worker-ownership'

async function main() {
  await ensureReady()
  const ids = [randomUUID(), randomUUID(), randomUUID()]
  const deadOwner = `worker:99999999:${'0'.repeat(20)}:${randomUUID()}`
  try {
    for (let index = 0; index < ids.length; index += 1) {
      await execRun(`INSERT INTO trigger_path_research_jobs (
        id,status,outcome_job_id,historical_scan_job_id,source_fingerprint,analysis_cutoff_date,
        created_at,expires_at) VALUES (?,'QUEUED',?,?,?,?,?,unixepoch()+3600)`,
      [ids[index], randomUUID(), randomUUID(), 'fixture', '2025-01-03', 100 + index])
    }
    const first = await claimNextPathResearchJob(deadOwner)
    assert.equal(first?.id, ids[0])
    assert.equal(await claimNextPathResearchJob(deadOwner), null, 'heavy-job concurrency guard')
    assert.equal((await recoverWorkerJobs('trigger_path_research_jobs', 'startup')).requeued, 1)
    assert.equal((await execGet<{ status: string }>('SELECT status FROM trigger_path_research_jobs WHERE id=?', [ids[0]]))?.status, 'QUEUED')
    const resumed = await claimNextPathResearchJob(deadOwner)
    assert.equal(resumed?.id, ids[0])
    assert.equal((await cancelPathResearchJob(ids[0]))?.status, 'CANCEL_REQUESTED')
    assert.equal((await recoverWorkerJobs('trigger_path_research_jobs', 'startup')).cancelled, 1)
    assert.equal((await execGet<{ status: string }>('SELECT status FROM trigger_path_research_jobs WHERE id=?', [ids[0]]))?.status, 'CANCELLED')
    assert.equal((await cancelPathResearchJob(ids[1]))?.status, 'CANCELLED')
    const last = await claimNextPathResearchJob(deadOwner)
    assert.equal(last?.id, ids[2])
    await execRun('UPDATE trigger_path_research_jobs SET attempt_count=2 WHERE id=?', [ids[2]])
    assert.equal((await recoverWorkerJobs('trigger_path_research_jobs', 'startup')).failed, 1)
    console.log('trigger-path-research-worker: PASS (single worker, restart, cancel, retry exhaustion)')
  } finally {
    for (const id of ids) await execRun('DELETE FROM trigger_path_research_jobs WHERE id=?', [id])
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
