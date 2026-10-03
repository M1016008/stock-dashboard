import { execGet } from '@/lib/db/client'
import { createOutcomeAnalysisJob, getOutcomeAnalysisJob } from '@/lib/server/trigger-discovery-outcome-jobs'
import { createPathResearchJob, getPathResearchJob } from '@/lib/server/trigger-path-research-jobs'
import { createMlDatasetJob, getMlDatasetJob } from '@/lib/server/trigger-ml-dataset-jobs'
import type { TriggerOutcomeEventSelector } from '@/lib/trigger-discovery-outcome-contract'

function option(name: string): string {
  const index = process.argv.indexOf(name)
  const value = process.argv[index + 1]
  if (index < 0 || !value || value.startsWith('--')) throw new Error(`missing ${name}`)
  return value
}

async function waitForCompletion(
  label: string,
  id: string,
  get: (id: string) => Promise<{ status: string; errorCategory?: string | null } | null>,
): Promise<void> {
  const deadline = Date.now() + 90 * 60_000
  while (Date.now() < deadline) {
    const job = await get(id)
    if (!job) throw new Error(`${label}_job_not_found`)
    if (job.status === 'COMPLETED') return
    if (job.status === 'FAILED' || job.status === 'CANCELLED') {
      throw new Error(`${label}_${job.status}:${job.errorCategory ?? 'unknown'}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000))
  }
  throw new Error(`${label}_timeout`)
}

async function main() {
  const scanId = option('--scan-id')
  const selector = option('--selector') as TriggerOutcomeEventSelector
  if (selector !== 'NEAR_ENTERED' && selector !== 'IN_ZONE_ENTERED'
    && selector !== 'STATUS_CHANGED') {
    throw new Error('15d_selector_not_preregistered')
  }
  const validationStart = option('--validation-start')
  const testStart = option('--test-start')
  for (const boundary of [validationStart, testStart]) {
    const session = await execGet<{ date: string }>(
      "SELECT date FROM ohlcv_daily WHERE ticker='7203' AND date=? LIMIT 1", [boundary],
    )
    if (!session) throw new Error(`split_boundary_not_market_session:${boundary}`)
  }
  const source = await execGet<{ status: string; request_json: string }>(
    'SELECT status,request_json FROM historical_trigger_scan_jobs WHERE id=?', [scanId],
  )
  if (source?.status !== 'COMPLETED' || !JSON.parse(source.request_json).researchLongRange) {
    throw new Error('not_completed_research_scan')
  }
  if (selector === 'STATUS_CHANGED'
    && (!JSON.parse(source.request_json).belowZoneToleranceEnabled
      || JSON.parse(source.request_json).maxBelowZonePct !== 3)) {
    throw new Error('below_zone_source_contract_mismatch')
  }
  const outcome = await createOutcomeAnalysisJob({ eventFilter: selector,
    horizons: [20, 60, 120, 245] }, scanId)
  console.log(JSON.stringify({ stage: 'outcome', jobId: outcome.jobId, status: outcome.status }))
  await waitForCompletion('outcome', outcome.jobId, getOutcomeAnalysisJob)
  const path = await createPathResearchJob(outcome.jobId)
  console.log(JSON.stringify({ stage: 'path', jobId: path.jobId, status: path.status }))
  await waitForCompletion('path', path.jobId, getPathResearchJob)
  const datasetId = await createMlDatasetJob({ pathResearchJobId: path.jobId,
    splitPolicy: { validationStart, testStart, embargoSessions: 0 } })
  console.log(JSON.stringify({ stage: 'dataset', jobId: datasetId, status: 'QUEUED' }))
  await waitForCompletion('dataset', datasetId, getMlDatasetJob)
  const dataset = await getMlDatasetJob(datasetId)
  if (!dataset?.manifest) throw new Error('dataset_manifest_unavailable')
  console.log(JSON.stringify({ status: 'COMPLETED', scanId, selector,
    outcomeId: outcome.jobId, pathId: path.jobId, datasetId,
    rows: dataset.manifest.rowCount, events: dataset.manifest.eventCount,
    artifactBytes: dataset.artifactBytes, datasetSha256: dataset.manifest.datasetSha256,
    sourceRange: [dataset.manifest.eventDateMin, dataset.manifest.eventDateMax],
    splitPolicy: dataset.manifest.splitPolicy }, null, 2))
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
