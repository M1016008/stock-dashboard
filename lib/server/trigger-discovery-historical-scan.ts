import { execAll } from '@/lib/db/client'
import { isHistoricalUniverseMemberAt } from '@/lib/historical-universe'
import {
  buildContinuousMonthlyMaSeries,
  daysBetween,
  splitContinuousHistory,
} from '@/lib/snapshots/continuous-ma'
import {
  attachTriggerDiscoveryStage,
  filterTriggerDiscoveryCandidates,
  filterTriggerDiscoveryRowsByStage,
  type TriggerDiscoveryCandidateSnapshot,
  type TriggerDiscoveryInput,
  type TriggerDiscoveryRow,
  type TriggerDiscoveryStageSnapshot,
} from '@/lib/server/trigger-discovery-read-model'
import type {
  TriggerHistoricalScanCandidateSnapshot,
  TriggerHistoricalScanDailyCount,
  TriggerHistoricalScanEvent,
  TriggerHistoricalScanPerformance,
  TriggerHistoricalScanResponse,
} from '@/lib/trigger-discovery-historical-scan-contract'
import {
  TRIGGER_DISCOVERY_HISTORICAL_SCAN_CONTRACT_VERSION,
} from '@/lib/trigger-discovery-historical-scan-contract'
import {
  DEFAULT_MA_ZONE_TRIGGER_CONFIG,
  evaluateMaZoneTrigger,
  requiredMaZoneTriggerObservations,
  type MaZoneTriggerConfig,
  type MaZoneTriggerObservation,
} from '@/lib/trigger-discovery-engine'
import {
  attachBiweeklyMovingAverages,
  buildBiweeklyBarsFromWeekly,
  type TriggerDiscoveryTimeframe,
} from '@/lib/trigger-discovery-timeframe'
import { calculateTriggerScore } from '@/lib/trigger-score'
import { calendarWeekBucket, calendarWeekStart } from '@/lib/timeframes'
import type { OHLCV } from '@/types/stock'

const MONTHLY_HISTORY_BUFFER_DAYS = 160
const BIWEEKLY_HISTORY_BUFFER_WEEKS = 10
export const MAX_HISTORICAL_SCAN_TRADING_DAYS = 520

type UniverseSqlRow = {
  ticker: string
  company_name: string | null
  market: string | null
  current_active: number
  historical_record_exists: number
  first_trade_date: string | null
  last_trade_date: string | null
  ledger_through: string | null
}

type DailySqlRow = {
  ticker: string
  date: string
  close: number
  volume: number
  is_full_daily: number
}

type StoredMonthlySqlRow = {
  ticker: string
  date: string
  close: number
  ma1: number
  ma2: number
}

type WeeklySqlRow = OHLCV & {
  ticker: string
  week_start_date: string
}

type StageSqlRow = {
  ticker: string
  date: string
  daily_a_stage: number | null
  daily_b_stage: number | null
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
}

type CoreRow = Omit<TriggerDiscoveryRow,
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

type DailySeries = {
  rows: OHLCV[]
  volumePrefix: number[]
  tradingValuePrefix: number[]
}

type BiweeklySegment = {
  weeklyDates: Array<{ date: string; weekStartDate: string }>
  points: Array<MaZoneTriggerObservation & { bucket: number; barIndex: number }>
  bars: Array<OHLCV & { bucket: number }>
  closesPrefix: number[]
}

type BiweeklyTickerSeries = {
  segments: BiweeklySegment[]
}

export interface TriggerHistoricalScanOptions {
  signal?: AbortSignal
  onDay?: (date: string, rows: TriggerDiscoveryRow[]) => void | Promise<void>
  onEvents?: (date: string, events: TriggerHistoricalScanEvent[]) => void | Promise<void>
  onProgress?: (progress: {
    processedTradingDays: number
    totalTradingDays: number
  }) => void | Promise<void>
}

function elapsedMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 1000) / 1000
}

function dateDaysBefore(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() - days)
  return value.toISOString().slice(0, 10)
}

function lowerBound<T>(rows: T[], value: string, dateOf: (row: T) => string): number {
  let low = 0
  let high = rows.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (dateOf(rows[middle]) < value) low = middle + 1
    else high = middle
  }
  return low
}

function upperBound<T>(rows: T[], value: string, dateOf: (row: T) => string): number {
  let low = 0
  let high = rows.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (dateOf(rows[middle]) <= value) low = middle + 1
    else high = middle
  }
  return low
}

function lowerBoundNumber<T>(rows: T[], value: number, numberOf: (row: T) => number): number {
  let low = 0
  let high = rows.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (numberOf(rows[middle]) < value) low = middle + 1
    else high = middle
  }
  return low
}

function rounded(value: number): number {
  return Math.round(value * 1_000) / 1_000
}

function stageNumber(value: number | null): number | null {
  const parsed = value == null ? null : Number(value)
  return parsed != null && Number.isInteger(parsed) && parsed >= 1 && parsed <= 6
    ? parsed
    : null
}

function measureMemory(current: { heap: number; rss: number }): void {
  const memory = process.memoryUsage()
  current.heap = Math.max(current.heap, memory.heapUsed)
  current.rss = Math.max(current.rss, memory.rss)
}

function abortIfRequested(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Historical scan aborted', 'AbortError')
}

