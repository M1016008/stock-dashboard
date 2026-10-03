import type { HolderCountMismatchError } from './filing'

export const SOURCE_QUARANTINE_STATUS = 'quarantined_source_inconsistency'
export const SOURCE_REVIEW_REQUIRED_STATUS = 'review_required_source_inconsistency'

export type DocumentDisposition = 'READY' | 'QUARANTINED_SOURCE_INCONSISTENCY'
  | 'REVIEW_REQUIRED_SOURCE_INCONSISTENCY' | 'FAILED_PARSER'
  | 'FAILED_CERTIFICATION' | 'SUPERSEDED' | 'OTHER'

export function documentDisposition(status: string): DocumentDisposition {
  if (status === 'ready') return 'READY'
  if (status === SOURCE_QUARANTINE_STATUS) return 'QUARANTINED_SOURCE_INCONSISTENCY'
  if (status === SOURCE_REVIEW_REQUIRED_STATUS) return 'REVIEW_REQUIRED_SOURCE_INCONSISTENCY'
  if (status === 'failed') return 'FAILED_PARSER'
  if (status === 'superseded') return 'SUPERSEDED'
  return 'OTHER'
}

export type SourceQuarantineRecord = {
  documentId: string
  disposition: 'QUARANTINED_SOURCE_INCONSISTENCY'
  reasonCode: 'HOLDER_COUNT_INTERNAL_INCONSISTENCY'
  coverDeclaredCount: number
  parsedLegalHolderCount: number
  rawAxisMemberCount: number
  affectedHolderMembers: HolderCountMismatchError['affectedHolderMembers']
  issuerSecurityCode: string
  issuerName: string | null
  sourceSha256: string
  parserVersion: string
  reviewedAt: string
  reviewVersion: string
  reviewStatus: 'APPROVED_FOR_QUARANTINE'
}

// Exact-source adjudications from official XBRL review.
// A new document or changed source hash must return to review, not inherit this disposition.
const REVIEWED = {
  S100Z34W: { sourceSha256: 'b76ebaabaf1d65fbab54ce9952b3caf3436b85f813749d1bea0be15b6b5ab872',
    coverDeclaredCount: 2, parsedLegalHolderCount: 3, rawAxisMemberCount: 3,
    issuerSecurityCode: '7956', reviewedAt: '2026-09-22', reviewVersion: '16D-2' },
  S100Z3AM: { sourceSha256: 'c3e063cfeb2f8fdbe188e32910d35981093eaf3ba25de27f36adb838d5c64ad3',
    coverDeclaredCount: 6, parsedLegalHolderCount: 7, rawAxisMemberCount: 7,
    issuerSecurityCode: '8136', reviewedAt: '2026-09-22', reviewVersion: '16D-2' },
  S100Z2WE: { sourceSha256: '8bb22620485e05aa26c094779d70054bfc76ad2e96e964d09658bd34fe0ab760',
    coverDeclaredCount: 13, parsedLegalHolderCount: 14, rawAxisMemberCount: 14,
    issuerSecurityCode: '4502', reviewedAt: '2026-09-22', reviewVersion: '16D-4' },
} as const

export function reviewedSourceQuarantine(error: HolderCountMismatchError,
  parserVersion: string): SourceQuarantineRecord | null {
  const reviewed = REVIEWED[error.documentId as keyof typeof REVIEWED]
  if (!reviewed || reviewed.sourceSha256 !== error.sourceSha256
    || reviewed.coverDeclaredCount !== error.coverDeclaredCount
    || reviewed.parsedLegalHolderCount !== error.parsedLegalHolderCount
    || reviewed.rawAxisMemberCount !== error.rawAxisMemberCount
    || reviewed.issuerSecurityCode !== error.issuerSecurityCode
    || new Set(error.affectedHolderMembers.map((holder) => `${holder.name}\u0000${holder.address}`)).size
      !== error.parsedLegalHolderCount) return null
  return { documentId: error.documentId, disposition: 'QUARANTINED_SOURCE_INCONSISTENCY',
    reasonCode: error.reasonCode, coverDeclaredCount: error.coverDeclaredCount,
    parsedLegalHolderCount: error.parsedLegalHolderCount,
    rawAxisMemberCount: error.rawAxisMemberCount,
    affectedHolderMembers: error.affectedHolderMembers,
    issuerSecurityCode: error.issuerSecurityCode, issuerName: error.issuerName,
    sourceSha256: error.sourceSha256, parserVersion,
    reviewedAt: reviewed.reviewedAt, reviewVersion: reviewed.reviewVersion,
    reviewStatus: 'APPROVED_FOR_QUARANTINE' }
}
