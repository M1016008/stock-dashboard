import { execAll } from '@/lib/db/client'
import { historicalUniverseMembershipSql } from '@/lib/historical-universe'
import { MONTHLY_MA_MONITOR_PERIODS } from '@/lib/monthly-ma-monitor'
import { buildContinuousMonthlyMaSeries } from '@/lib/snapshots/continuous-ma'
import {
  DEFAULT_MA_ZONE_TRIGGER_CONFIG,
  evaluateMaZoneTrigger,
  validateMaZoneTriggerConfig,
  type MaTrend,
  type MaZoneTriggerConfig,
  type MaZoneTriggerObservation,
  type TriggerApproachDirection,
  type TriggerStatus,
} from '@/lib/trigger-discovery-engine'
import type { OHLCV } from '@/types/stock'

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const DEFAULT_LIQUIDITY_LOOKBACK_SESSIONS = 20
const DEFAULT_MAX_PRICE_STALENESS_SESSIONS = 3
const DEFAULT_PAGE_LIMIT = 100
const MAX_PAGE_LIMIT = 500
const MAX_LIQUIDITY_LOOKBACK_SESSIONS = 252
const MAX_PRICE_STALENESS_SESSIONS = 60
const GENERIC_WARMUP_CALENDAR_DAYS = 160
const GENERIC_SESSION_CALENDAR_MULTIPLIER = 4

export type TriggerDiscoveryFreshness = 'CURRENT' | 'STALE_ACCEPTED'
export type TriggerDiscoveryMaPath = 'fast' | 'generic'
export type TriggerDiscoverySortKey =
  | 'ticker'
  | 'price'
  | 'zoneDistance'
  | 'ma1Distance'
  | 'ma2Distance'
  | 'averageVolume'
  | 'averageTradingValue'
  | 'approachVelocity'

export type TriggerDiscoveryRejectionReason =
  | 'PIT_UNIVERSE'
  | 'MARKET_FILTER'
  | 'PRICE_FILTER'
  | 'VOLUME_FILTER'
  | 'TRADING_VALUE_FILTER'
  | 'STALE_PRICE'
  | 'INSUFFICIENT_HISTORY'
  | 'MA_NOT_BOTH_RISING'
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
  sortBy?: TriggerDiscoverySortKey
  sortDirection?: 'asc' | 'desc'
  limit?: number
  offset?: number
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

export interface TriggerDiscoveryRow {
  ticker: string
  companyName: string
  market: string | null
  requestedAsOf: string
  resolvedAsOf: string
  priceDate: string
  maDate: string
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
  bothRising: boolean
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
}

export interface TriggerDiscoveryDiagnostics {
  counts: {
    universe: number
    afterMarket: number
    afterStalePrice: number
    afterPrice: number
    afterVolume: number
    afterTradingValue: number
    evaluated: number
    matched: number
  }
  rejected: Record<TriggerDiscoveryRejectionReason, number>
  performance: {
    queryCount: number
    dbQueryMs: number
    maPreparationMs: number
    engineEvaluationMs: number
    totalMs: number
    fastPathEvaluated: number
    genericPathEvaluated: number
  }
}

export interface TriggerDiscoveryResult {
  contractVersion: 'trigger-discovery-v1'
  requestedAsOf: string
  resolvedAsOf: string | null
  triggerConfig: MaZoneTriggerConfig
  liquidityLookbackSessions: number
  maxPriceStalenessSessions: number
  totalMatched: number
  rows: TriggerDiscoveryRow[]
  limit: number
  offset: number
  hasMore: boolean
  diagnostics: TriggerDiscoveryDiagnostics
}

interface TimedLoad<T> {
  value: T
  queryCount: number
  queryMs: number
  preparationMs?: number
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
  }): Promise<TimedLoad<Map<string, MaZoneTriggerObservation[]>>>
  loadGenericMaObservations(input: {
    candidates: TriggerDiscoveryFilteredCandidate[]
    ma1Period: number
    ma2Period: number
    requiredObservations: number
  }): Promise<TimedLoad<Map<string, MaZoneTriggerObservation[]>>>
}

