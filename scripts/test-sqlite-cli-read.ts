// Tests lib/storage/sqlite-cli-read.ts with /usr/bin/sqlite3 on throwaway WAL databases in a temp folder.
// The regression: `sqlite3 -readonly` fails with SQLITE_CANTOPEN (14) on a WAL database whose -wal/-shm are
// absent (no other connection open). The query-only connection must read it, refuse writes, never create a
// missing file, and work alongside the production writer (libsql) and another open connection.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sqliteCliReadArgs } from '@/lib/storage/sqlite-cli-read'

const SQLITE = '/usr/bin/sqlite3'
// A space like the production volume name. libsql URLs cannot carry %, # or ?, so those are tested with sqlite3 only (5.).
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stockboard cli read-'))
const sha = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

function cli(args: string[]) {
  return spawnSync(SQLITE, args, { encoding: 'utf8', timeout: 60_000 })
}
function read(database: string, statement: string, extra: string[] = []): string {
  const result = cli([...extra, ...sqliteCliReadArgs(database), statement])
  assert.equal(result.status, 0, `read failed (${result.status}): ${result.stderr}`)
  return result.stdout.trim()
}

// Written by libsql (the production writer) in its own process. libsql removes -wal/-shm when the
// connection is finally released (garbage collection or process exit), so after this no connection is open.
async function libsqlWrite(database: string, statements: string[]): Promise<void> {
  const script = `const { createClient } = require('@libsql/client')
    const client = createClient({ url: 'file:' + process.argv[1] })
    ;(async () => { for (const s of JSON.parse(process.argv[2])) await client.execute(s); client.close() })()
      .catch((e) => { console.error(e); process.exit(1) })`
  const result = spawnSync(process.execPath, ['-e', script, database, JSON.stringify(statements)], { encoding: 'utf8', timeout: 60_000 })
  assert.equal(result.status, 0, result.stderr)
}

async function main(): Promise<void> {
  try {
    const db = path.join(root, 'us analytics.db')
    await libsqlWrite(db, [
      'PRAGMA journal_mode=WAL',
      'CREATE TABLE ohlcv_daily (ticker TEXT, date TEXT)',
      "INSERT INTO ohlcv_daily VALUES ('AAA', '2026-11-20'), ('BBB', '2026-11-24'), ('AAA', '2026-11-24')",
    ])
    assert.deepEqual([...fs.readFileSync(db).subarray(18, 20)], [2, 2], 'not a WAL database')
    assert.equal(fs.existsSync(`${db}-wal`) || fs.existsSync(`${db}-shm`), false, 'libsql left -wal/-shm behind')

    // 1. The failure being fixed, and the query-only connection reading the same file.
    const before = sha(db)
    const old = cli(['-readonly', '-cmd', '.timeout 30000', db, 'SELECT MAX(date) FROM ohlcv_daily'])
    assert.equal(old.status, 14, `expected SQLITE_CANTOPEN from -readonly, got ${old.status}: ${old.stderr}`)
    assert.equal(read(db, 'SELECT MAX(date) FROM ohlcv_daily'), '2026-11-24')
    assert.equal(read(db, 'SELECT DISTINCT ticker FROM ohlcv_daily ORDER BY ticker'), 'AAA\nBBB')
    assert.deepEqual(JSON.parse(read(db, 'SELECT COUNT(*) AS n FROM ohlcv_daily', ['-json'])), [{ n: 3 }])
    assert.equal(read(db, 'PRAGMA schema_version; PRAGMA freelist_count;').split('\n').length, 2)

    // 2. Writes are refused, the database file is unchanged, and a missing file is never created.
    const write = cli([...sqliteCliReadArgs(db), "INSERT INTO ohlcv_daily VALUES ('CCC', '2026-11-25')"])
    assert.notEqual(write.status, 0)
    assert.match(write.stderr, /readonly database/)
    assert.equal(sha(db), before)
    const missing = path.join(root, 'missing.db')
    assert.notEqual(cli([...sqliteCliReadArgs(missing), 'SELECT 1']).status, 0)
    assert.equal(fs.existsSync(missing), false)
    assert.throws(() => sqliteCliReadArgs('relative.db'), /absolute/)

    // 3. The production writer keeps working after the read, and the database stays consistent.
    await libsqlWrite(db, ["INSERT INTO ohlcv_daily VALUES ('CCC', '2026-11-25')"])
    assert.equal(read(db, 'SELECT COUNT(*) FROM ohlcv_daily'), '4')
    assert.equal(read(db, 'PRAGMA integrity_check'), 'ok')

    // 4. Another process keeps the database open: still read.
    const holder = spawn(SQLITE, [db], { stdio: ['pipe', 'ignore', 'ignore'] })
    try {
      holder.stdin.write('SELECT COUNT(*) FROM ohlcv_daily;\n')
      for (let i = 0; i < 100 && !fs.existsSync(`${db}-shm`); i += 1) sleep(50)
      assert.ok(fs.existsSync(`${db}-shm`), 'holder did not open the database')
      assert.equal(read(db, 'SELECT COUNT(*) FROM ohlcv_daily'), '4')
    } finally {
      holder.stdin.end()
      await new Promise((resolve) => holder.once('exit', resolve))
    }
    // 5. Characters that mean something in a SQLite URI are encoded.
    const odd = path.join(root, 'odd %23 #? dir', 'a.db')
    fs.mkdirSync(path.dirname(odd))
    assert.equal(cli([odd, 'PRAGMA journal_mode=WAL; CREATE TABLE t (x); INSERT INTO t VALUES (7);']).status, 0)
    assert.equal(read(odd, 'SELECT x FROM t'), '7')
    console.log('sqlite-cli-read tests passed')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
