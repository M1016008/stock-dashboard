import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import os from 'node:os'
import path from 'node:path'
import type { Transaction } from '@libsql/client'
import { client, ensureReady, execAll, execGet, execRun } from '@/lib/db/client'
import { historicalScanResultPaths, isHistoricalScanJobResultCurrent } from '@/lib/server/trigger-discovery-historical-scan-jobs'
import { recoverWorkerJobs } from '@/lib/server/trigger-historical-worker-ownership'
import {
  aggregateOutcomeRows,
  calculateEventOutcome,
  outcomeEventMatches,
  type OutcomeOhlcvRow,
} from '@/lib/server/trigger-discovery-outcome-analysis'
import {
  TRIGGER_DISCOVERY_OUTCOME_CONTRACT_VERSION,
  TRIGGER_DISCOVERY_OUTCOME_JOB_CONTRACT_VERSION,
  TRIGGER_OUTCOME_EVENT_SELECTORS,
  TRIGGER_OUTCOME_HORIZONS,
  TRIGGER_OUTCOME_JOB_STATUSES,
  TRIGGER_OUTCOME_STAGE_AXES,
  type TriggerOutcomeEventSelector,
  type TriggerOutcomeHorizon,
  type TriggerOutcomeJobStartResponse,
  type TriggerOutcomeJobStatus,
  type TriggerOutcomeJobSummary,
  type TriggerOutcomeRecentJob,
  type TriggerOutcomeManifest,
  type TriggerOutcomeRequest,
  type TriggerOutcomeResultResponse,
  type TriggerOutcomeRow,
} from '@/lib/trigger-discovery-outcome-contract'
import type {
  TriggerHistoricalScanEvent,
  TriggerHistoricalScanRequest,
  TriggerHistoricalScanResponse,
} from '@/lib/trigger-discovery-historical-scan-contract'

const DEFAULT_JOB_TTL_DAYS = 7
const DEFAULT_REUSE_SECONDS = 15 * 60
const DEFAULT_STALE_SECONDS = 3 * 60
const OHLCV_TICKER_BATCH_SIZE = 200
const MAX_RESULT_PAGE_SIZE = 1_000
const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type TriggerOutcomeJobRow = {
  id: string
  status: TriggerOutcomeJobStatus
  historical_scan_job_id: string
  request_json: string
  request_signature: string
  source_fingerprint: string
  analysis_cutoff_date: string | null
  created_at: number
  started_at: number | null
  completed_at: number | null
  heartbeat_at: number | null
  total_events: number
  processed_events: number
  total_tickers: number
  processed_tickers: number
  result_location: string | null
  result_size_bytes: number
  duration_ms: number
  sql_ms: number
  calculation_ms: number
  aggregation_ms: number
  serialization_ms: number
  save_ms: number
  error_category: string | null
  cancel_requested: number
  owner_token: string | null
  attempt_count: number
  expires_at: number
}

type HistoricalSourceRow = {
  id: string
  status: string
  source_fingerprint: string
  timeframe: 'MONTHLY' | 'BIWEEKLY'
  expires_at: number
  result_location: string | null
}

export class TriggerOutcomeInputError extends Error {}

export class TriggerOutcomeSourceError extends Error {
  constructor(
    public readonly code:
      | 'historical_scan_job_not_found'
      | 'historical_scan_job_not_completed'
      | 'historical_scan_job_result_expired',
  ) {
    super(code)
    this.name = 'TriggerOutcomeSourceError'
  }
}

function boundedIntegerEnv(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name])
  if (!Number.isInteger(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

function nowSeconds(now: () => number = Date.now): number {
  return Math.floor(now() / 1_000)
}

function isoDateTime(epochSeconds: number | null): string | null {
  return epochSeconds == null ? null : new Date(Number(epochSeconds) * 1_000).toISOString()
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]),
  )
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value))
}

function isDatabaseBusy(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /SQLITE_BUSY|database is locked/i.test(message)
}

async function beginWriteTransaction(): Promise<Transaction> {
  const retries = boundedIntegerEnv('SQLITE_BUSY_RETRIES', 8, 0, 20)
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await client.transaction('write')
    } catch (error) {
      if (!isDatabaseBusy(error) || attempt >= retries) throw error
      await new Promise((resolve) => setTimeout(resolve, Math.min(2_500, 120 * 2 ** attempt)))
    }
  }
}

function outcomeResultRoot(): string {
  return process.env.STOCKBOARD_OUTCOME_ANALYSIS_DIR?.trim()
    || path.join(os.homedir(), 'Library', 'Application Support', 'StockBoard', 'trigger-outcomes')
}

export function outcomeResultPaths(jobId: string): {
  manifest: string
  rowsByDate: string
  rowsByTicker: string
  manifestTemp: string
  rowsByDateTemp: string
  rowsByTickerTemp: string
} {
  if (!JOB_ID_PATTERN.test(jobId)) throw new Error('invalid_outcome_job_id')
  const root = outcomeResultRoot()
  return {
    manifest: path.join(root, `${jobId}.json`),
    rowsByDate: path.join(root, `${jobId}.events.ndjson`),
    rowsByTicker: path.join(root, `${jobId}.tickers.ndjson`),
    manifestTemp: path.join(root, `${jobId}.json.tmp`),
    rowsByDateTemp: path.join(root, `${jobId}.events.ndjson.tmp`),
    rowsByTickerTemp: path.join(root, `${jobId}.tickers.ndjson.tmp`),
  }
}

async function removeOutcomeFiles(jobId: string): Promise<void> {
  const paths = outcomeResultPaths(jobId)
  await Promise.all(Object.values(paths).map((file) => rm(file, { force: true })))
}

