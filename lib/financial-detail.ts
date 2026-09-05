import type {
  AccountingStandard,
  ConsolidationScope,
  FinancialPeriodKind,
} from '@/lib/financial-foundation'
import type { FinancialMetricKey, MetricDefinition } from '@/lib/financial-metrics'
import type { FinancialTimelineMode } from '@/lib/financial-performance-timeline'

export type FinancialDetailAvailability = 'available' | 'missing' | 'not_applicable' | 'not_meaningful'

export interface FinancialDetailValue {
  value: number | null
  unit: string | null
  availability: FinancialDetailAvailability
  reason: string | null
  periodLabel: string | null
  periodStart: string | null
  periodEnd: string | null
  publishedAt: string | null
  consolidationScope: ConsolidationScope | null
  accountingStandard: AccountingStandard
  definitionVersion: string | null
  inputIds: string[]
}

export interface FinancialDetailPeriodBase {
  key: string
  label: string
  periodEnd: string
  targetFiscalYear: number | null
  periodKind: FinancialPeriodKind
  publishedAt: string
  consolidationScope: ConsolidationScope
  accountingStandard: AccountingStandard
}

export interface FinancialDetailPlPeriod extends FinancialDetailPeriodBase {
  metrics: {
    revenue: FinancialDetailValue
    operatingProfit: FinancialDetailValue
    ordinaryProfit: FinancialDetailValue
    netIncome: FinancialDetailValue
    eps: FinancialDetailValue
  }
}

export interface FinancialDetailBalancePeriod extends FinancialDetailPeriodBase {
  metrics: {
    totalAssets: FinancialDetailValue
    equity: FinancialDetailValue
    equityRatio: FinancialDetailValue
    bps: FinancialDetailValue
  }
}

export interface FinancialDetailCashFlowPeriod extends FinancialDetailPeriodBase {
  accumulationKind: FinancialTimelineMode
  metrics: {
    operatingCashFlow: FinancialDetailValue
    investingCashFlow: FinancialDetailValue
    financingCashFlow: FinancialDetailValue
    simpleFcf: FinancialDetailValue
  }
}

export interface FinancialDetailMetricPeriod extends FinancialDetailPeriodBase {
  basis: 'FY' | 'LTM'
  metrics: {
    operatingMargin: FinancialDetailValue
    netMargin: FinancialDetailValue
    roe: FinancialDetailValue
    roa: FinancialDetailValue
    equityRatio: FinancialDetailValue
    eps: FinancialDetailValue
    bps: FinancialDetailValue
    simpleFcf: FinancialDetailValue
  }
}

export const FINANCIAL_DETAIL_DEFINITION_KEYS = [
  'operating_margin',
  'net_margin',
  'roe',
  'roa',
  'equity_ratio',
  'eps',
  'bps',
  'simple_fcf',
] as const satisfies readonly FinancialMetricKey[]

export type FinancialDetailDefinitionKey = typeof FINANCIAL_DETAIL_DEFINITION_KEYS[number]

export interface FinancialDetailReadModel {
  contractVersion: 'financial-detail-v1'
  ticker: string
  asOf: string
  isFinancialSector: boolean
  summary: {
    profitability: {
      operatingMargin: FinancialDetailValue
      netMargin: FinancialDetailValue
      roe: FinancialDetailValue
      roa: FinancialDetailValue
    }
    financialHealth: {
      equityRatio: FinancialDetailValue
      totalAssets: FinancialDetailValue
      equity: FinancialDetailValue
      bps: FinancialDetailValue
    }
    cashFlow: {
      operatingCashFlow: FinancialDetailValue
      investingCashFlow: FinancialDetailValue
      financingCashFlow: FinancialDetailValue
      simpleFcf: FinancialDetailValue
    }
    capitalEfficiency: {
      roe: FinancialDetailValue
      roa: FinancialDetailValue
      eps: FinancialDetailValue
      bps: FinancialDetailValue
    }
  }
  metricPeriods: {
    FY: FinancialDetailMetricPeriod[]
    LTM: FinancialDetailMetricPeriod[]
  }
  profitAndLoss: Record<FinancialTimelineMode, FinancialDetailPlPeriod[]>
  balanceSheet: {
    FY: FinancialDetailBalancePeriod[]
    QUARTER: FinancialDetailBalancePeriod[]
  }
  cashFlow: Record<FinancialTimelineMode, FinancialDetailCashFlowPeriod[]>
  definitions: Record<FinancialDetailDefinitionKey, MetricDefinition>
  coverage: {
    facts: number
    profitAndLossPeriods: number
    balanceSheetPeriods: number
    cashFlowPeriods: number
  }
}