function groupDailyRows(rows: DailySqlRow[], includeSource: boolean): {
  sourceByTicker: Map<string, OHLCV[]>
  dailyByTicker: Map<string, DailySeries>
} {
  const sourceByTicker = new Map<string, OHLCV[]>()
  const fullDaily = new Map<string, OHLCV[]>()
  for (const row of rows) {
    const point: OHLCV = {
      date: row.date,
      open: Number(row.close),
      high: Number(row.close),
      low: Number(row.close),
      close: Number(row.close),
      volume: Number(row.volume),
    }
    if (includeSource) {
      const source = sourceByTicker.get(row.ticker) ?? []
      source.push(point)
      sourceByTicker.set(row.ticker, source)
    }
    if (Number(row.is_full_daily) === 1) {
      const daily = fullDaily.get(row.ticker) ?? []
      daily.push(point)
      fullDaily.set(row.ticker, daily)
    }
  }
  const dailyByTicker = new Map<string, DailySeries>()
  for (const [ticker, tickerRows] of fullDaily) {
    tickerRows.sort((left, right) => left.date.localeCompare(right.date))
    const volumePrefix = [0]
    const tradingValuePrefix = [0]
    for (const row of tickerRows) {
      volumePrefix.push(volumePrefix.at(-1)! + row.volume)
      tradingValuePrefix.push(tradingValuePrefix.at(-1)! + row.close * row.volume)
    }
    dailyByTicker.set(ticker, { rows: tickerRows, volumePrefix, tradingValuePrefix })
  }
  for (const rowsForTicker of sourceByTicker.values()) {
    rowsForTicker.sort((left, right) => left.date.localeCompare(right.date))
  }
  return { sourceByTicker, dailyByTicker }
}

function buildMonthlyObservations(
  sourceByTicker: Map<string, OHLCV[]>,
  dailyStart: string,
  config: MaZoneTriggerConfig,
  earlierDailyStarts: Map<string, string> = new Map(),
): Map<string, MaZoneTriggerObservation[]> {
  const result = new Map<string, MaZoneTriggerObservation[]>()
  for (const [ticker, rows] of sourceByTicker) {
    const points = buildContinuousMonthlyMaSeries(
      rows,
      [config.ma1Period, config.ma2Period],
      { adjustSplits: false },
    ).flatMap((point, barIndex) => {
      if (point.date < (earlierDailyStarts.get(ticker) ?? dailyStart)) return []
      const ma1 = point.values.get(config.ma1Period)
      const ma2 = point.values.get(config.ma2Period)
      return ma1 == null || ma2 == null
        ? []
        : [{ date: point.date, price: point.close, ma1, ma2 }]
    })
    result.set(ticker, points)
  }
  return result
}

function groupStoredMonthlyRows(rows: StoredMonthlySqlRow[]): Map<string, MaZoneTriggerObservation[]> {
  const result = new Map<string, MaZoneTriggerObservation[]>()
  for (const row of rows) {
    const points = result.get(row.ticker) ?? []
    points.push({
      date: row.date,
      price: Number(row.close),
      ma1: Number(row.ma1),
      ma2: Number(row.ma2),
    })
    result.set(row.ticker, points)
  }
  return result
}

export function buildBiweeklySeries(
  rows: WeeklySqlRow[],
  config: MaZoneTriggerConfig,
): BiweeklyTickerSeries {
  const segments = splitContinuousHistory(rows).map((weeklyRows): BiweeklySegment => {
    const bars = buildBiweeklyBarsFromWeekly(weeklyRows).map((row) => ({
      ...row,
      bucket: Math.floor(calendarWeekBucket(row.date) / 2),
    }))
    const points = attachBiweeklyMovingAverages(
      bars,
      [config.ma1Period, config.ma2Period],
      weeklyRows[0]?.date ?? '',
    ).flatMap((point, barIndex) => {
      const ma1 = point.values.get(config.ma1Period)
      const ma2 = point.values.get(config.ma2Period)
      return ma1 == null || ma2 == null
        ? []
        : [{
            date: point.date,
            price: point.close,
            ma1,
            ma2,
            bucket: Math.floor(calendarWeekBucket(point.date) / 2),
            barIndex,
          }]
    })
    const closesPrefix = [0]
    for (const point of bars) closesPrefix.push(closesPrefix.at(-1)! + point.close)
    return {
      weeklyDates: weeklyRows.map((row) => ({
        date: row.date,
        weekStartDate: row.week_start_date,
      })),
      points,
      bars,
      closesPrefix,
    }
  })
  return { segments }
}

export function currentBiweeklyObservations(
  prepared: BiweeklyTickerSeries | undefined,
  priceDate: string,
  price: number,
  config: MaZoneTriggerConfig,
  requiredObservations: number,
  historyCutoff: string,
): MaZoneTriggerObservation[] {
  if (!prepared) return []
  const currentWeekStart = calendarWeekStart(priceDate)
  const currentBucket = Math.floor(calendarWeekBucket(priceDate) / 2)
  let selected: BiweeklySegment | null = null
  let priorWeeklyDate: string | null = null
  for (const segment of prepared.segments) {
    const end = lowerBound(segment.weeklyDates, currentWeekStart, (row) => row.weekStartDate) - 1
    if (end < 0) continue
    const date = segment.weeklyDates[end].date
    if (priorWeeklyDate == null || date > priorWeeklyDate) {
      selected = segment
      priorWeeklyDate = date
    }
  }
  if (priorWeeklyDate && daysBetween(priorWeeklyDate, priceDate) > 60) selected = null

  const firstEligibleBar = selected
    ? lowerBound(selected.bars, historyCutoff, (row) => row.date)
    : 0
  const priorPoints = selected
    ? selected.points.filter((row) => row.bucket < currentBucket
      && row.barIndex >= firstEligibleBar + Math.max(config.ma1Period, config.ma2Period) - 1)
    : []
  const currentMa = (period: number): number | null => {
    if (!selected) return period === 1 ? price : null
    const end = lowerBoundNumber(selected.bars, currentBucket, (row) => row.bucket)
    if (end - firstEligibleBar < period - 1) return null
    const completedSum = selected.closesPrefix[end]
      - selected.closesPrefix[end - (period - 1)]
    return (completedSum + price) / period
  }
  const ma1 = currentMa(config.ma1Period)
  const ma2 = currentMa(config.ma2Period)
  const current = ma1 == null || ma2 == null
    ? []
    : [{ date: priceDate, price, ma1, ma2 }]
  return [...priorPoints, ...current].slice(-requiredObservations)
}

function observationSlice(
  rows: MaZoneTriggerObservation[] | undefined,
  oldestDate: string,
  priceDate: string,
  requiredObservations: number,
): MaZoneTriggerObservation[] {
  if (!rows?.length) return []
  const start = lowerBound(rows, oldestDate, (row) => row.date)
  const end = upperBound(rows, priceDate, (row) => row.date)
  return rows.slice(Math.max(start, end - requiredObservations), end)
}

