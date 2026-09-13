import { performance } from 'node:perf_hooks'
import { execAll, execGet } from '@/lib/db/client'
import {
  createTriggerDiscoverySqlDataSource,
  type TriggerDiscoveryFilteredCandidate,
} from '@/lib/server/trigger-discovery-read-model'
import { buildContinuousMonthlyMaSeries } from '@/lib/snapshots/continuous-ma'
import {
  TRIGGER_DISCOVERY_MINI_CHART_DEFAULT_POINTS,
  TRIGGER_DISCOVERY_MINI_CHART_MAX_TICKERS,
  type TriggerDiscoveryMiniChart,
  type TriggerDiscoveryMiniChartPoint,
  type TriggerDiscoveryMiniChartsRequest,
  type TriggerDiscoveryMiniChartsResponse,
} from '@/lib/trigger-discovery-contract'
import {
  TRIGGER_MA_PERIOD_MAX,
  TRIGGER_MA_PERIOD_MIN,
} from '@/lib/trigger-discovery-engine'
import {
  DEFAULT_TRIGGER_DISCOVERY_TIMEFRAME,
  type TriggerDiscoveryTimeframe,
} from '@/lib/trigger-discovery-timeframe'
import type { OHLCV } from '@/types/stock'

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const TICKER_PATTERN = /^[0-9A-Z]{4,8}$/
const MIN_DISPLAY_POINTS = 12
const MAX_DISPLAY_POINTS = 60
const HISTORY_BUFFER_MONTHS = 2

type MiniChartOhlcvRow = OHLCV & { ticker: string }

type BiweeklyLoad = {
  value: Map<string, TriggerDiscoveryMiniChartPoint[]>
  tickersWithPrices: Set<string>
  queryCount: number
  queryMs: number
  biweekly: NonNullable<TriggerDiscoveryMiniChartsResponse['performance']['biweekly']>
}

type ParsedMiniChartsRequest = {
  tickers: string[]
  requestedAsOf: string
  timeframe: TriggerDiscoveryTimeframe
  ma1Period: number
  ma2Period: number
  displayPoints: number
  displayMonths: number
}

export class TriggerDiscoveryMiniChartInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TriggerDiscoveryMiniChartInputError'
  }
}

export interface TriggerDiscoveryMiniChartDataSource {
  resolveAsOf(requestedAsOf: string): Promise<{
    value: string | null
    queryCount: number
    queryMs: number
  }>
  loadOhlcv?(input: {
    tickers: string[]
    fromDate: string
    throughDate: string
  }): Promise<{
    value: MiniChartOhlcvRow[]
    queryCount: number
    queryMs: number
  }>
  loadBiweeklyPoints?(input: {
    tickers: string[]
    throughDate: string
    ma1Period: number
    ma2Period: number
    displayPoints: number
  }): Promise<BiweeklyLoad>
}

function elapsedMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 1000) / 1000
}

function assertIsoDate(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) {
    throw new TriggerDiscoveryMiniChartInputError('requestedAsOf must use YYYY-MM-DD format')
  }
  const parsed = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new TriggerDiscoveryMiniChartInputError('requestedAsOf must use YYYY-MM-DD format')
  }
}

function integer(value: unknown, name: string, fallback?: number): number {
  const resolved = value ?? fallback
  if (typeof resolved !== 'number' || !Number.isInteger(resolved)) {
    throw new TriggerDiscoveryMiniChartInputError(`${name} must be an integer`)
  }
  return resolved
}

function parseTimeframe(value: unknown): TriggerDiscoveryTimeframe {
  const timeframe = value ?? DEFAULT_TRIGGER_DISCOVERY_TIMEFRAME
  if (timeframe !== 'MONTHLY' && timeframe !== 'BIWEEKLY') {
    throw new TriggerDiscoveryMiniChartInputError('timeframe must be MONTHLY or BIWEEKLY')
  }
  return timeframe
}

function normalizeTickers(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TriggerDiscoveryMiniChartInputError('tickers must be a non-empty array')
  }
  if (value.length > TRIGGER_DISCOVERY_MINI_CHART_MAX_TICKERS) {
    throw new TriggerDiscoveryMiniChartInputError(`tickers must contain at most ${TRIGGER_DISCOVERY_MINI_CHART_MAX_TICKERS} values`)
  }
  const normalized = value.map((ticker) => {
    if (typeof ticker !== 'string') {
      throw new TriggerDiscoveryMiniChartInputError('tickers contains an invalid value')
    }
    const trimmed = ticker.trim().toUpperCase()
    if (!TICKER_PATTERN.test(trimmed)) {
      throw new TriggerDiscoveryMiniChartInputError('tickers contains an invalid value')
    }
    return trimmed
  })
  return [...new Set(normalized)]
}

