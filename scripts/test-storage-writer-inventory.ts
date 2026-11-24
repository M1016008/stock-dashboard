import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

function files(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const value = path.join(root, entry.name)
    return entry.isDirectory() ? files(value) : [value]
  })
}

const sourceFiles = [...files('lib'), ...files('scripts')]
  .filter((file) => /\.(ts|py)$/.test(file) && !/scripts\/test-/.test(file))
const rawLocalClients: string[] = []
for (const file of sourceFiles) {
  const source = fs.readFileSync(file, 'utf8')
  if (file !== 'lib/storage/guarded-libsql-client.ts' && /createClient\(\{\s*url:\s*`file:/.test(source)) {
    rawLocalClients.push(file)
  }
  if (file.endsWith('.py')) {
    const readOnlyUriConnection = /uri\s*=\s*f?["']file:.*\?mode=ro/.test(source)
    for (const line of source.split('\n')) {
      if (!line.includes('sqlite3.connect(')) continue
      if (line.includes('mode=ro') || (line.includes('sqlite3.connect(uri, uri=True)') && readOnlyUriConnection)
        || file === 'scripts/external_storage_guard.py') continue
      // The sole remaining direct connection creates a synthetic local test fixture.
      if (file === 'scripts/train-ma-trajectory-shadow.py' && line.includes('sqlite3.connect(path)')) continue
      rawLocalClients.push(`${file}: ${line.trim()}`)
    }
  }
}
const nativeSqlite = sourceFiles.filter((file) => /(?:spawnSync|execFileSync)\(['"]sqlite3/.test(fs.readFileSync(file, 'utf8')))
assert.deepEqual(nativeSqlite.sort(), ['scripts/build-us-analytics-db.ts', 'scripts/run-us-ml-job.ts'])
assert.match(fs.readFileSync('scripts/build-us-analytics-db.ts', 'utf8'), /guardForDatabase\(dbPath/)
// Reads go through a query-only connection (lib/storage/sqlite-cli-read.ts): /usr/bin/sqlite3 -readonly cannot open a
// WAL database while its -wal/-shm are absent (the 2026-11-08 weekly US failure, db-maintenance since 2026-11-20).
assert.match(fs.readFileSync('scripts/run-us-ml-job.ts', 'utf8'), /sqliteCliReadArgs\(/)
// Python's bundled SQLite opens a WAL database read-only without -wal/-shm (checked), so only JS/TS sources are scanned.
// Every tracked JS/TS source in the project (app, components, lib, scripts, root files, ...).
const readonlyCli = execFileSync('git', ['ls-files', '*.ts', '*.tsx', '*.js', '*.mjs', '*.cjs'], { encoding: 'utf8' })
  .split('\n').filter(Boolean)
  .filter((file) => /\.(ts|tsx|js|mjs|cjs)$/.test(file) && !/scripts\/test-/.test(file))
  .filter((file) => /['"]-readonly['"]|[?&]mode=ro\b/.test(fs.readFileSync(file, 'utf8')))
// The backup tools run their own pinned sqlite3 3.54.1 on copies (one with immutable=1); the daily-close report is a development tool.
assert.deepEqual(readonlyCli.sort(), [
  'lib/storage/sqlite-cli-read.ts', // only its explanation of the failure
  'lib/storage/sqlite-rsync-generation.ts',
  // scripts/check-backup-integrity-by-table.ts is not in ebd9fe7 (it came to main later).
  'scripts/lib/readonly-daily-close-report.ts',
  'scripts/run-weekly-backup-generation.ts',
], 'a new `sqlite3 -readonly` read: use sqliteCliReadArgs instead')
assert.deepEqual(rawLocalClients, [], `unguarded direct local SQLite clients:\n${rawLocalClients.join('\n')}`)
console.log('Production writer inventory enforcement: PASS (no unguarded direct local SQLite client)')
