// @ts-expect-error The pinned Node types predate Node 24's built-in SQLite module.
import type { DatabaseSync } from 'node:sqlite'
import { reviewedSourceQuarantine, SOURCE_QUARANTINE_STATUS,
  type SourceQuarantineRecord } from '@/lib/large-holders/source-quarantine'
import { HolderCountMismatchError } from '@/lib/large-holders/filing'
import { sha256 } from '@/lib/large-holders/evidence-provenance'

type Row = Record<string, string | number | null>

export type QuarantineScope = {
  documentId: string
  ticker: string
  issuerName: string | null
  issuerEdinetCode: string | null
  submittedAt: string
  reasonCode: SourceQuarantineRecord['reasonCode']
  sourceSha256: string
  affectedHolderMembers: SourceQuarantineRecord['affectedHolderMembers']
}

export function readQuarantineScopes(db: DatabaseSync, asOf: string): QuarantineScope[] {
  const rows = db.prepare(`SELECT f.document_id,f.ticker,f.issuer_name,f.issuer_edinet_code,
    f.submitted_at,f.raw_parsed_payload_json,s.xbrl_sha256,s.xbrl_xml
    FROM large_holder_filings f JOIN large_holder_source_documents s USING(document_id)
    WHERE f.status=? AND substr(f.submitted_at,1,10)<=? ORDER BY f.document_id`)
    .all(SOURCE_QUARANTINE_STATUS, asOf) as Row[]
  return rows.map((row) => {
    const record = JSON.parse(String(row.raw_parsed_payload_json ?? 'null')) as SourceQuarantineRecord | null
    if (!record || record.documentId !== row.document_id || record.sourceSha256 !== row.xbrl_sha256
      || sha256(String(row.xbrl_xml ?? '')) !== record.sourceSha256
      || record.issuerSecurityCode !== row.ticker || !row.ticker
      || record.disposition !== 'QUARANTINED_SOURCE_INCONSISTENCY'
      || record.reviewStatus !== 'APPROVED_FOR_QUARANTINE'
      || !reviewedSourceQuarantine(new HolderCountMismatchError(record.documentId,
        record.coverDeclaredCount, record.parsedLegalHolderCount, record.rawAxisMemberCount,
        record.affectedHolderMembers, record.issuerSecurityCode, record.issuerName,
        record.sourceSha256), record.parserVersion))
      throw new Error(`quarantine_evidence_invalid:${row.document_id}`)
    return { documentId: record.documentId, ticker: String(row.ticker),
      issuerName: row.issuer_name == null ? null : String(row.issuer_name),
      issuerEdinetCode: row.issuer_edinet_code == null ? null : String(row.issuer_edinet_code),
      submittedAt: String(row.submitted_at), reasonCode: record.reasonCode,
      sourceSha256: record.sourceSha256, affectedHolderMembers: record.affectedHolderMembers }
  })
}

export function blockedTickerSet(scopes: QuarantineScope[]): Set<string> {
  return new Set(scopes.map((scope) => scope.ticker))
}
