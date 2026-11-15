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
type LockHolder = { label: string; child: ChildProcessWithoutNullStreams; exited: Promise<void> }

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

const settled = (child: ChildProcessWithoutNullStreams) => child.exitCode !== null || child.signalCode !== null

async function acquireLock(sqliteBinary: string, source: SnapshotSource, waitMs: number): Promise<LockHolder> {
  const child = spawn(sqliteBinary, ['-bail', '-batch', source.databasePath], { stdio: ['pipe', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  let spawnError = ''
  child.stdout.on('data', (chunk) => { out += String(chunk) })
  child.stderr.on('data', (chunk) => { err += String(chunk) })
  // Without these, a failed spawn or a closed pipe would crash the process before writers are restored.
  child.on('error', (error) => { spawnError ||= error.message })
  child.stdin.on('error', () => undefined)
  const holder = { label: source.label, child, exited: new Promise<void>((resolve) => child.once('close', () => resolve())) }
  child.stdin.write(`.dbconfig no_ckpt_on_close on\n.timeout ${waitMs}\nBEGIN IMMEDIATE;\nSELECT 'SNAPSHOT_LOCKED';\n`)
  const deadline = Date.now() + waitMs + 5_000
  while (!/^SNAPSHOT_LOCKED$/m.test(out)) {
    if (settled(child) || spawnError || Date.now() >= deadline) {
      // The setting may not have been applied, so never let this connection close normally.
      await releaseLock(holder, { graceful: /no_ckpt_on_close\s+on/.test(out) })
      throw new Error(`SNAPSHOT_LOCK_FAILED:${source.label}:${(spawnError || err).trim().slice(0, 200)}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  // Refuse to hold a lock whose close could checkpoint the source: kill it instead of closing it,
  // since a killed sqlite3 never runs its close path and so cannot checkpoint.
  if (!/no_ckpt_on_close\s+on/.test(out)) {
    await releaseLock(holder, { graceful: false })
    throw new Error(`SNAPSHOT_NO_CKPT_ON_CLOSE_NOT_SET:${source.label}`)
  }
  return holder
}

/** Resolves only once the lock process has exited (its lock is then gone), escalating to SIGKILL. */
async function releaseLock(holder: LockHolder, options: { graceful: boolean }): Promise<void> {
  const { child } = holder
  const waitExit = (ms: number) => Promise.race([holder.exited.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))])
  if (settled(child)) { await waitExit(1_000); return }
  if (options.graceful && child.stdin.writable) {
    child.stdin.end('ROLLBACK;\n.quit\n')
    if (await waitExit(10_000)) return
  }
  child.kill(options.graceful ? 'SIGTERM' : 'SIGKILL')
  if (await waitExit(5_000)) return
  child.kill('SIGKILL')
  if (!(await waitExit(5_000))) throw new Error(`SNAPSHOT_LOCK_PROCESS_DID_NOT_EXIT:${holder.label}`)
}

function cloneFile(cloneBinary: string, source: string, destination: string, timeoutMs: number): void {
  const result = spawnSync(cloneBinary, [source, destination],
    { encoding: 'utf8', timeout: Math.max(1, timeoutMs), killSignal: 'SIGKILL' })
  if (result.error || result.status !== 0) {
    throw new Error(`SNAPSHOT_CLONE_FAILED:${path.basename(source)}:${result.status}:${result.error?.message ?? result.stderr.trim()}`)
  }
}

function realDirectory(directory: string): boolean {
  let stat: fs.Stats
  try { stat = fs.lstatSync(directory) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`SNAPSHOT_STAGING_NOT_A_DIRECTORY:${directory}`)
  return true
}

/**
 * Removes only the names this module creates: each clone and the SQLite sidecars beside it, then the
 * directories. Symlinked directories are refused, and anything else left makes rmdir fail rather than vanish.
 */
export function removeLockedSnapshot(stagingDirectory: string, sources: SnapshotSource[]): void {
  if (!realDirectory(stagingDirectory)) return
  for (const source of sources) {
    const directory = path.join(stagingDirectory, source.label)
    if (!realDirectory(directory)) continue
    const base = path.basename(source.databasePath)
    for (const name of [base, `${base}-wal`, `${base}-shm`, `${base}-journal`]) {
      const file = path.join(directory, name)
      if (!fs.existsSync(file)) continue
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
    const remaining = () => {
      const left = lockedAt + args.maximumLockMs - Date.now()
      if (left <= 0) throw new Error('SNAPSHOT_LOCK_LIMIT_EXCEEDED')
      return left
    }
    for (const source of args.sources) {
      // Once the first lock is held, later waits count against the lock limit.
      const waitMs = lockedAt ? Math.min(args.lockWaitMs, Math.max(1, remaining() - 5_000)) : args.lockWaitMs
      holders.push(await acquireLock(args.sqliteBinary, source, waitMs))
      lockedAt ||= Date.now()
      remaining()
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
      if (settled(holder.child)) throw new Error(`SNAPSHOT_LOCK_LOST:${holder.label}`)
    }
  } catch (error) {
    await Promise.allSettled(holders.map((holder) => releaseLock(holder, { graceful: true })))
    try { removeLockedSnapshot(args.stagingDirectory, args.sources) } catch { /* the original error matters more */ }
    throw error
  }
  try {
    await Promise.all(holders.map((holder) => releaseLock(holder, { graceful: true })))
    lockHeldMs = Date.now() - lockedAt
    for (const holder of holders) {
      if (holder.child.exitCode !== 0) {
        throw new Error(`SNAPSHOT_LOCK_RELEASE_FAILED:${holder.label}:${holder.child.exitCode}:${holder.child.signalCode}`)
      }
    }
  } catch (error) {
    try { removeLockedSnapshot(args.stagingDirectory, args.sources) } catch { /* the original error matters more */ }
    throw error
  }
  return { stagingDirectory: args.stagingDirectory, files, lockHeldMs }
}
