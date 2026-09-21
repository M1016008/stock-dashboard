import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type StorageFailureCode =
  | 'VOLUME_NOT_MOUNTED' | 'VOLUME_UUID_MISMATCH' | 'DB_OUTSIDE_EXPECTED_VOLUME'
  | 'DB_NOT_FOUND' | 'VOLUME_READ_ONLY' | 'INSUFFICIENT_STORAGE'
  | 'MOUNT_IDENTITY_UNKNOWN' | 'VOLUME_IDENTITY_LOST' | 'FATAL_STORAGE_IO'

export class StorageUnavailableError extends Error {
  readonly status = 503
  constructor(readonly storageCode: StorageFailureCode, message: string) {
    super(message)
    this.name = 'StorageUnavailableError'
  }
}

export type VolumeIdentity = {
  mountPoint: string
  uuid: string | null
  filesystem: string | null
  writable: boolean
  freeBytes: number
  totalBytes: number
}

export type StorageProbe = {
  volume(mountPath: string): VolumeIdentity | null
  realpath(filePath: string): string
  stat(filePath: string): { dev: number | bigint; isFile(): boolean; isDirectory(): boolean }
  exists(filePath: string): boolean
}

function diskutilVolume(mountPath: string): VolumeIdentity | null {
  if (process.platform !== 'darwin') return null
  try {
    const plist = execFileSync('/usr/sbin/diskutil', ['info', '-plist', mountPath], {
      timeout: 8_000, maxBuffer: 2_000_000,
    })
    const info = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], {
      input: plist, encoding: 'utf8', timeout: 8_000,
    })) as Record<string, unknown>
    if (info.MountPoint !== mountPath) return null
    const stats = fs.statfsSync(mountPath, { bigint: true })
    return {
      mountPoint: String(info.MountPoint),
      uuid: typeof info.VolumeUUID === 'string' ? info.VolumeUUID : null,
      filesystem: typeof info.FilesystemType === 'string' ? info.FilesystemType : null,
      writable: info.WritableVolume === true,
      freeBytes: Number(stats.bavail * stats.bsize),
      totalBytes: Number(stats.blocks * stats.bsize),
    }
  } catch {
    return null
  }
}

export const systemStorageProbe: StorageProbe = {
  volume: diskutilVolume,
  realpath: fs.realpathSync,
  stat: fs.statSync,
  exists: fs.existsSync,
}

export type GuardConfig = {
  dbPath: string
  mountPath: string
  volumeUuid: string
  minFreeBytes: number
  minFreePercent: number
  jobType?: string
  incidentDir?: string
}

function fail(code: StorageFailureCode, detail: string): never {
  throw new StorageUnavailableError(code, `STORAGE_UNAVAILABLE: ${detail}`)
}

export function configForDatabase(dbPath: string, jobType?: string): GuardConfig {
  const mountPath = process.env.STOCK_DATA_MOUNT_PATH?.trim() ?? ''
  const volumeUuid = process.env.STOCK_DATA_VOLUME_UUID?.trim() ?? ''
  const minBytes = Number(process.env.STOCK_DATA_MIN_FREE_BYTES ?? 50 * 1024 ** 3)
  const minPercent = Number(process.env.STOCK_DATA_MIN_FREE_PERCENT ?? 5)
  if (!Number.isFinite(minBytes) || minBytes < 0 || !Number.isFinite(minPercent) || minPercent < 0 || minPercent > 100) {
    fail('MOUNT_IDENTITY_UNKNOWN', 'invalid storage free-space threshold')
  }
  return {
    dbPath, mountPath, volumeUuid, minFreeBytes: minBytes, minFreePercent: minPercent,
    jobType,
    incidentDir: process.env.STOCK_DATA_INCIDENT_DIR?.trim(),
  }
}

