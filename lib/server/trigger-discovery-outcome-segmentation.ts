import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { execGet } from '@/lib/db/client'
import { historicalScanResultPaths } from '@/lib/server/trigger-discovery-historical-scan-jobs'
import {
  addOutcomeRowToSummary,
  createOutcomeSummaryAccumulator,
  finalizeOutcomeSummary,
  type OutcomeSummaryAccumulator,
} from '@/lib/server/trigger-discovery-outcome-analysis'
import { outcomeResultPaths } from '@/lib/server/trigger-discovery-outcome-jobs'
import type { TriggerHistoricalScanResponse } from '@/lib/trigger-discovery-historical-scan-contract'
import type {
  TriggerOutcomeHorizon,
  TriggerOutcomeManifest,
  TriggerOutcomeRow,
} from '@/lib/trigger-discovery-outcome-contract'
import {
  TRIGGER_OUTCOME_SCORE_BANDS,
  TRIGGER_OUTCOME_SEGMENTATION_CONTRACT_VERSION,
  TRIGGER_OUTCOME_SEGMENT_COMPARISON_CONTRACT_VERSION,
  TRIGGER_OUTCOME_SEGMENT_DIMENSIONS,
  TRIGGER_OUTCOME_STAGE_BUCKETS,
  type TriggerOutcomeComparisonCompatibility,
  type TriggerOutcomeComparisonDifference,
  type TriggerOutcomeScoreBand,
  type TriggerOutcomeSegmentationResponse,
  type TriggerOutcomeSegmentationSourceMetadata,
  type TriggerOutcomeSegmentComparisonResponse,
  type TriggerOutcomeSegmentDimension,
  type TriggerOutcomeSegmentGroup,
  type TriggerOutcomeSegmentHorizonSummary,
  type TriggerOutcomeSegmentValue,
  type TriggerOutcomeStageBucket,
} from '@/lib/trigger-discovery-outcome-segmentation'

const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export const DEFAULT_OUTCOME_SEGMENT_SMALL_SAMPLE_THRESHOLD = 30

type OutcomeJobSourceRow = {
  id: string
  status: string
  historical_scan_job_id: string
  result_location: string | null
  expires_at: number
}

interface SegmentAccumulator {
  keys: Partial<Record<TriggerOutcomeSegmentDimension, TriggerOutcomeSegmentValue>>
  summary: OutcomeSummaryAccumulator
}

const STAGE_FIELD_BY_DIMENSION = {
  'stage:dayA': 'dayAStage',
  'stage:dayB': 'dayBStage',
  'stage:weekA': 'weekAStage',
  'stage:weekB': 'weekBStage',
  'stage:monthA': 'monthAStage',
  'stage:monthB': 'monthBStage',
} as const satisfies Record<Exclude<TriggerOutcomeSegmentDimension, 'scoreBand'>, keyof TriggerOutcomeRow>

export class TriggerOutcomeSegmentationInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TriggerOutcomeSegmentationInputError'
  }
}

export class TriggerOutcomeSegmentationSourceError extends Error {
  constructor(public readonly code:
    | 'outcome_analysis_job_not_found'
    | 'outcome_analysis_job_not_completed'
    | 'outcome_analysis_job_result_expired'
    | 'historical_scan_source_metadata_expired'
    | 'historical_scan_event_artifact_expired'
    | 'outcome_historical_event_mismatch') {
    super(code)
    this.name = 'TriggerOutcomeSegmentationSourceError'
  }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1_000)
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]),
  )
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value))
}

function sameValue(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right)
}

