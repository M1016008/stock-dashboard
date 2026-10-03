// Read-only verification of the two real same-count amendment sequences.
import assert from 'node:assert/strict'
import { client } from '@/lib/db/client'
import { resolveRevisionChains, type RevisionFiling } from '@/lib/large-holders/revision-chain'

async function main() {
  const ids = ['S100Y0JP', 'S100Y1GY', 'S100Y1RL', 'S100YZFC', 'S100Z1X5', 'S100Z26F']
  const rows = await client.execute({ sql: `SELECT f.document_id, f.filing_type, f.submitted_at,
    f.corrected_document_id, f.report_serial_number, f.report_serial_source,
    f.submission_count, f.issuer_edinet_code, f.issuer_security_code,
    f.obligation_date, f.previous_filing_id, f.withdrawn_at, f.status, s.xbrl_sha256
    FROM large_holder_filings f JOIN large_holder_source_documents s USING(document_id)
    WHERE f.document_id IN (${ids.map(() => '?').join(',')})`, args: ids })
  assert.equal(rows.rows.length, ids.length)
  const filings: RevisionFiling[] = rows.rows.map((r) => ({
    documentId: String(r.document_id), filingType: String(r.filing_type),
    submittedAt: String(r.submitted_at), correctsFilingId: r.corrected_document_id == null ? null : String(r.corrected_document_id),
    reportSerialNumber: r.report_serial_number == null ? null : Number(r.report_serial_number),
    submissionCount: r.submission_count == null ? null : Number(r.submission_count),
    issuerEdinetCode: r.issuer_edinet_code == null ? null : String(r.issuer_edinet_code),
    issuerSecurityCode: r.issuer_security_code == null ? null : String(r.issuer_security_code),
    obligationDate: r.obligation_date == null ? null : String(r.obligation_date),
    previousFilingId: r.previous_filing_id == null ? null : String(r.previous_filing_id),
    withdrawnAt: r.withdrawn_at == null ? null : String(r.withdrawn_at), status: String(r.status),
    sourceSha256: String(r.xbrl_sha256),
  }))
  const scenarios = [
    ['2026-04-30 09:31', 'S100Y0JP'], ['2026-04-30 09:32', 'S100Y1GY'],
    ['2026-05-01 09:10', 'S100Y1RL'], ['2026-09-14 14:38', 'S100YZFC'],
    ['2026-09-14 14:39', 'S100Z1X5'], ['2026-09-14 15:25', 'S100Z26F'],
  ] as const
  for (const [asOf, expected] of scenarios) {
    const root = expected.startsWith('S100Y') && !expected.startsWith('S100YZ')
      ? 'S100Y0JP' : 'S100YZFC'
    const selected = resolveRevisionChains(filings, asOf).find((r) => r.isEffectiveRevision && r.rootFilingId === root)
    assert.equal(selected?.documentId, expected, `${asOf} effective correction`)
  }
  console.log(JSON.stringify({ revisedDocuments: rows.rows.map((r) => ({
    documentId: r.document_id, serial: r.report_serial_number, serialSource: r.report_serial_source,
    submissionCount: r.submission_count, submittedAt: r.submitted_at,
    amendedDocumentId: r.corrected_document_id,
  })), checkedAsOfTimestamps: scenarios.length, unresolved: 0 }, null, 2))
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
