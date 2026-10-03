import type { TriggerStatus } from '@/lib/trigger-discovery-engine'
import type { TriggerScoreBreakdown } from '@/lib/trigger-score'
import type { TriggerDiscoveryTimeframe } from '@/lib/trigger-discovery-timeframe'

export const TRIGGER_DISCOVERY_STAGE_AXES = [
  'dayAStage',
  'dayBStage',
  'weekAStage',
  'weekBStage',
  'monthAStage',
  'monthBStage',
] as const

export type TriggerDiscoveryStageAxis = (typeof TRIGGER_DISCOVERY_STAGE_AXES)[number]
export type TriggerDiscoveryStageFilterValue = 1 | 2 | 3 | 4 | 5 | 6 | 'unknown'
export type TriggerDiscoveryStageFilters = Partial<
  Record<TriggerDiscoveryStageAxis, TriggerDiscoveryStageFilterValue[]>
>

export const TRIGGER_DISCOVERY_SORT_KEYS = [
  'ticker',
  'triggerStatus',
  'price',
  'zoneDistance',
  'ma1Distance',
  'ma2Distance',
  'averageVolume',
  'averageTradingValue',
  'approachVelocity',
  'triggerScore',
  ...TRIGGER_DISCOVERY_STAGE_AXES,
] as const

export type TriggerDiscoverySortKey = (typeof TRIGGER_DISCOVERY_SORT_KEYS)[number]
export type TriggerDiscoverySortDirection = 'asc' | 'desc'

export interface TriggerDiscoverySearchRequest {
  requestedAsOf: string
  timeframe?: TriggerDiscoveryTimeframe
  ma1Period?: number
  ma2Period?: number
  slopeLookbackSessions?: number
  approachLookbackSessions?: number
  minimumAboveZoneRatio?: number
  maxApproachDistancePct?: number
  nearDistancePct?: number
  spreadExpansionEnabled?: boolean
  spreadLookbackIntervals?: number
  minExpansionRatio?: number
  requireBullishMaOrder?: boolean
  belowZoneToleranceEnabled?: boolean
  maxBelowZonePct?: number
  statusFilter?: 'APPROACHING' | 'NEAR' | 'IN_ZONE' | 'BELOW_ZONE' | null
  markets?: Array<string | null>
  priceMin?: number | null
  priceMax?: number | null
  averageVolumeMin?: number | null
  averageVolumeMax?: number | null
  averageTradingValueMin?: number | null
  averageTradingValueMax?: number | null
  liquidityLookbackSessions?: number
  maxPriceStalenessSessions?: number
  sort?: {
    key: TriggerDiscoverySortKey
    direction: TriggerDiscoverySortDirection
  } | null
  page?: number
  pageSize?: number
  stageFilters?: TriggerDiscoveryStageFilters
}

export interface TriggerDiscoverySearchRow {
  ticker: string
  companyName: string
  market: string | null
  price: number
  triggerStatus: TriggerStatus
  zoneDistancePct: number
  ma1DistancePct: number
  ma2DistancePct: number
  maSpreadPct: number | null
  maSpreadSlope: number | null
  maSpreadExpansionRatio: number | null
  maSpreadExpanding: boolean
  bullishMaOrder: boolean
  spreadExpansionAvailable: boolean
  averageVolume: number | null
  averageTradingValue: number | null
  triggerScore: number
  scoreBreakdown: TriggerScoreBreakdown
  dayAStage: number | null
  dayBStage: number | null
  weekAStage: number | null
  weekBStage: number | null
  monthAStage: number | null
  monthBStage: number | null
  stageAvailable: boolean
  stageComplete: boolean
  priceDate: string
  maDate: string
  stageDate: string | null
  priceFreshness: 'CURRENT' | 'STALE_ACCEPTED'
  priceStalenessSessions: number
  ma1Period: number
  ma2Period: number
}

export interface TriggerDiscoverySearchResponse {
  contractVersion: 'trigger-discovery-search-v1'
  meta: {
    requestedAsOf: string
    resolvedAsOf: string | null
    timeframe: TriggerDiscoveryTimeframe
    pitUniverseCount: number
    currentPriceCount: number
    staleAcceptedCount: number
    triggerEvaluatedCount: number
    triggerMatchedCount: number
    matchedCount: number
    returnedCount: number
    page: number
    pageSize: number
    totalPages: number
  }
  criteria: {
    ma1Period: number
    ma2Period: number
    maxApproachDistancePct: number
    nearDistancePct: number
    spreadExpansionEnabled: boolean
    spreadLookbackIntervals: number
    minExpansionRatio: number
    requireBullishMaOrder: boolean
    belowZoneToleranceEnabled?: boolean
    maxBelowZonePct?: number
    statusFilter?: TriggerDiscoverySearchRequest['statusFilter']
    liquidityLookbackSessions: number
    markets: Array<string | null> | null
    stageFilters: TriggerDiscoveryStageFilters
    sort: TriggerDiscoverySearchRequest['sort']
  }
  rows: TriggerDiscoverySearchRow[]
  performance: {
    totalMs: number
    dbQueryMs: number
    maPreparationMs: number
    engineEvaluationMs: number
    stageJoinMs: number
    queryCount: number
    cacheHit: boolean
  }
}

export interface TriggerDiscoveryOptionsResponse {
  contractVersion: 'trigger-discovery-options-v1'
  latestAsOf: string | null
  markets: Array<{
    value: string | null
    label: string
    count: number
  }>
}

export const TRIGGER_DISCOVERY_MINI_CHART_MAX_TICKERS = 100
export const TRIGGER_DISCOVERY_MINI_CHART_DEFAULT_MONTHS = 36
export const TRIGGER_DISCOVERY_MINI_CHART_DEFAULT_POINTS = 36

export interface TriggerDiscoveryMiniChartsRequest {
  tickers: string[]
  requestedAsOf: string
  timeframe?: TriggerDiscoveryTimeframe
  ma1Period: number
  ma2Period: number
  displayPoints?: number
  /** Legacy Monthly caller compatibility. Prefer displayPoints for new callers. */
  displayMonths?: number
}

export interface TriggerDiscoveryMiniChartPoint {
  date: string
  close: number
  ma1: number | null
  ma2: number | null
}

export interface TriggerDiscoveryMiniChart {
  ticker: string
  requestedAsOf: string
  resolvedAsOf: string
  latestPointDate: string | null
  availability: 'available' | 'insufficient_history' | 'missing'
  points: TriggerDiscoveryMiniChartPoint[]
}

export interface TriggerDiscoveryMiniChartsResponse {
  contractVersion: 'trigger-discovery-mini-charts-v1'
  requestedAsOf: string
  resolvedAsOf: string | null
  timeframe: TriggerDiscoveryTimeframe
  ma1Period: number
  ma2Period: number
  displayPoints: number
  /** Legacy alias retained for existing Monthly clients. */
  displayMonths: number
  charts: TriggerDiscoveryMiniChart[]
  performance: {
    queryCount: number
    dbQueryMs: number
    maCalculationMs: number
    totalMs: number
    biweekly?: {
      latestPriceQueryMs: number
      weeklyHistoryQueryMs: number
      currentWeekQueryMs: number
      weeklyAssemblyMs: number
      biweeklyAggregationMs: number
      maCalculationMs: number
    }
  }
}