function candidateSnapshot(
  universe: UniverseSqlRow,
  day: string,
  oldestSessionDate: string,
  liquidityLookbackSessions: number,
  daily: DailySeries | undefined,
): TriggerDiscoveryCandidateSnapshot | null {
  const priceEnd = daily ? upperBound(daily.rows, day, (row) => row.date) : 0
  const latest = priceEnd > 0 ? daily!.rows[priceEnd - 1] : null
  const member = Number(universe.historical_record_exists) === 1
    ? isHistoricalUniverseMemberAt({
        asOf: day,
        currentActive: Number(universe.current_active) === 1,
        historicalRecordExists: true,
        firstTradeDate: universe.first_trade_date,
        lastTradeDate: universe.last_trade_date,
        ledgerThrough: universe.ledger_through,
      })
    : latest?.date === day
  if (!member) return null
  if (!daily || !latest || latest.date < oldestSessionDate) {
    return {
      ticker: universe.ticker,
      companyName: universe.company_name?.trim() || universe.ticker,
      market: universe.market,
      priceDate: null,
      price: null,
      averageVolume: null,
      averageTradingValue: null,
      liquidityObservationCount: 0,
    }
  }
  const boundedStart = lowerBound(daily.rows, oldestSessionDate, (row) => row.date)
  const available = priceEnd - boundedStart
  const observationCount = Math.min(liquidityLookbackSessions, Math.max(0, available))
  const averageStart = priceEnd - observationCount
  const averageVolume = observationCount > 0
    ? (daily.volumePrefix[priceEnd] - daily.volumePrefix[averageStart]) / observationCount
    : null
  const averageTradingValue = observationCount > 0
    ? (daily.tradingValuePrefix[priceEnd] - daily.tradingValuePrefix[averageStart]) / observationCount
    : null
  return {
    ticker: universe.ticker,
    companyName: universe.company_name?.trim() || universe.ticker,
    market: universe.market,
    priceDate: latest.date,
    price: latest.close,
    averageVolume,
    averageTradingValue,
    liquidityObservationCount: observationCount,
  }
}

export function historicalSnapshot(row: TriggerDiscoveryRow): TriggerHistoricalScanCandidateSnapshot {
  return {
    ticker: row.ticker,
    companyName: row.companyName,
    market: row.market,
    triggerStatus: row.triggerStatus,
    triggerScore: row.triggerScore,
    scoreBreakdown: row.scoreBreakdown,
    price: row.price,
    ma1: row.ma1Value,
    ma2: row.ma2Value,
    zoneDistancePct: row.zoneDistancePct,
    maSpreadPct: row.maSpreadPct,
    maSpreadSlope: row.maSpreadSlope,
    maSpreadExpansionRatio: row.maSpreadExpansionRatio,
    spreadExpansionPass: row.maSpreadExpanding,
    spreadExpansionAvailable: row.spreadExpansionAvailable,
    bullishMaOrder: row.bullishMaOrder,
    priceDate: row.priceDate,
    maDate: row.maDate,
    stageDate: row.stageDate,
    dayAStage: row.dayAStage,
    dayBStage: row.dayBStage,
    weekAStage: row.weekAStage,
    weekBStage: row.weekBStage,
    monthAStage: row.monthAStage,
    monthBStage: row.monthBStage,
  }
}

export function deriveHistoricalScanEvents(input: {
  date: string
  previous: ReadonlyMap<string, TriggerHistoricalScanCandidateSnapshot> | null
  current: ReadonlyMap<string, TriggerHistoricalScanCandidateSnapshot>
  seen: Set<string>
}): TriggerHistoricalScanEvent[] {
  if (input.previous == null) {
    for (const ticker of input.current.keys()) input.seen.add(ticker)
    return []
  }
  const events: TriggerHistoricalScanEvent[] = []
  const emit = (
    eventType: TriggerHistoricalScanEvent['eventType'],
    snapshot: TriggerHistoricalScanCandidateSnapshot,
    previousStatus: TriggerHistoricalScanEvent['previousStatus'],
    currentStatus: TriggerHistoricalScanEvent['currentStatus'],
    snapshotBasis: TriggerHistoricalScanEvent['snapshotBasis'],
  ) => events.push({
    date: input.date,
    ticker: snapshot.ticker,
    companyName: snapshot.companyName,
    eventType,
    previousStatus,
    currentStatus,
    snapshotBasis,
    price: snapshot.price,
    ma1: snapshot.ma1,
    ma2: snapshot.ma2,
    zoneDistancePct: snapshot.zoneDistancePct,
    maSpreadPct: snapshot.maSpreadPct,
    maSpreadSlope: snapshot.maSpreadSlope,
    maSpreadExpansionRatio: snapshot.maSpreadExpansionRatio,
    spreadExpansionPass: snapshot.spreadExpansionPass,
    spreadExpansionAvailable: snapshot.spreadExpansionAvailable,
    bullishMaOrder: snapshot.bullishMaOrder,
    spreadDiagnosticDate: snapshot.maDate,
    triggerScore: snapshot.triggerScore,
    scoreBreakdown: snapshot.scoreBreakdown,
    priceDate: snapshot.priceDate,
    maDate: snapshot.maDate,
    stageDate: snapshot.stageDate,
    dayAStage: snapshot.dayAStage,
    dayBStage: snapshot.dayBStage,
    weekAStage: snapshot.weekAStage,
    weekBStage: snapshot.weekBStage,
    monthAStage: snapshot.monthAStage,
    monthBStage: snapshot.monthBStage,
  })

  for (const [ticker, current] of input.current) {
    const previous = input.previous.get(ticker)
    if (!previous) {
      emit(input.seen.has(ticker) ? 'RE_ENTRY' : 'ENTERED', current, null, current.triggerStatus, 'CURRENT')
      input.seen.add(ticker)
    } else if (previous.triggerStatus !== current.triggerStatus) {
      emit('STATUS_CHANGED', current, previous.triggerStatus, current.triggerStatus, 'CURRENT')
    }
  }
  for (const [ticker, previous] of input.previous) {
    if (!input.current.has(ticker)) emit('EXITED', previous, previous.triggerStatus, null, 'PREVIOUS')
  }
  return events.sort((left, right) => left.ticker.localeCompare(right.ticker)
    || left.eventType.localeCompare(right.eventType))
}

