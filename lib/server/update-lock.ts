import { client, ensureReady, execAll, execGet } from '@/lib/db/client'

export const DEFAULT_UPDATE_LOCK_LEASE_SECONDS = 6 * 60 * 60

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

export async function acquireUpdateLock(
  jobType: string,
  leaseSeconds = DEFAULT_UPDATE_LOCK_LEASE_SECONDS,
): Promise<UpdateLockHandle | null> {
  await ensureReady()
  const owner = makeOwner(jobType)
  const result = await client.execute({
    sql: `
      INSERT INTO update_locks (
        job_type, status, owner, started_at, heartbeat_at, lease_expires_at
      )
      VALUES (?, 'running', ?, unixepoch(), unixepoch(), unixepoch() + ?)
      ON CONFLICT(job_type) DO UPDATE SET
        status = 'running',
        owner = excluded.owner,
        started_at = unixepoch(),
        heartbeat_at = unixepoch(),
        lease_expires_at = unixepoch() + ?
      WHERE update_locks.status <> 'running'
         OR update_locks.lease_expires_at <= unixepoch()
    `,
    args: [jobType, owner, leaseSeconds, leaseSeconds],
  })

  if (result.rowsAffected < 1) return null

  return {
    jobType,
    owner,
    heartbeat: async () => {
      await client.execute({
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
    },
    release: async () => {
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