function contained(mountPath: string, dbPath: string): boolean {
  const relative = path.relative(mountPath, dbPath)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function verifiedVolume(config: GuardConfig, probe: StorageProbe): {
  mountPath: string; realMount: string; mountDevice: number | bigint; volume: VolumeIdentity
} {
  const mountPath = path.resolve(config.mountPath)
  if (!config.volumeUuid || !path.isAbsolute(config.mountPath)) fail('MOUNT_IDENTITY_UNKNOWN', 'mount identity is not configured')
  if (!probe.exists(mountPath)) fail('VOLUME_NOT_MOUNTED', 'expected mount is missing')
  const volume = probe.volume(mountPath)
  if (!volume || volume.mountPoint !== mountPath) fail('VOLUME_NOT_MOUNTED', 'expected volume is not mounted at this path')
  if (!volume.uuid) fail('MOUNT_IDENTITY_UNKNOWN', 'mounted volume UUID is unavailable')
  if (volume.uuid.toUpperCase() !== config.volumeUuid.toUpperCase()) fail('VOLUME_UUID_MISMATCH', 'mounted volume UUID differs')
  if (!volume.writable) fail('VOLUME_READ_ONLY', 'mounted volume is read-only')
  if (volume.freeBytes < config.minFreeBytes || volume.freeBytes / Math.max(volume.totalBytes, 1) * 100 < config.minFreePercent) {
    fail('INSUFFICIENT_STORAGE', 'available capacity is below the configured threshold')
  }
  const realMount = probe.realpath(mountPath)
  const mountStat = probe.stat(realMount)
  if (!mountStat.isDirectory()) fail('VOLUME_NOT_MOUNTED', 'expected mount is not a directory')
  return { mountPath, realMount, mountDevice: mountStat.dev, volume }
}

export function inspectWritableTargetPath(config: GuardConfig, probe: StorageProbe = systemStorageProbe): VolumeIdentity {
  const { mountPath, realMount, mountDevice, volume } = verifiedVolume(config, probe)
  const target = path.resolve(config.dbPath)
  if (!contained(mountPath, target)) fail('DB_OUTSIDE_EXPECTED_VOLUME', 'target is outside expected mount')
  let ancestor = target
  while (!probe.exists(ancestor) && ancestor !== mountPath) ancestor = path.dirname(ancestor)
  const realAncestor = probe.realpath(ancestor)
  if (realAncestor !== realMount && !contained(realMount, realAncestor)) {
    fail('DB_OUTSIDE_EXPECTED_VOLUME', 'target parent resolves outside expected mount')
  }
  if (probe.stat(realAncestor).dev !== mountDevice) fail('DB_OUTSIDE_EXPECTED_VOLUME', 'target parent is on another device')
  if (probe.exists(target)) {
    if (!probe.stat(realAncestor).isFile()) fail('DB_OUTSIDE_EXPECTED_VOLUME', 'existing target is not a file')
    for (const suffix of ['-wal', '-shm']) {
      const companion = `${target}${suffix}`
      if (!probe.exists(companion)) continue
      const realCompanion = probe.realpath(companion)
      if (!contained(realMount, realCompanion) || probe.stat(realCompanion).dev !== mountDevice) {
        fail('DB_OUTSIDE_EXPECTED_VOLUME', `${suffix} is outside expected volume`)
      }
    }
  }
  return volume
}

export function assertWritableTargetPath(targetPath: string, jobType?: string): void {
  if (requiresExternalStorageGuard(targetPath)) inspectWritableTargetPath(configForDatabase(targetPath, jobType))
}

export function requiresExternalStorageGuard(dbPath: string): boolean {
  if (process.env.NODE_ENV === 'production' && process.env.EXTERNAL_STORAGE_REQUIRED === 'false') {
    fail('MOUNT_IDENTITY_UNKNOWN', 'production cannot disable external storage protection')
  }
  return process.env.NODE_ENV === 'production'
    || process.env.EXTERNAL_STORAGE_REQUIRED === 'true'
    || path.resolve(dbPath).startsWith('/Volumes/')
}

export function inspectStorage(config: GuardConfig, probe: StorageProbe = systemStorageProbe): VolumeIdentity {
  const { mountPath, realMount, mountDevice, volume } = verifiedVolume(config, probe)
  const dbPath = path.resolve(config.dbPath)
  if (!contained(mountPath, dbPath)) fail('DB_OUTSIDE_EXPECTED_VOLUME', 'configured DB path is outside expected mount')
  if (!probe.exists(dbPath)) fail('DB_NOT_FOUND', 'configured DB does not exist')
  const realDb = probe.realpath(dbPath)
  if (!contained(realMount, realDb)) fail('DB_OUTSIDE_EXPECTED_VOLUME', 'DB realpath is outside expected volume')
  const dbStat = probe.stat(realDb)
  if (!dbStat.isFile() || mountDevice !== dbStat.dev) {
    fail('DB_OUTSIDE_EXPECTED_VOLUME', 'DB is not a file on the expected device')
  }
  for (const suffix of ['-wal', '-shm']) {
    const companion = `${dbPath}${suffix}`
    if (!probe.exists(companion)) continue
    const realCompanion = probe.realpath(companion)
    if (!contained(realMount, realCompanion) || probe.stat(realCompanion).dev !== mountDevice) {
      fail('DB_OUTSIDE_EXPECTED_VOLUME', `${suffix} is outside expected volume`)
    }
  }
  return volume
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null
  const candidate = error as { code?: unknown; rawCode?: unknown; cause?: unknown }
  return typeof candidate.code === 'string' ? candidate.code
    : typeof candidate.rawCode === 'string' ? candidate.rawCode
    : candidate.cause ? errorCode(candidate.cause) : null
}

export function isStorageIoError(error: unknown): boolean {
  if (error instanceof StorageUnavailableError) return true
  const code = errorCode(error)
  if (code && /^(SQLITE_IOERR(?:_\w+)?|SQLITE_CANTOPEN(?:_\w+)?|SQLITE_READONLY(?:_\w+)?|SQLITE_FULL|EIO|ENODEV|ENOENT|EROFS|ENOSPC)$/.test(code)) return true
  const message = error instanceof Error ? error.message : ''
  return /\b(SQLITE_IOERR|SQLITE_CANTOPEN|SQLITE_READONLY|SQLITE_FULL|EIO|ENODEV|EROFS|ENOSPC)\b|disk I\/O error|database or disk is full|readonly database/i.test(message)
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/(token|secret|password|authorization|api[_-]?key)\s*[:=]\s*\S+/gi, '$1=[redacted]').slice(0, 400)
}

