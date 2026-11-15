// Point-in-time APFS clones of live SQLite databases on their own volume (the P1 pre-deploy copy
// and the weekly-backup rehearsal). Default is observe only; creating clones needs --confirm.
//   --staging=<new dir on the DB volume> --db=<LABEL>=<path> (repeat) --sqlite3=<path>
//   --clone-binary=<path> --clone-binary-sha256=<hex> --min-free-bytes=<n> [--max-lock-ms=60000]
//   [--remove-after] [--confirm=WRITE_APPROVED_LOCKED_SNAPSHOT]
import fs from 'node:fs'
import path from 'node:path'
import { createLockedSqliteSnapshot, removeLockedSnapshot } from '@/lib/storage/locked-sqlite-snapshot'
import { fileSha256 } from '@/lib/storage/sqlite-rsync-generation'

const options = new Map<string, string[]>()
for (const argument of process.argv.slice(2)) {
  const match = /^--([a-z0-9-]+)(?:=(.*))?$/.exec(argument)
  if (!match) throw new Error(`UNKNOWN_ARGUMENT:${argument}`)
  options.set(match[1], [...(options.get(match[1]) ?? []), match[2] ?? 'true'])
}
const one = (name: string): string => {
  const values = options.get(name)
  if (!values || values.length !== 1) throw new Error(`ARGUMENT_REQUIRED_ONCE:--${name}`)
  return values[0]
}
const known = ['staging', 'db', 'sqlite3', 'clone-binary', 'clone-binary-sha256', 'min-free-bytes', 'max-lock-ms', 'remove-after', 'confirm']
for (const name of options.keys()) if (!known.includes(name)) throw new Error(`UNKNOWN_ARGUMENT:--${name}`)

const staging = path.resolve(one('staging'))
const sources = (options.get('db') ?? []).map((value) => {
  const at = value.indexOf('=')
  return { label: value.slice(0, at), databasePath: path.resolve(value.slice(at + 1)) }
})
const minimumFreeBytes = Number(one('min-free-bytes'))
const maximumLockMs = Number(options.get('max-lock-ms')?.[0] ?? 60_000)
if (!Number.isSafeInteger(minimumFreeBytes) || minimumFreeBytes <= 0) throw new Error('MIN_FREE_BYTES_INVALID')
if (!Number.isSafeInteger(maximumLockMs) || maximumLockMs <= 0 || maximumLockMs > 5 * 60_000) throw new Error('MAX_LOCK_MS_INVALID')
const cloneBinary = one('clone-binary')
if (fileSha256(cloneBinary) !== one('clone-binary-sha256')) throw new Error('CLONE_BINARY_SHA256_MISMATCH')
const freeBytes = () => {
  const stat = fs.statfsSync(path.dirname(staging), { bigint: true })
  return Number(stat.bavail * stat.bsize)
}
const describe = () => sources.map(({ label, databasePath }) => {
  const wal = `${databasePath}-wal`
  return { label, databasePath, bytes: fs.statSync(databasePath).size, walBytes: fs.existsSync(wal) ? fs.statSync(wal).size : null }
})

async function main(): Promise<void> {
  const before = { at: new Date().toISOString(), freeBytes: freeBytes(), sources: describe() }
  if (before.freeBytes < minimumFreeBytes) throw new Error(`SOURCE_VOLUME_BELOW_MINIMUM_FREE:${before.freeBytes}`)
  if (options.get('confirm')?.[0] !== 'WRITE_APPROVED_LOCKED_SNAPSHOT') {
    console.log(JSON.stringify({ mode: 'observe', staging, minimumFreeBytes, maximumLockMs, ...before }, null, 2))
    return
  }
  const started = Date.now()
  const snapshot = await createLockedSqliteSnapshot({
    sqliteBinary: one('sqlite3'), cloneBinary, sources, stagingDirectory: staging,
    lockWaitMs: Math.min(30_000, maximumLockMs), maximumLockMs,
  })
  const after = { at: new Date().toISOString(), freeBytes: freeBytes(), elapsedMs: Date.now() - started }
  const removed = options.has('remove-after')
  if (removed) removeLockedSnapshot(staging, sources.map((source) => source.label))
  console.log(JSON.stringify({ mode: 'execute', before, snapshot, after, removed,
    freeBytesAfterRemoval: removed ? freeBytes() : null }, null, 2))
}

main().catch((error: unknown) => {
  console.error(`[locked-snapshot] FAILED: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
