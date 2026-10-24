import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { stableJson, type WeeklyBackupCompleteManifest } from '@/lib/storage/weekly-backup-policy'

export type RsyncMonitorLimits = {
  deadlineMs: number
  destinationMount: string
  destinationReserveBytes: number
  destinationFreeBytesAtStart: number
  maximumCandidateGrowthBytes: number
  sourceWalPath: string
  sourceWalBytesAtStart: number
  maximumWalGrowthBytes: number
  sourceDatabaseSizeAtStart: number
  sourceDatabaseMtimeMsAtStart: number
}

export type RsyncProgress = {
  at: string
  elapsedMs: number
  destinationFreeBytes: number
  sourceWalBytes: number
  sourceWalGrowthBytes: number
  candidatePhysicalGrowthBytes: number
}

export type ReplicaVerification = {
  databaseSha256: string
  quickCheck: string
  integrityCheck: string
  readOnlyReopen: boolean
  restoreQuickCheck: string
  restoreIntegrityCheck: string
}

function command(binary: string, args: string[], timeoutMs: number): string {
  const result = spawnSync(binary, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 16_000_000,
  })
  if (result.error || result.status !== 0) {
    throw new Error(`COMMAND_FAILED:${path.basename(binary)}:${result.status}:${result.signal}:${result.error?.message ?? result.stderr.trim()}`)
  }
  return result.stdout.trim()
}

function assertWithin(root: string, candidate: string): void {
  const normalizedRoot = path.resolve(root)
  const normalizedCandidate = path.resolve(candidate)
  if (normalizedCandidate !== normalizedRoot && !normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error(`PATH_OUTSIDE_APPROVED_ROOT:${candidate}`)
  }
}

function assertRegularFile(filePath: string): void {
  const stat = fs.lstatSync(filePath)
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`REGULAR_FILE_REQUIRED:${filePath}`)
}

export function fileSha256(filePath: string, deadlineMs?: number): string {
  assertRegularFile(filePath)
  const hash = createHash('sha256')
  const descriptor = fs.openSync(filePath, 'r')
  const buffer = Buffer.allocUnsafe(8 * 1024 * 1024)
  try {
    for (;;) {
      if (deadlineMs !== undefined && Date.now() >= deadlineMs) {
        throw new Error('VERIFICATION_DEADLINE_EXCEEDED')
      }
      const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null)
      if (bytes === 0) break
      hash.update(buffer.subarray(0, bytes))
    }
  } finally {
    fs.closeSync(descriptor)
  }
  return hash.digest('hex')
}

export function cloneReplicaSeed(args: {
  priorGenerationRoot: string
  priorDatabasePath: string
  candidateRoot: string
  candidateDatabasePath: string
  deadlineMs?: number
}): void {
  assertWithin(args.priorGenerationRoot, args.priorDatabasePath)
  assertWithin(args.candidateRoot, args.candidateDatabasePath)
  assertRegularFile(args.priorDatabasePath)
  if (fs.existsSync(args.candidateDatabasePath)) throw new Error('CANDIDATE_DATABASE_ALREADY_EXISTS')
  fs.mkdirSync(path.dirname(args.candidateDatabasePath), { recursive: true, mode: 0o700 })
  const timeoutMs = args.deadlineMs === undefined
    ? 30 * 60_000
    : Math.min(30 * 60_000, remainingMs(args.deadlineMs))
  command('/bin/cp', ['-c', args.priorDatabasePath, args.candidateDatabasePath], timeoutMs)
  assertRegularFile(args.candidateDatabasePath)
}

function walBytes(filePath: string): number {
  try {
    const stat = fs.lstatSync(filePath)
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`WAL_FILE_INVALID:${filePath}`)
    return stat.size
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
}

