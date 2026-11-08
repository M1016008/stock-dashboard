import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import type { InValue, Transaction } from '@libsql/client'
import { client, ensureReady, execAll, execGet, execRun } from '@/lib/db/client'

const LOCK_TYPE = 'trigger_historical_worker'
const LOCK_SECONDS = 10 * 365 * 86_400
const MAX_ATTEMPTS = 2
const JOB_TABLES = ['historical_trigger_scan_jobs', 'trigger_outcome_analysis_jobs', 'trigger_path_research_jobs', 'trigger_ml_dataset_jobs'] as const
type JobTable = typeof JOB_TABLES[number]
type RecoveryMode = 'startup' | 'stale'

export const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function boundedIntegerEnv(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name])
  if (!Number.isInteger(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

export function nowSeconds(now: () => number = Date.now): number {
  return Math.floor(now() / 1_000)
}

export function isoDateTime(epochSeconds: number | null): string | null {
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

export function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value))
}

export async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(/* turbopackIgnore: true */ file)) hash.update(chunk)
  return hash.digest('hex')
}

export async function readLines<T>(file: string): Promise<T[]> {
  const rows: T[] = []
  const stream = createReadStream(/* turbopackIgnore: true */ file, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  try { for await (const line of lines) if (line) rows.push(JSON.parse(line) as T) }
  finally { lines.close(); stream.destroy() }
  return rows
}

// Historical/outcome match busy errors on Error.message; path research matches on String(error).
function isDatabaseBusy(error: unknown, busyText: 'message' | 'string'): boolean {
  const message = busyText === 'message' && error instanceof Error ? error.message : String(error)
  return /SQLITE_BUSY|database is locked/i.test(message)
}

export async function beginWriteTransaction(busyText: 'message' | 'string' = 'message'): Promise<Transaction> {
  const retries = boundedIntegerEnv('SQLITE_BUSY_RETRIES', 8, 0, 20)
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await client.transaction('write')
    } catch (error) {
      if (!isDatabaseBusy(error, busyText) || attempt >= retries) throw error
      await new Promise((resolve) => setTimeout(resolve, Math.min(2_500, 120 * 2 ** attempt)))
    }
  }
}

// One heavy research job at a time across every worker table. The claimed table is checked first
// (excluding its own row on update), then the others in JOB_TABLES order, as in the original SQL.
function noActiveJobs(table: JobTable, excludeClaimed: boolean): string {
  return [table, ...JOB_TABLES.filter((other) => other !== table)].map((other) => ` AND NOT EXISTS (SELECT 1 FROM ${other}`
    + ` WHERE status IN ('RUNNING','CANCEL_REQUESTED')${excludeClaimed && other === table ? ' AND id<>?' : ''})`).join('')
}

// `reset` is the table-specific SET list after status='RUNNING'; its args are read after the candidate lookup.
// Historical/outcome also guard the candidate lookup; path/ML guard only the claim update.
// Only historical called ensureReady() between lookup and claim.
export async function claimWorkerJob<Row>(
  table: JobTable,
  reset: string,
  resetArgs: () => InValue[],
  policy: { guardLookup: boolean; ensureReadyBeforeClaim: boolean },
): Promise<Row | null> {
  const candidate = await execGet<{ id: string }>(`SELECT id FROM ${table}
    WHERE status='QUEUED'${policy.guardLookup ? noActiveJobs(table, false) : ''} ORDER BY created_at, id LIMIT 1`)
  if (!candidate) return null
  if (policy.ensureReadyBeforeClaim) await ensureReady()
  const claimed = await client.execute({
    sql: `UPDATE ${table} SET status='RUNNING', ${reset}
      WHERE id=? AND status='QUEUED'${noActiveJobs(table, true)} RETURNING *`,
    args: [...resetArgs(), candidate.id, candidate.id],
  })
  return (claimed.rows[0] as unknown as Row | undefined) ?? null
}

