import { execAll } from '@/lib/db/client'
import { outcomeEventMatches } from '@/lib/server/trigger-discovery-outcome-analysis'
import { assignOutcomeRowsToEpisodes } from '@/lib/server/trigger-discovery-outcome-robustness'
import { historicalEventKey } from '@/lib/server/trigger-discovery-historical-scan-jobs'
import {
  buildPathFromLoadedRows, pathHistoryStart, pathWeeklyStart,
  type PathDailyRow, type PathWeeklyRow,
} from '@/lib/server/trigger-path-source'
import type { TriggerHistoricalScanEvent } from '@/lib/trigger-discovery-historical-scan-contract'
import type { TriggerOutcomeManifest, TriggerOutcomeRow } from '@/lib/trigger-discovery-outcome-contract'
import type { PathResearchRow } from '@/lib/trigger-path-research-contract'

type SavedEvent = { event: TriggerHistoricalScanEvent; eventKey: string; sequence: number }
type TickerDaily = PathDailyRow & { ticker: string }
type TickerWeekly = PathWeeklyRow & { ticker: string }
const TICKER_CHUNK_SIZE = 25

function identity(source: TriggerHistoricalScanEvent | TriggerOutcomeRow): string {
  const event = source as TriggerHistoricalScanEvent
  const row = source as TriggerOutcomeRow
  return JSON.stringify([
    event.date ?? row.eventDate, source.ticker, event.eventType ?? row.eventType,
    event.previousStatus ?? row.previousStatus, event.currentStatus ?? row.currentStatus,
    event.price ?? row.anchorPrice, source.triggerScore,
    source.dayAStage, source.dayBStage, source.weekAStage, source.weekBStage,
    source.monthAStage, source.monthBStage,
    source.snapshotBasis ?? 'CURRENT',
  ])
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = []
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size))
  return result
}

export function mapResearchObservations(input: {
  outcomes: readonly TriggerOutcomeRow[]
  historicalEvents: readonly TriggerHistoricalScanEvent[]
  outcomeManifest: TriggerOutcomeManifest
}): { mapped: Array<{ outcome: TriggerOutcomeRow; saved: SavedEvent; episodeKey: string | null }>; episodeExcludedCount: number } {
  const selected = new Map<string, SavedEvent[]>()
  input.historicalEvents.forEach((event, sequence) => {
    if (!outcomeEventMatches({ event, ...input.outcomeManifest.request })) return
    const key = identity(event)
    const bucket = selected.get(key) ?? []
    bucket.push({ event, eventKey: historicalEventKey(sequence), sequence: sequence + 1 })
    selected.set(key, bucket)
  })
  const episodeAssignments = assignOutcomeRowsToEpisodes({
    rows: input.outcomes, historicalEvents: input.historicalEvents,
  })
  const episodeBySequence = new Map(episodeAssignments.observations.map(
    (observation) => [observation.sourceSequence, observation.episodeId],
  ))
  const mapped = input.outcomes.map((outcome) => {
    const saved = selected.get(identity(outcome))?.shift()
    if (!saved) throw new Error('outcome_historical_event_mismatch')
    return { outcome, saved, episodeKey: episodeBySequence.get(saved.sequence) ?? null }
  })
  const unmatched = Array.from(selected.values()).reduce((sum, bucket) => sum + bucket.length, 0)
  if (unmatched !== 0 || mapped.length !== input.outcomeManifest.summary.selectedEventCount) {
    throw new Error('outcome_historical_event_count_mismatch')
  }
  return {
    mapped,
    episodeExcludedCount: mapped.filter((item) => item.episodeKey == null).length,
  }
}