export function parseOutcomeSegmentDimensions(
  values: readonly string[],
): TriggerOutcomeSegmentDimension[] {
  if (values.length < 1 || values.length > 2) {
    throw new TriggerOutcomeSegmentationInputError('dimension must be specified once or twice')
  }
  const dimensions = values.map((value) => value.trim())
  if (new Set(dimensions).size !== dimensions.length) {
    throw new TriggerOutcomeSegmentationInputError('duplicate dimensions are not allowed')
  }
  for (const dimension of dimensions) {
    if (!TRIGGER_OUTCOME_SEGMENT_DIMENSIONS.includes(dimension as TriggerOutcomeSegmentDimension)) {
      throw new TriggerOutcomeSegmentationInputError(`unsupported dimension: ${dimension}`)
    }
  }
  return dimensions as TriggerOutcomeSegmentDimension[]
}

export function parseOutcomeSegmentationUrl(url: string): TriggerOutcomeSegmentDimension[] {
  return parseOutcomeSegmentDimensions(new URL(url).searchParams.getAll('dimension'))
}

export function scoreBandForOutcomeScore(value: unknown): TriggerOutcomeScoreBand {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) return 'UNKNOWN'
  if (value < 40) return 'LOW'
  if (value < 60) return 'MID_LOW'
  if (value < 80) return 'MID_HIGH'
  return 'HIGH'
}

function stageBucket(value: unknown): TriggerOutcomeStageBucket {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 6
    ? `S${Number(value)}` as TriggerOutcomeStageBucket
    : 'UNKNOWN'
}

function dimensionValue(
  row: TriggerOutcomeRow,
  dimension: TriggerOutcomeSegmentDimension,
): TriggerOutcomeSegmentValue {
  if (dimension === 'scoreBand') return scoreBandForOutcomeScore(row.triggerScore)
  return stageBucket(row[STAGE_FIELD_BY_DIMENSION[dimension]])
}

function valuesForDimension(
  dimension: TriggerOutcomeSegmentDimension,
): readonly TriggerOutcomeSegmentValue[] {
  return dimension === 'scoreBand' ? TRIGGER_OUTCOME_SCORE_BANDS : TRIGGER_OUTCOME_STAGE_BUCKETS
}

function cartesianValues(
  dimensions: readonly TriggerOutcomeSegmentDimension[],
): TriggerOutcomeSegmentValue[][] {
  if (dimensions.length === 1) return valuesForDimension(dimensions[0]!).map((value) => [value])
  const result: TriggerOutcomeSegmentValue[][] = []
  for (const left of valuesForDimension(dimensions[0]!)) {
    for (const right of valuesForDimension(dimensions[1]!)) result.push([left, right])
  }
  return result
}

function groupIdentity(values: readonly TriggerOutcomeSegmentValue[]): string {
  return values.join('\u001f')
}

function createSegmentAccumulators(
  dimensions: readonly TriggerOutcomeSegmentDimension[],
  horizons: readonly TriggerOutcomeHorizon[],
): Map<string, SegmentAccumulator> {
  return new Map(cartesianValues(dimensions).map((values) => [
    groupIdentity(values),
    {
      keys: Object.fromEntries(dimensions.map((dimension, index) => [dimension, values[index]])),
      summary: createOutcomeSummaryAccumulator(horizons),
    },
  ]))
}

function segmentHorizon(
  summary: ReturnType<typeof finalizeOutcomeSummary>[number],
  smallSampleThreshold: number,
): TriggerOutcomeSegmentHorizonSummary {
  const { totalSelectedEvents, ...rest } = summary
  return {
    ...rest,
    totalEventCount: totalSelectedEvents,
    smallSample: summary.eligibleCount < smallSampleThreshold,
  }
}

function finalizeGroups(
  accumulators: ReadonlyMap<string, SegmentAccumulator>,
  smallSampleThreshold: number,
): TriggerOutcomeSegmentGroup[] {
  return Array.from(accumulators.values(), ({ keys, summary }) => ({
    keys,
    eventCount: summary.rowCount,
    uniqueTickerCount: summary.tickers.size,
    horizons: finalizeOutcomeSummary(summary).map((item) => segmentHorizon(item, smallSampleThreshold)),
  }))
}

