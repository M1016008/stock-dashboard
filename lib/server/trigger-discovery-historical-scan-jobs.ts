import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import type { Transaction } from '@libsql/client'
import { client, ensureReady, execAll, execGet, execRun } from '@/lib/db/client'
import { TRIGGER_ENGINE_VERSION, type TriggerStatus } from '@/lib/trigger-discovery-engine'
import {
  MAX_HISTORICAL_SCAN_TRADING_DAYS,
  getTriggerHistoricalScan,
  type TriggerHistoricalScanOptions,
} from '@/lib/server/trigger-discovery-historical-scan'
import {
  DEFAULT_HISTORICAL_SCAN_EVENT_LIMIT,
  MAX_HISTORICAL_SCAN_EVENT_LIMIT,
  parseTriggerHistoricalScanRequest,
} from '@/lib/server/trigger-discovery-historical-scan-request'
import type {
  TriggerHistoricalScanEvent,
  TriggerHistoricalScanEventType,
  TriggerHistoricalScanRequest,
  TriggerHistoricalScanResponse,
} from '@/lib/trigger-discovery-historical-scan-contract'
import {
  TRIGGER_HISTORICAL_SCAN_JOB_CONTRACT_VERSION,
  type TriggerHistoricalScanJobListResponse,
  type TriggerHistoricalScanJobStartResponse,
  type TriggerHistoricalScanJobStatus,
  type TriggerHistoricalScanJobSummary,
} from '@/lib/trigger-discovery-historical-scan-job'
import { TRIGGER_SCORE_VERSION } from '@/lib/trigger-score'

const DEFAULT_JOB_TTL_DAYS = 7
const DEFAULT_REUSE_SECONDS = 15 * 60
const DEFAULT_STALE_SECONDS = 3 * 60
const DEFAULT_POLL_MS = 2_000
const MAX_ATTEMPTS = 2
const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type TriggerHistoricalScanJobRow = {
  id: string
  status: TriggerHistoricalScanJobStatus
  request_json: string
  request_signature: string
  source_fingerprint: string
  requested_start: string
  requested_end: string
  resolved_start: string | null
  resolved_end: string | null
  timeframe: TriggerHistoricalScanRequest['timeframe']
  created_at: number
  started_at: number | null
  completed_at: number | null
  heartbeat_at: number | null
  total_trading_days: number
  processed_trading_days: number
  result_location: string | null
  result_size_bytes: number
  duration_ms: number
  serialization_ms: number
  error_category: string | null
  cancel_requested: number
  owner_token: string | null
  attempt_count: number
  expires_at: number
}

type SourceFingerprintRow = {
  ohlcv_date: string | null
  weekly_date: string | null
  monthly_ma_date: string | null
  stage_date: string | null
  source_batch_at: number | null
}

type ScanRunner = typeof getTriggerHistoricalScan

export interface HistoricalScanWorkerDependencies {
  scan?: ScanRunner
  now?: () => number
}

