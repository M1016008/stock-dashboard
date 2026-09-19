import type {
  TriggerDiscoverySearchRequest,
  TriggerDiscoveryStageFilters,
} from '@/lib/trigger-discovery-contract'
import type { TriggerStatus } from '@/lib/trigger-discovery-engine'
import type { TriggerDiscoveryTimeframe } from '@/lib/trigger-discovery-timeframe'
import type { TriggerScoreBreakdown } from '@/lib/trigger-score'

export const TRIGGER_DISCOVERY_HISTORICAL_SCAN_CONTRACT_VERSION =
  'trigger-discovery-historical-scan-v1' as const

export type TriggerHistoricalScanEventType =
  | 'ENTERED'
  | 'RE_ENTRY'
  | 'STATUS_CHANGED'
  | 'EXITED'

export interface TriggerHistoricalScanRequest extends Omit<
  TriggerDiscoverySearchRequest,
  'requestedAsOf' | 'sort' | 'page' | 'pageSize' | 'statusFilter'
> {
  startDate: string
  endDate: string
  eventOffset?: number
  eventLimit?: number
}

export interface TriggerHistoricalScanCandidateSnapshot {
  ticker: string
  companyName: string
  market: string | null
  triggerStatus: TriggerStatus
  triggerScore: number
  scoreBreakdown: TriggerScoreBreakdown
  price: number
  ma1: number
  ma2: number
  zoneDistancePct: number
  maSpreadPct?: number | null
  maSpreadSlope?: number | null
  maSpreadExpansionRatio?: number | null
  spreadExpansionPass?: boolean
  spreadExpansionAvailable?: boolean
  bullishMaOrder?: boolean
  priceDate: string
  maDate: string
  stageDate: string | null
  dayAStage: number | null
  dayBStage: number | null
  weekAStage: number | null
  weekBStage: number | null
  monthAStage: number | null
  monthBStage: number | null
}

export interface TriggerHistoricalScanEvent {
  date: string
  ticker: string
  companyName: string
  eventType: TriggerHistoricalScanEventType
  previousStatus: TriggerStatus | null
  currentStatus: TriggerStatus | null
  snapshotBasis: 'CURRENT' | 'PREVIOUS'
  price: number
  ma1: number
  ma2: number
  zoneDistancePct: number
  maSpreadPct?: number | null
  maSpreadSlope?: number | null
  maSpreadExpansionRatio?: number | null
  spreadExpansionPass?: boolean
  spreadExpansionAvailable?: boolean
  bullishMaOrder?: boolean
  spreadDiagnosticDate?: string | null
  triggerScore: number
  scoreBreakdown: TriggerScoreBreakdown
  priceDate: string
  maDate: string
  stageDate: string | null
  dayAStage: number | null
  dayBStage: number | null
  weekAStage: number | null
  weekBStage: number | null
  monthAStage: number | null
  monthBStage: number | null
}

export interface TriggerHistoricalScanDailyCount {
  date: string
  candidateCount: number
  approachingCount: number
  nearCount: number
  inZoneCount: number
}

export interface TriggerHistoricalScanPerformance {
  totalMs: number
  queryCount: number
  tradingDays: number
  sourceTickerCount: number
  sourceRows: {
    ohlcv: number
    storedMonthlyMa: number
    weeklyOhlcv: number
    stage: number
  }
  sqlMs: {
    marketSessions: number
    universe: number
    ohlcv: number
    storedMonthlyMa: number
    weeklyOhlcv: number
    stage: number
    total: number
  }
  seriesBuildMs: number
  maPreparationMs: number
  liquidityMs: number
  universeFilterMs: number
  triggerEngineMs: number
  stageJoinMs: number
  scoreMs: number
  eventDerivationMs: number
  peakHeapBytes: number
  peakRssBytes: number
  heapDeltaBytes: number
}

export interface TriggerHistoricalScanResponse {
  contractVersion: typeof TRIGGER_DISCOVERY_HISTORICAL_SCAN_CONTRACT_VERSION
  scanMeta: {
    requestedStartDate: string
    resolvedStartDate: string | null
    requestedEndDate: string
    resolvedEndDate: string | null
    tradingDayCount: number
    processedTradingDays: number
    timeframe: TriggerDiscoveryTimeframe
    ma1Period: number
    ma2Period: number
    sampling: 'EACH_MARKET_TRADING_DAY'
    baselineDate: string | null
    baselineCandidateCount: number
    universeContract: 'reconstructed_from_currently_held_trade_history'
    universeNote: string
  }
  criteria: {
    maxApproachDistancePct: number
    nearDistancePct: number
    spreadExpansionEnabled?: boolean
    spreadLookbackIntervals?: number
    minExpansionRatio?: number
    requireBullishMaOrder?: boolean
    belowZoneToleranceEnabled?: boolean
    maxBelowZonePct?: number
    liquidityLookbackSessions: number
    maxPriceStalenessSessions: number
    markets: Array<string | null> | null
    priceMin: number | null
    priceMax: number | null
    averageVolumeMin: number | null
    averageVolumeMax: number | null
    averageTradingValueMin: number | null
    averageTradingValueMax: number | null
    stageFilters: TriggerDiscoveryStageFilters
  }
  summary: {
    tradingDays: number
    uniqueCandidateCount: number
    enteredCount: number
    reEntryCount: number
    statusChangeCount: number
    exitedCount: number
    totalEventCount: number
    maxDailyCandidates: number
    averageDailyCandidates: number
  }
  dailyCounts: TriggerHistoricalScanDailyCount[]
  events: TriggerHistoricalScanEvent[]
  eventPage: {
    offset: number
    limit: number
    returnedCount: number
    totalCount: number
    hasMore: boolean
  }
  performance: TriggerHistoricalScanPerformance
}
