import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { execAll } from '@/lib/db/client'
import { buildContinuousMonthlyMaSeries } from '@/lib/snapshots/continuous-ma'
import {
  addOutcomeRowToSummary, createOutcomeSummaryAccumulator, finalizeOutcomeSummary,
  type OutcomeSummaryAccumulator,
} from '@/lib/server/trigger-discovery-outcome-analysis'
import {
  buildBiweeklySeries, currentBiweeklyObservations,
} from '@/lib/server/trigger-discovery-historical-scan'
import {
  loadSegmentationSource, spreadBucketForOutcomeRow,
} from '@/lib/server/trigger-discovery-outcome-segmentation'
import {
  DEFAULT_MA_ZONE_TRIGGER_CONFIG, TRIGGER_ENGINE_VERSION, evaluateMaSpreadExpansion,
  type MaZoneTriggerObservation,
} from '@/lib/trigger-discovery-engine'
import type { TriggerHistoricalScanEvent } from '@/lib/trigger-discovery-historical-scan-contract'
import {
  TRIGGER_OUTCOME_HORIZONS, type TriggerOutcomeRow,
} from '@/lib/trigger-discovery-outcome-contract'
import {
  SPREAD_SENSITIVITY_CONTRACT_VERSION, SPREAD_SENSITIVITY_GRID_VERSION,
  spreadSensitivityGrid, type SpreadSensitivityGroup, type SpreadSensitivityResponse,
  type SpreadSensitivitySet,
} from '@/lib/trigger-discovery-spread-sensitivity'
import type { OHLCV } from '@/types/stock'

type PriceRow = { ticker: string; date: string; close: number; volume: number }
type StoredRow = { ticker: string; date: string; close: number; ma1: number; ma2: number }
type WeeklyRow = { ticker: string; date: string; week_start_date: string; close: number }
type Bucket = 'PASS' | 'FAIL' | 'UNKNOWN'
const BUCKETS: readonly Bucket[] = ['PASS', 'FAIL', 'UNKNOWN']
const BATCH_SIZE = 100

export class SpreadSensitivitySourceDriftError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SpreadSensitivitySourceDriftError'
  }
}

function dateBefore(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() - days)
  return value.toISOString().slice(0, 10)
}

function key(ticker: string, date: string): string {
  return `${ticker}\u001f${date}`
}

function asOhlcv(row: PriceRow | WeeklyRow): OHLCV {
  const close = Number(row.close)
  return { date: row.date, open: close, high: close, low: close, close,
    volume: 'volume' in row ? Number(row.volume) : 0 }
}

function sliceThrough(rows: readonly MaZoneTriggerObservation[], date: string, count: number): MaZoneTriggerObservation[] {
  let low = 0
  let high = rows.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (rows[middle]!.date <= date) low = middle + 1
    else high = middle
  }
  return rows.slice(Math.max(0, low - count), low)
}

function closeEnough(left: number | null | undefined, right: number | null | undefined): boolean {
  if (left == null || right == null) return left == null && right == null
  return Math.abs(left - right) <= Math.max(1, Math.abs(left), Math.abs(right)) * 1e-8
}

function group(accumulator: OutcomeSummaryAccumulator): SpreadSensitivityGroup {
  return {
    eventCount: accumulator.rowCount,
    uniqueTickerCount: accumulator.tickers.size,
    horizons: finalizeOutcomeSummary(accumulator).map((summary) => ({
      ...summary, smallSample: summary.eligibleCount < 30,
    })),
  }
}

