import { execAll, execGet } from '@/lib/db/client'
import { normalizeAsOf } from '@/lib/financial-foundation'
import type {
  CompanyOverviewFact,
  EmployeeInformationFact,
  OfficerInformationFact,
  SegmentInformationFact,
} from '@/lib/edinet-xbrl'
import {
  COMPANY_INFORMATION_CONTRACT_VERSION,
  type CompanyInformationReadModel,
  type EmployeeHistoryRow,
  type PolicyHoldingSummary,
} from '@/lib/company-information'

type SnapshotRow = {
  document_id: string
  ticker: string
  edinet_code: string | null
  document_type: string
  filer_name: string | null
  published_at: string
  period_start: string | null
  period_end: string | null
  fiscal_year: number | null
  accounting_standard: string
  correction_status: string
  company_overview_json: string
  employee_information_json: string
  officer_information_json: string
  segment_information_json: string
  parser_version: string
  employee_snapshot_count: number
  officer_count: number
  segment_count: number
  major_shareholder_count: number
  policy_holding_count: number
}

type IdentityRow = {
  name: string | null
  market_segment: string | null
  sector17_name: string | null
  sector33_name: string | null
  major_category: string | null
  sub_industry: string | null
}

type FactRow = {
  fact_id: string
  metric: string
  value: number
  period_end: string
}

const CACHE_TTL_MS = 5 * 60 * 1000
const cache = new Map<string, { expiresAt: number; value: CompanyInformationReadModel }>()

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function emptyOverview(): CompanyOverviewFact {
  return {
    businessDescription: null,
    companyHistory: null,
    businessPolicy: null,
    basicDescriptionTextBlocks: [],
  }
}

function emptyEmployees(): EmployeeInformationFact {
  return { consolidated: null, nonConsolidated: null }
}

function emptyOfficers(): OfficerInformationFact {
  return { officers: [], outsideOfficerNarrative: null }
}

function emptySegments(): SegmentInformationFact {
  return {
    periodEnd: null,
    accountingFramework: 'unknown',
    segments: [],
    geographicAreas: [],
    geographicRevenueTotal: null,
    majorCustomers: [],
    segmentNarrative: null,
    geographicNarrative: null,
  }
}

function dateOnly(value: string | null | undefined): string | null {
  return value?.slice(0, 10) || null
}

async function resolveAsOf(requestedAsOf?: string | null): Promise<string> {
  if (requestedAsOf) return requestedAsOf.slice(0, 10)
  const row = await execGet<{ latest_date: string | null }>(`SELECT MAX(date) AS latest_date FROM ohlcv_daily`)
  return row?.latest_date ?? new Date().toISOString().slice(0, 10)
}

async function buildPolicySummary(
  ticker: string,
  asOf: string,
  periodEnd: string | null,
  bookValues: Array<number | null>,
): Promise<PolicyHoldingSummary> {
  const numericBookValues = bookValues.filter((value): value is number => value != null && Number.isFinite(value))
  const bookValueTotal = numericBookValues.length > 0
    ? numericBookValues.reduce((sum, value) => sum + value, 0)
    : null
  if (bookValueTotal == null) {
    return {
      count: bookValues.length,
      bookValueTotal: null,
      equityRatio: null,
      marketCapRatio: null,
      equityInputFactId: null,
      marketCapInputIds: [],
      reason: '政策保有株式の貸借対照表計上額が揃っていないため比率を算定していません。',
    }
  }
  const cutoff = normalizeAsOf(asOf)
  const facts = await execAll<FactRow>(`
    SELECT fact_id, metric, value, period_end
    FROM normalized_financial_facts
    WHERE ticker = ?
      AND published_at <= ?
      AND metric IN ('equity_attributable', 'shareholders_equity', 'shares_outstanding', 'treasury_shares')
      ${periodEnd ? 'AND period_end <= ?' : ''}
    ORDER BY period_end DESC, published_at DESC,
      CASE metric
        WHEN 'equity_attributable' THEN 0
        WHEN 'shareholders_equity' THEN 1
        WHEN 'shares_outstanding' THEN 2
        ELSE 3
      END
  `, periodEnd ? [ticker, cutoff, periodEnd] : [ticker, cutoff])
  const equity = facts.find((fact) => fact.metric === 'equity_attributable')
    ?? facts.find((fact) => fact.metric === 'shareholders_equity')
  const issued = facts.find((fact) => fact.metric === 'shares_outstanding')
  const treasury = issued
    ? facts.find((fact) => fact.metric === 'treasury_shares' && fact.period_end === issued.period_end)
    : undefined
  const price = await execGet<{ date: string; close: number }>(`
    SELECT date, close FROM ohlcv_daily
    WHERE ticker = ? AND date <= ? AND close IS NOT NULL
    ORDER BY date DESC LIMIT 1
  `, [ticker, asOf])
  const netShares = issued && treasury ? issued.value - treasury.value : null
  const marketCap = price && netShares != null && netShares > 0 ? price.close * netShares : null
  const equityRatio = equity && equity.value > 0 ? (bookValueTotal / equity.value) * 100 : null
  const marketCapRatio = marketCap && marketCap > 0 ? (bookValueTotal / marketCap) * 100 : null
  const missing: string[] = []
  if (!equity) missing.push('自己資本')
  if (!issued || !treasury) missing.push('自己株控除後株式数')
  if (!price) missing.push('基準日株価')
  return {
    count: bookValues.length,
    bookValueTotal,
    equityRatio,
    marketCapRatio,
    equityInputFactId: equity?.fact_id ?? null,
    marketCapInputIds: marketCap != null
      ? [issued!.fact_id, treasury!.fact_id, `price:JP:${ticker}:${price!.date}`]
      : [],
    reason: missing.length > 0 ? `${missing.join('・')}がない比率は算定していません。` : null,
  }
}