export function parseTriggerDiscoveryMiniChartsRequest(value: unknown): ParsedMiniChartsRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TriggerDiscoveryMiniChartInputError('request body must be an object')
  }
  const source = value as Record<string, unknown>
  assertIsoDate(source.requestedAsOf)
  const timeframe = parseTimeframe(source.timeframe)
  const ma1Period = integer(source.ma1Period, 'ma1Period')
  const ma2Period = integer(source.ma2Period, 'ma2Period')
  if (ma1Period < TRIGGER_MA_PERIOD_MIN || ma1Period > TRIGGER_MA_PERIOD_MAX
    || ma2Period < TRIGGER_MA_PERIOD_MIN || ma2Period > TRIGGER_MA_PERIOD_MAX
    || ma1Period === ma2Period) {
    throw new TriggerDiscoveryMiniChartInputError('MA periods must be different integers between 2 and 120')
  }
  if (source.displayPoints != null && source.displayMonths != null
    && source.displayPoints !== source.displayMonths) {
    throw new TriggerDiscoveryMiniChartInputError('displayPoints and displayMonths must match when both are supplied')
  }
  const displayPoints = integer(
    source.displayPoints ?? source.displayMonths,
    'displayPoints',
    TRIGGER_DISCOVERY_MINI_CHART_DEFAULT_POINTS,
  )
  if (displayPoints < MIN_DISPLAY_POINTS || displayPoints > MAX_DISPLAY_POINTS) {
    throw new TriggerDiscoveryMiniChartInputError(`displayPoints must be between ${MIN_DISPLAY_POINTS} and ${MAX_DISPLAY_POINTS}`)
  }
  return {
    tickers: normalizeTickers(source.tickers),
    requestedAsOf: source.requestedAsOf,
    timeframe,
    ma1Period,
    ma2Period,
    displayPoints,
    displayMonths: displayPoints,
  }
}

function firstDayMonthsBefore(date: string, months: number): string {
  const parsed = new Date(`${date}T00:00:00Z`)
  parsed.setUTCDate(1)
  parsed.setUTCMonth(parsed.getUTCMonth() - months)
  return parsed.toISOString().slice(0, 8) + '01'
}

function monthKey(date: string): string {
  return date.slice(0, 7)
}

function valuesCte(values: string[]): { sql: string; args: string[] } {
  return { sql: values.map(() => '(?)').join(', '), args: values }
}

function miniCandidate(row: { ticker: string; date: string; close: number }): TriggerDiscoveryFilteredCandidate {
  return {
    ticker: row.ticker,
    companyName: row.ticker,
    market: null,
    priceDate: row.date,
    price: Number(row.close),
    averageVolume: null,
    averageTradingValue: null,
    liquidityObservationCount: 0,
    priceStalenessSessions: 0,
    priceFreshness: 'CURRENT',
    liquidityComplete: false,
  }
}

