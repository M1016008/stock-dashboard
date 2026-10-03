import type {
  AccountingStandard,
  ConsolidationScope,
  FinancialPeriodKind,
  ForecastScope,
} from '@/lib/financial-foundation'

export const FINANCIAL_TIMELINE_METRICS = [
  'revenue',
  'operating_profit',
  'eps_basic',
] as const

export type FinancialTimelineMetric = typeof FINANCIAL_TIMELINE_METRICS[number]
export type FinancialTimelineMode = 'FY' | 'YTD' | 'STANDALONE' | 'LTM'
export type FinancialTimelinePointType = 'actual' | 'current_forecast' | 'next_forecast'

export interface FinancialTimelineRevision {
  previousValue: number
  previousPublishedAt: string
  ratePercent: number | null
}

export interface FinancialTimelineValue {
  value: number
  unit: string
  publishedAt: string
  source: 'jquants' | 'calculated'
  inputIds: string[]
  definitionVersion: string | null
  yoyPercent: number | null
  revision: FinancialTimelineRevision | null
}

export interface FinancialTimelinePeriod {
  key: string
  label: string
  periodEnd: string
  targetFiscalYear: number | null
  periodKind: FinancialPeriodKind
  pointType: FinancialTimelinePointType
  forecastScope: ForecastScope | null
  publishedAt: string
  consolidationScope: ConsolidationScope
  accountingStandard: AccountingStandard
  metrics: Record<FinancialTimelineMetric, FinancialTimelineValue | null>
}

export interface FinancialTimelineModeSeries {
  mode: FinancialTimelineMode
  label: string
  consolidationScope: ConsolidationScope | null
  periods: FinancialTimelinePeriod[]
  note: string | null
}

export interface FinancialPerformanceTimelineReadModel {
  contractVersion: 'financial-performance-timeline-v1'
  ticker: string
  asOf: string
  modes: Record<FinancialTimelineMode, FinancialTimelineModeSeries>
  coverage: {
    facts: number
    forecastSnapshots: number
    actualPeriods: number
    forecastPeriods: number
  }
}

export const FINANCIAL_TIMELINE_MODE_LABELS: Record<FinancialTimelineMode, string> = {
  FY: 'FY',
  YTD: '四半期累積',
  STANDALONE: '四半期単独',
  LTM: 'LTM',
}
