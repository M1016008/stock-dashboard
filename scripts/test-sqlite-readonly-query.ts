// Tests lib/storage/sqlite-readonly-query.ts on throwaway WAL databases in a temp folder.
// The regression: /usr/bin/sqlite3 -readonly fails with SQLITE_CANTOPEN (14) on a WAL database whose
// -wal/-shm are absent (no other connection open). The helper must read it, stay read-only, and
// also read while another process keeps the database open.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { queryReadOnlyFirstColumn } from '@/lib/storage/sqlite-readonly-query'

const SQLITE = '/usr/bin/sqlite3'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stockboard-readonly-query-'))
const sha = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

function sql(database: string, statement: string): string {
  const result = spawnSync(SQLITE, [database, statement], { encoding: 'utf8', timeout: 60_000 })
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr)
  return result.stdout.trim()
}

// A WAL database with no -wal/-shm, as the production writer (libsql) leaves it after its last close.
function closedWalDatabase(name: string): string {
  const database = path.join(root, name)
  sql(database, `PRAGMA journal_mode=WAL; CREATE TABLE ohlcv_daily (ticker TEXT, date TEXT);
    INSERT INTO ohlcv_daily VALUES ('AAA', '2026-11-20'), ('BBB', '2026-11-24'), ('AAA', '2026-11-24');
    PRAGMA wal_checkpoint(TRUNCATE);`)
  assert.equal(fs.statSync(`${database}-wal`).size, 0)
  fs.rmSync(`${database}-wal`)
  fs.rmSync(`${database}-shm`)
  assert.deepEqual([...fs.readFileSync(database).subarray(18, 20)], [2, 2])
  return database
}

async function main(): Promise<void> {
  try {
    // 1. The failure being fixed, and the helper reading the same file.
    const closed = closedWalDatabase('closed.db')
    const before = sha(closed)
    const cli = spawnSync(SQLITE, ['-readonly', '-cmd', '.timeout 30000', closed, 'SELECT MAX(date) FROM ohlcv_daily'], { encoding: 'utf8' })
    assert.equal(cli.status, 14, `expected SQLITE_CANTOPEN from /usr/bin/sqlite3 -readonly, got ${cli.status}: ${cli.stderr}`)
    assert.deepEqual(queryReadOnlyFirstColumn(closed, ['SELECT MAX(date) FROM ohlcv_daily']), ['2026-11-24'])
    assert.deepEqual(queryReadOnlyFirstColumn(closed, ['SELECT DISTINCT ticker FROM ohlcv_daily ORDER BY ticker']), ['AAA', 'BBB'])
    assert.deepEqual(queryReadOnlyFirstColumn(closed, ['SELECT COUNT(*) FROM ohlcv_daily', 'SELECT NULL', 'SELECT MIN(date) FROM ohlcv_daily WHERE 0']),
      ['3', '', ''])
    assert.deepEqual(queryReadOnlyFirstColumn(closed, ['PRAGMA schema_version', 'PRAGMA freelist_count']).length, 2)

    // 2. Read-only: writes are refused and the database file is unchanged.
    assert.throws(() => queryReadOnlyFirstColumn(closed, ["INSERT INTO ohlcv_daily VALUES ('CCC', '2026-11-25') RETURNING ticker"]), /readonly|read-only/i)
    assert.equal(sql(closed, 'SELECT COUNT(*) FROM ohlcv_daily'), '3')
    assert.equal(sha(closed), before)

    // 3. Another process keeps the database open: the helper still reads.
    const open = closedWalDatabase('open.db')
    const holder = spawn(SQLITE, [open], { stdio: ['pipe', 'ignore', 'ignore'] })
    try {
      holder.stdin.write('SELECT COUNT(*) FROM ohlcv_daily;\n')
      for (let i = 0; i < 100 && !fs.existsSync(`${open}-shm`); i += 1) sleep(50)
      assert.ok(fs.existsSync(`${open}-shm`), 'holder did not open the database')
      assert.deepEqual(queryReadOnlyFirstColumn(open, ['SELECT COUNT(*) FROM ohlcv_daily']), ['3'])
    } finally {
      holder.stdin.end()
      await new Promise((resolve) => holder.once('exit', resolve))
    }

    // 4. The US ML wrapper no longer opens databases with `sqlite3 -readonly`.
    const usMlJob = fs.readFileSync(path.join(process.cwd(), 'scripts', 'run-us-ml-job.ts'), 'utf8')
    assert.equal(usMlJob.includes("'-readonly'"), false)
    assert.equal((usMlJob.match(/queryReadOnlyFirstColumn\(/g) ?? []).length, 2)
    console.log('sqlite-readonly-query tests passed')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
