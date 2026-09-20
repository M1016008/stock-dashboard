import { execGet } from '@/lib/db/client'
import {
  createOutcomeAnalysisJob, getOutcomeAnalysisJob,
} from '@/lib/server/trigger-discovery-outcome-jobs'
import {
  createPathResearchJob, getPathResearchJob,
} from '@/lib/server/trigger-path-research-jobs'
import {
  createMlDatasetJob, getMlDatasetJob,
} from '@/lib/server/trigger-ml-dataset-jobs'
import { RESEARCH_LONG_SCAN_VERSION } from '@/lib/server/trigger-research-long-scan'
import { historicalScanResultPaths } from '@/lib/server/trigger-discovery-historical-scan-jobs'
import { readFile } from 'node:fs/promises'
import type { TriggerHistoricalScanResponse } from '@/lib/trigger-discovery-historical-scan-contract'

const scanId = process.argv[2]
if (!scanId) throw new Error('usage: tsx scripts/run-trigger-research-long-pipeline.ts <research-scan-id>')

async function waitForCompletion(
  label: string, id: string,
  get: (id: string) => Promise<{ status: string; errorCategory?: string | null } | null>,
): Promise<void> {
  const deadline = Date.now() + 60 * 60 * 1_000
  while (Date.now() < deadline) {
    const state = await get(id)
    if (!state) throw new Error(`${label}_job_not_found`)
    if (state.status === 'COMPLETED') return
    if (['FAILED', 'CANCELLED'].includes(state.status)) {
      throw new Error(`${label}_${state.status}:${state.errorCategory ?? 'unknown'}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000))
  }
  throw new Error(`${label}_job_timeout`)
}

async function main() {
  const before = await execGet<{ status: string; request_json: string }>(
    'SELECT status,request_json FROM historical_trigger_scan_jobs WHERE id=?', [scanId])
  if (before?.status !== 'COMPLETED'
    || !JSON.parse(before.request_json).researchLongRange) throw new Error('not_completed_research_scan')
  const scanManifest = JSON.parse(await readFile(historicalScanResultPaths(scanId).manifest, 'utf8')) as TriggerHistoricalScanResponse
  if (scanManifest.researchProvenance?.version !== RESEARCH_LONG_SCAN_VERSION) {
    throw new Error('research_scan_version_not_current')
  }
  const outcome = await createOutcomeAnalysisJob({ eventFilter: 'NEAR_ENTERED',
    horizons: [20, 60, 120, 245] }, scanId)
  console.log(JSON.stringify({ stage: 'outcome', jobId: outcome.jobId, status: outcome.status }))
  await waitForCompletion('outcome', outcome.jobId, getOutcomeAnalysisJob)
  const path = await createPathResearchJob(outcome.jobId)
  console.log(JSON.stringify({ stage: 'path', jobId: path.jobId, status: path.status }))
  await waitForCompletion('path', path.jobId, getPathResearchJob)
  const datasetId = await createMlDatasetJob({ pathResearchJobId: path.jobId,
    splitPolicy: { validationStart: '2024-01-04', testStart: '2025-01-06', embargoSessions: 0 } })
  console.log(JSON.stringify({ stage: 'dataset', jobId: datasetId, status: 'QUEUED' }))
  await waitForCompletion('dataset', datasetId, getMlDatasetJob)
  const dataset = await getMlDatasetJob(datasetId)
  if (!dataset?.manifest) throw new Error('dataset_manifest_unavailable')
  console.log(JSON.stringify({ status: 'COMPLETED', scanId, outcomeId: outcome.jobId,
    pathId: path.jobId, datasetId, rows: dataset.manifest.rowCount,
    splitPolicy: dataset.manifest.splitPolicy,
    byHorizon: dataset.manifest.evaluationEligibleByHorizonSplit,
    byCheckpoint: dataset.manifest.rowsByCheckpoint,
    artifactBytes: dataset.artifactBytes }, null, 2))
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
