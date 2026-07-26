import { execFileSync } from 'node:child_process'
import { client, ensureReady, execAll, execGet } from '@/lib/db/client'

export const DEFAULT_UPDATE_LOCK_LEASE_SECONDS = 45 * 60
export const EXCLUSIVE_UPDATE_JOB_TYPES = [
  'update_latest',
  'post_ohlcv_refresh',
  'ml_learning',
  'ml_freshness_guard',
  'us_update_latest',
  'us_adjusted_foundation',
  'earnings_refresh',
  'kabutan_material_news',
  'kabutan_themes',
  'db_maintenance',
] as const

export type UpdateLockSnapshot = {
  jobType: string
  status: string
  owner: string | null
  startedAt: number
  heartbeatAt: number
  leaseExpiresAt: number
  active: boolean
}

export type UpdateLockHandle = {
  jobType: string
  owner: string
  heartbeat: () => Promise<void>
  release: () => Promise<void>
}

function makeOwner(jobType: string): string {
  const suffix = Math.random().toString(36).slice(2, 10)
  return `${jobType}:${process.pid}:${Date.now()}:${suffix}`
}

function localOwnerPid(owner: string | null): number | null {
  if (!owner) return null
  const rawPid = owner.split(':')[1]
  const pid = Number(rawPid)
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const SQLITE_WRITER_PROCESS_PATTERNS = [
  /scripts\/(?:update-latest|refresh-after-ohlcv|batch-ohlcv|batch-snapshots|batch-physical-momentum|build-dashboard-cache)\.(?:ts|js)\b/,
  /scripts\/(?:update-us-latest|batch-us-|run-us-ml-job)\S*\.(?:ts|js)\b/,
  /scripts\/(?:run-ml-learning|guard-ml-freshness|batch-ml-|build-serving-ml-)\S*\.(?:ts|js)\b/,
  /scripts\/(?:batch-forward-extrema|build-serving-|refresh-earnings|batch-kabutan-(?:material-news|themes)|maintenance-db)\S*\.(?:ts|js)\b/,
] as const

function hasActiveSqliteWriterProcess(): boolean {
  try {
    const output = execFileSync('ps', ['-axo', 'pid=,command='], {
      encoding: 'utf8',
      timeout: 5_000,
    })
    return output
      .split('\n')
      .some((line) => {
        const match = line.trim().match(/^(\d+)\s+(.+)$/)
        if (!match) return false
        const pid = Number(match[1])
        if (!Number.isInteger(pid) || pid === process.pid) return false
        return SQLITE_WRITER_PROCESS_PATTERNS.some((pattern) => pattern.test(match[2]))
      })
  } catch {
    // A failed process audit must never make lock cleanup more aggressive.
    return true
  }
}

function isSqliteBusyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /SQLITE_BUSY|database is locked/i.test(message)
}

async function cleanupOrphanedUpdateLocks(jobTypes: readonly string[]): Promise<number> {
  if (jobTypes.length === 0) return 0
  try {
    const candidates = await client.execute({
      sql: `
        SELECT job_type, owner
        FROM update_locks
        WHERE job_type IN (${jobTypes.map(() => '?').join(', ')})
          AND status = 'running'
          AND lease_expires_at > unixepoch()
      `,
      args: [...jobTypes],
    })
    const orphaned = candidates.rows
      .map((row) => ({
        jobType: String(row.job_type ?? ''),
        owner: row.owner == null ? null : String(row.owner),
      }))
      .filter((row) => {
        const pid = localOwnerPid(row.owner)
        return row.jobType && row.owner && pid && !processExists(pid)
      })
    if (orphaned.length === 0 || hasActiveSqliteWriterProcess()) return 0

    let cleaned = 0
    for (const row of orphaned) {
      const result = await client.execute({
        sql: `
          UPDATE update_locks
          SET status = 'idle',
              owner = NULL,
              heartbeat_at = unixepoch(),
              lease_expires_at = unixepoch()
          WHERE job_type = ?
            AND owner = ?
            AND status = 'running'
        `,
        args: [row.jobType, row.owner],
      })
      cleaned += Number(result.rowsAffected ?? 0)
    }
    return cleaned
  } catch (error) {
    if (isSqliteBusyError(error)) return 0
    throw error
  }
}

