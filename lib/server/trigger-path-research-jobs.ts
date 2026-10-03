import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import os from 'node:os'
import path from 'node:path'
import type { Transaction } from '@libsql/client'
import { client, ensureReady, execAll, execGet, execRun } from '@/lib/db/client'
import { historicalScanResultPaths } from '@/lib/server/trigger-discovery-historical-scan-jobs'
import { loadSegmentationSource, TriggerOutcomeSegmentationSourceError } from '@/lib/server/trigger-discovery-outcome-segmentation'
import { generatePathResearchRows, mapResearchObservations } from '@/lib/server/trigger-path-research-batch'
import { outcomeResultPaths } from '@/lib/server/trigger-discovery-outcome-jobs'
import { recoverWorkerJobs } from '@/lib/server/trigger-historical-worker-ownership'
import type { TriggerHistoricalScanEvent } from '@/lib/trigger-discovery-historical-scan-contract'
import type { TriggerOutcomeJobStatus, TriggerOutcomeRow } from '@/lib/trigger-discovery-outcome-contract'
import {
  PATH_RESEARCH_CONTRACT_VERSION, PATH_SEGMENTATION_VERSION,
  type PathResearchJobSummary, type PathResearchManifest, type PathResearchRow,
} from '@/lib/trigger-path-research-contract'

const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TABLE = 'trigger_path_research_jobs'
const TTL_SECONDS = 7 * 86_400

export type PathResearchJobRow = {
  id: string; status: TriggerOutcomeJobStatus; outcome_job_id: string; historical_scan_job_id: string
  source_fingerprint: string; analysis_cutoff_date: string; created_at: number; started_at: number | null
  completed_at: number | null; heartbeat_at: number | null; total_events: number; processed_events: number
  total_tickers: number; processed_tickers: number; result_location: string | null; result_size_bytes: number
  duration_ms: number; error_category: string | null; cancel_requested: number; owner_token: string | null
  attempt_count: number; expires_at: number
}

export class PathResearchSourceError extends Error {
  constructor(public readonly code: 'source_not_found' | 'source_not_completed' | 'source_expired' | 'source_changed') {
    super(code)
  }
}

function nowSeconds(): number { return Math.floor(Date.now() / 1_000) }
async function beginWriteTransaction(): Promise<Transaction> {
  const configured = Number(process.env.SQLITE_BUSY_RETRIES ?? 8)
  const retries = Number.isInteger(configured) ? Math.min(20, Math.max(0, configured)) : 8
  for (let attempt = 0; ; attempt += 1) {
    try { return await client.transaction('write') }
    catch (error) {
      if (!/SQLITE_BUSY|database is locked/i.test(String(error)) || attempt >= retries) throw error
      await new Promise((resolve) => setTimeout(resolve, Math.min(2_500, 120 * 2 ** attempt)))
    }
  }
}
function root(): string {
  return process.env.STOCKBOARD_PATH_RESEARCH_DIR?.trim()
    || path.join(os.homedir(), 'Library', 'Application Support', 'StockBoard', 'trigger-path-research')
}
export function pathResearchResultPaths(id: string): { manifest: string; rows: string; manifestTemp: string; rowsTemp: string } {
  if (!JOB_ID.test(id)) throw new Error('invalid_path_research_job_id')
  const base = path.join(root(), id)
  return { manifest: `${base}.json`, rows: `${base}.ndjson`, manifestTemp: `${base}.json.tmp`, rowsTemp: `${base}.ndjson.tmp` }
}
async function removeFiles(id: string): Promise<void> {
  await Promise.all(Object.values(pathResearchResultPaths(id)).map((file) => rm(file, { force: true })))
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(/* turbopackIgnore: true */ file)) hash.update(chunk)
  return hash.digest('hex')
}

