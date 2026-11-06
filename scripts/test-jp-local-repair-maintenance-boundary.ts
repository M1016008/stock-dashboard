import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// @ts-expect-error Node 24 ships node:sqlite; the repository pins older Node type declarations.
import { DatabaseSync } from 'node:sqlite'
import { assertNoUnauthorizedDatabaseHandles } from '@/lib/storage/launchd-writer-hold-driver'
import {
  quarantineInSameDirectory,
  restoreFromSameDirectoryQuarantine,
} from '@/lib/storage/same-directory-quarantine'

const mode = process.argv[2] ?? 'parent'
const dbPath = process.env.STOCKBOARD_DB_PATH ?? ''
const tsxImport = process.env.STOCKBOARD_TSX_IMPORT ?? 'tsx'

function fileSha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function syncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, 'r')
  try { fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
}

function assertNoDatabaseHandles(database: string): void {
  assertNoUnauthorizedDatabaseHandles({
    databasePath: database,
    approvedReaders: [],
    timeoutMs: 10_000,
  })
}

async function verifyQuarantineBoundary(directory: string): Promise<void> {
  const original = path.join(directory, 'quarantine.sqlite')
  const quarantined = path.join(directory, '.quarantine.sqlite.maintenance-test')
  const fixture = new DatabaseSync(original)
  fixture.exec('PRAGMA journal_mode=WAL; CREATE TABLE protected(value TEXT NOT NULL); INSERT INTO protected VALUES(\'sealed\');')
  fixture.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  fixture.close()
  const activeHandle = spawn(process.execPath, ['-e', `
    const { DatabaseSync } = require('node:sqlite')
    const db = new DatabaseSync(process.env.STOCKBOARD_DB_PATH, { readOnly: true })
    process.stdout.write('QUARANTINE_HANDLE_OPEN\\n')
    setTimeout(() => { db.close(); process.exit(0) }, 60000)
  `], {
    env: { ...process.env, STOCKBOARD_DB_PATH: original },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  await waitForLine(activeHandle, 'QUARANTINE_HANDLE_OPEN')
  try {
    assert.throws(() => assertNoDatabaseHandles(original), /UNAUTHORIZED_DATABASE_HANDLE/)
  } finally {
    activeHandle.kill('SIGTERM')
    await new Promise<void>((resolve) => activeHandle.once('exit', () => resolve()))
  }
  assertNoDatabaseHandles(original)
  assert.equal(fs.existsSync(`${original}-wal`), false)
  assert.equal(fs.existsSync(`${original}-shm`), false)
  const before = fileSha256(original)

  const originalStat = fs.statSync(original)
  assert.equal(originalStat.dev, fs.statSync(directory).dev)
  const quarantine = quarantineInSameDirectory({
    originalPath: original, quarantinedPath: quarantined, dev: Number(originalStat.dev), inode: Number(originalStat.ino),
  })
  assert.equal(fs.existsSync(original), false)
  assert.equal(fs.statSync(quarantined).ino, originalStat.ino)
  assert.equal(fileSha256(quarantined), before)

  const accidental = new DatabaseSync(original)
  accidental.close()
  assert.throws(() => restoreFromSameDirectoryQuarantine(quarantine), /EEXIST/)
  assert.equal(fileSha256(quarantined), before)
  fs.unlinkSync(original)
  restoreFromSameDirectoryQuarantine(quarantine)
  assert.equal(fileSha256(original), before)
  assert.equal(fs.existsSync(quarantined), false)

  // A crash between link and unlink leaves both names on one inode.
  fs.linkSync(original, quarantined)
  syncDirectory(directory)
  assert.equal(fs.statSync(original).ino, fs.statSync(quarantined).ino, 'link-before-unlink is crash-recoverable')
  fs.unlinkSync(quarantined)
  syncDirectory(directory)
  assert.equal(fileSha256(original), before)
}

function verifyDirectSqliteInitialization(): void {
  const cachePurge = fs.readFileSync(path.resolve('scripts/rehearse-jp-repair-cache-purge.ts'), 'utf8')
  assert.match(cachePurge, /db\.exec\('PRAGMA busy_timeout=60000'\)/)
}

async function cooperativeWriter(): Promise<void> {
  const { acquireJpStockboardUpdateLock } = await import('@/lib/server/update-lock')
  const lock = await acquireJpStockboardUpdateLock('update_latest', 60)
  if (lock) {
    await lock.release()
    throw new Error('cooperative writer acquired a lock during maintenance')
  }
  process.stdout.write('COOPERATIVE_BLOCKED\n')
}

function rawWriter(): void {
  const db = new DatabaseSync(dbPath)
  try {
    db.exec("INSERT INTO maintenance_boundary_probe(value) VALUES('raw-writer')")
  } finally {
    db.close()
  }
  process.stdout.write('RAW_WRITE_SUCCEEDED\n')
}

async function inheritedLease(): Promise<void> {
  const owner = process.env.STOCKBOARD_PARENT_UPDATE_LOCK_OWNER ?? ''
  const jobType = process.env.STOCKBOARD_PARENT_UPDATE_LOCK_JOB_TYPE ?? ''
  const { assertInheritedUpdateLockOwner } = await import('@/lib/server/update-lock')
  await assertInheritedUpdateLockOwner(jobType, owner, ['db_maintenance', 'update_latest'])
  await assert.rejects(
    () => assertInheritedUpdateLockOwner(jobType, `${owner}:tampered`, ['db_maintenance', 'update_latest']),
    /does not match/,
  )
  await assert.rejects(
    () => assertInheritedUpdateLockOwner(jobType, owner, ['post_ohlcv_refresh']),
    /not allowed/,
  )
  process.stdout.write('INHERITED_LEASE_VERIFIED\n')
}

async function cleanupOrphan(): Promise<void> {
  const { cleanupOrphanedUpdateLocks } = await import('@/lib/server/update-lock')
  const cleaned = await cleanupOrphanedUpdateLocks(['db_maintenance'])
  process.stdout.write(`ORPHAN_CLEANED=${cleaned}\n`)
}

async function transactionPragmas(): Promise<void> {
  const { client, ensureReady } = await import('@/lib/db/client')
  await ensureReady()
  for (let index = 0; index < 2; index += 1) {
    const transaction = await client.transaction('write')
    const transactionTimeout = await transaction.execute('PRAGMA busy_timeout')
    assert.equal(Number(Object.values(transactionTimeout.rows[0] ?? {})[0]), 60_000)
    await transaction.execute('UPDATE maintenance_boundary_probe SET value=value WHERE 0')
    await transaction.commit()
    const result = await client.execute('PRAGMA busy_timeout')
    assert.equal(Number(Object.values(result.rows[0] ?? {})[0]), 60_000)
  }
  const [transaction, ...timeouts] = await Promise.all([
    client.transaction('write'),
    client.execute('PRAGMA busy_timeout'),
    client.execute('PRAGMA busy_timeout'),
  ])
  await transaction.rollback()
  assert.deepEqual(timeouts.map((result) => Number(Object.values(result.rows[0] ?? {})[0])), [60_000, 60_000])
  process.stdout.write('TRANSACTION_PRAGMAS_VERIFIED\n')
}

function waitForLine(child: ReturnType<typeof spawn>, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = ''
    const timeout = setTimeout(() => reject(new Error(`timed out waiting for ${expected}: ${output}`)), 120_000)
    child.stdout!.on('data', (chunk) => {
      output += String(chunk)
      if (!output.includes(expected)) return
      clearTimeout(timeout)
      resolve()
    })
    child.stderr!.on('data', (chunk) => { output += String(chunk) })
    child.on('exit', (code) => {
      if (!output.includes(expected)) {
        clearTimeout(timeout)
        reject(new Error(`child exited ${code} before ${expected}: ${output}`))
      }
    })
  })
}

