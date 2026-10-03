import type {
  CompanyOverviewFact,
  EmployeeInformationFact,
  OfficerInformationFact,
  SegmentInformationFact,
} from '@/lib/edinet-xbrl'

export const COMPANY_INFORMATION_CONTRACT_VERSION = 'company-information-v1' as const
export const EDINET_COMPANY_PARSER_VERSION = 'edinet-company-parser-v1' as const

export interface CompanyInformationIdentity {
  ticker: string
  companyName: string | null
  edinetCode: string | null
  marketSegment: string | null
  sector17: string | null
  sector33: string | null
  custom60: string | null
  subIndustry: string | null
  accountingStandard: string
  fiscalYearEnd: string | null
}
export interface CompanyInformationSnapshotMeta {
  documentId: string
  documentType: string
  filerName: string | null
  publishedAt: string
  periodStart: string | null
  periodEnd: string | null
  fiscalYear: number | null
  correctionStatus: string
  parserVersion: string
}

export interface EmployeeHistoryRow {
  documentId: string
  publishedAt: string
  periodEnd: string
  consolidated: EmployeeInformationFact['consolidated']
  nonConsolidated: EmployeeInformationFact['nonConsolidated']
}

export interface MajorShareholderRow {
  rank: number
  holderName: string
  shares: number | null
  holdingRatio: number | null
}

export interface PolicyHoldingRow {
  rank: number
  issuerName: string
  shares: number | null
  bookValue: number | null
  purpose: string | null
  quantitativeEffect: string | null
  holdingType: string | null
}

export interface LargeHoldingReportRow {
  documentId: string
  submittedAt: string | null
  reportDate: string | null
  holderName: string | null
  shares: number | null
  holdingRatio: number | null
  previousHoldingRatio: number | null
  purpose: string | null
  reportKind: string | null
}

export interface PolicyHoldingSummary {
  count: number
  bookValueTotal: number | null
  equityRatio: number | null
  marketCapRatio: number | null
  equityInputFactId: string | null
  marketCapInputIds: string[]
  reason: string | null
}

export interface CompanyInformationReadModel {
  contractVersion: typeof COMPANY_INFORMATION_CONTRACT_VERSION
  ticker: string
  asOf: string
  identity: CompanyInformationIdentity
  snapshot: CompanyInformationSnapshotMeta
  overview: CompanyOverviewFact
  segmentInformation: SegmentInformationFact
  segmentTimeline: {
    connectedSeriesAvailable: false
    availablePeriods: Array<{ documentId: string; periodEnd: string; publishedAt: string }>
    reason: string
  }
  employees: {
    latest: EmployeeInformationFact
    history: EmployeeHistoryRow[]
  }
  officers: OfficerInformationFact
  shareholders: {
    major: MajorShareholderRow[]
    policy: PolicyHoldingRow[]
    largeReports: LargeHoldingReportRow[]
    policySummary: PolicyHoldingSummary
  }
  coverage: {
    snapshots: number
    hasBusinessDescription: boolean
    hasBusinessPolicy: boolean
    hasCompanyHistory: boolean
    segmentCount: number
    employeeSnapshotCount: number
    officerCount: number
    majorShareholderCount: number
    policyHoldingCount: number
  }
  sourcePolicy: {
    edinet: string
    shikiho: string
  }
}
