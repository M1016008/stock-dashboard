import type { HolderActivity, InvestorClass, InvestorSummary, RankedPosition } from './ranking-core'

export type RankingType = 'TOTAL_VALUE' | 'RECENT_INCREASE' | 'NEW_5PCT' | 'DECREASE'
export type ClassFilter = 'ALL' | InvestorClass
export type BasisFilter = 'OWNERSHIP' | 'INVESTMENT_AUTHORITY'
export type PeriodFilter = '7D' | '30D' | '90D' | '1Y'
export type CompletenessFilter = 'ALL' | 'COMPLETE' | 'PARTIAL' | 'NONE'
export type RankingRow = Omit<InvestorSummary, 'positions'> & {
  rankingValue?: number | null
  rankingBasis?: BasisFilter
  rankingLargestPositionTicker?: string | null
  rankingLargestPositionValue?: number | null
  latestActivityType?: HolderActivity['eventType'] | null
  latestActivityDate?: string | null
  selectedPositionCount?: number
  selectedValuedPositionCount?: number
  selectedPortfolioCompleteness?: InvestorSummary['portfolioCompleteness']
  activityCount?: number
  tickerCount?: number
  currentValueEquivalent?: number | null
  events?: HolderActivity[]
  investorName?: string
  eventType?: HolderActivity['eventType']
  ticker?: string
  issuerName?: string | null
  reportedHoldingPct?: number | null
  reportedShares?: number | null
  filingDate?: string
  documentId?: string
  holdingBasis?: string
}
export type ActivityRow = HolderActivity & {
  investorName: string
  investorType: string
  market: string | null
  industry17: string | null
  industry33: string | null
  filingSourceUrl: string | null
  sourceVerified: boolean
  fellowNames: string[]
}
export type ResponseMeta = {
  certificationAsOf: string
  snapshotStatus?: 'VALIDATED' | 'VALIDATED_WITH_QUARANTINE'
  quarantinedDocumentCount?: number
  quarantinedPositionScopeCount?: number
  affectedIssuerCount?: number
  affectedInvestorCount?: number
  quarantineReasons?: Record<string, number>
  quarantines?: { documentId: string; ticker: string; issuerName: string | null;
    reasonCode: string; sourceSha256: string; affectedHolderCount: number;
    knownPriorInvestorEntityIds?: string[] }[]
  snapshotId?: string | null
  snapshotGeneratedAt?: string | null
  latestEdinetDataAt: string | null
  latestPositionDate: string | null
  priceDate: string
  publicCurrentValuationReadyCount: number
  currentPositionCount: number
  coverageWarning: string
  partialWarning: string
  institutionalBasisWarning: string
}
export type PagedResponse<T> = ResponseMeta & {
  rows: T[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}
export type OverviewResponse = ResponseMeta & {
  investorCount: number
  investorClassCounts: Record<string, number>
  completenessCounts: Record<string, number>
  activityCounts: Record<string, number>
  markets: string[]
  industries17: string[]
  industries33: string[]
}
export type InvestorDetailResponse = ResponseMeta & {
  identity: Pick<InvestorSummary, 'investorEntityId' | 'displayName' | 'aliases' | 'investorClass' | 'investorType'>
  portfolioSummary: Pick<InvestorSummary, 'estimatedCurrentValue' | 'ownershipEstimatedValue' |
    'investmentAuthorityEstimatedValue' | 'votingAuthorityEstimatedValue' | 'valuedPositionCount' |
    'totalRelevantPositionCount' | 'unvaluedPositionCount' | 'portfolioCompleteness'> & {
    concentrationOfValuedPositions: number | null
  }
  positions: RankedPosition[]
  sectorAllocation: { sector: string; estimatedCurrentValue: number; valuedPositionCount: number }[]
  recentActivities: HolderActivity[]
  filingTimeline: { documentId: string; filingType: string; filingDate: string;
    obligationDate: string | null; ticker: string | null; issuerName: string | null;
    sourceUrl: string; sourceVerified: boolean; isCorrection: boolean }[]
  jointHolderEntityIds: string[]
  evidenceSummary: { publicReadyPositionCount: number; officialDocumentCount: number }
}

const number = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 1 })
const integer = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 0 })

export function yen(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const absolute = Math.abs(value)
  if (absolute >= 1e12) return `${number.format(value / 1e12)}兆円`
  if (absolute >= 1e8) return `${number.format(value / 1e8)}億円`
  if (absolute >= 1e4) return `${number.format(value / 1e4)}万円`
  return `${integer.format(value)}円`
}
export function exactYen(value: number | null | undefined) {
  return value == null ? '—' : `${integer.format(value)}円`
}
export function pct(value: number | null | undefined): string {
  return value == null ? '—' : `${number.format(value)}%`
}
export function date(value: string | null | undefined): string {
  return value ? value.replaceAll('-', '/') : '—'
}
export const CLASS_LABEL: Record<ClassFilter, string> = {
  ALL: 'すべて', INDIVIDUAL: '個人', INSTITUTIONAL: '機関',
  OTHER: 'その他', UNCLASSIFIED: '未分類',
}
export const TYPE_LABEL: Record<string, string> = {
  INDIVIDUAL: '個人', DOMESTIC_ASSET_MANAGER: '国内運用会社',
  FOREIGN_ASSET_MANAGER: '海外運用会社', FUND: 'ファンド',
  FINANCIAL_INSTITUTION: '金融機関', OPERATING_COMPANY: '事業会社',
  UNCLASSIFIED: '未分類',
}
export const RANKING_LABEL: Record<RankingType, string> = {
  TOTAL_VALUE: '推定時価保有総額', RECENT_INCREASE: '最近の買増',
  NEW_5PCT: '新規5%', DECREASE: '保有減少',
}
export const EVENT_LABEL: Record<HolderActivity['eventType'], string> = {
  NEW_5PCT: 'NEW', INCREASE: '↑ 買増', DECREASE: '↓ 減少', EXIT_5PCT: 'EXIT',
}
export function unitFor(position: Pick<RankedPosition, 'ticker' | 'issuerName'>): '株' | '口' {
  return position.issuerName?.includes('投資法人') ? '口' : '株'
}
export function positionUnits(value: number | null | undefined, position: Pick<RankedPosition, 'ticker' | 'issuerName'>) {
  return value == null ? '—' : `${integer.format(value)}${unitFor(position)}`
}