async function checkedSource(outcomeJobId: string): Promise<{
  source: Awaited<ReturnType<typeof loadSegmentationSource>>
  fingerprint: string
  expiresAt: number
}> {
  if (!JOB_ID.test(outcomeJobId)) throw new PathResearchSourceError('source_not_found')
  let source: Awaited<ReturnType<typeof loadSegmentationSource>>
  try {
    source = await loadSegmentationSource(outcomeJobId)
  } catch (error) {
    if (error instanceof TriggerOutcomeSegmentationSourceError) {
      if (error.code.endsWith('not_found')) throw new PathResearchSourceError('source_not_found')
      if (error.code.endsWith('not_completed')) throw new PathResearchSourceError('source_not_completed')
      throw new PathResearchSourceError('source_expired')
    }
    throw error
  }
  const historical = historicalScanResultPaths(source.outcome.historicalScanJobId)
  const outcome = outcomeResultPaths(outcomeJobId)
  const state = await execGet<{ cutoff: string | null; batch_at: number | null; expires_at: number }>(`SELECT
    (SELECT MAX(date) FROM ohlcv_daily) AS cutoff,
    (SELECT MAX(finished_at) FROM batch_runs WHERE job_type='ohlcv_fetch') AS batch_at,
    (SELECT expires_at FROM historical_trigger_scan_jobs WHERE id=?) AS expires_at`,
  [source.outcome.historicalScanJobId])
  if (!state?.cutoff || state.cutoff < source.outcome.metadata.analysisCutoffDate || !state.expires_at) {
    throw new PathResearchSourceError('source_changed')
  }
  const files = [outcome.manifest, outcome.rowsByDate, historical.manifest, historical.events]
  let hashes: string[]
  try { hashes = await Promise.all(files.map(hashFile)) }
  catch { throw new PathResearchSourceError('source_expired') }
  const fingerprint = createHash('sha256').update(JSON.stringify({
    hashes, cutoff: state.cutoff, batchAt: state.batch_at,
    outcomeFingerprint: source.outcome.sourceFingerprint,
    pathVersion: PATH_RESEARCH_CONTRACT_VERSION,
  })).digest('hex')
  return { source, fingerprint, expiresAt: Math.min(source.outcomeExpiresAt, Number(state.expires_at)) }
}

async function jobRow(id: string): Promise<PathResearchJobRow | null> {
  if (!JOB_ID.test(id)) return null
  return (await execGet<PathResearchJobRow>(`SELECT * FROM ${TABLE} WHERE id=?`, [id])) ?? null
}

async function summary(row: PathResearchJobRow): Promise<PathResearchJobSummary> {
  let resultAvailable = false
  if (row.status === 'COMPLETED' && row.result_location === row.id && Number(row.expires_at) > nowSeconds()) {
    try {
      const paths = pathResearchResultPaths(row.id)
      await Promise.all([stat(/* turbopackIgnore: true */ paths.manifest), stat(/* turbopackIgnore: true */ paths.rows)])
      resultAvailable = true
    } catch { /* unavailable artifact */ }
  }
  return {
    jobId: row.id, outcomeJobId: row.outcome_job_id, historicalScanJobId: row.historical_scan_job_id,
    status: row.status,
    progress: { processedEvents: Number(row.processed_events), totalEvents: Number(row.total_events),
      processedTickers: Number(row.processed_tickers), totalTickers: Number(row.total_tickers) },
    createdAt: new Date(Number(row.created_at) * 1_000).toISOString(),
    completedAt: row.completed_at == null ? null : new Date(Number(row.completed_at) * 1_000).toISOString(),
    expiresAt: new Date(Number(row.expires_at) * 1_000).toISOString(), resultAvailable,
    resultSizeBytes: Number(row.result_size_bytes), errorCategory: row.error_category,
  }
}

export async function createPathResearchJob(outcomeJobId: string): Promise<{ jobId: string; status: TriggerOutcomeJobStatus; reused: boolean }> {
  const { source, fingerprint, expiresAt } = await checkedSource(outcomeJobId)
  const now = nowSeconds()
  const ttl = Math.min(now + TTL_SECONDS, expiresAt)
  if (ttl <= now) throw new PathResearchSourceError('source_expired')
  await ensureReady()
  const tx = await beginWriteTransaction()
  try {
    const existing = await tx.execute({
      sql: `SELECT * FROM ${TABLE} WHERE outcome_job_id=? AND source_fingerprint=? AND expires_at>?
        AND status IN ('QUEUED','RUNNING','COMPLETED')
        ORDER BY CASE status WHEN 'COMPLETED' THEN 0 WHEN 'RUNNING' THEN 1 ELSE 2 END, created_at DESC LIMIT 1`,
      args: [outcomeJobId, fingerprint, now],
    })
    const prior = existing.rows[0] as unknown as PathResearchJobRow | undefined
    if (prior && (prior.status !== 'COMPLETED' || (await summary(prior)).resultAvailable)) {
      await tx.commit()
      return { jobId: prior.id, status: prior.status, reused: true }
    }
    const id = randomUUID()
    await tx.execute({
      sql: `INSERT INTO ${TABLE} (id,status,outcome_job_id,historical_scan_job_id,source_fingerprint,
        analysis_cutoff_date,created_at,expires_at) VALUES (?,'QUEUED',?,?,?,?,?,?)`,
      args: [id, outcomeJobId, source.outcome.historicalScanJobId, fingerprint,
        source.outcome.metadata.analysisCutoffDate, now, ttl],
    })
    await tx.commit()
    return { jobId: id, status: 'QUEUED', reused: false }
  } catch (error) {
    await tx.rollback().catch(() => undefined)
    throw error
  } finally { tx.close() }
}

