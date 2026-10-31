import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { stableSha256 } from '@/lib/jp-ohlcv-data-quality'
import {
  assertSqliteArtifactIdentityMatchesFile,
  assertSqliteIntegrityReceipt,
  sqliteArtifactIdentity,
  type SqliteArtifactIdentity,
  type SqliteIntegrityReceipt,
} from '@/lib/storage/sqlite-integrity-contract'

const SHA256 = /^[a-f0-9]{64}$/

export type ApfsCloneEvidence = {
  source: SqliteArtifactIdentity
  candidate: SqliteArtifactIdentity
  logicalBytes: number
  cloneExecutableRealpath: string
  cloneExecutableSha256: string
  writerBarrierReceiptSha256: string
  sourceIntegrityReceiptSha256: string
  freeBytesBefore: number
  freeBytesAfter: number
  observedFreeSpaceDeltaBytes: number
  maximumInitialAllocationBytes: number
  elapsedMs: number
  limitations: string[]
}

function assertRegularRealpath(file: string): fs.BigIntStats {
  if (!path.isAbsolute(file)) throw new Error('SQLITE_CLONE_ABSOLUTE_PATH_REQUIRED')
  const stat = fs.lstatSync(file, { bigint: true })
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`SQLITE_CLONE_REGULAR_FILE_REQUIRED:${file}`)
  if (fs.realpathSync(file) !== file) throw new Error(`SQLITE_CLONE_REALPATH_REQUIRED:${file}`)
  return stat
}

