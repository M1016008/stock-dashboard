import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { stableSha256 } from '@/lib/jp-ohlcv-data-quality'
import {
  ATOMIC_BUNDLE_ACTIVATION_PHASES,
  advanceAtomicBundleActivationJournal,
  assertAtomicBundleActivationJournal,
  assertSqliteBundleManifest,
  assertSqliteBundleMetadata,
  classifyAtomicBundlePosition,
  executeAtomicBundleReverseSwap,
  executeAtomicBundleSwap,
  readSqliteBundleManifest,
  sha256SqliteBundleFile,
  type AtomicBundleActivationJournal,
  type AtomicBundlePosition,
  type SqliteBundleManifest,
} from '@/lib/storage/apfs-atomic-sqlite-bundle'
import {
  assertSqliteIntegrityReceipt,
  type SqliteIntegrityReceipt,
} from '@/lib/storage/sqlite-integrity-contract'
import {
  assertAtomicBundleRecoveryApproval,
  type AtomicBundleRecoveryApproval,
} from '@/lib/storage/atomic-bundle-recovery-approval'

const SHA256 = /^[a-f0-9]{64}$/
export const SQLITE_BUNDLE_INTEGRITY_RECEIPT = 'integrity-receipt.json'
export const SQLITE_CANDIDATE_INTEGRITY_RECEIPT = 'sqlite-integrity-receipt.json'

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
  | 'PENDING_LOCK_ACQUIRED'
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

