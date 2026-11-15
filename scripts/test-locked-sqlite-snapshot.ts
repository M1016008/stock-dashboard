import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLockedSqliteSnapshot } from '@/lib/storage/locked-sqlite-snapshot'

const SQLITE = process.env.SQLITE3_BIN || '/tmp/stockboard-sqlite-tools-3540100/sqlite3'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stockboard-locked-snapshot-'))

function sql(database: string, statement: string, prefix: string[] = []): string {
  const result = spawnSync(SQLITE, [...prefix, database, statement], { encoding: 'utf8', timeout: 60_000 })
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr)
  return result.stdout.trim()
}
const sha = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const state = (database: string) => ({ db: sha(database), wal: fs.existsSync(`${database}-wal`) ? sha(`${database}-wal`) : null })

// A WAL database whose committed rows live only in its WAL (as on production between checkpoints).
function walDatabase(name: string, rows: number): string {
  const database = path.join(root, name)
  const result = spawnSync(SQLITE, [database], {
    encoding: 'utf8',
    input: `.dbconfig no_ckpt_on_close on\nPRAGMA journal_mode=WAL;\nPRAGMA wal_autocheckpoint=0;\nCREATE TABLE a(x);\n`
      + `WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c WHERE i<${rows}) INSERT INTO a SELECT i FROM c;\n`,
  })
  if (result.status !== 0) throw new Error(result.stderr)
  assert.ok(fs.statSync(`${database}-wal`).size > 0)
  return database
}