function parseStageFilters(value: unknown): TriggerOutcomeRequest['stageFilters'] {
  if (value == null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TriggerOutcomeInputError('stageFilters must be an object')
  }
  const source = value as Record<string, unknown>
  const result: TriggerOutcomeRequest['stageFilters'] = {}
  for (const key of Object.keys(source)) {
    if (!TRIGGER_OUTCOME_STAGE_AXES.includes(key as never)) {
      throw new TriggerOutcomeInputError(`unknown stage axis: ${key}`)
    }
    const values = source[key]
    if (!Array.isArray(values) || values.length === 0) {
      throw new TriggerOutcomeInputError(`${key} must be a non-empty array`)
    }
    const parsed = values.map((item) => {
      if (item === 'unknown') return item
      if (!Number.isInteger(item) || Number(item) < 1 || Number(item) > 6) {
        throw new TriggerOutcomeInputError(`${key} supports Stage 1-6 or unknown`)
      }
      return Number(item) as 1 | 2 | 3 | 4 | 5 | 6
    })
    result[key as keyof typeof result] = Array.from(new Set(parsed))
  }
  return result
}

function optionalScore(value: unknown, name: string): number | null {
  if (value == null || value === '') return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new TriggerOutcomeInputError(`${name} must be between 0 and 100`)
  }
  return parsed
}

export function parseTriggerOutcomeRequest(
  value: unknown,
  historicalScanJobIdOverride?: string,
): TriggerOutcomeRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TriggerOutcomeInputError('request body must be an object')
  }
  const source = value as Record<string, unknown>
  const historicalScanJobId = historicalScanJobIdOverride ?? String(source.historicalScanJobId ?? '')
  if (!JOB_ID_PATTERN.test(historicalScanJobId)) {
    throw new TriggerOutcomeInputError('historicalScanJobId must be a valid UUID')
  }
  if (historicalScanJobIdOverride && source.historicalScanJobId != null
    && source.historicalScanJobId !== historicalScanJobIdOverride) {
    throw new TriggerOutcomeInputError('historicalScanJobId must match the route')
  }
  const eventFilter = String(source.eventFilter ?? '') as TriggerOutcomeEventSelector
  if (!TRIGGER_OUTCOME_EVENT_SELECTORS.includes(eventFilter)) {
    throw new TriggerOutcomeInputError('eventFilter is not supported')
  }
  const horizonsSource = source.horizons ?? TRIGGER_OUTCOME_HORIZONS
  if (!Array.isArray(horizonsSource) || horizonsSource.length === 0) {
    throw new TriggerOutcomeInputError('horizons must be a non-empty array')
  }
  const horizons = Array.from(new Set(horizonsSource.map((value) => Number(value))))
  if (horizons.some((value) => !TRIGGER_OUTCOME_HORIZONS.includes(value as TriggerOutcomeHorizon))) {
    throw new TriggerOutcomeInputError('horizons supports only 20, 60, 120, and 245 sessions')
  }
  const ticker = source.ticker == null || String(source.ticker).trim() === ''
    ? null
    : String(source.ticker).normalize('NFKC').trim().replace(/\.T$/i, '').toUpperCase()
  if (ticker && !/^[0-9A-Z]{4,5}$/.test(ticker)) {
    throw new TriggerOutcomeInputError('ticker is invalid')
  }
  const triggerScoreMin = optionalScore(source.triggerScoreMin, 'triggerScoreMin')
  const triggerScoreMax = optionalScore(source.triggerScoreMax, 'triggerScoreMax')
  if (triggerScoreMin != null && triggerScoreMax != null && triggerScoreMin > triggerScoreMax) {
    throw new TriggerOutcomeInputError('triggerScoreMin must not exceed triggerScoreMax')
  }
  return {
    historicalScanJobId,
    eventFilter,
    horizons: horizons.sort((left, right) => left - right) as TriggerOutcomeHorizon[],
    ticker,
    triggerScoreMin,
    triggerScoreMax,
    stageFilters: parseStageFilters(source.stageFilters),
  }
}

async function historicalSourceRow(id: string): Promise<HistoricalSourceRow | null> {
  if (!JOB_ID_PATTERN.test(id)) return null
  return (await execGet<HistoricalSourceRow>(
    `SELECT id, status, source_fingerprint, timeframe, expires_at, result_location
     FROM historical_trigger_scan_jobs WHERE id=?`,
    [id],
  )) ?? null
}

async function checkedHistoricalSource(id: string): Promise<{
  row: HistoricalSourceRow
  manifest: TriggerHistoricalScanResponse
  eventsPath: string
  eventsStat: Awaited<ReturnType<typeof stat>>
}> {
  const row = await historicalSourceRow(id)
  if (!row) throw new TriggerOutcomeSourceError('historical_scan_job_not_found')
  if (row.status !== 'COMPLETED' || row.result_location !== row.id) {
    throw new TriggerOutcomeSourceError('historical_scan_job_not_completed')
  }
  if (Number(row.expires_at) <= nowSeconds()) {
    throw new TriggerOutcomeSourceError('historical_scan_job_result_expired')
  }
  if (!await isHistoricalScanJobResultCurrent(row.id)) {
    throw new TriggerOutcomeSourceError('historical_scan_job_result_expired')
  }
  const paths = historicalScanResultPaths(row.id)
  try {
    const [manifestJson, eventsStat] = await Promise.all([
      readFile(/* turbopackIgnore: true */ paths.manifest, 'utf8'),
      stat(/* turbopackIgnore: true */ paths.events),
    ])
    return {
      row,
      manifest: JSON.parse(manifestJson) as TriggerHistoricalScanResponse,
      eventsPath: paths.events,
      eventsStat,
    }
  } catch {
    throw new TriggerOutcomeSourceError('historical_scan_job_result_expired')
  }
}

