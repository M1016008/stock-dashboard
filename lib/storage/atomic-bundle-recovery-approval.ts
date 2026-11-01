import { stableSha256 } from '@/lib/jp-ohlcv-data-quality'
import type { AtomicBundleActivationJournal } from '@/lib/storage/apfs-atomic-sqlite-bundle'

const SHA256 = /^[a-f0-9]{64}$/

export type AtomicBundleRecoveryApproval = {
  version: 1
  action:
    | 'RECORD_OBSERVED_NEW_ACTIVE_WITHOUT_SWAP'
    | 'RECORD_OBSERVED_OLD_ACTIVE_AFTER_REVERSE_WITHOUT_SWAP'
  transactionId: string
  journalSha256: string
  journalFileSha256: string
  oldManifestSha256: string
  newManifestSha256: string
  activeIntegrityReceiptSha256: string
  barrierReceiptSha256: string
  allowedTransition: 'SWAP_INTENT_TO_SWAPPED' | 'REVERSE_INTENT_TO_PRE_CONSUMER_REVERSED'
  automaticSwapAllowed: false
  automaticSwapBackAllowed: false
  issuedAt: string
  expiresAt: string
  reason: string
}

export function atomicBundleRecoveryApprovalSha256(approval: AtomicBundleRecoveryApproval): string {
  return stableSha256(approval)
}

export function assertAtomicBundleRecoveryApproval(input: {
  approval: AtomicBundleRecoveryApproval
  approvalSha256: string
  journal: AtomicBundleActivationJournal
  journalFileSha256: string
  activeIntegrityReceiptSha256: string
  barrierReceiptSha256: string
  transitionAt: string
}): void {
  const { approval, journal } = input
  const expectedKeys = [
    'action', 'activeIntegrityReceiptSha256', 'allowedTransition', 'automaticSwapAllowed',
    'automaticSwapBackAllowed', 'barrierReceiptSha256', 'expiresAt', 'issuedAt',
    'journalFileSha256', 'journalSha256', 'newManifestSha256', 'oldManifestSha256',
    'reason', 'transactionId', 'version',
  ].sort()
  const issuedAt = Date.parse(approval.issuedAt)
  const expiresAt = Date.parse(approval.expiresAt)
  const now = Date.now()
  const transitionAt = Date.parse(input.transitionAt)
  const expectedTransition = approval.action === 'RECORD_OBSERVED_NEW_ACTIVE_WITHOUT_SWAP'
    ? 'SWAP_INTENT_TO_SWAPPED'
    : approval.action === 'RECORD_OBSERVED_OLD_ACTIVE_AFTER_REVERSE_WITHOUT_SWAP'
      ? 'REVERSE_INTENT_TO_PRE_CONSUMER_REVERSED'
      : null
  const expectedJournalPhase = approval.action === 'RECORD_OBSERVED_NEW_ACTIVE_WITHOUT_SWAP'
    ? 'SWAP_INTENT'
    : approval.action === 'RECORD_OBSERVED_OLD_ACTIVE_AFTER_REVERSE_WITHOUT_SWAP'
      ? 'REVERSE_INTENT'
      : null
  if (approval.version !== 1
    || JSON.stringify(Object.keys(approval).sort()) !== JSON.stringify(expectedKeys)
    || expectedTransition === null
    || journal.phase !== expectedJournalPhase
    || approval.transactionId !== journal.transactionId
    || approval.journalSha256 !== journal.journalSha256
    || approval.journalFileSha256 !== input.journalFileSha256
    || approval.oldManifestSha256 !== journal.oldManifestSha256
    || approval.newManifestSha256 !== journal.newManifestSha256
    || approval.activeIntegrityReceiptSha256 !== input.activeIntegrityReceiptSha256
    || approval.barrierReceiptSha256 !== input.barrierReceiptSha256
    || approval.allowedTransition !== expectedTransition
    || approval.automaticSwapAllowed !== false
    || approval.automaticSwapBackAllowed !== false
    || !SHA256.test(input.approvalSha256)
    || !SHA256.test(approval.journalSha256)
    || !SHA256.test(approval.journalFileSha256)
    || !SHA256.test(approval.oldManifestSha256)
    || !SHA256.test(approval.newManifestSha256)
    || !SHA256.test(approval.activeIntegrityReceiptSha256)
    || !SHA256.test(approval.barrierReceiptSha256)
    || atomicBundleRecoveryApprovalSha256(approval) !== input.approvalSha256
    || !Number.isFinite(issuedAt)
    || !Number.isFinite(expiresAt)
    || !Number.isFinite(now)
    || !Number.isFinite(transitionAt)
    || input.transitionAt !== new Date(transitionAt).toISOString()
    || approval.issuedAt !== new Date(issuedAt).toISOString()
    || approval.expiresAt !== new Date(expiresAt).toISOString()
    || issuedAt >= expiresAt
    || expiresAt - issuedAt > 15 * 60 * 1000
    || now < issuedAt
    || now > expiresAt
    || Math.abs(transitionAt - now) > 5_000
    || transitionAt < issuedAt
    || transitionAt > expiresAt
    || typeof approval.reason !== 'string'
    || !approval.reason.trim()) {
    throw new Error('SQLITE_BUNDLE_RECOVERY_APPROVAL_MISMATCH')
  }
}
