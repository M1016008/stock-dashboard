// @ts-expect-error The pinned Node types predate Node 24's built-in SQLite module.
import { DatabaseSync } from 'node:sqlite'
import { sha256 } from '@/lib/large-holders/evidence-provenance'
import { currentPositionEntityId } from '@/lib/large-holders/entity-adjudications'
import { resolveRevisionChains, type RevisionFiling } from '@/lib/large-holders/revision-chain'
import { blockedTickerSet, readQuarantineScopes } from './quarantine-scope'

type Row = Record<string, string | number | null>
const str = (value: unknown) => String(value ?? '')
const optional = (value: unknown) => value == null ? null : String(value)
const number = (value: unknown) => value == null ? null : Number(value)

export function priceUpdateCompleted(db: DatabaseSync, marketDate: string): boolean {
  if (!marketDate) return false
  const coverage = db.prepare(`SELECT expected_rows FROM jquants_daily_coverage WHERE date=?`)
    .get(marketDate) as Row | undefined
  const sync = db.prepare(`SELECT expected_rows, status, finished_at FROM jquants_sync_runs
    WHERE target_date=? AND api_type='equities/bars/daily:date' ORDER BY id DESC LIMIT 1`)
    .get(marketDate) as Row | undefined
  const actual = db.prepare('SELECT COUNT(*) count FROM ohlcv_daily WHERE date=?')
    .get(marketDate) as Row
  const update = db.prepare(`SELECT status, succeeded, finished_at FROM batch_runs
    WHERE job_type='update_latest' ORDER BY id DESC LIMIT 1`).get() as Row | undefined
  const expected = Number(coverage?.expected_rows ?? 0)
  return expected > 0 && Number(sync?.expected_rows) === expected && sync?.status === 'success'
    && Number(actual.count) >= expected && Number(sync.finished_at) > 0
    && (update?.status === 'success' || update?.status === 'partial')
    && Number(update.succeeded) === 1 && Number(update.finished_at) >= Number(sync.finished_at)
}

export function currentPositionFingerprint(db: DatabaseSync, certifiedOn: string): string {
  const quarantines = readQuarantineScopes(db, certifiedOn)
  const blocked = blockedTickerSet(quarantines)
  const filings = db.prepare(`SELECT f.*,s.xbrl_sha256 FROM large_holder_filings f
    LEFT JOIN large_holder_source_documents s USING(document_id)`).all() as Row[]
  const revisions = resolveRevisionChains(filings.map((row): RevisionFiling => ({
    documentId: str(row.document_id), filingType: str(row.filing_type), submittedAt: str(row.submitted_at),
    obligationDate: optional(row.obligation_date), correctsFilingId: optional(row.corrected_document_id),
    previousFilingId: optional(row.previous_filing_id), issuerEdinetCode: optional(row.issuer_edinet_code),
    issuerSecurityCode: optional(row.issuer_security_code), withdrawnAt: optional(row.withdrawn_at),
    status: str(row.status), sourceSha256: optional(row.xbrl_sha256),
    reportSerialNumber: number(row.report_serial_number), submissionCount: number(row.submission_count),
  })), certifiedOn)
  if (revisions.some((row) => row.unresolvedReason)) throw new Error('revision_chain_unresolved')
  const effective = new Set(revisions.filter((row) => row.isEffectiveRevision).map((row) => row.documentId))
  const positions = (db.prepare(`SELECT p.*,f.issuer_edinet_code,f.issuer_security_code,
    f.filer_edinet_code,f.report_serial_number,f.submitted_at,
    f.obligation_date AS filing_obligation_date,s.xbrl_sha256
    FROM large_holder_positions p JOIN large_holder_filings f USING(document_id)
    LEFT JOIN large_holder_source_documents s USING(document_id)`).all() as Row[])
    .filter((row) => effective.has(str(row.document_id)) && !blocked.has(str(row.ticker)))
    .toSorted((a, b) => str(b.obligation_date ?? b.submitted_at).slice(0, 10)
      .localeCompare(str(a.obligation_date ?? a.submitted_at).slice(0, 10))
      || str(b.submitted_at).localeCompare(str(a.submitted_at))
      || str(b.document_id).localeCompare(str(a.document_id)))
  const current = new Map<string, Row>()
  for (const row of positions) {
    const key = `${currentPositionEntityId(row)}:${row.ticker}`
    if (!current.has(key)) current.set(key, row)
  }
  const fingerprintPositions = [...current].sort(([a], [b]) => a.localeCompare(b))
    .map(([key, row]) => ({ key, documentId: row.document_id, holderKey: row.holder_key,
      entityId: row.entity_id, shares: row.reported_shares, pct: row.reported_holding_pct,
      units: row.market_price_eligible_units, status: row.market_price_status,
      breakdown: row.security_breakdown_json, source: row.xbrl_sha256 }))
  return sha256(JSON.stringify(quarantines.length ? { quarantines: quarantines.map((scope) => [scope.documentId,
    scope.ticker, scope.sourceSha256]), positions: fingerprintPositions } : fingerprintPositions))
}

export function readLargeHolderSourceState(db: DatabaseSync, certifiedOn: string) {
  const marketDate = str((db.prepare('SELECT MAX(date) d FROM ohlcv_daily').get() as Row | undefined)?.d)
  const priceEvidenceDate = str((db.prepare('SELECT MAX(price_date) d FROM large_holder_price_evidence').get() as Row | undefined)?.d)
  const filing = db.prepare(`SELECT COUNT(*) count,MAX(imported_at) importedAt,
    MAX(submitted_at) submittedAt FROM large_holder_filings`).get() as Row
  const failed = db.prepare(`SELECT COUNT(*) count FROM large_holder_filings
    WHERE status IN ('failed','review','review_required_source_inconsistency')
      AND substr(submitted_at,1,10)<=?`).get(certifiedOn) as Row
  return { marketDate, priceEvidenceDate, filingCount: Number(filing.count ?? 0),
    priceBatchComplete: priceUpdateCompleted(db, marketDate),
    latestImportedAt: number(filing.importedAt), latestSubmittedAt: optional(filing.submittedAt),
    unresolvedFilingCount: Number(failed.count ?? 0),
    currentPositionHash: currentPositionFingerprint(db, certifiedOn) }
}
