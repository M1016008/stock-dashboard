import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { configForDatabase, guardForDatabase, hasStorageFatalLatch, inspectStorage, systemStorageProbe } from '@/lib/storage/external-storage-guard'
import { resolveConfiguredStoragePath } from '@/lib/storage-paths'

type ReadOnlyDatabase = {
  exec(sql: string): void
  prepare(sql: string): { get(): unknown; all(): unknown[] }
  close(): void
}
const command = process.argv[2]
const configured = process.env.STOCKBOARD_DB_PATH || process.env.LOCAL_DB_PATH

function dbPath(): string {
  if (!configured) throw new Error('STOCKBOARD_DB_PATH is not configured')
  return resolveConfiguredStoragePath(configured)
}

function currentStatus(): void {
  const db = dbPath()
  const config = configForDatabase(db, 'storage-cli')
  const mount = path.resolve(config.mountPath)
  const volume = systemStorageProbe.volume(mount)
  let guardStatus = 'STORAGE_UNAVAILABLE'
  const startedAt = performance.now()
  try {
    if (hasStorageFatalLatch(config)) throw new Error('FAILED_SAFE: manual storage review required')
    inspectStorage(config); guardStatus = 'PASS'
  } catch (error) {
    guardStatus = error instanceof Error ? error.message : String(error)
  }
  const preflightMs = Math.round((performance.now() - startedAt) * 10) / 10
  const companions = ['-wal', '-shm'].map((suffix) => {
    const file = `${db}${suffix}`
    return { path: file, exists: fs.existsSync(file), realpath: fs.existsSync(file) ? fs.realpathSync(file) : null }
  })
  console.log(JSON.stringify({
    mountPath: mount, mounted: Boolean(volume), expectedUuidConfigured: Boolean(config.volumeUuid),
    uuidMatches: volume?.uuid?.toUpperCase() === config.volumeUuid.toUpperCase(),
    filesystem: volume?.filesystem ?? null, writable: volume?.writable ?? false,
    freeBytes: volume?.freeBytes ?? null, totalBytes: volume?.totalBytes ?? null,
    dbPath: db, dbExists: fs.existsSync(db), dbRealpath: fs.existsSync(db) ? fs.realpathSync(db) : null,
    companions, guardStatus, preflightMs,
  }, null, 2))
  if (guardStatus !== 'PASS') process.exitCode = 2
}

function sqliteReadOnly(db: string, quickCheck: boolean): void {
  const { DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: new (filename: string, options: { readOnly: boolean }) => ReadOnlyDatabase
  }
  const connection = new DatabaseSync(db, { readOnly: true })
  try {
    connection.exec('PRAGMA query_only=ON')
    if (quickCheck) {
      console.log(JSON.stringify(connection.prepare('PRAGMA quick_check').all()))
    } else {
      const pragmas = ['journal_mode', 'synchronous', 'busy_timeout', 'wal_autocheckpoint', 'foreign_keys']
      console.log(JSON.stringify(Object.fromEntries(pragmas.map((key) => [key, connection.prepare(`PRAGMA ${key}`).get()])), null, 2))
    }
  } finally { connection.close() }
}

function diagnose(): void {
  currentStatus()
  if (process.exitCode) return
  const db = dbPath()
  sqliteReadOnly(db, false)
  if (process.platform === 'darwin') {
    const diskutil = spawnSync('/usr/sbin/diskutil', ['info', configForDatabase(db).mountPath], { encoding: 'utf8', timeout: 8_000 })
    console.log((diskutil.stdout ?? '').split('\n').filter((line) => /Mounted:|File System|Volume Name:|Protocol:|SMART Status:|Free Space:/.test(line)).join('\n'))
    const recent = spawnSync('/usr/bin/log', [
      'show', '--last', '2h', '--style', 'compact', '--predicate', 'process == "diskarbitrationd"',
    ], { encoding: 'utf8', timeout: 15_000, maxBuffer: 2_000_000 })
    console.log((recent.stdout ?? '').split('\n').filter((line) => /mount|unmount|eject|disconnect/i.test(line)).slice(-20).join('\n'))
  }
}

function quickCheck(): void {
  const db = dbPath()
  guardForDatabase(db, 'manual-quick-check').assertWritable(true)
  const files = [db, `${db}-wal`, `${db}-shm`].filter((file) => fs.existsSync(file))
  const result = spawnSync('/usr/sbin/lsof', files, { encoding: 'utf8', timeout: 10_000 })
  if (result.error || result.status === null || result.status > 1) throw new Error('Could not verify active DB users')
  if (result.status === 0 && result.stdout.trim()) throw new Error('Active DB users found: quick_check refused')
  sqliteReadOnly(db, true)
}

try {
  if (command === 'status') currentStatus()
  else if (command === 'preflight') {
    const config = configForDatabase(dbPath(), 'service-restart-preflight')
    if (hasStorageFatalLatch(config)) throw new Error('FAILED_SAFE: manual storage review required')
    inspectStorage(config)
  }
  else if (command === 'diagnose') diagnose()
  else if (command === 'db-quick-check') quickCheck()
  else throw new Error(`Unknown storage command: ${command ?? ''}`)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