export function aggregateSpreadSensitivity(input: {
  rows: readonly TriggerOutcomeRow[]
  observations: ReadonlyMap<string, readonly MaZoneTriggerObservation[]>
  compareSavedBaseline?: boolean
}): { overall: SpreadSensitivityGroup; parameterSets: SpreadSensitivitySet[];
  timing: { evaluationMs: number; aggregationMs: number; percentileMs: number } } {
  let evaluationMs = 0
  let aggregationMs = 0
  const overallAccumulator = createOutcomeSummaryAccumulator(TRIGGER_OUTCOME_HORIZONS)
  const grid = spreadSensitivityGrid()
  const accumulators = grid.map(() => Object.fromEntries(BUCKETS.map((bucket) => [
    bucket, createOutcomeSummaryAccumulator(TRIGGER_OUTCOME_HORIZONS),
  ])) as Record<Bucket, OutcomeSummaryAccumulator>)
  for (const row of input.rows) {
    const aggregationStarted = performance.now()
    addOutcomeRowToSummary(overallAccumulator, row)
    aggregationMs += performance.now() - aggregationStarted
    const observations = row.snapshotBasis === 'CURRENT' && row.spreadDiagnosticDate
      && row.spreadDiagnosticDate <= row.eventDate
      ? (input.observations.get(key(row.ticker, row.eventDate)) ?? [])
        .filter((point) => point.date <= row.spreadDiagnosticDate!) : []
    for (let index = 0; index < grid.length; index += 1) {
      const parameter = grid[index]!
      const evaluationStarted = performance.now()
      const evaluated = evaluateMaSpreadExpansion({
        observations,
        config: { ...DEFAULT_MA_ZONE_TRIGGER_CONFIG,
          spreadLookbackIntervals: parameter.lookbackIntervals,
          minExpansionRatio: parameter.configuredMinExpansionRatio },
        bothRising: row.snapshotBasis === 'CURRENT',
      })
      const bucket: Bucket = row.snapshotBasis !== 'CURRENT' || !evaluated.available
        ? 'UNKNOWN' : evaluated.passed ? 'PASS' : 'FAIL'
      evaluationMs += performance.now() - evaluationStarted
      if (parameter.isBaseline && input.compareSavedBaseline) {
        const saved = spreadBucketForOutcomeRow(row)
        if (bucket !== saved || (bucket !== 'UNKNOWN' && (
          !closeEnough(evaluated.maSpreadPct, row.maSpreadPct)
          || !closeEnough(evaluated.maSpreadSlope, row.maSpreadSlope)
          || !closeEnough(evaluated.maSpreadExpansionRatio, row.maSpreadExpansionRatio)
          || evaluated.bullishMaOrder !== row.bullishMaOrder
        ))) {
          throw new SpreadSensitivitySourceDriftError(`baseline diagnostic mismatch: ${row.ticker} ${row.eventDate}`)
        }
      }
      const groupingStarted = performance.now()
      addOutcomeRowToSummary(accumulators[index]![bucket], row)
      aggregationMs += performance.now() - groupingStarted
    }
  }
  const percentileStarted = performance.now()
  const parameterSets = grid.map((parameter, index): SpreadSensitivitySet => {
    const sources = accumulators[index]!
    const groups = Object.fromEntries(BUCKETS.map((bucket) => [bucket, group(sources[bucket])])) as SpreadSensitivitySet['groups']
    return {
      ...parameter,
      passEventCount: groups.PASS.eventCount,
      failEventCount: groups.FAIL.eventCount,
      unknownEventCount: groups.UNKNOWN.eventCount,
      passUniqueTickerCount: groups.PASS.uniqueTickerCount,
      passRate: input.rows.length > 0 ? groups.PASS.eventCount / input.rows.length : 0,
      passUniqueTickerRate: overallAccumulator.tickers.size > 0
        ? groups.PASS.uniqueTickerCount / overallAccumulator.tickers.size : 0,
      groups,
    }
  })
  const overall = group(overallAccumulator)
  return { overall, parameterSets,
    timing: { evaluationMs, aggregationMs, percentileMs: performance.now() - percentileStarted } }
}

