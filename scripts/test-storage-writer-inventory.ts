import assert from 'node:assert/strict'
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
assert.match(fs.readFileSync('scripts/run-us-ml-job.ts', 'utf8'), /\['-readonly'/)
assert.deepEqual(rawLocalClients, [], `unguarded direct local SQLite clients:\n${rawLocalClients.join('\n')}`)
console.log('Production writer inventory enforcement: PASS (no unguarded direct local SQLite client)')
