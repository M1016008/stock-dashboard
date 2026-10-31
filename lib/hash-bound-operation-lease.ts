import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export type HashBoundOperationLeaseOwner = {
  version: 1
  scopeSha256: string
  pid: number
  processIdentitySha256: string
  acquiredAt: string
}

type ProcessIdentityReader = (pid: number) => { identitySha256: string } | null

function syncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, 'r')
  try { fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
}

function readOwner(file: string): { owner: HashBoundOperationLeaseOwner; raw: Buffer } {
  const raw = fs.readFileSync(file)
  const owner = JSON.parse(raw.toString('utf8')) as Partial<HashBoundOperationLeaseOwner>
  if (owner.version !== 1 || !/^[a-f0-9]{64}$/.test(owner.scopeSha256 ?? '')
    || !Number.isSafeInteger(owner.pid) || (owner.pid ?? 0) <= 0
    || !/^[a-f0-9]{64}$/.test(owner.processIdentitySha256 ?? '')
    || typeof owner.acquiredAt !== 'string') {
    throw new Error('hash_bound_operation_lease_owner_invalid')
  }
  return { owner: owner as HashBoundOperationLeaseOwner, raw }
}

export function isProcessDefinitelyAbsent(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return true
    if (code === 'EPERM') return false
    throw new Error(`hash_bound_operation_lease_process_probe_unknown:${code ?? 'unknown'}`)
  }
}

export function acquireHashBoundOperationLease(input: {
  leasePath: string
  scopeSha256: string
  readProcessIdentity: ProcessIdentityReader
  beforeStaleRename?: () => void
}): HashBoundOperationLeaseOwner {
  if (!path.isAbsolute(input.leasePath) || !/^[a-f0-9]{64}$/.test(input.scopeSha256)) {
    throw new Error('hash_bound_operation_lease_contract_invalid')
  }
  const directory = path.dirname(input.leasePath)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const identity = input.readProcessIdentity(process.pid)
  if (!identity) throw new Error('hash_bound_operation_lease_process_identity_unavailable')
  const owner: HashBoundOperationLeaseOwner = {
    version: 1,
    scopeSha256: input.scopeSha256,
    pid: process.pid,
    processIdentitySha256: identity.identitySha256,
    acquiredAt: new Date().toISOString(),
  }
  const acquisitionGuard = `${input.leasePath}.acquiring`
  const guardCandidate = `${acquisitionGuard}.candidate-${process.pid}-${crypto.randomUUID()}`
  fs.mkdirSync(guardCandidate, { mode: 0o700 })
  const guardOwner = path.join(guardCandidate, 'owner.json')
  const guardDescriptor = fs.openSync(guardOwner, 'wx', 0o400)
  try {
    fs.writeFileSync(guardDescriptor, `${JSON.stringify(owner, null, 2)}\n`)
    fs.fsyncSync(guardDescriptor)
  } finally {
    fs.closeSync(guardDescriptor)
  }
  syncDirectory(guardCandidate)
  try {
    fs.renameSync(guardCandidate, acquisitionGuard)
    syncDirectory(directory)
  } catch (error) {
    fs.rmSync(guardCandidate, { recursive: true, force: true })
    if (['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      throw new Error('hash_bound_operation_lease_acquisition_in_progress')
    }
    throw error
  }
  try {
    if (fs.existsSync(input.leasePath)) {
      const { owner: stale, raw: expectedRaw } = readOwner(input.leasePath)
      if (stale.scopeSha256 !== input.scopeSha256) {
        throw new Error('hash_bound_operation_lease_scope_mismatch')
      }
      const current = input.readProcessIdentity(stale.pid)
      if (current?.identitySha256 === stale.processIdentitySha256) {
        throw new Error('hash_bound_operation_lease_active')
      }
      if (!current && !isProcessDefinitelyAbsent(stale.pid)) {
        throw new Error('hash_bound_operation_lease_process_identity_unknown')
      }
      input.beforeStaleRename?.()
      const stalePath = `${input.leasePath}.stale-${Date.now()}-${crypto.randomUUID()}`
      try {
        fs.renameSync(input.leasePath, stalePath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error('hash_bound_operation_lease_reclaim_raced')
        }
        throw error
      }
      const movedRaw = fs.readFileSync(stalePath)
      if (!movedRaw.equals(expectedRaw)) {
        try {
          fs.linkSync(stalePath, input.leasePath)
          fs.unlinkSync(stalePath)
          syncDirectory(directory)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        }
        throw new Error('hash_bound_operation_lease_reclaim_raced')
      }
      syncDirectory(directory)
    }
  const temporary = `${input.leasePath}.candidate-${process.pid}-${crypto.randomUUID()}`
  const descriptor = fs.openSync(temporary, 'wx', 0o400)
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(owner, null, 2)}\n`)
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
  try {
    fs.linkSync(temporary, input.leasePath)
    syncDirectory(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('hash_bound_operation_lease_active')
    }
    throw error
  } finally {
    fs.rmSync(temporary, { force: true })
  }
    return owner
  } finally {
    const releasedGuard = `${acquisitionGuard}.released-${process.pid}-${crypto.randomUUID()}`
    fs.renameSync(acquisitionGuard, releasedGuard)
    syncDirectory(directory)
    fs.rmSync(releasedGuard, { recursive: true, force: true })
  }
}

export function releaseHashBoundOperationLease(input: {
  leasePath: string
  owner: HashBoundOperationLeaseOwner
}): void {
  const { owner: recorded } = readOwner(input.leasePath)
  if (JSON.stringify(recorded) !== JSON.stringify(input.owner)) {
    throw new Error('hash_bound_operation_lease_release_identity_mismatch')
  }
  fs.unlinkSync(input.leasePath)
  syncDirectory(path.dirname(input.leasePath))
}
