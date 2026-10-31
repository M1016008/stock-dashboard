import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { stableSha256 } from '@/lib/jp-ohlcv-data-quality'

const SHA256 = /^[a-f0-9]{64}$/

export type SqliteArtifactIdentity = {
  realpath: string
  device: string
  inode: string
  sizeBytes: number
  mtimeNs: string
  ctimeNs: string
  sha256: string
}

export type SqliteIntegrityReceipt = {
  version: 1
  kind: 'BACKUP_COMPLETE' | 'CANDIDATE_POST_WRITE' | 'RESTORE_IDENTITY'
  transactionId: string
  createdAt: string
  artifact: SqliteArtifactIdentity
  measurementEvidenceSha256: string
  parentReceiptSha256: string | null
  sqliteCheck: {
    command: 'PRAGMA quick_check;'
    result: 'ok' | 'INHERITED_BY_BYTE_IDENTITY'
    scope: 'WHOLE_FILE_QUICK_CHECK'
    elapsedMs: number
  }
  sourceGeneration: string
  servingGeneration: string
  guarantees: string[]
  limitations: string[]
}

function assertRegularAbsolute(file: string): fs.BigIntStats {
  if (!path.isAbsolute(file)) throw new Error('SQLITE_RECEIPT_ABSOLUTE_PATH_REQUIRED')
  const stat = fs.lstatSync(file, { bigint: true })
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('SQLITE_RECEIPT_REGULAR_FILE_REQUIRED')
  if (fs.realpathSync(file) !== file) throw new Error('SQLITE_RECEIPT_REALPATH_REQUIRED')
  return stat
}

export function sqliteArtifactIdentity(input: {
  file: string
  deadlineMs?: number
}): SqliteArtifactIdentity {
  const statBefore = assertRegularAbsolute(input.file)
  const hash = createHash('sha256')
  const descriptor = fs.openSync(input.file, 'r')
  const buffer = Buffer.allocUnsafe(8 * 1024 * 1024)
  try {
    for (;;) {
      if (input.deadlineMs !== undefined && Date.now() >= input.deadlineMs) {
        throw new Error('SQLITE_RECEIPT_HASH_DEADLINE_EXCEEDED')
      }
      const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null)
      if (bytes === 0) break
      hash.update(buffer.subarray(0, bytes))
    }
  } finally {
    fs.closeSync(descriptor)
  }
  const stat = assertRegularAbsolute(input.file)
  if (stat.dev !== statBefore.dev
    || stat.ino !== statBefore.ino
    || stat.size !== statBefore.size
    || stat.mtimeNs !== statBefore.mtimeNs
    || stat.ctimeNs !== statBefore.ctimeNs) {
    throw new Error('SQLITE_RECEIPT_ARTIFACT_CHANGED_DURING_HASH')
  }
  const sizeBytes = Number(stat.size)
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) throw new Error('SQLITE_RECEIPT_SIZE_INVALID')
  return {
    realpath: input.file,
    device: String(stat.dev),
    inode: String(stat.ino),
    sizeBytes,
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
    sha256: hash.digest('hex'),
  }
}

export function assertSqliteArtifactIdentityMatchesFile(artifact: SqliteArtifactIdentity): void {
  const stat = assertRegularAbsolute(artifact.realpath)
  if (artifact.device !== String(stat.dev)
    || artifact.inode !== String(stat.ino)
    || artifact.sizeBytes !== Number(stat.size)
    || artifact.mtimeNs !== String(stat.mtimeNs)
    || artifact.ctimeNs !== String(stat.ctimeNs)) {
    throw new Error('SQLITE_ARTIFACT_IDENTITY_CHANGED')
  }
}

