// Reviewed succession within one official joint-holder reporting series.
// This does not alter either raw holder, alias, or filing record.
export const OZAKI_ATSUSHI_SUCCESSION = {
  canonicalEntityId: 'lh_44ef9d6d00842f13476768dc59f0c222',
  priorEntityId: 'lh_4b4bdd801d865a0c6c577ad03f57bd26',
  ticker: '6459',
  issuerEdinetCode: 'E01961',
  filerEdinetCode: 'E09744',
  reportedShares: 3763000,
  reportedHoldingPct: 7.28,
  priorFilings: {
    S100YI0J: { serial: 16, member: 'FilerLargeVolumeHolder5Member',
      xbrlSha256: 'd5f86c5ac5ef9c6d150fb6a36211a52c3eaa5d02bb80ffeb46d8c872853ec302' },
    S100YQZ0: { serial: 17, member: 'FilerLargeVolumeHolder4Member',
      xbrlSha256: '4fd0d3ce575b1440283bdf11a7038495524de9f9fbae1a50058cf278c881f868' },
  },
  currentFiling: 'S100YX61',
} as const

type PositionEvidence = Record<string, string | number | null>

export function currentPositionEntityId(position: PositionEvidence): string {
  const review = OZAKI_ATSUSHI_SUCCESSION
  if (position.entity_id !== review.priorEntityId) return String(position.entity_id)
  const documentId = String(position.document_id)
  const filing = review.priorFilings[documentId as keyof typeof review.priorFilings]
  if (!filing || position.ticker !== review.ticker
    || position.issuer_edinet_code !== review.issuerEdinetCode
    || position.filer_edinet_code !== review.filerEdinetCode
    || Number(position.reported_shares) !== review.reportedShares
    || Number(position.reported_holding_pct) !== review.reportedHoldingPct
    || Number(position.report_serial_number) !== filing.serial
    || !String(position.holder_key).endsWith(`:${filing.member}`)
    || position.xbrl_sha256 !== filing.xbrlSha256) {
    throw new Error(`reviewed_holder_succession_evidence_changed:${documentId}`)
  }
  return review.canonicalEntityId
}