async function readOutcomeRows(source: Awaited<ReturnType<typeof loadSegmentationSource>>): Promise<{
  rows: TriggerOutcomeRow[]; hash: string; events: Map<string, TriggerHistoricalScanEvent>
}> {
  const [outcomeBytes, eventBytes] = await Promise.all([
    readFile(/* turbopackIgnore: true */ source.rowsFile),
    readFile(/* turbopackIgnore: true */ source.historicalEventsFile),
  ])
  const rows = outcomeBytes.toString('utf8').split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as TriggerOutcomeRow)
  const selected = new Set(rows.filter((row) => row.snapshotBasis === 'CURRENT')
    .map((row) => key(row.ticker, row.eventDate)))
  const events = new Map<string, TriggerHistoricalScanEvent>()
  for (const line of eventBytes.toString('utf8').split('\n')) {
    if (!line) continue
    const event = JSON.parse(line) as TriggerHistoricalScanEvent
    const id = key(event.ticker, event.date)
    if (selected.has(id)) events.set(id, event)
  }
  return { rows, events, hash: createHash('sha256').update(outcomeBytes).digest('hex') }
}

async function loadMaObservations(input: {
  rows: readonly TriggerOutcomeRow[]
  events: ReadonlyMap<string, TriggerHistoricalScanEvent>
  timeframe: 'MONTHLY' | 'BIWEEKLY'
  ma1Period: number
  ma2Period: number
}): Promise<{ observations: Map<string, MaZoneTriggerObservation[]>; queryMs: number; buildMs: number;
  queryCount: number; sourceRows: number }> {
  const current = input.rows.filter((row) => row.snapshotBasis === 'CURRENT' && row.spreadDiagnosticDate)
  const observations = new Map<string, MaZoneTriggerObservation[]>()
  if (!current.length) return { observations, queryMs: 0, buildMs: 0, queryCount: 0, sourceRows: 0 }
  const dates = current.map((row) => row.spreadDiagnosticDate!)
  const first = dates.reduce((left, right) => left < right ? left : right)
  const last = dates.reduce((left, right) => left > right ? left : right)
  const tickers = [...new Set(current.map((row) => row.ticker))]
  const config = { ...DEFAULT_MA_ZONE_TRIGGER_CONFIG,
    ma1Period: input.ma1Period, ma2Period: input.ma2Period }
  let queryMs = 0
  let buildMs = 0
  let queryCount = 0
  let sourceRows = 0
  const dailyStart = dateBefore(first, 45)
  const historyStart = dateBefore(dailyStart, (Math.max(input.ma1Period, input.ma2Period) + 4) * 31 + 160)
  const weeklyStart = dateBefore(first, (Math.max(input.ma1Period, input.ma2Period) + 20) * 2 * 7 + 100)
  for (let offset = 0; offset < tickers.length; offset += BATCH_SIZE) {
    const batch = tickers.slice(offset, offset + BATCH_SIZE)
    const placeholders = batch.map(() => '?').join(',')
    if (input.timeframe === 'MONTHLY') {
      const started = performance.now()
      const [prices, stored] = await Promise.all([
        execAll<PriceRow>(`WITH month_ends AS (
          SELECT ticker, substr(date,1,7) AS month_key, MAX(date) AS date FROM ohlcv_daily
          WHERE ticker IN (${placeholders}) AND date >= ? AND date < ? GROUP BY ticker,month_key
        )
        SELECT o.ticker,o.date,o.close,o.volume FROM month_ends AS m
        JOIN ohlcv_daily AS o ON o.ticker=m.ticker AND o.date=m.date
        UNION ALL
        SELECT ticker,date,close,volume FROM ohlcv_daily
        WHERE ticker IN (${placeholders}) AND date BETWEEN ? AND ? ORDER BY ticker,date`,
        [...batch, historyStart, dailyStart, ...batch, dailyStart, last]),
        execAll<StoredRow>(`SELECT a.ticker,a.date,a.close,a.ma_value AS ma1,b.ma_value AS ma2
          FROM monthly_ma_monitor_daily AS a JOIN monthly_ma_monitor_daily AS b
          ON b.ticker=a.ticker AND b.date=a.date AND b.period=?
          WHERE a.period=? AND a.ticker IN (${placeholders}) AND a.date BETWEEN ? AND ?
          ORDER BY a.ticker,a.date`,
        [input.ma2Period, input.ma1Period, ...batch, dailyStart, last]),
      ])
      queryMs += performance.now() - started
      queryCount += 2
      sourceRows += prices.length + stored.length
      const buildStarted = performance.now()
      const pricesByTicker = new Map<string, OHLCV[]>()
      for (const row of prices) {
        const series = pricesByTicker.get(row.ticker) ?? []
        series.push(asOhlcv(row))
        pricesByTicker.set(row.ticker, series)
      }
      const genericByTicker = new Map<string, MaZoneTriggerObservation[]>()
      for (const [ticker, series] of pricesByTicker) {
        genericByTicker.set(ticker, buildContinuousMonthlyMaSeries(series, [input.ma1Period, input.ma2Period],
          { adjustSplits: false }).flatMap((point) => {
          if (point.date < dailyStart) return []
          const ma1 = point.values.get(input.ma1Period)
          const ma2 = point.values.get(input.ma2Period)
          return ma1 == null || ma2 == null ? [] : [{ date: point.date, price: point.close, ma1, ma2 }]
        }))
      }
      const storedByTicker = new Map<string, MaZoneTriggerObservation[]>()
      for (const row of stored) {
        const series = storedByTicker.get(row.ticker) ?? []
        series.push({ date: row.date, price: Number(row.close), ma1: Number(row.ma1), ma2: Number(row.ma2) })
        storedByTicker.set(row.ticker, series)
      }
      for (const row of current) {
        if (!batch.includes(row.ticker)) continue
        const event = input.events.get(key(row.ticker, row.eventDate))
        const date = row.spreadDiagnosticDate!
        const generic = sliceThrough(genericByTicker.get(row.ticker) ?? [], date, 21)
        const fast = sliceThrough(storedByTicker.get(row.ticker) ?? [], date, 21)
        const matches = (series: MaZoneTriggerObservation[]) => series.at(-1)?.date === date
          && event && closeEnough(series.at(-1)?.ma1, event.ma1)
          && closeEnough(series.at(-1)?.ma2, event.ma2)
        const candidates = [generic, fast].filter(matches)
        const selected = candidates.find((series) => {
          const diagnostic = evaluateMaSpreadExpansion({ observations: series, config, bothRising: true })
          return closeEnough(diagnostic.maSpreadPct, row.maSpreadPct)
            && closeEnough(diagnostic.maSpreadSlope, row.maSpreadSlope)
            && closeEnough(diagnostic.maSpreadExpansionRatio, row.maSpreadExpansionRatio)
        }) ?? candidates[0] ?? generic
        observations.set(key(row.ticker, row.eventDate), selected)
      }
      buildMs += performance.now() - buildStarted
    } else {
      const started = performance.now()
      const weekly = await execAll<WeeklyRow>(`SELECT ticker,date,week_start_date,close FROM weekly_ohlcv
        WHERE ticker IN (${placeholders}) AND date BETWEEN ? AND ? ORDER BY ticker,date`,
      [...batch, weeklyStart, last])
      queryMs += performance.now() - started
      queryCount += 1
      sourceRows += weekly.length
      const buildStarted = performance.now()
      const weeklyByTicker = new Map<string, (OHLCV & { ticker: string; week_start_date: string })[]>()
      for (const row of weekly) {
        const series = weeklyByTicker.get(row.ticker) ?? []
        series.push({ ...asOhlcv(row), ticker: row.ticker, week_start_date: row.week_start_date })
        weeklyByTicker.set(row.ticker, series)
      }
      const prepared = new Map([...weeklyByTicker].map(([ticker, series]) => [ticker, buildBiweeklySeries(series, config)]))
      for (const row of current) {
        if (!batch.includes(row.ticker)) continue
        const event = input.events.get(key(row.ticker, row.eventDate))
        observations.set(key(row.ticker, row.eventDate), currentBiweeklyObservations(
          prepared.get(row.ticker), row.spreadDiagnosticDate!, event?.price ?? row.anchorPrice,
          config, 21, weeklyStart,
        ))
      }
      buildMs += performance.now() - buildStarted
    }
  }
  return { observations, queryMs, buildMs, queryCount, sourceRows }
}