export interface TriggerDiscoveryExecutionOptions {
  dataSource?: TriggerDiscoveryDataSource
  maPath?: 'auto' | TriggerDiscoveryMaPath
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
  period: number
  date: string
  close: number
  ma_value: number
}

type GenericMaSqlRow = OHLCV & {
  ticker: string
  is_recent: number
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
  if (!DATE_PATTERN.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
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
}): {
  candidates: TriggerDiscoveryFilteredCandidate[]
  counts: Omit<TriggerDiscoveryDiagnostics['counts'], 'evaluated' | 'matched'>
  rejected: Record<TriggerDiscoveryRejectionReason, number>
} {
  const rejected = emptyRejected()
  const selectedMarkets = input.markets == null ? null : new Set(input.markets)
  const marketRows = input.candidates.filter((candidate) => {
    const accepted = selectedMarkets == null || selectedMarkets.has(candidate.market)
    if (!accepted) rejected.MARKET_FILTER += 1
    return accepted
  })
  const freshRows = marketRows.flatMap((candidate): TriggerDiscoveryFilteredCandidate[] => {
    if (candidate.price == null || !candidate.priceDate) {
      rejected.STALE_PRICE += 1
      return []
    }
    const staleness = countSessionsAfter(candidate.priceDate, input.marketSessionsDescending)
    if (staleness > input.maxPriceStalenessSessions) {
      rejected.STALE_PRICE += 1
      return []
    }
    return [{
      ...candidate,
      price: candidate.price,
      priceDate: candidate.priceDate,
      priceStalenessSessions: staleness,
      priceFreshness: staleness === 0 ? 'CURRENT' : 'STALE_ACCEPTED',
      liquidityComplete: candidate.liquidityObservationCount >= input.liquidityLookbackSessions,
    }]
  })
  const priceRows = freshRows.filter((candidate) => {
    const accepted = inInclusiveRange(candidate.price, input.priceMin, input.priceMax)
    if (!accepted) rejected.PRICE_FILTER += 1
    return accepted
  })
  const volumeFilterEnabled = input.averageVolumeMin != null || input.averageVolumeMax != null
  const volumeRows = priceRows.filter((candidate) => {
    const accepted = !volumeFilterEnabled
      || inInclusiveRange(candidate.averageVolume, input.averageVolumeMin, input.averageVolumeMax)
    if (!accepted) rejected.VOLUME_FILTER += 1
    return accepted
  })
  const tradingValueFilterEnabled = input.averageTradingValueMin != null
    || input.averageTradingValueMax != null
  const tradingValueRows = volumeRows.filter((candidate) => {
    const accepted = !tradingValueFilterEnabled
      || inInclusiveRange(candidate.averageTradingValue, input.averageTradingValueMin, input.averageTradingValueMax)
    if (!accepted) rejected.TRADING_VALUE_FILTER += 1
    return accepted
  })
  return {
    candidates: tradingValueRows,
    counts: {
      universe: input.candidates.length,
      afterMarket: marketRows.length,
      afterStalePrice: freshRows.length,
      afterPrice: priceRows.length,
      afterVolume: volumeRows.length,
      afterTradingValue: tradingValueRows.length,
    },
    rejected,
  }
}

function rejectionForTrigger(result: ReturnType<typeof evaluateMaZoneTrigger>): TriggerDiscoveryRejectionReason {
  if (result.availability !== 'available') return 'INSUFFICIENT_HISTORY'
  if (!result.bothRising) return 'MA_NOT_BOTH_RISING'
  if (!result.fromAbove) return 'NOT_FROM_ABOVE'
  if (result.approachDirection !== 'TOWARD_ZONE' && result.status !== 'IN_ZONE') return 'NOT_APPROACHING'
  return 'TOO_FAR'
}