export async function acquireUpdateLock(
  jobType: string,
  leaseSeconds = DEFAULT_UPDATE_LOCK_LEASE_SECONDS,
  conflictingJobTypes: readonly string[] = [],
): Promise<UpdateLockHandle | null> {
  await ensureReady()
  const owner = makeOwner(jobType)
  const conflicts = [...new Set(conflictingJobTypes.filter((candidate) => candidate !== jobType))]
  const blockers = [...new Set([jobType, ...conflicts])]
  if (blockers.length > 0) {
    let active = await execGet<{ active: number }>(
      `
        SELECT 1 AS active
        FROM update_locks
        WHERE job_type IN (${blockers.map(() => '?').join(', ')})
          AND status = 'running'
          AND lease_expires_at > unixepoch()
        LIMIT 1
      `,
      blockers,
    )
    if (active) {
      // A terminated local process can leave a long lease behind. Cleanup
      // reclaims it only after auditing both its owner PID and SQLite writers.
      await cleanupOrphanedUpdateLocks(blockers)
      active = await execGet<{ active: number }>(
        `
          SELECT 1 AS active
          FROM update_locks
          WHERE job_type IN (${blockers.map(() => '?').join(', ')})
            AND status = 'running'
            AND lease_expires_at > unixepoch()
          LIMIT 1
        `,
        blockers,
      )
    }
    // Waiting jobs must remain read-only. Writing stale-cleanup metadata on
    // every poll can monopolize SQLite's single WAL writer and starve the
    // active batch that owns the lock.
    if (active) return null
  }
  await cleanupExpiredUpdateLocks()
  const activeConflictSql = conflicts.length > 0
    ? `
      AND NOT EXISTS (
        SELECT 1
        FROM update_locks AS conflicting_lock
        WHERE conflicting_lock.job_type IN (${conflicts.map(() => '?').join(', ')})
          AND conflicting_lock.status = 'running'
          AND conflicting_lock.lease_expires_at > unixepoch()
      )
    `
    : ''
  let result
  try {
    result = await client.execute({
      sql: `
        INSERT INTO update_locks (
          job_type, status, owner, started_at, heartbeat_at, lease_expires_at
        )
        SELECT ?, 'running', ?, unixepoch(), unixepoch(), unixepoch() + ?
        WHERE 1 = 1
          ${activeConflictSql}
        ON CONFLICT(job_type) DO UPDATE SET
          status = 'running',
          owner = excluded.owner,
          started_at = unixepoch(),
          heartbeat_at = unixepoch(),
          lease_expires_at = unixepoch() + ?
        WHERE (
          update_locks.status <> 'running'
          OR update_locks.lease_expires_at <= unixepoch()
        )
          ${activeConflictSql}
      `,
      args: [jobType, owner, leaseSeconds, ...conflicts, leaseSeconds, ...conflicts],
    })
  } catch (error) {
    if (isSqliteBusyError(error)) return null
    throw error
  }

  if (result.rowsAffected < 1) return null

  let heartbeatInFlight: Promise<void> | null = null
  const heartbeat = (): Promise<void> => {
    if (heartbeatInFlight) return heartbeatInFlight
    heartbeatInFlight = client.execute({
      sql: `
        UPDATE update_locks
        SET heartbeat_at = unixepoch(),
            lease_expires_at = unixepoch() + ?
        WHERE job_type = ?
          AND owner = ?
          AND status = 'running'
      `,
      args: [leaseSeconds, jobType, owner],
    })
      .then(() => undefined)
      .finally(() => {
        heartbeatInFlight = null
      })
    return heartbeatInFlight
  }

  return {
    jobType,
    owner,
    heartbeat,
    release: async () => {
      if (heartbeatInFlight) {
        await heartbeatInFlight.catch(() => undefined)
      }
      await client.execute({
        sql: `
          UPDATE update_locks
          SET status = 'idle',
              heartbeat_at = unixepoch(),
              lease_expires_at = unixepoch()
          WHERE job_type = ?
            AND owner = ?
        `,
        args: [jobType, owner],
      })
    },
  }
}

