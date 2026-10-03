import type { AccountingStandard, ConsolidationScope, ForecastScope } from '@/lib/financial-foundation'
import type {
  FinancialTimelineMode,
  FinancialTimelinePointType,
  FinancialTimelineValue,
} from '@/lib/financial-performance-timeline'

export const FINANCIAL_PERFORMANCE_DETAIL_METRICS = [
  'revenue',
  'operating_profit',
  'net_income_attributable',
  'eps_basic',
] as const

export type FinancialPerformanceDetailMetric = typeof FINANCIAL_PERFORMANCE_DETAIL_METRICS[number]
export type FinancialPerformanceAvailability = 'available' | 'missing' | 'not_applicable' | 'not_meaningful'

export interface FinancialPerformanceSummaryValue {
  value: number | null
  unit: string | null
  availability: FinancialPerformanceAvailability
  reason: string | null
  periodLabel: string | null
  inputIds: string[]
}

export interface FinancialPerformanceDetailPeriod {
  key: string
  label: string
  periodEnd: string
  targetFiscalYear: number | null
  periodKind: string
  pointType: FinancialTimelinePointType
  forecastScope: ForecastScope | null
  publishedAt: string
  consolidationScope: ConsolidationScope | null
  accountingStandard: AccountingStandard
  metrics: Record<FinancialPerformanceDetailMetric, FinancialTimelineValue | null>
  profitability: {
    grossMargin: FinancialPerformanceSummaryValue
    operatingMargin: FinancialPerformanceSummaryValue
    netMargin: FinancialPerformanceSummaryValue
    roe: FinancialPerformanceSummaryValue
    roa: FinancialPerformanceSummaryValue
  }
}

export interface FinancialPerformanceDetailModeSeries {
  mode: FinancialTimelineMode
  label: string
  note: string | null
  periods: FinancialPerformanceDetailPeriod[]
}

export interface FinancialForecastRevisionMetric {
  value: number
  unit: string
  previousValue: number | null
  previousPublishedAt: string | null
  revisionPercent: number | null
}

export type FinancialForecastRevisionDirection = 'initial' | 'up' | 'down' | 'unchanged' | 'mixed'

export interface FinancialForecastRevisionRow {
  key: string
  publishedAt: string
  targetFiscalYear: number
  forecastScope: ForecastScope
  consolidationScope: ConsolidationScope
  accountingStandard: AccountingStandard
  disclosureId: string
  direction: FinancialForecastRevisionDirection
  metrics: Record<FinancialPerformanceDetailMetric, FinancialForecastRevisionMetric | null>
}

export interface FinancialPerformanceDetailReadModel {
  contractVersion: 'financial-performance-detail-v1'
  ticker: string
  asOf: string
  isFinancialSector: boolean
  summary: {
    scale: {
      revenue: FinancialPerformanceSummaryValue
      operatingProfit: FinancialPerformanceSummaryValue
      netIncome: FinancialPerformanceSummaryValue
      eps: FinancialPerformanceSummaryValue
    }
    profitability: {
      operatingMargin: FinancialPerformanceSummaryValue
      roe: FinancialPerformanceSummaryValue
      roa: FinancialPerformanceSummaryValue
    }
    growth: {
      revenueCagr3y: FinancialPerformanceSummaryValue
      revenueCagr5y: FinancialPerformanceSummaryValue
      epsCagr3y: FinancialPerformanceSummaryValue
      epsCagr5y: FinancialPerformanceSummaryValue
    }
  }
  modes: Record<FinancialTimelineMode, FinancialPerformanceDetailModeSeries>
  forecastHistory: FinancialForecastRevisionRow[]
  coverage: {
    facts: number
    forecastSnapshots: number
    forecastHistoryRows: number
  }
}
