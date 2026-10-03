import { execAll } from '@/lib/db/client'
import { historicalUniverseMembershipSql } from '@/lib/historical-universe'
import { MONTHLY_MA_MONITOR_PERIODS } from '@/lib/monthly-ma-monitor'
import { buildContinuousMonthlyMaSeries, splitContinuousHistory } from '@/lib/snapshots/continuous-ma'
import { calendarWeekStart, resampleOhlcv } from '@/lib/timeframes'
import {
  DEFAULT_TRIGGER_DISCOVERY_TIMEFRAME,
  attachBiweeklyMovingAverages,
  buildBiweeklyBarsFromWeekly,
  type TriggerDiscoveryTimeframe,
} from '@/lib/trigger-discovery-timeframe'
import {
  DEFAULT_MA_ZONE_TRIGGER_CONFIG,
  evaluateMaZoneTrigger,
  requiredMaZoneTriggerObservations,
  validateMaZoneTriggerConfig,
  type MaTrend,
  type MaZoneTriggerConfig,
  type MaZoneTriggerObservation,
  type TriggerApproachDirection,
  type TriggerPricePosition,
  type TriggerStatus,
} from '@/lib/trigger-discovery-engine'
import type { OHLCV } from '@/types/stock'
import { calculateTriggerScore, type TriggerScoreBreakdown } from '@/lib/trigger-score'
import {
  TRIGGER_DISCOVERY_STAGE_AXES,
  type TriggerDiscoverySortKey,
  type TriggerDiscoveryStageAxis,
  type TriggerDiscoveryStageFilters,
  type TriggerDiscoveryStageFilterValue,
} from '@/lib/trigger-discovery-contract'

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const DEFAULT_LIQUIDITY_LOOKBACK_SESSIONS = 20
const DEFAULT_MAX_PRICE_STALENESS_SESSIONS = 3
const DEFAULT_PAGE_LIMIT = 100
const MAX_PAGE_LIMIT = 10_000
const MAX_LIQUIDITY_LOOKBACK_SESSIONS = 252
const MAX_PRICE_STALENESS_SESSIONS = 60
const GENERIC_WARMUP_CALENDAR_DAYS = 160
const GENERIC_SESSION_CALENDAR_MULTIPLIER = 4
const BIWEEKLY_HISTORY_BUFFER_WEEKS = 10

export type TriggerDiscoveryFreshness = 'CURRENT' | 'STALE_ACCEPTED'
export type TriggerDiscoveryMaPath = 'fast' | 'generic'
export type {
  TriggerDiscoverySortKey,
  TriggerDiscoveryStageAxis,
  TriggerDiscoveryStageFilters,
  TriggerDiscoveryStageFilterValue,
} from '@/lib/trigger-discovery-contract'

export type TriggerDiscoveryRejectionReason =
  | 'PIT_UNIVERSE'
  | 'MARKET_FILTER'
  | 'PRICE_FILTER'
  | 'VOLUME_FILTER'
  | 'TRADING_VALUE_FILTER'
  | 'STALE_PRICE'
  | 'INSUFFICIENT_HISTORY'
  | 'MA_NOT_BOTH_RISING'
  | 'MA_SPREAD_NOT_EXPANDING'
  | 'NOT_FROM_ABOVE'
  | 'NOT_APPROACHING'
  | 'TOO_FAR'

export interface TriggerDiscoveryInput {
  asOf: string
  triggerConfig?: Partial<MaZoneTriggerConfig>
  markets?: Array<string | null>
  priceMin?: number | null
  priceMax?: number | null
  averageVolumeMin?: number | null
  averageVolumeMax?: number | null
  averageTradingValueMin?: number | null
  averageTradingValueMax?: number | null
  liquidityLookbackSessions?: number
  maxPriceStalenessSessions?: number
  stageFilters?: TriggerDiscoveryStageFilters
  sortBy?: TriggerDiscoverySortKey
  sortDirection?: 'asc' | 'desc'
  limit?: number
  offset?: number
  /** Internal lifecycle audit only. These tickers do not alter the candidate universe. */
  observeTickers?: string[]
}

export type TriggerDiscoveryObservationDisposition =
  | 'FINAL_CANDIDATE'
  | 'STAGE_FILTER_EXIT'
  | 'UNIVERSE_FILTER_EXIT'
  | 'CORE_CONDITION_EXIT'
  | 'TRIGGER_EXIT'
  | 'DATA_UNAVAILABLE'

export interface TriggerDiscoveryObservation {
  ticker: string
  disposition: TriggerDiscoveryObservationDisposition
  exclusionReason: TriggerDiscoveryRejectionReason | 'STAGE_FILTER' | null
  triggerStatus: TriggerStatus | null
  pricePosition: TriggerPricePosition | null
  bothRising: boolean | null
  fromAbove: boolean | null
  approachDirection: TriggerApproachDirection | null
  zoneUpper: number | null
  zoneLower: number | null
  zoneDistancePct: number | null
  price: number | null
  triggerScore: number | null
  priceDate: string | null
  maDate: string | null
  stageDate: string | null
  universeFilterPassed: boolean
  priceFilterPassed: boolean | null
  liquidityFilterPassed: boolean | null
  stageFilterPassed: boolean | null
  dataAvailable: boolean
}

export interface TriggerDiscoveryCandidateSnapshot {
  ticker: string
  companyName: string
  market: string | null
  priceDate: string | null
  price: number | null
  averageVolume: number | null
  averageTradingValue: number | null
  liquidityObservationCount: number
}

export interface TriggerDiscoveryFilteredCandidate extends TriggerDiscoveryCandidateSnapshot {
  priceDate: string
  price: number
  priceStalenessSessions: number
  priceFreshness: TriggerDiscoveryFreshness
  liquidityComplete: boolean
}

export interface TriggerDiscoveryStageSnapshot {
  ticker: string
  date: string
  dayAStage: number | null
  dayBStage: number | null
  weekAStage: number | null
  weekBStage: number | null
  monthAStage: number | null
  monthBStage: number | null
}

export interface TriggerDiscoveryRow {
  ticker: string
  companyName: string
  market: string | null
  requestedAsOf: string
  resolvedAsOf: string
  priceDate: string
  maDate: string
  stageDate: string | null
  price: number
  priceStalenessSessions: number
  priceFreshness: TriggerDiscoveryFreshness
  averageVolume: number | null
  averageTradingValue: number | null
  liquidityLookbackSessions: number
  liquidityObservationCount: number
  liquidityComplete: boolean
  ma1Period: number
  ma2Period: number
  ma1Value: number
  ma2Value: number
  ma1Trend: MaTrend
  ma2Trend: MaTrend
  ma1SlopePct: number
  ma2SlopePct: number
  bothRising: boolean
  maSpreadPct: number | null
  maSpreadSlope: number | null
  maSpreadExpansionRatio: number | null
  maSpreadExpanding: boolean
  bullishMaOrder: boolean
  spreadExpansionAvailable: boolean
  zoneUpper: number
  zoneLower: number
  zoneDistancePct: number
  ma1DistancePct: number
  ma2DistancePct: number
  fromAbove: boolean
  approachDirection: TriggerApproachDirection
  approachVelocityPctPointsPerSession: number
  triggerStatus: TriggerStatus
  matched: true
  maPath: TriggerDiscoveryMaPath
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
}

type TriggerDiscoveryRowWithoutStage = Omit<TriggerDiscoveryRow,
  | 'stageDate'
  | 'dayAStage'
  | 'dayBStage'
  | 'weekAStage'
  | 'weekBStage'
  | 'monthAStage'
  | 'monthBStage'
  | 'stageAvailable'
  | 'stageComplete'
  | 'triggerScore'
  | 'scoreBreakdown'>

type TriggerDiscoveryRowWithStage = Omit<TriggerDiscoveryRow, 'triggerScore' | 'scoreBreakdown'>

export interface TriggerDiscoveryDiagnostics {
  counts: {
    universe: number
    afterMarket: number
    afterStalePrice: number
    currentPrice: number
    staleAccepted: number
    afterPrice: number
    afterVolume: number
    afterTradingValue: number
    evaluated: number
    matched: number
    afterStageFilter: number
    stageRows: number
    stageComplete: number
    stageIncomplete: number
  }
  rejected: Record<TriggerDiscoveryRejectionReason, number>
  performance: {
    queryCount: number
    dbQueryMs: number
    maPreparationMs: number
    engineEvaluationMs: number
    stageJoinMs: number
    scoreCalculationMs: number
    totalMs: number
    fastPathEvaluated: number
    genericPathEvaluated: number
    biweekly?: TriggerDiscoveryBiweeklyPerformance
  }
}