function emptyResponse(input: {
  requestedStartDate: string
  requestedEndDate: string
  timeframe: TriggerDiscoveryTimeframe
  config: MaZoneTriggerConfig
  criteria: Omit<TriggerDiscoveryInput, 'asOf'>
  eventOffset: number
  eventLimit: number
  performance: TriggerHistoricalScanPerformance
}): TriggerHistoricalScanResponse {
  return {
    contractVersion: TRIGGER_DISCOVERY_HISTORICAL_SCAN_CONTRACT_VERSION,
    scanMeta: {
      requestedStartDate: input.requestedStartDate,
      resolvedStartDate: null,
      requestedEndDate: input.requestedEndDate,
      resolvedEndDate: null,
      tradingDayCount: 0,
      processedTradingDays: 0,
      timeframe: input.timeframe,
      ma1Period: input.config.ma1Period,
      ma2Period: input.config.ma2Period,
      sampling: 'EACH_MARKET_TRADING_DAY',
      baselineDate: null,
      baselineCandidateCount: 0,
      universeContract: 'reconstructed_from_currently_held_trade_history',
      universeNote: '現在保持している全取引履歴から、各基準日の上場期間を復元しています。',
    },
    criteria: {
      maxApproachDistancePct: input.config.maxApproachDistancePct,
      nearDistancePct: input.config.nearDistancePct,
      spreadExpansionEnabled: input.config.spreadExpansionEnabled,
      spreadLookbackIntervals: input.config.spreadLookbackIntervals,
      minExpansionRatio: input.config.minExpansionRatio,
      requireBullishMaOrder: input.config.requireBullishMaOrder,
      belowZoneToleranceEnabled: input.config.belowZoneToleranceEnabled,
      maxBelowZonePct: input.config.maxBelowZonePct,
      liquidityLookbackSessions: input.criteria.liquidityLookbackSessions ?? 20,
      maxPriceStalenessSessions: input.criteria.maxPriceStalenessSessions ?? 3,
      markets: input.criteria.markets ?? null,
      priceMin: input.criteria.priceMin ?? null,
      priceMax: input.criteria.priceMax ?? null,
      averageVolumeMin: input.criteria.averageVolumeMin ?? null,
      averageVolumeMax: input.criteria.averageVolumeMax ?? null,
      averageTradingValueMin: input.criteria.averageTradingValueMin ?? null,
      averageTradingValueMax: input.criteria.averageTradingValueMax ?? null,
      stageFilters: input.criteria.stageFilters ?? {},
    },
    summary: {
      tradingDays: 0,
      uniqueCandidateCount: 0,
      enteredCount: 0,
      reEntryCount: 0,
      statusChangeCount: 0,
      exitedCount: 0,
      totalEventCount: 0,
      maxDailyCandidates: 0,
      averageDailyCandidates: 0,
    },
    dailyCounts: [],
    events: [],
    eventPage: {
      offset: input.eventOffset,
      limit: input.eventLimit,
      returnedCount: 0,
      totalCount: 0,
      hasMore: false,
    },
    performance: input.performance,
  }
}

