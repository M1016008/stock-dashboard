import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { stableSha256 } from '@/lib/jp-ohlcv-data-quality'
import {
  advanceAtomicBundleActivationJournal,
  assertAtomicBundleActivationJournal,
  assertSqliteBundleManifest,
  assertSqliteBundleMetadata,
  classifyAtomicBundlePosition,
  executeAtomicBundleSwap,
  readSqliteBundleManifest,
  sha256SqliteBundleFile,
  type AtomicBundleActivationJournal,
  type AtomicBundlePosition,
  type SqliteBundleManifest,
} from '@/lib/storage/apfs-atomic-sqlite-bundle'

const SHA256 = /^[a-f0-9]{64}$/
export const SQLITE_BUNDLE_INTEGRITY_RECEIPT = 'integrity-receipt.json'

export type SqliteBundleIntegrityReceipt = {
  version: 1
  kind: 'JP_OHLCV_SQLITE_BUNDLE_INTEGRITY'
  transactionId: string
  bundleId: string
  completedAt: string
  sourceGeneration: string
  servingGeneration: string
  cacheGeneration: string
  journalMode: 'delete' | 'wal'
  databaseSha256: string
  walSha256: string | null
  shmSha256: string | null
  fullQuickCheck: 'ok'
  fullQuickCheckReceiptSha256: string
  receiptSha256: string
}

export type DurableActivationWriteCheckpoint =
  | 'PENDING_FILE_FSYNC'
  | 'PENDING_DIRECTORY_FSYNC'
  | 'JOURNAL_FILE_FSYNC'
  | 'JOURNAL_RENAME'
  | 'JOURNAL_DIRECTORY_FSYNC'
  | 'PENDING_REMOVE_DIRECTORY_FSYNC'

export type DurableActivationJournalRead = {
  journal: AtomicBundleActivationJournal
  fileSha256: string
  durabilityIssues: string[]
}

export type DurableActivationObservation = DurableActivationJournalRead & {
  position: AtomicBundlePosition
  activeManifest: SqliteBundleManifest
  candidateManifest: SqliteBundleManifest
  activeReceipt: SqliteBundleIntegrityReceipt
  candidateReceipt: SqliteBundleIntegrityReceipt
}

function receiptBody(receipt: SqliteBundleIntegrityReceipt): Omit<SqliteBundleIntegrityReceipt, 'receiptSha256'> {
  const { receiptSha256: _receiptSha256, ...body } = receipt
  return body
}

function sha256Bytes(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function assertRealDirectory(directory: string): void {
  const stat = fs.lstatSync(directory)
  if (!path.isAbsolute(directory) || !stat.isDirectory() || stat.isSymbolicLink()
    || fs.realpathSync(directory) !== directory) {
    throw new Error('SQLITE_BUNDLE_DURABLE_DIRECTORY_INVALID')
  }
}

function syncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, 'r')
  try { fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
}

function immutableJson(file: string, payload: unknown): void {
  assertRealDirectory(path.dirname(file))
  const bytes = `${JSON.stringify(payload, null, 2)}\n`
  const descriptor = fs.openSync(file, 'wx', 0o600)
  try {
    fs.writeFileSync(descriptor, bytes)
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
  syncDirectory(path.dirname(file))
  if (fs.readFileSync(file, 'utf8') !== bytes) throw new Error('SQLITE_BUNDLE_DURABLE_READBACK_MISMATCH')
}

function assertJournalPath(journalPath: string, journal: AtomicBundleActivationJournal): void {
  if (!path.isAbsolute(journalPath)) throw new Error('SQLITE_BUNDLE_DURABLE_JOURNAL_PATH_INVALID')
  const resolved = path.resolve(journalPath)
  for (const bundlePath of [journal.activePath, journal.candidatePath]) {
    const relative = path.relative(bundlePath, resolved)
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
      throw new Error('SQLITE_BUNDLE_DURABLE_JOURNAL_INSIDE_BUNDLE')
    }
  }
  assertRealDirectory(path.dirname(resolved))
}

function journalArtifacts(journalPath: string): { pending: string; temporaryPrefix: string } {
  return {
    pending: `${journalPath}.pending`,
    temporaryPrefix: `${path.basename(journalPath)}.tmp-`,
  }
}

function listDurabilityIssues(journalPath: string): string[] {
  const { pending, temporaryPrefix } = journalArtifacts(journalPath)
  const issues: string[] = []
  if (fs.existsSync(pending)) issues.push('PENDING_WRITE_INTENT_PRESENT')
  const temporaries = fs.readdirSync(path.dirname(journalPath))
    .filter((entry) => entry.startsWith(temporaryPrefix)).sort()
  if (temporaries.length > 0) issues.push(`TEMPORARY_JOURNAL_PRESENT:${temporaries.join(',')}`)
  return issues
}

