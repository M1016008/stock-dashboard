import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PROBE_COMMAND_TIMEOUT_MS = 8_000
const PROBE_CERTIFICATION_CACHE_MS = 2_000
const PROBE_COORDINATION_WAIT_MS = 20_000
const PROBE_COORDINATION_POLL_MS = 50
const PROBE_COORDINATION_STALE_MS = 30_000
const PROBE_COORDINATION_VERSION = 2

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

type ConfirmationAttempt = {
  attempt: number
  inProcessIdentity: boolean
  uuidVerified: boolean
  probe: ProbeDiagnostics | null
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

type CertifiedVolumeIdentity = {
  version: 2
  resultVersion: 2
  volumeKey: string
  identityDigest: string
  mountPath: string
  mountDevice: string
  certifiedAt: number
  volume: VolumeIdentity
}

type ProbeLockOwner = {
  version: 2
  requestId: string
  volumeKey: string
  pid: number
  processStartIdentity: string
  acquiredAt: number
  leaseExpiresAt: number
}

type ProbeLifecycleEvent = {
  event: string
  timestamp: string
  requestId: string
  volumeKey: string
  callerPid: number
  callerRole: string
  callerStartIdentity: string
  [key: string]: unknown
}

export type ProbeCertificationContext = {
  requestId: string
  volumeKey: string
  recordSubprocess: (details: {
    stage: ProbeStage
    childPid: number | null
    startedAt: string
    endedAt: string
    durationMs: number
    exitStatus: number | null
    signal: string | null
    externalProbeSpawned: boolean
  }) => void
}

export type ProbeCoordinationOptions = {
  coordinationDir?: string
  cacheTtlMs?: number
  waitMs?: number
  pollMs?: number
  leaseMs?: number
  callerRole?: string
  wait?: (ms: number) => void
}

const globalForProbeCoordination = globalThis as typeof globalThis & {
  stockboardCertifiedVolumes?: Map<string, CertifiedVolumeIdentity>
}

function probeCoordinationDirectory(configured?: string): string {
  const fallback = path.join(os.homedir(), 'Library', 'Application Support', 'StockBoard', 'storage-incidents')
  const candidate = path.resolve(/* turbopackIgnore: true */ configured?.trim() || process.env.STOCK_DATA_INCIDENT_DIR?.trim() || fallback)
  return candidate.startsWith('/Volumes/') ? fallback : candidate
}

function canonicalMountPath(mountPath: string): string {
  const resolved = path.resolve(mountPath)
  try { return fs.realpathSync(resolved) }
  catch { return resolved }
}

function volumeCoordinationKey(mountPath: string): string {
  return createHash('sha256').update(canonicalMountPath(mountPath)).digest('hex').slice(0, 24)
}

export function storageProbeCoordinationPaths(mountPath: string, coordinationDir?: string): {
  cachePath: string
  lockPath: string
  telemetryPath: string
} {
  const key = volumeCoordinationKey(mountPath)
  const directory = probeCoordinationDirectory(coordinationDir)
  return {
    cachePath: path.join(directory, `volume-certification-${key}.json`),
    lockPath: path.join(directory, `volume-certification-${key}.lock`),
    telemetryPath: path.join(directory, `volume-certification-${key}.ndjson`),
  }
}

function mountDevice(mountPath: string): string | null {
  try { return String(fs.statSync(fs.realpathSync(mountPath)).dev) }
  catch { return null }
}

function processStartIdentity(pid: number): string | null {
  try {
    const started = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8', timeout: PROBE_COMMAND_TIMEOUT_MS, maxBuffer: 16_384,
    }).trim()
    return started ? createHash('sha256').update(`${pid}:${started}`).digest('hex').slice(0, 24) : null
  } catch { return null }
}

function callerRole(configured?: string): string {
  const role = configured?.trim()
    || process.env.STOCKBOARD_PROCESS_ROLE?.trim()
    || process.env.STOCK_DATA_JOB_TYPE?.trim()
    || path.basename(process.argv[1] || process.title || 'unknown')
  return role.replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 80) || 'unknown'
}