export interface TriggerDiscoveryBiweeklyPerformance {
  weeklyRowsLoaded: number
  currentWeekDailyRowsLoaded: number
  weeklyHistoryQueryMs: number
  currentWeekQueryMs: number
  weeklyAssemblyMs: number
  biweeklyAggregationMs: number
  maCalculationMs: number
}

export interface TriggerDiscoveryResult {
  contractVersion: 'trigger-discovery-v1'
  requestedAsOf: string
  resolvedAsOf: string | null
  triggerConfig: MaZoneTriggerConfig
  liquidityLookbackSessions: number
  maxPriceStalenessSessions: number
  totalTriggerMatched: number
  totalMatched: number
  rows: TriggerDiscoveryRow[]
  limit: number
  offset: number
  hasMore: boolean
  diagnostics: TriggerDiscoveryDiagnostics
  /** Present only when the internal observeTickers input is supplied. */
  observations?: TriggerDiscoveryObservation[]
}

interface TimedLoad<T> {
  value: T
  queryCount: number
  queryMs: number
  preparationMs?: number
  biweekly?: TriggerDiscoveryBiweeklyPerformance
}

export interface TriggerDiscoveryDataSource {
  loadMarketSessions(asOf: string, limit: number): Promise<TimedLoad<string[]>>
  loadCandidateSnapshots(input: {
    resolvedAsOf: string
    oldestSessionDate: string
    liquidityLookbackSessions: number
  }): Promise<TimedLoad<TriggerDiscoveryCandidateSnapshot[]>>
  loadStoredMaObservations(input: {
    candidates: TriggerDiscoveryFilteredCandidate[]
    ma1Period: number
    ma2Period: number
    oldestObservationDate: string
    requiredObservations: number
  }): Promise<TimedLoad<Map<string, MaZoneTriggerObservation[]>>>
  loadGenericMaObservations(input: {
    candidates: TriggerDiscoveryFilteredCandidate[]
    ma1Period: number
    ma2Period: number
    requiredObservations: number
  }): Promise<TimedLoad<Map<string, MaZoneTriggerObservation[]>>>
  loadBiweeklyMaObservations?(input: {
    candidates: TriggerDiscoveryFilteredCandidate[]
    ma1Period: number
    ma2Period: number
    requiredObservations: number
  }): Promise<TimedLoad<Map<string, MaZoneTriggerObservation[]>>>
  loadStageSnapshots(input: {
    tickers: string[]
    resolvedAsOf: string
  }): Promise<TimedLoad<Map<string, TriggerDiscoveryStageSnapshot>>>
}

export interface TriggerDiscoveryExecutionOptions {
  dataSource?: TriggerDiscoveryDataSource
  maPath?: 'auto' | TriggerDiscoveryMaPath
  /** The public request parser validates this before selecting the calculation path. */
  timeframe?: TriggerDiscoveryTimeframe
}

export class TriggerDiscoveryInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TriggerDiscoveryInputError'
  }
}

type CandidateSqlRow = {
  ticker: string
  company_name: string | null
  market: string | null
  price_date: string | null
  price: number | null
  average_volume: number | null
  average_trading_value: number | null
  liquidity_observation_count: number | null
}

type StoredMaSqlRow = {
  ticker: string
  date: string
  close: number
  ma1_value: number
  ma2_value: number
}

type GenericMaSqlRow = OHLCV & {
  ticker: string
  is_recent: number
}

type WeeklyOhlcvSqlRow = OHLCV & {
  ticker: string
  week_start_date: string
}

type DailyOhlcvSqlRow = OHLCV & {
  ticker: string
}

type StageSnapshotSqlRow = {
  ticker: string
  date: string
  daily_a_stage: number | null
  daily_b_stage: number | null
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
}

function elapsedMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 1000) / 1000
}

function finiteNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function assertIsoDate(value: string): void {
  const parsed = new Date(`${value}T00:00:00Z`)
  if (!DATE_PATTERN.test(value) || Number.isNaN(parsed.valueOf())
    || parsed.toISOString().slice(0, 10) !== value) {
    throw new TriggerDiscoveryInputError('asOf must use YYYY-MM-DD format')
  }
}

function boundedInteger(name: string, value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new TriggerDiscoveryInputError(`${name} must be an integer between ${min} and ${max}`)
  }
  return value
}

function optionalBound(name: string, value: number | null | undefined): number | null {
  if (value == null) return null
  if (!Number.isFinite(value) || value < 0) {
    throw new TriggerDiscoveryInputError(`${name} must be a finite non-negative number`)
  }
  return value
}

function validateRange(name: string, min: number | null, max: number | null): void {
  if (min != null && max != null && min > max) {
    throw new TriggerDiscoveryInputError(`${name} minimum must not exceed maximum`)
  }
}

function dateDaysBefore(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() - days)
  return value.toISOString().slice(0, 10)
}

function valuesCte(candidates: TriggerDiscoveryFilteredCandidate[]): { sql: string; args: Array<string> } {
  return {
    sql: candidates.map(() => '(?, ?)').join(', '),
    args: candidates.flatMap((candidate) => [candidate.ticker, candidate.priceDate]),
  }
}

function tickerValuesCte(tickers: string[]): { sql: string; args: string[] } {
  return {
    sql: tickers.map(() => '(?)').join(', '),
    args: tickers,
  }
}

function stageValue(value: number | null): number | null {
  return value == null ? null : Number(value)
}

export function attachTriggerDiscoveryStage(
  row: TriggerDiscoveryRowWithoutStage,
  snapshot: TriggerDiscoveryStageSnapshot | undefined,
): TriggerDiscoveryRowWithStage {
  const exactSnapshot = snapshot?.date === row.resolvedAsOf ? snapshot : undefined
  const stages = exactSnapshot
    ? [
        exactSnapshot.dayAStage,
        exactSnapshot.dayBStage,
        exactSnapshot.weekAStage,
        exactSnapshot.weekBStage,
        exactSnapshot.monthAStage,
        exactSnapshot.monthBStage,
      ]
    : []
  return {
    ...row,
    stageDate: exactSnapshot?.date ?? null,
    dayAStage: exactSnapshot?.dayAStage ?? null,
    dayBStage: exactSnapshot?.dayBStage ?? null,
    weekAStage: exactSnapshot?.weekAStage ?? null,
    weekBStage: exactSnapshot?.weekBStage ?? null,
    monthAStage: exactSnapshot?.monthAStage ?? null,
    monthBStage: exactSnapshot?.monthBStage ?? null,
    stageAvailable: exactSnapshot != null,
    stageComplete: exactSnapshot != null && stages.every((stage) => stage != null),
  }
}

function approximatelyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= Math.max(1, Math.abs(left), Math.abs(right)) * 1e-9
}

function countSessionsAfter(priceDate: string, sessionsDescending: string[]): number {
  const exact = sessionsDescending.indexOf(priceDate)
  if (exact >= 0) return exact
  return sessionsDescending.filter((date) => date > priceDate).length
}

function emptyRejected(): Record<TriggerDiscoveryRejectionReason, number> {
  return {
    PIT_UNIVERSE: 0,
    MARKET_FILTER: 0,
    PRICE_FILTER: 0,
    VOLUME_FILTER: 0,
    TRADING_VALUE_FILTER: 0,
    STALE_PRICE: 0,
    INSUFFICIENT_HISTORY: 0,
    MA_NOT_BOTH_RISING: 0,
    MA_SPREAD_NOT_EXPANDING: 0,
    NOT_FROM_ABOVE: 0,
    NOT_APPROACHING: 0,
    TOO_FAR: 0,
  }
}

function inInclusiveRange(value: number | null, min: number | null, max: number | null): boolean {
  if (value == null) return false
  return (min == null || value >= min) && (max == null || value <= max)
}

