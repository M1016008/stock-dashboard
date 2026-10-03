import type { ScreeningCondition, ScreeningMetricKey } from '@/lib/integrated-screener'

export type ScreenerReasonKind = 'condition_match' | 'supporting_fact' | 'caution'
export type ScreenerReasonValueStatus = 'available' | 'missing' | 'not_applicable' | 'not_meaningful'
export type ScreenerReasonComparisonBasis =
  | 'condition'
  | 'sector33_median'
  | 'major_category_median'
  | 'self_5y_percentile'
  | 'sector_rank'
  | 'neutral_point'
  | 'zero'
  | 'forecast_revision'

export interface ScreenerReasonActualValue {
  metric: ScreeningMetricKey | 'actual_eps' | 'forecast_eps' | 'net_debt_to_market_cap'
  label: string
  value: number | string | boolean | null
  formatted: string
  status: ScreenerReasonValueStatus
  unit?: string
}

export interface ScreenerReasonConditionEvidence {
  operator: ScreeningCondition['operator']
  value?: ScreeningCondition['value']
  valueTo?: number
  expression: string
  margin: number | null
  marginFormatted: string | null
}

export interface ScreenerReasonComparison {
  basis: ScreenerReasonComparisonBasis
  label: string
  value: number | null
  formatted: string | null
  delta: number | null
  deltaFormatted: string | null
  percentile: number | null
  sampleSize: number | null
}

export interface ScreenerReasonSource {
  source: 'stock_screening_serving' | 'normalized_financial_facts' | 'financial_forecast_snapshots'
  sourceMetric: string
  asOf: string
  sourceDate: string | null
  sourceId: string | null
}

export interface ScreenerReasonItem {
  id: string
  kind: ScreenerReasonKind
  metric: ScreenerReasonActualValue['metric']
  message: string
  actual: ScreenerReasonActualValue
  condition: ScreenerReasonConditionEvidence | null
  comparison: ScreenerReasonComparison | null
  source: ScreenerReasonSource
}

export interface ScreenerReasonContract {
  contractVersion: 'screener-reason-v1'
  ticker: string
  name: string
  asOf: string
  snapshotDate: string
  valuationDate: string | null
  classifications: {
    sector33: string | null
    majorCategory: string | null
    subIndustry: string | null
  }
  matchedConditions: ScreenerReasonItem[]
  supportingFacts: ScreenerReasonItem[]
  cautions: ScreenerReasonItem[]
  generatedAt: string
  elapsedMs: number
  cacheHit: boolean
  disclaimer: string
}

export interface ScreenerReasonRequest {
  ticker: string
  asOf?: string | null
  conditions: ScreeningCondition[]
}