function assertJournalFile(file: string): AtomicBundleActivationJournal {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(file) !== file
    || (stat.mode & 0o022) !== 0) {
    throw new Error('SQLITE_BUNDLE_DURABLE_JOURNAL_FILE_INVALID')
  }
  const journal = JSON.parse(fs.readFileSync(file, 'utf8')) as AtomicBundleActivationJournal
  assertAtomicBundleActivationJournal(journal)
  assertJournalPath(file, journal)
  return journal
}

function durableReplaceJournal(input: {
  journalPath: string
  previousJournalSha256: string | null
  journal: AtomicBundleActivationJournal
  checkpoint?: (checkpoint: DurableActivationWriteCheckpoint) => void
}): DurableActivationJournalRead {
  assertAtomicBundleActivationJournal(input.journal)
  assertJournalPath(input.journalPath, input.journal)
  if (listDurabilityIssues(input.journalPath).length > 0) {
    throw new Error('SQLITE_BUNDLE_DURABLE_JOURNAL_ARTIFACT_PRESENT')
  }
  const journalExists = fs.existsSync(input.journalPath)
  if ((input.previousJournalSha256 === null) !== !journalExists) {
    throw new Error('SQLITE_BUNDLE_DURABLE_JOURNAL_EXISTENCE_MISMATCH')
  }
  if (journalExists) {
    const current = readDurableActivationJournal(input.journalPath)
    if (current.durabilityIssues.length > 0 || current.journal.journalSha256 !== input.previousJournalSha256) {
      throw new Error('SQLITE_BUNDLE_DURABLE_JOURNAL_CAS_MISMATCH')
    }
  }

  const directory = path.dirname(input.journalPath)
  const { pending, temporaryPrefix } = journalArtifacts(input.journalPath)
  const temporary = path.join(directory, `${temporaryPrefix}${input.journal.journalSha256}`)
  const intentBody = {
    version: 1,
    kind: 'JP_OHLCV_ATOMIC_BUNDLE_JOURNAL_WRITE_INTENT',
    journalPath: input.journalPath,
    previousJournalSha256: input.previousJournalSha256,
    nextJournalSha256: input.journal.journalSha256,
    nextPhase: input.journal.phase,
  }
  const intent = { ...intentBody, intentSha256: stableSha256(intentBody) }
  const pendingDescriptor = fs.openSync(pending, 'wx', 0o600)
  try {
    fs.writeFileSync(pendingDescriptor, `${JSON.stringify(intent, null, 2)}\n`)
    input.checkpoint?.('PENDING_FILE_FSYNC')
    fs.fsyncSync(pendingDescriptor)
  } finally {
    fs.closeSync(pendingDescriptor)
  }
  input.checkpoint?.('PENDING_DIRECTORY_FSYNC')
  syncDirectory(directory)

  const bytes = `${JSON.stringify(input.journal, null, 2)}\n`
  const descriptor = fs.openSync(temporary, 'wx', 0o600)
  try {
    fs.writeFileSync(descriptor, bytes)
    input.checkpoint?.('JOURNAL_FILE_FSYNC')
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
  input.checkpoint?.('JOURNAL_RENAME')
  fs.renameSync(temporary, input.journalPath)
  input.checkpoint?.('JOURNAL_DIRECTORY_FSYNC')
  syncDirectory(directory)
  input.checkpoint?.('PENDING_REMOVE_DIRECTORY_FSYNC')
  fs.unlinkSync(pending)
  syncDirectory(directory)

  const readback = readDurableActivationJournal(input.journalPath)
  if (readback.durabilityIssues.length > 0
    || readback.journal.journalSha256 !== input.journal.journalSha256) {
    throw new Error('SQLITE_BUNDLE_DURABLE_JOURNAL_READBACK_MISMATCH')
  }
  return readback
}

export function createSqliteBundleIntegrityReceipt(input: {
  bundlePath: string
  transactionId: string
  bundleId: string
  completedAt: string
  sourceGeneration: string
  servingGeneration: string
  cacheGeneration: string
  journalMode: 'delete' | 'wal'
  fullQuickCheckReceiptSha256: string
}): SqliteBundleIntegrityReceipt {
  const member = (name: string): string | null => {
    const file = path.join(input.bundlePath, name)
    return fs.existsSync(file) ? sha256SqliteBundleFile(file) : null
  }
  const body = {
    version: 1 as const,
    kind: 'JP_OHLCV_SQLITE_BUNDLE_INTEGRITY' as const,
    transactionId: input.transactionId,
    bundleId: input.bundleId,
    completedAt: input.completedAt,
    sourceGeneration: input.sourceGeneration,
    servingGeneration: input.servingGeneration,
    cacheGeneration: input.cacheGeneration,
    journalMode: input.journalMode,
    databaseSha256: member('stockboard.db') ?? '',
    walSha256: member('stockboard.db-wal'),
    shmSha256: member('stockboard.db-shm'),
    fullQuickCheck: 'ok' as const,
    fullQuickCheckReceiptSha256: input.fullQuickCheckReceiptSha256,
  }
  const receipt = { ...body, receiptSha256: stableSha256(body) }
  if (!SHA256.test(receipt.databaseSha256) || !SHA256.test(receipt.fullQuickCheckReceiptSha256)) {
    throw new Error('SQLITE_BUNDLE_INTEGRITY_EVIDENCE_REQUIRED')
  }
  return receipt
}

export function persistSqliteBundleIntegrityReceipt(
  bundlePath: string,
  receipt: SqliteBundleIntegrityReceipt,
): void {
  assertRealDirectory(bundlePath)
  if (stableSha256(receiptBody(receipt)) !== receipt.receiptSha256) {
    throw new Error('SQLITE_BUNDLE_INTEGRITY_RECEIPT_INVALID')
  }
  immutableJson(path.join(bundlePath, SQLITE_BUNDLE_INTEGRITY_RECEIPT), receipt)
}

export function persistSqliteBundleManifest(bundlePath: string, manifest: SqliteBundleManifest): void {
  assertSqliteBundleIntegrityReceipt(bundlePath, manifest, { verifyByteIdentity: true })
  immutableJson(path.join(bundlePath, 'bundle.json'), manifest)
}

export function readSqliteBundleIntegrityReceipt(bundlePath: string): SqliteBundleIntegrityReceipt {
  const file = path.join(bundlePath, SQLITE_BUNDLE_INTEGRITY_RECEIPT)
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(file) !== file
    || (stat.mode & 0o022) !== 0) {
    throw new Error('SQLITE_BUNDLE_INTEGRITY_RECEIPT_FILE_INVALID')
  }
  return JSON.parse(fs.readFileSync(file, 'utf8')) as SqliteBundleIntegrityReceipt
}