export type DurableActivationArtifactClassification = {
  version: 1
  kind: 'JP_OHLCV_DURABLE_ACTIVATION_ARTIFACT_CLASSIFICATION'
  journalPath: string
  checkedAt: string
  transactionId: string
  currentJournalSha256: string
  currentJournalFileSha256: string
  currentJournalPhase: AtomicBundleActivationJournal['phase']
  snapshotStable: boolean
  pendingArtifactPresent: boolean
  pendingArtifactValid: boolean
  pending: null | {
    fileSha256: string
    previousJournalSha256: string | null
    nextJournalSha256: string
    nextPhase: AtomicBundleActivationJournal['phase']
    intentSha256: string
  }
  temporaries: Array<{
    file: string
    fileSha256: string
    journalSha256: string | null
    phase: AtomicBundleActivationJournal['phase'] | null
    valid: boolean
  }>
  classification:
    | 'CLEAN'
    | 'WRITE_NOT_PUBLISHED'
    | 'PUBLISHED_PENDING_CLEANUP'
    | 'AMBIGUOUS'
  destructiveActionAllowed: false
  receiptSha256: string
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

function artifactClassificationBody(
  receipt: DurableActivationArtifactClassification,
): Omit<DurableActivationArtifactClassification, 'receiptSha256'> {
  const { receiptSha256: _receiptSha256, ...body } = receipt
  return body
}

function artifactClassificationFor(
  receipt: Omit<DurableActivationArtifactClassification, 'receiptSha256' | 'classification'>,
): DurableActivationArtifactClassification['classification'] {
  if (!receipt.snapshotStable) return 'AMBIGUOUS'
  if (!receipt.pendingArtifactPresent && receipt.temporaries.length === 0) return 'CLEAN'
  if (!receipt.pendingArtifactValid || receipt.pending === null
    || receipt.temporaries.some((artifact) => !artifact.valid)) return 'AMBIGUOUS'
  if (receipt.currentJournalSha256 === receipt.pending.previousJournalSha256
    && receipt.temporaries.length === 1
    && receipt.temporaries[0]?.journalSha256 === receipt.pending.nextJournalSha256
    && receipt.temporaries[0]?.phase === receipt.pending.nextPhase) {
    return 'WRITE_NOT_PUBLISHED'
  }
  if (receipt.currentJournalSha256 === receipt.pending.nextJournalSha256
    && receipt.currentJournalPhase === receipt.pending.nextPhase
    && receipt.pending.nextPhase !== 'PREPARED'
    && receipt.temporaries.length === 0) return 'PUBLISHED_PENDING_CLEANUP'
  return 'AMBIGUOUS'
}

function secureArtifactFile(file: string): fs.Stats | null {
  try {
    const stat = fs.lstatSync(file)
    const currentUid = process.getuid?.()
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || fs.realpathSync(file) !== file
      || (stat.mode & 0o022) !== 0
      || (stat.uid !== 0 && currentUid !== undefined && stat.uid !== currentUid)) return null
    return stat
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export function classifyDurableActivationArtifacts(input: {
  journalPath: string
  checkedAt: string
}): DurableActivationArtifactClassification {
  if (!Number.isFinite(Date.parse(input.checkedAt))) {
    throw new Error('SQLITE_BUNDLE_ARTIFACT_CLASSIFICATION_TIME_INVALID')
  }
  const current = readDurableActivationJournal(input.journalPath)
  const directory = path.dirname(input.journalPath)
  const { pending, temporaryPrefix } = journalArtifacts(input.journalPath)
  let pendingEvidence: DurableActivationArtifactClassification['pending'] = null
  let pendingArtifactPresent = false
  let pendingInvalid = false
  try {
    fs.lstatSync(pending)
    pendingArtifactPresent = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (pendingArtifactPresent) {
    try {
      if (!secureArtifactFile(pending)) throw new Error('invalid pending file')
      const pendingBytes = fs.readFileSync(pending)
      const parsed = JSON.parse(pendingBytes.toString('utf8')) as Record<string, unknown>
      const { intentSha256, ...body } = parsed
      if (parsed.version !== 1
        || parsed.kind !== 'JP_OHLCV_ATOMIC_BUNDLE_JOURNAL_WRITE_INTENT'
        || parsed.journalPath !== input.journalPath
        || (parsed.previousJournalSha256 !== null && !SHA256.test(String(parsed.previousJournalSha256)))
        || !SHA256.test(String(parsed.nextJournalSha256))
        || !ATOMIC_BUNDLE_ACTIVATION_PHASES.includes(
          parsed.nextPhase as AtomicBundleActivationJournal['phase'],
        )
        || !SHA256.test(String(intentSha256))
        || stableSha256(body) !== intentSha256) {
        throw new Error('invalid pending intent')
      }
      pendingEvidence = {
        fileSha256: sha256Bytes(pendingBytes),
        previousJournalSha256: parsed.previousJournalSha256 as string | null,
        nextJournalSha256: String(parsed.nextJournalSha256),
        nextPhase: parsed.nextPhase as AtomicBundleActivationJournal['phase'],
        intentSha256: String(intentSha256),
      }
    } catch {
      pendingInvalid = true
    }
  }
  const temporaries = fs.readdirSync(directory)
    .filter((entry) => entry.startsWith(temporaryPrefix)).sort()
    .map((file) => {
      const absolute = path.join(directory, file)
      let journalSha256: string | null = null
      let phase: AtomicBundleActivationJournal['phase'] | null = null
      let fileSha256: string
      let valid = false
      try {
        const stat = secureArtifactFile(absolute)
        if (!stat) {
          return {
            file,
            fileSha256: stableSha256({
              invalidArtifact: true,
              file,
            }),
            journalSha256: null,
            phase: null,
            valid: false,
          }
        }
        const bytes = fs.readFileSync(absolute)
        fileSha256 = sha256Bytes(bytes)
        const parsed = JSON.parse(bytes.toString('utf8')) as AtomicBundleActivationJournal
        assertAtomicBundleActivationJournal(parsed)
        if (file !== `${temporaryPrefix}${parsed.journalSha256}`
          || parsed.transactionId !== current.journal.transactionId) {
          throw new Error('temporary identity mismatch')
        }
        if (pendingEvidence?.previousJournalSha256 === current.journal.journalSha256
          && pendingEvidence.nextJournalSha256 === parsed.journalSha256) {
          if (parsed.phase === 'PREPARED') throw new Error('illegal temporary transition')
          const expected = advanceAtomicBundleActivationJournal(
            current.journal,
            parsed.phase,
            parsed.updatedAt,
            { recoveryApprovalSha256: parsed.recoveryApprovalSha256 ?? undefined },
          )
          if (expected.journalSha256 !== parsed.journalSha256) {
            throw new Error('temporary transition mismatch')
          }
        }
        journalSha256 = parsed.journalSha256
        phase = parsed.phase
        valid = true
      } catch {
        fileSha256 = stableSha256({ invalidArtifact: true, file })
        journalSha256 = null
        phase = null
      }
      return { file, fileSha256, journalSha256, phase, valid }
    })
  let snapshotStable = false
  try {
    const after = readDurableActivationJournal(input.journalPath)
    snapshotStable = after.journal.journalSha256 === current.journal.journalSha256
      && after.fileSha256 === current.fileSha256
  } catch {
    snapshotStable = false
  }
  const body = {
    version: 1 as const,
    kind: 'JP_OHLCV_DURABLE_ACTIVATION_ARTIFACT_CLASSIFICATION' as const,
    journalPath: input.journalPath,
    checkedAt: input.checkedAt,
    transactionId: current.journal.transactionId,
    currentJournalSha256: current.journal.journalSha256,
    currentJournalFileSha256: current.fileSha256,
    currentJournalPhase: current.journal.phase,
    snapshotStable,
    pendingArtifactPresent,
    pendingArtifactValid: pendingArtifactPresent && !pendingInvalid,
    pending: pendingEvidence,
    temporaries,
    destructiveActionAllowed: false as const,
  }
  const classification = artifactClassificationFor(body)
  const receiptBody = { ...body, classification }
  return { ...receiptBody, receiptSha256: stableSha256(receiptBody) }
}

export function assertDurableActivationArtifactClassification(
  receipt: DurableActivationArtifactClassification,
): void {
  try {
    if (receipt.version !== 1
      || receipt.kind !== 'JP_OHLCV_DURABLE_ACTIVATION_ARTIFACT_CLASSIFICATION'
      || !Array.isArray(receipt.temporaries)
      || !['CLEAN', 'WRITE_NOT_PUBLISHED', 'PUBLISHED_PENDING_CLEANUP', 'AMBIGUOUS']
        .includes(receipt.classification)
      || !SHA256.test(receipt.receiptSha256)
      || stableSha256(artifactClassificationBody(receipt)) !== receipt.receiptSha256
      || artifactClassificationFor(receipt) !== receipt.classification
      || receipt.destructiveActionAllowed !== false) {
      throw new Error('invalid classification')
    }
  } catch {
    throw new Error('SQLITE_BUNDLE_ARTIFACT_CLASSIFICATION_INVALID')
  }
}

function listDurabilityIssues(journalPath: string): string[] {
  const { pending, temporaryPrefix } = journalArtifacts(journalPath)
  const issues: string[] = []
  try {
    fs.lstatSync(pending)
    issues.push('PENDING_WRITE_INTENT_PRESENT')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const temporaries = fs.readdirSync(path.dirname(journalPath))
    .filter((entry) => entry.startsWith(temporaryPrefix)).sort()
  if (temporaries.length > 0) issues.push(`TEMPORARY_JOURNAL_PRESENT:${temporaries.join(',')}`)
  return issues
}

function assertJournalFile(file: string): AtomicBundleActivationJournal {
  const stat = fs.lstatSync(file)
  const currentUid = process.getuid?.()
  if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(file) !== file
    || (stat.mode & 0o022) !== 0
    || (stat.uid !== 0 && currentUid !== undefined && stat.uid !== currentUid)) {
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
  let preservePending = false
  let pendingOpen = true
  let publishedReadback: DurableActivationJournalRead | null = null
  try {
    input.checkpoint?.('PENDING_LOCK_ACQUIRED')
    const staleTemporaries = fs.readdirSync(directory)
      .filter((entry) => entry.startsWith(temporaryPrefix)).sort()
    if (staleTemporaries.length > 0) {
      throw new Error(`SQLITE_BUNDLE_DURABLE_TEMPORARY_PRESENT:${staleTemporaries.join(',')}`)
    }
    const journalExists = fs.existsSync(input.journalPath)
    if ((input.previousJournalSha256 === null) !== !journalExists) {
      throw new Error('SQLITE_BUNDLE_DURABLE_JOURNAL_EXISTENCE_MISMATCH')
    }
    if (journalExists) {
      const current = assertJournalFile(input.journalPath)
      if (current.journalSha256 !== input.previousJournalSha256) {
        throw new Error('SQLITE_BUNDLE_DURABLE_JOURNAL_CAS_MISMATCH')
      }
      const expected = advanceAtomicBundleActivationJournal(
        current,
        input.journal.phase as Exclude<AtomicBundleActivationJournal['phase'], 'PREPARED'>,
        input.journal.updatedAt,
        input.journal.recoveryApprovalSha256 === current.recoveryApprovalSha256
          ? undefined
          : { recoveryApprovalSha256: input.journal.recoveryApprovalSha256 ?? '' },
      )
      if (expected.journalSha256 !== input.journal.journalSha256) {
        throw new Error('SQLITE_BUNDLE_DURABLE_TRANSITION_MISMATCH')
      }
    }

    preservePending = true
    fs.writeFileSync(pendingDescriptor, `${JSON.stringify(intent, null, 2)}\n`)
    input.checkpoint?.('PENDING_FILE_FSYNC')
    fs.fsyncSync(pendingDescriptor)
    fs.closeSync(pendingDescriptor)
    pendingOpen = false
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

    const existsBeforePublish = fs.existsSync(input.journalPath)
    if (input.previousJournalSha256 === null) {
      if (existsBeforePublish) throw new Error('SQLITE_BUNDLE_DURABLE_JOURNAL_EXISTENCE_MISMATCH')
    } else {
      if (!existsBeforePublish
        || assertJournalFile(input.journalPath).journalSha256 !== input.previousJournalSha256) {
        throw new Error('SQLITE_BUNDLE_DURABLE_JOURNAL_CAS_MISMATCH')
      }
    }
    input.checkpoint?.('JOURNAL_RENAME')
    if (input.previousJournalSha256 === null) {
      fs.linkSync(temporary, input.journalPath)
      fs.unlinkSync(temporary)
    } else {
      fs.renameSync(temporary, input.journalPath)
    }
    input.checkpoint?.('JOURNAL_DIRECTORY_FSYNC')
    syncDirectory(directory)
    const journalBytes = fs.readFileSync(input.journalPath)
    const journalReadback = assertJournalFile(input.journalPath)
    if (journalReadback.journalSha256 !== input.journal.journalSha256
      || fs.readdirSync(directory).some((entry) => entry.startsWith(temporaryPrefix))) {
      throw new Error('SQLITE_BUNDLE_DURABLE_JOURNAL_READBACK_MISMATCH')
    }
    publishedReadback = {
      journal: journalReadback,
      fileSha256: sha256Bytes(journalBytes),
      durabilityIssues: [],
    }
    input.checkpoint?.('PENDING_REMOVE_DIRECTORY_FSYNC')
    fs.unlinkSync(pending)
    syncDirectory(directory)
    preservePending = false
  } catch (error) {
    if (!preservePending && fs.existsSync(pending)) {
      if (pendingOpen) {
        fs.closeSync(pendingDescriptor)
        pendingOpen = false
      }
      fs.unlinkSync(pending)
      syncDirectory(directory)
    }
    throw error
  } finally {
    if (pendingOpen) fs.closeSync(pendingDescriptor)
  }

  if (!publishedReadback) throw new Error('SQLITE_BUNDLE_DURABLE_JOURNAL_READBACK_MISSING')
  return publishedReadback
}

export function persistSqliteCandidateIntegrityReceipt(
  bundlePath: string,
  receipt: SqliteIntegrityReceipt,
): void {
  assertSqliteIntegrityReceipt(receipt)
  immutableJson(path.join(bundlePath, SQLITE_CANDIDATE_INTEGRITY_RECEIPT), receipt)
}

export function readSqliteCandidateIntegrityReceipt(bundlePath: string): SqliteIntegrityReceipt {
  const file = path.join(bundlePath, SQLITE_CANDIDATE_INTEGRITY_RECEIPT)
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(file) !== file
    || (stat.mode & 0o022) !== 0) {
    throw new Error('SQLITE_CANDIDATE_INTEGRITY_RECEIPT_FILE_INVALID')
  }
  const receipt = JSON.parse(fs.readFileSync(file, 'utf8')) as SqliteIntegrityReceipt
  assertSqliteIntegrityReceipt(receipt)
  return receipt
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
}): SqliteBundleIntegrityReceipt {
  const member = (name: string): string | null => {
    const file = path.join(input.bundlePath, name)
    return fs.existsSync(file) ? sha256SqliteBundleFile(file) : null
  }
  const quickCheck = readSqliteCandidateIntegrityReceipt(input.bundlePath)
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
    fullQuickCheckReceiptSha256: stableSha256(quickCheck),
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
  const quickCheck = readSqliteCandidateIntegrityReceipt(bundlePath)
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
  if (!['BACKUP_COMPLETE', 'CANDIDATE_POST_WRITE'].includes(quickCheck.kind)
    || quickCheck.transactionId !== receipt.transactionId
    || quickCheck.sourceGeneration !== receipt.sourceGeneration
    || quickCheck.servingGeneration !== receipt.servingGeneration
    || path.basename(quickCheck.artifact.realpath) !== 'stockboard.db'
    || quickCheck.artifact.sha256 !== receipt.databaseSha256
    || quickCheck.artifact.sizeBytes !== manifest.database.sizeBytes
    || quickCheck.sqliteCheck.command !== 'PRAGMA quick_check;'
    || quickCheck.sqliteCheck.scope !== 'WHOLE_FILE_QUICK_CHECK'
    || quickCheck.sqliteCheck.result !== 'ok'
    || stableSha256(quickCheck) !== receipt.fullQuickCheckReceiptSha256) {
    throw new Error('SQLITE_FULL_QUICK_CHECK_RECEIPT_MISMATCH')
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

function persistDurableActivationTransition(input: {
  journalPath: string
  previousJournalSha256: string
  journal: AtomicBundleActivationJournal
  checkpoint?: (checkpoint: DurableActivationWriteCheckpoint) => void
}): DurableActivationJournalRead {
  return durableReplaceJournal(input)
}

export function assertDurableActivationGenerationConvergence(input: {
  observation: DurableActivationObservation
  sourceGeneration: string
  servingGeneration: string
  cacheGeneration: string
}): void {
  const receipt = input.observation.activeReceipt
  if (input.observation.durabilityIssues.length > 0 || input.observation.position !== 'NEW_ACTIVE'
    || !['SWAPPED', 'GENERATION_RECONCILED', 'COMMITTED'].includes(input.observation.journal.phase)
    || receipt.sourceGeneration !== input.sourceGeneration
    || receipt.servingGeneration !== input.servingGeneration
    || receipt.cacheGeneration !== input.cacheGeneration) {
    throw new Error('SQLITE_BUNDLE_GENERATION_CONVERGENCE_MISMATCH')
  }
}

export function assertDurablePreConsumerReverseGenerationConvergence(input: {
  observation: DurableActivationObservation
  sourceGeneration: string
  servingGeneration: string
  cacheGeneration: string
}): void {
  const { observation } = input
  const oldReceipt = observation.activeManifest.manifestSha256 === observation.journal.oldManifestSha256
    ? observation.activeReceipt
    : observation.candidateManifest.manifestSha256 === observation.journal.oldManifestSha256
      ? observation.candidateReceipt
      : null
  const phasePositionValid = (observation.journal.phase === 'REVERSE_INTENT'
      && ['NEW_ACTIVE', 'OLD_ACTIVE'].includes(observation.position))
    || (observation.journal.phase === 'PRE_CONSUMER_REVERSED' && observation.position === 'OLD_ACTIVE')
  if (observation.durabilityIssues.length > 0 || !phasePositionValid
    || oldReceipt === null
    || oldReceipt.sourceGeneration !== input.sourceGeneration
    || oldReceipt.servingGeneration !== input.servingGeneration
    || oldReceipt.cacheGeneration !== input.cacheGeneration) {
    throw new Error('SQLITE_BUNDLE_REVERSE_GENERATION_CONVERGENCE_MISMATCH')
  }
}

function assertOldBundleByteIdentity(observation: DurableActivationObservation): void {
  if (observation.activeManifest.manifestSha256 === observation.journal.oldManifestSha256) {
    assertSqliteBundleIntegrityReceipt(
      observation.journal.activePath, observation.activeManifest, { verifyByteIdentity: true },
    )
    return
  }
  if (observation.candidateManifest.manifestSha256 === observation.journal.oldManifestSha256) {
    assertSqliteBundleIntegrityReceipt(
      observation.journal.candidatePath, observation.candidateManifest, { verifyByteIdentity: true },
    )
    return
  }
  throw new Error('SQLITE_BUNDLE_OLD_BYTE_IDENTITY_AMBIGUOUS')
}

export function recordDurableGenerationReconciled(input: {
  journalPath: string
  updatedAt: string
  observedSourceGeneration: string
  observedServingGeneration: string
  observedCacheGeneration: string
  assertReaderWriterBarrierValid: () => void
  checkpoint?: (checkpoint: DurableActivationWriteCheckpoint) => void
}): DurableActivationObservation {
  input.assertReaderWriterBarrierValid()
  const before = inspectDurableAtomicBundleActivation({ journalPath: input.journalPath, verifyByteIdentity: false })
  if (before.journal.phase !== 'SWAPPED') {
    throw new Error('SQLITE_BUNDLE_GENERATION_RECONCILE_PHASE_INVALID')
  }
  assertDurableActivationGenerationConvergence({
    observation: before,
    sourceGeneration: input.observedSourceGeneration,
    servingGeneration: input.observedServingGeneration,
    cacheGeneration: input.observedCacheGeneration,
  })
  input.assertReaderWriterBarrierValid()
  const reconciled = advanceAtomicBundleActivationJournal(
    before.journal, 'GENERATION_RECONCILED', input.updatedAt,
  )
  persistDurableActivationTransition({
    journalPath: input.journalPath,
    previousJournalSha256: before.journal.journalSha256,
    journal: reconciled,
    checkpoint: input.checkpoint,
  })
  input.assertReaderWriterBarrierValid()
  const after = inspectDurableAtomicBundleActivation({ journalPath: input.journalPath, verifyByteIdentity: false })
  assertDurableActivationGenerationConvergence({
    observation: after,
    sourceGeneration: input.observedSourceGeneration,
    servingGeneration: input.observedServingGeneration,
    cacheGeneration: input.observedCacheGeneration,
  })
  if (after.journal.phase !== 'GENERATION_RECONCILED') {
    throw new Error('SQLITE_BUNDLE_GENERATION_RECONCILE_NOT_CONFIRMED')
  }
  return after
}

export function commitDurableAtomicBundleActivation(input: {
  journalPath: string
  updatedAt: string
  observedSourceGeneration: string
  observedServingGeneration: string
  observedCacheGeneration: string
  assertReaderWriterBarrierValid: () => void
  checkpoint?: (checkpoint: DurableActivationWriteCheckpoint) => void
}): DurableActivationObservation {
  input.assertReaderWriterBarrierValid()
  const before = inspectDurableAtomicBundleActivation({ journalPath: input.journalPath, verifyByteIdentity: false })
  if (before.journal.phase !== 'GENERATION_RECONCILED') {
    throw new Error('SQLITE_BUNDLE_COMMIT_PHASE_INVALID')
  }
  assertDurableActivationGenerationConvergence({
    observation: before,
    sourceGeneration: input.observedSourceGeneration,
    servingGeneration: input.observedServingGeneration,
    cacheGeneration: input.observedCacheGeneration,
  })
  input.assertReaderWriterBarrierValid()
  const committed = advanceAtomicBundleActivationJournal(before.journal, 'COMMITTED', input.updatedAt)
  persistDurableActivationTransition({
    journalPath: input.journalPath,
    previousJournalSha256: before.journal.journalSha256,
    journal: committed,
    checkpoint: input.checkpoint,
  })
  input.assertReaderWriterBarrierValid()
  const after = inspectDurableAtomicBundleActivation({ journalPath: input.journalPath, verifyByteIdentity: false })
  assertDurableActivationGenerationConvergence({
    observation: after,
    sourceGeneration: input.observedSourceGeneration,
    servingGeneration: input.observedServingGeneration,
    cacheGeneration: input.observedCacheGeneration,
  })
  if (after.journal.phase !== 'COMMITTED') throw new Error('SQLITE_BUNDLE_COMMIT_NOT_CONFIRMED')
  return after
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
  checkpoint?: (checkpoint: DurableActivationWriteCheckpoint) => void
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
    checkpoint: input.checkpoint,
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
  checkpoint?: (checkpoint: DurableActivationWriteCheckpoint) => void
}): DurableActivationObservation {
  input.assertReaderWriterBarrierValid()
  const before = inspectDurableAtomicBundleActivation({ journalPath: input.journalPath, verifyByteIdentity: false })
  if (before.durabilityIssues.length > 0 || before.journal.phase !== 'SWAP_INTENT'
    || before.position !== 'OLD_ACTIVE') {
    throw new Error('SQLITE_BUNDLE_DURABLE_SWAP_PRECONDITION_INVALID')
  }
  const swapped = advanceAtomicBundleActivationJournal(before.journal, 'SWAPPED', input.updatedAt)
  executeAtomicBundleSwap({
    journal: before.journal,
    activeManifest: before.activeManifest,
    candidateManifest: before.candidateManifest,
    executablePath: input.executablePath,
    executableSha256: input.executableSha256,
    timeoutMs: input.timeoutMs,
    assertReaderWriterBarrierValid: input.assertReaderWriterBarrierValid,
  })
  persistDurableActivationTransition({
    journalPath: input.journalPath,
    previousJournalSha256: before.journal.journalSha256,
    journal: swapped,
    checkpoint: input.checkpoint,
  })
  input.assertReaderWriterBarrierValid()
  const after = inspectDurableAtomicBundleActivation({ journalPath: input.journalPath, verifyByteIdentity: false })
  if (after.durabilityIssues.length > 0 || after.journal.phase !== 'SWAPPED'
    || after.position !== 'NEW_ACTIVE') {
    throw new Error('SQLITE_BUNDLE_DURABLE_SWAP_NOT_CONFIRMED')
  }
  return after
}

export function sealDurableReverseIntent(input: {
  journalPath: string
  updatedAt: string
  observedSourceGeneration: string
  observedServingGeneration: string
  observedCacheGeneration: string
  assertReaderWriterBarrierValid: () => void
  checkpoint?: (checkpoint: DurableActivationWriteCheckpoint) => void
}): DurableActivationObservation {
  input.assertReaderWriterBarrierValid()
  const before = inspectDurableAtomicBundleActivation({ journalPath: input.journalPath, verifyByteIdentity: false })
  if (before.durabilityIssues.length > 0
    || before.journal.phase !== 'SWAPPED'
    || before.position !== 'NEW_ACTIVE'
    || before.activeManifest.journalMode !== 'delete'
    || before.activeManifest.wal !== null
    || before.activeManifest.shm !== null
    || before.candidateManifest.journalMode !== 'delete'
    || before.candidateManifest.wal !== null
    || before.candidateManifest.shm !== null) {
    throw new Error('SQLITE_BUNDLE_DURABLE_REVERSE_INTENT_PRECONDITION_INVALID')
  }
  assertOldBundleByteIdentity(before)
  const reverseView = { ...before, journal: { ...before.journal, phase: 'REVERSE_INTENT' as const } }
  assertDurablePreConsumerReverseGenerationConvergence({
    observation: reverseView,
    sourceGeneration: input.observedSourceGeneration,
    servingGeneration: input.observedServingGeneration,
    cacheGeneration: input.observedCacheGeneration,
  })
  input.assertReaderWriterBarrierValid()
  const intent = advanceAtomicBundleActivationJournal(before.journal, 'REVERSE_INTENT', input.updatedAt)
  persistDurableActivationTransition({
    journalPath: input.journalPath,
    previousJournalSha256: before.journal.journalSha256,
    journal: intent,
    checkpoint: input.checkpoint,
  })
  input.assertReaderWriterBarrierValid()
  const after = inspectDurableAtomicBundleActivation({ journalPath: input.journalPath, verifyByteIdentity: false })
  assertDurablePreConsumerReverseGenerationConvergence({
    observation: after,
    sourceGeneration: input.observedSourceGeneration,
    servingGeneration: input.observedServingGeneration,
    cacheGeneration: input.observedCacheGeneration,
  })
  if (after.journal.phase !== 'REVERSE_INTENT' || after.position !== 'NEW_ACTIVE') {
    throw new Error('SQLITE_BUNDLE_DURABLE_REVERSE_INTENT_NOT_CONFIRMED')
  }
  return after
}

export function executeDurableAtomicBundleReverse(input: {
  journalPath: string
  executablePath: string
  executableSha256: string
  timeoutMs: number
  updatedAt: string
  observedSourceGeneration: string
  observedServingGeneration: string
  observedCacheGeneration: string
  assertReaderWriterBarrierValid: () => void
  checkpoint?: (checkpoint: DurableActivationWriteCheckpoint) => void
}): DurableActivationObservation {
  input.assertReaderWriterBarrierValid()
  const before = inspectDurableAtomicBundleActivation({ journalPath: input.journalPath, verifyByteIdentity: false })
  if (before.durabilityIssues.length > 0 || before.journal.phase !== 'REVERSE_INTENT'
    || before.position !== 'NEW_ACTIVE') {
    throw new Error('SQLITE_BUNDLE_DURABLE_REVERSE_PRECONDITION_INVALID')
  }
  assertDurablePreConsumerReverseGenerationConvergence({
    observation: before,
    sourceGeneration: input.observedSourceGeneration,
    servingGeneration: input.observedServingGeneration,
    cacheGeneration: input.observedCacheGeneration,
  })
  const reversed = advanceAtomicBundleActivationJournal(
    before.journal, 'PRE_CONSUMER_REVERSED', input.updatedAt,
  )
  executeAtomicBundleReverseSwap({
    journal: before.journal,
    activeManifest: before.activeManifest,
    candidateManifest: before.candidateManifest,
    executablePath: input.executablePath,
    executableSha256: input.executableSha256,
    timeoutMs: input.timeoutMs,
    assertReaderWriterBarrierValid: input.assertReaderWriterBarrierValid,
  })
  input.assertReaderWriterBarrierValid()
  const afterSwap = inspectDurableAtomicBundleActivation({
    journalPath: input.journalPath, verifyByteIdentity: false,
  })
  if (afterSwap.journal.phase !== 'REVERSE_INTENT' || afterSwap.position !== 'OLD_ACTIVE') {
    throw new Error('SQLITE_BUNDLE_DURABLE_REVERSE_SWAP_NOT_CONFIRMED')
  }
  assertOldBundleByteIdentity(afterSwap)
  input.assertReaderWriterBarrierValid()
  assertDurablePreConsumerReverseGenerationConvergence({
    observation: afterSwap,
    sourceGeneration: input.observedSourceGeneration,
    servingGeneration: input.observedServingGeneration,
    cacheGeneration: input.observedCacheGeneration,
  })
  persistDurableActivationTransition({
    journalPath: input.journalPath,
    previousJournalSha256: before.journal.journalSha256,
    journal: reversed,
    checkpoint: input.checkpoint,
  })
  input.assertReaderWriterBarrierValid()
  const after = inspectDurableAtomicBundleActivation({ journalPath: input.journalPath, verifyByteIdentity: false })
  assertDurablePreConsumerReverseGenerationConvergence({
    observation: after,
    sourceGeneration: input.observedSourceGeneration,
    servingGeneration: input.observedServingGeneration,
    cacheGeneration: input.observedCacheGeneration,
  })
  if (after.journal.phase !== 'PRE_CONSUMER_REVERSED' || after.position !== 'OLD_ACTIVE') {
    throw new Error('SQLITE_BUNDLE_DURABLE_REVERSE_NOT_CONFIRMED')
  }
  return after
}

export function recordDurableReverseObservedAfterRestart(input: {
  journalPath: string
  recoveryApproval: AtomicBundleRecoveryApproval
  recoveryApprovalSha256: string
  barrierReceiptSha256: string
  observedSourceGeneration: string
  observedServingGeneration: string
  observedCacheGeneration: string
  assertReaderWriterBarrierValid: () => void
  checkpoint?: (checkpoint: DurableActivationWriteCheckpoint) => void
}): DurableActivationObservation {
  input.assertReaderWriterBarrierValid()
  const before = inspectDurableAtomicBundleActivation({ journalPath: input.journalPath, verifyByteIdentity: false })
  if (before.durabilityIssues.length > 0 || before.journal.phase !== 'REVERSE_INTENT'
    || before.position !== 'OLD_ACTIVE' || before.journal.recoveryApprovalSha256 !== null) {
    throw new Error('SQLITE_BUNDLE_REVERSE_RESTART_OBSERVATION_PRECONDITION_INVALID')
  }
  assertOldBundleByteIdentity(before)
  assertDurablePreConsumerReverseGenerationConvergence({
    observation: before,
    sourceGeneration: input.observedSourceGeneration,
    servingGeneration: input.observedServingGeneration,
    cacheGeneration: input.observedCacheGeneration,
  })
  const transitionAt = new Date().toISOString()
  assertAtomicBundleRecoveryApproval({
    approval: input.recoveryApproval,
    approvalSha256: input.recoveryApprovalSha256,
    journal: before.journal,
    journalFileSha256: before.fileSha256,
    activeIntegrityReceiptSha256: before.activeReceipt.receiptSha256,
    barrierReceiptSha256: input.barrierReceiptSha256,
    transitionAt,
  })
  input.assertReaderWriterBarrierValid()
  const reversed = advanceAtomicBundleActivationJournal(
    before.journal, 'PRE_CONSUMER_REVERSED', transitionAt,
    { recoveryApprovalSha256: input.recoveryApprovalSha256 },
  )
  persistDurableActivationTransition({
    journalPath: input.journalPath,
    previousJournalSha256: before.journal.journalSha256,
    journal: reversed,
    checkpoint: input.checkpoint,
  })
  input.assertReaderWriterBarrierValid()
  const after = inspectDurableAtomicBundleActivation({ journalPath: input.journalPath, verifyByteIdentity: false })
  assertDurablePreConsumerReverseGenerationConvergence({
    observation: after,
    sourceGeneration: input.observedSourceGeneration,
    servingGeneration: input.observedServingGeneration,
    cacheGeneration: input.observedCacheGeneration,
  })
  if (after.journal.phase !== 'PRE_CONSUMER_REVERSED' || after.position !== 'OLD_ACTIVE'
    || after.journal.recoveryApprovalSha256 !== input.recoveryApprovalSha256) {
    throw new Error('SQLITE_BUNDLE_REVERSE_RESTART_OBSERVATION_NOT_CONFIRMED')
  }
  return after
}

export function recordDurableSwapObservedAfterRestart(input: {
  journalPath: string
  recoveryApproval: AtomicBundleRecoveryApproval
  recoveryApprovalSha256: string
  barrierReceiptSha256: string
  assertReaderWriterBarrierValid: () => void
  checkpoint?: (checkpoint: DurableActivationWriteCheckpoint) => void
}): DurableActivationObservation {
  input.assertReaderWriterBarrierValid()
  const before = inspectDurableAtomicBundleActivation({ journalPath: input.journalPath, verifyByteIdentity: true })
  if (before.durabilityIssues.length > 0 || before.journal.phase !== 'SWAP_INTENT'
    || before.position !== 'NEW_ACTIVE' || before.journal.recoveryApprovalSha256 !== null) {
    throw new Error('SQLITE_BUNDLE_RESTART_OBSERVATION_PRECONDITION_INVALID')
  }
  const transitionAt = new Date().toISOString()
  assertAtomicBundleRecoveryApproval({
    approval: input.recoveryApproval,
    approvalSha256: input.recoveryApprovalSha256,
    journal: before.journal,
    journalFileSha256: before.fileSha256,
    activeIntegrityReceiptSha256: before.activeReceipt.receiptSha256,
    barrierReceiptSha256: input.barrierReceiptSha256,
    transitionAt,
  })
  input.assertReaderWriterBarrierValid()
  const swapped = advanceAtomicBundleActivationJournal(before.journal, 'SWAPPED', transitionAt, {
    recoveryApprovalSha256: input.recoveryApprovalSha256,
  })
  persistDurableActivationTransition({
    journalPath: input.journalPath,
    previousJournalSha256: before.journal.journalSha256,
    journal: swapped,
    checkpoint: input.checkpoint,
  })
  input.assertReaderWriterBarrierValid()
  const after = inspectDurableAtomicBundleActivation({ journalPath: input.journalPath, verifyByteIdentity: false })
  if (after.durabilityIssues.length > 0 || after.journal.phase !== 'SWAPPED'
    || after.position !== 'NEW_ACTIVE'
    || after.journal.recoveryApprovalSha256 !== input.recoveryApprovalSha256) {
    throw new Error('SQLITE_BUNDLE_RESTART_OBSERVATION_NOT_CONFIRMED')
  }
  return after
}