export function createFullSqliteIntegrityReceipt(input: {
  kind: 'BACKUP_COMPLETE' | 'CANDIDATE_POST_WRITE'
  transactionId: string
  createdAt: string
  artifact: SqliteArtifactIdentity
  measurementEvidenceSha256: string
  quickCheckResult: string
  quickCheckElapsedMs: number
  sourceGeneration: string
  servingGeneration: string
  guarantees: string[]
  limitations: string[]
  parentReceipt?: SqliteIntegrityReceipt
  parentReceiptSha256?: string
}): SqliteIntegrityReceipt {
  if (input.quickCheckResult !== 'ok') throw new Error('SQLITE_RECEIPT_FULL_CHECK_REQUIRED')
  assertSqliteArtifactIdentityMatchesFile(input.artifact)
  if (input.kind === 'CANDIDATE_POST_WRITE') {
    if (!input.parentReceipt || !input.parentReceiptSha256) {
      throw new Error('SQLITE_CANDIDATE_PARENT_RECEIPT_REQUIRED')
    }
    assertSqliteIntegrityReceipt(input.parentReceipt)
    if (input.parentReceipt.kind !== 'BACKUP_COMPLETE'
      || input.parentReceipt.transactionId !== input.transactionId
      || stableSha256(input.parentReceipt) !== input.parentReceiptSha256
      || Date.parse(input.createdAt) < Date.parse(input.parentReceipt.createdAt)) {
      throw new Error('SQLITE_CANDIDATE_PARENT_RECEIPT_INVALID')
    }
  }
  const receipt: SqliteIntegrityReceipt = {
    version: 1,
    kind: input.kind,
    transactionId: input.transactionId,
    createdAt: input.createdAt,
    artifact: input.artifact,
    measurementEvidenceSha256: input.measurementEvidenceSha256,
    parentReceiptSha256: input.kind === 'BACKUP_COMPLETE'
      ? null
      : input.parentReceiptSha256 ?? null,
    sqliteCheck: {
      command: 'PRAGMA quick_check;',
      result: 'ok',
      scope: 'WHOLE_FILE_QUICK_CHECK',
      elapsedMs: input.quickCheckElapsedMs,
    },
    sourceGeneration: input.sourceGeneration,
    servingGeneration: input.servingGeneration,
    guarantees: [...input.guarantees],
    limitations: [...input.limitations],
  }
  assertSqliteIntegrityReceipt(receipt)
  return receipt
}

export function createRestoreIdentityReceipt(input: {
  transactionId: string
  createdAt: string
  artifact: SqliteArtifactIdentity
  inheritedReceipt: SqliteIntegrityReceipt
  inheritedReceiptSha256: string
  measurementEvidenceSha256: string
  sourceGeneration: string
  servingGeneration: string
  hashElapsedMs: number
}): SqliteIntegrityReceipt {
  assertSqliteIntegrityReceipt(input.inheritedReceipt)
  assertSqliteArtifactIdentityMatchesFile(input.inheritedReceipt.artifact)
  assertSqliteArtifactIdentityMatchesFile(input.artifact)
  if (stableSha256(input.inheritedReceipt) !== input.inheritedReceiptSha256) {
    throw new Error('SQLITE_RESTORE_INHERITED_RECEIPT_HASH_MISMATCH')
  }
  if (input.inheritedReceipt.kind !== 'BACKUP_COMPLETE'
    || input.transactionId !== input.inheritedReceipt.transactionId
    || input.sourceGeneration !== input.inheritedReceipt.sourceGeneration
    || input.servingGeneration !== input.inheritedReceipt.servingGeneration) {
    throw new Error('SQLITE_RESTORE_INHERITED_RECEIPT_INVALID')
  }
  if (input.artifact.sha256 !== input.inheritedReceipt.artifact.sha256
    || input.artifact.sizeBytes !== input.inheritedReceipt.artifact.sizeBytes
    || input.artifact.realpath === input.inheritedReceipt.artifact.realpath
    || (input.artifact.device === input.inheritedReceipt.artifact.device
      && input.artifact.inode === input.inheritedReceipt.artifact.inode)
    || Date.parse(input.createdAt) < Date.parse(input.inheritedReceipt.createdAt)) {
    throw new Error('SQLITE_RESTORE_BYTE_IDENTITY_MISMATCH')
  }
  const receipt: SqliteIntegrityReceipt = {
    version: 1,
    kind: 'RESTORE_IDENTITY',
    transactionId: input.transactionId,
    createdAt: input.createdAt,
    artifact: input.artifact,
    measurementEvidenceSha256: input.measurementEvidenceSha256,
    parentReceiptSha256: input.inheritedReceiptSha256,
    sqliteCheck: {
      command: 'PRAGMA quick_check;',
      result: 'INHERITED_BY_BYTE_IDENTITY',
      scope: 'WHOLE_FILE_QUICK_CHECK',
      elapsedMs: input.hashElapsedMs,
    },
    sourceGeneration: input.sourceGeneration,
    servingGeneration: input.servingGeneration,
    guarantees: [
      'restored bytes and size equal the artifact covered by the inherited full-database receipt',
    ],
    limitations: [
      'this receipt proves byte identity; it does not attest service readiness or semantic lineage',
    ],
  }
  assertSqliteIntegrityReceipt(receipt)
  return receipt
}

