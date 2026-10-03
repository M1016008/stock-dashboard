import { client, ensureReady } from '@/lib/db/client'
import type {
  CompanyOverviewFact,
  EmployeeInformationFact,
  MajorShareholderFact,
  OfficerInformationFact,
  PolicyHoldingFact,
  SegmentInformationFact,
} from '@/lib/edinet-xbrl'
import { EDINET_COMPANY_PARSER_VERSION } from '@/lib/company-information'

export interface EdinetCompanySnapshotInput {
  documentId: string
  ticker: string
  edinetCode: string | null
  documentType: string
  filerName: string | null
  publishedAt: string
  periodStart: string | null
  periodEnd: string | null
  accountingStandard: string
  correctionStatus: string
  xbrlFactCount: number
  overview: CompanyOverviewFact
  employees: EmployeeInformationFact
  officers: OfficerInformationFact
  segments: SegmentInformationFact
  majorShareholders: MajorShareholderFact[]
  policyHoldings: PolicyHoldingFact[]
}

function employeeSnapshotCount(value: EmployeeInformationFact): number {
  return Number(value.consolidated != null) + Number(value.nonConsolidated != null)
}

export async function edinetCompanySnapshotExists(documentId: string): Promise<boolean> {
  await ensureReady()
  const result = await client.execute({
    sql: `SELECT 1 FROM edinet_company_snapshots WHERE document_id = ? LIMIT 1`,
    args: [documentId],
  })
  return result.rows.length > 0
}

export async function saveEdinetCompanySnapshot(input: EdinetCompanySnapshotInput): Promise<void> {
  await ensureReady()
  const fiscalYear = input.periodEnd ? Number(input.periodEnd.slice(0, 4)) : null
  const hasCompanyOverview = Boolean(
    input.overview.businessDescription
    || input.overview.businessPolicy
    || input.overview.companyHistory,
  )
  const statements: Array<{ sql: string; args: Array<string | number | null> }> = [{
    sql: `
      INSERT INTO edinet_company_snapshots (
        document_id, ticker, edinet_code, document_type, filer_name, published_at,
        period_start, period_end, fiscal_year, accounting_standard, correction_status,
        consolidation_scope, company_overview_json, employee_information_json,
        officer_information_json, segment_information_json, has_company_overview,
        employee_snapshot_count, officer_count, segment_count, geographic_area_count,
        major_customer_count, major_shareholder_count, policy_holding_count,
        xbrl_fact_count, parser_version, source, imported_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'mixed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'edinet', unixepoch())
      ON CONFLICT(document_id) DO UPDATE SET
        ticker = excluded.ticker,
        edinet_code = excluded.edinet_code,
        document_type = excluded.document_type,
        filer_name = excluded.filer_name,
        published_at = excluded.published_at,
        period_start = excluded.period_start,
        period_end = excluded.period_end,
        fiscal_year = excluded.fiscal_year,
        accounting_standard = excluded.accounting_standard,
        correction_status = excluded.correction_status,
        consolidation_scope = excluded.consolidation_scope,
        company_overview_json = excluded.company_overview_json,
        employee_information_json = excluded.employee_information_json,
        officer_information_json = excluded.officer_information_json,
        segment_information_json = excluded.segment_information_json,
        has_company_overview = excluded.has_company_overview,
        employee_snapshot_count = excluded.employee_snapshot_count,
        officer_count = excluded.officer_count,
        segment_count = excluded.segment_count,
        geographic_area_count = excluded.geographic_area_count,
        major_customer_count = excluded.major_customer_count,
        major_shareholder_count = excluded.major_shareholder_count,
        policy_holding_count = excluded.policy_holding_count,
        xbrl_fact_count = excluded.xbrl_fact_count,
        parser_version = excluded.parser_version,
        source = excluded.source,
        imported_at = excluded.imported_at
    `,
    args: [
      input.documentId,
      input.ticker,
      input.edinetCode,
      input.documentType,
      input.filerName,
      input.publishedAt,
      input.periodStart,
      input.periodEnd,
      Number.isFinite(fiscalYear) ? fiscalYear : null,
      input.accountingStandard,
      input.correctionStatus,
      JSON.stringify(input.overview),
      JSON.stringify(input.employees),
      JSON.stringify(input.officers),
      JSON.stringify(input.segments),
      hasCompanyOverview ? 1 : 0,
      employeeSnapshotCount(input.employees),
      input.officers.officers.length,
      input.segments.segments.length,
      input.segments.geographicAreas.length,
      input.segments.majorCustomers.length,
      input.majorShareholders.length,
      input.policyHoldings.length,
      input.xbrlFactCount,
      EDINET_COMPANY_PARSER_VERSION,
    ],
  }, {
    sql: `DELETE FROM major_shareholders WHERE ticker = ? AND document_id = ?`,
    args: [input.ticker, input.documentId],
  }, {
    sql: `DELETE FROM policy_holdings WHERE ticker = ? AND document_id = ?`,
    args: [input.ticker, input.documentId],
  }]

  input.majorShareholders.forEach((row, index) => statements.push({
    sql: `
      INSERT INTO major_shareholders (
        ticker, document_id, rank, fiscal_year_end, holder_name, shares,
        holding_ratio, submitted_at, source, imported_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'edinet', unixepoch())
    `,
    args: [
      input.ticker,
      input.documentId,
      index + 1,
      input.periodEnd,
      row.holderName,
      row.shares,
      row.holdingRatio,
      input.publishedAt,
    ],
  }))
  input.policyHoldings.forEach((row, index) => statements.push({
    sql: `
      INSERT INTO policy_holdings (
        ticker, document_id, rank, fiscal_year_end, issuer_name, shares, book_value,
        purpose, quantitative_effect, holding_type, submitted_at, source, imported_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'edinet', unixepoch())
    `,
    args: [
      input.ticker,
      input.documentId,
      index + 1,
      input.periodEnd,
      row.issuerName,
      row.shares,
      row.bookValue,
      row.purpose,
      row.quantitativeEffect,
      row.holdingType,
      input.publishedAt,
    ],
  }))
  await client.batch(statements)
}