function internalIncidentDir(config: GuardConfig): string {
  const fallback = path.join(os.homedir(), 'Library', 'Application Support', 'StockBoard', 'storage-incidents')
  if (!config.incidentDir) return fallback
  const candidate = path.resolve(config.incidentDir)
  try {
    if (candidate.startsWith('/Volumes/') || fs.realpathSync(candidate).startsWith('/Volumes/')) return fallback
  } catch {
    if (candidate.startsWith('/Volumes/')) return fallback
  }
  return candidate
}

export function storageFatalLatchPath(config: GuardConfig): string {
  return path.join(internalIncidentDir(config), 'FAILED_SAFE')
}

export function hasStorageFatalLatch(config: GuardConfig): boolean {
  return fs.existsSync(storageFatalLatchPath(config))
}

export class ExternalStorageGuard {
  private fatal: StorageUnavailableError | null = null
  private lastCheckAt = 0
  private lastIdentityAt = 0
  private lastSuccessfulStorageCheck: string | null = null
  private knownDevice: number | bigint | null = null
  private knownMountRealpath: string | null = null
  private readonly fatalHandlers = new Set<() => void>()
  private operationContext: { jobType: string; jobId: string } | null = null

  constructor(readonly config: GuardConfig, private readonly probe: StorageProbe = systemStorageProbe) {}

  get status(): 'HEALTHY' | 'FAILED_SAFE' | 'UNCHECKED' {
    return this.fatal ? 'FAILED_SAFE' : this.lastCheckAt ? 'HEALTHY' : 'UNCHECKED'
  }

  get fatalError(): StorageUnavailableError | null { return this.fatal }

  setFatalHandler(handler: () => void): void { this.fatalHandlers.add(handler) }
  setOperationContext(jobType: string, jobId: string): void { this.operationContext = { jobType, jobId } }
  clearOperationContext(jobId: string): void {
    if (this.operationContext?.jobId === jobId) this.operationContext = null
  }

