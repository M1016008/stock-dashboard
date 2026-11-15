import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// A point-in-time copy of live WAL-mode SQLite databases on the same APFS volume.
// Shared by the P1 pre-deploy copy and the weekly backup (clone first, then sync off-device).
//
// While every source's write lock is held (BEGIN IMMEDIATE, nothing written), no connection
// can commit or restart its WAL. A passive checkpoint by another connection may still copy
// WAL pages into the main file, but the WAL itself stays intact, so the cloned main file plus
// the cloned WAL replay to the committed state at lock time. The -shm file is never cloned.
// `.dbconfig no_ckpt_on_close on` keeps the lock connection from checkpointing or deleting the
// WAL if it happens to be the last connection to close (checked on 2026-11-15 with 3.54.1).

export type SnapshotSource = { label: string; databasePath: string }
export type SnapshotFile = { label: string; kind: 'db' | 'wal'; sourcePath: string; clonePath: string; bytes: number }
export type LockedSnapshot = { stagingDirectory: string; files: SnapshotFile[]; lockHeldMs: number }

type WalIdentity = { ino: number; size: number; header: string } | null
type LockHolder = { label: string; child: ChildProcessWithoutNullStreams; stdout: () => string }

const LABEL = /^[A-Za-z0-9_-]{1,32}$/

function regularFile(filePath: string): fs.Stats {
  const stat = fs.lstatSync(filePath)
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`REGULAR_FILE_REQUIRED:${filePath}`)
  return stat
}