export function filterTriggerDiscoveryCandidates(input: {
  candidates: TriggerDiscoveryCandidateSnapshot[]
  marketSessionsDescending: string[]
  markets?: Array<string | null>
  priceMin: number | null
  priceMax: number | null
  averageVolumeMin: number | null
  averageVolumeMax: number | null
  averageTradingValueMin: number | null
  averageTradingValueMax: number | null
  liquidityLookbackSessions: number
  maxPriceStalenessSessions: number
  observeTickers?: ReadonlySet<string>
}): {
  candidates: TriggerDiscoveryFilteredCandidate[]
  counts: Omit<TriggerDiscoveryDiagnostics['counts'],
    | 'evaluated'
    | 'matched'
    | 'afterStageFilter'
    | 'stageRows'
    | 'stageComplete'
    | 'stageIncomplete'>
  rejected: Record<TriggerDiscoveryRejectionReason, number>
  observed: Map<string, TriggerDiscoveryObservation>
} {
  const rejected = emptyRejected()
  const selectedMarkets = input.markets == null ? null : new Set(input.markets)
  const observed = new Map<string, TriggerDiscoveryObservation>()
  const marketRows: TriggerDiscoveryCandidateSnapshot[] = []
  const freshRows: TriggerDiscoveryFilteredCandidate[] = []
  const priceRows: TriggerDiscoveryFilteredCandidate[] = []
  const volumeRows: TriggerDiscoveryFilteredCandidate[] = []
  const tradingValueRows: TriggerDiscoveryFilteredCandidate[] = []
  const volumeFilterEnabled = input.averageVolumeMin != null || input.averageVolumeMax != null
  const tradingValueFilterEnabled = input.averageTradingValueMin != null
    || input.averageTradingValueMax != null

  const observation = (
    candidate: TriggerDiscoveryCandidateSnapshot,
    overrides: Partial<TriggerDiscoveryObservation>,
  ): TriggerDiscoveryObservation => ({
    ticker: candidate.ticker,
    disposition: 'UNIVERSE_FILTER_EXIT',
    exclusionReason: null,
    triggerStatus: null,
    pricePosition: null,
    bothRising: null,
    fromAbove: null,
    approachDirection: null,
    zoneUpper: null,
    zoneLower: null,
    zoneDistancePct: null,
    price: candidate.price,
    triggerScore: null,
    priceDate: candidate.priceDate,
    maDate: null,
    stageDate: null,
    universeFilterPassed: false,
    priceFilterPassed: null,
    liquidityFilterPassed: null,
    stageFilterPassed: null,
    dataAvailable: candidate.price != null && candidate.priceDate != null,
    ...overrides,
  })

  for (const candidate of input.candidates) {
    const isObserved = input.observeTickers?.has(candidate.ticker) ?? false
    if (selectedMarkets != null && !selectedMarkets.has(candidate.market)) {
      rejected.MARKET_FILTER += 1
      if (isObserved) observed.set(candidate.ticker, observation(candidate, { exclusionReason: 'MARKET_FILTER' }))
      continue
    }
    marketRows.push(candidate)
    if (candidate.price == null || !candidate.priceDate) {
      rejected.STALE_PRICE += 1
      if (isObserved) observed.set(candidate.ticker, observation(candidate, {
        disposition: 'DATA_UNAVAILABLE', exclusionReason: 'STALE_PRICE', universeFilterPassed: true,
        dataAvailable: false,
      }))
      continue
    }
    const staleness = countSessionsAfter(candidate.priceDate, input.marketSessionsDescending)
    if (staleness > input.maxPriceStalenessSessions) {
      rejected.STALE_PRICE += 1
      if (isObserved) observed.set(candidate.ticker, observation(candidate, {
        disposition: 'DATA_UNAVAILABLE', exclusionReason: 'STALE_PRICE', universeFilterPassed: true,
        dataAvailable: false,
      }))
      continue
    }
    const filteredCandidate: TriggerDiscoveryFilteredCandidate = {
      ...candidate,
      price: candidate.price,
      priceDate: candidate.priceDate,
      priceStalenessSessions: staleness,
      priceFreshness: staleness === 0 ? 'CURRENT' : 'STALE_ACCEPTED',
      liquidityComplete: candidate.liquidityObservationCount >= input.liquidityLookbackSessions,
    }
    freshRows.push(filteredCandidate)
    if (!inInclusiveRange(filteredCandidate.price, input.priceMin, input.priceMax)) {
      rejected.PRICE_FILTER += 1
      if (isObserved) observed.set(candidate.ticker, observation(candidate, {
        exclusionReason: 'PRICE_FILTER', universeFilterPassed: true, priceFilterPassed: false,
      }))
      continue
    }
    priceRows.push(filteredCandidate)
    if (volumeFilterEnabled
      && !inInclusiveRange(filteredCandidate.averageVolume, input.averageVolumeMin, input.averageVolumeMax)) {
      rejected.VOLUME_FILTER += 1
      if (isObserved) observed.set(candidate.ticker, observation(candidate, {
        exclusionReason: 'VOLUME_FILTER', universeFilterPassed: true,
        priceFilterPassed: true, liquidityFilterPassed: false,
      }))
      continue
    }
    volumeRows.push(filteredCandidate)
    if (tradingValueFilterEnabled
      && !inInclusiveRange(filteredCandidate.averageTradingValue, input.averageTradingValueMin, input.averageTradingValueMax)) {
      rejected.TRADING_VALUE_FILTER += 1
      if (isObserved) observed.set(candidate.ticker, observation(candidate, {
        exclusionReason: 'TRADING_VALUE_FILTER', universeFilterPassed: true,
        priceFilterPassed: true, liquidityFilterPassed: false,
      }))
      continue
    }
    tradingValueRows.push(filteredCandidate)
    if (isObserved) observed.set(candidate.ticker, observation(candidate, {
      disposition: 'DATA_UNAVAILABLE', universeFilterPassed: true,
      priceFilterPassed: true, liquidityFilterPassed: true,
    }))
  }
  return {
    candidates: tradingValueRows,
    counts: {
      universe: input.candidates.length,
      afterMarket: marketRows.length,
      afterStalePrice: freshRows.length,
      currentPrice: freshRows.filter((candidate) => candidate.priceFreshness === 'CURRENT').length,
      staleAccepted: freshRows.filter((candidate) => candidate.priceFreshness === 'STALE_ACCEPTED').length,
      afterPrice: priceRows.length,
      afterVolume: volumeRows.length,
      afterTradingValue: tradingValueRows.length,
    },
    rejected,
    observed,
  }
}

function rejectionForTrigger(
  result: ReturnType<typeof evaluateMaZoneTrigger>,
  spreadExpansionEnabled = false,
): TriggerDiscoveryRejectionReason {
  if (result.availability !== 'available') return 'INSUFFICIENT_HISTORY'
  if (!result.bothRising) return 'MA_NOT_BOTH_RISING'
  if (!result.fromAbove) return 'NOT_FROM_ABOVE'
  if (spreadExpansionEnabled && !result.spreadExpansionAvailable) return 'INSUFFICIENT_HISTORY'
  if (spreadExpansionEnabled && !result.maSpreadExpanding) return 'MA_SPREAD_NOT_EXPANDING'
  if (result.approachDirection !== 'TOWARD_ZONE' && result.status !== 'IN_ZONE') return 'NOT_APPROACHING'
  return 'TOO_FAR'
}

function statusOrder(status: TriggerStatus): number {
  if (status === 'IN_ZONE') return 0
  if (status === 'NEAR') return 1
  if (status === 'APPROACHING') return 2
  return 3
}

const STAGE_AXES: TriggerDiscoveryStageAxis[] = [...TRIGGER_DISCOVERY_STAGE_AXES]

function numericSortValue(row: TriggerDiscoveryRow, key: TriggerDiscoverySortKey): number | string | null {
  switch (key) {
    case 'ticker': return row.ticker
    case 'triggerStatus': return statusOrder(row.triggerStatus)
    case 'price': return row.price
    case 'zoneDistance': return Math.abs(row.zoneDistancePct)
    case 'ma1Distance': return Math.abs(row.ma1DistancePct)
    case 'ma2Distance': return Math.abs(row.ma2DistancePct)
    case 'averageVolume': return row.averageVolume
    case 'averageTradingValue': return row.averageTradingValue
    case 'approachVelocity': return row.approachVelocityPctPointsPerSession
    case 'triggerScore': return row.triggerScore
    case 'dayAStage': return row.dayAStage
    case 'dayBStage': return row.dayBStage
    case 'weekAStage': return row.weekAStage
    case 'weekBStage': return row.weekBStage
    case 'monthAStage': return row.monthAStage
    case 'monthBStage': return row.monthBStage
  }
}

export function filterTriggerDiscoveryRowsByStage(
  rows: TriggerDiscoveryRow[],
  filters?: TriggerDiscoveryStageFilters,
): TriggerDiscoveryRow[] {
  if (!filters) return rows
  return rows.filter((row) => STAGE_AXES.every((axis) => {
    const selected = filters[axis]
    if (!selected?.length) return true
    const value = row[axis]
    return value == null ? selected.includes('unknown') : selected.includes(value as TriggerDiscoveryStageFilterValue)
  }))
}