export async function getPathResearchJob(id: string): Promise<PathResearchJobSummary | null> {
  const row = await jobRow(id)
  return row ? summary(row) : null
}

export async function cancelPathResearchJob(id: string): Promise<PathResearchJobSummary | null> {
  const row = await jobRow(id)
  if (!row) return null
  if (row.status === 'QUEUED') {
    await execRun(`UPDATE ${TABLE} SET status='CANCELLED',cancel_requested=1,completed_at=unixepoch()
      WHERE id=? AND status='QUEUED'`, [id])
  } else if (row.status === 'RUNNING') {
    await execRun(`UPDATE ${TABLE} SET status='CANCEL_REQUESTED',cancel_requested=1
      WHERE id=? AND status='RUNNING'`, [id])
  }
  return getPathResearchJob(id)
}

export async function claimNextPathResearchJob(ownerToken: string = randomUUID()): Promise<PathResearchJobRow | null> {
  const candidate = await execGet<{ id: string }>(`SELECT id FROM ${TABLE} WHERE status='QUEUED'
    ORDER BY created_at,id LIMIT 1`)
  if (!candidate) return null
  const now = nowSeconds()
  const result = await client.execute({
    sql: `UPDATE ${TABLE} SET status='RUNNING',started_at=?,completed_at=NULL,heartbeat_at=?,owner_token=?,
      cancel_requested=0,processed_events=0,processed_tickers=0,result_location=NULL,result_size_bytes=0,
      error_category=NULL,attempt_count=attempt_count+1
      WHERE id=? AND status='QUEUED'
        AND NOT EXISTS (SELECT 1 FROM ${TABLE} WHERE status IN ('RUNNING','CANCEL_REQUESTED') AND id<>?)
        AND NOT EXISTS (SELECT 1 FROM historical_trigger_scan_jobs WHERE status IN ('RUNNING','CANCEL_REQUESTED'))
        AND NOT EXISTS (SELECT 1 FROM trigger_outcome_analysis_jobs WHERE status IN ('RUNNING','CANCEL_REQUESTED'))
        AND NOT EXISTS (SELECT 1 FROM trigger_ml_dataset_jobs WHERE status IN ('RUNNING','CANCEL_REQUESTED'))
      RETURNING *`,
    args: [now, now, ownerToken, candidate.id, candidate.id],
  })
  return (result.rows[0] as unknown as PathResearchJobRow | undefined) ?? null
}