  assertWritable(forceIdentity = false): void {
    if (this.fatal) throw this.fatal
    if (hasStorageFatalLatch(this.config)) {
      this.fatal = new StorageUnavailableError('FATAL_STORAGE_IO', 'storage incident requires manual review before restarting writers')
      throw this.fatal
    }
    const now = Date.now()
    try {
      if (forceIdentity || now - this.lastIdentityAt >= 60_000 || !this.lastIdentityAt) {
        inspectStorage(this.config, this.probe)
        this.knownMountRealpath = this.probe.realpath(path.resolve(this.config.mountPath))
        this.knownDevice = this.probe.stat(this.knownMountRealpath).dev
        this.lastIdentityAt = now
      } else if (now - this.lastCheckAt >= 1_000) {
        const mountPath = path.resolve(this.config.mountPath)
        const dbPath = path.resolve(this.config.dbPath)
        if (!this.probe.exists(mountPath) || !this.probe.exists(dbPath)) fail('VOLUME_IDENTITY_LOST', 'mount or DB disappeared')
        const currentMount = this.probe.realpath(mountPath)
        const currentDb = this.probe.realpath(dbPath)
        if (currentMount !== this.knownMountRealpath || !contained(currentMount, currentDb)
          || this.probe.stat(currentMount).dev !== this.knownDevice
          || this.probe.stat(currentDb).dev !== this.knownDevice) {
          fail('VOLUME_IDENTITY_LOST', 'mount device or DB identity changed')
        }
      }
      this.lastCheckAt = now
      this.lastSuccessfulStorageCheck = new Date(now).toISOString()
    } catch (error) {
      this.markFatal(error)
      throw this.fatal
    }
  }

  classify(error: unknown): never {
    if (isStorageIoError(error)) {
      this.markFatal(error)
      throw this.fatal
    }
    throw error
  }

  markFatal(error: unknown): void {
    if (this.fatal) return
    this.fatal = error instanceof StorageUnavailableError ? error
      : new StorageUnavailableError('FATAL_STORAGE_IO', 'storage I/O failed; process must be restarted after recovery')
    for (const handler of this.fatalHandlers) {
      try { handler() } catch { /* best effort: never write to the disconnected DB */ }
    }
    const incidentDir = internalIncidentDir(this.config)
    try {
      fs.mkdirSync(incidentDir, { recursive: true, mode: 0o700 })
      fs.writeFileSync(storageFatalLatchPath(this.config), 'manual storage review required\n', { mode: 0o600 })
      const incident = {
        incidentId: randomUUID(), timestamp: new Date().toISOString(), process: process.title,
        pid: process.pid,
        jobType: this.operationContext?.jobType ?? this.config.jobType ?? process.env.STOCKBOARD_JOB_TYPE ?? 'web-or-unknown',
        jobId: this.operationContext?.jobId ?? null,
        dbPath: this.config.dbPath, expectedMount: this.config.mountPath,
        lastKnownMountStatus: this.lastCheckAt ? 'previously-mounted' : 'unknown',
        errorCode: this.fatal.storageCode, errorMessage: safeErrorMessage(error),
        sqliteCode: errorCode(error), lastSuccessfulStorageCheck: this.lastSuccessfulStorageCheck,
        actionTaken: 'FAILED_SAFE_NO_RETRY_NO_DB_WRITE',
      }
      fs.appendFileSync(path.join(incidentDir, 'incidents.ndjson'), `${JSON.stringify(incident)}\n`, { mode: 0o600 })
    } catch (logError) {
      console.error('[storage-guard] incident log unavailable on internal storage', safeErrorMessage(logError))
    }
  }
}

const globalForStorage = globalThis as typeof globalThis & { stockboardStorageGuards?: Map<string, ExternalStorageGuard> }

export function guardForDatabase(dbPath: string, jobType?: string): ExternalStorageGuard {
  const key = path.resolve(dbPath)
  globalForStorage.stockboardStorageGuards ??= new Map()
  let guard = globalForStorage.stockboardStorageGuards.get(key)
  if (!guard) {
    guard = new ExternalStorageGuard(configForDatabase(key, jobType))
    globalForStorage.stockboardStorageGuards.set(key, guard)
  }
  return guard
}

export function anyStorageFatal(): boolean {
  return [...(globalForStorage.stockboardStorageGuards?.values() ?? [])].some((guard) => guard.fatalError !== null)
}

export function assertConfiguredWritableStorage(dbPath: string, jobType?: string): ExternalStorageGuard {
  const guard = guardForDatabase(dbPath, jobType)
  guard.assertWritable(true)
  return guard
}
