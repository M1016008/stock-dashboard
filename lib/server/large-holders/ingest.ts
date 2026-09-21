import { createHash } from 'node:crypto'
import { client, ensureReady } from '@/lib/db/client'
import { type LargeHolderFiling } from '@/lib/large-holders/filing'
import { resolveRevisionChains, type RevisionFiling } from '@/lib/large-holders/revision-chain'
import { classifyFromFiling, classForCategory, INVESTOR_CATEGORIES, type InvestorCategory } from '@/lib/large-holders/classification'
import { assessMarketPriceHolding } from '@/lib/large-holders/market-price-eligibility'
import { marketPriceEvidence } from './market-price-evidence'
import type { EdinetDocumentIndexRow } from '@/lib/server/edinet-api'

export const LARGE_HOLDER_PARSER_VERSION = '16a6-1'

type DbExecutor = Pick<typeof client, 'execute'>

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function normalized(value: string): string {
  return value.normalize('NFKC').replace(/[\s\u3000]+/g, '').toLowerCase()
}

function tickerFromIssuer(code: string | null): string | null {
  const cleaned = code?.trim().toUpperCase() ?? ''
  if (/^[0-9A-Z]{4}$/.test(cleaned)) return cleaned
  if (/^[0-9A-Z]{4}0$/.test(cleaned)) return cleaned.slice(0, 4)
  return null
}

async function resolveEntity(
  db: DbExecutor,
  filing: LargeHolderFiling,
  row: EdinetDocumentIndexRow,
  holder: LargeHolderFiling['holders'][number],
): Promise<string> {
  const addressIdentity = holder.address
    ? `name-address:${normalized(holder.name)}:${normalized(holder.address)}` : null
  const codeIdentity = holder.role === 'PRIMARY' && row.edinetCode
    ? `edinet:${row.edinetCode}` : null
  const identity = codeIdentity ?? addressIdentity ?? `filing:${filing.documentId}:${holder.key}`
  const identityKey = hash(identity)
  const existing = await db.execute({ sql: 'SELECT entity_id FROM investor_aliases WHERE identity_key = ?', args: [identityKey] })
  const addressKey = addressIdentity ? hash(addressIdentity) : null
  const byAddress = addressKey ? await db.execute({
    sql: 'SELECT entity_id FROM investor_aliases WHERE identity_key = ?', args: [addressKey],
  }) : null
  const codeEntityId = existing.rows[0]?.entity_id == null ? null : String(existing.rows[0].entity_id)
  const addressEntityId = byAddress?.rows[0]?.entity_id == null ? null : String(byAddress.rows[0].entity_id)
  if (codeEntityId && addressEntityId && codeEntityId !== addressEntityId) {
    await db.execute({
      sql: `INSERT INTO investor_identity_reviews (identity_key, reason) VALUES (?, 'conflicting_stable_identities')
        ON CONFLICT(identity_key) DO NOTHING`, args: [identityKey],
    })
  }
  const entityId = codeEntityId ?? addressEntityId ?? `lh_${identityKey.slice(0, 32)}`
  const classification = classifyFromFiling(holder.personOrCorporation, holder.businessDescription, holder.address)
  await db.execute({
    sql: `INSERT INTO investor_entities (entity_id, canonical_name, display_name, investor_type,
      investor_class, is_individual, classification_confidence, classification_source, classification_evidence)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(entity_id) DO UPDATE SET
        investor_type=excluded.investor_type, investor_class=excluded.investor_class,
        is_individual=excluded.is_individual,
        classification_confidence=excluded.classification_confidence,
        classification_source=excluded.classification_source,
        classification_evidence=excluded.classification_evidence
        WHERE investor_entities.manual_override=0
          AND investor_entities.investor_class='UNCLASSIFIED'
          AND excluded.classification_confidence='AUTO_CONFIDENT'`,
    args: [entityId, holder.name, holder.name, classification.category, classification.investorClass,
      classification.category === 'INDIVIDUAL' ? 1 : 0, classification.confidence,
      classification.source, classification.evidence],
  })
  await db.execute({
    sql: `INSERT INTO investor_aliases (identity_key, entity_id, raw_holder_name, raw_holder_address,
      filer_edinet_code, match_confidence) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(identity_key) DO NOTHING`,
    args: [identityKey, entityId, holder.name, holder.address,
      holder.role === 'PRIMARY' ? row.edinetCode ?? null : null,
      identity.startsWith('filing:') ? 'AUTO_UNCERTAIN' : 'AUTO_CONFIDENT'],
  })
  if (addressKey && !addressEntityId) {
    await db.execute({
      sql: `INSERT INTO investor_aliases (identity_key, entity_id, raw_holder_name,
        raw_holder_address, match_confidence) VALUES (?, ?, ?, ?, 'AUTO_CONFIDENT')
        ON CONFLICT(identity_key) DO NOTHING`,
      args: [addressKey, entityId, holder.name, holder.address],
    })
  }
  if (identity.startsWith('filing:') || classification.confidence !== 'AUTO_CONFIDENT') {
    await db.execute({
      sql: `INSERT INTO investor_identity_reviews (identity_key, reason) VALUES (?, ?)
        ON CONFLICT(identity_key) DO NOTHING`,
      args: [identityKey, identity.startsWith('filing:') ? 'identity_without_stable_evidence' : 'investor_type_unclassified'],
    })
  }
  return entityId
}