export function sortTriggerDiscoveryRows(
  rows: TriggerDiscoveryRow[],
  sortBy?: TriggerDiscoverySortKey,
  direction: 'asc' | 'desc' = 'asc',
): TriggerDiscoveryRow[] {
  return rows.slice().sort((left, right) => {
    if (!sortBy) {
      const statusDifference = statusOrder(left.triggerStatus) - statusOrder(right.triggerStatus)
      if (statusDifference !== 0) return statusDifference
      const distanceDifference = Math.abs(left.zoneDistancePct) - Math.abs(right.zoneDistancePct)
      if (distanceDifference !== 0) return distanceDifference
      return left.ticker.localeCompare(right.ticker)
    }
    const leftValue = numericSortValue(left, sortBy)
    const rightValue = numericSortValue(right, sortBy)
    if (leftValue == null || rightValue == null) {
      if (leftValue == null && rightValue == null) return left.ticker.localeCompare(right.ticker)
      return leftValue == null ? 1 : -1
    }
    const compared = typeof leftValue === 'string' && typeof rightValue === 'string'
      ? leftValue.localeCompare(rightValue)
      : Number(leftValue) - Number(rightValue)
    return compared === 0
      ? left.ticker.localeCompare(right.ticker)
      : compared * (direction === 'desc' ? -1 : 1)
  })
}

function validateStageFilters(filters?: TriggerDiscoveryStageFilters): void {
  if (!filters) return
  for (const [axis, values] of Object.entries(filters)) {
    if (!STAGE_AXES.includes(axis as TriggerDiscoveryStageAxis) || !Array.isArray(values)) {
      throw new TriggerDiscoveryInputError('stageFilters contains an invalid axis')
    }
    if (values.some((value) => value !== 'unknown'
      && (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 6))) {
      throw new TriggerDiscoveryInputError(`${axis} must contain Stage 1-6 or unknown`)
    }
  }
}

