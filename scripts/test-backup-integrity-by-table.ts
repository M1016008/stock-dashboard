import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkBackupIntegrityByTable } from './check-backup-integrity-by-table'
import { fileSha256 } from '@/lib/storage/sqlite-rsync-generation'

const SQLITE = process.env.SQLITE3_BIN || '/tmp/stockboard-sqlite-tools-3540100/sqlite3'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stockboard-integrity-by-table-'))
const quiet = () => undefined
try {
  // A published generation (spaces in the path, like the SanDisk volume) and a report kept outside it.
  const generation = path.join(root, 'Backup Volume', 'generation')
  const database = path.join(generation, 'JP', 'stockboard.db')
  fs.mkdirSync(path.dirname(database), { recursive: true })
  const created = spawnSync(SQLITE, [database, `PRAGMA journal_mode=WAL; CREATE TABLE a(id INTEGER PRIMARY KEY, v TEXT UNIQUE);
    CREATE TABLE b(id INTEGER PRIMARY KEY, w INTEGER); CREATE INDEX bw ON b(w);
    INSERT INTO a(v) VALUES('x'),('y'); INSERT INTO b(w) VALUES(1),(2);`], { encoding: 'utf8' })
  assert.equal(created.status, 0, created.stderr)
  const manifest = (sha256: string) => fs.writeFileSync(path.join(generation, 'COMPLETE.manifest.json'),
    JSON.stringify({ status: 'VERIFIED', markets: { JP: { databaseSha256: sha256 } } }))
  manifest(fileSha256(database))
  const report = path.join(root, 'report.jsonl')
  const base = { generation, market: 'JP' as const, report, sqlite: SQLITE, log: quiet }

  assert.throws(() => checkBackupIntegrityByTable({ ...base, report: path.join(generation, 'r.jsonl') }), /REPORT_INSIDE_GENERATION/)
  // Only a .jsonl file, and never through a symlink (a dangling one could point into the generation or at production).
  assert.throws(() => checkBackupIntegrityByTable({ ...base, report: path.join(root, 'stockboard.db-wal') }), /REPORT_MUST_BE_JSONL/)
  const linked = path.join(root, 'linked.jsonl')
  fs.symlinkSync(path.join(generation, 'JP', 'planted.jsonl'), linked)
  assert.throws(() => checkBackupIntegrityByTable({ ...base, report: linked }), /REPORT_NOT_A_REGULAR_FILE|ELOOP/)
  assert.equal(fs.existsSync(path.join(generation, 'JP', 'planted.jsonl')), false)
  // Night 1 stops before starting any table; it still records the copy's identity.
  assert.deepEqual(checkBackupIntegrityByTable({ ...base, stopStartingAfterMs: Date.now() }),
    { done: 0, remaining: 3, failed: [], complete: false, ok: false })
  // Night 2 finishes; immutable read-only opens leave no -wal/-shm beside the copy.
  assert.deepEqual(checkBackupIntegrityByTable(base), { done: 3, remaining: 0, failed: [], complete: true, ok: true })
  const lines = fs.readFileSync(report, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.deepEqual(lines.map((line) => line.kind === 'table' ? `${line.table}:${line.result}` : line.kind),
    ['start', 'sqlite_schema:ok', 'a:ok', 'b:ok', 'complete'])
  assert.equal(lines[4].ok, true)
  assert.deepEqual(fs.readdirSync(path.dirname(database)), ['stockboard.db'])
  assert.throws(() => checkBackupIntegrityByTable(base), /REPORT_ALREADY_COMPLETE/)

  // A copy that changed between nights is refused.
  const changedReport = path.join(root, 'changed.jsonl')
  checkBackupIntegrityByTable({ ...base, report: changedReport, stopStartingAfterMs: Date.now() })
  fs.utimesSync(database, new Date(), new Date(Date.now() + 5_000))
  assert.throws(() => checkBackupIntegrityByTable({ ...base, report: changedReport }), /DATABASE_CHANGED_SINCE_FIRST_RUN/)

  // A table whose check is not "ok" is reported as failed, and the complete line says so.
  const stub = path.join(root, 'sqlite-stub.sh')
  fs.writeFileSync(stub, `#!/bin/sh\ncase "$3" in *'integrity_check("b")'*) echo 'row 2 missing from index bw';; *) exec "${SQLITE}" "$@";; esac\n`, { mode: 0o700 })
  const failedReport = path.join(root, 'failed.jsonl')
  assert.deepEqual(checkBackupIntegrityByTable({ ...base, report: failedReport, sqlite: stub }),
    { done: 3, remaining: 0, failed: ['b'], complete: true, ok: false })
  assert.equal(JSON.parse(fs.readFileSync(failedReport, 'utf8').trim().split('\n').at(-1)!).ok, false)
  // The command line exits non-zero when the check is not ok.
  const cli = spawnSync(process.execPath, ['--import', 'tsx', path.join(__dirname, 'check-backup-integrity-by-table.ts'),
    `--generation=${generation}`, '--market=JP', `--report=${path.join(root, 'cli.jsonl')}`, `--sqlite=${stub}`], { encoding: 'utf8' })
  assert.equal(cli.status, 1, cli.stderr)
  assert.equal(JSON.parse(cli.stdout.trim().split('\n').at(-1)!).ok, false)

  // A copy whose bytes change during the last night fails the final hash: complete, but not ok.
  const tamperGeneration = path.join(root, 'tamper')
  fs.cpSync(generation, tamperGeneration, { recursive: true })
  const tamperDb = path.join(tamperGeneration, 'JP', 'stockboard.db')
  const tamperStub = path.join(root, 'sqlite-tamper.sh')
  fs.writeFileSync(tamperStub, `#!/bin/sh\ncase "$3" in *'integrity_check("b")'*) /usr/bin/printf 'x' | /bin/dd of="${tamperDb}" bs=1 seek=5000 conv=notrunc 2>/dev/null; echo ok;; *) exec "${SQLITE}" "$@";; esac\n`, { mode: 0o700 })
  const tamperReport = path.join(root, 'tamper.jsonl')
  checkBackupIntegrityByTable({ ...base, generation: tamperGeneration, report: tamperReport, stopStartingAfterMs: Date.now() })
  const keepTimes = fs.statSync(tamperDb)
  const tampered = checkBackupIntegrityByTable({ ...base, generation: tamperGeneration, report: tamperReport, sqlite: tamperStub,
    log: () => fs.utimesSync(tamperDb, keepTimes.atime, keepTimes.mtime) })
  assert.deepEqual(tampered, { done: 3, remaining: 0, failed: [], complete: true, ok: false })

  // The copy must be the published bytes.
  manifest('0'.repeat(64))
  assert.throws(() => checkBackupIntegrityByTable({ ...base, report: path.join(root, 'other.jsonl') }), /DATABASE_SHA256_MISMATCH/)
  console.log('backup integrity-by-table tests passed')
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
