import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PROBE_COMMAND_TIMEOUT_MS = 2_000

export type StorageFailureCode =
  | 'VOLUME_NOT_MOUNTED' | 'VOLUME_UUID_MISMATCH' | 'PROBE_FAILED' | 'DB_OUTSIDE_EXPECTED_VOLUME'
  | 'DB_NOT_FOUND' | 'VOLUME_READ_ONLY' | 'INSUFFICIENT_STORAGE'
  | 'MOUNT_IDENTITY_UNKNOWN' | 'VOLUME_IDENTITY_LOST' | 'FATAL_STORAGE_IO'

export type ProbeStage = 'MOUNT_TABLE' | 'DISKUTIL_INFO' | 'PLUTIL_PARSE' | 'STATFS'
  | 'REALPATH' | 'STAT_DEVICE' | 'UUID_COMPARE'
export type ProbeDiagnostics = {
  probeStage: ProbeStage
  startedAt: string
  durationMs: number
  exitStatus: number | null
  signal: string | null
  stderr: string | null
}

export class StorageUnavailableError extends Error {
  readonly status = 503
  constructor(readonly storageCode: StorageFailureCode, message: string, readonly probeDiagnostics?: ProbeDiagnostics) {
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
  mountPresent?(mountPath: string): boolean
  realpath(filePath: string): string
  stat(filePath: string): { dev: number | bigint; isFile(): boolean; isDirectory(): boolean }
  exists(filePath: string): boolean
}

function probeFailure(stage: ProbeStage, started: number, error: unknown): StorageUnavailableError {
  const failure = error as { status?: number | null; signal?: string | null; stderr?: Buffer | string }
  const fatalIo = isStorageIoError(error)
  return new StorageUnavailableError(fatalIo ? 'FATAL_STORAGE_IO' : 'PROBE_FAILED',
    `STORAGE_UNAVAILABLE: ${stage} probe failed`, {
    probeStage: stage, startedAt: new Date(started).toISOString(), durationMs: Date.now() - started,
    exitStatus: typeof failure?.status === 'number' ? failure.status : null,
    signal: typeof failure?.signal === 'string' ? failure.signal : null,
    stderr: failure?.stderr ? safeErrorMessage(String(failure.stderr)).slice(0, 160) : null,
  })
}

export function mountTableContains(mounts: string, mountPath: string): boolean {
  return mounts.split('\n').some((line) => {
    const start = line.indexOf(' on ')
    const end = line.lastIndexOf(' (')
    return start >= 0 && end > start && line.slice(start + 4, end).replace(/\\040/g, ' ') === mountPath
  })
}

function mountedAt(mountPath: string): boolean {
  const started = Date.now()
  try {
    return mountTableContains(
      execFileSync('/sbin/mount', { encoding: 'utf8', timeout: PROBE_COMMAND_TIMEOUT_MS, maxBuffer: 2_000_000 }), mountPath)
  } catch (error) {
    throw probeFailure('MOUNT_TABLE', started, error)
  }
}

function classifyMountProbeFailure(mountPath: string, original?: StorageUnavailableError): never {
  if (original?.storageCode === 'FATAL_STORAGE_IO') throw original
  if (!mountedAt(mountPath)) {
    throw new StorageUnavailableError('VOLUME_NOT_MOUNTED', 'STORAGE_UNAVAILABLE: expected volume is absent from mount table')
  }
  throw original ?? new StorageUnavailableError('PROBE_FAILED', 'STORAGE_UNAVAILABLE: volume identity probe failed while mount remains listed')
}

function diskutilVolume(mountPath: string): VolumeIdentity | null {
  if (process.platform !== 'darwin') return null
  let plist: Buffer
  let info: Record<string, unknown>
  let started = Date.now()
  try {
    plist = execFileSync('/usr/sbin/diskutil', ['info', '-plist', mountPath], {
      timeout: PROBE_COMMAND_TIMEOUT_MS, maxBuffer: 2_000_000,
    })
  } catch (error) { classifyMountProbeFailure(mountPath, probeFailure('DISKUTIL_INFO', started, error)) }
  started = Date.now()
  try {
    info = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], {
      input: plist, encoding: 'utf8', timeout: PROBE_COMMAND_TIMEOUT_MS,
    })) as Record<string, unknown>
  } catch (error) { classifyMountProbeFailure(mountPath, probeFailure('PLUTIL_PARSE', started, error)) }
  if (info.MountPoint !== mountPath) classifyMountProbeFailure(mountPath,
    probeFailure('UUID_COMPARE', Date.now(), new Error('mount point mismatch')))
  started = Date.now()
  let stats: { bavail: bigint; bsize: bigint; blocks: bigint }
  try { stats = fs.statfsSync(mountPath, { bigint: true }) }
  catch (error) {
    if (isStorageIoError(error)) throw new StorageUnavailableError('FATAL_STORAGE_IO', 'STORAGE_UNAVAILABLE: filesystem I/O failed')
    classifyMountProbeFailure(mountPath, probeFailure('STATFS', started, error))
  }
  return {
    mountPoint: String(info.MountPoint),
    uuid: typeof info.VolumeUUID === 'string' ? info.VolumeUUID : null,
    filesystem: typeof info.FilesystemType === 'string' ? info.FilesystemType : null,
    writable: info.WritableVolume === true,
    freeBytes: Number(stats.bavail * stats.bsize),
    totalBytes: Number(stats.blocks * stats.bsize),
  }
}