export function assertSqliteBundleIntegrityReceipt(
  bundlePath: string,
  manifest: SqliteBundleManifest,
  options: { verifyByteIdentity: boolean },
): SqliteBundleIntegrityReceipt {
  if (options.verifyByteIdentity) assertSqliteBundleManifest(bundlePath, manifest)
  else assertSqliteBundleMetadata(bundlePath, manifest)
  const receipt = readSqliteBundleIntegrityReceipt(bundlePath)
  if (receipt.version !== 1 || receipt.kind !== 'JP_OHLCV_SQLITE_BUNDLE_INTEGRITY'
    || receipt.transactionId !== manifest.transactionId || receipt.bundleId !== manifest.bundleId
    || !Number.isFinite(Date.parse(receipt.completedAt)) || !receipt.cacheGeneration
    || receipt.sourceGeneration !== manifest.sourceGeneration
    || receipt.servingGeneration !== manifest.servingGeneration
    || receipt.journalMode !== manifest.journalMode || receipt.fullQuickCheck !== 'ok'
    || !SHA256.test(receipt.fullQuickCheckReceiptSha256)
    || receipt.databaseSha256 !== manifest.database.sha256
    || receipt.walSha256 !== (manifest.wal?.sha256 ?? null)
    || receipt.shmSha256 !== (manifest.shm?.sha256 ?? null)
    || stableSha256(receiptBody(receipt)) !== receipt.receiptSha256
    || receipt.receiptSha256 !== manifest.integrityReceiptSha256) {
    throw new Error('SQLITE_BUNDLE_INTEGRITY_RECEIPT_MISMATCH')
  }
  return receipt
}

export function persistInitialDurableActivationJournal(input: {
  journalPath: string
  journal: AtomicBundleActivationJournal
  checkpoint?: (checkpoint: DurableActivationWriteCheckpoint) => void
}): DurableActivationJournalRead {
  if (input.journal.phase !== 'PREPARED') throw new Error('SQLITE_BUNDLE_DURABLE_INITIAL_PHASE_INVALID')
  return durableReplaceJournal({ ...input, previousJournalSha256: null })
}

export function readDurableActivationJournal(journalPath: string): DurableActivationJournalRead {
  const journal = assertJournalFile(journalPath)
  return {
    journal,
    fileSha256: sha256Bytes(fs.readFileSync(journalPath)),
    durabilityIssues: listDurabilityIssues(journalPath),
  }
}