function appendProbeTelemetry(telemetryPath: string, event: ProbeLifecycleEvent): void {
  try {
    fs.mkdirSync(path.dirname(telemetryPath), { recursive: true, mode: 0o700 })
    const descriptor = fs.openSync(telemetryPath, 'a', 0o600)
    try { fs.writeSync(descriptor, `${JSON.stringify(event)}\n`) }
    finally { fs.closeSync(descriptor) }
  } catch {
    // Coordination safety must not depend on optional diagnostic persistence.
  }
}

function identityDigest(volume: VolumeIdentity, mountDevice: string): string {
  return createHash('sha256').update(JSON.stringify({
    mountPoint: volume.mountPoint,
    uuid: volume.uuid,
    filesystem: volume.filesystem,
    mountDevice,
  })).digest('hex')
}

function readCertifiedVolume(
  cachePath: string,
  mountPath: string,
  volumeKey: string,
  ttlMs: number,
): CertifiedVolumeIdentity | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as CertifiedVolumeIdentity
    const age = Date.now() - Number(parsed.certifiedAt)
    const device = mountDevice(mountPath)
    if (parsed.version !== PROBE_COORDINATION_VERSION || parsed.resultVersion !== PROBE_COORDINATION_VERSION
      || parsed.volumeKey !== volumeKey || parsed.mountPath !== canonicalMountPath(mountPath)
      || age < 0 || age >= ttlMs || !device || parsed.mountDevice !== device) return null
    if (parsed.identityDigest !== identityDigest(parsed.volume, device)) return null
    return parsed
  } catch { return null }
}