function employeeHistory(snapshots: SnapshotRow[]): EmployeeHistoryRow[] {
  const latestByPeriod = new Map<string, SnapshotRow>()
  for (const snapshot of snapshots) {
    const period = snapshot.period_end ?? ''
    const previous = latestByPeriod.get(period)
    if (!previous || snapshot.published_at > previous.published_at) latestByPeriod.set(period, snapshot)
  }
  return [...latestByPeriod.values()]
    .filter((snapshot) => snapshot.period_end != null && snapshot.employee_snapshot_count > 0)
    .sort((left, right) => (left.period_end ?? '').localeCompare(right.period_end ?? ''))
    .map((snapshot) => {
      const value = parseJson(snapshot.employee_information_json, emptyEmployees())
      return {
        documentId: snapshot.document_id,
        publishedAt: snapshot.published_at,
        periodEnd: snapshot.period_end!,
        consolidated: value.consolidated,
        nonConsolidated: value.nonConsolidated,
      }
    })
}

export async function getCompanyInformationReadModel(
  tickerInput: string,
  requestedAsOf?: string | null,
): Promise<CompanyInformationReadModel | null> {
  const ticker = tickerInput.replace(/\.T$/i, '').toUpperCase()
  const asOf = await resolveAsOf(requestedAsOf)
  const cacheKey = `${ticker}:${asOf}`
  const cached = cache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.value
  const cutoff = normalizeAsOf(asOf)
  const snapshots = await execAll<SnapshotRow>(`
    SELECT * FROM edinet_company_snapshots
    WHERE ticker = ? AND published_at <= ?
    ORDER BY period_end ASC, published_at ASC, document_id ASC
  `, [ticker, cutoff])
  if (snapshots.length === 0) return null
  const latest = [...snapshots].sort((left, right) => (
    (right.period_end ?? '').localeCompare(left.period_end ?? '')
    || right.published_at.localeCompare(left.published_at)
    || right.document_id.localeCompare(left.document_id)
  ))[0]
  const identity = await execGet<IdentityRow>(`
    SELECT
      u.name, u.market_segment, u.sector17_name, u.sector33_name,
      c.major_category, c.sub_industry
    FROM ticker_universe u
    LEFT JOIN stock_classification c ON c.ticker = u.ticker
    WHERE u.ticker = ? LIMIT 1
  `, [ticker])
  const major = await execAll<{
    rank: number
    holder_name: string
    shares: number | null
    holding_ratio: number | null
  }>(`
    SELECT rank, holder_name, shares, holding_ratio
    FROM major_shareholders
    WHERE ticker = ? AND document_id = ?
    ORDER BY rank
  `, [ticker, latest.document_id])
  const policy = await execAll<{
    rank: number
    issuer_name: string
    shares: number | null
    book_value: number | null
    purpose: string | null
    quantitative_effect: string | null
    holding_type: string | null
  }>(`
    SELECT rank, issuer_name, shares, book_value, purpose, quantitative_effect, holding_type
    FROM policy_holdings
    WHERE ticker = ? AND document_id = ?
    ORDER BY rank
  `, [ticker, latest.document_id])
  const largeReports = await execAll<{
    document_id: string
    submitted_at: string | null
    report_date: string | null
    holder_name: string | null
    shares: number | null
    holding_ratio: number | null
    previous_holding_ratio: number | null
    purpose: string | null
    report_kind: string | null
  }>(`
    SELECT document_id, submitted_at, report_date, holder_name, shares,
      holding_ratio, previous_holding_ratio, purpose, report_kind
    FROM large_holding_reports
    WHERE ticker = ? AND submitted_at IS NOT NULL AND submitted_at <= ?
    ORDER BY submitted_at DESC LIMIT 30
  `, [ticker, cutoff])
  const policySummary = await buildPolicySummary(
    ticker,
    asOf,
    latest.period_end,
    policy.map((row) => row.book_value),
  )
  const overview = parseJson(latest.company_overview_json, emptyOverview())
  const latestEmployees = parseJson(latest.employee_information_json, emptyEmployees())
  const officers = parseJson(latest.officer_information_json, emptyOfficers())
  const segmentInformation = parseJson(latest.segment_information_json, emptySegments())
  const availablePeriods = [...new Map(snapshots
    .filter((snapshot) => snapshot.segment_count > 0 && snapshot.period_end != null)
    .map((snapshot) => [snapshot.period_end!, snapshot])).values()]
    .map((snapshot) => ({
      documentId: snapshot.document_id,
      periodEnd: snapshot.period_end!,
      publishedAt: snapshot.published_at,
    }))

  const value: CompanyInformationReadModel = {
    contractVersion: COMPANY_INFORMATION_CONTRACT_VERSION,
    ticker,
    asOf,
    identity: {
      ticker,
      companyName: identity?.name ?? latest.filer_name,
      edinetCode: latest.edinet_code,
      marketSegment: identity?.market_segment ?? null,
      sector17: identity?.sector17_name ?? null,
      sector33: identity?.sector33_name ?? null,
      custom60: identity?.major_category ?? null,
      subIndustry: identity?.sub_industry ?? null,
      accountingStandard: latest.accounting_standard,
      fiscalYearEnd: dateOnly(latest.period_end)?.slice(5) ?? null,
    },
    snapshot: {
      documentId: latest.document_id,
      documentType: latest.document_type,
      filerName: latest.filer_name,
      publishedAt: latest.published_at,
      periodStart: latest.period_start,
      periodEnd: latest.period_end,
      fiscalYear: latest.fiscal_year,
      correctionStatus: latest.correction_status,
      parserVersion: latest.parser_version,
    },
    overview,
    segmentInformation,
    segmentTimeline: {
      connectedSeriesAvailable: false,
      availablePeriods,
      reason: availablePeriods.length > 1
        ? '過去有報は保存済みですが、名称変更・組織再編を自動同一視しないためセグメント系列は接続していません。'
        : '比較可能な過去有報が不足しているため、最新年度だけを表示します。',
    },
    employees: {
      latest: latestEmployees,
      history: employeeHistory(snapshots),
    },
    officers,
    shareholders: {
      major: major.map((row) => ({
        rank: row.rank,
        holderName: row.holder_name,
        shares: row.shares,
        holdingRatio: row.holding_ratio,
      })),
      policy: policy.map((row) => ({
        rank: row.rank,
        issuerName: row.issuer_name,
        shares: row.shares,
        bookValue: row.book_value,
        purpose: row.purpose,
        quantitativeEffect: row.quantitative_effect,
        holdingType: row.holding_type,
      })),
      largeReports: largeReports.map((row) => ({
        documentId: row.document_id,
        submittedAt: row.submitted_at,
        reportDate: row.report_date,
        holderName: row.holder_name,
        shares: row.shares,
        holdingRatio: row.holding_ratio,
        previousHoldingRatio: row.previous_holding_ratio,
        purpose: row.purpose,
        reportKind: row.report_kind,
      })),
      policySummary,
    },
    coverage: {
      snapshots: snapshots.length,
      hasBusinessDescription: overview.businessDescription != null,
      hasBusinessPolicy: overview.businessPolicy != null,
      hasCompanyHistory: overview.companyHistory != null,
      segmentCount: segmentInformation.segments.length,
      employeeSnapshotCount: Number(latestEmployees.consolidated != null) + Number(latestEmployees.nonConsolidated != null),
      officerCount: officers.officers.length,
      majorShareholderCount: major.length,
      policyHoldingCount: policy.length,
    },
    sourcePolicy: {
      edinet: '法定開示に基づく企業情報。有報のdocument IDと公表日時を保持します。',
      shikiho: '四季報の特色・記事は外部編集情報として別管理し、EDINET本文で上書きしません。',
    },
  }
  cache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, value })
  return value
}
