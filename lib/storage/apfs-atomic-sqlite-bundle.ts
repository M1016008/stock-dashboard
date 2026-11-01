import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { stableSha256 } from '@/lib/jp-ohlcv-data-quality'

const SHA256 = /^[a-f0-9]{64}$/
const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/

export type SqliteBundleMember = {
  file: string
  device: string
  inode: string
  sizeBytes: number
  mtimeNs: string
  ctimeNs: string
  sha256: string
}

export type SqliteBundleManifest = {
  version: 1
  kind: 'JP_OHLCV_SQLITE_BUNDLE'
  bundleId: string
  transactionId: string
  createdAt: string
  sourceGeneration: string
  servingGeneration: string
  journalMode: 'delete' | 'wal'
  database: SqliteBundleMember
  wal: SqliteBundleMember | null
  shm: SqliteBundleMember | null
  integrityReceiptSha256: string
  manifestSha256: string
}

export type AtomicBundleActivationJournal = {
  version: 1
  kind: 'JP_OHLCV_ATOMIC_BUNDLE_ACTIVATION'
  transactionId: string
  activePath: string
  candidatePath: string
  oldManifestSha256: string
  newManifestSha256: string
  phase: 'PREPARED' | 'SWAP_INTENT' | 'SWAPPED' | 'GENERATION_RECONCILED' | 'COMMITTED' | 'HOLD'
  createdAt: string
  updatedAt: string
  journalSha256: string
}

export type AtomicBundlePosition = 'OLD_ACTIVE' | 'NEW_ACTIVE' | 'AMBIGUOUS'

export function sha256SqliteBundleFile(file: string): string {
  const hash = createHash('sha256')
  const descriptor = fs.openSync(file, 'r')
  const buffer = Buffer.allocUnsafe(8 * 1024 * 1024)
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

function manifestBody(manifest: SqliteBundleManifest): Omit<SqliteBundleManifest, 'manifestSha256'> {
  const { manifestSha256: _manifestSha256, ...body } = manifest
  return body
}

function assertOptionalIntegrityReceiptIdentity(bundlePath: string, manifest: SqliteBundleManifest): void {
  const file = path.join(bundlePath, 'integrity-receipt.json')
  if (!fs.existsSync(file)) return
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(file) !== file) {
    throw new Error('SQLITE_BUNDLE_INTEGRITY_RECEIPT_FILE_INVALID')
  }
  const receipt = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
  const { receiptSha256, ...body } = receipt
  if (receiptSha256 !== manifest.integrityReceiptSha256
    || stableSha256(body) !== receiptSha256) {
    throw new Error('SQLITE_BUNDLE_INTEGRITY_RECEIPT_IDENTITY_MISMATCH')
  }
}

function journalBody(journal: AtomicBundleActivationJournal): Omit<AtomicBundleActivationJournal, 'journalSha256'> {
  const { journalSha256: _journalSha256, ...body } = journal
  return body
}

function assertMemberMetadata(bundlePath: string, member: SqliteBundleMember, expectedFile: string): void {
  if (member.file !== expectedFile || !Number.isSafeInteger(member.sizeBytes) || member.sizeBytes <= 0
    || !member.device || !member.inode || !member.mtimeNs || !member.ctimeNs || !SHA256.test(member.sha256)) {
    throw new Error(`SQLITE_BUNDLE_MEMBER_INVALID:${expectedFile}`)
  }
  const file = path.join(bundlePath, member.file)
  const stat = fs.lstatSync(file, { bigint: true })
  if (!stat.isFile() || stat.isSymbolicLink()
    || fs.realpathSync(file) !== file || String(stat.dev) !== member.device
    || String(stat.ino) !== member.inode || Number(stat.size) !== member.sizeBytes
    || String(stat.mtimeNs) !== member.mtimeNs || String(stat.ctimeNs) !== member.ctimeNs) {
    throw new Error(`SQLITE_BUNDLE_MEMBER_IDENTITY_MISMATCH:${expectedFile}`)
  }
}

function assertMemberHash(bundlePath: string, member: SqliteBundleMember): void {
  if (sha256SqliteBundleFile(path.join(bundlePath, member.file)) !== member.sha256) {
    throw new Error(`SQLITE_BUNDLE_MEMBER_HASH_MISMATCH:${member.file}`)
  }
}

function observedJournalMode(databasePath: string): 'delete' | 'wal' {
  const descriptor = fs.openSync(databasePath, 'r')
  const header = Buffer.alloc(20)
  try {
    if (fs.readSync(descriptor, header, 0, header.length, 0) !== header.length
      || header.subarray(0, 16).toString('binary') !== 'SQLite format 3\u0000') {
      throw new Error('SQLITE_BUNDLE_DATABASE_HEADER_INVALID')
    }
  } finally {
    fs.closeSync(descriptor)
  }
  if (header[18] === 1 && header[19] === 1) return 'delete'
  if (header[18] === 2 && header[19] === 2) return 'wal'
  throw new Error(`SQLITE_BUNDLE_JOURNAL_MODE_UNSUPPORTED:${header[18]}:${header[19]}`)
}

