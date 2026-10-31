import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { stableSha256 } from '@/lib/jp-ohlcv-data-quality'
import {
  assertApfsCandidateCapacity,
  createMeasuredApfsClone,
} from '@/lib/storage/apfs-sqlite-candidate'
import {
  assertSqliteArtifactIdentityMatchesFile,
  assertSqliteIntegrityReceipt,
  createFullSqliteIntegrityReceipt,
  createRestoreIdentityReceipt,
  sqliteArtifactIdentity,
} from '@/lib/storage/sqlite-integrity-contract'

type Database = {
  close(): void
  exec(sql: string): void
  prepare(sql: string): { get(): Record<string, unknown> | undefined }
}

const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (file: string, options?: { readOnly?: boolean }) => Database
}

function sha256File(file: string): string {
  const hash = createHash('sha256')
  const descriptor = fs.openSync(file, 'r')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    for (;;) {
      const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null)
      if (bytes === 0) break
      hash.update(buffer.subarray(0, bytes))
    }
  } finally {
    fs.closeSync(descriptor)
  }
  return hash.digest('hex')
}

function createDatabase(file: string, value: string): void {
  const db = new DatabaseSync(file)
  try {
    db.exec(`
      PRAGMA journal_mode=DELETE;
      PRAGMA synchronous=FULL;
      CREATE TABLE marker(id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO marker(id, value) VALUES (1, '${value}');
    `)
  } finally {
    db.close()
  }
}

function quickCheck(file: string): string {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return String(db.prepare('PRAGMA quick_check;').get()?.quick_check)
  } finally {
    db.close()
  }
}

function compileCloneHelper(root: string): string {
  const executable = path.join(root, 'apfs-clone-file')
  const source = path.resolve('scripts/native/apfs-clone-file.c')
  const result = spawnSync('/usr/bin/clang', ['-O2', '-Wall', '-Wextra', source, '-o', executable], {
    encoding: 'utf8',
  })
  if (result.error || result.status !== 0) {
    throw new Error(`fixture_compile_failed:${result.error?.message ?? result.stderr}`)
  }
  return executable
}