export async function getTriggerHistoricalScan(input: {
  requestedStartDate: string
  requestedEndDate: string
  timeframe: TriggerDiscoveryTimeframe
  criteria: Omit<TriggerDiscoveryInput, 'asOf' | 'limit' | 'offset' | 'sortBy' | 'sortDirection'>
  eventOffset: number
  eventLimit: number
}, options: TriggerHistoricalScanOptions = {}): Promise<TriggerHistoricalScanResponse> {
  const totalStartedAt = performance.now()
  const initialMemory = process.memoryUsage().heapUsed
  const memory = { heap: initialMemory, rss: process.memoryUsage().rss }
  let queryCount = 0
  const sqlMs = {
    marketSessions: 0,
    universe: 0,
    ohlcv: 0,
    storedMonthlyMa: 0,
    weeklyOhlcv: 0,
    stage: 0,
    total: 0,
  }
  let sourceOhlcvRows = 0
  let sourceStoredRows = 0
  let sourceWeeklyRows = 0
  let sourceStageRows = 0
  let seriesBuildMs = 0
  let maPreparationMs = 0
  let liquidityMs = 0
  let universeFilterMs = 0
  let triggerEngineMs = 0
  let stageJoinMs = 0
  let scoreMs = 0
  let eventDerivationMs = 0
  const config: MaZoneTriggerConfig = {
    ...DEFAULT_MA_ZONE_TRIGGER_CONFIG,
    ...input.criteria.triggerConfig,
  }
  const requiredObservations = requiredMaZoneTriggerObservations(config)
  const liquidityLookbackSessions = input.criteria.liquidityLookbackSessions ?? 20
  const maxPriceStalenessSessions = input.criteria.maxPriceStalenessSessions ?? 3

  abortIfRequested(options.signal)
  let queryStartedAt = performance.now()
  const marketSessions = (await execAll<{ date: string }>(`
    SELECT DISTINCT date FROM ohlcv_daily
    WHERE date <= ?
    ORDER BY date
  `, [input.requestedEndDate])).map((row) => row.date)
  sqlMs.marketSessions = elapsedMs(queryStartedAt)
  queryCount += 1
  const scanDates = marketSessions.filter((date) => date >= input.requestedStartDate
    && date <= input.requestedEndDate)
  await options.onProgress?.({ processedTradingDays: 0, totalTradingDays: scanDates.length })
  const basePerformance = (): TriggerHistoricalScanPerformance => ({
    totalMs: elapsedMs(totalStartedAt),
    queryCount,
    tradingDays: scanDates.length,
    sourceTickerCount: 0,
    sourceRows: { ohlcv: sourceOhlcvRows, storedMonthlyMa: sourceStoredRows, weeklyOhlcv: sourceWeeklyRows, stage: sourceStageRows },
    sqlMs: { ...sqlMs, total: rounded(Object.entries(sqlMs).filter(([key]) => key !== 'total').reduce((sum, [, value]) => sum + value, 0)) },
    seriesBuildMs,
    maPreparationMs,
    liquidityMs,
    universeFilterMs,
    triggerEngineMs,
    stageJoinMs,
    scoreMs,
    eventDerivationMs,
    peakHeapBytes: memory.heap,
    peakRssBytes: memory.rss,
    heapDeltaBytes: memory.heap - initialMemory,
  })
  if (scanDates.length === 0) {
    return emptyResponse({
      requestedStartDate: input.requestedStartDate,
      requestedEndDate: input.requestedEndDate,
      timeframe: input.timeframe,
      config,
      criteria: input.criteria,
      eventOffset: input.eventOffset,
      eventLimit: input.eventLimit,
      performance: basePerformance(),
    })
  }
  if (scanDates.length > MAX_HISTORICAL_SCAN_TRADING_DAYS) {
    throw new RangeError(`historical scan supports at most ${MAX_HISTORICAL_SCAN_TRADING_DAYS} trading days`)
  }
  const resolvedStartDate = scanDates[0]
  const resolvedEndDate = scanDates.at(-1)!
  const startSessionIndex = marketSessions.indexOf(resolvedStartDate)
  const sessionLimit = Math.max(requiredObservations, liquidityLookbackSessions)
    + maxPriceStalenessSessions + 5
  const candidateWindowStart = marketSessions[Math.max(0, startSessionIndex - sessionLimit + 1)]
  const genericObservationStart = dateDaysBefore(
    candidateWindowStart,
    requiredObservations * 4 + 30,
  )
  const dailyStart = input.timeframe === 'MONTHLY'
    ? genericObservationStart
    : calendarWeekStart(candidateWindowStart)
  const historyStart = dateDaysBefore(
    candidateWindowStart,
    Math.max(config.ma1Period, config.ma2Period) * 31 + MONTHLY_HISTORY_BUFFER_DAYS,
  )

  abortIfRequested(options.signal)
  queryStartedAt = performance.now()
  const universeRows = await execAll<UniverseSqlRow>(`
    WITH universe_keys AS (
      SELECT ticker FROM historical_universe
      UNION
      SELECT ticker FROM ticker_universe
    )
    SELECT keys.ticker,
           COALESCE(hu.name, tu.name, keys.ticker) AS company_name,
           COALESCE(hu.market_segment, tu.market_segment) AS market,
           COALESCE(tu.active, 0) AS current_active,
           CASE WHEN hu.ticker IS NULL THEN 0 ELSE 1 END AS historical_record_exists,
           hu.first_trade_date,
           hu.last_trade_date,
           hu.latest_ohlcv_date AS ledger_through
    FROM universe_keys AS keys
    LEFT JOIN historical_universe AS hu ON hu.ticker = keys.ticker
    LEFT JOIN ticker_universe AS tu ON tu.ticker = keys.ticker
    ORDER BY keys.ticker
  `)
  sqlMs.universe = elapsedMs(queryStartedAt)
  queryCount += 1

  queryStartedAt = performance.now()
  const dailySqlRows = input.timeframe === 'MONTHLY'
    ? await execAll<DailySqlRow>(`
        WITH month_edges AS (
          SELECT ticker, substr(date, 1, 7) AS month_key,
                 MIN(date) AS first_date, MAX(date) AS last_date
          FROM ohlcv_daily
          WHERE date >= ? AND date < ?
          GROUP BY ticker, month_key
        )
        SELECT o.ticker, o.date, o.close, o.volume, 0 AS is_full_daily
        FROM month_edges
        INNER JOIN ohlcv_daily AS o ON o.ticker=month_edges.ticker
          AND o.date IN (month_edges.first_date, month_edges.last_date)
        UNION ALL
        SELECT ticker, date, close, volume, 1 AS is_full_daily
        FROM ohlcv_daily
        WHERE date BETWEEN ? AND ?
        ORDER BY ticker, date
      `, [historyStart, dailyStart, dailyStart, resolvedEndDate])
    : await execAll<DailySqlRow>(`
        SELECT ticker, date, close, volume, 1 AS is_full_daily
        FROM ohlcv_daily
        WHERE date BETWEEN ? AND ?
        ORDER BY ticker, date
      `, [dailyStart, resolvedEndDate])
  sqlMs.ohlcv = elapsedMs(queryStartedAt)
  queryCount += 1
  sourceOhlcvRows = dailySqlRows.length
  measureMemory(memory)

  const groupStartedAt = performance.now()
  const { sourceByTicker, dailyByTicker } = groupDailyRows(
    dailySqlRows,
    input.timeframe === 'MONTHLY',
  )
  dailySqlRows.length = 0
  seriesBuildMs += elapsedMs(groupStartedAt)
  let monthlyObservations = new Map<string, MaZoneTriggerObservation[]>()
  let storedMonthlyObservations = new Map<string, MaZoneTriggerObservation[]>()
  let biweeklyByTicker = new Map<string, BiweeklyTickerSeries>()
  if (input.timeframe === 'MONTHLY') {
    const earlierDailyStarts = new Map<string, string>()
    const sparse = [...sourceByTicker.keys()].filter((ticker) => {
      const daily = dailyByTicker.get(ticker)?.rows ?? []
      return upperBound(daily, resolvedStartDate, (row) => row.date) < requiredObservations
    })
    for (let offset = 0; offset < sparse.length; offset += 250) {
      const tickers = sparse.slice(offset, offset + 250)
      queryStartedAt = performance.now()
      const earlier = await execAll<DailySqlRow>(`
        WITH requested(ticker) AS (VALUES ${tickers.map(() => '(?)').join(', ')}), ranked AS (
          SELECT o.ticker, o.date, o.close, o.volume,
                 ROW_NUMBER() OVER (PARTITION BY o.ticker ORDER BY o.date DESC) AS recent_rank
          FROM ohlcv_daily AS o
          INNER JOIN requested AS r ON r.ticker=o.ticker
          WHERE o.date>=? AND o.date<?
        )
        SELECT ticker, date, close, volume, 0 AS is_full_daily
        FROM ranked WHERE recent_rank<=?
      `, [...tickers, historyStart, dailyStart, requiredObservations])
      sqlMs.ohlcv += elapsedMs(queryStartedAt)
      queryCount += 1
      sourceOhlcvRows += earlier.length
      const earlierByTicker = new Map<string, OHLCV[]>()
      for (const row of earlier) {
        const points = earlierByTicker.get(row.ticker) ?? []
        points.push({
          date: row.date, open: Number(row.close), high: Number(row.close),
          low: Number(row.close), close: Number(row.close), volume: Number(row.volume),
        })
        earlierByTicker.set(row.ticker, points)
      }
      for (const [ticker, points] of earlierByTicker) {
        const first = points.reduce((oldest, point) => point.date < oldest ? point.date : oldest, dailyStart)
        earlierDailyStarts.set(ticker, first)
        const byDate = new Map((sourceByTicker.get(ticker) ?? []).map((row) => [row.date, row]))
        for (const point of points) byDate.set(point.date, point)
        sourceByTicker.set(ticker, [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date)))
      }
    }
    const maStartedAt = performance.now()
    monthlyObservations = buildMonthlyObservations(sourceByTicker, dailyStart, config, earlierDailyStarts)
    maPreparationMs += elapsedMs(maStartedAt)

    queryStartedAt = performance.now()
    const storedRows = await execAll<StoredMonthlySqlRow>(`
      SELECT ma1.ticker, ma1.date, ma1.close, ma1.ma_value AS ma1, ma2.ma_value AS ma2
      FROM monthly_ma_monitor_daily AS ma1
      INNER JOIN monthly_ma_monitor_daily AS ma2
        ON ma2.ticker=ma1.ticker AND ma2.date=ma1.date AND ma2.period=?
      WHERE ma1.period=? AND ma1.date BETWEEN ? AND ?
      ORDER BY ma1.ticker, ma1.date
    `, [config.ma2Period, config.ma1Period, candidateWindowStart, resolvedEndDate])
    sqlMs.storedMonthlyMa = elapsedMs(queryStartedAt)
    queryCount += 1
    sourceStoredRows = storedRows.length
    storedMonthlyObservations = groupStoredMonthlyRows(storedRows)
    storedRows.length = 0
    sourceByTicker.clear()
  } else {
    sourceByTicker.clear()
    const maximumPeriod = Math.max(config.ma1Period, config.ma2Period)
    const requiredBiweeklyBars = maximumPeriod + requiredObservations - 1
    const requiredWeeklyBars = requiredBiweeklyBars * 2 + 1
    const weeklyStart = dateDaysBefore(
      candidateWindowStart,
      (requiredWeeklyBars + BIWEEKLY_HISTORY_BUFFER_WEEKS) * 7,
    )
    queryStartedAt = performance.now()
    const weeklyRows = await execAll<Pick<WeeklySqlRow, 'ticker' | 'date' | 'week_start_date' | 'close'>>(`
      SELECT ticker, date, week_start_date, close
      FROM weekly_ohlcv
      WHERE date BETWEEN ? AND ?
      ORDER BY ticker, date
    `, [weeklyStart, resolvedEndDate])
    sqlMs.weeklyOhlcv = elapsedMs(queryStartedAt)
    queryCount += 1
    sourceWeeklyRows = weeklyRows.length
    const grouped = new Map<string, WeeklySqlRow[]>()
    for (const row of weeklyRows) {
      const rows = grouped.get(row.ticker) ?? []
      const close = Number(row.close)
      rows.push({
        ticker: row.ticker,
        date: row.date,
        week_start_date: row.week_start_date,
        open: close,
        high: close,
        low: close,
        close,
        volume: 0,
      })
      grouped.set(row.ticker, rows)
    }
    const maStartedAt = performance.now()
    for (const [ticker, rows] of grouped) biweeklyByTicker.set(ticker, buildBiweeklySeries(rows, config))
    maPreparationMs += elapsedMs(maStartedAt)
    grouped.clear()
    weeklyRows.length = 0
  }
  measureMemory(memory)

  const marketIndex = new Map(marketSessions.map((date, index) => [date, index]))
  const coreByDate = new Map<string, CoreRow[]>()
  for (let dayOffset = 0; dayOffset < scanDates.length; dayOffset += 1) {
    abortIfRequested(options.signal)
    const day = scanDates[dayOffset]
    const daySessionIndex = marketIndex.get(day)!
    const oldestSessionDate = marketSessions[Math.max(0, daySessionIndex - sessionLimit + 1)]
    const sessionsDescending = marketSessions
      .slice(Math.max(0, daySessionIndex - sessionLimit + 1), daySessionIndex + 1)
      .reverse()

    const liquidityStartedAt = performance.now()
    const snapshots: TriggerDiscoveryCandidateSnapshot[] = []
    for (const universe of universeRows) {
      const snapshot = candidateSnapshot(
        universe,
        day,
        oldestSessionDate,
        liquidityLookbackSessions,
        dailyByTicker.get(universe.ticker),
      )
      if (snapshot) snapshots.push(snapshot)
    }
    liquidityMs += performance.now() - liquidityStartedAt

    const filterStartedAt = performance.now()
    const filtered = filterTriggerDiscoveryCandidates({
      candidates: snapshots,
      marketSessionsDescending: sessionsDescending,
      markets: input.criteria.markets,
      priceMin: input.criteria.priceMin ?? null,
      priceMax: input.criteria.priceMax ?? null,
      averageVolumeMin: input.criteria.averageVolumeMin ?? null,
      averageVolumeMax: input.criteria.averageVolumeMax ?? null,
      averageTradingValueMin: input.criteria.averageTradingValueMin ?? null,
      averageTradingValueMax: input.criteria.averageTradingValueMax ?? null,
      liquidityLookbackSessions,
      maxPriceStalenessSessions,
    })
    universeFilterMs += performance.now() - filterStartedAt

    let storedCoverageExists = false
    if (input.timeframe === 'MONTHLY') {
      storedCoverageExists = filtered.candidates.some((candidate) => observationSlice(
        storedMonthlyObservations.get(candidate.ticker),
        oldestSessionDate,
        candidate.priceDate,
        requiredObservations,
      ).length > 0)
    }
    const oldestFilteredPriceDate = filtered.candidates.reduce<string | null>(
      (oldest, candidate) => oldest == null || candidate.priceDate < oldest ? candidate.priceDate : oldest,
      null,
    )
    const biweeklyHistoryCutoff = oldestFilteredPriceDate == null
      ? day
      : dateDaysBefore(
          oldestFilteredPriceDate,
          ((Math.max(config.ma1Period, config.ma2Period) + requiredObservations - 1) * 2
            + 1 + BIWEEKLY_HISTORY_BUFFER_WEEKS) * 7,
        )
    const rows: CoreRow[] = []
    for (const candidate of filtered.candidates) {
      const maStartedAt = performance.now()
      let observations: MaZoneTriggerObservation[]
      let maPath: CoreRow['maPath'] = 'generic'
      if (input.timeframe === 'BIWEEKLY') {
        observations = currentBiweeklyObservations(
          biweeklyByTicker.get(candidate.ticker),
          candidate.priceDate,
          candidate.price,
          config,
          requiredObservations,
          biweeklyHistoryCutoff,
        )
      } else {
        const stored = observationSlice(
          storedMonthlyObservations.get(candidate.ticker),
          oldestSessionDate,
          candidate.priceDate,
          requiredObservations,
        )
        const latest = stored.at(-1)
        const useGeneric = !storedCoverageExists
          || Boolean(latest && (latest.date !== candidate.priceDate
            || Math.abs(latest.price - candidate.price) > Math.max(1, Math.abs(latest.price), Math.abs(candidate.price)) * 1e-9))
          || Boolean(latest && stored.length < requiredObservations)
        if (useGeneric) {
          observations = observationSlice(
            monthlyObservations.get(candidate.ticker),
            '',
            candidate.priceDate,
            requiredObservations,
          )
        } else {
          observations = stored
          maPath = 'fast'
        }
      }
      maPreparationMs += performance.now() - maStartedAt

      const engineStartedAt = performance.now()
      const trigger = evaluateMaZoneTrigger({ observations, asOf: day, config })
      triggerEngineMs += performance.now() - engineStartedAt
      if (!trigger.matched || !trigger.snapshot || !trigger.observationDate
        || !trigger.ma1Trend || !trigger.ma2Trend || !trigger.approachDirection
        || trigger.approachVelocityPctPointsPerSession == null) continue
      rows.push({
        ticker: candidate.ticker,
        companyName: candidate.companyName,
        market: candidate.market,
        requestedAsOf: day,
        resolvedAsOf: day,
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
        maPath,
      })
    }
    coreByDate.set(day, rows)
    await options.onProgress?.({
      processedTradingDays: Math.min(dayOffset + 1, Math.max(0, scanDates.length - 1)),
      totalTradingDays: scanDates.length,
    })
    if (dayOffset % 20 === 0) measureMemory(memory)
  }
  measureMemory(memory)

  const stageKeys = [...coreByDate].flatMap(([date, rows]) => rows.map((row) => ({ date, ticker: row.ticker })))
  let stageByKey = new Map<string, TriggerDiscoveryStageSnapshot>()
  if (stageKeys.length > 0) {
    queryStartedAt = performance.now()
    const stageRows = await execAll<StageSqlRow>(`
      WITH requested AS (
        SELECT json_extract(value, '$.date') AS date,
               json_extract(value, '$.ticker') AS ticker
        FROM json_each(?)
      )
      SELECT snapshots.ticker, snapshots.date,
             snapshots.daily_a_stage, snapshots.daily_b_stage,
             snapshots.weekly_a_stage, snapshots.weekly_b_stage,
             snapshots.monthly_a_stage, snapshots.monthly_b_stage
      FROM requested
      INNER JOIN daily_snapshots AS snapshots
        ON snapshots.ticker=requested.ticker AND snapshots.date=requested.date
    `, [JSON.stringify(stageKeys)])
    sqlMs.stage = elapsedMs(queryStartedAt)
    queryCount += 1
    sourceStageRows = stageRows.length
    stageByKey = new Map(stageRows.map((row) => [`${row.date}\0${row.ticker}`, {
      ticker: row.ticker,
      date: row.date,
      dayAStage: stageNumber(row.daily_a_stage),
      dayBStage: stageNumber(row.daily_b_stage),
      weekAStage: stageNumber(row.weekly_a_stage),
      weekBStage: stageNumber(row.weekly_b_stage),
      monthAStage: stageNumber(row.monthly_a_stage),
      monthBStage: stageNumber(row.monthly_b_stage),
    }]))
  }
  measureMemory(memory)

  const dailyCounts: TriggerHistoricalScanDailyCount[] = []
  const seen = new Set<string>()
  let previous: Map<string, TriggerHistoricalScanCandidateSnapshot> | null = null
  const pagedEvents: TriggerHistoricalScanEvent[] = []
  let totalEventCount = 0
  let enteredCount = 0
  let reEntryCount = 0
  let statusChangeCount = 0
  let exitedCount = 0
  let baselineCandidateCount = 0
  for (let dayOffset = 0; dayOffset < scanDates.length; dayOffset += 1) {
    abortIfRequested(options.signal)
    const day = scanDates[dayOffset]
    const joinStartedAt = performance.now()
    const attached = (coreByDate.get(day) ?? []).map((row) => attachTriggerDiscoveryStage(
      row,
      stageByKey.get(`${day}\0${row.ticker}`),
    ))
    stageJoinMs += performance.now() - joinStartedAt
    const scoreStartedAt = performance.now()
    const scored: TriggerDiscoveryRow[] = attached.map((row) => {
      const score = calculateTriggerScore({
        triggerStatus: row.triggerStatus,
        fromAbove: row.fromAbove,
        zoneDistancePct: row.zoneDistancePct,
        maxApproachDistancePct: config.maxApproachDistancePct,
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
      return { ...row, triggerScore: score.totalScore, scoreBreakdown: score.scoreBreakdown }
    })
    const finalRows = filterTriggerDiscoveryRowsByStage(scored, input.criteria.stageFilters)
    scoreMs += performance.now() - scoreStartedAt
    await options.onDay?.(day, finalRows)
    const current = new Map(finalRows.map((row) => [row.ticker, historicalSnapshot(row)]))
    if (dayOffset === 0) baselineCandidateCount = current.size
    dailyCounts.push({
      date: day,
      candidateCount: current.size,
      approachingCount: finalRows.filter((row) => row.triggerStatus === 'APPROACHING').length,
      nearCount: finalRows.filter((row) => row.triggerStatus === 'NEAR').length,
      inZoneCount: finalRows.filter((row) => row.triggerStatus === 'IN_ZONE').length,
    })
    const eventStartedAt = performance.now()
    const events = deriveHistoricalScanEvents({ date: day, previous, current, seen })
    eventDerivationMs += performance.now() - eventStartedAt
    await options.onEvents?.(day, events)
    for (const event of events) {
      if (event.eventType === 'ENTERED') enteredCount += 1
      else if (event.eventType === 'RE_ENTRY') reEntryCount += 1
      else if (event.eventType === 'STATUS_CHANGED') statusChangeCount += 1
      else if (event.eventType === 'EXITED') exitedCount += 1
      if (totalEventCount >= input.eventOffset
        && pagedEvents.length < input.eventLimit) pagedEvents.push(event)
      totalEventCount += 1
    }
    previous = current
  }
  await options.onProgress?.({
    processedTradingDays: scanDates.length,
    totalTradingDays: scanDates.length,
  })
  measureMemory(memory)
  const performanceResult = basePerformance()
  performanceResult.totalMs = elapsedMs(totalStartedAt)
  performanceResult.sourceTickerCount = universeRows.length
  performanceResult.sqlMs.total = rounded(
    sqlMs.marketSessions + sqlMs.universe + sqlMs.ohlcv + sqlMs.storedMonthlyMa
      + sqlMs.weeklyOhlcv + sqlMs.stage,
  )
  performanceResult.peakHeapBytes = memory.heap
  performanceResult.peakRssBytes = memory.rss
  performanceResult.heapDeltaBytes = memory.heap - initialMemory
  performanceResult.liquidityMs = rounded(liquidityMs)
  performanceResult.universeFilterMs = rounded(universeFilterMs)
  performanceResult.maPreparationMs = rounded(maPreparationMs)
  performanceResult.triggerEngineMs = rounded(triggerEngineMs)
  performanceResult.stageJoinMs = rounded(stageJoinMs)
  performanceResult.scoreMs = rounded(scoreMs)
  performanceResult.eventDerivationMs = rounded(eventDerivationMs)

  const totalCandidates = dailyCounts.reduce((sum, row) => sum + row.candidateCount, 0)
  return {
    contractVersion: TRIGGER_DISCOVERY_HISTORICAL_SCAN_CONTRACT_VERSION,
    scanMeta: {
      requestedStartDate: input.requestedStartDate,
      resolvedStartDate,
      requestedEndDate: input.requestedEndDate,
      resolvedEndDate,
      tradingDayCount: scanDates.length,
      processedTradingDays: scanDates.length,
      timeframe: input.timeframe,
      ma1Period: config.ma1Period,
      ma2Period: config.ma2Period,
      sampling: 'EACH_MARKET_TRADING_DAY',
      baselineDate: resolvedStartDate,
      baselineCandidateCount,
      universeContract: 'reconstructed_from_currently_held_trade_history',
      universeNote: '現在保持している全取引履歴から、各基準日の上場期間を復元しています。',
    },
    criteria: {
      maxApproachDistancePct: config.maxApproachDistancePct,
      nearDistancePct: config.nearDistancePct,
      spreadExpansionEnabled: config.spreadExpansionEnabled,
      spreadLookbackIntervals: config.spreadLookbackIntervals,
      minExpansionRatio: config.minExpansionRatio,
      requireBullishMaOrder: config.requireBullishMaOrder,
      belowZoneToleranceEnabled: config.belowZoneToleranceEnabled,
      maxBelowZonePct: config.maxBelowZonePct,
      liquidityLookbackSessions,
      maxPriceStalenessSessions,
      markets: input.criteria.markets ?? null,
      priceMin: input.criteria.priceMin ?? null,
      priceMax: input.criteria.priceMax ?? null,
      averageVolumeMin: input.criteria.averageVolumeMin ?? null,
      averageVolumeMax: input.criteria.averageVolumeMax ?? null,
      averageTradingValueMin: input.criteria.averageTradingValueMin ?? null,
      averageTradingValueMax: input.criteria.averageTradingValueMax ?? null,
      stageFilters: input.criteria.stageFilters ?? {},
    },
    summary: {
      tradingDays: scanDates.length,
      uniqueCandidateCount: seen.size,
      enteredCount,
      reEntryCount,
      statusChangeCount,
      exitedCount,
      totalEventCount,
      maxDailyCandidates: Math.max(0, ...dailyCounts.map((row) => row.candidateCount)),
      averageDailyCandidates: scanDates.length ? rounded(totalCandidates / scanDates.length) : 0,
    },
    dailyCounts,
    events: pagedEvents,
    eventPage: {
      offset: input.eventOffset,
      limit: input.eventLimit,
      returnedCount: pagedEvents.length,
      totalCount: totalEventCount,
      hasMore: input.eventOffset + pagedEvents.length < totalEventCount,
    },
    performance: performanceResult,
  }
}