export function persistDurableActivationTransition(input: {
  journalPath: string
  previousJournalSha256: string
  journal: AtomicBundleActivationJournal
  checkpoint?: (checkpoint: DurableActivationWriteCheckpoint) => void
}): DurableActivationJournalRead {
  const current = readDurableActivationJournal(input.journalPath)
  if (current.durabilityIssues.length > 0 || current.journal.journalSha256 !== input.previousJournalSha256) {
    throw new Error('SQLITE_BUNDLE_DURABLE_JOURNAL_CAS_MISMATCH')
  }
  const expected = advanceAtomicBundleActivationJournal(
    current.journal,
    input.journal.phase as Exclude<AtomicBundleActivationJournal['phase'], 'PREPARED'>,
    input.journal.updatedAt,
  )
  if (expected.journalSha256 !== input.journal.journalSha256) {
    throw new Error('SQLITE_BUNDLE_DURABLE_TRANSITION_MISMATCH')
  }
  return durableReplaceJournal(input)
}

export function inspectDurableAtomicBundleActivation(input: {
  journalPath: string
  verifyByteIdentity: boolean
}): DurableActivationObservation {
  const durable = readDurableActivationJournal(input.journalPath)
  const activeManifest = readSqliteBundleManifest(durable.journal.activePath)
  const candidateManifest = readSqliteBundleManifest(durable.journal.candidatePath)
  const activeReceipt = assertSqliteBundleIntegrityReceipt(
    durable.journal.activePath, activeManifest, { verifyByteIdentity: input.verifyByteIdentity },
  )
  const candidateReceipt = assertSqliteBundleIntegrityReceipt(
    durable.journal.candidatePath, candidateManifest, { verifyByteIdentity: input.verifyByteIdentity },
  )
  return {
    ...durable,
    activeManifest,
    candidateManifest,
    activeReceipt,
    candidateReceipt,
    position: classifyAtomicBundlePosition({ journal: durable.journal, activeManifest, candidateManifest }),
  }
}

export function sealDurableSwapIntent(input: {
  journalPath: string
  updatedAt: string
  assertReaderWriterBarrierValid: () => void
}): DurableActivationObservation {
  input.assertReaderWriterBarrierValid()
  const before = inspectDurableAtomicBundleActivation({ journalPath: input.journalPath, verifyByteIdentity: true })
  if (before.durabilityIssues.length > 0 || before.journal.phase !== 'PREPARED'
    || before.position !== 'OLD_ACTIVE') {
    throw new Error('SQLITE_BUNDLE_DURABLE_SWAP_INTENT_PRECONDITION_INVALID')
  }
  input.assertReaderWriterBarrierValid()
  const intent = advanceAtomicBundleActivationJournal(before.journal, 'SWAP_INTENT', input.updatedAt)
  persistDurableActivationTransition({
    journalPath: input.journalPath,
    previousJournalSha256: before.journal.journalSha256,
    journal: intent,
  })
  input.assertReaderWriterBarrierValid()
  const after = inspectDurableAtomicBundleActivation({ journalPath: input.journalPath, verifyByteIdentity: false })
  if (after.durabilityIssues.length > 0 || after.journal.phase !== 'SWAP_INTENT'
    || after.position !== 'OLD_ACTIVE') {
    throw new Error('SQLITE_BUNDLE_DURABLE_SWAP_INTENT_NOT_CONFIRMED')
  }
  return after
}

export function executeDurableAtomicBundleSwap(input: {
  journalPath: string
  executablePath: string
  executableSha256: string
  timeoutMs: number
  updatedAt: string
  assertReaderWriterBarrierValid: () => void
}): DurableActivationObservation {
  input.assertReaderWriterBarrierValid()
  const before = inspectDurableAtomicBundleActivation({ journalPath: input.journalPath, verifyByteIdentity: false })
  if (before.durabilityIssues.length > 0 || before.journal.phase !== 'SWAP_INTENT'
    || before.position !== 'OLD_ACTIVE') {
    throw new Error('SQLITE_BUNDLE_DURABLE_SWAP_PRECONDITION_INVALID')
  }
  executeAtomicBundleSwap({
    journal: before.journal,
    activeManifest: before.activeManifest,
    candidateManifest: before.candidateManifest,
    executablePath: input.executablePath,
    executableSha256: input.executableSha256,
    timeoutMs: input.timeoutMs,
    assertReaderWriterBarrierValid: input.assertReaderWriterBarrierValid,
  })
  const swapped = advanceAtomicBundleActivationJournal(before.journal, 'SWAPPED', input.updatedAt)
  persistDurableActivationTransition({
    journalPath: input.journalPath,
    previousJournalSha256: before.journal.journalSha256,
    journal: swapped,
  })
  const after = inspectDurableAtomicBundleActivation({ journalPath: input.journalPath, verifyByteIdentity: false })
  if (after.durabilityIssues.length > 0 || after.journal.phase !== 'SWAPPED'
    || after.position !== 'NEW_ACTIVE') {
    throw new Error('SQLITE_BUNDLE_DURABLE_SWAP_NOT_CONFIRMED')
  }
  return after
}
