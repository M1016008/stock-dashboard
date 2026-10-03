import type {
  AccountingStandard,
  ConsolidationScope,
  ForecastScope,
} from '@/lib/financial-foundation'
import type { MetricDefinition } from '@/lib/financial-metrics'

export type ShareholderReturnAvailability = 'available' | 'missing' | 'not_applicable' | 'not_meaningful'

export interface ShareholderReturnValue {
  value: number | null
  unit: string | null
  availability: ShareholderReturnAvailability
  reason: string | null
  periodEnd: string | null
  publishedAt: string | null
  definitionVersion: string | null
  inputIds: string[]
}

export type DividendDirection = 'increase' | 'unchanged' | 'decrease' | 'no_dividend' | 'resumed' | 'unknown'

export interface DividendHistoryRow {
  key: string
  fiscalYear: number
  periodEnd: string
  publishedAt: string
  actualDps: ShareholderReturnValue
  rawActualDps: number | null
  forecastDps: ShareholderReturnValue
  forecastScope: ForecastScope | null
  eps: ShareholderReturnValue
  payoutRatio: ShareholderReturnValue
  dividendYield: ShareholderReturnValue
  direction: DividendDirection
  splitAdjustmentFactor: number
}

export interface DividendSplitAdjustment {
  fromFiscalYear: number
  toFiscalYear: number
  factor: number
  evidence: string
}

export type ForecastRevisionDirection = 'initial' | 'increase' | 'decrease' | 'unchanged' | 'basis_change'

export interface DividendForecastRevision {
  key: string
  publishedAt: string
  targetFiscalYear: number
  forecastScope: ForecastScope
  consolidationScope: ConsolidationScope
  accountingStandard: AccountingStandard
  value: number
  previousValue: number | null
  changeAmount: number | null
  changePercent: number | null
  direction: ForecastRevisionDirection
  disclosureId: string
  snapshotId: string
  previousSnapshotId: string | null
}

export interface ShareCountHistoryRow {
  fiscalYear: number
  periodEnd: string
  issuedShares: number
  treasuryShares: number
  netShares: number
  splitAdjustedNetShares: number
  netShareChangePercent: number | null
  splitAdjustmentFactor: number
  inputIds: string[]
}

export interface ShareholderReturnsReadModel {
  contractVersion: 'shareholder-returns-v1'
  ticker: string
  asOf: string
  priceDate: string | null
  isFinancialSector: boolean
  current: {
    forecastDps: ShareholderReturnValue
    forecastDividendYield: ShareholderReturnValue
    payoutRatio: ShareholderReturnValue
    actualDps: ShareholderReturnValue
    dpsYoY: ShareholderReturnValue
    fcfYield: ShareholderReturnValue
  }
  history: {
    rows: DividendHistoryRow[]
    adjustments: DividendSplitAdjustment[]
    adjustmentMethod: string
  }
  direction: {
    consecutiveIncreaseYears: ShareholderReturnValue
    consecutiveNonDecreaseYears: ShareholderReturnValue
    cutsLast5Years: ShareholderReturnValue
    dpsCagr3y: ShareholderReturnValue
    dpsCagr5y: ShareholderReturnValue
  }
  forecastRevisions: DividendForecastRevision[]
  sustainability: {
    payoutRatio: ShareholderReturnValue
    annualDividendTotal: ShareholderReturnValue
    standardFcf: ShareholderReturnValue
    fcfYield: ShareholderReturnValue
    fcfDividendCoverage: ShareholderReturnValue
    facts: string[]
  }
  buybacks: {
    availability: 'share_counts_only' | 'unavailable'
    reason: string
    annualBuybackAmount: ShareholderReturnValue
    marketCapRatio: ShareholderReturnValue
    shareCountHistory: ShareCountHistoryRow[]
  }
  totalReturns: {
    availability: 'available' | 'unavailable'
    reason: string
    totalPayout: ShareholderReturnValue
    totalPayoutRatio: ShareholderReturnValue
    totalPayoutYield: ShareholderReturnValue
  }
  definitions: {
    dividendYield: MetricDefinition
    payoutRatio: MetricDefinition
    standardFcf: MetricDefinition
    fcfYield: MetricDefinition
    dpsCagr: {
      formula: string
      version: string
    }
    annualDividendTotal: {
      formula: string
      version: string
    }
  }
  coverage: {
    facts: number
    actualDividendYears: number
    forecastSnapshots: number
    forecastRevisionRows: number
    payoutRatioYears: number
    shareCountYears: number
    splitAdjustments: number
    buybackAmountAvailable: boolean
  }
}