export function readSqliteBundleManifest(bundlePath: string): SqliteBundleManifest {
  const file = path.join(bundlePath, 'bundle.json')
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(file) !== file) {
    throw new Error('SQLITE_BUNDLE_MANIFEST_FILE_INVALID')
  }
  return JSON.parse(fs.readFileSync(file, 'utf8')) as SqliteBundleManifest
}

export function createSqliteBundleManifest(input: {
  bundlePath: string
  bundleId: string
  transactionId: string
  createdAt: string
  sourceGeneration: string
  servingGeneration: string
  journalMode: 'delete' | 'wal'
  integrityReceiptSha256: string
}): SqliteBundleManifest {
  const member = (file: string): SqliteBundleMember | null => {
    const target = path.join(input.bundlePath, file)
    try {
      const stat = fs.lstatSync(target, { bigint: true })
      if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(target) !== target) {
        throw new Error(`SQLITE_BUNDLE_MEMBER_INVALID:${file}`)
      }
      return {
        file,
        device: String(stat.dev),
        inode: String(stat.ino),
        sizeBytes: Number(stat.size),
        mtimeNs: String(stat.mtimeNs),
        ctimeNs: String(stat.ctimeNs),
        sha256: sha256SqliteBundleFile(target),
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }
  const database = member('stockboard.db')
  if (!database) throw new Error('SQLITE_BUNDLE_DATABASE_REQUIRED')
  const body = {
    version: 1 as const,
    kind: 'JP_OHLCV_SQLITE_BUNDLE' as const,
    bundleId: input.bundleId,
    transactionId: input.transactionId,
    createdAt: input.createdAt,
    sourceGeneration: input.sourceGeneration,
    servingGeneration: input.servingGeneration,
    journalMode: input.journalMode,
    database,
    wal: member('stockboard.db-wal'),
    shm: member('stockboard.db-shm'),
    integrityReceiptSha256: input.integrityReceiptSha256,
  }
  const manifest = { ...body, manifestSha256: stableSha256(body) }
  assertSqliteBundleManifest(input.bundlePath, manifest)
  return manifest
}

export function assertSqliteBundleManifest(bundlePath: string, manifest: SqliteBundleManifest): void {
  assertSqliteBundleMetadata(bundlePath, manifest)
  assertMemberHash(bundlePath, manifest.database)
  if (manifest.wal) assertMemberHash(bundlePath, manifest.wal)
  if (manifest.shm) assertMemberHash(bundlePath, manifest.shm)
}

export function assertSqliteBundleMetadata(bundlePath: string, manifest: SqliteBundleManifest): void {
  const stat = fs.lstatSync(bundlePath)
  if (!path.isAbsolute(bundlePath) || !stat.isDirectory() || stat.isSymbolicLink()
    || fs.realpathSync(bundlePath) !== bundlePath || manifest.version !== 1
    || manifest.kind !== 'JP_OHLCV_SQLITE_BUNDLE' || !BUNDLE_ID.test(manifest.bundleId)
    || !BUNDLE_ID.test(manifest.transactionId) || !Number.isFinite(Date.parse(manifest.createdAt))
    || !manifest.sourceGeneration || !manifest.servingGeneration
    || !['delete', 'wal'].includes(manifest.journalMode)
    || !SHA256.test(manifest.integrityReceiptSha256)
    || stableSha256(manifestBody(manifest)) !== manifest.manifestSha256) {
    throw new Error('SQLITE_BUNDLE_MANIFEST_INVALID')
  }
  if ((manifest.wal === null) !== (manifest.shm === null)) {
    throw new Error('SQLITE_BUNDLE_SIDECAR_PAIR_REQUIRED')
  }
  if (manifest.journalMode === 'delete' && (manifest.wal !== null || manifest.shm !== null)) {
    throw new Error('SQLITE_BUNDLE_DELETE_MODE_SIDECAR_PRESENT')
  }
  const allowedEntries = new Set(['stockboard.db', 'bundle.json'])
  if (fs.existsSync(path.join(bundlePath, 'integrity-receipt.json'))) {
    allowedEntries.add('integrity-receipt.json')
  }
  if (fs.existsSync(path.join(bundlePath, 'sqlite-integrity-receipt.json'))) {
    allowedEntries.add('sqlite-integrity-receipt.json')
  }
  if (manifest.wal) allowedEntries.add('stockboard.db-wal')
  if (manifest.shm) allowedEntries.add('stockboard.db-shm')
  const unexpected = fs.readdirSync(bundlePath).filter((entry) => !allowedEntries.has(entry))
  if (unexpected.length > 0) throw new Error(`SQLITE_BUNDLE_UNEXPECTED_ENTRY:${unexpected.sort().join(',')}`)
  assertOptionalIntegrityReceiptIdentity(bundlePath, manifest)
  assertMemberMetadata(bundlePath, manifest.database, 'stockboard.db')
  if (manifest.wal) assertMemberMetadata(bundlePath, manifest.wal, 'stockboard.db-wal')
  if (manifest.shm) assertMemberMetadata(bundlePath, manifest.shm, 'stockboard.db-shm')
  if (observedJournalMode(path.join(bundlePath, manifest.database.file)) !== manifest.journalMode) {
    throw new Error('SQLITE_BUNDLE_JOURNAL_MODE_MISMATCH')
  }
}

export function createAtomicBundleActivationJournal(input: Omit<
  AtomicBundleActivationJournal,
  'version' | 'kind' | 'phase' | 'journalSha256'
>): AtomicBundleActivationJournal {
  const body = {
    version: 1 as const,
    kind: 'JP_OHLCV_ATOMIC_BUNDLE_ACTIVATION' as const,
    ...input,
    phase: 'PREPARED' as const,
  }
  const journal = { ...body, journalSha256: stableSha256(body) }
  assertAtomicBundleActivationJournal(journal)
  return journal
}

export function advanceAtomicBundleActivationJournal(
  current: AtomicBundleActivationJournal,
  phase: Exclude<AtomicBundleActivationJournal['phase'], 'PREPARED'>,
  updatedAt: string,
): AtomicBundleActivationJournal {
  assertAtomicBundleActivationJournal(current)
  const allowed: Record<AtomicBundleActivationJournal['phase'], AtomicBundleActivationJournal['phase'][]> = {
    PREPARED: ['SWAP_INTENT', 'HOLD'],
    SWAP_INTENT: ['SWAPPED', 'HOLD'],
    SWAPPED: ['GENERATION_RECONCILED', 'HOLD'],
    GENERATION_RECONCILED: ['COMMITTED', 'HOLD'],
    COMMITTED: [],
    HOLD: [],
  }
  if (!allowed[current.phase].includes(phase) || Date.parse(updatedAt) < Date.parse(current.updatedAt)) {
    throw new Error(`SQLITE_BUNDLE_ACTIVATION_TRANSITION_INVALID:${current.phase}:${phase}`)
  }
  const { version: _version, kind: _kind, journalSha256: _journalSha256, phase: _phase, ...input } = current
  const body = { version: 1 as const, kind: 'JP_OHLCV_ATOMIC_BUNDLE_ACTIVATION' as const, ...input, phase, updatedAt }
  const next = { ...body, journalSha256: stableSha256(body) }
  assertAtomicBundleActivationJournal(next)
  return next
}

export function assertAtomicBundleActivationJournal(journal: AtomicBundleActivationJournal): void {
  if (journal.version !== 1 || journal.kind !== 'JP_OHLCV_ATOMIC_BUNDLE_ACTIVATION'
    || !BUNDLE_ID.test(journal.transactionId) || !path.isAbsolute(journal.activePath)
    || !path.isAbsolute(journal.candidatePath)
    || path.dirname(journal.activePath) !== path.dirname(journal.candidatePath)
    || journal.activePath === journal.candidatePath || !SHA256.test(journal.oldManifestSha256)
    || !SHA256.test(journal.newManifestSha256)
    || journal.oldManifestSha256 === journal.newManifestSha256
    || !['PREPARED', 'SWAP_INTENT', 'SWAPPED', 'GENERATION_RECONCILED', 'COMMITTED', 'HOLD'].includes(journal.phase)
    || !Number.isFinite(Date.parse(journal.createdAt)) || !Number.isFinite(Date.parse(journal.updatedAt))
    || Date.parse(journal.updatedAt) < Date.parse(journal.createdAt)
    || stableSha256(journalBody(journal)) !== journal.journalSha256) {
    throw new Error('SQLITE_BUNDLE_ACTIVATION_JOURNAL_INVALID')
  }
}

export function classifyAtomicBundlePosition(input: {
  journal: AtomicBundleActivationJournal
  activeManifest: SqliteBundleManifest
  candidateManifest: SqliteBundleManifest
}): AtomicBundlePosition {
  assertAtomicBundleActivationJournal(input.journal)
  const active = input.activeManifest.manifestSha256
  const candidate = input.candidateManifest.manifestSha256
  if (active === input.journal.oldManifestSha256 && candidate === input.journal.newManifestSha256) {
    return 'OLD_ACTIVE'
  }
  if (active === input.journal.newManifestSha256 && candidate === input.journal.oldManifestSha256) {
    return 'NEW_ACTIVE'
  }
  return 'AMBIGUOUS'
}

export function assertActiveBundlePublication(input: {
  journal: AtomicBundleActivationJournal
  activeManifest: SqliteBundleManifest
  candidateManifest: SqliteBundleManifest
  sourceGeneration: string
  servingGeneration: string
  activeDatabaseHandleCount: number
}): void {
  assertSqliteBundleMetadata(input.journal.activePath, input.activeManifest)
  assertSqliteBundleMetadata(input.journal.candidatePath, input.candidateManifest)
  if (stableSha256(readSqliteBundleManifest(input.journal.activePath)) !== stableSha256(input.activeManifest)
    || stableSha256(readSqliteBundleManifest(input.journal.candidatePath)) !== stableSha256(input.candidateManifest)) {
    throw new Error('SQLITE_BUNDLE_ON_DISK_MANIFEST_MISMATCH')
  }
  const position = classifyAtomicBundlePosition(input)
  if (!['GENERATION_RECONCILED', 'COMMITTED'].includes(input.journal.phase)
    || position !== 'NEW_ACTIVE' || input.activeDatabaseHandleCount !== 0
    || input.sourceGeneration !== input.activeManifest.sourceGeneration
    || input.servingGeneration !== input.activeManifest.servingGeneration) {
    throw new Error('SQLITE_BUNDLE_PUBLICATION_NOT_RECONCILED')
  }
}

export function executeAtomicBundleSwap(input: {
  journal: AtomicBundleActivationJournal
  activeManifest: SqliteBundleManifest
  candidateManifest: SqliteBundleManifest
  executablePath: string
  executableSha256: string
  timeoutMs: number
  assertReaderWriterBarrierValid: () => void
}): { elapsedMs: number; position: 'NEW_ACTIVE' } {
  assertAtomicBundleActivationJournal(input.journal)
  if (input.journal.phase !== 'SWAP_INTENT'
    || classifyAtomicBundlePosition(input) !== 'OLD_ACTIVE'
    || input.candidateManifest.journalMode !== 'delete'
    || input.candidateManifest.wal !== null
    || input.candidateManifest.shm !== null
    || !SHA256.test(input.executableSha256)
    || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new Error('SQLITE_BUNDLE_SWAP_PRECONDITION_INVALID')
  }
  assertSqliteBundleMetadata(input.journal.activePath, input.activeManifest)
  assertSqliteBundleMetadata(input.journal.candidatePath, input.candidateManifest)
  if (stableSha256(readSqliteBundleManifest(input.journal.activePath)) !== stableSha256(input.activeManifest)
    || stableSha256(readSqliteBundleManifest(input.journal.candidatePath)) !== stableSha256(input.candidateManifest)) {
    throw new Error('SQLITE_BUNDLE_ON_DISK_MANIFEST_MISMATCH')
  }
  const executable = fs.lstatSync(input.executablePath)
  if (!path.isAbsolute(input.executablePath) || !executable.isFile() || executable.isSymbolicLink()
    || fs.realpathSync(input.executablePath) !== input.executablePath
    || (executable.mode & 0o111) === 0 || (executable.mode & 0o022) !== 0
    || (executable.uid !== 0 && executable.uid !== (process.getuid?.() ?? -1))
    || sha256SqliteBundleFile(input.executablePath) !== input.executableSha256) {
    throw new Error('SQLITE_BUNDLE_SWAP_EXECUTABLE_INVALID')
  }
  input.assertReaderWriterBarrierValid()
  const started = Date.now()
  const result = spawnSync(input.executablePath, [
    '--swap', input.journal.activePath, input.journal.candidatePath,
  ], {
    encoding: 'utf8',
    timeout: input.timeoutMs,
    env: { NODE_ENV: process.env.NODE_ENV ?? 'production', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
  })
  if (result.error || result.status !== 0) {
    throw new Error(`SQLITE_BUNDLE_SWAP_FAILED:${result.status}:${result.signal}:${result.error?.message ?? result.stderr.trim()}`)
  }
  input.assertReaderWriterBarrierValid()
  const activeManifest = readSqliteBundleManifest(input.journal.activePath)
  const candidateManifest = readSqliteBundleManifest(input.journal.candidatePath)
  assertSqliteBundleMetadata(input.journal.activePath, activeManifest)
  assertSqliteBundleMetadata(input.journal.candidatePath, candidateManifest)
  if (classifyAtomicBundlePosition({ journal: input.journal, activeManifest, candidateManifest }) !== 'NEW_ACTIVE') {
    throw new Error('SQLITE_BUNDLE_SWAP_POSTCONDITION_INVALID')
  }
  return { elapsedMs: Date.now() - started, position: 'NEW_ACTIVE' }
}