export function aggregateOutcomeSegmentsFromRows(input: {
  rows: Iterable<TriggerOutcomeRow>
  dimensions: readonly TriggerOutcomeSegmentDimension[]
  horizons: readonly TriggerOutcomeHorizon[]
  smallSampleThreshold?: number
}): TriggerOutcomeSegmentGroup[] {
  const dimensions = parseOutcomeSegmentDimensions(input.dimensions)
  const accumulators = createSegmentAccumulators(dimensions, input.horizons)
  for (const row of input.rows) {
    const values = dimensions.map((dimension) => dimensionValue(row, dimension))
    const accumulator = accumulators.get(groupIdentity(values))
    if (!accumulator) throw new Error('outcome_segment_accumulator_missing')
    addOutcomeRowToSummary(accumulator.summary, row)
  }
  return finalizeGroups(
    accumulators,
    input.smallSampleThreshold ?? DEFAULT_OUTCOME_SEGMENT_SMALL_SAMPLE_THRESHOLD,
  )
}

export function sourceMetadata(
  outcome: TriggerOutcomeManifest,
  historical: TriggerHistoricalScanResponse,
): TriggerOutcomeSegmentationSourceMetadata {
  const timeframe = outcome.metadata.sourceTimeframe
  return {
    historicalScanJobId: outcome.historicalScanJobId,
    outcomeJobId: outcome.outcomeJobId,
    eventSelector: outcome.request.eventFilter,
    timeframe,
    maPeriods: {
      ma1: historical.scanMeta.ma1Period,
      ma2: historical.scanMeta.ma2Period,
      unit: timeframe === 'BIWEEKLY' ? 'BIWEEKLY_BARS' : 'MONTHLY_BARS',
    },
    scanPeriod: {
      requestedStartDate: historical.scanMeta.requestedStartDate,
      requestedEndDate: historical.scanMeta.requestedEndDate,
      resolvedStartDate: historical.scanMeta.resolvedStartDate,
      resolvedEndDate: historical.scanMeta.resolvedEndDate,
    },
    filters: {
      markets: historical.criteria.markets,
      price: { min: historical.criteria.priceMin, max: historical.criteria.priceMax },
      liquidity: {
        averageVolumeMin: historical.criteria.averageVolumeMin,
        averageVolumeMax: historical.criteria.averageVolumeMax,
        averageTradingValueMin: historical.criteria.averageTradingValueMin,
        averageTradingValueMax: historical.criteria.averageTradingValueMax,
        lookbackSessions: historical.criteria.liquidityLookbackSessions,
        maxPriceStalenessSessions: historical.criteria.maxPriceStalenessSessions,
      },
      historicalStage: historical.criteria.stageFilters,
      outcomeStage: outcome.request.stageFilters,
      outcomeScore: { min: outcome.request.triggerScoreMin, max: outcome.request.triggerScoreMax },
      outcomeTicker: outcome.request.ticker,
    },
    analysisCutoffDate: outcome.metadata.analysisCutoffDate,
    horizons: outcome.request.horizons,
    historicalUniverseCaveat: historical.scanMeta.universeNote,
    observationIndependenceNote: outcome.metadata.observationIndependenceNote,
  }
}

function integrity(input: {
  groups: readonly TriggerOutcomeSegmentGroup[]
  outcome: TriggerOutcomeManifest
}): TriggerOutcomeSegmentationResponse['integrity'] {
  const eligibleCountsMatchOverall: Record<string, boolean> = {}
  const weightedMeanMatchesOverall: Record<string, boolean> = {}
  for (const overall of input.outcome.summary.horizons) {
    const grouped = input.groups.map((group) => group.horizons.find(
      (horizon) => horizon.horizonSessions === overall.horizonSessions,
    )).filter((value): value is TriggerOutcomeSegmentHorizonSummary => Boolean(value))
    const eligible = grouped.reduce((sum, value) => sum + value.eligibleCount, 0)
    eligibleCountsMatchOverall[String(overall.horizonSessions)] = eligible === overall.eligibleCount
    const weightedSum = grouped.reduce(
      (sum, value) => sum + (value.meanReturn ?? 0) * value.eligibleCount,
      0,
    )
    const weightedMean = eligible > 0 ? weightedSum / eligible : null
    weightedMeanMatchesOverall[String(overall.horizonSessions)] = overall.meanReturn == null
      ? weightedMean == null
      : weightedMean != null && Math.abs(weightedMean - overall.meanReturn) <= 1e-12
  }
  return {
    eventCountMatchesOverall: input.groups.reduce((sum, group) => sum + group.eventCount, 0)
      === input.outcome.summary.selectedEventCount,
    eligibleCountsMatchOverall,
    weightedMeanMatchesOverall,
  }
}

