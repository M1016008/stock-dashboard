// scripts/maintenance-db.ts
//
// Safe SQLite maintenance for StockBoard's large local databases.
// This script never VACUUMs and never deletes DB/WAL files. It only:
// - records DB/WAL/SHM sizes
// - marks stale running batch/update-lock rows when the owning process is gone
// - runs PRAGMA optimize
// - checkpoints/truncates WAL only when no other process has the DB open
// - performs a smoke check by default, or PRAGMA quick_check when requested

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

type TargetName = 'jp' | 'us'

type Target = {
  name: TargetName
  dbPath: string
}

type OpenHandle = {
  command: string
  pid: number
  raw: string
}

type MaintenanceResult = {
  target: TargetName
  dbPath: string
  before: SizeSnapshot
  after: SizeSnapshot
  activeHandles: OpenHandle[]
  staleBatchRuns: Array<{ id: number; jobType: string; startedAt: number; action: 'marked_failed' | 'skipped_active' }>
  staleUpdateLocks: Array<{ jobType: string; owner: string; heartbeatAt: number; action: 'cleared' | 'skipped_active' }>
  checkpoint: 'done' | 'skipped_active_handles' | 'skipped_dry_run' | 'failed'
  sqliteOutput: string[]
  error?: string
}

type SizeSnapshot = {
  dbBytes: number
  walBytes: number
  shmBytes: number
  db: string
  wal: string
  shm: string
}

const SQLITE_BIN = process.env.SQLITE3_BIN || '/usr/bin/sqlite3'

function resolveDefaultJpDbPath(): string {
  const configured = process.env.STOCKBOARD_DB_PATH || process.env.LOCAL_DB_PATH
  return configured ? path.resolve(configured) : path.join(process.cwd(), 'data', 'stockboard.db')
}

function resolveDefaultUsDbPath(): string {
  const configured = process.env.US_ANALYTICS_DB_PATH
  return configured
    ? path.resolve(configured)
    : '/Volumes/OWC Express 1M2 80G/stockboard-data/us/stockboard-us.db'
}

function parseTargets(): Target[] {
  const raw = process.env.DB_MAINT_TARGETS || process.env.DB_MAINT_TARGET || 'jp'
  const names = raw
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
  const unique = [...new Set(names)] as TargetName[]
  return unique.map((name) => {
    if (name === 'jp') return { name, dbPath: resolveDefaultJpDbPath() }
    if (name === 'us') return { name, dbPath: resolveDefaultUsDbPath() }
    throw new Error(`Unknown DB_MAINT target: ${name}`)
  })
}

