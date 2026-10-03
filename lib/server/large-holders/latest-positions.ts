import { client, ensureReady } from '@/lib/db/client'
import { resolveRevisionChains, type RevisionFiling, type RevisionState } from '@/lib/large-holders/revision-chain'

export type LatestDisclosedPosition = {
  documentId: string
  ticker: string
  entityId: string
  reportedShares: number | null
  holdingPct: number | null
  valuationEligibleShares: number | null
  submittedAt: string
  obligationDate: string | null
  rootFilingId: string
  revisionSequence: number
}

async function revisionsAt(asOf: string): Promise<RevisionState[]> {
  if (!/^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}(?::\d{2})?)?$/.test(asOf)) throw new Error('Invalid as-of date')
  await ensureReady()
  const result = await client.execute({
    sql: `SELECT f.document_id, f.filing_type, f.submitted_at, f.obligation_date, f.corrected_document_id,
      f.previous_filing_id, f.issuer_edinet_code, f.issuer_security_code, f.withdrawn_at, f.status,
      f.report_serial_number, f.submission_count,
      s.xbrl_sha256 FROM large_holder_filings f
      LEFT JOIN large_holder_source_documents s ON s.document_id=f.document_id
      WHERE f.status IN ('ready', 'withdrawn') AND substr(f.submitted_at,1,10)<=?`,
    args: [asOf.slice(0, 10)],
  })
  return resolveRevisionChains(result.rows.map((row): RevisionFiling => ({
    documentId: String(row.document_id), filingType: String(row.filing_type),
    submittedAt: String(row.submitted_at),
    obligationDate: row.obligation_date == null ? null : String(row.obligation_date),
    correctsFilingId: row.corrected_document_id == null ? null : String(row.corrected_document_id),
    previousFilingId: row.previous_filing_id == null ? null : String(row.previous_filing_id),
    issuerEdinetCode: row.issuer_edinet_code == null ? null : String(row.issuer_edinet_code),
    issuerSecurityCode: row.issuer_security_code == null ? null : String(row.issuer_security_code),
    withdrawnAt: row.withdrawn_at == null ? null : String(row.withdrawn_at),
    status: String(row.status),
    sourceSha256: row.xbrl_sha256 == null ? null : String(row.xbrl_sha256),
    reportSerialNumber: row.report_serial_number == null ? null : Number(row.report_serial_number),
    submissionCount: row.submission_count == null ? null : Number(row.submission_count),
  })), asOf)
}

export async function revisionHistory(asOf: string, rootFilingId: string): Promise<RevisionState[]> {
  return (await revisionsAt(asOf)).filter((row) => row.rootFilingId === rootFilingId)
    .sort((left, right) => (left.revisionSequence ?? 0) - (right.revisionSequence ?? 0))
}

export type CorrectionComparison = {
  before: { documentId: string; issuerEdinetCode: string | null; issuerSecurityCode: string | null;
    issuerName: string | null; obligationDate: string | null;
    holders: { key: string; name: string; role: string; shares: number | null; holdingPct: number | null }[] } | null
  after: NonNullable<CorrectionComparison['before']>
}