export function createTriggerDiscoverySqlDataSource(): TriggerDiscoveryDataSource {
  return {
    async loadMarketSessions(asOf, limit) {
      const startedAt = performance.now()
      const rows = await execAll<{ date: string }>(`
        SELECT DISTINCT date
        FROM ohlcv_daily
        WHERE date <= ?
        ORDER BY date DESC
        LIMIT ?
      `, [asOf, limit])
      return { value: rows.map((row) => row.date), queryCount: 1, queryMs: elapsedMs(startedAt) }
    },

    async loadCandidateSnapshots({ resolvedAsOf, oldestSessionDate, liquidityLookbackSessions }) {
      const startedAt = performance.now()
      const membership = historicalUniverseMembershipSql(
        'params.as_of',
        'hu',
        'tu',
        'prices.price_date = params.as_of',
      )
      const rows = await execAll<CandidateSqlRow>(`
        WITH params AS (
          SELECT ? AS as_of, ? AS lookback
        ), universe_keys AS (
          SELECT ticker FROM historical_universe
          UNION
          SELECT ticker FROM ticker_universe
        ), ranked_prices AS (
          SELECT o.ticker, o.date, o.close, o.volume,
                 ROW_NUMBER() OVER (PARTITION BY o.ticker ORDER BY o.date DESC) AS rn
          FROM ohlcv_daily AS o
          WHERE o.date BETWEEN ? AND ?
        ), prices AS (
          SELECT r.ticker,
                 MAX(CASE WHEN r.rn = 1 THEN r.date END) AS price_date,
                 MAX(CASE WHEN r.rn = 1 THEN r.close END) AS price,
                 AVG(CASE WHEN r.rn <= params.lookback THEN r.volume END) AS average_volume,
                 AVG(CASE WHEN r.rn <= params.lookback THEN r.close * r.volume END) AS average_trading_value,
                 SUM(CASE WHEN r.rn <= params.lookback THEN 1 ELSE 0 END) AS liquidity_observation_count
          FROM ranked_prices AS r
          CROSS JOIN params
          GROUP BY r.ticker
        )
        SELECT keys.ticker,
               COALESCE(hu.name, tu.name, keys.ticker) AS company_name,
               COALESCE(hu.market_segment, tu.market_segment) AS market,
               prices.price_date,
               prices.price,
               prices.average_volume,
               prices.average_trading_value,
               prices.liquidity_observation_count
        FROM universe_keys AS keys
        CROSS JOIN params
        LEFT JOIN historical_universe AS hu ON hu.ticker = keys.ticker
        LEFT JOIN ticker_universe AS tu ON tu.ticker = keys.ticker
        LEFT JOIN prices ON prices.ticker = keys.ticker
        WHERE ${membership}
        ORDER BY keys.ticker
      `, [resolvedAsOf, liquidityLookbackSessions, oldestSessionDate, resolvedAsOf])
      return {
        value: rows.map((row) => ({
          ticker: row.ticker,
          companyName: row.company_name?.trim() || row.ticker,
          market: row.market,
          priceDate: row.price_date,
          price: finiteNumber(row.price),
          averageVolume: finiteNumber(row.average_volume),
          averageTradingValue: finiteNumber(row.average_trading_value),
          liquidityObservationCount: Number(row.liquidity_observation_count ?? 0),
        })),
        queryCount: 1,
        queryMs: elapsedMs(startedAt),
      }
    },

    async loadStoredMaObservations({
      candidates,
      ma1Period,
      ma2Period,
      oldestObservationDate,
      requiredObservations,
    }) {
      if (candidates.length === 0) return { value: new Map(), queryCount: 0, queryMs: 0 }
      const candidateRows = valuesCte(candidates)
      const queryStartedAt = performance.now()
      const rows = await execAll<StoredMaSqlRow>(`
        WITH candidates(ticker, price_date) AS (VALUES ${candidateRows.sql})
        SELECT ma1.ticker,
               ma1.date,
               ma1.close,
               ma1.ma_value AS ma1_value,
               ma2.ma_value AS ma2_value
        FROM candidates
        CROSS JOIN monthly_ma_monitor_daily AS ma1
          INDEXED BY monthly_ma_monitor_ticker_period_date_idx
        CROSS JOIN monthly_ma_monitor_daily AS ma2
          INDEXED BY monthly_ma_monitor_ticker_period_date_idx
        WHERE ma1.ticker = candidates.ticker
          AND ma1.period = ?
          AND ma1.date BETWEEN MAX(COALESCE((
            SELECT cutoff.date
            FROM monthly_ma_monitor_daily AS cutoff
              INDEXED BY monthly_ma_monitor_ticker_period_date_idx
            INNER JOIN monthly_ma_monitor_daily AS cutoff_pair
              INDEXED BY monthly_ma_monitor_ticker_period_date_idx
              ON cutoff_pair.ticker = cutoff.ticker
             AND cutoff_pair.period = ?
             AND cutoff_pair.date = cutoff.date
            WHERE cutoff.ticker = candidates.ticker
              AND cutoff.period = ?
              AND cutoff.date <= candidates.price_date
            ORDER BY cutoff.date DESC
            LIMIT 1 OFFSET ?
          ), ?), ?)
          AND candidates.price_date
          AND ma2.ticker = ma1.ticker
          AND ma2.period = ?
          AND ma2.date = ma1.date
      `, [
        ...candidateRows.args,
        ma1Period,
        ma2Period,
        ma1Period,
        requiredObservations - 1,
        oldestObservationDate,
        oldestObservationDate,
        ma2Period,
      ])
      const queryMs = elapsedMs(queryStartedAt)
      const preparationStartedAt = performance.now()
      const value = new Map<string, MaZoneTriggerObservation[]>()
      for (const row of rows) {
        const observations = value.get(row.ticker) ?? []
        observations.push({
          date: row.date,
          price: Number(row.close),
          ma1: Number(row.ma1_value),
          ma2: Number(row.ma2_value),
        })
        value.set(row.ticker, observations)
      }
      for (const observations of value.values()) {
        observations.sort((left, right) => left.date.localeCompare(right.date))
      }
      return {
        value,
        queryCount: 1,
        queryMs,
        preparationMs: elapsedMs(preparationStartedAt),
      }
    },

    async loadGenericMaObservations({ candidates, ma1Period, ma2Period, requiredObservations }) {
      if (candidates.length === 0) return { value: new Map(), queryCount: 0, queryMs: 0 }
      const candidateByTicker = new Map(candidates.map((candidate) => [candidate.ticker, candidate]))
      const maximumPeriod = Math.max(ma1Period, ma2Period)
      const historyCalendarDays = maximumPeriod * 32
        + GENERIC_WARMUP_CALENDAR_DAYS
        + requiredObservations * GENERIC_SESSION_CALENDAR_MULTIPLIER
      const historyStart = dateDaysBefore(
        candidates.reduce((oldest, candidate) => candidate.priceDate < oldest ? candidate.priceDate : oldest, candidates[0].priceDate),
        historyCalendarDays,
      )
      const oldestPriceDate = candidates.reduce(
        (oldest, candidate) => candidate.priceDate < oldest ? candidate.priceDate : oldest,
        candidates[0].priceDate,
      )
      const newestPriceDate = candidates.reduce(
        (newest, candidate) => candidate.priceDate > newest ? candidate.priceDate : newest,
        candidates[0].priceDate,
      )
      const recentStart = dateDaysBefore(
        oldestPriceDate,
        requiredObservations * GENERIC_SESSION_CALENDAR_MULTIPLIER + 30,
      )
      const queryStartedAt = performance.now()
      let rows: GenericMaSqlRow[]
      if (candidates.length <= 200) {
        const cte = valuesCte(candidates)
        rows = await execAll<GenericMaSqlRow>(`
          WITH candidates(ticker, price_date) AS (VALUES ${cte.sql}), bounded AS (
            SELECT o.ticker, o.date, o.open, o.high, o.low, o.close, o.volume,
                   ROW_NUMBER() OVER (
                     PARTITION BY o.ticker, substr(o.date, 1, 7)
                     ORDER BY o.date DESC
                   ) AS month_rank,
                   ROW_NUMBER() OVER (
                     PARTITION BY o.ticker, substr(o.date, 1, 7)
                     ORDER BY o.date ASC
                   ) AS month_first_rank,
                   ROW_NUMBER() OVER (
                     PARTITION BY o.ticker
                     ORDER BY o.date DESC
                   ) AS recent_rank
            FROM ohlcv_daily AS o
            INNER JOIN candidates
              ON candidates.ticker = o.ticker
             AND o.date <= candidates.price_date
            WHERE o.date >= ?
          )
          SELECT ticker, date, open, high, low, close, volume,
                 CASE WHEN recent_rank <= ? THEN 1 ELSE 0 END AS is_recent
          FROM bounded
          WHERE month_rank = 1 OR month_first_rank = 1 OR recent_rank <= ?
          ORDER BY ticker, date
        `, [...cte.args, historyStart, requiredObservations, requiredObservations])
      } else {
        rows = await execAll<GenericMaSqlRow>(`
          WITH month_edges AS (
            SELECT ticker, substr(date, 1, 7) AS month_key,
                   MIN(date) AS first_date, MAX(date) AS last_date
            FROM ohlcv_daily
            WHERE date BETWEEN ? AND ?
            GROUP BY ticker, month_key
          )
          SELECT o.ticker, o.date, o.open, o.high, o.low, o.close, o.volume, 0 AS is_recent
          FROM month_edges
          INNER JOIN ohlcv_daily AS o
            ON o.ticker = month_edges.ticker
            AND o.date IN (month_edges.first_date, month_edges.last_date)
          UNION ALL
          SELECT o.ticker, o.date, o.open, o.high, o.low, o.close, o.volume, 1 AS is_recent
          FROM ohlcv_daily AS o
          WHERE o.date BETWEEN ? AND ?
          ORDER BY ticker, date, is_recent
        `, [historyStart, newestPriceDate, recentStart, newestPriceDate])
      }
      let queryMs = elapsedMs(queryStartedAt)
      let queryCount = 1
      const preparationStartedAt = performance.now()
      const grouped = new Map<string, { byDate: Map<string, OHLCV>; recentDates: Set<string> }>()
      for (const row of rows) {
        const candidate = candidateByTicker.get(row.ticker)
        if (!candidate || row.date > candidate.priceDate) continue
        const group = grouped.get(row.ticker) ?? { byDate: new Map<string, OHLCV>(), recentDates: new Set<string>() }
        group.byDate.set(row.date, {
          date: row.date,
          open: Number(row.open),
          high: Number(row.high),
          low: Number(row.low),
          close: Number(row.close),
          volume: Number(row.volume),
        })
        if (Number(row.is_recent) === 1) group.recentDates.add(row.date)
        grouped.set(row.ticker, group)
      }
      if (candidates.length > 200) {
        const sparse = candidates.filter((candidate) =>
          (grouped.get(candidate.ticker)?.recentDates.size ?? 0) < requiredObservations)
        for (let offset = 0; offset < sparse.length; offset += 250) {
          const cte = valuesCte(sparse.slice(offset, offset + 250))
          const startedAt = performance.now()
          const recent = await execAll<GenericMaSqlRow>(`
            WITH candidates(ticker, price_date) AS (VALUES ${cte.sql}), ranked AS (
              SELECT o.ticker, o.date, o.open, o.high, o.low, o.close, o.volume,
                     ROW_NUMBER() OVER (PARTITION BY o.ticker ORDER BY o.date DESC) AS recent_rank
              FROM ohlcv_daily AS o
              INNER JOIN candidates AS c ON c.ticker=o.ticker AND o.date<=c.price_date
              WHERE o.date>=?
            )
            SELECT ticker, date, open, high, low, close, volume, 1 AS is_recent
            FROM ranked WHERE recent_rank<=?
          `, [...cte.args, historyStart, requiredObservations])
          queryMs += elapsedMs(startedAt)
          queryCount += 1
          for (const row of recent) {
            const group = grouped.get(row.ticker) ?? { byDate: new Map<string, OHLCV>(), recentDates: new Set<string>() }
            group.byDate.set(row.date, {
              date: row.date, open: Number(row.open), high: Number(row.high),
              low: Number(row.low), close: Number(row.close), volume: Number(row.volume),
            })
            group.recentDates.add(row.date)
            grouped.set(row.ticker, group)
          }
        }
      }
      const value = new Map<string, MaZoneTriggerObservation[]>()
      for (const [ticker, group] of grouped) {
        const recentDateSet = new Set([...group.recentDates].sort().slice(-requiredObservations))
        const series = buildContinuousMonthlyMaSeries(
          [...group.byDate.values()].sort((left, right) => left.date.localeCompare(right.date)),
          [ma1Period, ma2Period],
          { adjustSplits: false },
        )
        value.set(ticker, series.flatMap((point) => {
          if (!recentDateSet.has(point.date)) return []
          const ma1 = point.values.get(ma1Period)
          const ma2 = point.values.get(ma2Period)
          return ma1 == null || ma2 == null
            ? []
            : [{ date: point.date, price: point.close, ma1, ma2 }]
        }))
      }
      return {
        value,
        queryCount,
        queryMs,
        preparationMs: elapsedMs(preparationStartedAt),
      }
    },

    async loadBiweeklyMaObservations({ candidates, ma1Period, ma2Period, requiredObservations }) {
      if (candidates.length === 0) {
        return {
          value: new Map(),
          queryCount: 0,
          queryMs: 0,
          preparationMs: 0,
          biweekly: {
            weeklyRowsLoaded: 0,
            currentWeekDailyRowsLoaded: 0,
            weeklyHistoryQueryMs: 0,
            currentWeekQueryMs: 0,
            weeklyAssemblyMs: 0,
            biweeklyAggregationMs: 0,
            maCalculationMs: 0,
          },
        }
      }

      const candidateByTicker = new Map(candidates.map((candidate) => [candidate.ticker, candidate]))
      const weekStartByTicker = new Map(
        candidates.map((candidate) => [candidate.ticker, calendarWeekStart(candidate.priceDate)]),
      )
      const maximumPeriod = Math.max(ma1Period, ma2Period)
      const requiredBiweeklyBars = maximumPeriod + requiredObservations - 1
      const requiredWeeklyBars = requiredBiweeklyBars * 2 + 1
      const oldestPriceDate = candidates.reduce(
        (oldest, candidate) => candidate.priceDate < oldest ? candidate.priceDate : oldest,
        candidates[0].priceDate,
      )
      const newestPriceDate = candidates.reduce(
        (newest, candidate) => candidate.priceDate > newest ? candidate.priceDate : newest,
        candidates[0].priceDate,
      )
      const oldestCurrentWeekStart = candidates.reduce((oldest, candidate) => {
        const weekStart = weekStartByTicker.get(candidate.ticker)!
        return weekStart < oldest ? weekStart : oldest
      }, weekStartByTicker.get(candidates[0].ticker)!)
      const historyStart = dateDaysBefore(
        oldestPriceDate,
        (requiredWeeklyBars + BIWEEKLY_HISTORY_BUFFER_WEEKS) * 7,
      )
      const candidateTickers = tickerValuesCte(candidates.map((candidate) => candidate.ticker))

      const weeklyQueryStartedAt = performance.now()
      const weeklyRows = await execAll<WeeklyOhlcvSqlRow>(`
        WITH candidates(ticker) AS (VALUES ${candidateTickers.sql}), latest_weekly AS (
          SELECT weekly.ticker, weekly.week_start_date, MAX(weekly.date) AS date
          FROM weekly_ohlcv AS weekly
          INNER JOIN candidates ON candidates.ticker = weekly.ticker
          WHERE weekly.date BETWEEN ? AND ?
          GROUP BY weekly.ticker, weekly.week_start_date
        )
        SELECT weekly.ticker,
               weekly.date,
               weekly.week_start_date,
               weekly.open,
               weekly.high,
               weekly.low,
               weekly.close,
               weekly.volume
        FROM latest_weekly
        INNER JOIN weekly_ohlcv AS weekly
          ON weekly.ticker = latest_weekly.ticker
         AND weekly.week_start_date = latest_weekly.week_start_date
         AND weekly.date = latest_weekly.date
        ORDER BY weekly.ticker, weekly.date
      `, [...candidateTickers.args, historyStart, newestPriceDate])
      const weeklyHistoryQueryMs = elapsedMs(weeklyQueryStartedAt)

      const currentWeekQueryStartedAt = performance.now()
      const currentWeekDailyRows = await execAll<DailyOhlcvSqlRow>(`
        WITH candidates(ticker) AS (VALUES ${candidateTickers.sql})
        SELECT daily.ticker, daily.date, daily.open, daily.high, daily.low, daily.close, daily.volume
        FROM ohlcv_daily AS daily
        INNER JOIN candidates ON candidates.ticker = daily.ticker
        WHERE daily.date BETWEEN ? AND ?
        ORDER BY daily.ticker, daily.date
      `, [...candidateTickers.args, oldestCurrentWeekStart, newestPriceDate])
      const currentWeekQueryMs = elapsedMs(currentWeekQueryStartedAt)

      const preparationStartedAt = performance.now()
      const weeklyByTicker = new Map<string, OHLCV[]>()
      for (const row of weeklyRows) {
        const candidate = candidateByTicker.get(row.ticker)
        const currentWeekStart = weekStartByTicker.get(row.ticker)
        if (!candidate || !currentWeekStart || row.date > candidate.priceDate
          || row.week_start_date >= currentWeekStart) continue
        const rows = weeklyByTicker.get(row.ticker) ?? []
        rows.push({
          date: row.date,
          open: Number(row.open),
          high: Number(row.high),
          low: Number(row.low),
          close: Number(row.close),
          volume: Number(row.volume),
        })
        weeklyByTicker.set(row.ticker, rows)
      }

      const currentDailyByTicker = new Map<string, OHLCV[]>()
      for (const row of currentWeekDailyRows) {
        const candidate = candidateByTicker.get(row.ticker)
        const currentWeekStart = weekStartByTicker.get(row.ticker)
        if (!candidate || !currentWeekStart || row.date < currentWeekStart || row.date > candidate.priceDate) continue
        const rows = currentDailyByTicker.get(row.ticker) ?? []
        rows.push({
          date: row.date,
          open: Number(row.open),
          high: Number(row.high),
          low: Number(row.low),
          close: Number(row.close),
          volume: Number(row.volume),
        })
        currentDailyByTicker.set(row.ticker, rows)
      }

      const assembledWeekly = new Map<string, OHLCV[]>()
      for (const candidate of candidates) {
        const history = (weeklyByTicker.get(candidate.ticker) ?? []).slice(-requiredWeeklyBars)
        const currentWeek = resampleOhlcv(
          currentDailyByTicker.get(candidate.ticker) ?? [],
          { timeframe: 'week', multiplier: 1 },
        )
        assembledWeekly.set(
          candidate.ticker,
          [...history, ...currentWeek].sort((left, right) => left.date.localeCompare(right.date)),
        )
      }
      const weeklyAssemblyMs = elapsedMs(preparationStartedAt)

      let biweeklyAggregationMs = 0
      let maCalculationMs = 0
      const value = new Map<string, MaZoneTriggerObservation[]>()
      for (const [ticker, weekly] of assembledWeekly) {
        const points = splitContinuousHistory(weekly).flatMap((segment) => {
          const aggregationStartedAt = performance.now()
          const biweekly = buildBiweeklyBarsFromWeekly(segment)
          biweeklyAggregationMs += performance.now() - aggregationStartedAt

          const maStartedAt = performance.now()
          const withMa = attachBiweeklyMovingAverages(
            biweekly,
            [ma1Period, ma2Period],
            segment[0]?.date ?? '',
          )
          maCalculationMs += performance.now() - maStartedAt
          return withMa
        })
        value.set(ticker, points.flatMap((point) => {
          const ma1 = point.values.get(ma1Period)
          const ma2 = point.values.get(ma2Period)
          return ma1 == null || ma2 == null
            ? []
            : [{ date: point.date, price: point.close, ma1, ma2 }]
        }).slice(-requiredObservations))
      }

      const biweekly = {
        weeklyRowsLoaded: weeklyRows.length,
        currentWeekDailyRowsLoaded: currentWeekDailyRows.length,
        weeklyHistoryQueryMs,
        currentWeekQueryMs,
        weeklyAssemblyMs,
        biweeklyAggregationMs: Math.round(biweeklyAggregationMs * 1000) / 1000,
        maCalculationMs: Math.round(maCalculationMs * 1000) / 1000,
      }
      return {
        value,
        queryCount: 2,
        queryMs: weeklyHistoryQueryMs + currentWeekQueryMs,
        preparationMs: weeklyAssemblyMs + biweekly.biweeklyAggregationMs + biweekly.maCalculationMs,
        biweekly,
      }
    },

    async loadStageSnapshots({ tickers, resolvedAsOf }) {
      if (tickers.length === 0) return { value: new Map(), queryCount: 0, queryMs: 0 }
      const candidates = tickerValuesCte(tickers)
      const queryStartedAt = performance.now()
      const rows = await execAll<StageSnapshotSqlRow>(`
        WITH candidates(ticker) AS (VALUES ${candidates.sql})
        SELECT snapshots.ticker,
               snapshots.date,
               snapshots.daily_a_stage,
               snapshots.daily_b_stage,
               snapshots.weekly_a_stage,
               snapshots.weekly_b_stage,
               snapshots.monthly_a_stage,
               snapshots.monthly_b_stage
        FROM candidates
        INNER JOIN daily_snapshots AS snapshots
          ON snapshots.ticker = candidates.ticker
         AND snapshots.date = ?
      `, [...candidates.args, resolvedAsOf])
      const queryMs = elapsedMs(queryStartedAt)
      const preparationStartedAt = performance.now()
      const value = new Map<string, TriggerDiscoveryStageSnapshot>()
      for (const row of rows) {
        value.set(row.ticker, {
          ticker: row.ticker,
          date: row.date,
          dayAStage: stageValue(row.daily_a_stage),
          dayBStage: stageValue(row.daily_b_stage),
          weekAStage: stageValue(row.weekly_a_stage),
          weekBStage: stageValue(row.weekly_b_stage),
          monthAStage: stageValue(row.monthly_a_stage),
          monthBStage: stageValue(row.monthly_b_stage),
        })
      }
      return {
        value,
        queryCount: 1,
        queryMs,
        preparationMs: elapsedMs(preparationStartedAt),
      }
    },
  }
}

