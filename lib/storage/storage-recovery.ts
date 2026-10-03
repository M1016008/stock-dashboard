import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {
  hasStorageFatalLatch, inspectStorage, storageFatalLatchPath,
  type GuardConfig, type VolumeIdentity,
} from './external-storage-guard'

export type RecoveryResolution =
  | 'REAL_DISCONNECT_RECOVERED' | 'FALSE_POSITIVE_CONFIRMED'
  | 'TRANSIENT_CHECK_FAILURE' | 'UNKNOWN_BUT_CURRENTLY_STABLE'

type Incident = { incidentId: string; timestamp: string; errorCode: string }
type Identity = { mount: string; db: string; device: number | bigint }

function latestIncident(dir: string): Incident {
  const lines = fs.readFileSync(path.join(dir, 'incidents.ndjson'), 'utf8').trim().split('\n')
  const incident = JSON.parse(lines.at(-1) ?? '{}') as Incident
  if (!incident.incidentId || !incident.timestamp || !incident.errorCode) throw new Error('Latest storage incident is invalid')
  return incident
}

function lightweightIdentity(config: GuardConfig): Identity {
  const mount = fs.realpathSync(config.mountPath)
  const db = fs.realpathSync(config.dbPath)
  const device = fs.statSync(mount).dev
  if (!db.startsWith(`${mount}${path.sep}`) || fs.statSync(db).dev !== device) {
    throw new Error('DB is not on the expected mounted device')
  }
  const mounts = execFileSync('/sbin/mount', { encoding: 'utf8', timeout: 8_000, maxBuffer: 2_000_000 })
  if (!mounts.includes(` on ${config.mountPath} (`)) throw new Error('Expected mount is absent from mount table')
  for (const suffix of ['-wal', '-shm']) {
    const companion = `${config.dbPath}${suffix}`
    if (fs.existsSync(companion) && fs.statSync(fs.realpathSync(companion)).dev !== device) {
      throw new Error(`${suffix} is not on the expected mounted device`)
    }
  }
  return { mount, db, device }
}

function assertNoDbHandles(config: GuardConfig): void {
  const files = [config.dbPath, `${config.dbPath}-wal`, `${config.dbPath}-shm`].filter(fs.existsSync)
  const result = spawnSync('/usr/sbin/lsof', files, { encoding: 'utf8', timeout: 15_000 })
  if (result.error || result.status === null || result.status > 1 || result.stderr.trim()) {
    throw new Error('DB handle audit failed')
  }
  if (result.status === 0 && result.stdout.trim()) throw new Error('DB handles remain open; stop services gracefully')
}

function assertNoNewStorageErrors(startedAt: Date): void {
  const start = startedAt.toLocaleString('sv-SE', { timeZone: 'Asia/Tokyo', hour12: false }).replace('T', ' ')
  const predicate = 'process == "kernel" AND (eventMessage CONTAINS[c] "CommandTimeout" OR eventMessage CONTAINS[c] "FatalHandling" OR eventMessage CONTAINS[c] "I/O error" OR eventMessage CONTAINS[c] "unmounting volume")'
  const result = spawnSync('/usr/bin/log', ['show', '--start', start, '--style', 'compact', '--predicate', predicate], {
    encoding: 'utf8', timeout: 60_000, maxBuffer: 4_000_000,
  })
  if (result.error || result.status !== 0) throw new Error('macOS storage error log audit failed')
  const events = result.stdout.split('\n').filter((line) =>
    /IONVMeController::(?:CommandTimeout|FatalHandling)|NVMe.*command timeout|apfs.*I\/O error|unmounting volume/i.test(line))
  if (events.length) throw new Error(`New storage error events detected: ${events.length}`)
}

export type RecoveryChecks = {
  inspect: () => VolumeIdentity
  identity: () => Identity
  noHandles: () => void
  noErrors: (startedAt: Date) => void
  wait: (ms: number) => Promise<void>
}

export async function recoverStorage(
  config: GuardConfig,
  incidentId: string,
  resolution: RecoveryResolution,
  options: { checks?: RecoveryChecks; observations?: number; intervalMs?: number } = {},
): Promise<{ incidentId: string; checks: number; resolvedAt: string }> {
  const dir = path.dirname(storageFatalLatchPath(config))
  if (!hasStorageFatalLatch(config)) throw new Error('No FAILED_SAFE latch exists')
  const incident = latestIncident(dir)
  if (incident.incidentId !== incidentId) throw new Error('Incident ID does not match the latest incident')
  const checks = options.checks ?? {
    inspect: () => inspectStorage(config),
    identity: () => lightweightIdentity(config),
    noHandles: () => assertNoDbHandles(config),
    noErrors: assertNoNewStorageErrors,
    wait: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  }
  const observations = options.observations ?? 21
  const intervalMs = options.intervalMs ?? 30_000
  if (observations < 2 || intervalMs < 0) throw new Error('Invalid recovery observation contract')
  const startedAt = new Date()
  const startVolume = checks.inspect()
  if (startVolume.filesystem?.toLowerCase() !== 'apfs') throw new Error('Expected APFS source volume')
  checks.noHandles()
  const baseline = checks.identity()
  for (let index = 1; index < observations; index++) {
    await checks.wait(intervalMs)
    const current = checks.identity()
    if (current.mount !== baseline.mount || current.db !== baseline.db || current.device !== baseline.device) {
      throw new Error(`Storage identity changed during observation ${index}`)
    }
    console.log(`Storage recovery observation ${index + 1}/${observations}: stable`)
  }
  const endVolume = checks.inspect()
  if (endVolume.filesystem?.toLowerCase() !== 'apfs'
    || startVolume.uuid !== endVolume.uuid || endVolume.uuid?.toUpperCase() !== config.volumeUuid.toUpperCase()) {
    throw new Error('Volume UUID changed during recovery observation')
  }
  checks.noErrors(startedAt)
  checks.noHandles()
  if (!hasStorageFatalLatch(config) || latestIncident(dir).incidentId !== incidentId) {
    throw new Error('Storage incident state changed during recovery observation')
  }
  const uncertainMarkers = fs.readdirSync(dir).filter((name) => /^PROBE_UNCERTAIN-\d+$/.test(name))
  for (const marker of uncertainMarkers) {
    const pid = Number(marker.slice('PROBE_UNCERTAIN-'.length))
    try {
      process.kill(pid, 0)
      throw new Error(`Probe owner remains alive: ${pid}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') continue
      throw error
    }
  }

  const resolvedAt = new Date().toISOString()
  const record = {
    incidentId, incidentTimestamp: incident.timestamp, originalErrorCode: incident.errorCode,
    resolvedAt, resolution, operatorAction: 'storage:recover',
    preflight: { uuidMatch: true, dbOnExpectedDevice: true, freeSpacePass: true, noActiveDbHandles: true },
    observations, intervalMs, newStorageErrors: 0, archivedStaleProbeMarkers: uncertainMarkers.length,
  }
  const recordPath = path.join(dir, `recovery-${incidentId}.json`)
  const archivedLatch = path.join(dir, `FAILED_SAFE.resolved-${incidentId}`)
  const descriptor = fs.openSync(recordPath, 'wx', 0o600)
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(record, null, 2)}\n`)
    fs.fsyncSync(descriptor)
  } finally { fs.closeSync(descriptor) }
  for (const marker of uncertainMarkers) {
    fs.renameSync(path.join(dir, marker), path.join(dir, `${marker}.resolved-${incidentId}`))
  }
  fs.renameSync(storageFatalLatchPath(config), archivedLatch)
  return { incidentId, checks: observations, resolvedAt }
}