function backupReceiptFor(file: string, evidenceCharacter: string) {
  return createFullSqliteIntegrityReceipt({
    kind: 'BACKUP_COMPLETE',
    transactionId: 'fixture-clone',
    createdAt: new Date().toISOString(),
    artifact: sqliteArtifactIdentity({ file }),
    measurementEvidenceSha256: evidenceCharacter.repeat(64),
    quickCheckResult: quickCheck(file),
    quickCheckElapsedMs: 10,
    sourceGeneration: 'source-original',
    servingGeneration: 'serving-original',
    guarantees: ['full backup SQLite quick_check completed before candidate creation'],
    limitations: ['quick_check does not replace semantic lineage verification'],
  })
}

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'stockboard-sqlite-candidate-'))
  try {
  const source = path.join(root, 'source.sqlite')
  const candidate = path.join(root, 'candidate.sqlite')
  const executable = compileCloneHelper(root)
  createDatabase(source, 'original')

  const sourceIdentity = sqliteArtifactIdentity({ file: source })
  assertSqliteArtifactIdentityMatchesFile(sourceIdentity)
  const backupReceipt = backupReceiptFor(source, 'a')
  assertSqliteIntegrityReceipt(backupReceipt)

  const backupReceiptSha256 = stableSha256(backupReceipt)
  let writerBarrierChecks = 0
  const evidence = await createMeasuredApfsClone({
    sourceIntegrityReceipt: backupReceipt,
    sourceIntegrityReceiptSha256: backupReceiptSha256,
    candidatePath: candidate,
    cloneExecutablePath: executable,
    cloneExecutableSha256: sha256File(executable),
    writerBarrierReceiptSha256: 'b'.repeat(64),
    capacity: {
      maximumInitialAllocationBytes: 64 * 1024 * 1024,
      maximumCowGrowthBytes: 64 * 1024 * 1024,
      failedStateRetentionBytes: 64 * 1024 * 1024,
      minimumReserveBytes: 1,
    },
    timeoutMs: 30_000,
    sha256File,
    assertWriterBarrierValid: async () => { writerBarrierChecks += 1 },
  })
  assert.equal(writerBarrierChecks, 2)
  assert.equal(evidence.logicalBytes, fs.statSync(source).size)
  assert.equal(sha256File(candidate), sourceIdentity.sha256)
  assert.notEqual(fs.statSync(candidate).ino, fs.statSync(source).ino)
  assertSqliteArtifactIdentityMatchesFile(sourceIdentity)

  const candidateReceipt = createFullSqliteIntegrityReceipt({
    kind: 'CANDIDATE_POST_WRITE',
    transactionId: 'fixture-clone',
    createdAt: new Date().toISOString(),
    artifact: sqliteArtifactIdentity({ file: candidate }),
    measurementEvidenceSha256: 'c'.repeat(64),
    quickCheckResult: quickCheck(candidate),
    quickCheckElapsedMs: 8,
    sourceGeneration: 'source-candidate',
    servingGeneration: 'serving-candidate',
    guarantees: ['full candidate SQLite quick_check completed after candidate mutation stage'],
    limitations: ['service readiness is verified after a separately approved activation'],
    parentReceipt: backupReceipt,
    parentReceiptSha256: backupReceiptSha256,
  })
  assertSqliteIntegrityReceipt(candidateReceipt)

  const restored = path.join(root, 'restored.sqlite')
  fs.copyFileSync(source, restored)
  const restoredReceipt = createRestoreIdentityReceipt({
    transactionId: 'fixture-clone',
    createdAt: new Date().toISOString(),
    artifact: sqliteArtifactIdentity({ file: restored }),
    inheritedReceipt: backupReceipt,
    inheritedReceiptSha256: backupReceiptSha256,
    measurementEvidenceSha256: 'd'.repeat(64),
    sourceGeneration: 'source-original',
    servingGeneration: 'serving-original',
    hashElapsedMs: 2,
  })
  assert.equal(restoredReceipt.sqliteCheck.result, 'INHERITED_BY_BYTE_IDENTITY')

  assert.deepEqual(assertApfsCandidateCapacity({
    availableBytes: 1_000,
    maximumInitialAllocationBytes: 100,
    maximumCowGrowthBytes: 300,
    failedStateRetentionBytes: 200,
    minimumReserveBytes: 300,
  }), { requiredBytes: 900, remainingBytes: 100 })
  assert.throws(() => assertApfsCandidateCapacity({
    availableBytes: 899,
    maximumInitialAllocationBytes: 100,
    maximumCowGrowthBytes: 300,
    failedStateRetentionBytes: 200,
    minimumReserveBytes: 300,
  }), /SQLITE_CLONE_CAPACITY_INSUFFICIENT/)
  assert.throws(() => assertApfsCandidateCapacity({
    availableBytes: Number.MAX_SAFE_INTEGER,
    maximumInitialAllocationBytes: Number.MAX_SAFE_INTEGER,
    maximumCowGrowthBytes: 1,
    failedStateRetentionBytes: 1,
    minimumReserveBytes: 1,
  }), /SQLITE_CLONE_CAPACITY_SUM_UNSAFE/)

  await assert.rejects(() => createMeasuredApfsClone({
    sourceIntegrityReceipt: backupReceipt,
    sourceIntegrityReceiptSha256: backupReceiptSha256,
    candidatePath: path.join(root, 'bad-executable-candidate.sqlite'),
    cloneExecutablePath: executable,
    cloneExecutableSha256: '0'.repeat(64),
    writerBarrierReceiptSha256: '6'.repeat(64),
    capacity: {
      maximumInitialAllocationBytes: 64 * 1024 * 1024,
      maximumCowGrowthBytes: 64 * 1024 * 1024,
      failedStateRetentionBytes: 64 * 1024 * 1024,
      minimumReserveBytes: 1,
    },
    timeoutMs: 30_000,
    sha256File,
    assertWriterBarrierValid: async () => {},
  }), /SQLITE_CLONE_EXECUTABLE_HASH_MISMATCH/)

  const sidecarSource = path.join(root, 'sidecar.sqlite')
  createDatabase(sidecarSource, 'sidecar')
  fs.writeFileSync(`${sidecarSource}-wal`, 'present')
  const sidecarReceipt = backupReceiptFor(sidecarSource, '4')
  await assert.rejects(() => createMeasuredApfsClone({
    sourceIntegrityReceipt: sidecarReceipt,
    sourceIntegrityReceiptSha256: stableSha256(sidecarReceipt),
    candidatePath: path.join(root, 'sidecar-candidate.sqlite'),
    cloneExecutablePath: executable,
    cloneExecutableSha256: sha256File(executable),
    writerBarrierReceiptSha256: 'e'.repeat(64),
    capacity: {
      maximumInitialAllocationBytes: 64 * 1024 * 1024,
      maximumCowGrowthBytes: 64 * 1024 * 1024,
      failedStateRetentionBytes: 64 * 1024 * 1024,
      minimumReserveBytes: 1,
    },
    timeoutMs: 30_000,
    sha256File,
    assertWriterBarrierValid: async () => {},
  }), /SQLITE_CLONE_SIDECAR_PRESENT/)

  const changedSource = path.join(root, 'changed.sqlite')
  createDatabase(changedSource, 'changed')
  const staleIdentity = sqliteArtifactIdentity({ file: changedSource })
  const changedDb = new DatabaseSync(changedSource)
  try { changedDb.exec("UPDATE marker SET value='new';") } finally { changedDb.close() }
  const staleReceipt = backupReceiptFor(changedSource, '5')
  staleReceipt.artifact = staleIdentity
  await assert.rejects(() => createMeasuredApfsClone({
    sourceIntegrityReceipt: staleReceipt,
    sourceIntegrityReceiptSha256: stableSha256(staleReceipt),
    candidatePath: path.join(root, 'changed-candidate.sqlite'),
    cloneExecutablePath: executable,
    cloneExecutableSha256: sha256File(executable),
    writerBarrierReceiptSha256: '1'.repeat(64),
    capacity: {
      maximumInitialAllocationBytes: 64 * 1024 * 1024,
      maximumCowGrowthBytes: 64 * 1024 * 1024,
      failedStateRetentionBytes: 64 * 1024 * 1024,
      minimumReserveBytes: 1,
    },
    timeoutMs: 30_000,
    sha256File,
    assertWriterBarrierValid: async () => {},
  }), /SQLITE_(?:CLONE_SOURCE|ARTIFACT)_IDENTITY_CHANGED/)

  assert.throws(() => createRestoreIdentityReceipt({
    transactionId: 'other-transaction',
    createdAt: new Date().toISOString(),
    artifact: sqliteArtifactIdentity({ file: restored }),
    inheritedReceipt: backupReceipt,
    inheritedReceiptSha256: backupReceiptSha256,
    measurementEvidenceSha256: '3'.repeat(64),
    sourceGeneration: 'source-original',
    servingGeneration: 'serving-original',
    hashElapsedMs: 2,
  }), /SQLITE_RESTORE_INHERITED_RECEIPT_INVALID/)
  assert.throws(() => createFullSqliteIntegrityReceipt({
    kind: 'BACKUP_COMPLETE',
    transactionId: 'fixture-clone',
    createdAt: new Date().toISOString(),
    artifact: sourceIdentity,
    measurementEvidenceSha256: '7'.repeat(64),
    quickCheckResult: 'not ok',
    quickCheckElapsedMs: 1,
    sourceGeneration: 'source-original',
    servingGeneration: 'serving-original',
    guarantees: ['fixture'],
    limitations: ['fixture'],
  }), /SQLITE_RECEIPT_FULL_CHECK_REQUIRED/)
  assert.throws(() => assertSqliteIntegrityReceipt({} as never), /SQLITE_INTEGRITY_RECEIPT_INVALID/)

  console.log('SQLite integrity receipt and clone-only APFS candidate tests passed')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
