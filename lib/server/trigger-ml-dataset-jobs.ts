import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { client, ensureReady, execGet, execRun } from '@/lib/db/client'
import { historicalScanResultPaths } from '@/lib/server/trigger-discovery-historical-scan-jobs'
import { outcomeResultPaths } from '@/lib/server/trigger-discovery-outcome-jobs'
import { loadSegmentationSource } from '@/lib/server/trigger-discovery-outcome-segmentation'
import { getPathResearchArtifact, pathResearchResultPaths } from '@/lib/server/trigger-path-research-jobs'
import { generateMlDataset } from '@/lib/server/trigger-ml-dataset-batch'
import {
  JOB_ID_PATTERN as UUID, cancelWorkerJob, claimWorkerJob, hashFile, readLines, recoverWorkerJobs,
} from '@/lib/server/trigger-historical-worker-ownership'
import type { TriggerHistoricalScanEvent, TriggerHistoricalScanRequest } from '@/lib/trigger-discovery-historical-scan-contract'
import type { TriggerOutcomeRow } from '@/lib/trigger-discovery-outcome-contract'
import { TRIGGER_ML_CHECKPOINTS, TRIGGER_ML_FEATURE_REGISTRY, TRIGGER_ML_FEATURE_SCHEMA_VERSION,
  TRIGGER_ML_LABEL_REGISTRY, TRIGGER_ML_LABEL_SCHEMA_VERSION,
  type TriggerMlDatasetManifest, type TriggerMlSplitPolicy } from '@/lib/trigger-ml-dataset-contract'
import type { PathResearchRow } from '@/lib/trigger-path-research-contract'
import { TRIGGER_PATH_CONTRACT_VERSION } from '@/lib/trigger-path-contract'

const TABLE = 'trigger_ml_dataset_jobs'
type Row = {
  id: string; status: string; path_research_job_id: string; outcome_job_id: string
  historical_scan_job_id: string; source_fingerprint: string; split_policy_json: string
  analysis_cutoff_date: string; created_at: number; started_at: number | null
  completed_at: number | null; heartbeat_at: number | null; total_events: number
  processed_events: number; total_tickers: number; processed_tickers: number
  result_location: string | null; result_size_bytes: number; result_sha256: string | null
  duration_ms: number; error_category: string | null; cancel_requested: number
  owner_token: string | null; attempt_count: number
}

function root(): string {
  return process.env.STOCKBOARD_ML_DATASET_DIR?.trim()
    || path.join(os.homedir(), 'Library', 'Application Support', 'StockBoard', 'trigger-ml-datasets')
}
export function mlDatasetPaths(id: string) {
  if (!UUID.test(id)) throw new Error('invalid_dataset_id')
  const base = path.join(root(), id)
  return { rows: `${base}.ndjson`, manifest: `${base}.json`,
    rowsTemp: `${base}.ndjson.tmp`, manifestTemp: `${base}.json.tmp` }
}

async function hashArtifact(manifest: string, rows: string): Promise<string> {
  const [metadata, data] = await Promise.all([hashFile(manifest), hashFile(rows)])
  return createHash('sha256').update(`${metadata}:${data}`).digest('hex')
}

async function source(pathJobId: string) {
  const pathArtifact = await getPathResearchArtifact(pathJobId)
  if (!pathArtifact || typeof pathArtifact === 'string') throw new Error('ml_path_source_unavailable')
  const { manifest: pathManifest } = pathArtifact
  const scanRow = await execGet<{ request_json: string }>(
    'SELECT request_json FROM historical_trigger_scan_jobs WHERE id=?', [pathManifest.historicalScanJobId])
  if (!scanRow) throw new Error('ml_scan_source_unavailable')
  const sourceRequest = JSON.parse(scanRow.request_json) as TriggerHistoricalScanRequest
  const [outcome, scan] = await Promise.all([
    loadSegmentationSource(pathManifest.outcomeJobId),
    Promise.resolve(historicalScanResultPaths(pathManifest.historicalScanJobId)),
  ])
  if (outcome.outcome.historicalScanJobId !== pathManifest.historicalScanJobId
    || outcome.outcome.outcomeJobId !== pathManifest.outcomeJobId
    || pathManifest.generatedRowCount !== outcome.outcome.summary.selectedEventCount) {
    throw new Error('ml_source_chain_mismatch')
  }
  const [scanSha, outcomeSha, pathSha] = await Promise.all([
    hashArtifact(scan.manifest, scan.events),
    hashArtifact(outcomeResultPaths(pathManifest.outcomeJobId).manifest, outcome.rowsFile),
    hashArtifact(pathResearchResultPaths(pathJobId).manifest, pathArtifact.rowsFile),
  ])
  const hashes = { scan: scanSha, outcome: outcomeSha, path: pathSha }
  const fingerprint = createHash('sha256').update(JSON.stringify({ hashes,
    pathSource: pathManifest.sourceFingerprint, sourceRequest,
    analysisCutoffDate: pathManifest.analysisCutoffDate,
  })).digest('hex')
  return { pathArtifact, outcome, scan, hashes, fingerprint, sourceRequest }
}