async function outcomeSourceFingerprint(source: Awaited<ReturnType<typeof checkedHistoricalSource>>): Promise<{
  fingerprint: string
  analysisCutoffDate: string
}> {
  const current = await execGet<{ cutoff: string | null; batch_at: number | null }>(`SELECT
    (SELECT MAX(date) FROM ohlcv_daily) AS cutoff,
    (SELECT MAX(finished_at) FROM batch_runs WHERE job_type='ohlcv_fetch') AS batch_at`)
  if (!current?.cutoff) throw new TriggerOutcomeInputError('OHLCV is unavailable')
  const fingerprint = createHash('sha256').update(stableJson({
    sourceJobId: source.row.id,
    sourceFingerprint: source.row.source_fingerprint,
    sourceResultSize: Number(source.eventsStat.size),
    sourceResultMtimeMs: Math.trunc(Number(source.eventsStat.mtimeMs)),
    analysisCutoffDate: current.cutoff,
    ohlcvBatchAt: current.batch_at,
    contractVersion: TRIGGER_DISCOVERY_OUTCOME_CONTRACT_VERSION,
  })).digest('hex')
  return { fingerprint, analysisCutoffDate: current.cutoff }
}

async function jobRow(id: string): Promise<TriggerOutcomeJobRow | null> {
  if (!JOB_ID_PATTERN.test(id)) return null
  return (await execGet<TriggerOutcomeJobRow>(
    'SELECT * FROM trigger_outcome_analysis_jobs WHERE id=?', [id],
  )) ?? null
}

function parseStoredRequest(row: TriggerOutcomeJobRow): TriggerOutcomeRequest {
  return JSON.parse(row.request_json) as TriggerOutcomeRequest
}

async function filesAvailable(id: string): Promise<boolean> {
  const paths = outcomeResultPaths(id)
  try {
    await Promise.all([
      stat(/* turbopackIgnore: true */ paths.manifest),
      stat(/* turbopackIgnore: true */ paths.rowsByDate),
      stat(/* turbopackIgnore: true */ paths.rowsByTicker),
    ])
    return true
  } catch {
    return false
  }
}

async function jobSummary(row: TriggerOutcomeJobRow): Promise<TriggerOutcomeJobSummary> {
  const available = row.status === 'COMPLETED' && row.result_location === row.id
    && Number(row.expires_at) > nowSeconds()
    && await isHistoricalScanJobResultCurrent(row.historical_scan_job_id)
    && await filesAvailable(row.id)
  return {
    contractVersion: TRIGGER_DISCOVERY_OUTCOME_JOB_CONTRACT_VERSION,
    jobId: row.id,
    status: row.status,
    request: parseStoredRequest(row),
    historicalScanJobId: row.historical_scan_job_id,
    analysisCutoffDate: row.analysis_cutoff_date,
    progress: {
      processedEvents: Number(row.processed_events),
      totalEvents: Number(row.total_events),
      processedTickers: Number(row.processed_tickers),
      totalTickers: Number(row.total_tickers),
    },
    createdAt: isoDateTime(Number(row.created_at))!,
    startedAt: isoDateTime(row.started_at == null ? null : Number(row.started_at)),
    completedAt: isoDateTime(row.completed_at == null ? null : Number(row.completed_at)),
    expiresAt: isoDateTime(Number(row.expires_at))!,
    durationMs: Number(row.duration_ms),
    resultSizeBytes: Number(row.result_size_bytes),
    resultAvailable: available,
    errorCategory: row.error_category,
  }
}