async function main(): Promise<void> {
  try {
    const clone = path.join(root, 'apfs-clone-file')
    const compiled = spawnSync('/usr/bin/cc', ['-O2', '-Wall', '-Werror', '-o', clone,
      path.join(process.cwd(), 'scripts', 'native', 'apfs-clone-file.c')], { encoding: 'utf8' })
    assert.equal(compiled.status, 0, compiled.stderr)
    const base = { sqliteBinary: SQLITE, cloneBinary: clone, lockWaitMs: 2_000, maximumLockMs: 20_000 }

    // 1. The lock connection is the last one to close: production's DB and WAL stay byte-identical,
    //    and the clone (main file + WAL, no -shm) opens to the same committed rows.
    const jp = walDatabase('jp.db', 20_000)
    const us = path.join(root, 'us.db')
    sql(us, 'PRAGMA journal_mode=WAL; CREATE TABLE b(y); INSERT INTO b VALUES (1),(2);') // closes cleanly: no WAL left
    const before = { jp: state(jp), us: state(us) }
    const snapshot = await createLockedSqliteSnapshot({ ...base, stagingDirectory: path.join(root, 'staging-1'),
      sources: [{ label: 'JP', databasePath: jp }, { label: 'US', databasePath: us }] })
    // A source without a WAL gets an empty one from the lock connection (SQLite ignores an empty WAL);
    // every existing byte stays the same.
    assert.deepEqual({ jp: state(jp), us: state(us) }, { ...before, us: { ...before.us, wal: sha('/dev/null') } })
    assert.deepEqual(snapshot.files.map((file) => `${file.label}:${file.kind}`), ['JP:db', 'JP:wal', 'US:db', 'US:wal'])
    assert.equal(fs.existsSync(path.join(root, 'staging-1', 'JP', 'jp.db-shm')), false)
    assert.equal(sql(path.join(root, 'staging-1', 'JP', 'jp.db'), 'SELECT count(*), sum(x) FROM a;'), '20000|200010000')
    assert.equal(sql(path.join(root, 'staging-1', 'US', 'us.db'), 'SELECT count(*) FROM b;'), '2')

    // 2. Between the main-file clone and the WAL clone another connection checkpoints (it may copy
    //    WAL pages into the main file) and tries to write (it must be refused by the held lock).
    const live = walDatabase('live.db', 5_000)
    const wrapper = path.join(root, 'clone-with-interference.sh')
    fs.writeFileSync(wrapper, `#!/bin/sh\ncase "$1" in *-wal)\n`
      + `  "${SQLITE}" "${live}" "PRAGMA wal_checkpoint(PASSIVE);" > "${root}/ckpt.out" 2>&1\n`
      + `  "${SQLITE}" -cmd ".timeout 100" "${live}" "INSERT INTO a VALUES (-1);" > "${root}/write.out" 2>&1 && echo WROTE >> "${root}/write.out"\n`
      + `;;\nesac\nexec "${clone}" "$@"\n`, { mode: 0o700 })
    const mainBefore = sha(live)
    await createLockedSqliteSnapshot({ ...base, cloneBinary: wrapper, stagingDirectory: path.join(root, 'staging-2'),
      sources: [{ label: 'JP', databasePath: live }] })
    assert.match(fs.readFileSync(path.join(root, 'ckpt.out'), 'utf8'), /^0\|\d+\|\d+/)
    assert.notEqual(sha(live), mainBefore, 'the passive checkpoint really copied WAL pages into the main file')
    assert.match(fs.readFileSync(path.join(root, 'write.out'), 'utf8'), /locked|busy/i)
    assert.doesNotMatch(fs.readFileSync(path.join(root, 'write.out'), 'utf8'), /WROTE/)
    const staged = path.join(root, 'staging-2', 'JP', 'live.db')
    assert.equal(sql(staged, 'SELECT count(*), min(x) FROM a;'), '5000|1')
    assert.equal(sql(staged, 'PRAGMA integrity_check;'), 'ok')

    // 3. A writer already holding the lock: the snapshot gives up within the wait and leaves nothing behind.
    const busy = walDatabase('busy.db', 100)
    const holder = spawn(SQLITE, [busy], { stdio: ['pipe', 'pipe', 'pipe'] })
    let held = ''
    holder.stdout.on('data', (chunk) => { held += String(chunk) })
    holder.stdin.write(`BEGIN IMMEDIATE;\nSELECT 'HELD';\n`)
    while (!held.includes('HELD')) await new Promise((resolve) => setTimeout(resolve, 20))
    await assert.rejects(() => createLockedSqliteSnapshot({ ...base, lockWaitMs: 300,
      stagingDirectory: path.join(root, 'staging-3'), sources: [{ label: 'JP', databasePath: busy }] }), /SNAPSHOT_LOCK_FAILED:JP/)
    assert.equal(fs.existsSync(path.join(root, 'staging-3')), false)
    holder.stdin.end('ROLLBACK;\n')

    // 4. Cloning past the lock limit fails, removes the staging copy, and releases the lock.
    const slow = path.join(root, 'slow-clone.sh')
    fs.writeFileSync(slow, `#!/bin/sh\nsleep 3\nexec "${clone}" "$@"\n`, { mode: 0o700 })
    const limited = walDatabase('limited.db', 100)
    await assert.rejects(() => createLockedSqliteSnapshot({ ...base, cloneBinary: slow, maximumLockMs: 1_000,
      stagingDirectory: path.join(root, 'staging-4'), sources: [{ label: 'JP', databasePath: limited }] }),
    /SNAPSHOT_CLONE_FAILED|SNAPSHOT_LOCK_LIMIT_EXCEEDED/)
    assert.equal(fs.existsSync(path.join(root, 'staging-4')), false)
    sql(limited, 'INSERT INTO a VALUES (0);', ['-cmd', '.timeout 2000'])

    // 5. An existing staging directory is never reused or removed.
    fs.mkdirSync(path.join(root, 'staging-5'))
    fs.writeFileSync(path.join(root, 'staging-5', 'keep'), 'x')
    await assert.rejects(() => createLockedSqliteSnapshot({ ...base, stagingDirectory: path.join(root, 'staging-5'),
      sources: [{ label: 'JP', databasePath: jp }] }), /SNAPSHOT_STAGING_DIRECTORY_INVALID/)
    assert.equal(fs.readFileSync(path.join(root, 'staging-5', 'keep'), 'utf8'), 'x')

    console.log(JSON.stringify({ lastCloseKeepsProductionBytes: true, checkpointDuringCloneConsistent: true,
      busyLockFailsClean: true, lockLimitFailsClean: true, existingStagingRefused: true, lockHeldMs: snapshot.lockHeldMs }, null, 2))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

void main()
