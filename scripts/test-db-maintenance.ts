// Runs scripts/maintenance-db.ts against throwaway WAL databases in a temp folder.
// Regression: when no other process has a WAL database open, its -wal/-shm files are gone and a
// read-only open fails with SQLITE_CANTOPEN (14). The US target then threw before any JSON was printed.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SQLITE = '/usr/bin/sqlite3'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stockboard-db-maintenance-'))

function sql(database: string, statement: string): string {
  const result = spawnSync(SQLITE, [database, statement], { encoding: 'utf8', timeout: 60_000 })
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr)
  return result.stdout.trim()
}

const BATCH_RUNS = `CREATE TABLE batch_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, job_type TEXT NOT NULL,
  started_at INTEGER NOT NULL, finished_at INTEGER, status TEXT NOT NULL, total_tickers INTEGER,
  succeeded INTEGER DEFAULT 0, failed INTEGER DEFAULT 0, rows_inserted INTEGER DEFAULT 0, error_summary TEXT);`
const UPDATE_LOCKS = `CREATE TABLE update_locks (job_type TEXT PRIMARY KEY, status TEXT NOT NULL, owner TEXT,
  started_at INTEGER NOT NULL DEFAULT (unixepoch()), heartbeat_at INTEGER NOT NULL DEFAULT (unixepoch()),
  lease_expires_at INTEGER NOT NULL);`
// A job type that matches no running process (random, so no command line contains it), started 7 hours
// ago (TTL is 6 hours). maintenance-db skips a row whose job type appears in `ps` output.
const STALE_JOB = `zz_test_${randomBytes(6).toString('hex')}`
const STALE_ROW = `INSERT INTO batch_runs (job_type, started_at, status) VALUES ('${STALE_JOB}', unixepoch() - 7 * 3600, 'running');`

function walDatabase(dir: string, name: string): string {
  fs.mkdirSync(dir, { recursive: true })
  const database = path.join(dir, name)
  sql(database, `PRAGMA journal_mode=WAL; ${BATCH_RUNS} ${UPDATE_LOCKS} ${STALE_ROW} PRAGMA wal_checkpoint(TRUNCATE);`)
  // The production writer (libsql) removes -wal and -shm when the last connection closes. macOS's
  // /usr/bin/sqlite3 keeps them, so remove them here; the WAL is empty after the TRUNCATE checkpoint.
  assert.equal(fs.statSync(`${database}-wal`).size, 0)
  fs.rmSync(`${database}-wal`)
  fs.rmSync(`${database}-shm`)
  assert.equal(fs.existsSync(`${database}-wal`), false, `${name}: -wal should be absent`)
  assert.equal(fs.existsSync(`${database}-shm`), false, `${name}: -shm should be absent`)
  // Still a WAL database (file format bytes 18-19 are 2), checked without opening it.
  const header = fs.readFileSync(database).subarray(18, 20)
  assert.deepEqual([...header], [2, 2])
  return database
}

type Result = { target: string; dbPath: string; checkpoint: string; error?: string; activeHandles: unknown[]
  staleBatchRuns: Array<{ jobType: string; action: string }> }

function runMaintenance(jp: string, us: string, extra: Record<string, string> = {}): Result[] {
  // Only the temp databases: no .env.local, no Turso, no external-storage paths. NODE_ENV=test keeps
  // any storage-incident record under this checkout instead of the shared Production folder.
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: 'test',
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    USE_LOCAL_DB: '1',
    SKIP_SCHEMA_ENSURE: '1',
    EXTERNAL_STORAGE_REQUIRED: 'false',
    STOCKBOARD_DB_PATH: jp,
    US_ANALYTICS_DB_PATH: us,
    DB_MAINT_TARGETS: 'jp,us',
    DB_MAINT_CHECK_MODE: 'smoke',
    DB_MAINT_STALE_BATCH_TTL_HOURS: '6',
    DB_MAINT_CLEAN_STALE_WITH_ACTIVE: '1',
    SQLITE3_BIN: SQLITE,
    ...extra,
  }
  const run = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/maintenance-db.ts'], {
    cwd: process.cwd(), env, encoding: 'utf8', timeout: 120_000,
  })
  assert.equal(run.status, 0, `maintenance-db exited ${run.status}\n${run.stderr}`)
  const results: Result[] = JSON.parse(run.stdout.slice(run.stdout.indexOf('{'))).results
  assert.deepEqual(results.map((r) => [r.target, r.dbPath, r.error]), [['jp', jp, undefined], ['us', us, undefined]])
  return results
}

const staleStatus = (database: string) => sql(database, `SELECT status FROM batch_runs WHERE job_type='${STALE_JOB}';`)
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

async function main(): Promise<void> {
  try {
    // 1. No other connection: -wal/-shm are absent (Production US DB since 2026-11-19).
    const jp = walDatabase(path.join(root, 'closed'), 'jp.db')
    const us = walDatabase(path.join(root, 'closed'), 'us.db')
    // The read-only open the script used before the fix fails on such a database.
    const readOnly = spawnSync(SQLITE, [`file:${us}?mode=ro`, 'SELECT 1;'], { encoding: 'utf8' })
    assert.equal(readOnly.status, 14, `expected SQLITE_CANTOPEN from a read-only open, got ${readOnly.status}: ${readOnly.stderr}`)
    for (const [result, database] of runMaintenance(jp, us).map((r, i) => [r, [jp, us][i]] as const)) {
      assert.equal(result.checkpoint, 'done')
      assert.deepEqual(result.staleBatchRuns.map((r) => [r.jobType, r.action]), [[STALE_JOB, 'marked_failed']])
      assert.equal(staleStatus(database), 'failed')
    }

    // 2. DRY_RUN=1: reports the stale row but changes nothing and skips the checkpoint.
    const dryJp = walDatabase(path.join(root, 'dry'), 'jp.db')
    const dryUs = walDatabase(path.join(root, 'dry'), 'us.db')
    for (const [result, database] of runMaintenance(dryJp, dryUs, { DRY_RUN: '1' }).map((r, i) => [r, [dryJp, dryUs][i]] as const)) {
      assert.equal(result.checkpoint, 'skipped_dry_run')
      assert.deepEqual(result.staleBatchRuns.map((r) => [r.jobType, r.action]), [[STALE_JOB, 'marked_failed']])
      assert.equal(staleStatus(database), 'running')
    }

    // 3. Another process keeps the US DB open (Production until 2026-11-19): still cleaned up.
    const openJp = walDatabase(path.join(root, 'open'), 'jp.db')
    const openUs = walDatabase(path.join(root, 'open'), 'us.db')
    const holder = spawn(SQLITE, [openUs], { stdio: ['pipe', 'ignore', 'ignore'] })
    try {
      holder.stdin.write('SELECT count(*) FROM batch_runs;\n')
      for (let i = 0; i < 100 && !fs.existsSync(`${openUs}-shm`); i += 1) sleep(50)
      assert.ok(fs.existsSync(`${openUs}-shm`), 'holder did not open the US DB')
      const [, result] = runMaintenance(openJp, openUs)
      assert.ok(result.activeHandles.length > 0, 'the holder should be listed as an active handle')
      assert.equal(result.checkpoint, 'done')
      assert.deepEqual(result.staleBatchRuns.map((r) => [r.jobType, r.action]), [[STALE_JOB, 'marked_failed']])
    } finally {
      holder.stdin.end()
      await new Promise((resolve) => holder.once('exit', resolve))
    }
    assert.equal(staleStatus(openUs), 'failed')
    console.log('db-maintenance tests passed')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