function boundedIntegerEnv(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name])
  if (!Number.isInteger(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

function nowSeconds(now: () => number = Date.now): number {
  return Math.floor(now() / 1_000)
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

function jobRequest(request: TriggerHistoricalScanRequest): Omit<
  TriggerHistoricalScanRequest,
  'eventOffset' | 'eventLimit'
> {
  const { eventOffset: _eventOffset, eventLimit: _eventLimit, ...rest } = request
  return rest
}

function resultRoot(): string {
  return process.env.STOCKBOARD_HISTORICAL_SCAN_DIR?.trim()
    || path.join(os.homedir(), 'Library', 'Application Support', 'StockBoard', 'historical-trigger-scans')
}

export function historicalScanResultPaths(jobId: string): {
  manifest: string
  events: string
  manifestTemp: string
  eventsTemp: string
} {
  if (!JOB_ID_PATTERN.test(jobId)) throw new Error('invalid_historical_scan_job_id')
  const root = resultRoot()
  return {
    manifest: path.join(root, `${jobId}.json`),
    events: path.join(root, `${jobId}.events.ndjson`),
    manifestTemp: path.join(root, `${jobId}.json.tmp`),
    eventsTemp: path.join(root, `${jobId}.events.ndjson.tmp`),
  }
}

async function removeJobFiles(jobId: string): Promise<void> {
  const paths = historicalScanResultPaths(jobId)
  await Promise.all(Object.values(paths).map((file) => rm(file, { force: true })))
}

async function sourceFingerprint(): Promise<string> {
  const row = await execGet<SourceFingerprintRow>(`SELECT
    (SELECT MAX(date) FROM ohlcv_daily) AS ohlcv_date,
    (SELECT MAX(date) FROM weekly_ohlcv) AS weekly_date,
    (SELECT MAX(date) FROM monthly_ma_monitor_daily) AS monthly_ma_date,
    (SELECT MAX(date) FROM daily_snapshots) AS stage_date,
    (SELECT MAX(finished_at) FROM batch_runs
      WHERE job_type IN ('ohlcv_fetch','snapshot_compute','weekly_ohlcv','monthly_ma_monitor')) AS source_batch_at`)
  return createHash('sha256').update(stableJson(row ?? {})).digest('hex')
}

async function tradingDayCount(startDate: string, endDate: string): Promise<number> {
  const row = await execGet<{ count: number }>(
    'SELECT COUNT(DISTINCT date) AS count FROM ohlcv_daily WHERE date BETWEEN ? AND ?',
    [startDate, endDate],
  )
  return Number(row?.count ?? 0)
}

async function transactionJob(tx: Transaction, id: string): Promise<TriggerHistoricalScanJobRow | null> {
  const result = await tx.execute({
    sql: 'SELECT * FROM historical_trigger_scan_jobs WHERE id=?',
    args: [id],
  })
  return (result.rows[0] as unknown as TriggerHistoricalScanJobRow | undefined) ?? null
}

async function jobRow(id: string): Promise<TriggerHistoricalScanJobRow | null> {
  if (!JOB_ID_PATTERN.test(id)) return null
  return (await execGet<TriggerHistoricalScanJobRow>(
    'SELECT * FROM historical_trigger_scan_jobs WHERE id=?',
    [id],
  )) ?? null
}

function parseStoredRequest(row: TriggerHistoricalScanJobRow): Omit<
  TriggerHistoricalScanRequest,
  'eventOffset' | 'eventLimit'
> {
  return JSON.parse(row.request_json) as Omit<TriggerHistoricalScanRequest, 'eventOffset' | 'eventLimit'>
}

async function filesAvailable(jobId: string): Promise<boolean> {
  const paths = historicalScanResultPaths(jobId)
  try {
    await Promise.all([
      stat(/* turbopackIgnore: true */ paths.manifest),
      stat(/* turbopackIgnore: true */ paths.events),
    ])
    return true
  } catch {
    return false
  }
}

async function jobSummary(row: TriggerHistoricalScanJobRow): Promise<TriggerHistoricalScanJobSummary> {
  const unexpired = Number(row.expires_at) > nowSeconds()
  const available = row.status === 'COMPLETED' && row.result_location === row.id
    && unexpired && await filesAvailable(row.id)
  return {
    contractVersion: TRIGGER_HISTORICAL_SCAN_JOB_CONTRACT_VERSION,
    jobId: row.id,
    status: row.status,
    request: parseStoredRequest(row),
    requestedStartDate: row.requested_start,
    requestedEndDate: row.requested_end,
    resolvedStartDate: row.resolved_start,
    resolvedEndDate: row.resolved_end,
    timeframe: row.timeframe,
    progress: {
      processedTradingDays: Number(row.processed_trading_days),
      totalTradingDays: Number(row.total_trading_days),
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

export async function createHistoricalScanJob(
  value: unknown,
): Promise<TriggerHistoricalScanJobStartResponse> {
  const parsed = parseTriggerHistoricalScanRequest(value)
  const request = jobRequest(parsed.request)
  const totalDays = await tradingDayCount(request.startDate, request.endDate)
  if (totalDays > MAX_HISTORICAL_SCAN_TRADING_DAYS) {
    throw new RangeError(`historical scan supports at most ${MAX_HISTORICAL_SCAN_TRADING_DAYS} trading days`)
  }
  const fingerprint = await sourceFingerprint()
  const requestSignature = createHash('sha256').update(stableJson({
    request,
    contractVersion: TRIGGER_HISTORICAL_SCAN_JOB_CONTRACT_VERSION,
    engineVersion: TRIGGER_ENGINE_VERSION,
    scoreVersion: TRIGGER_SCORE_VERSION,
  })).digest('hex')
  const now = nowSeconds()
  const reuseSeconds = boundedIntegerEnv(
    'TRIGGER_HISTORICAL_SCAN_REUSE_SECONDS', DEFAULT_REUSE_SECONDS, 0, 86_400,
  )
  const ttlSeconds = boundedIntegerEnv(
    'TRIGGER_HISTORICAL_SCAN_TTL_DAYS', DEFAULT_JOB_TTL_DAYS, 1, 30,
  ) * 86_400
  const id = randomUUID()
  await ensureReady()
  const tx = await beginWriteTransaction()
  try {
    const existingResult = await tx.execute({
      sql: `SELECT * FROM historical_trigger_scan_jobs
        WHERE request_signature=? AND source_fingerprint=? AND expires_at>?
          AND (
            status IN ('QUEUED','RUNNING')
            OR (status='COMPLETED' AND completed_at>=?)
          )
        ORDER BY CASE status WHEN 'COMPLETED' THEN 0 WHEN 'RUNNING' THEN 1 ELSE 2 END,
                 created_at DESC
        LIMIT 1`,
      args: [requestSignature, fingerprint, now, now - reuseSeconds],
    })
    const existing = existingResult.rows[0] as unknown as TriggerHistoricalScanJobRow | undefined
    if (existing) {
      if (existing.status !== 'COMPLETED' || await filesAvailable(existing.id)) {
        await tx.commit()
        return {
          contractVersion: TRIGGER_HISTORICAL_SCAN_JOB_CONTRACT_VERSION,
          jobId: existing.id,
          status: existing.status,
          reused: true,
        }
      }
    }
    await tx.execute({
      sql: `INSERT INTO historical_trigger_scan_jobs (
        id, status, request_json, request_signature, source_fingerprint,
        requested_start, requested_end, timeframe, created_at,
        total_trading_days, processed_trading_days, expires_at
      ) VALUES (?, 'QUEUED', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      args: [id, JSON.stringify(request), requestSignature, fingerprint,
        request.startDate, request.endDate, parsed.timeframe, now, totalDays, now + ttlSeconds],
    })
    await tx.commit()
    return {
      contractVersion: TRIGGER_HISTORICAL_SCAN_JOB_CONTRACT_VERSION,
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

export async function getHistoricalScanJob(id: string): Promise<TriggerHistoricalScanJobSummary | null> {
  const row = await jobRow(id)
  return row ? jobSummary(row) : null
}

export async function listHistoricalScanJobs(limit = 20): Promise<TriggerHistoricalScanJobListResponse> {
  const boundedLimit = Math.max(1, Math.min(20, Math.trunc(limit)))
  const rows = await execAll<TriggerHistoricalScanJobRow>(
    'SELECT * FROM historical_trigger_scan_jobs ORDER BY created_at DESC LIMIT ?',
    [boundedLimit],
  )
  return {
    contractVersion: TRIGGER_HISTORICAL_SCAN_JOB_CONTRACT_VERSION,
    jobs: await Promise.all(rows.map(jobSummary)),
  }
}

export async function cancelHistoricalScanJob(id: string): Promise<TriggerHistoricalScanJobSummary | null> {
  if (!JOB_ID_PATTERN.test(id)) return null
  await ensureReady()
  const tx = await beginWriteTransaction()
  try {
    const row = await transactionJob(tx, id)
    if (!row) {
      await tx.commit()
      return null
    }
    if (row.status === 'QUEUED') {
      await tx.execute({
        sql: `UPDATE historical_trigger_scan_jobs SET
          status='CANCELLED', cancel_requested=1, completed_at=unixepoch(),
          heartbeat_at=unixepoch(), owner_token=NULL, error_category=NULL
          WHERE id=? AND status='QUEUED'`,
        args: [id],
      })
    } else if (row.status === 'RUNNING') {
      await tx.execute({
        sql: `UPDATE historical_trigger_scan_jobs SET
          status='CANCEL_REQUESTED', cancel_requested=1, heartbeat_at=unixepoch()
          WHERE id=? AND status='RUNNING'`,
        args: [id],
      })
    }
    const updated = await transactionJob(tx, id)
    await tx.commit()
    return updated ? jobSummary(updated) : null
  } catch (error) {
    await tx.rollback().catch(() => undefined)
    throw error
  } finally {
    tx.close()
  }
}

function staleSeconds(): number {
  return boundedIntegerEnv(
    'TRIGGER_HISTORICAL_SCAN_STALE_SECONDS', DEFAULT_STALE_SECONDS, 30, 3_600,
  )
}

export async function recoverStaleHistoricalScanJobs(now: () => number = Date.now): Promise<{
  requeued: number
  failed: number
  cancelled: number
}> {
  const current = nowSeconds(now)
  const cutoff = current - staleSeconds()
  await ensureReady()
  const tx = await beginWriteTransaction()
  try {
    const cancelled = await tx.execute({
      sql: `UPDATE historical_trigger_scan_jobs SET
        status='CANCELLED', completed_at=?, owner_token=NULL, heartbeat_at=?, error_category=NULL
        WHERE status='CANCEL_REQUESTED' AND COALESCE(heartbeat_at, started_at, created_at)<=?`,
      args: [current, current, cutoff],
    })
    const failed = await tx.execute({
      sql: `UPDATE historical_trigger_scan_jobs SET
        status='FAILED', completed_at=?, owner_token=NULL, heartbeat_at=?,
        error_category='worker_stale_after_retry'
        WHERE status='RUNNING' AND COALESCE(heartbeat_at, started_at, created_at)<=?
          AND attempt_count>=?`,
      args: [current, current, cutoff, MAX_ATTEMPTS],
    })
    const requeued = await tx.execute({
      sql: `UPDATE historical_trigger_scan_jobs SET
        status='QUEUED', started_at=NULL, owner_token=NULL, heartbeat_at=?,
        processed_trading_days=0, error_category='worker_recovered'
        WHERE status='RUNNING' AND COALESCE(heartbeat_at, started_at, created_at)<=?
          AND attempt_count<?`,
      args: [current, cutoff, MAX_ATTEMPTS],
    })
    await tx.commit()
    return {
      requeued: Number(requeued.rowsAffected),
      failed: Number(failed.rowsAffected),
      cancelled: Number(cancelled.rowsAffected),
    }
  } catch (error) {
    await tx.rollback().catch(() => undefined)
    throw error
  } finally {
    tx.close()
  }
}

export async function claimNextHistoricalScanJob(
  ownerToken = randomUUID(),
  now: () => number = Date.now,
): Promise<TriggerHistoricalScanJobRow | null> {
  const current = nowSeconds(now)
  const candidate = await execGet<{ id: string }>(`SELECT id FROM historical_trigger_scan_jobs
    WHERE status='QUEUED'
      AND NOT EXISTS (
        SELECT 1 FROM historical_trigger_scan_jobs
        WHERE status IN ('RUNNING','CANCEL_REQUESTED')
      )
      AND NOT EXISTS (
        SELECT 1 FROM trigger_outcome_analysis_jobs
        WHERE status IN ('RUNNING','CANCEL_REQUESTED')
      )
    ORDER BY created_at, id LIMIT 1`)
  if (!candidate) return null
  await ensureReady()
  const claimed = await client.execute({
    sql: `UPDATE historical_trigger_scan_jobs SET
        status='RUNNING', started_at=?, completed_at=NULL, heartbeat_at=?, owner_token=?,
        cancel_requested=0, processed_trading_days=0, result_location=NULL,
        result_size_bytes=0, duration_ms=0, serialization_ms=0, error_category=NULL,
        attempt_count=attempt_count+1
        WHERE id=? AND status='QUEUED'
          AND NOT EXISTS (
            SELECT 1 FROM historical_trigger_scan_jobs
            WHERE status IN ('RUNNING','CANCEL_REQUESTED') AND id<>?
          )
          AND NOT EXISTS (
            SELECT 1 FROM trigger_outcome_analysis_jobs
            WHERE status IN ('RUNNING','CANCEL_REQUESTED')
          )
        RETURNING *`,
    args: [current, current, ownerToken, candidate.id, candidate.id],
  })
  return (claimed.rows[0] as unknown as TriggerHistoricalScanJobRow | undefined) ?? null
}

function errorCategory(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled'
  if (error instanceof RangeError) return 'invalid_range'
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
  if (message.includes('memory') || message.includes('heap') || message.includes('allocation')) return 'memory_limit'
  if (message.includes('database') || message.includes('sqlite') || message.includes('busy')) return 'database_error'
  return 'historical_scan_failed'
}

async function writeEventLines(
  stream: ReturnType<typeof createWriteStream>,
  events: TriggerHistoricalScanEvent[],
): Promise<void> {
  if (events.length === 0) return
  const payload = `${events.map((event) => JSON.stringify(event)).join('\n')}\n`
  if (!stream.write(payload)) await once(stream, 'drain')
}

async function closeWriteStream(stream: ReturnType<typeof createWriteStream>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.once('error', reject)
    stream.end(resolve)
  })
}

async function updateWorkerProgress(input: {
  row: TriggerHistoricalScanJobRow
  ownerToken: string
  progress: { processedTradingDays: number; totalTradingDays: number }
  controller: AbortController
}): Promise<void> {
  const state = await execGet<{ status: TriggerHistoricalScanJobStatus; cancel_requested: number; owner_token: string | null }>(
    'SELECT status, cancel_requested, owner_token FROM historical_trigger_scan_jobs WHERE id=?',
    [input.row.id],
  )
  if (!state || state.owner_token !== input.ownerToken || state.status !== 'RUNNING'
    || Number(state.cancel_requested) === 1) {
    input.controller.abort()
    throw new DOMException('Historical scan cancelled', 'AbortError')
  }
  await execRun(`UPDATE historical_trigger_scan_jobs SET
    processed_trading_days=?, total_trading_days=?, heartbeat_at=unixepoch()
    WHERE id=? AND owner_token=? AND status='RUNNING'`, [
    input.progress.processedTradingDays,
    input.progress.totalTradingDays,
    input.row.id,
    input.ownerToken,
  ])
}

export async function executeHistoricalScanJob(
  row: TriggerHistoricalScanJobRow,
  dependencies: HistoricalScanWorkerDependencies = {},
): Promise<TriggerHistoricalScanJobStatus> {
  if (row.status !== 'RUNNING' || !row.owner_token) throw new Error('historical_scan_job_not_claimed')
  const startedAt = performance.now()
  const ownerToken = row.owner_token
  const controller = new AbortController()
  const paths = historicalScanResultPaths(row.id)
  await mkdir(resultRoot(), { recursive: true })
  await removeJobFiles(row.id)
  const eventStream = createWriteStream(paths.eventsTemp, { encoding: 'utf8' })
  let lastProgressWriteAt = 0
  let lastProcessed = -1
  try {
    const storedRequest = parseStoredRequest(row)
    const parsed = parseTriggerHistoricalScanRequest({
      ...storedRequest,
      eventOffset: 0,
      eventLimit: 1,
    })
    const scanOptions: TriggerHistoricalScanOptions = {
      signal: controller.signal,
      onEvents: async (_date, events) => writeEventLines(eventStream, events),
      onProgress: async (progress) => {
        const now = Date.now()
        const final = progress.processedTradingDays === progress.totalTradingDays
        const advancedEnough = progress.processedTradingDays - lastProcessed >= 5
        if (!final && !advancedEnough && now - lastProgressWriteAt < 1_000) return
        await updateWorkerProgress({ row, ownerToken, progress, controller })
        lastProgressWriteAt = now
        lastProcessed = progress.processedTradingDays
      },
    }
    const response = await (dependencies.scan ?? getTriggerHistoricalScan)({
      requestedStartDate: storedRequest.startDate,
      requestedEndDate: storedRequest.endDate,
      timeframe: parsed.timeframe,
      criteria: parsed.input,
      eventOffset: 0,
      eventLimit: 1,
    }, scanOptions)
    await closeWriteStream(eventStream)
    const serializationStartedAt = performance.now()
    const storedResponse: TriggerHistoricalScanResponse = {
      ...response,
      events: [],
      eventPage: {
        offset: 0,
        limit: 0,
        returnedCount: 0,
        totalCount: response.summary.totalEventCount,
        hasMore: response.summary.totalEventCount > 0,
      },
    }
    await writeFile(paths.manifestTemp, JSON.stringify(storedResponse), 'utf8')
    await rename(paths.eventsTemp, paths.events)
    await rename(paths.manifestTemp, paths.manifest)
    const [manifestStat, eventsStat] = await Promise.all([
      stat(/* turbopackIgnore: true */ paths.manifest),
      stat(/* turbopackIgnore: true */ paths.events),
    ])
    const serializationMs = performance.now() - serializationStartedAt
    const state = await execGet<{ status: TriggerHistoricalScanJobStatus; cancel_requested: number }>(
      'SELECT status, cancel_requested FROM historical_trigger_scan_jobs WHERE id=? AND owner_token=?',
      [row.id, ownerToken],
    )
    if (!state || state.status !== 'RUNNING' || Number(state.cancel_requested) === 1) {
      await removeJobFiles(row.id)
      await execRun(`UPDATE historical_trigger_scan_jobs SET
        status='CANCELLED', completed_at=unixepoch(), heartbeat_at=unixepoch(), owner_token=NULL,
        result_location=NULL, result_size_bytes=0, error_category=NULL
        WHERE id=? AND owner_token=? AND status IN ('RUNNING','CANCEL_REQUESTED')`, [row.id, ownerToken])
      return 'CANCELLED'
    }
    await ensureReady()
    const completed = await client.execute({
      sql: `UPDATE historical_trigger_scan_jobs SET
        status='COMPLETED', completed_at=unixepoch(), heartbeat_at=unixepoch(), owner_token=NULL,
        processed_trading_days=?, total_trading_days=?, resolved_start=?, resolved_end=?,
        result_location=?, result_size_bytes=?, duration_ms=?, serialization_ms=?, error_category=NULL
        WHERE id=? AND owner_token=? AND status='RUNNING'`,
      args: [
        response.scanMeta.processedTradingDays,
        response.scanMeta.tradingDayCount,
        response.scanMeta.resolvedStartDate,
        response.scanMeta.resolvedEndDate,
        row.id,
        manifestStat.size + eventsStat.size,
        performance.now() - startedAt,
        serializationMs,
        row.id,
        ownerToken,
      ],
    })
    if (Number(completed.rowsAffected) !== 1) {
      await removeJobFiles(row.id)
      await execRun(`UPDATE historical_trigger_scan_jobs SET
        status='CANCELLED', completed_at=unixepoch(), heartbeat_at=unixepoch(), owner_token=NULL,
        result_location=NULL, result_size_bytes=0, error_category=NULL
        WHERE id=? AND owner_token=? AND status='CANCEL_REQUESTED'`, [row.id, ownerToken])
      return 'CANCELLED'
    }
    return 'COMPLETED'
  } catch (error) {
    eventStream.destroy()
    await removeJobFiles(row.id).catch(() => undefined)
    const cancelled = error instanceof DOMException && error.name === 'AbortError'
    await execRun(`UPDATE historical_trigger_scan_jobs SET
      status=?, completed_at=unixepoch(), heartbeat_at=unixepoch(), owner_token=NULL,
      result_location=NULL, result_size_bytes=0, duration_ms=?, error_category=?
      WHERE id=? AND owner_token=? AND status IN ('RUNNING','CANCEL_REQUESTED')`, [
      cancelled ? 'CANCELLED' : 'FAILED',
      performance.now() - startedAt,
      cancelled ? null : errorCategory(error),
      row.id,
      ownerToken,
    ]).catch(() => undefined)
    if (!cancelled) throw error
    return 'CANCELLED'
  }
}

export async function runHistoricalScanWorkerOnce(
  dependencies: HistoricalScanWorkerDependencies = {},
): Promise<{ jobId: string; status: TriggerHistoricalScanJobStatus } | null> {
  const row = await claimNextHistoricalScanJob(randomUUID(), dependencies.now)
  if (!row) return null
  try {
    const status = await executeHistoricalScanJob(row, dependencies)
    return { jobId: row.id, status }
  } catch (error) {
    console.error(
      `[trigger-historical-scan-worker] job=${row.id} failed category=${errorCategory(error)}`
      + ` message=${error instanceof Error ? error.message : String(error)}`,
    )
    return { jobId: row.id, status: 'FAILED' }
  }
}

export async function cleanupExpiredHistoricalScanJobs(
  now: () => number = Date.now,
): Promise<number> {
  const current = nowSeconds(now)
  const rows = await execAll<{ id: string }>(`SELECT id FROM historical_trigger_scan_jobs
    WHERE expires_at<=? AND status IN ('COMPLETED','FAILED','CANCELLED')`, [current])
  for (const row of rows) await removeJobFiles(row.id).catch(() => undefined)
  if (rows.length > 0) {
    await execRun(`DELETE FROM historical_trigger_scan_jobs
      WHERE expires_at<=? AND status IN ('COMPLETED','FAILED','CANCELLED')`, [current])
  }
  return rows.length
}

export async function runHistoricalScanWorkerLoop(): Promise<void> {
  const pollMs = boundedIntegerEnv('TRIGGER_HISTORICAL_SCAN_POLL_MS', DEFAULT_POLL_MS, 250, 30_000)
  let stopping = false
  const stop = () => { stopping = true }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  let recovered: Awaited<ReturnType<typeof recoverStaleHistoricalScanJobs>> | null = null
  while (!stopping && !recovered) {
    try {
      await cleanupExpiredHistoricalScanJobs()
      recovered = await recoverStaleHistoricalScanJobs()
    } catch (error) {
      console.error(
        `[trigger-historical-scan-worker] startup retry category=${errorCategory(error)}`
        + ` message=${error instanceof Error ? error.message : String(error)}`,
      )
      await new Promise((resolve) => setTimeout(resolve, pollMs))
    }
  }
  if (stopping) {
    console.log('[trigger-historical-scan-worker] stopped')
    return
  }
  console.log(`[trigger-historical-scan-worker] started concurrency=1 recovered=${JSON.stringify(recovered)}`)
  while (!stopping) {
    try {
      const result = await runHistoricalScanWorkerOnce()
      if (result) {
        console.log(`[trigger-historical-scan-worker] job=${result.jobId} status=${result.status}`)
        continue
      }
    } catch (error) {
      console.error(
        `[trigger-historical-scan-worker] poll retry category=${errorCategory(error)}`
        + ` message=${error instanceof Error ? error.message : String(error)}`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
  console.log('[trigger-historical-scan-worker] stopped')
}

const HISTORICAL_SCAN_EVENT_TYPES = new Set<TriggerHistoricalScanEventType>([
  'ENTERED',
  'RE_ENTRY',
  'STATUS_CHANGED',
  'EXITED',
])
const HISTORICAL_SCAN_EVENT_STATUSES = new Set<TriggerStatus>([
  'NOT_MATCHED',
  'APPROACHING',
  'NEAR',
  'IN_ZONE',
  'BELOW_ZONE',
])

export interface HistoricalScanResultQuery {
  eventOffset: number
  eventLimit: number
  eventType: TriggerHistoricalScanEventType | null
  currentStatus: TriggerStatus | null
  eventDate: string | null
  eventSearch: string | null
  eventOrder: 'asc' | 'desc'
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

export function parseHistoricalScanResultPagination(url: string): HistoricalScanResultQuery {
  const search = new URL(url).searchParams
  const rawOffset = search.get('eventOffset') ?? '0'
  const rawLimit = search.get('eventLimit') ?? String(DEFAULT_HISTORICAL_SCAN_EVENT_LIMIT)
  const rawEventType = search.get('eventType')
  const rawCurrentStatus = search.get('currentStatus')
  const rawEventDate = search.get('eventDate')
  const rawEventSearch = search.get('eventSearch')?.normalize('NFKC').trim() ?? ''
  const rawEventOrder = search.get('eventOrder') ?? 'asc'
  const eventOffset = Number(rawOffset)
  const eventLimit = Number(rawLimit)
  if (!Number.isInteger(eventOffset) || eventOffset < 0) throw new RangeError('eventOffset must be a non-negative integer')
  if (!Number.isInteger(eventLimit) || eventLimit < 1 || eventLimit > MAX_HISTORICAL_SCAN_EVENT_LIMIT) {
    throw new RangeError(`eventLimit must be an integer between 1 and ${MAX_HISTORICAL_SCAN_EVENT_LIMIT}`)
  }
  if (rawEventType && !HISTORICAL_SCAN_EVENT_TYPES.has(rawEventType as TriggerHistoricalScanEventType)) {
    throw new RangeError('eventType is not supported')
  }
  if (rawCurrentStatus && !HISTORICAL_SCAN_EVENT_STATUSES.has(rawCurrentStatus as TriggerStatus)) {
    throw new RangeError('currentStatus is not supported')
  }
  if (rawEventDate && !isIsoDate(rawEventDate)) throw new RangeError('eventDate must use YYYY-MM-DD')
  if (rawEventSearch.length > 80) throw new RangeError('eventSearch must be 80 characters or fewer')
  if (rawEventOrder !== 'asc' && rawEventOrder !== 'desc') throw new RangeError('eventOrder must be asc or desc')
  return {
    eventOffset,
    eventLimit,
    eventType: rawEventType as TriggerHistoricalScanEventType | null,
    currentStatus: rawCurrentStatus as TriggerStatus | null,
    eventDate: rawEventDate,
    eventSearch: rawEventSearch || null,
    eventOrder: rawEventOrder,
  }
}

function eventMatches(
  event: TriggerHistoricalScanEvent,
  eventType: TriggerHistoricalScanEventType | null,
  currentStatus: TriggerStatus | null,
  eventDate: string | null,
  eventSearch: string | null,
): boolean {
  if (eventType && event.eventType !== eventType) return false
  if (currentStatus && event.currentStatus !== currentStatus) return false
  if (eventDate && event.date !== eventDate) return false
  if (!eventSearch) return true
  const needle = eventSearch.toLocaleLowerCase('ja-JP')
  return event.ticker.normalize('NFKC').toLocaleLowerCase('ja-JP').includes(needle)
    || event.companyName.normalize('NFKC').toLocaleLowerCase('ja-JP').includes(needle)
}

async function readAscendingEventPage(
  file: string,
  offset: number,
  limit: number,
  eventType: TriggerHistoricalScanEventType | null,
  currentStatus: TriggerStatus | null,
  eventDate: string | null,
  eventSearch: string | null,
  knownTotalCount: number | null,
): Promise<{ events: TriggerHistoricalScanEvent[]; totalCount: number }> {
  const events: TriggerHistoricalScanEvent[] = []
  const input = createReadStream(file, { encoding: 'utf8' })
  const lines = createInterface({ input, crlfDelay: Infinity })
  let matchedCount = 0
  try {
    for await (const line of lines) {
      if (!line) continue
      const event = JSON.parse(line) as TriggerHistoricalScanEvent
      if (!eventMatches(event, eventType, currentStatus, eventDate, eventSearch)) continue
      if (matchedCount >= offset && events.length < limit) events.push(event)
      matchedCount += 1
      if (knownTotalCount != null && events.length >= limit) break
    }
  } finally {
    lines.close()
    input.destroy()
  }
  return { events, totalCount: knownTotalCount ?? matchedCount }
}

async function countMatchingEvents(
  file: string,
  eventType: TriggerHistoricalScanEventType | null,
  currentStatus: TriggerStatus | null,
  eventDate: string | null,
  eventSearch: string | null,
): Promise<number> {
  const input = createReadStream(file, { encoding: 'utf8' })
  const lines = createInterface({ input, crlfDelay: Infinity })
  let count = 0
  try {
    for await (const line of lines) {
      if (line && eventMatches(
        JSON.parse(line) as TriggerHistoricalScanEvent,
        eventType,
        currentStatus,
        eventDate,
        eventSearch,
      )) count += 1
    }
  } finally {
    lines.close()
    input.destroy()
  }
  return count
}

async function readDescendingEventPage(
  file: string,
  offset: number,
  limit: number,
  eventType: TriggerHistoricalScanEventType | null,
  currentStatus: TriggerStatus | null,
  eventDate: string | null,
  eventSearch: string | null,
  knownTotalCount: number | null,
): Promise<{ events: TriggerHistoricalScanEvent[]; totalCount: number }> {
  const totalCount = knownTotalCount ?? await countMatchingEvents(
    file,
    eventType,
    currentStatus,
    eventDate,
    eventSearch,
  )
  const chronologicalStart = Math.max(0, totalCount - offset - limit)
  const chronologicalEnd = Math.max(0, totalCount - offset)
  const selected: TriggerHistoricalScanEvent[] = []
  const input = createReadStream(file, { encoding: 'utf8' })
  const lines = createInterface({ input, crlfDelay: Infinity })
  let matchedIndex = 0
  try {
    for await (const line of lines) {
      if (!line) continue
      const event = JSON.parse(line) as TriggerHistoricalScanEvent
      if (!eventMatches(event, eventType, currentStatus, eventDate, eventSearch)) continue
      if (matchedIndex >= chronologicalStart && matchedIndex < chronologicalEnd) selected.push(event)
      matchedIndex += 1
      if (matchedIndex >= chronologicalEnd) break
    }
  } finally {
    lines.close()
    input.destroy()
  }
  return { events: selected.reverse(), totalCount }
}

export async function getHistoricalScanJobResult(input: {
  id: string
  eventOffset: number
  eventLimit: number
  eventType?: TriggerHistoricalScanEventType | null
  currentStatus?: TriggerStatus | null
  eventDate?: string | null
  eventSearch?: string | null
  eventOrder?: 'asc' | 'desc'
}): Promise<TriggerHistoricalScanResponse | null | 'NOT_READY' | 'EXPIRED'> {
  const row = await jobRow(input.id)
  if (!row) return null
  if (row.status !== 'COMPLETED') return 'NOT_READY'
  if (Number(row.expires_at) <= nowSeconds()) return 'EXPIRED'
  const paths = historicalScanResultPaths(row.id)
  try {
    const manifestJson = await readFile(/* turbopackIgnore: true */ paths.manifest, 'utf8')
    const response = JSON.parse(manifestJson) as TriggerHistoricalScanResponse
    const eventType = input.eventType ?? null
    const currentStatus = input.currentStatus ?? null
    const eventDate = input.eventDate ?? null
    const eventSearch = input.eventSearch?.normalize('NFKC').trim() || null
    const eventOrder = input.eventOrder ?? 'asc'
    const unfiltered = eventType == null && currentStatus == null && eventDate == null && eventSearch == null
    const page = eventOrder === 'desc'
      ? await readDescendingEventPage(
        paths.events,
        input.eventOffset,
        input.eventLimit,
        eventType,
        currentStatus,
        eventDate,
        eventSearch,
        unfiltered ? response.summary.totalEventCount : null,
      )
      : await readAscendingEventPage(
        paths.events,
        input.eventOffset,
        input.eventLimit,
        eventType,
        currentStatus,
        eventDate,
        eventSearch,
        unfiltered ? response.summary.totalEventCount : null,
      )
    return {
      ...response,
      events: page.events,
      eventPage: {
        offset: input.eventOffset,
        limit: input.eventLimit,
        returnedCount: page.events.length,
        totalCount: page.totalCount,
        hasMore: input.eventOffset + page.events.length < page.totalCount,
      },
    }
  } catch {
    return 'EXPIRED'
  }
}