export async function acquireExclusiveUpdateLock(
  jobType: string,
  leaseSeconds = DEFAULT_UPDATE_LOCK_LEASE_SECONDS,
): Promise<UpdateLockHandle | null> {
  return acquireUpdateLock(
    jobType,
    leaseSeconds,
    EXCLUSIVE_UPDATE_JOB_TYPES,
  )
}

export async function getUpdateLock(jobType: string): Promise<UpdateLockSnapshot | null> {
  const row = await execGet<{
    jobType: string
    status: string
    owner: string | null
    startedAt: number
    heartbeatAt: number
    leaseExpiresAt: number
    active: number
  }>(
    `
      SELECT
        job_type AS jobType,
        status,
        owner,
        started_at AS startedAt,
        heartbeat_at AS heartbeatAt,
        lease_expires_at AS leaseExpiresAt,
        CASE
          WHEN status = 'running' AND lease_expires_at > unixepoch() THEN 1
          ELSE 0
        END AS active
      FROM update_locks
      WHERE job_type = ?
    `,
    [jobType],
  )
  return row
    ? {
        ...row,
        active: Boolean(row.active),
      }
    : null
}

export async function getActiveUpdateLocks(jobTypes?: readonly string[]): Promise<UpdateLockSnapshot[]> {
  await cleanupExpiredUpdateLocks(jobTypes)
  const where = jobTypes && jobTypes.length > 0
    ? `AND job_type IN (${jobTypes.map(() => '?').join(', ')})`
    : ''
  const rows = await execAll<{
    jobType: string
    status: string
    owner: string | null
    startedAt: number
    heartbeatAt: number
    leaseExpiresAt: number
    active: number
  }>(
    `
      SELECT
        job_type AS jobType,
        status,
        owner,
        started_at AS startedAt,
        heartbeat_at AS heartbeatAt,
        lease_expires_at AS leaseExpiresAt,
        1 AS active
      FROM update_locks
      WHERE status = 'running'
        AND lease_expires_at > unixepoch()
        ${where}
      ORDER BY heartbeat_at DESC
    `,
    jobTypes ?? [],
  )
  return rows.map((row) => ({ ...row, active: true }))
}

export async function cleanupExpiredUpdateLocks(jobTypes?: readonly string[]): Promise<number> {
  await ensureReady()
  const where = jobTypes && jobTypes.length > 0
    ? `AND job_type IN (${jobTypes.map(() => '?').join(', ')})`
    : ''
  try {
    const result = await client.execute({
      sql: `
        UPDATE update_locks
        SET status = 'idle',
            owner = NULL,
            heartbeat_at = unixepoch(),
            lease_expires_at = unixepoch()
        WHERE status = 'running'
          AND lease_expires_at <= unixepoch()
          ${where}
      `,
      args: [...(jobTypes ?? [])],
    })
    let cleaned = Number(result.rowsAffected ?? 0)

    const candidates = await client.execute({
      sql: `
        SELECT job_type, owner
        FROM update_locks
        WHERE status = 'running'
          AND lease_expires_at > unixepoch()
          ${where}
      `,
      args: [...(jobTypes ?? [])],
    })
    let writerAudit: boolean | null = null
    for (const row of candidates.rows) {
      const jobType = String(row.job_type ?? '')
      const owner = row.owner == null ? null : String(row.owner)
      const pid = localOwnerPid(owner)
      if (!jobType || !owner || !pid || processExists(pid)) continue
      writerAudit ??= hasActiveSqliteWriterProcess()
      if (writerAudit) continue
      const orphaned = await client.execute({
        sql: `
          UPDATE update_locks
          SET status = 'idle',
              owner = NULL,
              heartbeat_at = unixepoch(),
              lease_expires_at = unixepoch()
          WHERE job_type = ?
            AND owner = ?
            AND status = 'running'
        `,
        args: [jobType, owner],
      })
      cleaned += Number(orphaned.rowsAffected ?? 0)
    }
    return cleaned
  } catch (error) {
    if (isSqliteBusyError(error)) return 0
    throw error
  }
}