function pathEntryExists(file: string): boolean {
  try {
    fs.lstatSync(file)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function assertNoSidecars(file: string): void {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    if (pathEntryExists(`${file}${suffix}`)) throw new Error(`SQLITE_CLONE_SIDECAR_PRESENT:${file}${suffix}`)
  }
}

function freeBytes(file: string): number {
  const stat = fs.statfsSync(path.dirname(file), { bigint: true })
  const bytes = stat.bsize * stat.bavail
  if (bytes > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('SQLITE_CLONE_FREE_BYTES_UNSAFE')
  return Number(bytes)
}

function assertArtifactMatchesFile(artifact: SqliteArtifactIdentity, stat: fs.BigIntStats): void {
  if (artifact.realpath !== fs.realpathSync(artifact.realpath)
    || artifact.device !== String(stat.dev)
    || artifact.inode !== String(stat.ino)
    || artifact.sizeBytes !== Number(stat.size)
    || artifact.mtimeNs !== String(stat.mtimeNs)
    || artifact.ctimeNs !== String(stat.ctimeNs)
    || !SHA256.test(artifact.sha256)) {
    throw new Error('SQLITE_CLONE_SOURCE_IDENTITY_CHANGED')
  }
}

export function assertApfsCandidateCapacity(input: {
  availableBytes: number
  maximumInitialAllocationBytes: number
  maximumCowGrowthBytes: number
  failedStateRetentionBytes: number
  minimumReserveBytes: number
}): { requiredBytes: number; remainingBytes: number } {
  const values = Object.values(input)
  if (!values.every(Number.isSafeInteger) || values.some((value) => value < 0)) {
    throw new Error('SQLITE_CLONE_CAPACITY_INPUT_INVALID')
  }
  if (input.maximumInitialAllocationBytes === 0
    || input.maximumCowGrowthBytes === 0
    || input.minimumReserveBytes === 0) {
    throw new Error('SQLITE_CLONE_CAPACITY_BUDGET_REQUIRED')
  }
  const requiredBytes = input.maximumInitialAllocationBytes
    + input.maximumCowGrowthBytes
    + input.failedStateRetentionBytes
    + input.minimumReserveBytes
  if (!Number.isSafeInteger(requiredBytes)) throw new Error('SQLITE_CLONE_CAPACITY_SUM_UNSAFE')
  const remainingBytes = input.availableBytes - requiredBytes
  if (!Number.isSafeInteger(remainingBytes) || remainingBytes < 0) {
    throw new Error(`SQLITE_CLONE_CAPACITY_INSUFFICIENT:${input.availableBytes}:${requiredBytes}`)
  }
  return { requiredBytes, remainingBytes }
}

export async function createMeasuredApfsClone(input: {
  sourceIntegrityReceipt: SqliteIntegrityReceipt
  sourceIntegrityReceiptSha256: string
  candidatePath: string
  cloneExecutablePath: string
  cloneExecutableSha256: string
  writerBarrierReceiptSha256: string
  capacity: {
    maximumInitialAllocationBytes: number
    maximumCowGrowthBytes: number
    failedStateRetentionBytes: number
    minimumReserveBytes: number
  }
  timeoutMs: number
  sha256File: (file: string) => string
  assertWriterBarrierValid: () => Promise<void>
}): Promise<ApfsCloneEvidence> {
  if (!SHA256.test(input.cloneExecutableSha256)
    || !SHA256.test(input.writerBarrierReceiptSha256)
    || !SHA256.test(input.sourceIntegrityReceiptSha256)
    || !Number.isSafeInteger(input.timeoutMs)
    || input.timeoutMs <= 0) {
    throw new Error('SQLITE_CLONE_INPUT_INVALID')
  }
  assertSqliteIntegrityReceipt(input.sourceIntegrityReceipt)
  if (input.sourceIntegrityReceipt.kind !== 'BACKUP_COMPLETE'
    || stableSha256(input.sourceIntegrityReceipt) !== input.sourceIntegrityReceiptSha256) {
    throw new Error('SQLITE_CLONE_SOURCE_RECEIPT_INVALID')
  }
  const source = input.sourceIntegrityReceipt.artifact
  assertSqliteArtifactIdentityMatchesFile(source)
  const sourceBefore = assertRegularRealpath(source.realpath)
  assertArtifactMatchesFile(source, sourceBefore)
  assertNoSidecars(source.realpath)
  await input.assertWriterBarrierValid()
  const executable = assertRegularRealpath(input.cloneExecutablePath)
  if ((executable.mode & BigInt(0o111)) === BigInt(0)) throw new Error('SQLITE_CLONE_EXECUTABLE_REQUIRED')
  if ((executable.mode & BigInt(0o022)) !== BigInt(0)
    || (executable.uid !== BigInt(0) && executable.uid !== BigInt(process.getuid?.() ?? -1))) {
    throw new Error('SQLITE_CLONE_EXECUTABLE_PERMISSIONS_INVALID')
  }
  const executableParent = fs.lstatSync(path.dirname(input.cloneExecutablePath), { bigint: true })
  if (!executableParent.isDirectory()
    || (executableParent.mode & BigInt(0o022)) !== BigInt(0)
    || (executableParent.uid !== BigInt(0) && executableParent.uid !== BigInt(process.getuid?.() ?? -1))) {
    throw new Error('SQLITE_CLONE_EXECUTABLE_DIRECTORY_PERMISSIONS_INVALID')
  }
  if (input.sha256File(input.cloneExecutablePath) !== input.cloneExecutableSha256) {
    throw new Error('SQLITE_CLONE_EXECUTABLE_HASH_MISMATCH')
  }
  if (!path.isAbsolute(input.candidatePath)
    || path.dirname(input.candidatePath) !== path.dirname(source.realpath)
    || /-(?:wal|shm|journal)$/.test(path.basename(input.candidatePath))
    || pathEntryExists(input.candidatePath)) {
    throw new Error('SQLITE_CLONE_CANDIDATE_PATH_INVALID')
  }
  assertNoSidecars(input.candidatePath)

  const before = freeBytes(input.candidatePath)
  assertApfsCandidateCapacity({ availableBytes: before, ...input.capacity })
  const started = Date.now()
  const result = spawnSync(input.cloneExecutablePath, [source.realpath, input.candidatePath], {
    encoding: 'utf8',
    timeout: input.timeoutMs,
    env: {
      NODE_ENV: process.env.NODE_ENV ?? 'production',
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    },
  })
  if (result.error || result.status !== 0) {
    let orphan = 'absent'
    try {
      const candidate = fs.lstatSync(input.candidatePath, { bigint: true })
      if (candidate.isFile() && !candidate.isSymbolicLink()
        && candidate.dev === sourceBefore.dev && candidate.size === sourceBefore.size) {
        fs.rmSync(input.candidatePath)
        orphan = 'removed'
      } else {
        orphan = 'preserved-ambiguous'
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') orphan = 'preserved-inspection-failed'
    }
    throw new Error(`SQLITE_APFS_CLONE_FAILED:${result.status}:${result.signal}:${orphan}:${result.error?.message ?? result.stderr.trim()}`)
  }

  try {
    const executableAfter = assertRegularRealpath(input.cloneExecutablePath)
    if (executable.dev !== executableAfter.dev
      || executable.ino !== executableAfter.ino
      || executable.size !== executableAfter.size
      || executable.mtimeNs !== executableAfter.mtimeNs
      || executable.ctimeNs !== executableAfter.ctimeNs
      || input.sha256File(input.cloneExecutablePath) !== input.cloneExecutableSha256) {
      throw new Error('SQLITE_CLONE_EXECUTABLE_CHANGED')
    }
    const sourceAfter = assertRegularRealpath(source.realpath)
    assertArtifactMatchesFile(source, sourceAfter)
    assertNoSidecars(source.realpath)
    assertNoSidecars(input.candidatePath)
    await input.assertWriterBarrierValid()
    const candidateStat = assertRegularRealpath(input.candidatePath)
    if (candidateStat.dev !== sourceAfter.dev
      || candidateStat.ino === sourceAfter.ino
      || candidateStat.size !== sourceAfter.size) {
      throw new Error('SQLITE_CLONE_RESULT_IDENTITY_MISMATCH')
    }
    const candidate = sqliteArtifactIdentity({ file: input.candidatePath, deadlineMs: started + input.timeoutMs })
    if (candidate.sha256 !== source.sha256) throw new Error('SQLITE_CLONE_CONTENT_HASH_MISMATCH')
    const after = freeBytes(input.candidatePath)
    const observedFreeSpaceDeltaBytes = before - after
    if (observedFreeSpaceDeltaBytes > input.capacity.maximumInitialAllocationBytes
      || after < input.capacity.minimumReserveBytes) {
      throw new Error(`SQLITE_CLONE_ALLOCATION_LIMIT_EXCEEDED:${observedFreeSpaceDeltaBytes}:${after}`)
    }
    return {
      source: { ...source },
      candidate,
      logicalBytes: Number(candidateStat.size),
      cloneExecutableRealpath: input.cloneExecutablePath,
      cloneExecutableSha256: input.cloneExecutableSha256,
      writerBarrierReceiptSha256: input.writerBarrierReceiptSha256,
      sourceIntegrityReceiptSha256: input.sourceIntegrityReceiptSha256,
      freeBytesBefore: before,
      freeBytesAfter: after,
      observedFreeSpaceDeltaBytes,
      maximumInitialAllocationBytes: input.capacity.maximumInitialAllocationBytes,
      elapsedMs: Date.now() - started,
      limitations: [
        'statfs deltas are filesystem-wide observations and are not a per-file physical allocation measurement',
        'the caller must continue to enforce the sealed writer barrier while this candidate is mutated and verified',
      ],
    }
  } catch (error) {
    try {
      const candidate = fs.lstatSync(input.candidatePath, { bigint: true })
      if (candidate.isFile() && !candidate.isSymbolicLink()
        && candidate.dev === sourceBefore.dev && candidate.size === sourceBefore.size) {
        fs.rmSync(input.candidatePath)
      }
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new AggregateError([error, cleanupError], 'SQLITE_CLONE_POSTCHECK_AND_CLEANUP_FAILED')
      }
    }
    throw error
  }
}
