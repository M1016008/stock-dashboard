import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { processGroupExists } from '@/lib/child-process-group'

export type PidProcessLock = {
  release: () => void
  prepareProcessGroupMarker: () => string
  setProcessGroup: (processGroupId: number | null) => void
}

type ProcessLockOwner = {
  version: 2
  pid: number
  pidStartedAt: string
  processGroupId: number | null
  processGroupMarkerPath: string | null
  owner: string
  label: string
  acquiredAt: string
}

const INVALID_OWNER_GRACE_MS = 60_000

function pidExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : ''
    return code === 'EPERM'
  }
}

function processStartIdentity(pid: number): string | null {
  if (!pidExists(pid)) return null
  try {
    const value = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      timeout: 5_000,
    }).trim()
    return value || null
  } catch {
    return null
  }
}

function installAtomicLock(lockPath: string, contents: string): boolean {
  const temporaryPath = path.join(
    path.dirname(lockPath),
    `.${path.basename(lockPath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  )
  fs.writeFileSync(temporaryPath, contents, { flag: 'wx', mode: 0o600 })
  try {
    fs.linkSync(temporaryPath, lockPath)
    return true
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : ''
    if (code === 'EEXIST') return false
    throw error
  } finally {
    fs.rmSync(temporaryPath, { force: true })
  }
}

function parseOwner(raw: string): {
  pid: number
  pidStartedAt: string | null
  processGroupId: number | null
  processGroupMarkerPath: string | null
  owner: string | null
} {
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value === 'number') {
      return {
        pid: Number.isInteger(value) ? value : 0,
        pidStartedAt: null,
        processGroupId: null,
        processGroupMarkerPath: null,
        owner: null,
      }
    }
    if (value == null || typeof value !== 'object') throw new Error('invalid process lock owner')
    const parsed = value as Partial<ProcessLockOwner>
    return {
      pid: Number(parsed.pid ?? 0),
      pidStartedAt: typeof parsed.pidStartedAt === 'string' ? parsed.pidStartedAt : null,
      processGroupId: Number.isInteger(parsed.processGroupId) && Number(parsed.processGroupId) > 0
        ? Number(parsed.processGroupId)
        : null,
      processGroupMarkerPath: typeof parsed.processGroupMarkerPath === 'string'
        ? parsed.processGroupMarkerPath
        : null,
      owner: typeof parsed.owner === 'string' ? parsed.owner : null,
    }
  } catch {
    const legacyPid = Number(raw.trim())
    return {
      pid: Number.isInteger(legacyPid) ? legacyPid : 0,
      pidStartedAt: null,
      processGroupId: null,
      processGroupMarkerPath: null,
      owner: null,
    }
  }
}

function ownerIsActive(owner: ReturnType<typeof parseOwner>): boolean {
  const parentExists = pidExists(owner.pid)
  const observedStartIdentity = parentExists && owner.pidStartedAt != null
    ? processStartIdentity(owner.pid)
    : null
  const parentActive = parentExists && (
    owner.pidStartedAt == null
    || observedStartIdentity == null
    || observedStartIdentity === owner.pidStartedAt
  )
  let markerProcessGroupActive = false
  if (owner.processGroupMarkerPath) {
    try {
      const markerProcessGroupId = Number(
        fs.readFileSync(owner.processGroupMarkerPath, 'utf8').trim(),
      )
      markerProcessGroupActive = processGroupExists(markerProcessGroupId)
    } catch {
      markerProcessGroupActive = false
    }
  }
  return parentActive || markerProcessGroupActive || (
    owner.processGroupId != null && processGroupExists(owner.processGroupId)
  )
}

function writeOwnedRecord(lockPath: string, ownerId: string, record: ProcessLockOwner): boolean {
  let descriptor: number | null = null
  try {
    descriptor = fs.openSync(lockPath, 'r+')
    const opened = fs.fstatSync(descriptor)
    const currentRaw = fs.readFileSync(descriptor, 'utf8')
    if (parseOwner(currentRaw).owner !== ownerId) return false
    const contents = `${JSON.stringify(record)}\n`
    fs.ftruncateSync(descriptor, 0)
    fs.writeSync(descriptor, contents, 0, 'utf8')
    fs.fsyncSync(descriptor)
    const current = fs.statSync(lockPath)
    return current.dev === opened.dev
      && current.ino === opened.ino
      && parseOwner(fs.readFileSync(lockPath, 'utf8')).owner === ownerId
  } catch {
    return false
  } finally {
    if (descriptor != null) fs.closeSync(descriptor)
  }
}

export function quarantineObservedStalePidProcessLock(
  lockPath: string,
  stalePath: string,
  expectedRaw: string,
  beforeUnlink?: () => void,
): boolean {
  const recoveryPath = `${lockPath}.stale-recovery`
  try {
    fs.mkdirSync(recoveryPath)
  } catch {
    // Only one contender may validate and unlink a stale pathname at a time.
    return false
  }
  try {
    fs.linkSync(lockPath, stalePath)
    const observed = fs.statSync(stalePath)
    if (fs.readFileSync(stalePath, 'utf8') !== expectedRaw) return false
    beforeUnlink?.()
    const current = fs.statSync(lockPath)
    if (current.dev !== observed.dev || current.ino !== observed.ino) return false
    if (fs.readFileSync(lockPath, 'utf8') !== expectedRaw) return false
    fs.unlinkSync(lockPath)
    return true
  } catch {
    return false
  } finally {
    try {
      fs.rmdirSync(recoveryPath)
    } catch {
      // A retained recovery marker fails closed on later stale reclamation.
    }
  }
}

export function acquirePidProcessLock(
  lockPath: string,
  label: string,
): PidProcessLock | null {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  const pidStartedAt = processStartIdentity(process.pid)
  if (!pidStartedAt) {
    throw new Error(`${label} cannot establish the current process identity`)
  }
  const ownerId = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  let owner: ProcessLockOwner = {
    version: 2,
    pid: process.pid,
    pidStartedAt,
    processGroupId: null,
    processGroupMarkerPath: null,
    owner: ownerId,
    label,
    acquiredAt: new Date().toISOString(),
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const ownerContents = `${JSON.stringify(owner)}\n`
    if (installAtomicLock(lockPath, ownerContents)) {
      let released = false
      return {
        prepareProcessGroupMarker: () => {
          if (released) throw new Error(`${label} process lock is already released`)
          const markerPath = `${lockPath}.process-group-${ownerId}`
          fs.rmSync(markerPath, { force: true })
          const next = { ...owner, processGroupMarkerPath: markerPath }
          if (!writeOwnedRecord(lockPath, ownerId, next)) {
            throw new Error(`${label} process lock ownership changed while preparing its child group`)
          }
          owner = next
          return markerPath
        },
        setProcessGroup: (processGroupId) => {
          if (released) throw new Error(`${label} process lock is already released`)
          const markerPath = owner.processGroupMarkerPath
          const next = {
            ...owner,
            processGroupId,
            processGroupMarkerPath: processGroupId == null ? null : markerPath,
          }
          if (!writeOwnedRecord(lockPath, ownerId, next)) {
            throw new Error(`${label} process lock ownership changed while publishing its child group`)
          }
          owner = next
          if (processGroupId == null && markerPath) {
            fs.rmSync(markerPath, { force: true })
          }
        },
        release: () => {
          if (released) return
          released = true
          try {
            if (parseOwner(fs.readFileSync(lockPath, 'utf8')).owner === ownerId) {
              fs.unlinkSync(lockPath)
            }
          } catch {
            // A missing or replaced lock no longer belongs to this process.
          }
          if (owner.processGroupMarkerPath) {
            fs.rmSync(owner.processGroupMarkerPath, { force: true })
          }
        },
      }
    }

    let existingRaw = ''
    let modifiedAt = Date.now()
    try {
      existingRaw = fs.readFileSync(lockPath, 'utf8')
      modifiedAt = fs.statSync(lockPath).mtimeMs
    } catch {
      continue
    }
    const existing = parseOwner(existingRaw)
    if (ownerIsActive(existing)) {
      console.log(
        `${label} already running (lock=${lockPath}, pid=${existing.pid}, `
        + `processGroup=${existing.processGroupId ?? 'none'}); skipping duplicate.`,
      )
      return null
    }
    if (Date.now() - modifiedAt < INVALID_OWNER_GRACE_MS) {
      console.log(`${label} lock owner or child group is still being published; lock=${lockPath}; skipping duplicate.`)
      return null
    }

    const stalePath = `${lockPath}.stale-owner-${Date.now()}-${process.pid}`
    if (!quarantineObservedStalePidProcessLock(lockPath, stalePath, existingRaw)) {
      console.log(`${label} lock changed during stale-owner recovery; skipping duplicate.`)
      return null
    }
    console.warn(`${label} quarantined stale owner record at ${stalePath}`)
    if (existing.processGroupMarkerPath) {
      fs.rmSync(existing.processGroupMarkerPath, { force: true })
    }
  }
  console.log(`${label} lock could not be acquired after stale-owner recovery attempts; lock=${lockPath}.`)
  return null
}