export async function storeLargeHolderFiling(
  row: EdinetDocumentIndexRow,
  filing: LargeHolderFiling,
  xml: string,
): Promise<'ready' | 'review'> {
  await ensureReady()
  const ticker = tickerFromIssuer(filing.issuerSecurityCode)
  const status = ticker && filing.obligationDate && filing.schemaRegime !== 'UNKNOWN' ? 'ready' : 'review'
  const tx = await client.transaction('write')
  try {
    const sourceSha = hash(xml)
    const priorSource = await tx.execute({
      sql: 'SELECT xbrl_sha256 FROM large_holder_source_documents WHERE document_id=?',
      args: [filing.documentId],
    })
    if (priorSource.rows.length && String(priorSource.rows[0].xbrl_sha256) !== sourceSha) {
      throw new Error(`immutable_large_holder_source_changed:${filing.documentId}`)
    }
    await tx.execute({
      sql: `INSERT INTO large_holder_filings (
        document_id, filing_type, submitted_at, obligation_date, reference_date, parent_document_id,
        corrected_document_id, issuer_edinet_code, issuer_security_code, issuer_name,
        ticker, primary_holder_name, group_shares, group_holding_pct, source_url,
        raw_index_json, raw_parsed_payload_json, parser_version, status,
        previous_filing_id, filer_edinet_code, filer_name, schema_regime,
        report_serial_number, report_serial_source, submission_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(document_id) DO UPDATE SET
        filing_type=excluded.filing_type, submitted_at=excluded.submitted_at,
        obligation_date=excluded.obligation_date, reference_date=excluded.reference_date,
        parent_document_id=excluded.parent_document_id,
        corrected_document_id=excluded.corrected_document_id,
        issuer_edinet_code=excluded.issuer_edinet_code,
        issuer_security_code=excluded.issuer_security_code, issuer_name=excluded.issuer_name,
        ticker=excluded.ticker, primary_holder_name=excluded.primary_holder_name,
        group_shares=excluded.group_shares, group_holding_pct=excluded.group_holding_pct,
        source_url=excluded.source_url,
        previous_filing_id=excluded.previous_filing_id,
        filer_edinet_code=excluded.filer_edinet_code, filer_name=excluded.filer_name,
        schema_regime=excluded.schema_regime,
        report_serial_number=excluded.report_serial_number,
        report_serial_source=excluded.report_serial_source,
        submission_count=excluded.submission_count,
        parser_version=excluded.parser_version,
        status=CASE WHEN large_holder_filings.withdrawn_at IS NULL
          THEN excluded.status ELSE large_holder_filings.status END,
        error_message=NULL`,
      args: [filing.documentId, filing.filingType, filing.submittedAt, filing.obligationDate,
        filing.referenceDate, filing.parentDocumentId, filing.correctedDocumentId, filing.issuerEdinetCode,
        filing.issuerSecurityCode, filing.issuerName, ticker, filing.primaryHolderName,
        filing.groupShares, filing.groupHoldingPct, filing.sourceUrl, JSON.stringify(row),
        JSON.stringify(filing), LARGE_HOLDER_PARSER_VERSION, status,
        filing.previousFilingId, filing.filerEdinetCode, filing.filerName, filing.schemaRegime,
        filing.reportSerialNumber, filing.reportSerialSource, filing.submissionCount],
    })
    if (!priorSource.rows.length) {
      await tx.execute({
        sql: `INSERT INTO large_holder_source_documents (document_id, xbrl_sha256, xbrl_xml)
          VALUES (?, ?, ?)`, args: [filing.documentId, sourceSha, xml],
      })
    }
    await tx.execute({ sql: 'DELETE FROM large_holder_positions WHERE document_id = ?', args: [filing.documentId] })
    await tx.execute({ sql: 'DELETE FROM large_holder_groups WHERE document_id = ?', args: [filing.documentId] })
    if (status === 'ready' && ticker) {
      const entities: string[] = []
      for (const holder of filing.holders) entities.push(await resolveEntity(tx, filing, row, holder))
      const primaryIndex = filing.holders.findIndex((holder) => holder.role === 'PRIMARY')
      await tx.execute({
        sql: `INSERT INTO large_holder_groups
          (document_id, primary_entity_id, group_shares, group_holding_pct, participant_count)
          VALUES (?, ?, ?, ?, ?)`,
        args: [filing.documentId, entities[primaryIndex >= 0 ? primaryIndex : 0], filing.groupShares,
          filing.groupHoldingPct, filing.holders.length],
      })
      for (let i = 0; i < filing.holders.length; i += 1) {
        const holder = filing.holders[i]
        const instrumentEvidence = await marketPriceEvidence(tx, filing, holder, ticker)
        const assessment = assessMarketPriceHolding(holder, instrumentEvidence)
        const pctDelta = holder.holdingPct != null && holder.previousHoldingPct != null
          ? holder.holdingPct - holder.previousHoldingPct : null
        await tx.execute({
          sql: `INSERT INTO large_holder_positions (
            document_id, holder_key, ticker, entity_id, holding_group_id, holder_role,
            reported_shares, reported_holding_pct, previous_reported_shares,
            previous_holding_pct, shares_delta, holding_pct_delta, obligation_date,
            reference_date, ordinary_share_candidate, valuation_eligible_shares,
            reported_equivalent_shares, valuation_coverage_pct, valuation_basis,
            valuation_confidence, valuation_status, valuation_evidence_json, security_components_json,
            security_breakdown_json, deductions_json, market_price_eligible_units,
            market_price_status, market_price_reason, market_price_basis_json,
            market_price_evidence_json, market_price_close_date, market_price_close
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [filing.documentId, holder.key, ticker, entities[i], filing.documentId,
            holder.role, holder.shares, holder.holdingPct, null, holder.previousHoldingPct,
            null, pctDelta, filing.obligationDate, holder.referenceDate ?? filing.referenceDate,
            holder.ordinaryShareCandidate, holder.valuationEligibleShares, holder.shares,
            holder.valuationEligibleShares != null && holder.shares != null && holder.shares > 0
              ? holder.valuationEligibleShares / holder.shares * 100 : null,
            holder.valuationBasis, holder.valuationEligibleShares != null ? 'SOURCE_EVIDENCED' : 'UNCONFIRMED', holder.valuationStatus,
            JSON.stringify(holder.valuationEvidence), JSON.stringify(holder.securityComponents),
            JSON.stringify(holder.securityBreakdown), JSON.stringify(holder.deductions),
            assessment.eligibleUnits, assessment.status, assessment.reason,
            JSON.stringify(assessment.basisUnits), JSON.stringify(instrumentEvidence),
            instrumentEvidence.priceDate, instrumentEvidence.close],
        })
      }
    }
    const rows = await tx.execute({
      sql: `SELECT f.document_id, f.filing_type, f.submitted_at, f.obligation_date, f.corrected_document_id,
        f.previous_filing_id, f.issuer_edinet_code, f.issuer_security_code, f.withdrawn_at, f.status,
        f.report_serial_number, f.submission_count,
        s.xbrl_sha256 FROM large_holder_filings f
        LEFT JOIN large_holder_source_documents s ON s.document_id=f.document_id
        WHERE f.status IN ('ready', 'withdrawn')`, args: [],
    })
    const revisions = resolveRevisionChains(rows.rows.map((item): RevisionFiling => ({
      documentId: String(item.document_id), filingType: String(item.filing_type),
      submittedAt: String(item.submitted_at),
      obligationDate: item.obligation_date == null ? null : String(item.obligation_date),
      correctsFilingId: item.corrected_document_id == null ? null : String(item.corrected_document_id),
      previousFilingId: item.previous_filing_id == null ? null : String(item.previous_filing_id),
      issuerEdinetCode: item.issuer_edinet_code == null ? null : String(item.issuer_edinet_code),
      issuerSecurityCode: item.issuer_security_code == null ? null : String(item.issuer_security_code),
      withdrawnAt: item.withdrawn_at == null ? null : String(item.withdrawn_at), status: String(item.status),
      sourceSha256: item.xbrl_sha256 == null ? null : String(item.xbrl_sha256),
      reportSerialNumber: item.report_serial_number == null ? null : Number(item.report_serial_number),
      submissionCount: item.submission_count == null ? null : Number(item.submission_count),
    })), '9999-12-31')
    for (const revision of revisions) {
      await tx.execute({ sql: `UPDATE large_holder_filings SET root_filing_id=?, revision_sequence=?
        WHERE document_id=? AND (root_filing_id IS NOT ? OR revision_sequence IS NOT ?)`,
      args: [revision.rootFilingId, revision.revisionSequence, revision.documentId,
        revision.rootFilingId, revision.revisionSequence] })
    }
    await tx.commit()
    return status
  } catch (error) {
    await tx.rollback()
    throw error
  }
}

export async function recordLargeHolderWithdrawal(documentId: string, withdrawnAt: string): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(withdrawnAt)) {
    throw new Error('Withdrawal notice has no usable timestamp')
  }
  await ensureReady()
  await client.execute({
    sql: `UPDATE large_holder_filings SET status='withdrawn',
      withdrawn_at=CASE WHEN withdrawn_at IS NULL OR withdrawn_at > ? THEN ? ELSE withdrawn_at END
      WHERE document_id=? AND status IN ('ready', 'withdrawn')`,
    args: [withdrawnAt, withdrawnAt, documentId],
  })
}

export async function setEvidenceBackedInvestorClassification(
  entityId: string, category: InvestorCategory, evidence: string,
): Promise<void> {
  if (!INVESTOR_CATEGORIES.includes(category) || category === 'UNCLASSIFIED'
      || !evidence.trim() || evidence.length > 1000) {
    throw new Error('classification_requires_specific_category_and_source_evidence')
  }
  await ensureReady()
  const result = await client.execute({
    sql: `UPDATE investor_entities SET investor_type=?, investor_class=?, is_individual=?,
      classification_confidence='MANUAL', classification_evidence=?, manual_override=1,
      updated_at=unixepoch() WHERE entity_id=?`,
    args: [category, classForCategory(category), category === 'INDIVIDUAL' ? 1 : 0,
      evidence.trim(), entityId],
  })
  if (!result.rowsAffected) throw new Error('investor_entity_not_found')
}