function freeBytes(mountPath: string): number {
  const stat = fs.statfsSync(mountPath, { bigint: true })
  const bytes = stat.bsize * stat.bavail
  if (bytes > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('DESTINATION_FREE_BYTES_UNSAFE')
  return Number(bytes)
}

export async function runMonitoredSqliteRsync(args: {
  sqliteRsyncBinary: string
  sourceDatabasePath: string
  candidateDatabasePath: string
  limits: RsyncMonitorLimits
  assertRuntimeIdentity: () => void
  onProgress?: (progress: RsyncProgress) => void
}): Promise<{ elapsedMs: number; sourceWalGrowthBytes: number; stderr: string }> {
  assertRegularFile(args.sqliteRsyncBinary)
  assertRegularFile(args.sourceDatabasePath)
  assertRegularFile(args.candidateDatabasePath)
  args.assertRuntimeIdentity()
  const started = Date.now()
  let stderr = ''
  let stdout = ''
  let peakWalGrowthBytes = 0
  const child = spawn(args.sqliteRsyncBinary,
    ['--wal-only', '-vv', args.sourceDatabasePath, args.candidateDatabasePath],
    { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', (chunk) => { stdout = `${stdout}${String(chunk)}`.slice(-4_000_000) })
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-4_000_000) })

  let monitorError: Error | null = null
  while (child.exitCode === null && child.signalCode === null) {
    try { args.assertRuntimeIdentity() } catch (error) {
      monitorError = error instanceof Error ? error : new Error(String(error))
    }
    const currentWalBytes = walBytes(args.limits.sourceWalPath)
    const growth = Math.abs(currentWalBytes - args.limits.sourceWalBytesAtStart)
    const available = freeBytes(args.limits.destinationMount)
    const candidateGrowth = Math.max(0, args.limits.destinationFreeBytesAtStart - available)
    const sourceStat = fs.lstatSync(args.sourceDatabasePath)
    peakWalGrowthBytes = Math.max(peakWalGrowthBytes, growth)
    const progress: RsyncProgress = {
      at: new Date().toISOString(),
      elapsedMs: Date.now() - started,
      destinationFreeBytes: available,
      sourceWalBytes: currentWalBytes,
      sourceWalGrowthBytes: growth,
      candidatePhysicalGrowthBytes: candidateGrowth,
    }
    try { args.onProgress?.(progress) } catch (error) {
      monitorError = error instanceof Error ? error : new Error(String(error))
    }
    if (Date.now() >= args.limits.deadlineMs) monitorError = new Error('SQLITE_RSYNC_DEADLINE_EXCEEDED')
    else if (available < args.limits.destinationReserveBytes) monitorError = new Error('DESTINATION_RESERVE_BREACHED')
    else if (candidateGrowth > args.limits.maximumCandidateGrowthBytes) {
      monitorError = new Error('CANDIDATE_GROWTH_LIMIT_EXCEEDED')
    }
    else if (growth > args.limits.maximumWalGrowthBytes) monitorError = new Error('SOURCE_WAL_GROWTH_LIMIT_EXCEEDED')
    else if (sourceStat.size !== args.limits.sourceDatabaseSizeAtStart
      || sourceStat.mtimeMs !== args.limits.sourceDatabaseMtimeMsAtStart) {
      monitorError = new Error('SOURCE_DATABASE_CHANGED_DURING_SYNC')
    }
    if (monitorError) {
      child.kill('SIGTERM')
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }

  const killTimer = monitorError ? setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }, 5_000) : null
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve({ code: child.exitCode, signal: child.signalCode })
    else child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  if (killTimer) clearTimeout(killTimer)
  if (monitorError) throw monitorError
  if (result.code !== 0) {
    throw new Error(`SQLITE_RSYNC_FAILED:${result.code}:${result.signal}:${stderr.trim() || stdout.trim()}`)
  }
  args.assertRuntimeIdentity()
  return { elapsedMs: Date.now() - started, sourceWalGrowthBytes: peakWalGrowthBytes, stderr: stderr.trim() }
}

function remainingMs(deadlineMs: number): number {
  const remaining = deadlineMs - Date.now()
  if (!Number.isFinite(deadlineMs) || remaining <= 0) throw new Error('VERIFICATION_DEADLINE_EXCEEDED')
  return Math.max(1, Math.floor(remaining))
}

function pragma(sqliteBinary: string, databasePath: string, statement: string, timeoutMs: number): string {
  return command(sqliteBinary, ['-readonly', databasePath, statement], timeoutMs)
}

export function verifyReplica(args: {
  sqliteBinary: string
  candidateRoot: string
  candidateDatabasePath: string
  restoreDatabasePath: string
  deadlineMs: number
}): ReplicaVerification {
  assertWithin(args.candidateRoot, args.candidateDatabasePath)
  assertWithin(args.candidateRoot, args.restoreDatabasePath)
  assertRegularFile(args.sqliteBinary)
  assertRegularFile(args.candidateDatabasePath)
  if (fs.existsSync(args.restoreDatabasePath)) throw new Error('RESTORE_SMOKE_PATH_ALREADY_EXISTS')
  const quickCheck = pragma(args.sqliteBinary, args.candidateDatabasePath,
    'PRAGMA quick_check;', remainingMs(args.deadlineMs))
  const integrityCheck = pragma(args.sqliteBinary, args.candidateDatabasePath,
    'PRAGMA integrity_check;', remainingMs(args.deadlineMs))
  pragma(args.sqliteBinary, args.candidateDatabasePath,
    'SELECT count(*) FROM sqlite_schema;', remainingMs(args.deadlineMs))
  cloneReplicaSeed({
    priorGenerationRoot: args.candidateRoot,
    priorDatabasePath: args.candidateDatabasePath,
    candidateRoot: args.candidateRoot,
    candidateDatabasePath: args.restoreDatabasePath,
    deadlineMs: args.deadlineMs,
  })
  const restoreQuickCheck = pragma(args.sqliteBinary, args.restoreDatabasePath,
    'PRAGMA quick_check;', remainingMs(args.deadlineMs))
  const restoreIntegrityCheck = pragma(args.sqliteBinary, args.restoreDatabasePath,
    'PRAGMA integrity_check;', remainingMs(args.deadlineMs))
  return {
    databaseSha256: fileSha256(args.candidateDatabasePath, args.deadlineMs),
    quickCheck,
    integrityCheck,
    readOnlyReopen: true,
    restoreQuickCheck,
    restoreIntegrityCheck,
  }
}

export function publishVerifiedGeneration(args: {
  generationRoot: string
  manifest: WeeklyBackupCompleteManifest
}): { manifestPath: string; manifestSha256: string } {
  fs.mkdirSync(args.generationRoot, { recursive: true, mode: 0o700 })
  const manifestPath = path.join(args.generationRoot, 'COMPLETE.manifest.json')
  const temporaryPath = path.join(args.generationRoot, `.COMPLETE.manifest.${process.pid}.tmp`)
  if (fs.existsSync(manifestPath) || fs.existsSync(temporaryPath)) throw new Error('COMPLETE_MANIFEST_COLLISION')
  const descriptor = fs.openSync(temporaryPath, 'wx', 0o600)
  try {
    fs.writeFileSync(descriptor, stableJson(args.manifest))
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
  fs.renameSync(temporaryPath, manifestPath)
  const directory = fs.openSync(args.generationRoot, 'r')
  try { fs.fsyncSync(directory) } finally { fs.closeSync(directory) }
  return { manifestPath, manifestSha256: fileSha256(manifestPath) }
}
