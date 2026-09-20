import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { once } from 'node:events'
import { execAll } from '@/lib/db/client'
import { mapResearchObservations } from '@/lib/server/trigger-path-research-batch'
import { buildPathFromLoadedRows, pathHistoryStart, pathWeeklyStart,
  type PathDailyRow, type PathWeeklyRow } from '@/lib/server/trigger-path-source'
import { buildMlRowsForEvent, assignEpisodeSplits, splitPolicyFromSessions,
  type ExactStageRow } from '@/lib/server/trigger-ml-dataset-core'
import { DEFAULT_MA_ZONE_TRIGGER_CONFIG } from '@/lib/trigger-discovery-engine'
import type { TriggerHistoricalScanEvent, TriggerHistoricalScanResponse } from '@/lib/trigger-discovery-historical-scan-contract'
import type { TriggerHistoricalScanRequest } from '@/lib/trigger-discovery-historical-scan-contract'
import type { TriggerOutcomeManifest, TriggerOutcomeRow } from '@/lib/trigger-discovery-outcome-contract'
import type { PathResearchRow } from '@/lib/trigger-path-research-contract'
import { TRIGGER_ML_CHECKPOINTS, TRIGGER_ML_FEATURE_REGISTRY,
  type TriggerMlDatasetManifest, type TriggerMlDatasetRow, type TriggerMlSplitPolicy,
} from '@/lib/trigger-ml-dataset-contract'

type DailyTicker = PathDailyRow & { ticker: string }
type WeeklyTicker = PathWeeklyRow & { ticker: string }
type StageTicker = ExactStageRow & { ticker: string }

function chunks<T>(rows: readonly T[], size: number): T[][] {
  const values: T[][] = []
  for (let i = 0; i < rows.length; i += size) values.push(rows.slice(i, i + size))
  return values
}

