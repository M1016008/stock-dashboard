import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

async function main() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'stockboard-ml-worker-'))
  process.env.USE_LOCAL_DB = '1'
  process.env.STOCKBOARD_DB_PATH = path.join(directory, 'test.db')
  process.env.STOCKBOARD_ML_DATASET_DIR = directory
  try {
    const { ensureReady, client, execGet } = await import('@/lib/db/client')
    const { recoverWorkerJobs } = await import('@/lib/server/trigger-historical-worker-ownership')
    const mlJobs = await import('@/lib/server/trigger-ml-dataset-jobs')
    const { cancelMlDatasetJob, claimNextMlDatasetJob, executeMlDatasetJob, mlDatasetPaths } = mlJobs
    assert.equal(Object.keys(mlJobs).some((name) => /cleanup/i.test(name)), false, 'ML datasets have no cleanup')
    await ensureReady()
    const deadOwner = `worker:987654321:0123456789abcdef0123:${randomUUID()}`
    const requeueId = randomUUID()
    const cancelId = randomUUID()
    for (const [id, status] of [[requeueId, 'RUNNING'], [cancelId, 'CANCEL_REQUESTED']]) {
      await client.execute({ sql: `INSERT INTO trigger_ml_dataset_jobs
        (id,status,path_research_job_id,outcome_job_id,historical_scan_job_id,source_fingerprint,
         split_policy_json,analysis_cutoff_date,owner_token,attempt_count,heartbeat_at)
         VALUES (?,?,?,?,?,?,?,?,?,1,unixepoch()-400)`,
      args: [id, status, randomUUID(), randomUUID(), randomUUID(), 'fixture', '{}', '2025-01-01', deadOwner] })
    }
    const result = await recoverWorkerJobs('trigger_ml_dataset_jobs', 'startup')
    assert.deepEqual(result, { requeued: 1, failed: 0, cancelled: 1 })
    assert.equal((await execGet<{ status: string }>(
      'SELECT status FROM trigger_ml_dataset_jobs WHERE id=?', [requeueId]))?.status, 'QUEUED')
    assert.equal((await execGet<{ status: string }>(
      'SELECT status FROM trigger_ml_dataset_jobs WHERE id=?', [cancelId]))?.status, 'CANCELLED')
    assert.equal(await cancelMlDatasetJob('not-a-uuid'), null)
    assert.equal(await cancelMlDatasetJob(randomUUID()), null)
    const pathBlocker = randomUUID()
    await client.execute({ sql: `INSERT INTO trigger_path_research_jobs (id,status,outcome_job_id,
      historical_scan_job_id,source_fingerprint,analysis_cutoff_date,expires_at)
      VALUES (?,'RUNNING',?,?,'fixture','2025-01-01',unixepoch()+3600)`, args: [pathBlocker, randomUUID(), randomUUID()] })
    assert.equal(await claimNextMlDatasetJob(deadOwner), null, 'cross-table guard blocks ML while path research is active')
    await client.execute({ sql: 'DELETE FROM trigger_path_research_jobs WHERE id=?', args: [pathBlocker] })
    await client.execute({ sql: 'UPDATE trigger_ml_dataset_jobs SET completed_at=123 WHERE id=?', args: [requeueId] })
    const claimed = await claimNextMlDatasetJob(deadOwner)
    assert.equal(claimed?.id, requeueId)
    assert.equal(Number(claimed?.completed_at), 123, 'ML claim keeps its narrower column reset')
    assert.equal(Number(claimed?.attempt_count), 2)
    assert.equal((await claimNextMlDatasetJob(deadOwner)), null)
    assert.ok(claimed)
    const queuedCancelId = randomUUID()
    await client.execute({ sql: `INSERT INTO trigger_ml_dataset_jobs
      (id,status,path_research_job_id,outcome_job_id,historical_scan_job_id,source_fingerprint,
       split_policy_json,analysis_cutoff_date) VALUES (?,'QUEUED',?,?,?,'fixture','{}','2025-01-01')`,
    args: [queuedCancelId, randomUUID(), randomUUID(), randomUUID()] })
    assert.equal((await cancelMlDatasetJob(queuedCancelId))?.status, 'CANCELLED')
    assert.equal(Number((await execGet<{ cancel_requested: number }>(
      'SELECT cancel_requested FROM trigger_ml_dataset_jobs WHERE id=?', [queuedCancelId]))?.cancel_requested), 1)
    const paths = mlDatasetPaths(requeueId)
    const data = '{"fixture":"already published"}\n'
    const hash = createHash('sha256').update(data).digest('hex')
    await writeFile(paths.rows, data)
    await writeFile(paths.manifestTemp, JSON.stringify({ datasetId: requeueId,
      datasetSha256: hash, datasetArtifact: { bytes: Buffer.byteLength(data) },
      eventCount: 1, uniqueTickerCount: 1 }))
    assert.equal(await executeMlDatasetJob(claimed), 'COMPLETED')
    assert.equal((await execGet<{ status: string; result_sha256: string }>(
      'SELECT status,result_sha256 FROM trigger_ml_dataset_jobs WHERE id=?', [requeueId]))?.result_sha256, hash)
    assert.equal((await execGet<{ status: string }>(
      'SELECT status FROM trigger_ml_dataset_jobs WHERE id=?', [requeueId]))?.status, 'COMPLETED')
    console.log('trigger ML dataset worker recovery/cancellation/concurrency: PASS')
  } finally { await rm(directory, { recursive: true, force: true }) }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