export async function getTriggerDiscovery(
  input: TriggerDiscoveryInput,
  options: TriggerDiscoveryExecutionOptions = {},
): Promise<TriggerDiscoveryResult> {
  const totalStartedAt = performance.now()
  assertIsoDate(input.asOf)
  validateStageFilters(input.stageFilters)
  const timeframe = options.timeframe ?? DEFAULT_TRIGGER_DISCOVERY_TIMEFRAME
  if (timeframe !== 'MONTHLY' && timeframe !== 'BIWEEKLY') {
    throw new TriggerDiscoveryInputError('timeframe must be MONTHLY or BIWEEKLY')
  }
  const observeTickerSet = new Set(input.observeTickers ?? [])
  if (observeTickerSet.size > MAX_PAGE_LIMIT) {
    throw new TriggerDiscoveryInputError(`observeTickers must contain at most ${MAX_PAGE_LIMIT} tickers`)
  }
  const triggerConfig: MaZoneTriggerConfig = {
    ...DEFAULT_MA_ZONE_TRIGGER_CONFIG,
    ...input.triggerConfig,
  }
  validateMaZoneTriggerConfig(triggerConfig)
  const liquidityLookbackSessions = boundedInteger(
    'liquidityLookbackSessions',
    input.liquidityLookbackSessions ?? DEFAULT_LIQUIDITY_LOOKBACK_SESSIONS,
    1,
    MAX_LIQUIDITY_LOOKBACK_SESSIONS,
  )
  const maxPriceStalenessSessions = boundedInteger(
    'maxPriceStalenessSessions',
    input.maxPriceStalenessSessions ?? DEFAULT_MAX_PRICE_STALENESS_SESSIONS,
    0,
    MAX_PRICE_STALENESS_SESSIONS,
  )
  const limit = boundedInteger('limit', input.limit ?? DEFAULT_PAGE_LIMIT, 1, MAX_PAGE_LIMIT)
  const offset = boundedInteger('offset', input.offset ?? 0, 0, Number.MAX_SAFE_INTEGER)
  const priceMin = optionalBound('priceMin', input.priceMin)
  const priceMax = optionalBound('priceMax', input.priceMax)
  const averageVolumeMin = optionalBound('averageVolumeMin', input.averageVolumeMin)
  const averageVolumeMax = optionalBound('averageVolumeMax', input.averageVolumeMax)
  const averageTradingValueMin = optionalBound('averageTradingValueMin', input.averageTradingValueMin)
  const averageTradingValueMax = optionalBound('averageTradingValueMax', input.averageTradingValueMax)
  validateRange('price', priceMin, priceMax)
  validateRange('averageVolume', averageVolumeMin, averageVolumeMax)
  validateRange('averageTradingValue', averageTradingValueMin, averageTradingValueMax)

  const requiredObservations = requiredMaZoneTriggerObservations(triggerConfig)
  const sessionLimit = Math.max(requiredObservations, liquidityLookbackSessions)
    + maxPriceStalenessSessions + 5
  const dataSource = options.dataSource ?? createTriggerDiscoverySqlDataSource()
  let queryCount = 0
  let dbQueryMs = 0
  let maPreparationMs = 0
  let biweeklyPerformance: TriggerDiscoveryBiweeklyPerformance | undefined
  const sessionsLoad = await dataSource.loadMarketSessions(input.asOf, sessionLimit)
  queryCount += sessionsLoad.queryCount
  dbQueryMs += sessionsLoad.queryMs
  const marketSessions = sessionsLoad.value
  const resolvedAsOf = marketSessions[0] ?? null
  const rejected = emptyRejected()
  if (!resolvedAsOf) {
    return {
      contractVersion: 'trigger-discovery-v1',
      requestedAsOf: input.asOf,
      resolvedAsOf: null,
      triggerConfig,
      liquidityLookbackSessions,
      maxPriceStalenessSessions,
      totalTriggerMatched: 0,
      totalMatched: 0,
      rows: [],
      limit,
      offset,
      hasMore: false,
      diagnostics: {
        counts: { universe: 0, afterMarket: 0, afterStalePrice: 0, currentPrice: 0, staleAccepted: 0, afterPrice: 0, afterVolume: 0, afterTradingValue: 0, evaluated: 0, matched: 0, afterStageFilter: 0, stageRows: 0, stageComplete: 0, stageIncomplete: 0 },
        rejected,
        performance: { queryCount, dbQueryMs, maPreparationMs: 0, engineEvaluationMs: 0, stageJoinMs: 0, scoreCalculationMs: 0, totalMs: elapsedMs(totalStartedAt), fastPathEvaluated: 0, genericPathEvaluated: 0 },
      },
      observations: input.observeTickers == null ? undefined : [],
    }
  }

  const candidateLoad = await dataSource.loadCandidateSnapshots({
    resolvedAsOf,
    oldestSessionDate: marketSessions.at(-1)!,
    liquidityLookbackSessions,
  })
  queryCount += candidateLoad.queryCount
  dbQueryMs += candidateLoad.queryMs
  const filtered = filterTriggerDiscoveryCandidates({
    candidates: candidateLoad.value,
    marketSessionsDescending: marketSessions,
    markets: input.markets,
    priceMin,
    priceMax,
    averageVolumeMin,
    averageVolumeMax,
    averageTradingValueMin,
    averageTradingValueMax,
    liquidityLookbackSessions,
    maxPriceStalenessSessions,
    observeTickers: observeTickerSet,
  })
  Object.assign(rejected, filtered.rejected)
  const lifecycleObservations = new Map<string, TriggerDiscoveryObservation>()
  for (const ticker of observeTickerSet) {
    lifecycleObservations.set(ticker, {
      ticker,
      disposition: 'UNIVERSE_FILTER_EXIT',
      exclusionReason: 'PIT_UNIVERSE',
      triggerStatus: null,
      pricePosition: null,
      bothRising: null,
      fromAbove: null,
      approachDirection: null,
      zoneUpper: null,
      zoneLower: null,
      zoneDistancePct: null,
      price: null,
      triggerScore: null,
      priceDate: null,
      maDate: null,
      stageDate: null,
      universeFilterPassed: false,
      priceFilterPassed: null,
      liquidityFilterPassed: null,
      stageFilterPassed: null,
      dataAvailable: false,
    })
  }
  for (const [ticker, observation] of filtered.observed) lifecycleObservations.set(ticker, observation)

  const observations = new Map<string, { rows: MaZoneTriggerObservation[]; path: TriggerDiscoveryMaPath }>()
  const storedPeriods = new Set<number>(MONTHLY_MA_MONITOR_PERIODS)
  const canUseFastPath = timeframe === 'MONTHLY'
    && storedPeriods.has(triggerConfig.ma1Period)
    && storedPeriods.has(triggerConfig.ma2Period)
  if (options.maPath === 'fast' && !canUseFastPath) {
    throw new TriggerDiscoveryInputError('fast MA path is unavailable for the requested periods')
  }
  const useFastPath = options.maPath !== 'generic' && canUseFastPath
  let genericCandidates = filtered.candidates
  if (useFastPath) {
    const fastLoad = await dataSource.loadStoredMaObservations({
      candidates: filtered.candidates,
      ma1Period: triggerConfig.ma1Period,
      ma2Period: triggerConfig.ma2Period,
      oldestObservationDate: marketSessions.at(-1)!,
      requiredObservations,
    })
    queryCount += fastLoad.queryCount
    dbQueryMs += fastLoad.queryMs
    maPreparationMs += fastLoad.preparationMs ?? 0
    const fallback: TriggerDiscoveryFilteredCandidate[] = []
    const storedCoverageExists = fastLoad.value.size > 0
    for (const candidate of filtered.candidates) {
      const rows = fastLoad.value.get(candidate.ticker) ?? []
      const latest = rows.at(-1)
      if (!storedCoverageExists) {
        fallback.push(candidate)
      } else if (latest && (
        latest.date !== candidate.priceDate
        || !approximatelyEqual(latest.price, candidate.price)
      )) {
        fallback.push(candidate)
      } else if (latest && rows.length < requiredObservations) {
        // The saved series can be short around suspensions even when older OHLCV
        // contains enough observations. Rebuild only that bounded subset.
        fallback.push(candidate)
      } else {
        observations.set(candidate.ticker, { rows, path: 'fast' })
      }
    }
    genericCandidates = fallback
  }
  if (!useFastPath || genericCandidates.length > 0) {
    const genericLoad = timeframe === 'BIWEEKLY'
      ? await (() => {
          if (!dataSource.loadBiweeklyMaObservations) {
            throw new TriggerDiscoveryInputError('Biweekly MA data source is unavailable')
          }
          return dataSource.loadBiweeklyMaObservations({
            candidates: genericCandidates,
            ma1Period: triggerConfig.ma1Period,
            ma2Period: triggerConfig.ma2Period,
            requiredObservations,
          })
        })()
      : await dataSource.loadGenericMaObservations({
          candidates: genericCandidates,
          ma1Period: triggerConfig.ma1Period,
          ma2Period: triggerConfig.ma2Period,
          requiredObservations,
        })
    queryCount += genericLoad.queryCount
    dbQueryMs += genericLoad.queryMs
    maPreparationMs += genericLoad.preparationMs ?? 0
    biweeklyPerformance = genericLoad.biweekly
    for (const candidate of genericCandidates) {
      observations.set(candidate.ticker, {
        rows: genericLoad.value.get(candidate.ticker) ?? [],
        path: 'generic',
      })
    }
  }

  const engineStartedAt = performance.now()
  const matchedRows: TriggerDiscoveryRowWithoutStage[] = []
  let fastPathEvaluated = 0
  let genericPathEvaluated = 0
  for (const candidate of filtered.candidates) {
    const prepared = observations.get(candidate.ticker) ?? { rows: [], path: 'generic' as const }
    if (prepared.path === 'fast') fastPathEvaluated += 1
    else genericPathEvaluated += 1
    const trigger = evaluateMaZoneTrigger({
      observations: prepared.rows,
      asOf: resolvedAsOf,
      config: triggerConfig,
    })
    if (observeTickerSet.has(candidate.ticker)) {
      const snapshot = trigger.snapshot
      const reason = rejectionForTrigger(trigger, triggerConfig.spreadExpansionEnabled)
      lifecycleObservations.set(candidate.ticker, {
        ticker: candidate.ticker,
        disposition: trigger.availability !== 'available'
          ? 'DATA_UNAVAILABLE'
          : !trigger.bothRising || !trigger.fromAbove
              || (triggerConfig.spreadExpansionEnabled && !trigger.maSpreadExpanding)
            ? 'CORE_CONDITION_EXIT'
            : trigger.matched
              ? 'FINAL_CANDIDATE'
              : 'TRIGGER_EXIT',
        exclusionReason: trigger.matched ? null : reason,
        triggerStatus: trigger.status,
        pricePosition: snapshot?.pricePosition ?? null,
        bothRising: trigger.availability === 'available' ? trigger.bothRising : null,
        fromAbove: trigger.availability === 'available' ? trigger.fromAbove : null,
        approachDirection: trigger.approachDirection,
        zoneUpper: snapshot?.zoneUpper ?? null,
        zoneLower: snapshot?.zoneLower ?? null,
        zoneDistancePct: snapshot?.zoneDistancePct ?? null,
        price: snapshot?.price ?? candidate.price,
        triggerScore: null,
        priceDate: candidate.priceDate,
        maDate: trigger.observationDate,
        stageDate: null,
        universeFilterPassed: true,
        priceFilterPassed: true,
        liquidityFilterPassed: true,
        stageFilterPassed: null,
        dataAvailable: trigger.availability === 'available',
      })
    }
    if (!trigger.matched || !trigger.snapshot || !trigger.observationDate
      || !trigger.ma1Trend || !trigger.ma2Trend || !trigger.approachDirection
      || trigger.approachVelocityPctPointsPerSession == null) {
      rejected[rejectionForTrigger(trigger, triggerConfig.spreadExpansionEnabled)] += 1
      continue
    }
    matchedRows.push({
      ticker: candidate.ticker,
      companyName: candidate.companyName,
      market: candidate.market,
      requestedAsOf: input.asOf,
      resolvedAsOf,
      priceDate: candidate.priceDate,
      maDate: trigger.observationDate,
      price: trigger.snapshot.price,
      priceStalenessSessions: candidate.priceStalenessSessions,
      priceFreshness: candidate.priceFreshness,
      averageVolume: candidate.averageVolume,
      averageTradingValue: candidate.averageTradingValue,
      liquidityLookbackSessions,
      liquidityObservationCount: candidate.liquidityObservationCount,
      liquidityComplete: candidate.liquidityComplete,
      ma1Period: trigger.ma1Period,
      ma2Period: trigger.ma2Period,
      ma1Value: trigger.snapshot.ma1,
      ma2Value: trigger.snapshot.ma2,
      ma1Trend: trigger.ma1Trend,
      ma2Trend: trigger.ma2Trend,
      ma1SlopePct: trigger.ma1SlopePct ?? 0,
      ma2SlopePct: trigger.ma2SlopePct ?? 0,
      bothRising: trigger.bothRising,
      maSpreadPct: trigger.maSpreadPct,
      maSpreadSlope: trigger.maSpreadSlope,
      maSpreadExpansionRatio: trigger.maSpreadExpansionRatio,
      maSpreadExpanding: trigger.maSpreadExpanding,
      bullishMaOrder: trigger.bullishMaOrder,
      spreadExpansionAvailable: trigger.spreadExpansionAvailable,
      zoneUpper: trigger.snapshot.zoneUpper,
      zoneLower: trigger.snapshot.zoneLower,
      zoneDistancePct: trigger.snapshot.zoneDistancePct,
      ma1DistancePct: trigger.snapshot.ma1DistancePct,
      ma2DistancePct: trigger.snapshot.ma2DistancePct,
      fromAbove: trigger.fromAbove,
      approachDirection: trigger.approachDirection,
      approachVelocityPctPointsPerSession: trigger.approachVelocityPctPointsPerSession,
      triggerStatus: trigger.status,
      matched: true,
      maPath: prepared.path,
    })
  }
  const engineEvaluationMs = elapsedMs(engineStartedAt)
  const stageLoad = await dataSource.loadStageSnapshots({
    tickers: matchedRows.map((row) => row.ticker),
    resolvedAsOf,
  })
  queryCount += stageLoad.queryCount
  dbQueryMs += stageLoad.queryMs
  const stageJoinMs = stageLoad.queryMs + (stageLoad.preparationMs ?? 0)
  const unscoredRows = matchedRows.map((row) => attachTriggerDiscoveryStage(
    row,
    stageLoad.value.get(row.ticker),
  ))
  const scoreStartedAt = performance.now()
  const rowsWithStages: TriggerDiscoveryRow[] = unscoredRows.map((row) => {
    const score = calculateTriggerScore({
      triggerStatus: row.triggerStatus,
      fromAbove: row.fromAbove,
      zoneDistancePct: row.zoneDistancePct,
      maxApproachDistancePct: triggerConfig.maxApproachDistancePct,
      approachVelocityPctPointsPerSession: row.approachVelocityPctPointsPerSession,
      ma1SlopePct: row.ma1SlopePct,
      ma2SlopePct: row.ma2SlopePct,
      averageTradingValue: row.averageTradingValue,
      dayAStage: row.dayAStage,
      dayBStage: row.dayBStage,
      weekAStage: row.weekAStage,
      weekBStage: row.weekBStage,
      monthAStage: row.monthAStage,
      monthBStage: row.monthBStage,
    })
    return {
      ...row,
      triggerScore: score.totalScore,
      scoreBreakdown: score.scoreBreakdown,
    }
  })
  const scoreCalculationMs = elapsedMs(scoreStartedAt)
  const filteredByStage = filterTriggerDiscoveryRowsByStage(rowsWithStages, input.stageFilters)
  const stageAcceptedTickers = new Set(filteredByStage.map((row) => row.ticker))
  for (const row of rowsWithStages) {
    if (!observeTickerSet.has(row.ticker)) continue
    const stageFilterPassed = stageAcceptedTickers.has(row.ticker)
    lifecycleObservations.set(row.ticker, {
      ...lifecycleObservations.get(row.ticker)!,
      disposition: stageFilterPassed ? 'FINAL_CANDIDATE' : 'STAGE_FILTER_EXIT',
      exclusionReason: stageFilterPassed ? null : 'STAGE_FILTER',
      triggerStatus: row.triggerStatus,
      triggerScore: row.triggerScore,
      stageDate: row.stageDate,
      stageFilterPassed,
    })
  }
  const sorted = sortTriggerDiscoveryRows(filteredByStage, input.sortBy, input.sortDirection)
  const rows = sorted.slice(offset, offset + limit)
  return {
    contractVersion: 'trigger-discovery-v1',
    requestedAsOf: input.asOf,
    resolvedAsOf,
    triggerConfig,
    liquidityLookbackSessions,
    maxPriceStalenessSessions,
    totalTriggerMatched: rowsWithStages.length,
    totalMatched: sorted.length,
    rows,
    limit,
    offset,
    hasMore: offset + rows.length < sorted.length,
    diagnostics: {
      counts: {
        ...filtered.counts,
        evaluated: filtered.candidates.length,
        matched: rowsWithStages.length,
        afterStageFilter: filteredByStage.length,
        stageRows: rowsWithStages.filter((row) => row.stageAvailable).length,
        stageComplete: rowsWithStages.filter((row) => row.stageComplete).length,
        stageIncomplete: rowsWithStages.filter((row) => !row.stageComplete).length,
      },
      rejected,
      performance: {
        queryCount,
        dbQueryMs,
        maPreparationMs,
        engineEvaluationMs,
        stageJoinMs,
        scoreCalculationMs,
        totalMs: elapsedMs(totalStartedAt),
        fastPathEvaluated,
        genericPathEvaluated,
        ...(biweeklyPerformance ? { biweekly: biweeklyPerformance } : {}),
      },
    },
    observations: input.observeTickers == null
      ? undefined
      : [...lifecycleObservations.values()].sort((left, right) => left.ticker.localeCompare(right.ticker)),
  }
}
