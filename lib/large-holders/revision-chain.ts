import { CORRECTION_PREDECESSOR_ADJUDICATIONS } from './revision-adjudications'

export type RevisionFiling = {
  documentId: string
  filingType: string
  submittedAt: string
  obligationDate: string | null
  correctsFilingId: string | null
  previousFilingId: string | null
  issuerEdinetCode: string | null
  issuerSecurityCode: string | null
  withdrawnAt: string | null
  status: string
  sourceSha256?: string | null
  reportSerialNumber?: number | null
  submissionCount?: number | null
}

export type RevisionState = RevisionFiling & {
  rootFilingId: string | null
  revisionSequence: number | null
  isCorrection: boolean
  isSuperseded: boolean
  isEffectiveRevision: boolean
  effectivePredecessorId: string | null
  unresolvedReason: string | null
}

export function resolveRevisionChains(filings: RevisionFiling[], asOf: string): RevisionState[] {
  if (!/^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}(?::\d{2})?)?$/.test(asOf)) {
    throw new Error('invalid_revision_as_of')
  }
  const cutoff = asOf.length === 10 ? `${asOf} 23:59:59` : asOf.length === 16 ? `${asOf}:59` : asOf
  const visible = filings.filter((row) => ['ready', 'withdrawn'].includes(row.status)
    && row.submittedAt <= cutoff
    && (!row.withdrawnAt || row.withdrawnAt > cutoff))
  const byId = new Map(visible.map((row) => [row.documentId, row]))
  const roots = new Map<string, RevisionFiling[]>()
  const errors = new Map<string, string>()
  for (const row of visible) {
    let ancestor = row
    const seen = new Set<string>()
    while (ancestor.filingType === 'AMENDMENT') {
      if (seen.has(ancestor.documentId)) { errors.set(row.documentId, 'correction_cycle'); break }
      seen.add(ancestor.documentId)
      const parent = ancestor.correctsFilingId ? byId.get(ancestor.correctsFilingId) : null
      if (!parent) { errors.set(row.documentId, 'missing_correction_origin'); break }
      if ((ancestor.issuerEdinetCode && parent.issuerEdinetCode && ancestor.issuerEdinetCode !== parent.issuerEdinetCode)
        || (ancestor.issuerSecurityCode && parent.issuerSecurityCode && ancestor.issuerSecurityCode !== parent.issuerSecurityCode)
        || ancestor.submittedAt < parent.submittedAt) {
        errors.set(row.documentId, 'correction_identity_or_chronology_mismatch'); break
      }
      ancestor = parent
    }
    if (!errors.has(row.documentId)) {
      const siblings = roots.get(ancestor.documentId) ?? []
      siblings.push(row)
      roots.set(ancestor.documentId, siblings)
    }
  }
  const states = new Map<string, RevisionState>()
  for (const [rootId, members] of roots) {
    const root = byId.get(rootId)!
    // In real EDINET instances even a non-amendment may retain a report's
    // serial-like DEI count (e.g. No.16 -> 16). Do not rewrite that fact.
    let problem: string | null = Number.isInteger(root.submissionCount) && root.submissionCount! >= 1
      ? null : 'missing_or_invalid_root_submission_count'
    const amendments = members.filter((row) => row.documentId !== rootId)
      .sort((a, b) => (a.submissionCount ?? 0) - (b.submissionCount ?? 0)
        || a.submittedAt.localeCompare(b.submittedAt) || a.documentId.localeCompare(b.documentId))
    const ordered = [root, ...amendments]
    const predecessors = new Map<string, string>()
    for (let i = 1; i < ordered.length; i += 1) {
      const prior = ordered[i - 1]
      const current = ordered[i]
      const adjudication = CORRECTION_PREDECESSOR_ADJUDICATIONS[current.documentId]
      if (adjudication && (adjudication.predecessorId !== prior.documentId
        || adjudication.formalTargetId !== current.correctsFilingId
        || adjudication.currentSha256 !== current.sourceSha256
        || adjudication.predecessorSha256 !== prior.sourceSha256)) {
        problem ??= 'correction_adjudication_evidence_mismatch'
      }
      if (!Number.isInteger(current.submissionCount) || current.submissionCount! < 1) {
        problem ??= 'missing_or_invalid_submission_count'
      } else if (prior.documentId !== rootId && current.submissionCount! < (prior.submissionCount ?? 0)) {
        problem ??= 'non_monotonic_submission_count'
      } else if (prior.documentId !== rootId && current.submissionCount === prior.submissionCount) {
        const explicitTarget = current.correctsFilingId === prior.documentId
        const audited = adjudication?.predecessorId === prior.documentId
          && adjudication.formalTargetId === current.correctsFilingId
          && adjudication.currentSha256 === current.sourceSha256
          && adjudication.predecessorSha256 === prior.sourceSha256
        if (!explicitTarget && !audited) {
          problem ??= 'ambiguous_revision_same_submission_count'
        }
      }
      if (current.submittedAt < prior.submittedAt) problem ??= 'non_monotonic_submission_time'
      if (current.reportSerialNumber != null && root.reportSerialNumber != null
        && current.reportSerialNumber !== root.reportSerialNumber) problem ??= 'report_serial_mismatch'
      predecessors.set(current.documentId, prior.documentId)
    }
    ordered.forEach((row, i) => states.set(row.documentId, {
      ...row, rootFilingId: problem ? null : rootId, revisionSequence: problem ? null : i,
      isCorrection: row.filingType === 'AMENDMENT',
      isSuperseded: !problem && i < ordered.length - 1,
      isEffectiveRevision: !problem && i === ordered.length - 1,
      effectivePredecessorId: problem ? null : predecessors.get(row.documentId) ?? null,
      unresolvedReason: problem,
    }))
  }
  return visible.map((row) => states.get(row.documentId) ?? {
    ...row, rootFilingId: null, revisionSequence: null,
    isCorrection: row.filingType === 'AMENDMENT', isSuperseded: false,
    isEffectiveRevision: false, effectivePredecessorId: null,
    unresolvedReason: errors.get(row.documentId) ?? 'unresolved_revision',
  })
}
