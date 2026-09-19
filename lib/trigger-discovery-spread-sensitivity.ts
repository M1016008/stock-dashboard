import type { TriggerOutcomeHorizonSummary } from '@/lib/trigger-discovery-outcome-contract'
import type { TriggerDiscoveryTimeframe } from '@/lib/trigger-discovery-timeframe'

export const SPREAD_SENSITIVITY_GRID_VERSION = 'spread-sensitivity-default-v1' as const
export const SPREAD_SENSITIVITY_CONTRACT_VERSION = 'spread-sensitivity-v1' as const
export const SPREAD_SENSITIVITY_MAX_SETS = 32

export interface SpreadSensitivityParameter {
  lookbackIntervals: number
  requiredObservations: number
  configuredMinExpansionRatio: number
  requiredExpandedIntervals: number
  effectiveMinExpansionRatio: number
  isBaseline: boolean
}

const DEFAULT_GRID = [
  [3, 2], [3, 3],
  [4, 2], [4, 3], [4, 4],
  [6, 3], [6, 4], [6, 5], [6, 6],
  [8, 4], [8, 6], [8, 7], [8, 8],
] as const

export function spreadSensitivityGrid(): SpreadSensitivityParameter[] {
  if (DEFAULT_GRID.length > SPREAD_SENSITIVITY_MAX_SETS) throw new Error('spread_sensitivity_grid_too_large')
  const seen = new Set<string>()
  return DEFAULT_GRID.map(([lookbackIntervals, requiredExpandedIntervals]) => {
    const key = `${lookbackIntervals}:${requiredExpandedIntervals}`
    if (seen.has(key)) throw new Error('spread_sensitivity_duplicate_effective_rule')
    seen.add(key)
    const isBaseline = lookbackIntervals === 4 && requiredExpandedIntervals === 3
    return {
      lookbackIntervals,
      requiredObservations: lookbackIntervals + 1,
      configuredMinExpansionRatio: isBaseline ? 0.7 : requiredExpandedIntervals / lookbackIntervals,
      requiredExpandedIntervals,
      effectiveMinExpansionRatio: requiredExpandedIntervals / lookbackIntervals,
      isBaseline,
    }
  })
}

export type SpreadSensitivityHorizonSummary = TriggerOutcomeHorizonSummary & { smallSample: boolean }

export interface SpreadSensitivityGroup {
  eventCount: number
  uniqueTickerCount: number
  horizons: SpreadSensitivityHorizonSummary[]
}

export interface SpreadSensitivitySet extends SpreadSensitivityParameter {
  passEventCount: number
  failEventCount: number
  unknownEventCount: number
  passUniqueTickerCount: number
  passRate: number
  passUniqueTickerRate: number
  groups: { PASS: SpreadSensitivityGroup; FAIL: SpreadSensitivityGroup; UNKNOWN: SpreadSensitivityGroup }
}

export interface SpreadSensitivityResponse {
  contractVersion: typeof SPREAD_SENSITIVITY_CONTRACT_VERSION
  meta: {
    outcomeJobId: string
    historicalScanJobId: string
    sourceFingerprint: string
    parameterGridVersion: typeof SPREAD_SENSITIVITY_GRID_VERSION
    spreadEvaluatorVersion: number
    timeframe: TriggerDiscoveryTimeframe
    eventSelector: string
    scanPeriod: { startDate: string | null; endDate: string | null }
    observationUnit: 'MONTHLY_MA_AS_OF_EACH_TRADING_DAY' | 'BIWEEKLY_PARTIAL_BAR'
    observationIndependenceNote: string
    analysisCutoffDate: string
    sourceOutcomeHash: string
    baselineMatchesSavedDiagnostics: boolean
    generatedAt: string
    performance: {
      sourceOutcomeLoadMs: number
      maSourceQueryMs: number
      maSeriesConstructionMs: number
      parameterEvaluationMs: number
      aggregationMs: number
      percentileMs: number
      serializationMs: number
      totalMs: number
      sqlQueryCount: number
      sourceRows: number
      peakHeapBytes: number
      peakRssBytes: number
      resultBytes: number
    }
  }
  overall: SpreadSensitivityGroup
  parameterSets: SpreadSensitivitySet[]
}
