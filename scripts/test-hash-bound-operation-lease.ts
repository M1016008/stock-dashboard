import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import {
  acquireHashBoundOperationLease,
  releaseHashBoundOperationLease,
} from '@/lib/hash-bound-operation-lease'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hash-bound-operation-lease-'))
const leasePath = path.join(root, 'operation.lease')
const scopeSha256 = crypto.createHash('sha256').update('approved-package').digest('hex')
const currentIdentity = crypto.createHash('sha256').update('current-process').digest('hex')
const readProcessIdentity = (pid: number) => pid === process.pid
  ? { identitySha256: currentIdentity }
  : null

try {
  const owner = acquireHashBoundOperationLease({ leasePath, scopeSha256, readProcessIdentity })
  assert.throws(
    () => acquireHashBoundOperationLease({ leasePath, scopeSha256, readProcessIdentity }),
    /hash_bound_operation_lease_active/,
  )
  releaseHashBoundOperationLease({ leasePath, owner })
  fs.writeFileSync(leasePath, `${JSON.stringify({
    ...owner,
    pid: 2147483647,
    processIdentitySha256: 'a'.repeat(64),
  })}\n`)
  const reclaimed = acquireHashBoundOperationLease({ leasePath, scopeSha256, readProcessIdentity })
  releaseHashBoundOperationLease({ leasePath, owner: reclaimed })
  fs.writeFileSync(leasePath, `${JSON.stringify({
    ...owner,
    pid: 2147483647,
    processIdentitySha256: 'c'.repeat(64),
  })}\n`)
  const competingOwner = { ...owner, processIdentitySha256: 'd'.repeat(64) }
  assert.throws(() => acquireHashBoundOperationLease({
    leasePath,
    scopeSha256,
    readProcessIdentity,
    beforeStaleRename: () => fs.writeFileSync(leasePath, `${JSON.stringify(competingOwner)}\n`),
  }), /hash_bound_operation_lease_reclaim_raced/)
  assert.equal(JSON.parse(fs.readFileSync(leasePath, 'utf8')).processIdentitySha256,
    competingOwner.processIdentitySha256)
  fs.rmSync(leasePath)
  const activeUnknown = spawn('/bin/sleep', ['10'])
  if (!activeUnknown.pid) throw new Error('fixture_process_missing')
  fs.writeFileSync(leasePath, `${JSON.stringify({ ...owner, pid: activeUnknown.pid })}\n`)
  assert.throws(() => acquireHashBoundOperationLease({
    leasePath,
    scopeSha256,
    readProcessIdentity: (pid) => pid === process.pid ? { identitySha256: currentIdentity } : null,
  }), /hash_bound_operation_lease_process_identity_unknown/)
  activeUnknown.kill('SIGTERM')
  fs.rmSync(leasePath)
  fs.writeFileSync(leasePath, `${JSON.stringify({ ...owner, scopeSha256: 'b'.repeat(64), pid: 2147483647 })}\n`)
  assert.throws(
    () => acquireHashBoundOperationLease({ leasePath, scopeSha256, readProcessIdentity }),
    /hash_bound_operation_lease_scope_mismatch/,
  )
  console.log('Hash-bound operation lease regression: PASS (exclusive, stale recovery, race and unknown rejection)')
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