function sizeOf(filePath: string): number {
  try {
    return fs.statSync(filePath).size
  } catch {
    return 0
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`
}

function sizes(dbPath: string): SizeSnapshot {
  const dbBytes = sizeOf(dbPath)
  const walBytes = sizeOf(`${dbPath}-wal`)
  const shmBytes = sizeOf(`${dbPath}-shm`)
  return {
    dbBytes,
    walBytes,
    shmBytes,
    db: formatBytes(dbBytes),
    wal: formatBytes(walBytes),
    shm: formatBytes(shmBytes),
  }
}

function runSqlite(dbPath: string, sql: string, options: { readonly?: boolean } = {}): string {
  const args = [
    ...(options.readonly ? ['-readonly'] : []),
    dbPath,
    sql,
  ]
  const result = spawnSync(SQLITE_BIN, args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 64,
  })
  if (result.status !== 0) {
    throw new Error(`sqlite3 failed (${result.status}): ${result.stderr || result.stdout}`)
  }
  return result.stdout.trim()
}

function tableExists(dbPath: string, tableName: string): boolean {
  const output = runSqlite(
    dbPath,
    `SELECT name FROM sqlite_master WHERE type='table' AND name=${sqlString(tableName)} LIMIT 1;`,
    { readonly: true },
  )
  return output.trim() === tableName
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function activeProcessText(): string {
  const result = spawnSync('ps', ['-axo', 'pid,command'], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 16,
  })
  return result.status === 0 ? result.stdout : ''
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function pidFromOwner(owner: string): number | null {
  const pid = Number(owner.split(':')[1])
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

function looksActive(jobType: string, psText: string): boolean {
  const haystack = psText.toLowerCase()
  const job = jobType.toLowerCase()
  const variants = [
    job,
    job.replace(/_/g, '-'),
    job.replace(/_/g, ''),
    `batch:${job.replace(/_/g, '-')}`,
    `batch-${job.replace(/^batch[-_]/, '').replace(/_/g, '-')}`,
    `scripts/${job.replace(/_/g, '-')}.ts`,
  ].filter((item) => item.length >= 4)
  return variants.some((variant) => haystack.includes(variant))
}

function parseTsv(output: string): string[][] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split('|'))
}

function cleanupStaleBatchRuns(dbPath: string, psText: string): MaintenanceResult['staleBatchRuns'] {
  if (!tableExists(dbPath, 'batch_runs')) return []
  const ttlHours = Math.max(1, Number(process.env.DB_MAINT_STALE_BATCH_TTL_HOURS ?? process.env.STALE_BATCH_TTL_HOURS ?? 6))
  const dryRun = process.env.DRY_RUN === '1'
  const output = runSqlite(
    dbPath,
    `SELECT id, job_type, started_at FROM batch_runs WHERE status='running' AND started_at < unixepoch() - ${Math.floor(ttlHours * 3600)} ORDER BY started_at ASC;`,
  )
  const rows = parseTsv(output).map(([id, jobType, startedAt]) => ({
    id: Number(id),
    jobType,
    startedAt: Number(startedAt),
  })).filter((row) => Number.isInteger(row.id) && row.jobType)

  return rows.map((row) => {
    if (looksActive(row.jobType, psText)) {
      return { ...row, action: 'skipped_active' as const }
    }
    if (!dryRun) {
      const note = `[auto-stale] Marked failed by DB maintenance at ${new Date().toISOString()} after ${ttlHours}h TTL; no matching local process was observed.`
      runSqlite(
        dbPath,
        `
          UPDATE batch_runs
          SET status='failed',
              finished_at=unixepoch(),
              error_summary=COALESCE(error_summary || char(10), '') || ${sqlString(note)}
          WHERE id=${row.id} AND status='running';
        `,
      )
    }
    return { ...row, action: 'marked_failed' as const }
  })
}

function cleanupStaleUpdateLocks(dbPath: string): MaintenanceResult['staleUpdateLocks'] {
  if (!tableExists(dbPath, 'update_locks')) return []
  const staleMinutes = Math.max(5, Number(process.env.DB_MAINT_STALE_LOCK_MINUTES ?? 90))
  const dryRun = process.env.DRY_RUN === '1'
  const output = runSqlite(
    dbPath,
    `SELECT job_type, owner, heartbeat_at FROM update_locks WHERE status='running' AND heartbeat_at < unixepoch() - ${Math.floor(staleMinutes * 60)} ORDER BY heartbeat_at ASC;`,
  )
  const rows = parseTsv(output).map(([jobType, owner, heartbeatAt]) => ({
    jobType,
    owner,
    heartbeatAt: Number(heartbeatAt),
  })).filter((row) => row.jobType && row.owner)

  return rows.map((row) => {
    const pid = pidFromOwner(row.owner)
    if (pid && pidExists(pid)) {
      return { ...row, action: 'skipped_active' as const }
    }
    if (!dryRun) {
      runSqlite(
        dbPath,
        `
          UPDATE update_locks
          SET status='idle',
              owner=NULL,
              heartbeat_at=unixepoch(),
              lease_expires_at=unixepoch()
          WHERE job_type=${sqlString(row.jobType)}
            AND owner=${sqlString(row.owner)}
            AND status='running';
        `,
      )
    }
    return { ...row, action: 'cleared' as const }
  })
}

function listOpenHandles(dbPath: string): OpenHandle[] {
  const targets = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].filter((target) => fs.existsSync(target))
  if (targets.length === 0) return []
  const result = spawnSync('lsof', ['-nP', ...targets], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 16,
  })
  if (result.status === 1 && !result.stdout.trim()) return []
  const lines = result.stdout.split('\n').filter(Boolean)
  return lines.slice(1).map((line) => {
    const columns = line.trim().split(/\s+/)
    return {
      command: columns[0] ?? '',
      pid: Number(columns[1] ?? 0),
      raw: line,
    }
  }).filter((handle) => Number.isInteger(handle.pid) && handle.pid !== process.pid)
}

function runReadOnlySmoke(dbPath: string): string[] {
  const sql = [
    'PRAGMA schema_version;',
    'PRAGMA page_count;',
    'PRAGMA freelist_count;',
  ].join(' ')
  return runSqlite(dbPath, sql).split('\n').filter(Boolean)
}

function runWritableMaintenance(dbPath: string): string[] {
  const checkMode = process.env.DB_MAINT_CHECK_MODE ?? 'smoke'
  const checkSql = checkMode === 'quick'
    ? ['PRAGMA quick_check;']
    : [
        'PRAGMA schema_version;',
        'PRAGMA page_count;',
        'PRAGMA freelist_count;',
      ]
  const sql = [
    'PRAGMA busy_timeout=60000;',
    'PRAGMA optimize;',
    'PRAGMA wal_checkpoint(TRUNCATE);',
    ...checkSql,
  ].join(' ')
  return runSqlite(dbPath, sql).split('\n').filter(Boolean)
}

function maintainTarget(target: Target): MaintenanceResult {
  if (!fs.existsSync(target.dbPath)) {
    throw new Error(`DB not found for ${target.name}: ${target.dbPath}`)
  }

  const psText = activeProcessText()
  const before = sizes(target.dbPath)
  let activeHandles = listOpenHandles(target.dbPath)
  const canWriteMetadata = activeHandles.length === 0 || process.env.DB_MAINT_CLEAN_STALE_WITH_ACTIVE === '1' || process.env.DB_MAINT_ALLOW_ACTIVE === '1'
  let staleBatchRuns: MaintenanceResult['staleBatchRuns'] = []
  let staleUpdateLocks: MaintenanceResult['staleUpdateLocks'] = []
  if (canWriteMetadata) {
    staleBatchRuns = cleanupStaleBatchRuns(target.dbPath, psText)
    staleUpdateLocks = cleanupStaleUpdateLocks(target.dbPath)
    activeHandles = listOpenHandles(target.dbPath)
  }
  const dryRun = process.env.DRY_RUN === '1'
  let checkpoint: MaintenanceResult['checkpoint'] = 'skipped_active_handles'
  let sqliteOutput: string[] = []
  let error: string | undefined

  try {
    if (dryRun) {
      checkpoint = 'skipped_dry_run'
      sqliteOutput = runReadOnlySmoke(target.dbPath)
    } else if (activeHandles.length > 0 && process.env.DB_MAINT_ALLOW_ACTIVE !== '1') {
      checkpoint = 'skipped_active_handles'
      sqliteOutput = runReadOnlySmoke(target.dbPath)
    } else {
      checkpoint = 'done'
      sqliteOutput = runWritableMaintenance(target.dbPath)
    }
  } catch (maintenanceError) {
    checkpoint = 'failed'
    error = maintenanceError instanceof Error ? maintenanceError.message : String(maintenanceError)
  }

  const after = sizes(target.dbPath)
  return {
    target: target.name,
    dbPath: target.dbPath,
    before,
    after,
    activeHandles,
    staleBatchRuns,
    staleUpdateLocks,
    checkpoint,
    sqliteOutput,
    error,
  }
}

function main(): void {
  const results = parseTargets().map(maintainTarget)
  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    dryRun: process.env.DRY_RUN === '1',
    checkMode: process.env.DB_MAINT_CHECK_MODE ?? 'smoke',
    results,
  }, null, 2))

  if (results.some((result) => result.checkpoint === 'failed')) {
    process.exitCode = 1
  }
}

try {
  main()
} catch (error) {
  console.error('[maintenance-db] failed:', error)
  process.exitCode = 1
}