async function readLines<T>(file: string): Promise<T[]> {
  const rows: T[] = []
  const stream = createReadStream(/* turbopackIgnore: true */ file, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  try { for await (const line of lines) if (line) rows.push(JSON.parse(line) as T) }
  finally { lines.close(); stream.destroy() }
  return rows
}

async function updateProgress(row: PathResearchJobRow, progress: {
  processedEvents: number; totalEvents: number; processedTickers: number; totalTickers: number
}, controller: AbortController): Promise<void> {
  const result = await client.execute({
    sql: `UPDATE ${TABLE} SET processed_events=?,total_events=?,processed_tickers=?,total_tickers=?,
      heartbeat_at=unixepoch() WHERE id=? AND owner_token=? AND status='RUNNING' AND cancel_requested=0`,
    args: [progress.processedEvents, progress.totalEvents, progress.processedTickers, progress.totalTickers,
      row.id, row.owner_token],
  })
  if (Number(result.rowsAffected) !== 1) {
    controller.abort()
    throw new DOMException('Path research cancelled', 'AbortError')
  }
}

async function writeRows(file: string, rows: readonly PathResearchRow[]): Promise<void> {
  const stream = createWriteStream(file, { encoding: 'utf8' })
  try {
    for (const row of rows) if (!stream.write(`${JSON.stringify(row)}\n`)) await once(stream, 'drain')
    await new Promise<void>((resolve, reject) => { stream.once('error', reject); stream.end(resolve) })
  } catch (error) { stream.destroy(); throw error }
}

export async function executePathResearchJob(row: PathResearchJobRow, shutdownSignal?: AbortSignal): Promise<TriggerOutcomeJobStatus> {
  if (row.status !== 'RUNNING' || !row.owner_token) throw new Error('path_research_job_not_claimed')
  const started = performance.now()
  const controller = new AbortController()
  const onShutdown = () => controller.abort()
  shutdownSignal?.addEventListener('abort', onShutdown, { once: true })
  if (shutdownSignal?.aborted) controller.abort()
  const paths = pathResearchResultPaths(row.id)
  await mkdir(root(), { recursive: true })
  await removeFiles(row.id)
  try {
    const sourceStarted = performance.now()
    const checked = await checkedSource(row.outcome_job_id)
    if (checked.fingerprint !== row.source_fingerprint) throw new PathResearchSourceError('source_changed')
    const outcomes = await readLines<TriggerOutcomeRow>(checked.source.rowsFile)
    const historicalEvents = await readLines<TriggerHistoricalScanEvent>(checked.source.historicalEventsFile)
    const sourceOutcomeReadMs = performance.now() - sourceStarted
    const mappingStarted = performance.now()
    const { mapped, episodeExcludedCount } = mapResearchObservations({
      outcomes, historicalEvents, outcomeManifest: checked.source.outcome,
    })
    const eventMappingMs = performance.now() - mappingStarted
    const generated = await generatePathResearchRows({
      mapped, outcomeManifest: checked.source.outcome,
      ma1Period: checked.source.historical.scanMeta.ma1Period,
      ma2Period: checked.source.historical.scanMeta.ma2Period,
      timeframe: checked.source.historical.scanMeta.timeframe,
      analysisCutoffDate: row.analysis_cutoff_date, signal: controller.signal,
      onProgress: (progress) => updateProgress(row, progress, controller),
    })
    if (controller.signal.aborted) throw new DOMException('Path research cancelled', 'AbortError')
    // Source artifacts and the OHLCV batch/cutoff must still match before publishing.
    if ((await checkedSource(row.outcome_job_id)).fingerprint !== row.source_fingerprint) {
      throw new PathResearchSourceError('source_changed')
    }
    const serializationStarted = performance.now()
    await writeRows(paths.rowsTemp, generated.rows)
    const serializationMs = performance.now() - serializationStarted
    const manifest: PathResearchManifest = {
      contractVersion: PATH_RESEARCH_CONTRACT_VERSION,
      pathSegmentationVersion: PATH_SEGMENTATION_VERSION,
      jobId: row.id, outcomeJobId: row.outcome_job_id,
      historicalScanJobId: row.historical_scan_job_id,
      sourceFingerprint: row.source_fingerprint,
      analysisCutoffDate: row.analysis_cutoff_date,
      eventSelector: checked.source.outcome.request.eventFilter,
      timeframe: checked.source.historical.scanMeta.timeframe,
      ma1Period: checked.source.historical.scanMeta.ma1Period,
      ma2Period: checked.source.historical.scanMeta.ma2Period,
      sourceObservationCount: outcomes.length,
      generatedRowCount: generated.rows.length,
      episodeMappedCount: generated.rows.length - episodeExcludedCount,
      episodeExcludedCount,
      pathUnavailableCount: generated.rows.filter((item) => item.pathStatus !== 'AVAILABLE').length,
      artifactFormat: 'NDJSON', fixedWindows: [20, 60, 120, 245],
      definitions: {
        path: 'POST_EVENT_REALIZED_PATH', outcome: 'SAVED_OUTCOME_ARTIFACT',
        episodeAnchor: 'FIRST_SELECTED_EVENT_IN_EPISODE', zoneBasis: 'MOVING_MA_ZONE',
      },
      performance: {
        totalMs: performance.now() - started, sourceOutcomeReadMs, eventMappingMs,
        ohlcvMaLoadMs: generated.timing.sqlMs + generated.timing.maMs,
        pathCalculationMs: generated.timing.pathMs, atrMs: generated.timing.atrMs,
        serializationMs, aggregationMs: 0, sqlQueryCount: generated.timing.queryCount,
        peakHeapBytes: generated.timing.peakHeapBytes, peakRssBytes: generated.timing.peakRssBytes,
        artifactBytes: 0,
      },
      generatedAt: new Date().toISOString(),
    }
    await writeFile(paths.manifestTemp, JSON.stringify(manifest), 'utf8')
    await rename(paths.rowsTemp, paths.rows)
    await rename(paths.manifestTemp, paths.manifest)
    const bytes = (await stat(/* turbopackIgnore: true */ paths.rows)).size
      + (await stat(/* turbopackIgnore: true */ paths.manifest)).size
    manifest.performance.artifactBytes = bytes
    manifest.performance.totalMs = performance.now() - started
    await writeFile(paths.manifestTemp, JSON.stringify(manifest), 'utf8')
    await rename(paths.manifestTemp, paths.manifest)
    const completed = await client.execute({
      sql: `UPDATE ${TABLE} SET status='COMPLETED',completed_at=unixepoch(),heartbeat_at=unixepoch(),
        owner_token=NULL,processed_events=?,total_events=?,processed_tickers=?,total_tickers=?,
        result_location=?,result_size_bytes=?,duration_ms=?,error_category=NULL
        WHERE id=? AND owner_token=? AND status='RUNNING' AND cancel_requested=0`,
      args: [generated.rows.length, generated.rows.length,
        new Set(generated.rows.map((item) => item.ticker)).size,
        new Set(generated.rows.map((item) => item.ticker)).size,
        row.id, bytes, performance.now() - started, row.id, row.owner_token],
    })
    if (Number(completed.rowsAffected) !== 1) {
      await removeFiles(row.id)
      await execRun(`UPDATE ${TABLE} SET status='CANCELLED',owner_token=NULL,completed_at=unixepoch()
        WHERE id=? AND owner_token=? AND status='CANCEL_REQUESTED'`, [row.id, row.owner_token])
      return 'CANCELLED'
    }
    return 'COMPLETED'
  } catch (error) {
    await removeFiles(row.id).catch(() => undefined)
    if (shutdownSignal?.aborted) {
      const cancelled = await client.execute({ sql: `UPDATE ${TABLE} SET status='CANCELLED',owner_token=NULL,
        completed_at=unixepoch(),result_location=NULL,result_size_bytes=0
        WHERE id=? AND owner_token=? AND status='CANCEL_REQUESTED'`, args: [row.id, row.owner_token] })
      if (Number(cancelled.rowsAffected) === 0) {
        await execRun(`UPDATE ${TABLE} SET status='QUEUED',owner_token=NULL,started_at=NULL,
          processed_events=0,processed_tickers=0,attempt_count=MAX(0,attempt_count-1),
          error_category='worker_recovered' WHERE id=? AND owner_token=? AND status='RUNNING'`,
        [row.id, row.owner_token])
      }
      return Number(cancelled.rowsAffected) > 0 ? 'CANCELLED' : 'QUEUED'
    }
    const cancelled = error instanceof DOMException && error.name === 'AbortError'
    await execRun(`UPDATE ${TABLE} SET status=?,completed_at=unixepoch(),owner_token=NULL,
      result_location=NULL,result_size_bytes=0,duration_ms=?,error_category=?
      WHERE id=? AND owner_token=? AND status IN ('RUNNING','CANCEL_REQUESTED')`, [
      cancelled ? 'CANCELLED' : 'FAILED', performance.now() - started,
      cancelled ? null : error instanceof PathResearchSourceError ? error.code : 'path_research_failed',
      row.id, row.owner_token,
    ]).catch(() => undefined)
    if (!cancelled) throw error
    return 'CANCELLED'
  } finally { shutdownSignal?.removeEventListener('abort', onShutdown) }
}

export async function getPathResearchArtifact(id: string): Promise<{
  manifest: PathResearchManifest; rowsFile: string
} | null | 'NOT_READY' | 'EXPIRED'> {
  const row = await jobRow(id)
  if (!row) return null
  if (row.status !== 'COMPLETED') return 'NOT_READY'
  if (Number(row.expires_at) <= nowSeconds() || row.result_location !== row.id) return 'EXPIRED'
  try {
    const paths = pathResearchResultPaths(id)
    const manifest = JSON.parse(await readFile(/* turbopackIgnore: true */ paths.manifest, 'utf8')) as PathResearchManifest
    await stat(/* turbopackIgnore: true */ paths.rows)
    if (manifest.sourceFingerprint !== row.source_fingerprint) return 'EXPIRED'
    return { manifest, rowsFile: paths.rows }
  } catch { return 'EXPIRED' }
}

export async function cleanupExpiredPathResearchJobs(): Promise<number> {
  const ids = await execAll<{ id: string }>(`SELECT id FROM ${TABLE}
    WHERE expires_at<=unixepoch() AND status IN ('COMPLETED','FAILED','CANCELLED')`)
  for (const item of ids) await removeFiles(item.id).catch(() => undefined)
  if (ids.length) await execRun(`DELETE FROM ${TABLE}
    WHERE expires_at<=unixepoch() AND status IN ('COMPLETED','FAILED','CANCELLED')`)
  return ids.length
}

export async function recoverStalePathResearchJobs(): Promise<{ requeued: number; failed: number; cancelled: number }> {
  return recoverWorkerJobs(TABLE, 'stale')
}