async function outcomeJobSourceRow(id: string): Promise<OutcomeJobSourceRow | null> {
  if (!JOB_ID_PATTERN.test(id)) return null
  return (await execGet<OutcomeJobSourceRow>(`SELECT id, status, historical_scan_job_id,
    result_location, expires_at FROM trigger_outcome_analysis_jobs WHERE id=?`, [id])) ?? null
}

export async function loadSegmentationSource(id: string): Promise<{
  outcome: TriggerOutcomeManifest
  historical: TriggerHistoricalScanResponse
  rowsFile: string
  historicalEventsFile: string
  manifestLoadMs: number
}> {
  const row = await outcomeJobSourceRow(id)
  if (!row) throw new TriggerOutcomeSegmentationSourceError('outcome_analysis_job_not_found')
  if (row.status !== 'COMPLETED' || row.result_location !== row.id) {
    throw new TriggerOutcomeSegmentationSourceError('outcome_analysis_job_not_completed')
  }
  if (Number(row.expires_at) <= nowSeconds()) {
    throw new TriggerOutcomeSegmentationSourceError('outcome_analysis_job_result_expired')
  }
  const outcomePaths = outcomeResultPaths(id)
  const historicalPaths = historicalScanResultPaths(row.historical_scan_job_id)
  const startedAt = performance.now()
  let outcomeJson: string
  try {
    ;[outcomeJson] = await Promise.all([
      readFile(/* turbopackIgnore: true */ outcomePaths.manifest, 'utf8'),
      stat(/* turbopackIgnore: true */ outcomePaths.rowsByDate),
    ])
  } catch {
    throw new TriggerOutcomeSegmentationSourceError('outcome_analysis_job_result_expired')
  }
  let historicalJson: string
  try {
    historicalJson = await readFile(
      /* turbopackIgnore: true */ historicalPaths.manifest,
      'utf8',
    )
  } catch {
    throw new TriggerOutcomeSegmentationSourceError('historical_scan_source_metadata_expired')
  }
  return {
    outcome: JSON.parse(outcomeJson) as TriggerOutcomeManifest,
    historical: JSON.parse(historicalJson) as TriggerHistoricalScanResponse,
    rowsFile: outcomePaths.rowsByDate,
    historicalEventsFile: historicalPaths.events,
    manifestLoadMs: performance.now() - startedAt,
  }
}