export async function createOutcomeAnalysisJob(
  value: unknown,
  historicalScanJobIdOverride?: string,
): Promise<TriggerOutcomeJobStartResponse> {
  const request = parseTriggerOutcomeRequest(value, historicalScanJobIdOverride)
  const source = await checkedHistoricalSource(request.historicalScanJobId)
  const sourceState = await outcomeSourceFingerprint(source)
  const requestSignature = createHash('sha256').update(stableJson({
    request,
    contractVersion: TRIGGER_DISCOVERY_OUTCOME_JOB_CONTRACT_VERSION,
  })).digest('hex')
  const now = nowSeconds()
  const reuseSeconds = boundedIntegerEnv('TRIGGER_OUTCOME_REUSE_SECONDS', DEFAULT_REUSE_SECONDS, 0, 86_400)
  const ttlSeconds = boundedIntegerEnv('TRIGGER_OUTCOME_TTL_DAYS', DEFAULT_JOB_TTL_DAYS, 1, 30) * 86_400
  const id = randomUUID()
  await ensureReady()
  const tx = await beginWriteTransaction()
  try {
    const existingResult = await tx.execute({
      sql: `SELECT * FROM trigger_outcome_analysis_jobs
        WHERE historical_scan_job_id=? AND request_signature=? AND source_fingerprint=? AND expires_at>?
          AND (status IN ('QUEUED','RUNNING') OR (status='COMPLETED' AND completed_at>=?))
        ORDER BY CASE status WHEN 'COMPLETED' THEN 0 WHEN 'RUNNING' THEN 1 ELSE 2 END,
                 created_at DESC LIMIT 1`,
      args: [request.historicalScanJobId, requestSignature, sourceState.fingerprint, now, now - reuseSeconds],
    })
    const existing = existingResult.rows[0] as unknown as TriggerOutcomeJobRow | undefined
    if (existing && (existing.status !== 'COMPLETED' || await filesAvailable(existing.id))) {
      await tx.commit()
      return {
        contractVersion: TRIGGER_DISCOVERY_OUTCOME_JOB_CONTRACT_VERSION,
        jobId: existing.id,
        status: existing.status,
        reused: true,
      }
    }
    await tx.execute({
      sql: `INSERT INTO trigger_outcome_analysis_jobs (
        id, status, historical_scan_job_id, request_json, request_signature,
        source_fingerprint, analysis_cutoff_date, created_at, expires_at
      ) VALUES (?, 'QUEUED', ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, request.historicalScanJobId, JSON.stringify(request), requestSignature,
        sourceState.fingerprint, sourceState.analysisCutoffDate, now, now + ttlSeconds],
    })
    await tx.commit()
    return {
      contractVersion: TRIGGER_DISCOVERY_OUTCOME_JOB_CONTRACT_VERSION,
      jobId: id,
      status: 'QUEUED',
      reused: false,
    }
  } catch (error) {
    await tx.rollback().catch(() => undefined)
    throw error
  } finally {
    tx.close()
  }
}

export async function getOutcomeAnalysisJob(id: string): Promise<TriggerOutcomeJobSummary | null> {
  const row = await jobRow(id)
  return row ? jobSummary(row) : null
}

export async function listRecentCompletedOutcomeJobs(limit = 20): Promise<TriggerOutcomeRecentJob[]> {
  await ensureReady()
  const rows = await execAll<TriggerOutcomeJobRow & {
    scan_request_json: string
    timeframe: 'MONTHLY' | 'BIWEEKLY'
    requested_start: string
    requested_end: string
    resolved_start: string | null
    resolved_end: string | null
  }>(`SELECT o.*, h.request_json AS scan_request_json, h.timeframe,
      h.requested_start, h.requested_end, h.resolved_start, h.resolved_end
    FROM trigger_outcome_analysis_jobs o
    JOIN historical_trigger_scan_jobs h ON h.id = o.historical_scan_job_id
    WHERE o.status = 'COMPLETED' AND o.result_location = o.id AND o.expires_at > unixepoch()
      AND h.status = 'COMPLETED' AND h.expires_at > unixepoch()
    ORDER BY o.completed_at DESC LIMIT ?`, [Math.max(1, Math.min(limit, 20))])
  const available = await Promise.all(rows.map(async (row) => {
    if (!await filesAvailable(row.id)) return null
    const request = parseStoredRequest(row)
    const scanRequest = JSON.parse(row.scan_request_json) as TriggerHistoricalScanRequest
    return {
      jobId: row.id,
      historicalScanJobId: row.historical_scan_job_id,
      eventSelector: request.eventFilter,
      timeframe: row.timeframe,
      ma1Period: scanRequest.ma1Period ?? 20,
      ma2Period: scanRequest.ma2Period ?? 25,
      requestedStartDate: row.requested_start,
      requestedEndDate: row.requested_end,
      resolvedStartDate: row.resolved_start,
      resolvedEndDate: row.resolved_end,
      spreadExpansionEnabled: Boolean(scanRequest.spreadExpansionEnabled),
      completedAt: isoDateTime(Number(row.completed_at))!,
    } satisfies TriggerOutcomeRecentJob
  }))
  return available.filter((job): job is TriggerOutcomeRecentJob => job !== null)
}

export async function cancelOutcomeAnalysisJob(id: string): Promise<TriggerOutcomeJobSummary | null> {
  if (!JOB_ID_PATTERN.test(id)) return null
  await ensureReady()
  const tx = await beginWriteTransaction()
  try {
    const selected = await tx.execute({
      sql: 'SELECT * FROM trigger_outcome_analysis_jobs WHERE id=?', args: [id],
    })
    const row = selected.rows[0] as unknown as TriggerOutcomeJobRow | undefined
    if (!row) {
      await tx.commit()
      return null
    }
    if (row.status === 'QUEUED') {
      await tx.execute({
        sql: `UPDATE trigger_outcome_analysis_jobs SET status='CANCELLED', cancel_requested=1,
          completed_at=unixepoch(), heartbeat_at=unixepoch(), owner_token=NULL, error_category=NULL
          WHERE id=? AND status='QUEUED'`, args: [id],
      })
    } else if (row.status === 'RUNNING') {
      await tx.execute({
        sql: `UPDATE trigger_outcome_analysis_jobs SET status='CANCEL_REQUESTED', cancel_requested=1,
          heartbeat_at=unixepoch() WHERE id=? AND status='RUNNING'`, args: [id],
      })
    }
    const updated = await tx.execute({
      sql: 'SELECT * FROM trigger_outcome_analysis_jobs WHERE id=?', args: [id],
    })
    await tx.commit()
    const result = updated.rows[0] as unknown as TriggerOutcomeJobRow | undefined
    return result ? jobSummary(result) : null
  } catch (error) {
    await tx.rollback().catch(() => undefined)
    throw error
  } finally {
    tx.close()
  }
}

function staleSeconds(): number {
  return boundedIntegerEnv('TRIGGER_OUTCOME_STALE_SECONDS', DEFAULT_STALE_SECONDS, 30, 3_600)
}

export async function recoverStaleOutcomeJobs(
  now: () => number = Date.now,
  processAudit?: () => boolean | null,
): Promise<{
  requeued: number
  failed: number
  cancelled: number
}> {
  return recoverWorkerJobs('trigger_outcome_analysis_jobs', 'stale', now, staleSeconds(), processAudit)
}

export async function claimNextOutcomeJob(
  ownerToken: string = randomUUID(),
  now: () => number = Date.now,
): Promise<TriggerOutcomeJobRow | null> {
  const current = nowSeconds(now)
  const candidate = await execGet<{ id: string }>(`SELECT id FROM trigger_outcome_analysis_jobs
    WHERE status='QUEUED'
      AND NOT EXISTS (SELECT 1 FROM trigger_outcome_analysis_jobs WHERE status IN ('RUNNING','CANCEL_REQUESTED'))
      AND NOT EXISTS (SELECT 1 FROM historical_trigger_scan_jobs WHERE status IN ('RUNNING','CANCEL_REQUESTED'))
      AND NOT EXISTS (SELECT 1 FROM trigger_path_research_jobs WHERE status IN ('RUNNING','CANCEL_REQUESTED'))
      AND NOT EXISTS (SELECT 1 FROM trigger_ml_dataset_jobs WHERE status IN ('RUNNING','CANCEL_REQUESTED'))
    ORDER BY created_at, id LIMIT 1`)
  if (!candidate) return null
  const claimed = await client.execute({
    sql: `UPDATE trigger_outcome_analysis_jobs SET status='RUNNING', started_at=?, completed_at=NULL,
      heartbeat_at=?, owner_token=?, cancel_requested=0, processed_events=0, processed_tickers=0,
      result_location=NULL, result_size_bytes=0, duration_ms=0, sql_ms=0, calculation_ms=0,
      aggregation_ms=0, serialization_ms=0, save_ms=0, error_category=NULL,
      attempt_count=attempt_count+1
      WHERE id=? AND status='QUEUED'
        AND NOT EXISTS (SELECT 1 FROM trigger_outcome_analysis_jobs
          WHERE status IN ('RUNNING','CANCEL_REQUESTED') AND id<>?)
        AND NOT EXISTS (SELECT 1 FROM historical_trigger_scan_jobs
          WHERE status IN ('RUNNING','CANCEL_REQUESTED'))
        AND NOT EXISTS (SELECT 1 FROM trigger_path_research_jobs
          WHERE status IN ('RUNNING','CANCEL_REQUESTED'))
        AND NOT EXISTS (SELECT 1 FROM trigger_ml_dataset_jobs
          WHERE status IN ('RUNNING','CANCEL_REQUESTED')) RETURNING *`,
    args: [current, current, ownerToken, candidate.id, candidate.id],
  })
  return (claimed.rows[0] as unknown as TriggerOutcomeJobRow | undefined) ?? null
}

async function selectedEvents(
  sourceFile: string,
  request: TriggerOutcomeRequest,
): Promise<TriggerHistoricalScanEvent[]> {
  const selected: TriggerHistoricalScanEvent[] = []
  const input = createReadStream(sourceFile, { encoding: 'utf8' })
  const lines = createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (!line) continue
      const event = JSON.parse(line) as TriggerHistoricalScanEvent
      if (outcomeEventMatches({ event, ...request })) selected.push(event)
    }
  } finally {
    lines.close()
    input.destroy()
  }
  return selected
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = []
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size))
  return result
}

async function updateProgress(input: {
  row: TriggerOutcomeJobRow
  ownerToken: string
  processedEvents: number
  totalEvents: number
  processedTickers: number
  totalTickers: number
  controller: AbortController
}): Promise<void> {
  const state = await execGet<{ status: TriggerOutcomeJobStatus; cancel_requested: number; owner_token: string | null }>(
    'SELECT status, cancel_requested, owner_token FROM trigger_outcome_analysis_jobs WHERE id=?',
    [input.row.id],
  )
  if (!state || state.owner_token !== input.ownerToken || state.status !== 'RUNNING'
    || Number(state.cancel_requested) === 1) {
    input.controller.abort()
    throw new DOMException('Outcome analysis cancelled', 'AbortError')
  }
  await execRun(`UPDATE trigger_outcome_analysis_jobs SET processed_events=?, total_events=?,
    processed_tickers=?, total_tickers=?, heartbeat_at=unixepoch()
    WHERE id=? AND owner_token=? AND status='RUNNING'`, [
    input.processedEvents, input.totalEvents, input.processedTickers, input.totalTickers,
    input.row.id, input.ownerToken,
  ])
}

async function writeRows(file: string, rows: readonly TriggerOutcomeRow[]): Promise<{
  serializationMs: number
  writeMs: number
}> {
  const stream = createWriteStream(file, { encoding: 'utf8' })
  let serializationMs = 0
  let writeMs = 0
  try {
    for (const batch of chunks(rows, 500)) {
      const serializationStartedAt = performance.now()
      const payload = `${batch.map((row) => JSON.stringify(row)).join('\n')}\n`
      serializationMs += performance.now() - serializationStartedAt
      const writeStartedAt = performance.now()
      if (!stream.write(payload)) await once(stream, 'drain')
      writeMs += performance.now() - writeStartedAt
    }
    const closeStartedAt = performance.now()
    await new Promise<void>((resolve, reject) => {
      stream.once('error', reject)
      stream.end(resolve)
    })
    writeMs += performance.now() - closeStartedAt
    return { serializationMs, writeMs }
  } catch (error) {
    stream.destroy()
    throw error
  }
}

function outcomeErrorCategory(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled'
  if (error instanceof TriggerOutcomeSourceError) return error.code
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
  if (message.includes('memory') || message.includes('heap')) return 'memory_limit'
  if (message.includes('database') || message.includes('sqlite') || message.includes('busy')) return 'database_error'
  return 'outcome_analysis_failed'
}

export async function executeOutcomeAnalysisJob(
  row: TriggerOutcomeJobRow,
  shutdownSignal?: AbortSignal,
): Promise<TriggerOutcomeJobStatus> {
  if (row.status !== 'RUNNING' || !row.owner_token) throw new Error('outcome_job_not_claimed')
  const startedAt = performance.now()
  const ownerToken = row.owner_token
  const controller = new AbortController()
  const onShutdown = () => controller.abort()
  shutdownSignal?.addEventListener('abort', onShutdown, { once: true })
  if (shutdownSignal?.aborted) controller.abort()
  const paths = outcomeResultPaths(row.id)
  await mkdir(outcomeResultRoot(), { recursive: true })
  await removeOutcomeFiles(row.id)
  let sqlMs = 0
  let calculationMs = 0
  let aggregationMs = 0
  let serializationMs = 0
  let saveMs = 0
  let queryCount = 0
  let ohlcvRowCount = 0
  let peakHeapBytes = process.memoryUsage().heapUsed
  let peakRssBytes = process.memoryUsage().rss
  try {
    const request = parseStoredRequest(row)
    const source = await checkedHistoricalSource(row.historical_scan_job_id)
    const currentSource = await outcomeSourceFingerprint(source)
    if (currentSource.fingerprint !== row.source_fingerprint
      || currentSource.analysisCutoffDate !== row.analysis_cutoff_date) {
      throw new Error('outcome_source_changed_retry_required')
    }
    const events = await selectedEvents(source.eventsPath, request)
    const eventIndexesByTicker = new Map<string, number[]>()
    events.forEach((event, index) => {
      const indexes = eventIndexesByTicker.get(event.ticker) ?? []
      indexes.push(index)
      eventIndexesByTicker.set(event.ticker, indexes)
    })
    const tickers = Array.from(eventIndexesByTicker.keys()).sort()
    const outcomes = new Array<TriggerOutcomeRow>(events.length)
    let marketSessions: string[] = []
    if (events.length > 0) {
      const firstEventDate = events.reduce(
        (earliest, event) => event.date < earliest ? event.date : earliest,
        events[0]?.date ?? currentSource.analysisCutoffDate,
      )
      const marketSessionStartedAt = performance.now()
      marketSessions = (await execAll<{ date: string }>(`SELECT DISTINCT date FROM ohlcv_daily
        WHERE date>=? AND date<=? ORDER BY date`, [firstEventDate, currentSource.analysisCutoffDate]))
        .map((session) => session.date)
      sqlMs += performance.now() - marketSessionStartedAt
      queryCount += 1
    }
    await updateProgress({
      row, ownerToken, controller, processedEvents: 0, totalEvents: events.length,
      processedTickers: 0, totalTickers: tickers.length,
    })
    let processedEvents = 0
    let processedTickers = 0
    for (const tickerBatch of chunks(tickers, OHLCV_TICKER_BATCH_SIZE)) {
      if (controller.signal.aborted) throw new DOMException('Outcome analysis cancelled', 'AbortError')
      const earliestEventDate = tickerBatch.reduce((earliest, ticker) => {
        const firstIndex = eventIndexesByTicker.get(ticker)?.[0]
        const date = firstIndex == null ? earliest : events[firstIndex]?.date
        return date && date < earliest ? date : earliest
      }, row.analysis_cutoff_date ?? currentSource.analysisCutoffDate)
      const placeholders = tickerBatch.map(() => '?').join(',')
      const sqlStartedAt = performance.now()
      const priceRows = await execAll<OutcomeOhlcvRow>(`SELECT ticker, date, high, low, close
        FROM ohlcv_daily WHERE ticker IN (${placeholders}) AND date>=? AND date<=?
        ORDER BY ticker, date`, [...tickerBatch, earliestEventDate, currentSource.analysisCutoffDate])
      if (controller.signal.aborted) throw new DOMException('Worker stopping', 'AbortError')
      sqlMs += performance.now() - sqlStartedAt
      queryCount += 1
      ohlcvRowCount += priceRows.length
      const seriesByTicker = new Map<string, OutcomeOhlcvRow[]>()
      for (const priceRow of priceRows) {
        const series = seriesByTicker.get(priceRow.ticker) ?? []
        series.push(priceRow)
        seriesByTicker.set(priceRow.ticker, series)
      }
      const calculationStartedAt = performance.now()
      for (const ticker of tickerBatch) {
        const series = seriesByTicker.get(ticker) ?? []
        for (const eventIndex of eventIndexesByTicker.get(ticker) ?? []) {
          const event = events[eventIndex]
          if (event) outcomes[eventIndex] = calculateEventOutcome(
            event,
            series,
            request.horizons,
            marketSessions,
          )
          processedEvents += 1
        }
        processedTickers += 1
      }
      calculationMs += performance.now() - calculationStartedAt
      const memory = process.memoryUsage()
      peakHeapBytes = Math.max(peakHeapBytes, memory.heapUsed)
      peakRssBytes = Math.max(peakRssBytes, memory.rss)
      await updateProgress({
        row, ownerToken, controller, processedEvents, totalEvents: events.length,
        processedTickers, totalTickers: tickers.length,
      })
    }
    if (controller.signal.aborted) throw new DOMException('Worker stopping', 'AbortError')
    const completeOutcomes = outcomes.filter((outcome): outcome is TriggerOutcomeRow => Boolean(outcome))
    const aggregationStartedAt = performance.now()
    const summaries = aggregateOutcomeRows(completeOutcomes, request.horizons)
    aggregationMs = performance.now() - aggregationStartedAt
    const byDate = [...completeOutcomes].sort((left, right) => (
      left.eventDate.localeCompare(right.eventDate) || left.ticker.localeCompare(right.ticker)
    ))
    const byTicker = [...completeOutcomes].sort((left, right) => (
      left.ticker.localeCompare(right.ticker) || left.eventDate.localeCompare(right.eventDate)
    ))
    const manifest: TriggerOutcomeManifest = {
      contractVersion: TRIGGER_DISCOVERY_OUTCOME_CONTRACT_VERSION,
      outcomeJobId: row.id,
      historicalScanJobId: row.historical_scan_job_id,
      sourceFingerprint: row.source_fingerprint,
      request,
      metadata: {
        analysisCutoffDate: currentSource.analysisCutoffDate,
        sourceTimeframe: source.row.timeframe,
        adjustmentBasis: 'JQUANTS_ADJUSTED_OHLCV',
        anchorPriceBasis: 'HISTORICAL_EVENT_CLOSE',
        excursionWindow: 'NEXT_SESSION_THROUGH_HORIZON',
        observationIndependenceNote: '同一銘柄の複数イベントを含むため、各観測は統計的に完全独立ではありません。',
      },
      summary: {
        selectedEventCount: completeOutcomes.length,
        uniqueTickerCount: tickers.length,
        horizons: summaries,
      },
      performance: {
        totalMs: 0,
        sqlMs,
        calculationMs,
        aggregationMs,
        serializationMs: 0,
        saveMs: 0,
        queryCount,
        selectedEventCount: completeOutcomes.length,
        uniqueTickerCount: tickers.length,
        ohlcvRowCount,
        peakHeapBytes,
        peakRssBytes,
      },
      generatedAt: new Date().toISOString(),
    }
    const rowsWritten = await Promise.all([
      writeRows(paths.rowsByDateTemp, byDate),
      writeRows(paths.rowsByTickerTemp, byTicker),
    ])
    serializationMs = rowsWritten.reduce((sum, item) => sum + item.serializationMs, 0)
    saveMs = rowsWritten.reduce((sum, item) => sum + item.writeMs, 0)
    const serializationStartedAt = performance.now()
    JSON.stringify(manifest)
    serializationMs += performance.now() - serializationStartedAt
    manifest.performance.serializationMs = serializationMs
    const saveStartedAt = performance.now()
    await writeFile(paths.manifestTemp, JSON.stringify(manifest), 'utf8')
    await Promise.all([
      rename(paths.rowsByDateTemp, paths.rowsByDate),
      rename(paths.rowsByTickerTemp, paths.rowsByTicker),
      rename(paths.manifestTemp, paths.manifest),
    ])
    saveMs += performance.now() - saveStartedAt
    manifest.performance.saveMs = saveMs
    manifest.performance.totalMs = performance.now() - startedAt
    const finalManifestSerializationStartedAt = performance.now()
    const finalManifest = JSON.stringify(manifest)
    serializationMs += performance.now() - finalManifestSerializationStartedAt
    manifest.performance.serializationMs = serializationMs
    const finalSaveStartedAt = performance.now()
    await writeFile(paths.manifestTemp, finalManifest, 'utf8')
    await rename(paths.manifestTemp, paths.manifest)
    saveMs += performance.now() - finalSaveStartedAt
    const fileStats = await Promise.all([
      stat(/* turbopackIgnore: true */ paths.manifest),
      stat(/* turbopackIgnore: true */ paths.rowsByDate),
      stat(/* turbopackIgnore: true */ paths.rowsByTicker),
    ])
    const state = await execGet<{ status: TriggerOutcomeJobStatus; cancel_requested: number }>(
      'SELECT status, cancel_requested FROM trigger_outcome_analysis_jobs WHERE id=? AND owner_token=?',
      [row.id, ownerToken],
    )
    if (!state || state.status !== 'RUNNING' || Number(state.cancel_requested) === 1) {
      await removeOutcomeFiles(row.id)
      await execRun(`UPDATE trigger_outcome_analysis_jobs SET status='CANCELLED', completed_at=unixepoch(),
        heartbeat_at=unixepoch(), owner_token=NULL, result_location=NULL, result_size_bytes=0,
        error_category=NULL WHERE id=? AND owner_token=? AND status IN ('RUNNING','CANCEL_REQUESTED')`,
      [row.id, ownerToken])
      return 'CANCELLED'
    }
    const resultSize = fileStats.reduce((sum, file) => sum + file.size, 0)
    const durationMs = performance.now() - startedAt
    const completed = await client.execute({
      sql: `UPDATE trigger_outcome_analysis_jobs SET status='COMPLETED', completed_at=unixepoch(),
        heartbeat_at=unixepoch(), owner_token=NULL, processed_events=?, total_events=?,
        processed_tickers=?, total_tickers=?, result_location=?, result_size_bytes=?, duration_ms=?,
        sql_ms=?, calculation_ms=?, aggregation_ms=?, serialization_ms=?, save_ms=?, error_category=NULL
        WHERE id=? AND owner_token=? AND status='RUNNING'`,
      args: [completeOutcomes.length, completeOutcomes.length, tickers.length, tickers.length,
        row.id, resultSize, durationMs, sqlMs, calculationMs, aggregationMs, serializationMs, saveMs,
        row.id, ownerToken],
    })
    if (Number(completed.rowsAffected) !== 1) {
      await removeOutcomeFiles(row.id)
      await execRun(`UPDATE trigger_outcome_analysis_jobs SET status='CANCELLED',
        completed_at=unixepoch(), heartbeat_at=unixepoch(), owner_token=NULL,
        result_location=NULL, result_size_bytes=0, error_category=NULL
        WHERE id=? AND owner_token=? AND status='CANCEL_REQUESTED'`, [row.id, ownerToken])
      return 'CANCELLED'
    }
    return 'COMPLETED'
  } catch (error) {
    await removeOutcomeFiles(row.id).catch(() => undefined)
    if (shutdownSignal?.aborted) {
      const cancelled = await client.execute({
        sql: `UPDATE trigger_outcome_analysis_jobs SET status='CANCELLED',
          completed_at=unixepoch(), heartbeat_at=unixepoch(), owner_token=NULL,
          result_location=NULL, result_size_bytes=0, error_category=NULL
          WHERE id=? AND owner_token=? AND status='CANCEL_REQUESTED'`,
        args: [row.id, ownerToken],
      })
      if (Number(cancelled.rowsAffected) === 0) {
        await execRun(`UPDATE trigger_outcome_analysis_jobs SET status='QUEUED', started_at=NULL,
          heartbeat_at=unixepoch(), owner_token=NULL, processed_events=0, processed_tickers=0,
          attempt_count=MAX(0,attempt_count-1),
          result_location=NULL, result_size_bytes=0, error_category='worker_recovered'
          WHERE id=? AND owner_token=? AND status='RUNNING'`, [row.id, ownerToken])
      }
      return Number(cancelled.rowsAffected) > 0 ? 'CANCELLED' : 'QUEUED'
    }
    const cancelled = error instanceof DOMException && error.name === 'AbortError'
    await execRun(`UPDATE trigger_outcome_analysis_jobs SET status=?, completed_at=unixepoch(),
      heartbeat_at=unixepoch(), owner_token=NULL, result_location=NULL, result_size_bytes=0,
      duration_ms=?, sql_ms=?, calculation_ms=?, aggregation_ms=?, serialization_ms=?, save_ms=?,
      error_category=? WHERE id=? AND owner_token=? AND status IN ('RUNNING','CANCEL_REQUESTED')`, [
      cancelled ? 'CANCELLED' : 'FAILED', performance.now() - startedAt, sqlMs, calculationMs,
      aggregationMs, serializationMs, saveMs, cancelled ? null : outcomeErrorCategory(error),
      row.id, ownerToken,
    ]).catch(() => undefined)
    if (!cancelled) throw error
    return 'CANCELLED'
  } finally {
    shutdownSignal?.removeEventListener('abort', onShutdown)
  }
}

export async function cleanupExpiredOutcomeJobs(now: () => number = Date.now): Promise<number> {
  const current = nowSeconds(now)
  const rows = await execAll<{ id: string }>(`SELECT id FROM trigger_outcome_analysis_jobs
    WHERE expires_at<=? AND status IN ('COMPLETED','FAILED','CANCELLED')`, [current])
  for (const row of rows) await removeOutcomeFiles(row.id).catch(() => undefined)
  if (rows.length > 0) {
    await execRun(`DELETE FROM trigger_outcome_analysis_jobs
      WHERE expires_at<=? AND status IN ('COMPLETED','FAILED','CANCELLED')`, [current])
  }
  return rows.length
}

export interface OutcomeResultQuery {
  offset: number
  limit: number
  sortBy: 'eventDate' | 'ticker'
  sortOrder: 'asc' | 'desc'
}

export function parseOutcomeResultQuery(url: string): OutcomeResultQuery {
  const search = new URL(url).searchParams
  const offset = Number(search.get('offset') ?? '0')
  const limit = Number(search.get('limit') ?? '100')
  const sortBy = search.get('sortBy') ?? 'eventDate'
  const sortOrder = search.get('sortOrder') ?? 'asc'
  if (!Number.isInteger(offset) || offset < 0) throw new TriggerOutcomeInputError('offset must be non-negative')
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RESULT_PAGE_SIZE) {
    throw new TriggerOutcomeInputError(`limit must be between 1 and ${MAX_RESULT_PAGE_SIZE}`)
  }
  if (sortBy !== 'eventDate' && sortBy !== 'ticker') {
    throw new TriggerOutcomeInputError('sortBy must be eventDate or ticker')
  }
  if (sortOrder !== 'asc' && sortOrder !== 'desc') {
    throw new TriggerOutcomeInputError('sortOrder must be asc or desc')
  }
  return { offset, limit, sortBy, sortOrder }
}

async function readOutcomePage(
  file: string,
  totalCount: number,
  query: OutcomeResultQuery,
): Promise<TriggerOutcomeRow[]> {
  const ascendingStart = query.sortOrder === 'asc'
    ? query.offset
    : Math.max(0, totalCount - query.offset - query.limit)
  const ascendingEnd = query.sortOrder === 'asc'
    ? Math.min(totalCount, query.offset + query.limit)
    : Math.max(0, totalCount - query.offset)
  const rows: TriggerOutcomeRow[] = []
  const input = createReadStream(file, { encoding: 'utf8' })
  const lines = createInterface({ input, crlfDelay: Infinity })
  let index = 0
  try {
    for await (const line of lines) {
      if (index >= ascendingEnd) break
      if (line && index >= ascendingStart) rows.push(JSON.parse(line) as TriggerOutcomeRow)
      index += 1
    }
  } finally {
    lines.close()
    input.destroy()
  }
  return query.sortOrder === 'desc' ? rows.reverse() : rows
}

export async function getOutcomeAnalysisResult(input: {
  id: string
  query: OutcomeResultQuery
}): Promise<TriggerOutcomeResultResponse | null | 'NOT_READY' | 'EXPIRED'> {
  const row = await jobRow(input.id)
  if (!row) return null
  if (row.status !== 'COMPLETED') return 'NOT_READY'
  if (Number(row.expires_at) <= nowSeconds()
    || !await isHistoricalScanJobResultCurrent(row.historical_scan_job_id)) return 'EXPIRED'
  const paths = outcomeResultPaths(row.id)
  try {
    const manifest = JSON.parse(
      await readFile(/* turbopackIgnore: true */ paths.manifest, 'utf8'),
    ) as TriggerOutcomeManifest
    const rows = await readOutcomePage(
      input.query.sortBy === 'ticker' ? paths.rowsByTicker : paths.rowsByDate,
      manifest.summary.selectedEventCount,
      input.query,
    )
    return {
      ...manifest,
      rows,
      rowPage: {
        offset: input.query.offset,
        limit: input.query.limit,
        returnedCount: rows.length,
        totalCount: manifest.summary.selectedEventCount,
        hasMore: input.query.offset + rows.length < manifest.summary.selectedEventCount,
        sortBy: input.query.sortBy,
        sortOrder: input.query.sortOrder,
      },
    }
  } catch {
    return 'EXPIRED'
  }
}

export function isOutcomeJobStatus(value: string): value is TriggerOutcomeJobStatus {
  return TRIGGER_OUTCOME_JOB_STATUSES.includes(value as TriggerOutcomeJobStatus)
}