function writeCertifiedVolume(cachePath: string, certified: CertifiedVolumeIdentity): void {
  const temporary = `${cachePath}.${process.pid}.${randomUUID()}.tmp`
  const descriptor = fs.openSync(temporary, 'wx', 0o600)
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(certified)}\n`)
    fs.fsyncSync(descriptor)
  } finally { fs.closeSync(descriptor) }
  fs.renameSync(temporary, cachePath)
}

function readLockOwner(lockPath: string): ProbeLockOwner | null {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8')) as ProbeLockOwner
  } catch { return null }
}

function lockOwnerAlive(lockPath: string): boolean {
  const lock = readLockOwner(lockPath)
  if (!lock || !Number.isInteger(lock.pid) || Number(lock.pid) <= 0) return false
  try { process.kill(Number(lock.pid), 0) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    return true
  }
  if (lock.version !== PROBE_COORDINATION_VERSION || !lock.processStartIdentity) return true
  const observedStartIdentity = processStartIdentity(lock.pid)
  return observedStartIdentity === null || observedStartIdentity === lock.processStartIdentity
}

export function certifyVolumeIdentitySingleFlight(
  mountPath: string,
  certify: (context: ProbeCertificationContext) => VolumeIdentity,
  options: ProbeCoordinationOptions = {},
): VolumeIdentity {
  const resolvedMount = canonicalMountPath(mountPath)
  const volumeKey = volumeCoordinationKey(resolvedMount)
  const requestId = randomUUID()
  const role = callerRole(options.callerRole)
  const startIdentity = processStartIdentity(process.pid)
    ?? createHash('sha256').update(`${process.pid}:${process.uptime()}`).digest('hex').slice(0, 24)
  const ttlMs = options.cacheTtlMs ?? PROBE_CERTIFICATION_CACHE_MS
  const waitMs = options.waitMs ?? PROBE_COORDINATION_WAIT_MS
  const pollMs = options.pollMs ?? PROBE_COORDINATION_POLL_MS
  const leaseMs = Math.max(options.leaseMs ?? PROBE_COORDINATION_STALE_MS, waitMs, PROBE_COMMAND_TIMEOUT_MS * 2)
  const wait = options.wait ?? ((ms: number) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  })
  const paths = storageProbeCoordinationPaths(resolvedMount, options.coordinationDir)
  const started = Date.now()
  const baseEvent = {
    requestId, volumeKey, callerPid: process.pid, callerRole: role, callerStartIdentity: startIdentity,
  }
  const record = (event: string, details: Record<string, unknown> = {}): void => appendProbeTelemetry(
    paths.telemetryPath,
    { event, timestamp: new Date().toISOString(), ...baseEvent, ...details },
  )
  record('REQUEST', { lockRequestedAt: new Date(started).toISOString(), cacheTtlMs: ttlMs })
  globalForProbeCoordination.stockboardCertifiedVolumes ??= new Map()
  let waitedForOwner = false
  let cacheMissRecorded = false

  for (;;) {
    const processCached = globalForProbeCoordination.stockboardCertifiedVolumes.get(volumeKey)
    const device = mountDevice(resolvedMount)
    if (processCached && Date.now() - processCached.certifiedAt < ttlMs
      && device && processCached.mountDevice === device) {
      record('CACHE_HIT', { cacheScope: 'process', cacheAgeMs: Date.now() - processCached.certifiedAt })
      if (waitedForOwner) record('JOINED_RESULT', { cacheAgeMs: Date.now() - processCached.certifiedAt })
      return processCached.volume
    }
    const shared = readCertifiedVolume(paths.cachePath, resolvedMount, volumeKey, ttlMs)
    if (shared) {
      globalForProbeCoordination.stockboardCertifiedVolumes.set(volumeKey, shared)
      record('CACHE_HIT', { cacheScope: 'shared', cacheAgeMs: Date.now() - shared.certifiedAt })
      if (waitedForOwner) record('JOINED_RESULT', { cacheAgeMs: Date.now() - shared.certifiedAt })
      return shared.volume
    }
    if (!cacheMissRecorded) {
      record('CACHE_MISS', { cacheScope: 'process-and-shared' })
      cacheMissRecorded = true
    }

    fs.mkdirSync(path.dirname(paths.lockPath), { recursive: true, mode: 0o700 })
    let descriptor: number | null = null
    const acquiredAt = Date.now()
    const owner: ProbeLockOwner = {
      version: PROBE_COORDINATION_VERSION,
      requestId,
      volumeKey,
      pid: process.pid,
      processStartIdentity: startIdentity,
      acquiredAt,
      leaseExpiresAt: acquiredAt + leaseMs,
    }
    try {
      descriptor = fs.openSync(/* turbopackIgnore: true */ paths.lockPath, 'wx', 0o600)
      fs.writeFileSync(descriptor, `${JSON.stringify(owner)}\n`)
      fs.fsyncSync(descriptor)
      record('LOCK_ACQUIRED', {
        lockAcquiredAt: new Date(acquiredAt).toISOString(), lockWaitMs: acquiredAt - started,
        lockOwnerPid: owner.pid, lockOwnerStartIdentity: owner.processStartIdentity,
        leaseExpiresAt: new Date(owner.leaseExpiresAt).toISOString(),
      })
    } catch (error) {
      if (descriptor !== null) {
        fs.closeSync(descriptor)
        try { fs.unlinkSync(paths.lockPath) } catch { /* best effort; stale-lock handling remains fail closed */ }
      }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw probeFailure('DISKUTIL_INFO', started, error)
      const currentOwner = readLockOwner(paths.lockPath)
      if (!waitedForOwner) {
        record('LOCK_WAIT', {
          lockOwnerPid: currentOwner?.pid ?? null,
          lockOwnerStartIdentity: currentOwner?.processStartIdentity ?? null,
          leaseExpiresAt: currentOwner?.leaseExpiresAt ? new Date(currentOwner.leaseExpiresAt).toISOString() : null,
        })
      }
      waitedForOwner = true
      try {
        const lockAge = Date.now() - fs.statSync(/* turbopackIgnore: true */ paths.lockPath).mtimeMs
        const leaseExpired = currentOwner?.version === PROBE_COORDINATION_VERSION
          ? Date.now() > Number(currentOwner.leaseExpiresAt)
          : lockAge > leaseMs
        const stale = lockAge > leaseMs && leaseExpired
        if (stale && !lockOwnerAlive(paths.lockPath)) {
          fs.unlinkSync(paths.lockPath)
          record('STALE_LOCK_RECOVERED', {
            staleOwnerPid: currentOwner?.pid ?? null,
            staleOwnerStartIdentity: currentOwner?.processStartIdentity ?? null,
            lockAgeMs: lockAge,
          })
          continue
        }
      } catch (lockError) {
        if ((lockError as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw probeFailure('DISKUTIL_INFO', started, lockError)
      }
      if (Date.now() - started >= waitMs) {
        throw new StorageUnavailableError('PROBE_FAILED', 'STORAGE_UNAVAILABLE: serialized identity probe wait timed out', {
          probeStage: 'DISKUTIL_INFO', startedAt: new Date(started).toISOString(), durationMs: Date.now() - started,
          exitStatus: null, signal: null, stderr: null,
        })
      }
      wait(pollMs)
      continue
    }

    try {
      const cachedAfterLock = readCertifiedVolume(paths.cachePath, resolvedMount, volumeKey, ttlMs)
      if (cachedAfterLock) {
        globalForProbeCoordination.stockboardCertifiedVolumes.set(volumeKey, cachedAfterLock)
        record('JOINED_RESULT', { cacheAgeMs: Date.now() - cachedAfterLock.certifiedAt })
        return cachedAfterLock.volume
      }
      const probeStarted = Date.now()
      record('FULL_PROBE_START', { externalProbeSpawned: false })
      let volume: VolumeIdentity
      let externalProbeSpawned = false
      try {
        volume = certify({
          requestId,
          volumeKey,
          recordSubprocess: (details) => {
            if (details.externalProbeSpawned) externalProbeSpawned = true
            record('SUBPROCESS_END', details)
          },
        })
      } catch (error) {
        const unavailable = error instanceof StorageUnavailableError ? error : null
        record('FULL_PROBE_END', {
          status: 'FAILED', durationMs: Date.now() - probeStarted,
          stage: unavailable?.probeDiagnostics?.probeStage ?? null,
          exitStatus: unavailable?.probeDiagnostics?.exitStatus ?? null,
          signal: unavailable?.probeDiagnostics?.signal ?? null,
          externalProbeSpawned,
        })
        throw error
      }
      const currentDevice = mountDevice(resolvedMount)
      if (!currentDevice) fail('VOLUME_NOT_MOUNTED', 'expected volume disappeared during certification', 'STAT_DEVICE')
      const certified: CertifiedVolumeIdentity = {
        version: PROBE_COORDINATION_VERSION,
        resultVersion: PROBE_COORDINATION_VERSION,
        volumeKey,
        identityDigest: identityDigest(volume, currentDevice),
        mountPath: resolvedMount,
        mountDevice: currentDevice,
        certifiedAt: Date.now(),
        volume,
      }
      writeCertifiedVolume(paths.cachePath, certified)
      globalForProbeCoordination.stockboardCertifiedVolumes.set(volumeKey, certified)
      record('FULL_PROBE_END', {
        status: 'VERIFIED', durationMs: Date.now() - probeStarted,
        resultVersion: certified.resultVersion, identityDigest: certified.identityDigest,
        externalProbeSpawned,
      })
      return volume
    } finally {
      if (descriptor !== null) fs.closeSync(descriptor)
      try {
        const currentOwner = readLockOwner(paths.lockPath)
        if (currentOwner?.requestId === requestId) fs.unlinkSync(paths.lockPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      } finally {
        record('LOCK_RELEASED', { lockOwnerPid: process.pid })
      }
    }
  }
}

function runDiskutilVolume(mountPath: string, context: ProbeCertificationContext): VolumeIdentity {
  let plist: Buffer
  let info: Record<string, unknown>
  let started = Date.now()
  try {
    const result = spawnSync('/usr/sbin/diskutil', ['info', '-plist', mountPath], {
      timeout: PROBE_COMMAND_TIMEOUT_MS, maxBuffer: 2_000_000,
    })
    context.recordSubprocess({
      stage: 'DISKUTIL_INFO', childPid: result.pid ?? null,
      startedAt: new Date(started).toISOString(), endedAt: new Date().toISOString(),
      durationMs: Date.now() - started, exitStatus: result.status,
      signal: result.signal, externalProbeSpawned: true,
    })
    if (result.error || result.status !== 0) {
      throw Object.assign(result.error ?? new Error('diskutil exited unsuccessfully'), {
        status: result.status, signal: result.signal, stderr: result.stderr,
      })
    }
    plist = result.stdout
  } catch (error) { classifyMountProbeFailure(mountPath, probeFailure('DISKUTIL_INFO', started, error)) }
  started = Date.now()
  try {
    const result = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], {
      input: plist, encoding: 'utf8', timeout: PROBE_COMMAND_TIMEOUT_MS,
    })
    context.recordSubprocess({
      stage: 'PLUTIL_PARSE', childPid: result.pid ?? null,
      startedAt: new Date(started).toISOString(), endedAt: new Date().toISOString(),
      durationMs: Date.now() - started, exitStatus: result.status,
      signal: result.signal, externalProbeSpawned: false,
    })
    if (result.error || result.status !== 0) {
      throw Object.assign(result.error ?? new Error('plutil exited unsuccessfully'), {
        status: result.status, signal: result.signal, stderr: result.stderr,
      })
    }
    info = JSON.parse(result.stdout) as Record<string, unknown>
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

function diskutilVolume(mountPath: string): VolumeIdentity | null {
  if (process.platform !== 'darwin') return null
  return certifyVolumeIdentitySingleFlight(mountPath, (context) => runDiskutilVolume(mountPath, context))
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

type IdentityRequirement = 'REQUIRED_WRITABLE' | 'OPTIONAL_READ'

function verifiedVolume(config: GuardConfig, probe: StorageProbe, requirement: IdentityRequirement = 'REQUIRED_WRITABLE'): {
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
  if (requirement === 'REQUIRED_WRITABLE') {
    if (!volume.writable) fail('VOLUME_READ_ONLY', 'mounted volume is read-only')
    if (volume.freeBytes < config.minFreeBytes || volume.freeBytes / Math.max(volume.totalBytes, 1) * 100 < config.minFreePercent) {
      fail('INSUFFICIENT_STORAGE', 'available capacity is below the configured threshold')
    }
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

// Optional read artifacts may be absent, but their configured location must
// still resolve to the expected mounted volume before absence is accepted.
export function inspectReadableVolumeIdentity(config: GuardConfig, probe: StorageProbe = systemStorageProbe): VolumeIdentity {
  const { mountPath, realMount, mountDevice, volume } = verifiedVolume(config, probe, 'OPTIONAL_READ')
  const target = path.resolve(config.dbPath)
  if (!contained(mountPath, target)) fail('DB_OUTSIDE_EXPECTED_VOLUME', 'target is outside expected mount')
  let ancestor = target
  while (!probe.exists(ancestor) && ancestor !== mountPath) ancestor = path.dirname(ancestor)
  const realAncestor = probe.realpath(ancestor)
  if (realAncestor !== realMount && !contained(realMount, realAncestor)) {
    fail('DB_OUTSIDE_EXPECTED_VOLUME', 'target parent resolves outside expected mount')
  }
  const ancestorStat = probe.stat(realAncestor)
  if (ancestorStat.dev !== mountDevice) fail('DB_OUTSIDE_EXPECTED_VOLUME', 'target parent is on another device', 'STAT_DEVICE')
  if (ancestor === target && !ancestorStat.isFile()) fail('DB_OUTSIDE_EXPECTED_VOLUME', 'existing target is not a file')
  if (ancestor !== target && !ancestorStat.isDirectory()) fail('DB_OUTSIDE_EXPECTED_VOLUME', 'target parent is not a directory')
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
    try {
      const realCompanion = probe.realpath(companion)
      if (!contained(realMount, realCompanion) || probe.stat(realCompanion).dev !== mountDevice) {
        fail('DB_OUTSIDE_EXPECTED_VOLUME', `${suffix} is outside expected volume`)
      }
    } catch (error) {
      if (errorCode(error) !== 'ENOENT' || probe.exists(companion)) throw error
      throw new StorageUnavailableError('PROBE_FAILED', `STORAGE_UNAVAILABLE: ${suffix} changed during identity probe`, {
        probeStage: 'REALPATH', startedAt: new Date().toISOString(), durationMs: 0,
        exitStatus: null, signal: null, stderr: null,
      })
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

function isOptionalReadVolumeFatal(error: unknown): boolean {
  if (error instanceof StorageUnavailableError) {
    return error.storageCode === 'VOLUME_NOT_MOUNTED'
      || error.storageCode === 'VOLUME_UUID_MISMATCH'
      || error.storageCode === 'MOUNT_IDENTITY_UNKNOWN'
      || error.storageCode === 'VOLUME_IDENTITY_LOST'
      || error.storageCode === 'FATAL_STORAGE_IO'
  }
  const code = errorCode(error)
  if (code && /^(SQLITE_IOERR(?:_\w+)?|EIO|ENODEV)$/.test(code)) return true
  const message = error instanceof Error ? error.message : ''
  return /\b(SQLITE_IOERR|EIO|ENODEV)\b|disk I\/O error/i.test(message)
}

function isRebuildableCacheVolumeFatal(error: unknown): boolean {
  if (error instanceof StorageUnavailableError) {
    return error.storageCode !== 'DB_NOT_FOUND' && error.storageCode !== 'PROBE_FAILED'
  }
  const code = errorCode(error)
  if (code && /^(SQLITE_IOERR(?:_\w+)?|SQLITE_READONLY(?:_\w+)?|SQLITE_FULL|EIO|ENODEV|EROFS|ENOSPC)$/.test(code)) return true
  const message = error instanceof Error ? error.message : ''
  return /\b(SQLITE_IOERR|SQLITE_READONLY|SQLITE_FULL|EIO|ENODEV|EROFS|ENOSPC)\b|disk I\/O error|database or disk is full|readonly database/i.test(message)
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
  private confirmationAttempts: ConfirmationAttempt[] = []
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

  private fullIdentity(requirement: IdentityRequirement = 'REQUIRED_WRITABLE'): void {
    const started = Date.now()
    try {
      if (requirement === 'OPTIONAL_READ') inspectReadableVolumeIdentity(this.config, this.probe)
      else inspectStorage(this.config, this.probe)
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

  private lightweightIdentity(includeMountTable = false, requirement: IdentityRequirement = 'REQUIRED_WRITABLE'): void {
    const started = Date.now()
    try {
      const mountPath = path.resolve(this.config.mountPath)
      const dbPath = path.resolve(this.config.dbPath)
      if (includeMountTable && this.probe.mountPresent && !this.probe.mountPresent(mountPath)) {
        fail('VOLUME_NOT_MOUNTED', 'expected volume is absent from mount table', 'MOUNT_TABLE')
      }
      if (!this.probe.exists(mountPath) || (requirement === 'REQUIRED_WRITABLE' && !this.probe.exists(dbPath))) {
        fail('VOLUME_IDENTITY_LOST', requirement === 'REQUIRED_WRITABLE' ? 'mount or DB disappeared' : 'mount disappeared', 'REALPATH')
      }
      const currentMount = this.probe.realpath(mountPath)
      const mountStat = this.probe.stat(currentMount)
      let currentTarget = dbPath
      while (!this.probe.exists(currentTarget) && currentTarget !== mountPath) currentTarget = path.dirname(currentTarget)
      const currentTargetRealpath = this.probe.realpath(currentTarget)
      const targetStat = this.probe.stat(currentTargetRealpath)
      if (!mountStat.isDirectory()
        || (requirement === 'REQUIRED_WRITABLE' ? !targetStat.isFile() : currentTarget === dbPath ? !targetStat.isFile() : !targetStat.isDirectory())
        || (currentTargetRealpath !== currentMount && !contained(currentMount, currentTargetRealpath))
        || mountStat.dev !== targetStat.dev || (this.knownMountRealpath && currentMount !== this.knownMountRealpath)
        || (this.knownDevice !== null && mountStat.dev !== this.knownDevice)) {
        fail('VOLUME_IDENTITY_LOST', 'mount device or target identity changed', 'STAT_DEVICE')
      }
      for (const suffix of requirement === 'REQUIRED_WRITABLE' ? ['-wal', '-shm'] : []) {
        const companion = `${dbPath}${suffix}`
        if (!this.probe.exists(companion)) continue
        try {
          const realCompanion = this.probe.realpath(companion)
          if (!contained(currentMount, realCompanion) || this.probe.stat(realCompanion).dev !== mountStat.dev) {
            fail('VOLUME_IDENTITY_LOST', `${suffix} identity changed`, 'STAT_DEVICE')
          }
        } catch (error) {
          if (errorCode(error) !== 'ENOENT' || this.probe.exists(companion)) throw error
          // SQLite may remove a companion after the existence check; certify the full UUID before proceeding.
          this.fullIdentity(requirement)
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

  private confirmProbe(initial: StorageUnavailableError, requirement: IdentityRequirement): void {
    this.uncertain = true
    this.confirmationAttempts = [{ attempt: 1, inProcessIdentity: false,
      uuidVerified: false, probe: initial.probeDiagnostics ?? null }]
    try {
      fs.mkdirSync(internalIncidentDir(this.config), { recursive: true, mode: 0o700 })
      fs.writeFileSync(this.uncertainMarker, `${new Date().toISOString()}\n`, { flag: 'wx', mode: 0o600 })
    } catch (error) {
      this.markFatal(error)
      throw this.fatal
    }
    this.recordProbeEvent('PROBE_UNCERTAIN', initial)
    for (const [index, delayMs] of [1_000, 2_000, 4_000].entries()) {
      let inProcessIdentity = false
      try {
        this.lightweightIdentity(false, requirement)
        inProcessIdentity = true
        ;(this.options.wait ?? ((ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }))(delayMs)
        this.lightweightIdentity(false, requirement)
        this.fullIdentity(requirement)
        this.confirmationAttempts.push({ attempt: index + 2, inProcessIdentity,
          uuidVerified: true, probe: null })
        fs.unlinkSync(this.uncertainMarker)
        this.uncertain = false
        this.recoveredTransientCount++
        this.recordProbeEvent('TRANSIENT_PROBE_FAILURE_RECOVERED', initial)
        this.confirmationAttempts = []
        return
      } catch (error) {
        this.confirmationAttempts.push({ attempt: index + 2, inProcessIdentity,
          uuidVerified: false, probe: error instanceof StorageUnavailableError ? error.probeDiagnostics ?? null : null })
        if (!(error instanceof StorageUnavailableError) || error.storageCode !== 'PROBE_FAILED') {
          this.markFatal(error)
          throw this.fatal
        }
      }
    }
    this.markFatal(initial)
    throw this.fatal
  }

  private assertIdentity(requirement: IdentityRequirement, forceIdentity = false): void {
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
        this.fullIdentity(requirement)
      } else if (now - this.lastCheckAt >= 1_000) {
        this.lightweightIdentity(false, requirement)
      }
      this.lastCheckAt = Date.now()
      this.lastSuccessfulStorageCheck = new Date(this.lastCheckAt).toISOString()
    } catch (error) {
      if (error instanceof StorageUnavailableError && error.storageCode === 'PROBE_FAILED') {
        this.confirmProbe(error, requirement)
        this.lastCheckAt = Date.now()
        this.lastSuccessfulStorageCheck = new Date(this.lastCheckAt).toISOString()
        return
      }
      if (requirement === 'OPTIONAL_READ' && !isOptionalReadVolumeFatal(error)) throw error
      this.markFatal(error)
      throw this.fatal
    }
  }

  assertWritable(forceIdentity = false): void {
    this.assertIdentity('REQUIRED_WRITABLE', forceIdentity)
  }

  assertReadableVolumeIdentity(forceIdentity = false): void {
    this.assertIdentity('OPTIONAL_READ', forceIdentity)
  }

  classify(error: unknown): never {
    if (isStorageIoError(error)) {
      this.markFatal(error)
      throw this.fatal
    }
    throw error
  }

  classifyOptionalRead(error: unknown): never {
    if (isOptionalReadVolumeFatal(error)) {
      this.markFatal(error)
      throw this.fatal
    }
    throw error
  }

  classifyRebuildableCache(error: unknown): never {
    if (isRebuildableCacheVolumeFatal(error)) {
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
        confirmationAttempts: this.confirmationAttempts.length ? this.confirmationAttempts : null,
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