export async function getSpreadSensitivity(outcomeJobId: string): Promise<SpreadSensitivityResponse> {
  const startedAt = performance.now()
  let peakHeapBytes = process.memoryUsage().heapUsed
  let peakRssBytes = process.memoryUsage().rss
  const source = await loadSegmentationSource(outcomeJobId)
  const { rows, events, hash } = await readOutcomeRows(source)
  const sourceOutcomeLoadMs = performance.now() - startedAt
  const ma = await loadMaObservations({ rows, events,
    timeframe: source.outcome.metadata.sourceTimeframe,
    ma1Period: source.historical.scanMeta.ma1Period,
    ma2Period: source.historical.scanMeta.ma2Period })
  peakHeapBytes = Math.max(peakHeapBytes, process.memoryUsage().heapUsed)
  peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss)
  const evaluatedAt = performance.now()
  const { overall, parameterSets, timing } = aggregateSpreadSensitivity({ rows, observations: ma.observations,
    compareSavedBaseline: true })
  const elapsedAggregation = performance.now() - evaluatedAt
  const performanceMetrics: SpreadSensitivityResponse['meta']['performance'] = {
    sourceOutcomeLoadMs, maSourceQueryMs: ma.queryMs, maSeriesConstructionMs: ma.buildMs,
    parameterEvaluationMs: timing.evaluationMs,
    aggregationMs: timing.aggregationMs + Math.max(0, elapsedAggregation
      - timing.evaluationMs - timing.aggregationMs - timing.percentileMs),
    percentileMs: timing.percentileMs, serializationMs: 0, totalMs: 0,
    sqlQueryCount: ma.queryCount + 1, sourceRows: ma.sourceRows,
    peakHeapBytes, peakRssBytes, resultBytes: 0,
  }
  const response: SpreadSensitivityResponse = {
    contractVersion: SPREAD_SENSITIVITY_CONTRACT_VERSION,
    meta: {
      outcomeJobId, historicalScanJobId: source.outcome.historicalScanJobId,
      sourceFingerprint: source.outcome.sourceFingerprint,
      parameterGridVersion: SPREAD_SENSITIVITY_GRID_VERSION,
      spreadEvaluatorVersion: TRIGGER_ENGINE_VERSION,
      timeframe: source.outcome.metadata.sourceTimeframe,
      eventSelector: source.outcome.request.eventFilter,
      scanPeriod: { startDate: source.historical.scanMeta.resolvedStartDate,
        endDate: source.historical.scanMeta.resolvedEndDate },
      observationUnit: source.outcome.metadata.sourceTimeframe === 'MONTHLY'
        ? 'MONTHLY_MA_AS_OF_EACH_TRADING_DAY' : 'BIWEEKLY_PARTIAL_BAR',
      observationIndependenceNote: source.outcome.metadata.observationIndependenceNote,
      analysisCutoffDate: source.outcome.metadata.analysisCutoffDate,
      sourceOutcomeHash: hash, baselineMatchesSavedDiagnostics: true,
      generatedAt: new Date().toISOString(), performance: performanceMetrics,
    }, overall, parameterSets,
  }
  const serializationStart = performance.now()
  const encoded = JSON.stringify(response)
  performanceMetrics.serializationMs = performance.now() - serializationStart
  performanceMetrics.totalMs = performance.now() - startedAt
  performanceMetrics.peakHeapBytes = Math.max(peakHeapBytes, process.memoryUsage().heapUsed)
  performanceMetrics.peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss)
  performanceMetrics.resultBytes = Buffer.byteLength(encoded)
  return response
}