// Historical/outcome cancel inside a write transaction and also touch heartbeat/owner/error;
// path research and ML datasets keep their plain single-statement updates.
export async function cancelWorkerJob<Row>(
  table: JobTable,
  id: string,
  mode: 'transaction' | 'direct',
): Promise<Row | null> {
  if (!JOB_ID_PATTERN.test(id)) return null
  const select = `SELECT * FROM ${table} WHERE id=?`
  const queued = mode === 'transaction'
    ? `UPDATE ${table} SET status='CANCELLED', cancel_requested=1, completed_at=unixepoch(),
      heartbeat_at=unixepoch(), owner_token=NULL, error_category=NULL WHERE id=? AND status='QUEUED'`
    : `UPDATE ${table} SET status='CANCELLED', cancel_requested=1, completed_at=unixepoch()
      WHERE id=? AND status='QUEUED'`
  const running = `UPDATE ${table} SET status='CANCEL_REQUESTED', cancel_requested=1`
    + `${mode === 'transaction' ? ', heartbeat_at=unixepoch()' : ''} WHERE id=? AND status='RUNNING'`
  if (mode === 'direct') {
    const row = await execGet<{ status: string }>(select, [id])
    if (!row) return null
    if (row.status === 'QUEUED') await execRun(queued, [id])
    else if (row.status === 'RUNNING') await execRun(running, [id])
    return (await execGet<Row>(select, [id])) ?? null
  }
  await ensureReady()
  const tx = await beginWriteTransaction()
  try {
    const row = (await tx.execute({ sql: select, args: [id] })).rows[0] as unknown as { status: string } | undefined
    if (!row) {
      await tx.commit()
      return null
    }
    if (row.status === 'QUEUED') await tx.execute({ sql: queued, args: [id] })
    else if (row.status === 'RUNNING') await tx.execute({ sql: running, args: [id] })
    const updated = (await tx.execute({ sql: select, args: [id] })).rows[0] as unknown as Row | undefined
    await tx.commit()
    return updated ?? null
  } catch (error) {
    await tx.rollback().catch(() => undefined)
    throw error
  } finally {
    tx.close()
  }
}

// ML dataset jobs deliberately have no expiry cleanup. Path research passes no `current` and keeps SQL unixepoch().
export async function cleanupExpiredWorkerJobs(
  table: Exclude<JobTable, 'trigger_ml_dataset_jobs'>,
  removeFiles: (id: string) => Promise<void>,
  current?: number,
): Promise<number> {
  const expiry = current == null ? 'unixepoch()' : '?'
  const args = current == null ? [] : [current]
  const rows = await execAll<{ id: string }>(`SELECT id FROM ${table}
    WHERE expires_at<=${expiry} AND status IN ('COMPLETED','FAILED','CANCELLED')`, args)
  for (const row of rows) await removeFiles(row.id).catch(() => undefined)
  if (rows.length > 0) {
    await execRun(`DELETE FROM ${table}
      WHERE expires_at<=${expiry} AND status IN ('COMPLETED','FAILED','CANCELLED')`, args)
  }
  return rows.length
}

export type WorkerIdentity = { owner: string; jobOwner: () => string }
type ActiveJob = {
  id: string
  status: string
  owner_token: string | null
  heartbeat_at: number | null
  started_at: number | null
  created_at: number
  attempt_count: number
}

function processBirth(pid: number): string | null {
  try {
    const value = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8', timeout: 5_000,
    }).trim()
    return value || null
  } catch {
    return null
  }
}

function birthHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 20)
}

export function createWorkerIdentity(): WorkerIdentity {
  const birth = processBirth(process.pid)
  if (!birth) throw new Error('worker_process_birth_unavailable')
  const owner = `worker:${process.pid}:${birthHash(birth)}:${randomUUID()}`
  return { owner, jobOwner: () => `${owner}:${randomUUID()}` }
}

// Unknown liveness is deliberately treated as alive: never steal from an unverified owner.
export function ownerLiveness(owner: string): 'alive' | 'dead' | 'unknown' {
  const match = /^worker:(\d+):([0-9a-f]{20}):[0-9a-f-]{36}(?::[0-9a-f-]{36})?$/.exec(owner)
  if (!match) return 'unknown'
  const pid = Number(match[1])
  try {
    process.kill(pid, 0)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown'
  }
  const birth = processBirth(pid)
  return birth ? (birthHash(birth) === match[2] ? 'alive' : 'dead') : 'unknown'
}

function processRows(): { pid: number; parent: number; command: string }[] | null {
  try {
    return execFileSync('ps', ['-axo', 'pid=,ppid=,command='], {
      encoding: 'utf8', timeout: 5_000,
    }).split('\n').flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
      return match ? [{ pid: Number(match[1]), parent: Number(match[2]), command: match[3] }] : []
    })
  } catch {
    return null
  }
}

export function otherHistoricalWorkerAlive(): boolean | null {
  const rows = processRows()
  if (!rows) return null
  const parents = new Map(rows.map((row) => [row.pid, row.parent]))
  const family = new Set<number>()
  let pid = process.pid
  while (pid > 0 && !family.has(pid)) {
    family.add(pid)
    pid = parents.get(pid) ?? 0
  }
  return rows.some((row) => !family.has(row.pid)
    && /(?:^|\/)scripts\/run-trigger-historical-scan-worker\.ts(?:\s|$)/.test(row.command)
    && /(?:^|\/)node(?:\s|$)/.test(row.command))
}