async function rowFor(id: string): Promise<Row | null> {
  return UUID.test(id) ? (await execGet<Row>(`SELECT * FROM ${TABLE} WHERE id=?`, [id])) ?? null : null
}

export async function createMlDatasetJob(input: {
  pathResearchJobId: string
  splitPolicy?: Partial<Pick<TriggerMlSplitPolicy, 'validationStart' | 'testStart' | 'embargoSessions'>>
}): Promise<string> {
  if (!UUID.test(input.pathResearchJobId)) throw new Error('invalid_path_research_job_id')
  const checked = await source(input.pathResearchJobId)
  const dates = input.splitPolicy
  if (dates?.validationStart && !/^\d{4}-\d{2}-\d{2}$/.test(dates.validationStart)) throw new Error('invalid_validation_start')
  if (dates?.testStart && !/^\d{4}-\d{2}-\d{2}$/.test(dates.testStart)) throw new Error('invalid_test_start')
  if (dates?.embargoSessions != null && (!Number.isInteger(dates.embargoSessions)
    || dates.embargoSessions < 0 || dates.embargoSessions > 245)) throw new Error('invalid_embargo_sessions')
  await ensureReady()
  const id = randomUUID()
  await execRun(`INSERT INTO ${TABLE} (id,status,path_research_job_id,outcome_job_id,historical_scan_job_id,
    source_fingerprint,split_policy_json,analysis_cutoff_date,total_events)
    VALUES (?,'QUEUED',?,?,?,?,?,?,?)`, [id, input.pathResearchJobId,
    checked.pathArtifact.manifest.outcomeJobId, checked.pathArtifact.manifest.historicalScanJobId,
    checked.fingerprint, JSON.stringify(input.splitPolicy ?? {}), checked.pathArtifact.manifest.analysisCutoffDate,
    checked.pathArtifact.manifest.generatedRowCount])
  return id
}

export async function getMlDatasetJob(id: string): Promise<MlDatasetJobView | null> {
  const row = await rowFor(id)
  return row ? jobView(row) : null
}

type MlDatasetJobView = {
  datasetId: string; status: string; progress: { processedEvents: number; totalEvents: number }
  resultAvailable: boolean; errorCategory: string | null; artifactBytes: number
  manifest: TriggerMlDatasetManifest | null
}

async function jobView(row: Row): Promise<MlDatasetJobView> {
  const id = row.id
  let manifest: TriggerMlDatasetManifest | null = null
  if (row.status === 'COMPLETED' && row.result_location === id) {
    try {
      manifest = JSON.parse(await readFile(/* turbopackIgnore: true */ mlDatasetPaths(id).manifest, 'utf8')) as TriggerMlDatasetManifest
      await stat(/* turbopackIgnore: true */ mlDatasetPaths(id).rows)
    } catch { manifest = null }
  }
  return { datasetId: id, status: row.status,
    progress: { processedEvents: Number(row.processed_events), totalEvents: Number(row.total_events) },
    resultAvailable: manifest != null, errorCategory: row.error_category,
    artifactBytes: Number(row.result_size_bytes), manifest }
}

export async function cancelMlDatasetJob(id: string) {
  const row = await cancelWorkerJob<Row>(TABLE, id, 'direct')
  return row ? jobView(row) : null
}

export async function claimNextMlDatasetJob(ownerToken: string = randomUUID()): Promise<Row | null> {
  // ML keeps its narrower reset: completed_at, cancel_requested and result columns are left untouched.
  return claimWorkerJob<Row>(TABLE, `started_at=unixepoch(),
    heartbeat_at=unixepoch(),owner_token=?,attempt_count=attempt_count+1,processed_events=0,
    processed_tickers=0,error_category=NULL`, () => [ownerToken],
    { guardLookup: false, ensureReadyBeforeClaim: false })
}

