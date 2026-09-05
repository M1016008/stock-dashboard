export type SimilarityCandidateKind = 'sector33' | 'custom' | 'financial' | 'structure'

export type ComparisonAvailability = 'available' | 'missing' | 'not_applicable' | 'not_meaningful'

export type ComparisonMetricKey =
  | 'revenue'
  | 'revenueGrowth'
  | 'epsGrowth'
  | 'operatingMargin'
  | 'roe'
  | 'roa'
  | 'standardFcf'
  | 'forwardPer'
  | 'pbr'
  | 'fcfYield'
  | 'evEbitda'
  | 'dividendYield'
  | 'payoutRatio'
  | 'dpsCagr5y'
  | 'pms'
  | 'pfs'
  | 'sectorStructureScore'

export interface ComparisonValue {
  value: number | null
  unit: string | null
  availability: ComparisonAvailability
  reason: string | null
  source: string
  asOf: string | null
}

export interface SimilarityCandidate {
  ticker: string
  name: string | null
  sector33: string | null
  custom60: string | null
  subIndustry: string | null
  score: number | null
  coveragePercent: number | null
  reason: string
  stageCode: string | null
}

export interface SimilarityCandidateGroup {
  kind: SimilarityCandidateKind
  label: string
  description: string
  asOf: string | null
  candidates: SimilarityCandidate[]
}

export interface ComparisonCompany {
  ticker: string
  name: string | null
  marketSegment: string | null
  sector33: string | null
  custom60: string | null
  subIndustry: string | null
  isBase: boolean
  stageCode: string | null
  stages: {
    dailyA: number | null
    dailyB: number | null
    weeklyA: number | null
    weeklyB: number | null
    monthlyA: number | null
    monthlyB: number | null
  }
  metrics: Record<ComparisonMetricKey, ComparisonValue>
}

export interface ComparisonDistribution {
  metric: ComparisonMetricKey
  validCount: number
  peerCount: number
  percentile25: number | null
  median: number | null
  percentile75: number | null
}

export interface SimilarityComparisonReadModel {
  contractVersion: 'similarity-comparison-v1'
  ticker: string
  asOf: string
  valuationDate: string | null
  structureDate: string | null
  classification: {
    name: string | null
    sector33: string | null
    custom60: string | null
    subIndustry: string | null
  }
  candidateGroups: SimilarityCandidateGroup[]
  recommendations: string[]
  selectedTickers: string[]
  companies: ComparisonCompany[]
  sectorDistribution: {
    label: string
    groupName: string | null
    metrics: Partial<Record<ComparisonMetricKey, ComparisonDistribution>>
  }
  coverage: {
    activeUniverse: number
    financialFeatureUniverse: number
    sectorPeers: number
    selectedCompanies: number
  }
}