export function assertSqliteIntegrityReceipt(receipt: SqliteIntegrityReceipt): void {
  if (!receipt || typeof receipt !== 'object'
    || receipt.version !== 1
    || !['BACKUP_COMPLETE', 'CANDIDATE_POST_WRITE', 'RESTORE_IDENTITY'].includes(receipt.kind)
    || !receipt.transactionId
    || !Number.isFinite(Date.parse(receipt.createdAt))
    || !receipt.artifact
    || typeof receipt.artifact !== 'object'
    || !path.isAbsolute(receipt.artifact.realpath)
    || !receipt.artifact.device
    || !receipt.artifact.inode
    || !Number.isSafeInteger(receipt.artifact.sizeBytes)
    || receipt.artifact.sizeBytes <= 0
    || !receipt.artifact.mtimeNs
    || !receipt.artifact.ctimeNs
    || !SHA256.test(receipt.artifact.sha256)
    || !SHA256.test(receipt.measurementEvidenceSha256)
    || !receipt.sqliteCheck
    || typeof receipt.sqliteCheck !== 'object'
    || receipt.sqliteCheck.command !== 'PRAGMA quick_check;'
    || receipt.sqliteCheck.scope !== 'WHOLE_FILE_QUICK_CHECK'
    || !Number.isFinite(receipt.sqliteCheck.elapsedMs)
    || receipt.sqliteCheck.elapsedMs < 0
    || !receipt.sourceGeneration
    || !receipt.servingGeneration
    || !Array.isArray(receipt.guarantees)
    || !Array.isArray(receipt.limitations)
    || receipt.guarantees.length === 0
    || receipt.limitations.length === 0
    || !receipt.guarantees.every((entry) => typeof entry === 'string' && entry.length > 0)
    || !receipt.limitations.every((entry) => typeof entry === 'string' && entry.length > 0)) {
    throw new Error('SQLITE_INTEGRITY_RECEIPT_INVALID')
  }
  if (receipt.kind === 'RESTORE_IDENTITY') {
    if (!receipt.parentReceiptSha256 || !SHA256.test(receipt.parentReceiptSha256)
      || receipt.sqliteCheck.result !== 'INHERITED_BY_BYTE_IDENTITY') {
      throw new Error('SQLITE_RESTORE_RECEIPT_INVALID')
    }
  } else if (receipt.kind === 'CANDIDATE_POST_WRITE') {
    if (!receipt.parentReceiptSha256 || !SHA256.test(receipt.parentReceiptSha256)
      || receipt.sqliteCheck.result !== 'ok') {
      throw new Error('SQLITE_CANDIDATE_RECEIPT_INVALID')
    }
  } else if (receipt.parentReceiptSha256 !== null || receipt.sqliteCheck.result !== 'ok') {
    throw new Error('SQLITE_FULL_CHECK_RECEIPT_INVALID')
  }
}