export async function compareCorrection(documentId: string, asOf: string): Promise<CorrectionComparison> {
  if (!/^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}(?::\d{2})?)?$/.test(asOf)) throw new Error('Invalid as-of date')
  const cutoff = asOf.length === 10 ? `${asOf} 23:59:59` : asOf.length === 16 ? `${asOf}:59` : asOf
  await ensureReady()
  const load = async (id: string) => {
    const result = await client.execute({
      sql: `SELECT document_id, issuer_edinet_code, issuer_security_code, issuer_name,
        obligation_date, corrected_document_id, filing_type, submitted_at FROM large_holder_filings
        WHERE document_id=? AND submitted_at<=?`, args: [id, cutoff],
    })
    const row = result.rows[0]
    if (!row) return null
    const holders = await client.execute({
      sql: `SELECT p.holder_key, e.display_name, p.holder_role, p.reported_shares,
        p.reported_holding_pct FROM large_holder_positions p
        JOIN investor_entities e ON e.entity_id=p.entity_id
        WHERE p.document_id=? ORDER BY p.holder_key`, args: [id],
    })
    return { documentId: String(row.document_id),
      issuerEdinetCode: row.issuer_edinet_code == null ? null : String(row.issuer_edinet_code),
      issuerSecurityCode: row.issuer_security_code == null ? null : String(row.issuer_security_code),
      issuerName: row.issuer_name == null ? null : String(row.issuer_name),
      obligationDate: row.obligation_date == null ? null : String(row.obligation_date),
      correctedDocumentId: row.corrected_document_id == null ? null : String(row.corrected_document_id),
      filingType: String(row.filing_type),
      holders: holders.rows.map((holder) => ({ key: String(holder.holder_key),
        name: String(holder.display_name), role: String(holder.holder_role),
        shares: holder.reported_shares == null ? null : Number(holder.reported_shares),
        holdingPct: holder.reported_holding_pct == null ? null : Number(holder.reported_holding_pct),
      })) }
  }
  const after = await load(documentId)
  if (!after || after.filingType !== 'AMENDMENT') throw new Error('correction_not_available_as_of')
  const revision = (await revisionsAt(asOf)).find((item) => item.documentId === documentId)
  if (!revision || revision.unresolvedReason) throw new Error('correction_chain_unresolved_as_of')
  const before = revision.effectivePredecessorId ? await load(revision.effectivePredecessorId) : null
  if (!before) throw new Error('correction_origin_not_available_as_of')
  return { before, after }
}

export async function latestDisclosedPositions(asOf: string): Promise<LatestDisclosedPosition[]> {
  const selected = (await revisionsAt(asOf)).filter((item) => item.isEffectiveRevision)
  const positions: LatestDisclosedPosition[] = []
  for (let index = 0; index < selected.length; index += 400) {
    const chunk = selected.slice(index, index + 400)
    if (!chunk.length) continue
    const result = await client.execute({
      sql: `SELECT document_id, ticker, entity_id, reported_shares, reported_holding_pct,
        valuation_eligible_shares FROM large_holder_positions
        WHERE document_id IN (${chunk.map(() => '?').join(',')})`,
      args: chunk.map((item) => item.documentId),
    })
    const byId = new Map(chunk.map((item) => [item.documentId, item]))
    for (const row of result.rows) {
      const filing = byId.get(String(row.document_id))!
      positions.push({ documentId: filing.documentId, ticker: String(row.ticker),
        entityId: String(row.entity_id),
        reportedShares: row.reported_shares == null ? null : Number(row.reported_shares),
        holdingPct: row.reported_holding_pct == null ? null : Number(row.reported_holding_pct),
        valuationEligibleShares: row.valuation_eligible_shares == null ? null : Number(row.valuation_eligible_shares),
        submittedAt: filing.submittedAt, obligationDate: filing.obligationDate,
        rootFilingId: filing.rootFilingId!, revisionSequence: filing.revisionSequence!,
      })
    }
  }
  positions.sort((a, b) => {
    const date = (b.obligationDate ?? b.submittedAt.slice(0, 10)).localeCompare(a.obligationDate ?? a.submittedAt.slice(0, 10))
    return date || b.submittedAt.localeCompare(a.submittedAt) || b.documentId.localeCompare(a.documentId)
  })
  const latest = new Map<string, LatestDisclosedPosition>()
  for (const position of positions) {
    const key = `${position.entityId}:${position.ticker}`
    if (!latest.has(key)) latest.set(key, position)
  }
  return [...latest.values()].sort((a, b) => a.entityId.localeCompare(b.entityId) || a.ticker.localeCompare(b.ticker))
}