function statusOrder(status: TriggerStatus): number {
  if (status === 'IN_ZONE') return 0
  if (status === 'NEAR') return 1
  if (status === 'APPROACHING') return 2
  return 3
}

function numericSortValue(row: TriggerDiscoveryRow, key: TriggerDiscoverySortKey): number | string {
  switch (key) {
    case 'ticker': return row.ticker
    case 'price': return row.price
    case 'zoneDistance': return Math.abs(row.zoneDistancePct)
    case 'ma1Distance': return Math.abs(row.ma1DistancePct)
    case 'ma2Distance': return Math.abs(row.ma2DistancePct)
    case 'averageVolume': return row.averageVolume ?? Number.POSITIVE_INFINITY
    case 'averageTradingValue': return row.averageTradingValue ?? Number.POSITIVE_INFINITY
    case 'approachVelocity': return row.approachVelocityPctPointsPerSession
  }
}

function sortRows(
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
    const compared = typeof leftValue === 'string' && typeof rightValue === 'string'
      ? leftValue.localeCompare(rightValue)
      : Number(leftValue) - Number(rightValue)
    return compared === 0
      ? left.ticker.localeCompare(right.ticker)
      : compared * (direction === 'desc' ? -1 : 1)
  })
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

    async loadStoredMaObservations({ candidates, ma1Period, ma2Period, oldestObservationDate }) {
      if (candidates.length === 0) return { value: new Map(), queryCount: 0, queryMs: 0 }
      const candidateByTicker = new Map(candidates.map((candidate) => [candidate.ticker, candidate]))
      const newestObservationDate = candidates.reduce(
        (newest, candidate) => candidate.priceDate > newest ? candidate.priceDate : newest,
        candidates[0].priceDate,
      )
      const queryStartedAt = performance.now()
      const rows = await execAll<StoredMaSqlRow>(`
        SELECT monitor.ticker, monitor.period, monitor.date, monitor.close, monitor.ma_value
        FROM monthly_ma_monitor_daily AS monitor
        WHERE monitor.period IN (?, ?)
          AND monitor.date BETWEEN ? AND ?
        ORDER BY monitor.ticker, monitor.date, monitor.period
      `, [ma1Period, ma2Period, oldestObservationDate, newestObservationDate])
      const queryMs = elapsedMs(queryStartedAt)
      const preparationStartedAt = performance.now()
      const paired = new Map<string, Map<string, { price: number; ma1?: number; ma2?: number }>>()
      for (const row of rows) {
        const candidate = candidateByTicker.get(row.ticker)
        if (!candidate || row.date > candidate.priceDate) continue
        const byDate = paired.get(row.ticker) ?? new Map()
        const point = byDate.get(row.date) ?? { price: Number(row.close) }
        if (Number(row.period) === ma1Period) point.ma1 = Number(row.ma_value)
        if (Number(row.period) === ma2Period) point.ma2 = Number(row.ma_value)
        byDate.set(row.date, point)
        paired.set(row.ticker, byDate)
      }
      const value = new Map<string, MaZoneTriggerObservation[]>()
      for (const [ticker, byDate] of paired) {
        value.set(ticker, [...byDate.entries()].flatMap(([date, point]) => (
          point.ma1 == null || point.ma2 == null
            ? []
            : [{ date, price: point.price, ma1: point.ma1, ma2: point.ma2 }]
        )))
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
          WHERE month_rank = 1 OR recent_rank <= ?
          ORDER BY ticker, date
        `, [...cte.args, historyStart, requiredObservations, requiredObservations])
      } else {
        rows = await execAll<GenericMaSqlRow>(`
          WITH month_ends AS (
            SELECT ticker, substr(date, 1, 7) AS month_key, MAX(date) AS date
            FROM ohlcv_daily
            WHERE date BETWEEN ? AND ?
            GROUP BY ticker, month_key
          )
          SELECT o.ticker, o.date, o.open, o.high, o.low, o.close, o.volume, 0 AS is_recent
          FROM month_ends
          INNER JOIN ohlcv_daily AS o
            ON o.ticker = month_ends.ticker AND o.date = month_ends.date
          UNION ALL
          SELECT o.ticker, o.date, o.open, o.high, o.low, o.close, o.volume, 1 AS is_recent
          FROM ohlcv_daily AS o
          WHERE o.date BETWEEN ? AND ?
          ORDER BY ticker, date, is_recent
        `, [historyStart, newestPriceDate, recentStart, newestPriceDate])
      }
      const queryMs = elapsedMs(queryStartedAt)
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

  const requiredObservations = Math.max(
    triggerConfig.slopeLookbackSessions,
    triggerConfig.approachLookbackSessions,
  ) + 1
  const sessionLimit = Math.max(requiredObservations, liquidityLookbackSessions)
    + maxPriceStalenessSessions + 5
  const dataSource = options.dataSource ?? createTriggerDiscoverySqlDataSource()
  let queryCount = 0
  let dbQueryMs = 0
  let maPreparationMs = 0
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
      totalMatched: 0,
      rows: [],
      limit,
      offset,
      hasMore: false,
      diagnostics: {
        counts: { universe: 0, afterMarket: 0, afterStalePrice: 0, afterPrice: 0, afterVolume: 0, afterTradingValue: 0, evaluated: 0, matched: 0 },
        rejected,
        performance: { queryCount, dbQueryMs, maPreparationMs: 0, engineEvaluationMs: 0, totalMs: elapsedMs(totalStartedAt), fastPathEvaluated: 0, genericPathEvaluated: 0 },
      },
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
  })
  Object.assign(rejected, filtered.rejected)

  const observations = new Map<string, { rows: MaZoneTriggerObservation[]; path: TriggerDiscoveryMaPath }>()
  const storedPeriods = new Set<number>(MONTHLY_MA_MONITOR_PERIODS)
  const canUseFastPath = storedPeriods.has(triggerConfig.ma1Period)
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
    const genericLoad = await dataSource.loadGenericMaObservations({
      candidates: genericCandidates,
      ma1Period: triggerConfig.ma1Period,
      ma2Period: triggerConfig.ma2Period,
      requiredObservations,
    })
    queryCount += genericLoad.queryCount
    dbQueryMs += genericLoad.queryMs
    maPreparationMs += genericLoad.preparationMs ?? 0
    for (const candidate of genericCandidates) {
      observations.set(candidate.ticker, {
        rows: genericLoad.value.get(candidate.ticker) ?? [],
        path: 'generic',
      })
    }
  }

  const engineStartedAt = performance.now()
  const matchedRows: TriggerDiscoveryRow[] = []
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
    if (!trigger.matched || !trigger.snapshot || !trigger.observationDate
      || !trigger.ma1Trend || !trigger.ma2Trend || !trigger.approachDirection
      || trigger.approachVelocityPctPointsPerSession == null) {
      rejected[rejectionForTrigger(trigger)] += 1
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
      bothRising: trigger.bothRising,
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
  const sorted = sortRows(matchedRows, input.sortBy, input.sortDirection)
  const rows = sorted.slice(offset, offset + limit)
  return {
    contractVersion: 'trigger-discovery-v1',
    requestedAsOf: input.asOf,
    resolvedAsOf,
    triggerConfig,
    liquidityLookbackSessions,
    maxPriceStalenessSessions,
    totalMatched: sorted.length,
    rows,
    limit,
    offset,
    hasMore: offset + rows.length < sorted.length,
    diagnostics: {
      counts: {
        ...filtered.counts,
        evaluated: filtered.candidates.length,
        matched: sorted.length,
      },
      rejected,
      performance: {
        queryCount,
        dbQueryMs,
        maPreparationMs,
        engineEvaluationMs,
        totalMs: elapsedMs(totalStartedAt),
        fastPathEvaluated,
        genericPathEvaluated,
      },
    },
  }
}