function runChild(childMode: string, environment: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', tsxImport, process.argv[1], childMode], {
      cwd: process.cwd(),
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => { output += String(chunk) })
    child.stderr.on('data', (chunk) => { output += String(chunk) })
    child.on('error', reject)
    child.on('exit', (code) => code === 0 ? resolve(output) : reject(new Error(output)))
  })
}

async function parent(): Promise<void> {
  verifyDirectSqliteInitialization()
  // realpath: the quarantine refuses a directory reached through a symlink.
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stockboard-maintenance-boundary-')))
  await verifyQuarantineBoundary(directory)
  const database = path.join(directory, 'fixture.sqlite')
  const fixture = new DatabaseSync(database)
  fixture.exec(`
    CREATE TABLE maintenance_boundary_probe(value TEXT NOT NULL);
    CREATE TABLE update_locks(
      job_type TEXT PRIMARY KEY, status TEXT NOT NULL, owner TEXT,
      started_at INTEGER NOT NULL DEFAULT (unixepoch()),
      heartbeat_at INTEGER NOT NULL DEFAULT (unixepoch()), lease_expires_at INTEGER NOT NULL
    );
  `)
  fixture.close()
  const environment = {
    ...process.env,
    USE_LOCAL_DB: '1',
    STOCKBOARD_DB_PATH: database,
    SKIP_SCHEMA_ENSURE: '1',
    STOCKBOARD_LOCK_HOLDER_LEASE_SECONDS: '60',
    STOCKBOARD_LOCK_HOLDER_HEARTBEAT_MS: '1000',
  }
  const transactionPragmaResult = await runChild('transaction-pragmas', environment)
  assert.match(transactionPragmaResult, /TRANSACTION_PRAGMAS_VERIFIED/)
  const lockHolder = spawn(process.execPath, ['--import', tsxImport, 'scripts/hold-update-lock.ts'], {
    cwd: process.cwd(), env: environment, stdio: ['pipe', 'pipe', 'pipe'],
  })
  try {
    await waitForLine(lockHolder, '"status":"LOCKED"')
    const lockDb = new DatabaseSync(database, { readOnly: true })
    const owner = String((lockDb.prepare(
      "SELECT owner FROM update_locks WHERE job_type='db_maintenance'",
    ).get() as { owner: string }).owner)
    lockDb.close()
    const inherited = await runChild('inherited-lease', {
      ...environment,
      STOCKBOARD_PARENT_UPDATE_LOCK_JOB_TYPE: 'db_maintenance',
      STOCKBOARD_PARENT_UPDATE_LOCK_OWNER: owner,
    })
    assert.match(inherited, /INHERITED_LEASE_VERIFIED/)
    const cooperative = await runChild('cooperative-writer', environment)
    assert.match(cooperative, /COOPERATIVE_BLOCKED/)
    const raw = await runChild('raw-writer', environment)
    assert.match(raw, /RAW_WRITE_SUCCEEDED/)
    const inspected = new DatabaseSync(database, { readOnly: true })
    const count = inspected.prepare('SELECT COUNT(*) AS count FROM maintenance_boundary_probe').get() as { count: number }
    inspected.close()
    assert.equal(count.count, 1)

    const tamper = new DatabaseSync(database)
    tamper.prepare("UPDATE update_locks SET owner='tampered-owner' WHERE job_type='db_maintenance'").run()
    tamper.close()
    const holderExit = lockHolder.exitCode !== null
      ? lockHolder.exitCode
      : await new Promise<number | null>((resolve) => lockHolder.once('exit', resolve))
    assert.notEqual(holderExit, 0, 'ownership loss must terminate the holder as a failure')
    const held = new DatabaseSync(database, { readOnly: true })
    const lockRow = held.prepare(
      "SELECT status,owner FROM update_locks WHERE job_type='db_maintenance'",
    ).get() as { status: string; owner: string }
    held.close()
    assert.equal(lockRow.status, 'running', 'a failed heartbeat must not mark the maintenance lease idle')
    assert.equal(lockRow.owner, 'tampered-owner')

    const reset = new DatabaseSync(database)
    reset.exec("UPDATE update_locks SET status='idle',owner=NULL,lease_expires_at=unixepoch()")
    reset.close()
    const orphanHolder = spawn(process.execPath, ['--import', tsxImport, 'scripts/hold-update-lock.ts'], {
      cwd: process.cwd(), env: environment, stdio: ['pipe', 'pipe', 'pipe'],
    })
    await waitForLine(orphanHolder, '"status":"LOCKED"')
    orphanHolder.stdin.end()
    const orphanExit = await new Promise<number | null>((resolve) => orphanHolder.once('exit', resolve))
    assert.equal(orphanExit, 0, 'a closed parent pipe must stop heartbeats without releasing the lease')

    const activeDbHandle = spawn(process.execPath, ['-e', `
      const { DatabaseSync } = require('node:sqlite')
      const db = new DatabaseSync(process.env.STOCKBOARD_DB_PATH, { readOnly: true })
      process.stdout.write('DB_HANDLE_OPEN\\n')
      setTimeout(() => { db.close(); process.exit(0) }, 60000)
    `], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
    await waitForLine(activeDbHandle, 'DB_HANDLE_OPEN')
    try {
      const blockedCleanup = await runChild('cleanup-orphan', environment)
      assert.match(blockedCleanup, /ORPHAN_CLEANED=0/)
    } finally {
      activeDbHandle.kill('SIGTERM')
      await new Promise<void>((resolve) => activeDbHandle.once('exit', () => resolve()))
    }

    const unrelatedWriter = spawn(process.execPath, [
      '-e', 'setTimeout(() => process.exit(0), 60000)', 'scripts/update-latest.ts',
    ], { stdio: 'ignore' })
    try {
      let cleanup = ''
      for (let attempt = 0; attempt < 20; attempt += 1) {
        cleanup = await runChild('cleanup-orphan', environment)
        if (/ORPHAN_CLEANED=1/.test(cleanup)) break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      assert.match(cleanup, /ORPHAN_CLEANED=1/)
    } finally {
      unrelatedWriter.kill('SIGTERM')
    }
    console.log('JP local repair maintenance boundary: PASS')
    console.log('cooperative lease requires a service hold; quarantine rename blocks normal-path access and restores without clobbering')
  } finally {
    lockHolder.stdin?.end()
    if (lockHolder.exitCode === null && lockHolder.signalCode === null) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          lockHolder.kill('SIGKILL')
          resolve()
        }, 5_000)
        lockHolder.once('exit', () => {
          clearTimeout(timeout)
          resolve()
        })
      })
    }
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  if (mode === 'cooperative-writer') await cooperativeWriter()
  else if (mode === 'raw-writer') rawWriter()
  else if (mode === 'inherited-lease') await inheritedLease()
  else if (mode === 'cleanup-orphan') await cleanupOrphan()
  else if (mode === 'transaction-pragmas') await transactionPragmas()
  else await parent()
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