export const systemStorageProbe: StorageProbe = {
  volume: diskutilVolume,
  mountPresent: mountedAt,
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

function fail(code: StorageFailureCode, detail: string, stage?: ProbeStage): never {
  throw new StorageUnavailableError(code, `STORAGE_UNAVAILABLE: ${detail}`, stage ? {
    probeStage: stage, startedAt: new Date().toISOString(), durationMs: 0,
    exitStatus: null, signal: null, stderr: null,
  } : undefined)
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
  if (!probe.exists(mountPath)) {
    if (probe.mountPresent && probe.mountPresent(mountPath)) fail('VOLUME_IDENTITY_LOST', 'expected mount path disappeared', 'REALPATH')
    fail('VOLUME_NOT_MOUNTED', 'expected mount is missing', 'MOUNT_TABLE')
  }
  if (probe.mountPresent && !probe.mountPresent(mountPath)) fail('VOLUME_NOT_MOUNTED', 'expected volume is absent from mount table', 'MOUNT_TABLE')
  const volume = probe.volume(mountPath)
  if (!volume || volume.mountPoint !== mountPath) fail('VOLUME_NOT_MOUNTED', 'expected volume is not mounted at this path')
  if (!volume.uuid) fail('MOUNT_IDENTITY_UNKNOWN', 'mounted volume UUID is unavailable')
  if (volume.uuid.toUpperCase() !== config.volumeUuid.toUpperCase()) fail('VOLUME_UUID_MISMATCH', 'mounted volume UUID differs', 'UUID_COMPARE')
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
  if (probe.stat(realAncestor).dev !== mountDevice) fail('DB_OUTSIDE_EXPECTED_VOLUME', 'target parent is on another device', 'STAT_DEVICE')
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
    fail('DB_OUTSIDE_EXPECTED_VOLUME', 'DB is not a file on the expected device', 'STAT_DEVICE')
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
  if (error instanceof StorageUnavailableError) return error.storageCode !== 'PROBE_FAILED'
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

function uncertainMarkers(config: GuardConfig): string[] {
  const directory = internalIncidentDir(config)
  try {
    return fs.readdirSync(/* turbopackIgnore: true */ directory).filter((name) => /^PROBE_UNCERTAIN-\d+$/.test(name))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

export function hasStorageUncertainMarker(config: GuardConfig): boolean {
  return uncertainMarkers(config).length > 0
}

export class ExternalStorageGuard {
  private fatal: StorageUnavailableError | null = null
  private uncertain = false
  private lastCheckAt = 0
  private lastIdentityAt = 0
  private lastSuccessfulStorageCheck: string | null = null
  private knownDevice: number | bigint | null = null
  private knownMountRealpath: string | null = null
  private readonly fatalHandlers = new Set<() => void>()
  private operationContext: { jobType: string; jobId: string } | null = null
  private fullProbeDurations: number[] = []
  private lightweightProbeDurations: number[] = []
  private fullProbeCount = 0
  private lightweightProbeCount = 0
  private recoveredTransientCount = 0
  private readonly uncertainMarker: string

  constructor(readonly config: GuardConfig, private readonly probe: StorageProbe = systemStorageProbe,
    private readonly options: { wait?: (ms: number) => void; fullIntervalMs?: number } = {}) {
    this.uncertainMarker = path.join(internalIncidentDir(config), `PROBE_UNCERTAIN-${process.pid}`)
  }

  get status(): 'HEALTHY' | 'PROBE_UNCERTAIN' | 'FAILED_SAFE' | 'UNCHECKED' {
    return this.fatal ? 'FAILED_SAFE' : this.uncertain ? 'PROBE_UNCERTAIN' : this.lastCheckAt ? 'HEALTHY' : 'UNCHECKED'
  }

  get fatalError(): StorageUnavailableError | null { return this.fatal }
  get probeMetrics() {
    return {
      fullCount: this.fullProbeCount,
      lightweightCount: this.lightweightProbeCount,
      recoveredTransientCount: this.recoveredTransientCount,
      fullDurationsMs: [...this.fullProbeDurations],
      lightweightDurationsMs: [...this.lightweightProbeDurations],
    }
  }

  setFatalHandler(handler: () => void): void { this.fatalHandlers.add(handler) }
  setOperationContext(jobType: string, jobId: string): void { this.operationContext = { jobType, jobId } }
  clearOperationContext(jobId: string): void {
    if (this.operationContext?.jobId === jobId) this.operationContext = null
  }

  private recordDuration(kind: 'full' | 'lightweight', duration: number): void {
    const samples = kind === 'full' ? this.fullProbeDurations : this.lightweightProbeDurations
    if (kind === 'full') this.fullProbeCount++
    else this.lightweightProbeCount++
    samples.push(duration)
    if (samples.length > 256) samples.shift()
  }

  private fullIdentity(): void {
    const started = Date.now()
    try {
      inspectStorage(this.config, this.probe)
      const realMount = this.probe.realpath(path.resolve(this.config.mountPath))
      const device = this.probe.stat(realMount).dev
      if ((this.knownMountRealpath && realMount !== this.knownMountRealpath)
        || (this.knownDevice !== null && device !== this.knownDevice)) {
        fail('VOLUME_IDENTITY_LOST', 'mount identity changed between certifications', 'STAT_DEVICE')
      }
      this.knownMountRealpath = realMount
      this.knownDevice = device
      this.lastIdentityAt = Date.now()
    } finally { this.recordDuration('full', Date.now() - started) }
  }

  private lightweightIdentity(includeMountTable = false): void {
    const started = Date.now()
    try {
      const mountPath = path.resolve(this.config.mountPath)
      const dbPath = path.resolve(this.config.dbPath)
      if (includeMountTable && this.probe.mountPresent && !this.probe.mountPresent(mountPath)) {
        fail('VOLUME_NOT_MOUNTED', 'expected volume is absent from mount table', 'MOUNT_TABLE')
      }
      if (!this.probe.exists(mountPath) || !this.probe.exists(dbPath)) {
        fail('VOLUME_IDENTITY_LOST', 'mount or DB disappeared', 'REALPATH')
      }
      const currentMount = this.probe.realpath(mountPath)
      const currentDb = this.probe.realpath(dbPath)
      const mountStat = this.probe.stat(currentMount)
      const dbStat = this.probe.stat(currentDb)
      if (!mountStat.isDirectory() || !dbStat.isFile() || !contained(currentMount, currentDb)
        || mountStat.dev !== dbStat.dev || (this.knownMountRealpath && currentMount !== this.knownMountRealpath)
        || (this.knownDevice !== null && mountStat.dev !== this.knownDevice)) {
        fail('VOLUME_IDENTITY_LOST', 'mount device or DB identity changed', 'STAT_DEVICE')
      }
      for (const suffix of ['-wal', '-shm']) {
        const companion = `${dbPath}${suffix}`
        if (!this.probe.exists(companion)) continue
        const realCompanion = this.probe.realpath(companion)
        if (!contained(currentMount, realCompanion) || this.probe.stat(realCompanion).dev !== mountStat.dev) {
          fail('VOLUME_IDENTITY_LOST', `${suffix} identity changed`, 'STAT_DEVICE')
        }
      }
    } finally { this.recordDuration('lightweight', Date.now() - started) }
  }

  private recordProbeEvent(event: 'PROBE_UNCERTAIN' | 'TRANSIENT_PROBE_FAILURE_RECOVERED', error: StorageUnavailableError): void {
    try {
      const directory = internalIncidentDir(this.config)
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
      fs.appendFileSync(path.join(directory, 'probe-events.ndjson'), `${JSON.stringify({
        event, timestamp: new Date().toISOString(), process: process.title, pid: process.pid,
        jobType: this.operationContext?.jobType ?? this.config.jobType ?? 'web-or-unknown',
        probe: error.probeDiagnostics ?? null,
      })}\n`, { mode: 0o600 })
    } catch (logError) {
      console.error('[storage-guard] probe event log unavailable', safeErrorMessage(logError))
    }
  }

  private confirmProbe(initial: StorageUnavailableError): void {
    this.uncertain = true
    try {
      fs.mkdirSync(internalIncidentDir(this.config), { recursive: true, mode: 0o700 })
      fs.writeFileSync(this.uncertainMarker, `${new Date().toISOString()}\n`, { flag: 'wx', mode: 0o600 })
    } catch (error) {
      this.markFatal(error)
      throw this.fatal
    }
    this.recordProbeEvent('PROBE_UNCERTAIN', initial)
    for (const delayMs of [1_000, 2_000]) {
      try {
        this.lightweightIdentity(true)
        ;(this.options.wait ?? ((ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }))(delayMs)
        this.lightweightIdentity(true)
        this.fullIdentity()
        fs.unlinkSync(this.uncertainMarker)
        this.uncertain = false
        this.recoveredTransientCount++
        this.recordProbeEvent('TRANSIENT_PROBE_FAILURE_RECOVERED', initial)
        return
      } catch (error) {
        if (!(error instanceof StorageUnavailableError) || error.storageCode !== 'PROBE_FAILED') {
          this.markFatal(error)
          throw this.fatal
        }
      }
    }
    this.markFatal(initial)
    throw this.fatal
  }

  assertWritable(forceIdentity = false): void {
    if (this.fatal) throw this.fatal
    if (this.uncertain) throw new StorageUnavailableError('PROBE_FAILED', 'storage identity confirmation is in progress')
    if (hasStorageFatalLatch(this.config)) {
      this.fatal = new StorageUnavailableError('FATAL_STORAGE_IO', 'storage incident requires manual review before restarting writers')
      throw this.fatal
    }
    const markers = uncertainMarkers(this.config)
    if (markers.length) {
      for (const marker of markers) {
        const pid = Number(marker.slice('PROBE_UNCERTAIN-'.length))
        try { process.kill(pid, 0) }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
            this.markFatal(new StorageUnavailableError('FATAL_STORAGE_IO', 'probe owner exited before confirmation'))
            throw this.fatal
          }
        }
      }
      throw new StorageUnavailableError('PROBE_FAILED', 'storage identity confirmation is in progress')
    }
    const now = Date.now()
    try {
      if (forceIdentity || now - this.lastIdentityAt >= (this.options.fullIntervalMs ?? 300_000) || !this.lastIdentityAt) {
        this.fullIdentity()
      } else if (now - this.lastCheckAt >= 1_000) {
        this.lightweightIdentity()
      }
      this.lastCheckAt = Date.now()
      this.lastSuccessfulStorageCheck = new Date(this.lastCheckAt).toISOString()
    } catch (error) {
      if (error instanceof StorageUnavailableError && error.storageCode === 'PROBE_FAILED') {
        this.confirmProbe(error)
        this.lastCheckAt = Date.now()
        this.lastSuccessfulStorageCheck = new Date(this.lastCheckAt).toISOString()
        return
      }
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
    this.uncertain = false
    this.fatal = error instanceof StorageUnavailableError ? error
      : new StorageUnavailableError('FATAL_STORAGE_IO', 'storage I/O failed; process must be restarted after recovery')
    for (const handler of this.fatalHandlers) {
      try { handler() } catch { /* best effort: never write to the disconnected DB */ }
    }
    const incidentDir = internalIncidentDir(this.config)
    let latchCreated = false
    try {
      fs.mkdirSync(incidentDir, { recursive: true, mode: 0o700 })
      fs.writeFileSync(storageFatalLatchPath(this.config), 'manual storage review required\n', { mode: 0o600 })
      latchCreated = true
      const incident = {
        incidentId: randomUUID(), timestamp: new Date().toISOString(), process: process.title,
        pid: process.pid,
        jobType: this.operationContext?.jobType ?? this.config.jobType ?? process.env.STOCKBOARD_JOB_TYPE ?? 'web-or-unknown',
        jobId: this.operationContext?.jobId ?? null,
        dbPath: this.config.dbPath, expectedMount: this.config.mountPath,
        lastKnownMountStatus: this.lastCheckAt ? 'previously-mounted' : 'unknown',
        errorCode: this.fatal.storageCode, errorMessage: safeErrorMessage(error),
        sqliteCode: errorCode(error), lastSuccessfulStorageCheck: this.lastSuccessfulStorageCheck,
        probe: error instanceof StorageUnavailableError ? error.probeDiagnostics ?? null : null,
        actionTaken: 'FAILED_SAFE_NO_RETRY_NO_DB_WRITE',
      }
      fs.appendFileSync(path.join(incidentDir, 'incidents.ndjson'), `${JSON.stringify(incident)}\n`, { mode: 0o600 })
    } catch (logError) {
      console.error('[storage-guard] incident log unavailable on internal storage', safeErrorMessage(logError))
    }
    if (latchCreated) {
      try { fs.unlinkSync(this.uncertainMarker) }
      catch (removeError) {
        if ((removeError as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.error('[storage-guard] uncertain marker could not be removed', safeErrorMessage(removeError))
        }
      }
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

export function anyStorageUncertain(): boolean {
  return [...(globalForStorage.stockboardStorageGuards?.values() ?? [])].some((guard) => guard.status === 'PROBE_UNCERTAIN')
}

export function assertConfiguredWritableStorage(dbPath: string, jobType?: string): ExternalStorageGuard {
  const guard = guardForDatabase(dbPath, jobType)
  guard.assertWritable(true)
  return guard
}
