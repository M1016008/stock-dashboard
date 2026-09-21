export type InvestorClass = 'INDIVIDUAL' | 'INSTITUTIONAL' | 'OTHER' | 'UNCLASSIFIED'
export type HoldingBasis = 'OWNERSHIP' | 'INVESTMENT_AUTHORITY' | 'VOTING_AUTHORITY' | 'OTHER'
export type Completeness = 'COMPLETE' | 'PARTIAL' | 'NONE'

export type RankedPosition = {
  positionKey: string
  documentId: string
  investorEntityId: string
  ticker: string
  issuerName: string | null
  reportedShares: number | null
  reportedHoldingPct: number | null
  certifiedUnits: number | null
  estimatedCurrentValue: number | null
  holdingBasis: HoldingBasis
  filingDate: string
  obligationDate: string | null
  holdingInformationDate: string
  priceDate: string | null
  valuationStatus: 'PUBLIC_CURRENT_VALUATION_READY' | 'UNVALUED'
  market: string | null
  industry17: string | null
  industry33: string | null
  source: { authority: 'EDINET'; documentId: string; sourceSha256: string | null }
}

export type InvestorSummary = {
  investorEntityId: string
  displayName: string
  investorClass: InvestorClass
  investorType: string
  aliases: string[]
  positions: RankedPosition[]
  estimatedCurrentValue: number | null
  ownershipEstimatedValue: number | null
  investmentAuthorityEstimatedValue: number | null
  votingAuthorityEstimatedValue: number | null
  otherEstimatedValue: number | null
  valuedPositionCount: number
  totalRelevantPositionCount: number
  unvaluedPositionCount: number
  portfolioCompleteness: Completeness
  largestPositionTicker: string | null
  largestPositionValue: number | null
  largestHoldingPct: number | null
  latestFilingDate: string | null
}

export type HolderActivity = {
  eventType: 'NEW_5PCT' | 'INCREASE' | 'DECREASE' | 'EXIT_5PCT'
  investorEntityId: string
  investorClass: InvestorClass
  ticker: string
  issuerName: string | null
  documentId: string
  filingDate: string
  obligationDate: string
  reportedHoldingPct: number | null
  previousHoldingPct: number | null
  reportedShares: number | null
  sharesDelta: number | null
  holdingPctDelta: number | null
  currentValueEquivalent: number | null
  holdingBasis: HoldingBasis
  priceDate: string | null
}

export function classifyEffectiveTransition(input: {
  rootFilingType: string
  previousShares: number | null
  previousWasObserved: boolean
  currentShares: number | null
  previousHoldingPct: number | null
  currentHoldingPct: number | null
  afterOfficiallyVerified: boolean
  beforeOfficiallyVerified: boolean
  sameCertifiedInstrument: boolean
}): { eventType: HolderActivity['eventType']; sharesDelta: number | null } | null {
  if (!input.afterOfficiallyVerified || !input.sameCertifiedInstrument
    || input.currentShares == null) return null
  if (input.rootFilingType === 'INITIAL' && !input.previousWasObserved
    && input.currentHoldingPct != null && input.currentHoldingPct >= 5)
    return { eventType: 'NEW_5PCT', sharesDelta: null }
  if (input.rootFilingType !== 'CHANGE' || !input.beforeOfficiallyVerified
    || input.previousShares == null) return null
  const sharesDelta = input.currentShares - input.previousShares
  if (input.currentHoldingPct != null && input.currentHoldingPct < 5
    && input.previousHoldingPct != null && input.previousHoldingPct >= 5)
    return { eventType: 'EXIT_5PCT', sharesDelta }
  if (sharesDelta > 0) return { eventType: 'INCREASE', sharesDelta }
  if (sharesDelta < 0) return { eventType: 'DECREASE', sharesDelta }
  return null
}

export type RankingSnapshot = {
  version: 1
  certificationAsOf: string
  certificationDate: string
  manifestSha256: string
  activityEvidenceManifestSha256: string | null
  effectiveFilingArchiveComplete: boolean
  latestEdinetDataAt: string | null
  latestPositionDate: string | null
  priceDate: string
  filingWatermark: { count: number; maxImportedAt: number | null; maxSubmittedAt: string | null }
  positionFingerprintSha256: string
  publicCurrentValuationReadyCount: number
  currentPositionCount: number
  investors: InvestorSummary[]
  activities: HolderActivity[]
  filings: { documentId: string; filingType: string; filingDate: string;
    obligationDate: string | null; issuerName: string | null; ticker: string | null;
    sourceUrl: string; sourceSha256: string | null; sourceVerified: boolean; rootFilingId: string;
    isCorrection: boolean; investorEntityIds: string[] }[]
}

export const POSITION_FINGERPRINT_SQL = `SELECT document_id,holder_key,ticker,entity_id,
  reported_shares,reported_holding_pct,market_price_eligible_units,
  security_breakdown_json,market_price_status FROM large_holder_positions
  ORDER BY document_id,holder_key`

export function summarizeInvestor(input: Pick<InvestorSummary,
  'investorEntityId' | 'displayName' | 'investorClass' | 'investorType' | 'aliases' | 'positions'>): InvestorSummary {
  const valued = input.positions.filter((position) => position.estimatedCurrentValue !== null)
  const sum = (basis?: HoldingBasis): number | null => {
    const selected = valued.filter((position) => !basis || position.holdingBasis === basis)
    return selected.length ? selected.reduce((total, position) => total + position.estimatedCurrentValue!, 0) : null
  }
  const biggest = valued.toSorted((a, b) => b.estimatedCurrentValue! - a.estimatedCurrentValue!)[0]
  const total = input.positions.length
  return { ...input,
    estimatedCurrentValue: sum(),
    ownershipEstimatedValue: sum('OWNERSHIP'),
    investmentAuthorityEstimatedValue: sum('INVESTMENT_AUTHORITY'),
    votingAuthorityEstimatedValue: sum('VOTING_AUTHORITY'),
    otherEstimatedValue: sum('OTHER'),
    valuedPositionCount: valued.length,
    totalRelevantPositionCount: total,
    unvaluedPositionCount: total - valued.length,
    portfolioCompleteness: valued.length === 0 ? 'NONE' : valued.length === total ? 'COMPLETE' : 'PARTIAL',
    largestPositionTicker: biggest?.ticker ?? null,
    largestPositionValue: biggest?.estimatedCurrentValue ?? null,
    largestHoldingPct: input.positions.reduce<number | null>((max, position) =>
      position.reportedHoldingPct == null ? max : Math.max(max ?? -Infinity, position.reportedHoldingPct), null),
    latestFilingDate: input.positions.reduce<string | null>((max, position) =>
      !max || position.filingDate > max ? position.filingDate : max, null),
  }
}

export const LARGE_HOLDER_DISCLAIMER = {
  valuationLabel: '推定時価保有額',
  valuationBasisDescription: '認定済み株数・投資口数を新鮮な未調整終値で現在時価換算。取得原価ではありません。',
  disclosureBasis: '直近開示ベース',
  coverageWarning: '大量保有報告で観測可能なPositionのみ。5%未満など未観測の保有は含みません。',
  partialWarning: 'PARTIALは算定可能なPositionだけの合計であり、完全なポートフォリオ総額ではありません。',
  institutionalBasisWarning: '所有等ベースと運用権限ベースは法的性質が異なります。合計値を自己保有額・投資額と解釈しないでください。',
} as const