export function createTriggerDiscoveryMiniChartSqlDataSource(): TriggerDiscoveryMiniChartDataSource {
  const discoverySource = createTriggerDiscoverySqlDataSource()
  return {
    async resolveAsOf(requestedAsOf) {
      const startedAt = performance.now()
      const row = await execGet<{ date: string | null }>(`
        SELECT MAX(date) AS date
        FROM ohlcv_daily
        WHERE date <= ?
      `, [requestedAsOf])
      return { value: row?.date ?? null, queryCount: 1, queryMs: elapsedMs(startedAt) }
    },

    async loadOhlcv({ tickers, fromDate, throughDate }) {
      if (tickers.length === 0) return { value: [], queryCount: 0, queryMs: 0 }
      const tickerRows = valuesCte(tickers)
      const startedAt = performance.now()
      const rows = await execAll<MiniChartOhlcvRow>(`
        WITH requested(ticker) AS (VALUES ${tickerRows.sql})
        SELECT prices.ticker,
               prices.date,
               prices.open,
               prices.high,
               prices.low,
               prices.close,
               prices.volume
        FROM requested
        INNER JOIN ohlcv_daily AS prices
          ON prices.ticker = requested.ticker
         AND prices.date BETWEEN ? AND ?
        ORDER BY prices.ticker, prices.date
      `, [...tickerRows.args, fromDate, throughDate])
      return { value: rows, queryCount: 1, queryMs: elapsedMs(startedAt) }
    },

    async loadBiweeklyPoints({ tickers, throughDate, ma1Period, ma2Period, displayPoints }) {
      if (tickers.length === 0) {
        return {
          value: new Map(),
          tickersWithPrices: new Set(),
          queryCount: 0,
          queryMs: 0,
          biweekly: {
            latestPriceQueryMs: 0,
            weeklyHistoryQueryMs: 0,
            currentWeekQueryMs: 0,
            weeklyAssemblyMs: 0,
            biweeklyAggregationMs: 0,
            maCalculationMs: 0,
          },
        }
      }
      const tickerRows = valuesCte(tickers)
      const latestStartedAt = performance.now()
      const latestRows = await execAll<{ ticker: string; date: string; close: number }>(`
        WITH requested(ticker) AS (VALUES ${tickerRows.sql}), latest AS (
          SELECT requested.ticker, MAX(prices.date) AS date
          FROM requested
          LEFT JOIN ohlcv_daily AS prices
            ON prices.ticker = requested.ticker
           AND prices.date <= ?
          GROUP BY requested.ticker
        )
        SELECT latest.ticker, latest.date, prices.close
        FROM latest
        INNER JOIN ohlcv_daily AS prices
          ON prices.ticker = latest.ticker
         AND prices.date = latest.date
        ORDER BY latest.ticker
      `, [...tickerRows.args, throughDate])
      const latestPriceQueryMs = elapsedMs(latestStartedAt)
      const candidates = latestRows.map(miniCandidate)
      const prepared = await discoverySource.loadBiweeklyMaObservations!({
        candidates,
        ma1Period,
        ma2Period,
        requiredObservations: displayPoints,
      })
      const detail = prepared.biweekly!
      const value = new Map<string, TriggerDiscoveryMiniChartPoint[]>()
      for (const candidate of candidates) {
        value.set(candidate.ticker, (prepared.value.get(candidate.ticker) ?? []).map((point) => ({
          date: point.date,
          close: point.price,
          ma1: point.ma1,
          ma2: point.ma2,
        })))
      }
      return {
        value,
        tickersWithPrices: new Set(latestRows.map((row) => row.ticker)),
        queryCount: 1 + prepared.queryCount,
        queryMs: latestPriceQueryMs + prepared.queryMs,
        biweekly: {
          latestPriceQueryMs,
          weeklyHistoryQueryMs: detail.weeklyHistoryQueryMs,
          currentWeekQueryMs: detail.currentWeekQueryMs,
          weeklyAssemblyMs: detail.weeklyAssemblyMs,
          biweeklyAggregationMs: detail.biweeklyAggregationMs,
          maCalculationMs: detail.maCalculationMs,
        },
      }
    },
  }
}

function emptyChart(input: {
  ticker: string
  requestedAsOf: string
  resolvedAsOf: string
  availability: TriggerDiscoveryMiniChart['availability']
}): TriggerDiscoveryMiniChart {
  return { ...input, latestPointDate: null, points: [] }
}

function buildMonthlyChart(input: {
  ticker: string
  rows: OHLCV[]
  requestedAsOf: string
  resolvedAsOf: string
  ma1Period: number
  ma2Period: number
  displayPoints: number
}): TriggerDiscoveryMiniChart {
  if (input.rows.length === 0) {
    return emptyChart({ ...input, availability: 'missing' })
  }
  const series = buildContinuousMonthlyMaSeries(
    input.rows,
    [input.ma1Period, input.ma2Period],
  )
  const byMonth = new Map<string, typeof series[number]>()
  for (const point of series) byMonth.set(monthKey(point.date), point)
  const points = [...byMonth.values()].slice(-input.displayPoints).map((point) => ({
    date: point.date,
    close: point.close,
    ma1: point.values.get(input.ma1Period) ?? null,
    ma2: point.values.get(input.ma2Period) ?? null,
  }))
  const latest = points.at(-1) ?? null
  return {
    ticker: input.ticker,
    requestedAsOf: input.requestedAsOf,
    resolvedAsOf: input.resolvedAsOf,
    latestPointDate: latest?.date ?? null,
    availability: latest?.ma1 != null && latest.ma2 != null
      ? 'available'
      : 'insufficient_history',
    points,
  }
}