async function progress(row: Row, processedEvents: number, totalEvents: number,
  processedTickers: number, totalTickers: number, signal: AbortController): Promise<void> {
  const result = await client.execute({ sql: `UPDATE ${TABLE} SET processed_events=?,total_events=?,
    processed_tickers=?,total_tickers=?,heartbeat_at=unixepoch()
    WHERE id=? AND owner_token=? AND status='RUNNING' AND cancel_requested=0`,
  args: [processedEvents, totalEvents, processedTickers, totalTickers, row.id, row.owner_token] })
  if (Number(result.rowsAffected) !== 1) {
    signal.abort()
    throw new DOMException('ML dataset cancelled', 'AbortError')
  }
}

export async function executeMlDatasetJob(row: Row, shutdownSignal?: AbortSignal): Promise<string> {
  if (row.status !== 'RUNNING' || !row.owner_token) throw new Error('ml_dataset_job_not_claimed')
  const start = performance.now()
  const controller = new AbortController()
  const abort = () => controller.abort()
  shutdownSignal?.addEventListener('abort', abort, { once: true })
  if (shutdownSignal?.aborted) controller.abort()
  const paths = mlDatasetPaths(row.id)
  await mkdir(root(), { recursive: true })
  try {
    // A worker can die after publishing files but before recording completion. Never overwrite that snapshot.
    let manifest: TriggerMlDatasetManifest
    let size: number
    if (!(await stat(/* turbopackIgnore: true */ paths.manifest).then(() => true, () => false))
      && await stat(/* turbopackIgnore: true */ paths.rows).then(() => true, () => false)) {
      const pending = await readFile(/* turbopackIgnore: true */ paths.manifestTemp, 'utf8')
        .then((value) => JSON.parse(value) as TriggerMlDatasetManifest,
          () => { throw new Error('incomplete_immutable_dataset_artifact') })
      if (pending.datasetId !== row.id || pending.datasetSha256 !== await hashFile(paths.rows)) {
        throw new Error('immutable_dataset_artifact_conflict')
      }
      await rename(paths.manifestTemp, paths.manifest)
    }
    if (await stat(/* turbopackIgnore: true */ paths.manifest).then(() => true, () => false)) {
      manifest = JSON.parse(await readFile(/* turbopackIgnore: true */ paths.manifest, 'utf8'))
      if (manifest.datasetId !== row.id || manifest.datasetSha256 !== await hashFile(paths.rows)) {
        throw new Error('immutable_dataset_artifact_conflict')
      }
      size = manifest.datasetArtifact.bytes
    } else {
      await rm(paths.rowsTemp, { force: true })
      await rm(paths.manifestTemp, { force: true })
      const checked = await source(row.path_research_job_id)
      if (checked.fingerprint !== row.source_fingerprint) throw new Error('ml_source_changed')
      const sourceStart = performance.now()
      const [pathRows, outcomes, historicalEvents] = await Promise.all([
        readLines<PathResearchRow>(checked.pathArtifact.rowsFile),
        readLines<TriggerOutcomeRow>(checked.outcome.rowsFile),
        readLines<TriggerHistoricalScanEvent>(checked.outcome.historicalEventsFile),
      ])
      const sourceLoadMs = performance.now() - sourceStart
      const built = await generateMlDataset({ datasetId: row.id, pathRows,
        outcomeRows: outcomes, historicalEvents, outcomeManifest: checked.outcome.outcome,
        historical: checked.outcome.historical, sourceRequest: checked.sourceRequest,
        analysisCutoffDate: row.analysis_cutoff_date,
        splitOverrides: JSON.parse(row.split_policy_json), file: paths.rowsTemp,
        signal: controller.signal,
        onProgress: (events, total, tickers, tickerTotal) => progress(row, events, total, tickers, tickerTotal, controller),
      })
      if (controller.signal.aborted) throw new DOMException('ML dataset cancelled', 'AbortError')
      if ((await source(row.path_research_job_id)).fingerprint !== row.source_fingerprint) {
        throw new Error('ml_source_changed')
      }
      const shaStarted = performance.now()
      if (await hashFile(paths.rowsTemp) !== built.hash) throw new Error('ml_dataset_sha_mismatch')
      const shaMs = performance.now() - shaStarted
      manifest = {
        datasetId: row.id, generatedAt: new Date().toISOString(),
        analysisCutoffDate: row.analysis_cutoff_date,
        sourceHistoricalScanJobId: row.historical_scan_job_id,
        sourceOutcomeJobId: row.outcome_job_id, sourcePathResearchJobId: row.path_research_job_id,
        sourceSha256: checked.hashes,
        ...(checked.outcome.historical.researchProvenance
          ? { researchProvenance: checked.outcome.historical.researchProvenance } : {}),
        featureSchemaVersion: TRIGGER_ML_FEATURE_SCHEMA_VERSION,
        labelSchemaVersion: TRIGGER_ML_LABEL_SCHEMA_VERSION,
        pathSchemaVersion: TRIGGER_PATH_CONTRACT_VERSION,
        checkpoints: TRIGGER_ML_CHECKPOINTS,
        featureColumns: TRIGGER_ML_FEATURE_REGISTRY,
        labelColumns: TRIGGER_ML_LABEL_REGISTRY,
        ...built.summary,
        ...(checked.outcome.historical.researchProvenance ? { temporalFolds: [{
          id: 'fold1', validationStart: built.summary.splitPolicy.validationStart,
          testStart: built.summary.splitPolicy.testStart,
          embargoSessions: built.summary.splitPolicy.embargoSessions,
        }] } : {}),
        timeframe: checked.outcome.historical.scanMeta.timeframe,
        ma1Period: checked.outcome.historical.scanMeta.ma1Period,
        ma2Period: checked.outcome.historical.scanMeta.ma2Period,
        sourceFilters: { ...checked.outcome.historical.criteria,
          sourceTriggerConfig: checked.sourceRequest,
          outcomeEventSelector: checked.outcome.outcome.request.eventFilter,
          outcomeRequest: checked.outcome.outcome.request },
        sourceUniverseContract: checked.outcome.historical.scanMeta.universeNote,
        repeatedEventNote: 'Observations can repeat per ticker/episode; split assigned by earliest episode event.',
        datasetArtifact: { format: 'NDJSON', location: paths.rows, bytes: built.bytes },
        datasetSha256: built.hash,
        trainingInputPolicy: 'FEATURE_REGISTRY_ONLY',
        performance: { ...built.performance, sourceLoadMs, shaMs, totalMs: performance.now() - start },
      }
      await writeFile(paths.manifestTemp, JSON.stringify(manifest), { flag: 'wx' })
      await rename(paths.rowsTemp, paths.rows)
      await rename(paths.manifestTemp, paths.manifest)
      size = built.bytes
    }
    const done = await client.execute({ sql: `UPDATE ${TABLE} SET status='COMPLETED',completed_at=unixepoch(),
      heartbeat_at=unixepoch(),owner_token=NULL,processed_events=?,total_events=?,
      processed_tickers=?,total_tickers=?,result_location=?,result_size_bytes=?,
      result_sha256=?,duration_ms=?,error_category=NULL
      WHERE id=? AND owner_token=? AND status='RUNNING' AND cancel_requested=0`,
    args: [manifest.eventCount, manifest.eventCount, manifest.uniqueTickerCount, manifest.uniqueTickerCount,
      row.id, size, manifest.datasetSha256, performance.now() - start, row.id, row.owner_token] })
    if (Number(done.rowsAffected) !== 1) throw new DOMException('ML dataset cancelled', 'AbortError')
    return 'COMPLETED'
  } catch (error) {
    await rm(paths.rowsTemp, { force: true }).catch(() => undefined)
    await rm(paths.manifestTemp, { force: true }).catch(() => undefined)
    if (shutdownSignal?.aborted) {
      const cancelled = await client.execute({ sql: `UPDATE ${TABLE} SET status='CANCELLED',
        owner_token=NULL,completed_at=unixepoch() WHERE id=? AND owner_token=? AND status='CANCEL_REQUESTED'`,
      args: [row.id, row.owner_token] })
      if (Number(cancelled.rowsAffected) === 0) await execRun(`UPDATE ${TABLE} SET status='QUEUED',
        owner_token=NULL,started_at=NULL,processed_events=0,processed_tickers=0,
        attempt_count=MAX(0,attempt_count-1),error_category='worker_recovered'
        WHERE id=? AND owner_token=? AND status='RUNNING'`, [row.id, row.owner_token])
      return Number(cancelled.rowsAffected) ? 'CANCELLED' : 'QUEUED'
    }
    const cancelled = error instanceof DOMException && error.name === 'AbortError'
    await execRun(`UPDATE ${TABLE} SET status=?,owner_token=NULL,completed_at=unixepoch(),
      error_category=? WHERE id=? AND owner_token=? AND status IN ('RUNNING','CANCEL_REQUESTED')`,
    [cancelled ? 'CANCELLED' : 'FAILED', cancelled ? null : 'ml_dataset_failed', row.id, row.owner_token])
    if (!cancelled) throw error
    return 'CANCELLED'
  } finally { shutdownSignal?.removeEventListener('abort', abort) }
}

export async function recoverStaleMlDatasetJobs() { return recoverWorkerJobs(TABLE, 'stale') }