export async function generateMlDataset(input: {
  datasetId: string
  pathRows: readonly PathResearchRow[]
  outcomeRows: readonly TriggerOutcomeRow[]
  historicalEvents: readonly TriggerHistoricalScanEvent[]
  outcomeManifest: TriggerOutcomeManifest
  historical: TriggerHistoricalScanResponse
  sourceRequest: TriggerHistoricalScanRequest
  analysisCutoffDate: string
  splitOverrides?: Partial<Pick<TriggerMlSplitPolicy, 'validationStart' | 'testStart' | 'embargoSessions'>>
  file: string
  signal?: AbortSignal
  onProgress?: (processedEvents: number, totalEvents: number, processedTickers: number, totalTickers: number) => Promise<void>
}): Promise<{ summary: Pick<TriggerMlDatasetManifest, 'rowCount' | 'eventCount' | 'episodeCount'
  | 'uniqueTickerCount' | 'eventDateMin' | 'eventDateMax' | 'rowsByCheckpoint' | 'labelAvailableByHorizon'
  | 'evaluationEligibleByHorizonSplit' | 'splitCounts' | 'purgedRows' | 'featureMissingRate' | 'splitPolicy'>;
  hash: string; bytes: number; performance: Record<string, number> }> {
  const started = performance.now()
  const mapped = mapResearchObservations({ outcomes: input.outcomeRows,
    historicalEvents: input.historicalEvents, outcomeManifest: input.outcomeManifest }).mapped
  const byKey = new Map(mapped.map((item) => [item.saved.eventKey, item.saved.event]))
  if (mapped.length !== input.pathRows.length || new Set(input.pathRows.map((row) => row.eventKey)).size !== mapped.length
    || input.pathRows.some((row) => !byKey.has(row.eventKey))) throw new Error('ml_source_event_mismatch')
  const allTickers = [...new Set(input.pathRows.map((row) => row.ticker))].sort()
  const earliest = input.pathRows.reduce((date, row) => row.eventDate < date ? row.eventDate : date,
    input.analysisCutoffDate)
  const latest = input.pathRows.reduce((date, row) => row.eventDate > date ? row.eventDate : date, earliest)
  let sqlMs = 0
  let queryCount = 0
  const sqlStart = performance.now()
  const prior = (await execAll<{ date: string }>(
    'SELECT DISTINCT date FROM ohlcv_daily WHERE date<? ORDER BY date DESC LIMIT 20', [earliest],
  )).map((row) => row.date).reverse()
  const market = (await execAll<{ date: string }>(
    'SELECT DISTINCT date FROM ohlcv_daily WHERE date BETWEEN ? AND ? ORDER BY date',
    [earliest, input.analysisCutoffDate],
  )).map((row) => row.date)
  sqlMs += performance.now() - sqlStart
  queryCount += 2
  const sessions = [...prior, ...market]
  const splitStart = performance.now()
  const policy = splitPolicyFromSessions(market.filter((date) => date <= latest), input.splitOverrides)
  const assignments = assignEpisodeSplits(input.pathRows, policy)
  const splitMs = performance.now() - splitStart
  const byTicker = new Map<string, PathResearchRow[]>()
  for (const row of input.pathRows) byTicker.set(row.ticker, [...(byTicker.get(row.ticker) ?? []), row])
  const config = { ...DEFAULT_MA_ZONE_TRIGGER_CONFIG,
    ma1Period: input.historical.scanMeta.ma1Period, ma2Period: input.historical.scanMeta.ma2Period,
    slopeLookbackSessions: input.sourceRequest.slopeLookbackSessions ?? DEFAULT_MA_ZONE_TRIGGER_CONFIG.slopeLookbackSessions,
    approachLookbackSessions: input.sourceRequest.approachLookbackSessions ?? DEFAULT_MA_ZONE_TRIGGER_CONFIG.approachLookbackSessions,
    minimumAboveZoneRatio: input.sourceRequest.minimumAboveZoneRatio ?? DEFAULT_MA_ZONE_TRIGGER_CONFIG.minimumAboveZoneRatio,
    maxApproachDistancePct: input.historical.criteria.maxApproachDistancePct,
    nearDistancePct: input.historical.criteria.nearDistancePct,
    spreadExpansionEnabled: input.historical.criteria.spreadExpansionEnabled ?? false,
    spreadLookbackIntervals: input.historical.criteria.spreadLookbackIntervals ?? DEFAULT_MA_ZONE_TRIGGER_CONFIG.spreadLookbackIntervals,
    minExpansionRatio: input.historical.criteria.minExpansionRatio ?? DEFAULT_MA_ZONE_TRIGGER_CONFIG.minExpansionRatio,
    requireBullishMaOrder: input.historical.criteria.requireBullishMaOrder ?? true,
    belowZoneToleranceEnabled: input.historical.criteria.belowZoneToleranceEnabled ?? false,
    maxBelowZonePct: input.historical.criteria.maxBelowZonePct ?? DEFAULT_MA_ZONE_TRIGGER_CONFIG.maxBelowZonePct,
  }
  const counts = Object.fromEntries(TRIGGER_ML_CHECKPOINTS.map((checkpoint) => [checkpoint, 0])) as TriggerMlDatasetManifest['rowsByCheckpoint']
  const labelCounts: Record<string, number> = { '20': 0, '60': 0, '120': 0, '245': 0 }
  const eligibleBySplit: TriggerMlDatasetManifest['evaluationEligibleByHorizonSplit'] = {
    '20': { TRAIN: 0, VALIDATION: 0, TEST: 0 },
    '60': { TRAIN: 0, VALIDATION: 0, TEST: 0 },
    '120': { TRAIN: 0, VALIDATION: 0, TEST: 0 },
    '245': { TRAIN: 0, VALIDATION: 0, TEST: 0 },
  }
  const splitCounts = { TRAIN: 0, VALIDATION: 0, TEST: 0 }
  const missing = Object.fromEntries(TRIGGER_ML_FEATURE_REGISTRY.map((item) => [item.name, 0])) as Record<string, number>
  const hash = createHash('sha256')
  let bytes = 0
  let rowCount = 0
  let purgedRows = 0
  let processedEvents = 0
  let processedTickers = 0
  let featureGenerationMs = 0
  const detailTiming = { pathSnapshotMs: 0, labelGenerationMs: 0 }
  let serializationMs = 0
  let peakHeapBytes = process.memoryUsage().heapUsed
  let peakRssBytes = process.memoryUsage().rss
  const stream = createWriteStream(input.file, { flags: 'wx', encoding: 'utf8' })
  try {
    await input.onProgress?.(0, input.pathRows.length, 0, allTickers.length)
    const maxPeriod = Math.max(config.ma1Period, config.ma2Period)
    for (const tickerChunk of chunks(allTickers, 25)) {
      if (input.signal?.aborted) throw new DOMException('ML dataset cancelled', 'AbortError')
      const earliestTicker = tickerChunk.reduce((min, ticker) => (byTicker.get(ticker) ?? [])
        .reduce((d, row) => row.eventDate < d ? row.eventDate : d, min), input.analysisCutoffDate)
      const eventIndex = sessions.indexOf(earliestTicker)
      const contextStart = sessions[Math.max(0, eventIndex - 20)] ?? earliestTicker
      const historyStart = pathHistoryStart(contextStart, input.historical.scanMeta.timeframe, maxPeriod)
      const placeholders = tickerChunk.map(() => '?').join(',')
      const loadStart = performance.now()
      const daily = await execAll<DailyTicker>(`SELECT ticker,date,open,high,low,close FROM ohlcv_daily
        WHERE ticker IN (${placeholders}) AND date BETWEEN ? AND ? ORDER BY ticker,date`,
      [...tickerChunk, historyStart, input.analysisCutoffDate])
      const weekly = input.historical.scanMeta.timeframe === 'BIWEEKLY'
        ? await execAll<WeeklyTicker>(`SELECT ticker,date,week_start_date,open,high,low,close FROM weekly_ohlcv
          WHERE ticker IN (${placeholders}) AND date BETWEEN ? AND ? ORDER BY ticker,date`,
        [...tickerChunk, pathWeeklyStart(contextStart, maxPeriod), input.analysisCutoffDate]) : []
      const stages = await execAll<StageTicker>(`SELECT ticker,date,daily_a_stage,daily_b_stage,
        weekly_a_stage,weekly_b_stage,monthly_a_stage,monthly_b_stage FROM daily_snapshots
        WHERE ticker IN (${placeholders}) AND date BETWEEN ? AND ? ORDER BY ticker,date`,
      [...tickerChunk, earliestTicker, input.analysisCutoffDate])
      sqlMs += performance.now() - loadStart
      queryCount += input.historical.scanMeta.timeframe === 'BIWEEKLY' ? 3 : 2
      const dailyByTicker = new Map<string, DailyTicker[]>()
      const weeklyByTicker = new Map<string, WeeklyTicker[]>()
      const stageByTicker = new Map<string, Map<string, StageTicker>>()
      for (const item of daily) {
        if (!dailyByTicker.has(item.ticker)) dailyByTicker.set(item.ticker, [])
        dailyByTicker.get(item.ticker)!.push(item)
      }
      for (const item of weekly) {
        if (!weeklyByTicker.has(item.ticker)) weeklyByTicker.set(item.ticker, [])
        weeklyByTicker.get(item.ticker)!.push(item)
      }
      for (const item of stages) {
        const dates = stageByTicker.get(item.ticker) ?? new Map<string, StageTicker>()
        dates.set(item.date, item)
        stageByTicker.set(item.ticker, dates)
      }
      for (const ticker of tickerChunk) {
        const tickerDaily = dailyByTicker.get(ticker) ?? []
        const tickerWeekly = weeklyByTicker.get(ticker) ?? []
        for (const pathRow of byTicker.get(ticker) ?? []) {
          if (input.signal?.aborted) throw new DOMException('ML dataset cancelled', 'AbortError')
          const event = byKey.get(pathRow.eventKey)!
          const anchorIndex = sessions.indexOf(event.date)
          const localContext = sessions[Math.max(0, anchorIndex - 20)] ?? event.date
          const buildStart = performance.now()
          const prepared = buildPathFromLoadedRows({ eventKey: pathRow.eventKey, event,
            timeframe: pathRow.timeframe, ma1Period: pathRow.ma1Period, ma2Period: pathRow.ma2Period,
            analysisCutoffDate: input.analysisCutoffDate, contextStart: localContext,
            marketSessions: sessions.slice(anchorIndex),
            daily: tickerDaily.filter((item) => item.date >= pathHistoryStart(localContext, pathRow.timeframe, maxPeriod)),
            weekly: tickerWeekly.filter((item) => item.date >= pathWeeklyStart(localContext, maxPeriod)),
          })
          if (pathRow.pathStatus === 'AVAILABLE'
            && JSON.stringify(prepared.profile) !== JSON.stringify(pathRow.pathProfile)) {
            throw new Error('source_path_profile_changed')
          }
          const split = assignments.get(pathRow.episodeKey ?? `event:${pathRow.eventKey}`)!
          const rows = buildMlRowsForEvent({ datasetId: input.datasetId, row: pathRow, event,
            series: prepared.series, daily: tickerDaily, marketSessions: sessions,
            stages: stageByTicker.get(ticker) ?? new Map(), config, split,
            splitPolicy: policy, analysisCutoffDate: input.analysisCutoffDate, timing: detailTiming })
          featureGenerationMs += performance.now() - buildStart
          for (const mlRow of rows) {
            const writeStarted = performance.now()
            const line = `${JSON.stringify(mlRow)}\n`
            hash.update(line)
            bytes += Buffer.byteLength(line)
            if (!stream.write(line)) await once(stream, 'drain')
            serializationMs += performance.now() - writeStarted
            rowCount += 1
            counts[mlRow.checkpoint] += 1
            splitCounts[mlRow.split] += 1
            if (mlRow.purged) purgedRows += 1
            for (const label of mlRow.outcomeLabel.snapshotForward) {
              const key = String(label.labelHorizonSessions) as keyof typeof eligibleBySplit
              if (label.labelAvailable) {
                labelCounts[key] += 1
                if (!mlRow.purgedByHorizon[key]) eligibleBySplit[key][mlRow.split] += 1
              }
            }
            for (const definition of TRIGGER_ML_FEATURE_REGISTRY) {
              const [layer, name] = definition.name.split('.')
              const value = layer === 'eventFeature'
                ? mlRow.eventFeature[name as keyof typeof mlRow.eventFeature]
                : mlRow.pathSnapshot[name as keyof typeof mlRow.pathSnapshot]
              if (value == null || value === 'UNKNOWN') missing[definition.name] += 1
            }
          }
          processedEvents += 1
        }
        processedTickers += 1
      }
      const memory = process.memoryUsage()
      peakHeapBytes = Math.max(peakHeapBytes, memory.heapUsed)
      peakRssBytes = Math.max(peakRssBytes, memory.rss)
      await input.onProgress?.(processedEvents, input.pathRows.length, processedTickers, allTickers.length)
    }
    await new Promise<void>((resolve, reject) => { stream.once('error', reject); stream.end(resolve) })
  } catch (error) { stream.destroy(); throw error }
  if (processedEvents !== input.pathRows.length) throw new Error('ml_observation_count_mismatch')
  return {
    summary: {
      rowCount, eventCount: processedEvents,
      episodeCount: new Set(input.pathRows.map((row) => row.episodeKey ?? `event:${row.eventKey}`)).size,
      uniqueTickerCount: allTickers.length, eventDateMin: earliest, eventDateMax: latest,
      rowsByCheckpoint: counts, labelAvailableByHorizon: labelCounts,
      evaluationEligibleByHorizonSplit: eligibleBySplit,
      splitCounts, purgedRows,
      featureMissingRate: Object.fromEntries(Object.entries(missing).map(([key, count]) => [key, rowCount ? count / rowCount : 0])),
      splitPolicy: policy,
    }, hash: hash.digest('hex'), bytes,
    performance: { totalMs: performance.now() - started, sqlMs, sqlQueryCount: queryCount,
      featureGenerationMs, pathSnapshotMs: detailTiming.pathSnapshotMs,
      labelGenerationMs: detailTiming.labelGenerationMs,
      splitMs, serializationMs, peakHeapBytes, peakRssBytes },
  }
}