export async function getTriggerDiscoveryMiniCharts(
  request: TriggerDiscoveryMiniChartsRequest,
  options: { dataSource?: TriggerDiscoveryMiniChartDataSource } = {},
): Promise<TriggerDiscoveryMiniChartsResponse> {
  const startedAt = performance.now()
  const input = parseTriggerDiscoveryMiniChartsRequest(request)
  const dataSource = options.dataSource ?? createTriggerDiscoveryMiniChartSqlDataSource()
  const resolved = await dataSource.resolveAsOf(input.requestedAsOf)
  let queryCount = resolved.queryCount
  let dbQueryMs = resolved.queryMs
  const common = {
    contractVersion: 'trigger-discovery-mini-charts-v1' as const,
    requestedAsOf: input.requestedAsOf,
    timeframe: input.timeframe,
    ma1Period: input.ma1Period,
    ma2Period: input.ma2Period,
    displayPoints: input.displayPoints,
    displayMonths: input.displayMonths,
  }
  if (!resolved.value) {
    return {
      ...common,
      resolvedAsOf: null,
      charts: [],
      performance: { queryCount, dbQueryMs, maCalculationMs: 0, totalMs: elapsedMs(startedAt) },
    }
  }

  if (input.timeframe === 'BIWEEKLY') {
    if (!dataSource.loadBiweeklyPoints) {
      throw new TriggerDiscoveryMiniChartInputError('Biweekly Mini Chart data source is unavailable')
    }
    const loaded = await dataSource.loadBiweeklyPoints({
      tickers: input.tickers,
      throughDate: resolved.value,
      ma1Period: input.ma1Period,
      ma2Period: input.ma2Period,
      displayPoints: input.displayPoints,
    })
    queryCount += loaded.queryCount
    dbQueryMs += loaded.queryMs
    const charts = input.tickers.map((ticker) => {
      const points = loaded.value.get(ticker) ?? []
      const latest = points.at(-1) ?? null
      if (!loaded.tickersWithPrices.has(ticker)) {
        return emptyChart({ ticker, requestedAsOf: input.requestedAsOf, resolvedAsOf: resolved.value!, availability: 'missing' })
      }
      return {
        ticker,
        requestedAsOf: input.requestedAsOf,
        resolvedAsOf: resolved.value!,
        latestPointDate: latest?.date ?? null,
        availability: latest ? 'available' as const : 'insufficient_history' as const,
        points,
      }
    })
    return {
      ...common,
      resolvedAsOf: resolved.value,
      charts,
      performance: {
        queryCount,
        dbQueryMs: Math.round(dbQueryMs * 1000) / 1000,
        maCalculationMs: loaded.biweekly.maCalculationMs,
        totalMs: elapsedMs(startedAt),
        biweekly: loaded.biweekly,
      },
    }
  }

  if (!dataSource.loadOhlcv) {
    throw new TriggerDiscoveryMiniChartInputError('Monthly Mini Chart data source is unavailable')
  }
  const historyMonths = input.displayPoints + Math.max(input.ma1Period, input.ma2Period) + HISTORY_BUFFER_MONTHS
  const rows = await dataSource.loadOhlcv({
    tickers: input.tickers,
    fromDate: firstDayMonthsBefore(resolved.value, historyMonths),
    throughDate: resolved.value,
  })
  queryCount += rows.queryCount
  dbQueryMs += rows.queryMs
  const calculationStartedAt = performance.now()
  const byTicker = new Map<string, OHLCV[]>()
  for (const row of rows.value) {
    if (row.date > resolved.value) continue
    const tickerRows = byTicker.get(row.ticker) ?? []
    tickerRows.push({
      date: row.date,
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number(row.volume),
    })
    byTicker.set(row.ticker, tickerRows)
  }
  const charts = input.tickers.map((ticker) => buildMonthlyChart({
    ticker,
    rows: byTicker.get(ticker) ?? [],
    requestedAsOf: input.requestedAsOf,
    resolvedAsOf: resolved.value!,
    ma1Period: input.ma1Period,
    ma2Period: input.ma2Period,
    displayPoints: input.displayPoints,
  }))
  const maCalculationMs = elapsedMs(calculationStartedAt)
  return {
    ...common,
    resolvedAsOf: resolved.value,
    charts,
    performance: {
      queryCount,
      dbQueryMs: Math.round(dbQueryMs * 1000) / 1000,
      maCalculationMs,
      totalMs: elapsedMs(startedAt),
    },
  }
}