export async function generatePathResearchRows(input: {
  mapped: readonly { outcome: TriggerOutcomeRow; saved: SavedEvent; episodeKey: string | null }[]
  outcomeManifest: TriggerOutcomeManifest
  ma1Period: number
  ma2Period: number
  timeframe: 'MONTHLY' | 'BIWEEKLY'
  analysisCutoffDate: string
  signal?: AbortSignal
  onProgress?: (progress: { processedEvents: number; totalEvents: number; processedTickers: number; totalTickers: number }) => Promise<void>
}): Promise<{ rows: PathResearchRow[]; timing: {
  sqlMs: number; queryCount: number; maMs: number; atrMs: number; pathMs: number; peakHeapBytes: number; peakRssBytes: number
} }> {
  const byTicker = new Map<string, Array<{ outcome: TriggerOutcomeRow; saved: SavedEvent; episodeKey: string | null }>>()
  for (const item of input.mapped) {
    const bucket = byTicker.get(item.outcome.ticker) ?? []
    bucket.push(item)
    byTicker.set(item.outcome.ticker, bucket)
  }
  const tickers = [...byTicker.keys()].sort()
  const earliest = input.mapped.reduce(
    (date, item) => item.outcome.eventDate < date ? item.outcome.eventDate : date,
    input.analysisCutoffDate,
  )
  let sqlMs = 0
  let queryCount = 0
  let maMs = 0
  let atrMs = 0
  let pathMs = 0
  let peakHeapBytes = process.memoryUsage().heapUsed
  let peakRssBytes = process.memoryUsage().rss
  const sqlStarted = performance.now()
  const prior = (await execAll<{ date: string }>(
    'SELECT DISTINCT date FROM ohlcv_daily WHERE date<? ORDER BY date DESC LIMIT 20', [earliest],
  )).map((item) => item.date).reverse()
  const market = (await execAll<{ date: string }>(
    'SELECT DISTINCT date FROM ohlcv_daily WHERE date BETWEEN ? AND ? ORDER BY date',
    [earliest, input.analysisCutoffDate],
  )).map((item) => item.date)
  sqlMs += performance.now() - sqlStarted
  queryCount += 2
  const allSessions = [...prior, ...market]
  const marketIndex = new Map(allSessions.map((date, index) => [date, index]))
  const result: PathResearchRow[] = []
  let processedEvents = 0
  let processedTickers = 0
  const maxPeriod = Math.max(input.ma1Period, input.ma2Period)
  await input.onProgress?.({ processedEvents, totalEvents: input.mapped.length, processedTickers, totalTickers: tickers.length })
  for (const tickerChunk of chunks(tickers, TICKER_CHUNK_SIZE)) {
    if (input.signal?.aborted) throw new DOMException('Path research cancelled', 'AbortError')
    const earliestTickerDate = tickerChunk.reduce((date, ticker) => {
      const first = byTicker.get(ticker)?.reduce((value, item) => (
        item.outcome.eventDate < value ? item.outcome.eventDate : value
      ), input.analysisCutoffDate)
      return first && first < date ? first : date
    }, input.analysisCutoffDate)
    const startIndex = marketIndex.get(earliestTickerDate)
    const contextStart = allSessions[Math.max(0, (startIndex ?? 0) - 20)] ?? earliestTickerDate
    const historyStart = pathHistoryStart(contextStart, input.timeframe, maxPeriod)
    const placeholders = tickerChunk.map(() => '?').join(',')
    const loadStarted = performance.now()
    const daily = await execAll<TickerDaily>(
      `SELECT ticker,date,open,high,low,close FROM ohlcv_daily
       WHERE ticker IN (${placeholders}) AND date BETWEEN ? AND ? ORDER BY ticker,date`,
      [...tickerChunk, historyStart, input.analysisCutoffDate],
    )
    let weekly: TickerWeekly[] = []
    if (input.timeframe === 'BIWEEKLY') {
      weekly = await execAll<TickerWeekly>(
        `SELECT ticker,date,week_start_date,open,high,low,close FROM weekly_ohlcv
         WHERE ticker IN (${placeholders}) AND date BETWEEN ? AND ? ORDER BY ticker,date`,
        [...tickerChunk, pathWeeklyStart(contextStart, maxPeriod), input.analysisCutoffDate],
      )
    }
    sqlMs += performance.now() - loadStarted
    queryCount += input.timeframe === 'BIWEEKLY' ? 2 : 1
    const dailyByTicker = new Map<string, PathDailyRow[]>()
    const weeklyByTicker = new Map<string, PathWeeklyRow[]>()
    for (const row of daily) {
      const series = dailyByTicker.get(row.ticker) ?? []
      series.push(row)
      dailyByTicker.set(row.ticker, series)
    }
    for (const row of weekly) {
      const series = weeklyByTicker.get(row.ticker) ?? []
      series.push(row)
      weeklyByTicker.set(row.ticker, series)
    }
    for (const ticker of tickerChunk) {
      for (const item of byTicker.get(ticker) ?? []) {
        if (input.signal?.aborted) throw new DOMException('Path research cancelled', 'AbortError')
        const { event, eventKey } = item.saved
        const eventIndex = marketIndex.get(event.date)
        const localContext = eventIndex == null ? event.date
          : allSessions[Math.max(0, eventIndex - 20)] ?? event.date
        let pathStatus: PathResearchRow['pathStatus'] = 'AVAILABLE'
        let profile: PathResearchRow['pathProfile'] = null
        if (eventIndex == null) pathStatus = 'MISSING_MARKET_DATA'
        else if (!(event.price > 0) || !(event.ma1 > 0) || !(event.ma2 > 0)) pathStatus = 'INVALID_ANCHOR'
        else {
          const prepared = buildPathFromLoadedRows({
            eventKey, event, timeframe: input.timeframe,
            ma1Period: input.ma1Period, ma2Period: input.ma2Period,
            analysisCutoffDate: input.analysisCutoffDate, contextStart: localContext,
            marketSessions: allSessions.slice(eventIndex),
            daily: (dailyByTicker.get(ticker) ?? []).filter((row) => row.date >= pathHistoryStart(localContext, input.timeframe, maxPeriod)),
            weekly: (weeklyByTicker.get(ticker) ?? []).filter((row) => row.date >= pathWeeklyStart(localContext, maxPeriod)),
          })
          profile = prepared.profile
          maMs += prepared.maZoneBuildMs
          atrMs += prepared.atrMs
          pathMs += prepared.pathCalculationMs
        }
        result.push({
          eventKey, episodeKey: item.episodeKey, ticker, eventDate: event.date,
          eventSelector: input.outcomeManifest.request.eventFilter,
          anchorSemantics: event.snapshotBasis === 'PREVIOUS'
            ? 'PREVIOUS_CANDIDATE_SAVED_PRICE' : 'EVENT_SAVED_PRICE',
          timeframe: input.timeframe, ma1Period: input.ma1Period, ma2Period: input.ma2Period,
          anchorPrice: event.price, analysisCutoffDate: input.analysisCutoffDate,
          pathStatus, pathProfile: profile, outcome: item.outcome,
        })
        processedEvents += 1
      }
      processedTickers += 1
    }
    const memory = process.memoryUsage()
    peakHeapBytes = Math.max(peakHeapBytes, memory.heapUsed)
    peakRssBytes = Math.max(peakRssBytes, memory.rss)
    await input.onProgress?.({ processedEvents, totalEvents: input.mapped.length, processedTickers, totalTickers: tickers.length })
  }
  if (result.length !== input.mapped.length) throw new Error('path_research_row_count_mismatch')
  return { rows: result, timing: { sqlMs, queryCount, maMs, atrMs, pathMs, peakHeapBytes, peakRssBytes } }
}