export async function getOutcomeSegmentation(input: {
  outcomeJobId: string
  dimensions: readonly TriggerOutcomeSegmentDimension[]
  smallSampleThreshold?: number
}): Promise<TriggerOutcomeSegmentationResponse> {
  const startedAt = performance.now()
  const dimensions = parseOutcomeSegmentDimensions(input.dimensions)
  const smallSampleThreshold = input.smallSampleThreshold
    ?? DEFAULT_OUTCOME_SEGMENT_SMALL_SAMPLE_THRESHOLD
  const source = await loadSegmentationSource(input.outcomeJobId)
  const accumulators = createSegmentAccumulators(dimensions, source.outcome.request.horizons)
  let parsingMs = 0
  let groupingMs = 0
  let rowsRead = 0
  let peakHeapBytes = process.memoryUsage().heapUsed
  let peakRssBytes = process.memoryUsage().rss
  const streamStartedAt = performance.now()
  const stream = createReadStream(source.rowsFile, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (!line) continue
      const parsingStartedAt = performance.now()
      const row = JSON.parse(line) as TriggerOutcomeRow
      parsingMs += performance.now() - parsingStartedAt
      const groupingStartedAt = performance.now()
      const values = dimensions.map((dimension) => dimensionValue(row, dimension))
      const accumulator = accumulators.get(groupIdentity(values))
      if (!accumulator) throw new Error('outcome_segment_accumulator_missing')
      addOutcomeRowToSummary(accumulator.summary, row)
      groupingMs += performance.now() - groupingStartedAt
      rowsRead += 1
      if (rowsRead % 500 === 0) {
        const memory = process.memoryUsage()
        peakHeapBytes = Math.max(peakHeapBytes, memory.heapUsed)
        peakRssBytes = Math.max(peakRssBytes, memory.rss)
      }
    }
  } finally {
    lines.close()
    stream.destroy()
  }
  const streamMs = performance.now() - streamStartedAt
  const percentileStartedAt = performance.now()
  const groups = finalizeGroups(accumulators, smallSampleThreshold)
  const percentileMs = performance.now() - percentileStartedAt
  const memory = process.memoryUsage()
  peakHeapBytes = Math.max(peakHeapBytes, memory.heapUsed)
  peakRssBytes = Math.max(peakRssBytes, memory.rss)
  const performanceMetrics = {
    totalMs: 0,
    manifestLoadMs: source.manifestLoadMs,
    ndjsonReadMs: Math.max(0, streamMs - parsingMs - groupingMs),
    parsingMs,
    groupingMs,
    percentileMs,
    serializationMs: 0,
    dbQueryCount: 1,
    ohlcvQueryCount: 0 as const,
    rowsRead,
    peakHeapBytes,
    peakRssBytes,
    resultBytes: 0,
  }
  const response: TriggerOutcomeSegmentationResponse = {
    contractVersion: TRIGGER_OUTCOME_SEGMENTATION_CONTRACT_VERSION,
    meta: {
      dimensions,
      smallSampleThreshold,
      source: sourceMetadata(source.outcome, source.historical),
      generatedAt: new Date().toISOString(),
      performance: performanceMetrics,
    },
    overall: source.outcome.summary,
    segmentation: { dimensions, groups },
    integrity: integrity({ groups, outcome: source.outcome }),
  }
  const serializationStartedAt = performance.now()
  let serialized = JSON.stringify(response)
  performanceMetrics.serializationMs = performance.now() - serializationStartedAt
  performanceMetrics.totalMs = performance.now() - startedAt
  performanceMetrics.resultBytes = Buffer.byteLength(serialized)
  serialized = JSON.stringify(response)
  performanceMetrics.resultBytes = Buffer.byteLength(serialized)
  return response
}

