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
    const { claimNextMlDatasetJob, executeMlDatasetJob, mlDatasetPaths } =
      await import('@/lib/server/trigger-ml-dataset-jobs')
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
    const claimed = await claimNextMlDatasetJob(deadOwner)
    assert.equal(claimed?.id, requeueId)
    assert.equal((await claimNextMlDatasetJob(deadOwner)), null)
    assert.ok(claimed)
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