export async function acquireHistoricalWorker(
  identity: WorkerIdentity,
  processAudit: () => boolean | null = otherHistoricalWorkerAlive,
): Promise<boolean> {
  await ensureReady()
  // The previous release did not take a DB lock. Do not race its live process during upgrade.
  if (processAudit() !== false) return false
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await execGet<{ status: string; owner: string | null }>(
      'SELECT status, owner FROM update_locks WHERE job_type=?', [LOCK_TYPE],
    )
    if (current?.status === 'running' && (!current.owner || ownerLiveness(current.owner) !== 'dead')) {
      return false
    }
    const changed = current
      ? await client.execute({
        sql: `UPDATE update_locks SET status='running', owner=?, started_at=unixepoch(),
          heartbeat_at=unixepoch(), lease_expires_at=unixepoch()+?
          WHERE job_type=? AND status=? AND owner IS ?`,
        args: [identity.owner, LOCK_SECONDS, LOCK_TYPE, current.status, current.owner],
      })
      : await client.execute({
        sql: `INSERT OR IGNORE INTO update_locks
          (job_type,status,owner,started_at,heartbeat_at,lease_expires_at)
          VALUES (?,'running',?,unixepoch(),unixepoch(),unixepoch()+?)`,
        args: [LOCK_TYPE, identity.owner, LOCK_SECONDS],
      })
    if (Number(changed.rowsAffected) === 1) {
      if (processAudit() === false) return true
      await releaseHistoricalWorker(identity)
      return false
    }
  }
  return false
}

export async function releaseHistoricalWorker(identity: WorkerIdentity): Promise<void> {
  await client.execute({
    sql: `UPDATE update_locks SET status='idle', owner=NULL,
      heartbeat_at=unixepoch(), lease_expires_at=unixepoch()
      WHERE job_type=? AND owner=? AND status='running'`,
    args: [LOCK_TYPE, identity.owner],
  })
}

export async function recoverWorkerJobs(
  table: JobTable,
  mode: RecoveryMode,
  now: () => number = Date.now,
  staleSeconds = 180,
  processAudit: () => boolean | null = otherHistoricalWorkerAlive,
): Promise<{ requeued: number; failed: number; cancelled: number }> {
  const counts = { requeued: 0, failed: 0, cancelled: 0 }
  const current = Math.floor(now() / 1_000)
  const cutoff = current - staleSeconds
  const jobs = await execAll<ActiveJob>(`SELECT id,status,owner_token,heartbeat_at,
    started_at,created_at,attempt_count FROM ${table}
    WHERE status IN ('RUNNING','CANCEL_REQUESTED')`)
  if (jobs.length === 0) return counts
  let legacyWorkers: boolean | null | undefined
  const progressReset = table === 'historical_trigger_scan_jobs'
    ? "processed_trading_days=CASE WHEN ?='QUEUED' THEN 0 ELSE processed_trading_days END,"
    : "processed_events=CASE WHEN ?='QUEUED' THEN 0 ELSE processed_events END,"
      + " processed_tickers=CASE WHEN ?='QUEUED' THEN 0 ELSE processed_tickers END,"
  for (const job of jobs) {
    const heartbeat = Number(job.heartbeat_at ?? job.started_at ?? job.created_at)
    if (mode === 'stale' && heartbeat > cutoff) continue
    const liveness = job.owner_token ? ownerLiveness(job.owner_token) : 'unknown'
    if (liveness === 'unknown') legacyWorkers ??= processAudit()
    if (liveness === 'alive' || (liveness === 'unknown' && legacyWorkers !== false)) continue
    const action = job.status === 'CANCEL_REQUESTED' ? 'cancelled'
      : Number(job.attempt_count) >= MAX_ATTEMPTS ? 'failed' : 'requeued'
    const status = action === 'cancelled' ? 'CANCELLED' : action === 'failed' ? 'FAILED' : 'QUEUED'
    const result = await client.execute({
      sql: `UPDATE ${table} SET status=?, owner_token=NULL, heartbeat_at=?,
        completed_at=CASE WHEN ?='QUEUED' THEN NULL ELSE ? END,
        started_at=CASE WHEN ?='QUEUED' THEN NULL ELSE started_at END,
        ${progressReset} result_location=NULL, result_size_bytes=0,
        error_category=CASE WHEN ?='QUEUED' THEN 'worker_recovered'
          WHEN ?='FAILED' THEN 'worker_stale_after_retry' ELSE NULL END
        WHERE id=? AND status=? AND owner_token IS ?
          ${mode === 'stale' ? 'AND COALESCE(heartbeat_at,started_at,created_at)<=?' : ''}`,
      args: [status, current, status, current, status,
        ...Array.from({ length: table === 'historical_trigger_scan_jobs' ? 1 : 2 }, () => status),
        status, status,
        job.id, job.status, job.owner_token, ...(mode === 'stale' ? [cutoff] : [])],
    })
    if (Number(result.rowsAffected) !== 1) continue
    counts[action] += 1
    console.log(`[trigger-historical-worker] recovery type=${table} job=${job.id}`
      + ` oldOwner=${job.owner_token ?? 'none'} reason=${liveness === 'dead' ? 'owner_dead' : 'legacy_owner_absent'}`
      + ` heartbeatAge=${current - heartbeat}s action=${action}`)
  }
  return counts
}