function compatibility(
  left: TriggerOutcomeSegmentationSourceMetadata,
  right: TriggerOutcomeSegmentationSourceMetadata,
): TriggerOutcomeComparisonCompatibility {
  const differences: TriggerOutcomeComparisonDifference[] = []
  if (left.timeframe !== right.timeframe) differences.push('timeframe')
  if (!sameValue(left.maPeriods, right.maPeriods)) differences.push('maPeriods')
  if (!sameValue(
    [left.scanPeriod.requestedStartDate, left.scanPeriod.requestedEndDate],
    [right.scanPeriod.requestedStartDate, right.scanPeriod.requestedEndDate],
  )) differences.push('requestedScanPeriod')
  if (!sameValue(
    [left.scanPeriod.resolvedStartDate, left.scanPeriod.resolvedEndDate],
    [right.scanPeriod.resolvedStartDate, right.scanPeriod.resolvedEndDate],
  )) differences.push('resolvedScanPeriod')
  if (!sameValue(left.filters.markets, right.filters.markets)) differences.push('marketFilters')
  if (!sameValue(left.filters.price, right.filters.price)) differences.push('priceFilters')
  if (!sameValue(left.filters.liquidity, right.filters.liquidity)) differences.push('liquidityFilters')
  if (!sameValue(
    [left.filters.historicalStage, left.filters.outcomeStage],
    [right.filters.historicalStage, right.filters.outcomeStage],
  )) differences.push('stageFilters')
  if (left.eventSelector !== right.eventSelector) differences.push('eventSelector')
  if (!sameValue(left.filters.outcomeScore, right.filters.outcomeScore)) differences.push('scoreFilters')
  if (!sameValue(left.horizons, right.horizons)) differences.push('horizons')
  if (left.analysisCutoffDate !== right.analysisCutoffDate) differences.push('analysisCutoffDate')
  const sameDateRange = !differences.includes('requestedScanPeriod')
    && !differences.includes('resolvedScanPeriod')
  const samePopulationFilters = ![
    'marketFilters', 'priceFilters', 'liquidityFilters', 'stageFilters',
  ].some((difference) => differences.includes(difference as TriggerOutcomeComparisonDifference))
  return {
    differences,
    samePopulationFilters,
    sameDateRange,
    sameEventSelector: left.eventSelector === right.eventSelector,
    sameHorizons: sameValue(left.horizons, right.horizons),
    sameTimeframe: left.timeframe === right.timeframe,
    sameMaPeriods: sameValue(left.maPeriods, right.maPeriods),
    sameScoreFilters: sameValue(left.filters.outcomeScore, right.filters.outcomeScore),
    sameAnalysisCutoffDate: left.analysisCutoffDate === right.analysisCutoffDate,
  }
}

export function parseOutcomeSegmentComparisonRequest(value: unknown): {
  leftOutcomeJobId: string
  rightOutcomeJobId: string
  dimensions: TriggerOutcomeSegmentDimension[]
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TriggerOutcomeSegmentationInputError('request body must be an object')
  }
  const source = value as Record<string, unknown>
  const leftOutcomeJobId = String(source.leftOutcomeJobId ?? '')
  const rightOutcomeJobId = String(source.rightOutcomeJobId ?? '')
  if (!JOB_ID_PATTERN.test(leftOutcomeJobId) || !JOB_ID_PATTERN.test(rightOutcomeJobId)) {
    throw new TriggerOutcomeSegmentationInputError('outcome job IDs must be valid UUIDs')
  }
  if (!Array.isArray(source.dimensions)) {
    throw new TriggerOutcomeSegmentationInputError('dimensions must be an array')
  }
  return {
    leftOutcomeJobId,
    rightOutcomeJobId,
    dimensions: parseOutcomeSegmentDimensions(source.dimensions.map(String)),
  }
}

export async function compareOutcomeSegments(value: unknown): Promise<TriggerOutcomeSegmentComparisonResponse> {
  const startedAt = performance.now()
  const request = parseOutcomeSegmentComparisonRequest(value)
  const left = await getOutcomeSegmentation({
    outcomeJobId: request.leftOutcomeJobId,
    dimensions: request.dimensions,
  })
  const right = await getOutcomeSegmentation({
    outcomeJobId: request.rightOutcomeJobId,
    dimensions: request.dimensions,
  })
  const response: TriggerOutcomeSegmentComparisonResponse = {
    contractVersion: TRIGGER_OUTCOME_SEGMENT_COMPARISON_CONTRACT_VERSION,
    dimensions: request.dimensions,
    left,
    right,
    compatibility: compatibility(left.meta.source, right.meta.source),
    performance: {
      totalMs: 0,
      resultBytes: 0,
      peakHeapBytes: Math.max(left.meta.performance.peakHeapBytes, right.meta.performance.peakHeapBytes),
      peakRssBytes: Math.max(left.meta.performance.peakRssBytes, right.meta.performance.peakRssBytes),
    },
  }
  response.performance.totalMs = performance.now() - startedAt
  response.performance.resultBytes = Buffer.byteLength(JSON.stringify(response))
  return response
}