function walIdentity(walPath: string): WalIdentity {
  let descriptor: number
  try { descriptor = fs.openSync(walPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  try {
    const stat = fs.fstatSync(descriptor)
    if (!stat.isFile()) throw new Error(`REGULAR_FILE_REQUIRED:${walPath}`)
    const header = Buffer.alloc(32)
    const bytes = fs.readSync(descriptor, header, 0, 32, 0)
    return { ino: stat.ino, size: stat.size, header: header.subarray(0, bytes).toString('hex') }
  } finally { fs.closeSync(descriptor) }
}

async function acquireLock(sqliteBinary: string, source: SnapshotSource, waitMs: number): Promise<LockHolder> {
  const child = spawn(sqliteBinary, ['-bail', '-batch', source.databasePath], { stdio: ['pipe', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  child.stdout.on('data', (chunk) => { out += String(chunk) })
  child.stderr.on('data', (chunk) => { err += String(chunk) })
  const holder = { label: source.label, child, stdout: () => out }
  child.stdin.write(`.dbconfig no_ckpt_on_close on\n.timeout ${waitMs}\nBEGIN IMMEDIATE;\nSELECT 'SNAPSHOT_LOCKED';\n`)
  const deadline = Date.now() + waitMs + 5_000
  while (!/^SNAPSHOT_LOCKED$/m.test(out)) {
    if (child.exitCode !== null || child.signalCode !== null || Date.now() >= deadline) {
      await releaseLock(holder)
      throw new Error(`SNAPSHOT_LOCK_FAILED:${source.label}:${err.trim().slice(0, 200)}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  // Refuse to hold a lock whose close could checkpoint the source.
  if (!/no_ckpt_on_close\s+on/.test(out)) {
    await releaseLock(holder)
    throw new Error(`SNAPSHOT_NO_CKPT_ON_CLOSE_NOT_SET:${source.label}`)
  }
  return holder
}

async function releaseLock(holder: LockHolder): Promise<void> {
  const { child } = holder
  if (child.exitCode === null && child.signalCode === null) {
    if (child.stdin.writable) child.stdin.end('ROLLBACK;\n.quit\n')
    const exited = await Promise.race([
      new Promise<boolean>((resolve) => child.once('exit', () => resolve(true))),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10_000)),
    ])
    // A killed sqlite3 never runs its close path, so it cannot checkpoint either.
    if (!exited) child.kill('SIGTERM')
  }
}

function cloneFile(cloneBinary: string, source: string, destination: string, timeoutMs: number): void {
  const result = spawnSync(cloneBinary, [source, destination], { encoding: 'utf8', timeout: Math.max(1, timeoutMs) })
  if (result.error || result.status !== 0) {
    throw new Error(`SNAPSHOT_CLONE_FAILED:${path.basename(source)}:${result.status}:${result.error?.message ?? result.stderr.trim()}`)
  }
}

/** Removes only files this module created (clones and SQLite sidecars beside them) and their directories. */
export function removeLockedSnapshot(stagingDirectory: string, labels: string[]): void {
  if (!fs.existsSync(stagingDirectory)) return
  for (const label of labels) {
    const directory = path.join(stagingDirectory, label)
    if (!fs.existsSync(directory)) continue
    for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory, name)
      regularFile(file)
      fs.unlinkSync(file)
    }
    fs.rmdirSync(directory)
  }
  fs.rmdirSync(stagingDirectory)
}

export async function createLockedSqliteSnapshot(args: {
  sqliteBinary: string
  cloneBinary: string
  sources: SnapshotSource[]
  stagingDirectory: string
  lockWaitMs: number
  maximumLockMs: number
}): Promise<LockedSnapshot> {
  const labels = args.sources.map((source) => source.label)
  if (!labels.length || new Set(labels).size !== labels.length || !labels.every((label) => LABEL.test(label))) {
    throw new Error('SNAPSHOT_LABELS_INVALID')
  }
  const parent = fs.lstatSync(path.dirname(args.stagingDirectory))
  if (!parent.isDirectory() || fs.existsSync(args.stagingDirectory)) throw new Error('SNAPSHOT_STAGING_DIRECTORY_INVALID')
  const sourceStats = args.sources.map((source) => regularFile(source.databasePath))
  // clonefile(2) needs one volume; the native helper also refuses an existing destination.
  if (sourceStats.some((stat) => stat.dev !== parent.dev)) throw new Error('SNAPSHOT_STAGING_NOT_ON_SOURCE_VOLUME')

  fs.mkdirSync(args.stagingDirectory, { mode: 0o700 })
  const holders: LockHolder[] = []
  const files: SnapshotFile[] = []
  let lockedAt = 0
  let lockHeldMs = 0
  try {
    for (const label of labels) fs.mkdirSync(path.join(args.stagingDirectory, label), { mode: 0o700 })
    // Every lock is taken before the first clone and held until the last one.
    for (const source of args.sources) {
      holders.push(await acquireLock(args.sqliteBinary, source, args.lockWaitMs))
      lockedAt ||= Date.now()
    }
    const remaining = () => {
      const left = lockedAt + args.maximumLockMs - Date.now()
      if (left <= 0) throw new Error('SNAPSHOT_LOCK_LIMIT_EXCEEDED')
      return left
    }
    args.sources.forEach((source, index) => {
      const walPath = `${source.databasePath}-wal`
      const walBefore = walIdentity(walPath)
      const directory = path.join(args.stagingDirectory, source.label)
      const dbClone = path.join(directory, path.basename(source.databasePath))
      // Main file first, then the WAL, the direction SQLite rolls forward.
      cloneFile(args.cloneBinary, source.databasePath, dbClone, remaining())
      files.push({ label: source.label, kind: 'db', sourcePath: source.databasePath, clonePath: dbClone, bytes: regularFile(dbClone).size })
      if (walBefore) {
        const walClone = `${dbClone}-wal`
        cloneFile(args.cloneBinary, walPath, walClone, remaining())
        files.push({ label: source.label, kind: 'wal', sourcePath: walPath, clonePath: walClone, bytes: regularFile(walClone).size })
        const walAfter = walIdentity(walPath)
        if (JSON.stringify(walAfter) !== JSON.stringify(walBefore) || regularFile(walClone).size !== walBefore.size) {
          throw new Error(`SNAPSHOT_WAL_CHANGED_UNDER_LOCK:${source.label}`)
        }
      } else if (walIdentity(walPath) !== null) {
        throw new Error(`SNAPSHOT_WAL_APPEARED_UNDER_LOCK:${source.label}`)
      }
      const now = regularFile(source.databasePath)
      if (now.dev !== sourceStats[index].dev || now.ino !== sourceStats[index].ino) {
        throw new Error(`SNAPSHOT_SOURCE_REPLACED:${source.label}`)
      }
    })
    remaining()
    for (const holder of holders) {
      if (holder.child.exitCode !== null || holder.child.signalCode !== null) throw new Error(`SNAPSHOT_LOCK_LOST:${holder.label}`)
    }
    lockHeldMs = Date.now() - lockedAt
  } catch (error) {
    await Promise.all(holders.map(releaseLock))
    try { removeLockedSnapshot(args.stagingDirectory, labels) } catch { /* the original error matters more */ }
    throw error
  }
  await Promise.all(holders.map(releaseLock))
  for (const holder of holders) {
    if (holder.child.exitCode !== 0) {
      removeLockedSnapshot(args.stagingDirectory, labels)
      throw new Error(`SNAPSHOT_LOCK_RELEASE_FAILED:${holder.label}:${holder.child.exitCode}:${holder.child.signalCode}`)
    }
  }
  return { stagingDirectory: args.stagingDirectory, files, lockHeldMs }
}
