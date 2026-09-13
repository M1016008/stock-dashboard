import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import {
  aggregateOutcomeRows,
  outcomeQuantile,
} from '@/lib/server/trigger-discovery-outcome-analysis'
import {
  DEFAULT_OUTCOME_SEGMENT_SMALL_SAMPLE_THRESHOLD,
  loadSegmentationSource,
  parseOutcomeSegmentDimensions,
  sourceMetadata,
  TriggerOutcomeSegmentationInputError,
  TriggerOutcomeSegmentationSourceError,
} from '@/lib/server/trigger-discovery-outcome-segmentation'
import type { TriggerHistoricalScanEvent } from '@/lib/trigger-discovery-historical-scan-contract'
import type {
  TriggerOutcomeAvailability,
  TriggerOutcomeHorizon,
  TriggerOutcomeHorizonSummary,
  TriggerOutcomeManifest,
  TriggerOutcomeRow,
} from '@/lib/trigger-discovery-outcome-contract'
import {
  TRIGGER_OUTCOME_ROBUSTNESS_CONTRACT_VERSION,
  robustnessUnavailableReason,
  type TriggerOutcomeAnalysisUnit,
  type TriggerOutcomeRobustnessBlock,
  type TriggerOutcomeRobustnessConcentration,
  type TriggerOutcomeRobustnessDelta,
  type TriggerOutcomeRobustnessHorizonSummary,
  type TriggerOutcomeRobustnessPerformance,
  type TriggerOutcomeRobustnessResponse,
  type TriggerOutcomeRobustnessSegmentGroup,
  type TriggerOutcomeRobustnessUnitSummary,
} from '@/lib/trigger-discovery-outcome-robustness'
import {
  TRIGGER_OUTCOME_SCORE_BANDS,
  TRIGGER_OUTCOME_STAGE_BUCKETS,
  type TriggerOutcomeScoreBand,
  type TriggerOutcomeSegmentDimension,
  type TriggerOutcomeSegmentValue,
  type TriggerOutcomeStageBucket,
} from '@/lib/trigger-discovery-outcome-segmentation'

const STAGE_FIELD_BY_DIMENSION = {
  'stage:dayA': 'dayAStage',
  'stage:dayB': 'dayBStage',
  'stage:weekA': 'weekAStage',
  'stage:weekB': 'weekBStage',
  'stage:monthA': 'monthAStage',
  'stage:monthB': 'monthBStage',
} as const satisfies Record<Exclude<TriggerOutcomeSegmentDimension, 'scoreBand'>, keyof TriggerOutcomeRow>

export interface EpisodeOutcomeObservation {
  row: TriggerOutcomeRow
  episodeId: string
  syntheticBaseline: boolean
}

function eventIdentity(input: {
  date: string
  ticker: string
  eventType: string
  previousStatus: string | null
  currentStatus: string | null
}): string {
  return [input.date, input.ticker, input.eventType, input.previousStatus ?? '', input.currentStatus ?? '']
    .join('\u001f')
}

function outcomeIdentity(row: TriggerOutcomeRow): string {
  return eventIdentity({
    date: row.eventDate,
    ticker: row.ticker,
    eventType: row.eventType,
    previousStatus: row.previousStatus,
    currentStatus: row.currentStatus,
  })
}

export class OutcomeEpisodeBuilder {
  private readonly pendingRows = new Map<string, TriggerOutcomeRow[]>()
  private readonly openEpisodes = new Map<string, { id: string; synthetic: boolean }>()
  private readonly episodeSequence = new Map<string, number>()
  private unmatchedRows: number
  readonly observations: EpisodeOutcomeObservation[] = []
  historicalEventsRead = 0
  syntheticBaselineEpisodeCount = 0

  constructor(rows: readonly TriggerOutcomeRow[]) {
    this.unmatchedRows = rows.length
    for (const row of rows) {
      const identity = outcomeIdentity(row)
      const pending = this.pendingRows.get(identity) ?? []
      pending.push(row)
      this.pendingRows.set(identity, pending)
    }
  }

  private newEpisode(ticker: string, synthetic: boolean): { id: string; synthetic: boolean } {
    const sequence = (this.episodeSequence.get(ticker) ?? 0) + 1
    this.episodeSequence.set(ticker, sequence)
    const episode = { id: `${ticker}\u001f${sequence}`, synthetic }
    this.openEpisodes.set(ticker, episode)
    if (synthetic) this.syntheticBaselineEpisodeCount += 1
    return episode
  }

  consume(event: TriggerHistoricalScanEvent): void {
    this.historicalEventsRead += 1
    let episode = this.openEpisodes.get(event.ticker)
    if (event.eventType === 'ENTERED' || event.eventType === 'RE_ENTRY') {
      episode = this.newEpisode(event.ticker, false)
    } else if (!episode) {
      episode = this.newEpisode(event.ticker, true)
    }

    const identity = eventIdentity(event)
    const pending = this.pendingRows.get(identity)
    const row = pending?.shift()
    if (row) {
      this.unmatchedRows -= 1
      this.observations.push({ row, episodeId: episode.id, syntheticBaseline: episode.synthetic })
      if (pending?.length === 0) this.pendingRows.delete(identity)
    }

    if (event.eventType === 'EXITED') this.openEpisodes.delete(event.ticker)
  }

  finish(): { observations: EpisodeOutcomeObservation[]; unmatchedOutcomeRowCount: number } {
    return { observations: this.observations, unmatchedOutcomeRowCount: this.unmatchedRows }
  }
}

export function assignOutcomeRowsToEpisodes(input: {
  rows: readonly TriggerOutcomeRow[]
  historicalEvents: readonly TriggerHistoricalScanEvent[]
}): {
  observations: EpisodeOutcomeObservation[]
  unmatchedOutcomeRowCount: number
  syntheticBaselineEpisodeCount: number
} {
  const builder = new OutcomeEpisodeBuilder(input.rows)
  for (const event of input.historicalEvents) builder.consume(event)
  return {
    ...builder.finish(),
    syntheticBaselineEpisodeCount: builder.syntheticBaselineEpisodeCount,
  }
}

function episodeRepresentatives(
  observations: readonly EpisodeOutcomeObservation[],
): EpisodeOutcomeObservation[] {
  const seen = new Set<string>()
  return observations.filter((observation) => {
    if (seen.has(observation.episodeId)) return false
    seen.add(observation.episodeId)
    return true
  })
}

function medianNumbers(values: Array<number | null>): number | null {
  return outcomeQuantile(values.filter((value): value is number => value != null), 0.5)
}

function tickerRepresentativeRows(
  representatives: readonly EpisodeOutcomeObservation[],
  horizons: readonly TriggerOutcomeHorizon[],
): TriggerOutcomeRow[] {
  const byTicker = new Map<string, EpisodeOutcomeObservation[]>()
  for (const representative of representatives) {
    const values = byTicker.get(representative.row.ticker) ?? []
    values.push(representative)
    byTicker.set(representative.row.ticker, values)
  }
  return Array.from(byTicker.values(), (values) => {
    const base = { ...values[0]!.row }
    for (const horizon of horizons) {
      const eligible = values.filter(({ row }) => row[`availability${horizon}`] === 'AVAILABLE')
      if (eligible.length > 0) {
        base[`availability${horizon}`] = 'AVAILABLE'
        base[`return${horizon}`] = medianNumbers(eligible.map(({ row }) => row[`return${horizon}`]))
        base[`mfe${horizon}`] = medianNumbers(eligible.map(({ row }) => row[`mfe${horizon}`]))
        base[`mae${horizon}`] = medianNumbers(eligible.map(({ row }) => row[`mae${horizon}`]))
      } else {
        base[`availability${horizon}`] = robustnessUnavailableReason(
          values.map(({ row }) => row[`availability${horizon}`]),
        )
        base[`return${horizon}`] = null
        base[`mfe${horizon}`] = null
        base[`mae${horizon}`] = null
      }
    }
    return base
  })
}

function horizonSummary(
  summary: TriggerOutcomeHorizonSummary,
  smallSampleThreshold: number,
): TriggerOutcomeRobustnessHorizonSummary {
  const { totalSelectedEvents, ...rest } = summary
  return {
    ...rest,
    totalObservationCount: totalSelectedEvents,
    smallSample: summary.eligibleCount < smallSampleThreshold,
  }
}

function unitSummary(input: {
  unit: TriggerOutcomeAnalysisUnit
  rows: readonly TriggerOutcomeRow[]
  horizons: readonly TriggerOutcomeHorizon[]
  smallSampleThreshold: number
  savedHorizons?: readonly TriggerOutcomeHorizonSummary[]
}): TriggerOutcomeRobustnessUnitSummary {
  const summaries = input.savedHorizons ?? aggregateOutcomeRows(input.rows, input.horizons)
  return {
    unit: input.unit,
    observationCount: input.rows.length,
    uniqueTickerCount: new Set(input.rows.map((row) => row.ticker)).size,
    horizons: summaries.map((summary) => horizonSummary(summary, input.smallSampleThreshold)),
  }
}

function distribution(values: readonly number[]): { median: number | null; p90: number | null; max: number } {
  return {
    median: outcomeQuantile(values, 0.5),
    p90: outcomeQuantile(values, 0.9),
    max: values.length > 0 ? Math.max(...values) : 0,
  }
}

function concentration(input: {
  eventRows: readonly TriggerOutcomeRow[]
  episodeRows: readonly EpisodeOutcomeObservation[]
  syntheticBaselineEpisodeCount: number
}): TriggerOutcomeRobustnessConcentration {
  const eventsByTicker = new Map<string, number>()
  for (const row of input.eventRows) {
    eventsByTicker.set(row.ticker, (eventsByTicker.get(row.ticker) ?? 0) + 1)
  }
  const episodesByTicker = new Map<string, number>()
  for (const observation of input.episodeRows) {
    episodesByTicker.set(observation.row.ticker, (episodesByTicker.get(observation.row.ticker) ?? 0) + 1)
  }
  const eventCounts = Array.from(eventsByTicker.values())
  const episodeCounts = Array.from(episodesByTicker.values())
  const top10Events = [...eventCounts].sort((left, right) => right - left)
    .slice(0, 10).reduce((sum, value) => sum + value, 0)
  return {
    sourceEventCount: input.eventRows.length,
    episodeObservationCount: input.episodeRows.length,
    uniqueTickerCount: eventsByTicker.size,
    eventsPerTicker: distribution(eventCounts),
    episodesPerTicker: distribution(episodeCounts),
    top10TickerEventShare: input.eventRows.length > 0 ? top10Events / input.eventRows.length : null,
    syntheticBaselineEpisodeCount: input.syntheticBaselineEpisodeCount,
    selectedSyntheticBaselineEpisodeCount: input.episodeRows.filter(
      (observation) => observation.syntheticBaseline,
    ).length,
  }
}

function delta(
  left: TriggerOutcomeRobustnessUnitSummary,
  right: TriggerOutcomeRobustnessUnitSummary,
): TriggerOutcomeRobustnessDelta[] {
  const difference = (leftValue: number | null, rightValue: number | null): number | null => (
    leftValue == null || rightValue == null ? null : rightValue - leftValue
  )
  return left.horizons.map((leftHorizon) => {
    const rightHorizon = right.horizons.find(
      (value) => value.horizonSessions === leftHorizon.horizonSessions,
    )!
    return {
      horizonSessions: leftHorizon.horizonSessions,
      medianReturn: difference(leftHorizon.medianReturn, rightHorizon.medianReturn),
      positiveReturnRatio: difference(leftHorizon.positiveReturnRatio, rightHorizon.positiveReturnRatio),
      medianMfe: difference(leftHorizon.medianMfe, rightHorizon.medianMfe),
      medianMae: difference(leftHorizon.medianMae, rightHorizon.medianMae),
    }
  })
}

function buildBlock(input: {
  observations: readonly EpisodeOutcomeObservation[]
  horizons: readonly TriggerOutcomeHorizon[]
  smallSampleThreshold: number
  savedEventHorizons?: readonly TriggerOutcomeHorizonSummary[]
  syntheticBaselineEpisodeCount: number
  timing: { tickerAggregationMs: number; percentileMs: number }
}): TriggerOutcomeRobustnessBlock {
  const eventRows = input.observations.map((observation) => observation.row)
  const episodeRows = episodeRepresentatives(input.observations)
  const tickerStartedAt = performance.now()
  const tickerRows = tickerRepresentativeRows(episodeRows, input.horizons)
  input.timing.tickerAggregationMs += performance.now() - tickerStartedAt
  const percentileStartedAt = performance.now()
  const eventSummary = unitSummary({
    unit: 'EVENT', rows: eventRows, horizons: input.horizons,
    smallSampleThreshold: input.smallSampleThreshold,
    savedHorizons: input.savedEventHorizons,
  })
  const episodeSummary = unitSummary({
    unit: 'EPISODE', rows: episodeRows.map((observation) => observation.row),
    horizons: input.horizons, smallSampleThreshold: input.smallSampleThreshold,
  })
  const tickerSummary = unitSummary({
    unit: 'TICKER_EQUAL_WEIGHT', rows: tickerRows,
    horizons: input.horizons, smallSampleThreshold: input.smallSampleThreshold,
  })
  const diagnostics = concentration({
    eventRows,
    episodeRows,
    syntheticBaselineEpisodeCount: input.syntheticBaselineEpisodeCount,
  })
  input.timing.percentileMs += performance.now() - percentileStartedAt
  return {
    diagnostics,
    units: {
      EVENT: eventSummary,
      EPISODE: episodeSummary,
      TICKER_EQUAL_WEIGHT: tickerSummary,
    },
    deltas: {
      eventToEpisode: delta(eventSummary, episodeSummary),
      episodeToTicker: delta(episodeSummary, tickerSummary),
    },
    countInvariant: diagnostics.sourceEventCount >= diagnostics.episodeObservationCount
      && diagnostics.episodeObservationCount >= diagnostics.uniqueTickerCount,
  }
}

function scoreBand(value: number): TriggerOutcomeScoreBand {
  if (!Number.isFinite(value) || value < 0 || value > 100) return 'UNKNOWN'
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
  if (dimension === 'scoreBand') return scoreBand(row.triggerScore)
  return stageBucket(row[STAGE_FIELD_BY_DIMENSION[dimension]])
}

function dimensionValues(
  dimension: TriggerOutcomeSegmentDimension,
): readonly TriggerOutcomeSegmentValue[] {
  return dimension === 'scoreBand' ? TRIGGER_OUTCOME_SCORE_BANDS : TRIGGER_OUTCOME_STAGE_BUCKETS
}

function dimensionCartesian(
  dimensions: readonly TriggerOutcomeSegmentDimension[],
): TriggerOutcomeSegmentValue[][] {
  if (dimensions.length === 1) return dimensionValues(dimensions[0]!).map((value) => [value])
  const values: TriggerOutcomeSegmentValue[][] = []
  for (const left of dimensionValues(dimensions[0]!)) {
    for (const right of dimensionValues(dimensions[1]!)) values.push([left, right])
  }
  return values
}

function groupKey(values: readonly TriggerOutcomeSegmentValue[]): string {
  return values.join('\u001f')
}

export function parseOutcomeRobustnessDimensions(
  values: readonly string[],
): TriggerOutcomeSegmentDimension[] {
  return values.length === 0 ? [] : parseOutcomeSegmentDimensions(values)
}

export function parseOutcomeRobustnessUrl(url: string): TriggerOutcomeSegmentDimension[] {
  return parseOutcomeRobustnessDimensions(new URL(url).searchParams.getAll('dimension'))
}

function sameSummary(
  eventSummary: TriggerOutcomeRobustnessUnitSummary,
  outcome: TriggerOutcomeManifest,
): boolean {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stable(child)]))
  }
  const actual = eventSummary.horizons.map(({ smallSample: _small, totalObservationCount, ...value }) => ({
    ...value,
    totalSelectedEvents: totalObservationCount,
  }))
  return JSON.stringify(stable(actual)) === JSON.stringify(stable(outcome.summary.horizons))
}

async function readOutcomeRows(input: {
  file: string
  performance: TriggerOutcomeRobustnessPerformance
  updateMemory: () => void
}): Promise<TriggerOutcomeRow[]> {
  const rows: TriggerOutcomeRow[] = []
  const startedAt = performance.now()
  const stream = createReadStream(input.file, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (!line) continue
      const parsingStartedAt = performance.now()
      rows.push(JSON.parse(line) as TriggerOutcomeRow)
      input.performance.outcomeParsingMs += performance.now() - parsingStartedAt
      if (rows.length % 500 === 0) input.updateMemory()
    }
  } finally {
    lines.close()
    stream.destroy()
  }
  input.performance.outcomeNdjsonReadMs = Math.max(
    0,
    performance.now() - startedAt - input.performance.outcomeParsingMs,
  )
  input.performance.outcomeRowsRead = rows.length
  return rows
}

async function attachEpisodes(input: {
  file: string
  rows: readonly TriggerOutcomeRow[]
  performance: TriggerOutcomeRobustnessPerformance
  updateMemory: () => void
}): Promise<{
  observations: EpisodeOutcomeObservation[]
  unmatchedOutcomeRowCount: number
  syntheticBaselineEpisodeCount: number
}> {
  try {
    await stat(/* turbopackIgnore: true */ input.file)
  } catch {
    throw new TriggerOutcomeSegmentationSourceError('historical_scan_event_artifact_expired')
  }
  const builder = new OutcomeEpisodeBuilder(input.rows)
  const startedAt = performance.now()
  let parsingMs = 0
  const stream = createReadStream(input.file, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (!line) continue
      const parsingStartedAt = performance.now()
      const event = JSON.parse(line) as TriggerHistoricalScanEvent
      parsingMs += performance.now() - parsingStartedAt
      const episodeStartedAt = performance.now()
      builder.consume(event)
      input.performance.episodeBuildMs += performance.now() - episodeStartedAt
      if (builder.historicalEventsRead % 500 === 0) input.updateMemory()
    }
  } finally {
    lines.close()
    stream.destroy()
  }
  input.performance.historicalParsingMs = parsingMs
  input.performance.historicalArtifactReadMs = Math.max(
    0,
    performance.now() - startedAt - parsingMs - input.performance.episodeBuildMs,
  )
  input.performance.historicalEventsRead = builder.historicalEventsRead
  return {
    ...builder.finish(),
    syntheticBaselineEpisodeCount: builder.syntheticBaselineEpisodeCount,
  }
}

export async function getOutcomeRobustness(input: {
  outcomeJobId: string
  dimensions?: readonly TriggerOutcomeSegmentDimension[]
  smallSampleThreshold?: number
}): Promise<TriggerOutcomeRobustnessResponse> {
  const startedAt = performance.now()
  const dimensions = parseOutcomeRobustnessDimensions(input.dimensions ?? [])
  const smallSampleThreshold = input.smallSampleThreshold
    ?? DEFAULT_OUTCOME_SEGMENT_SMALL_SAMPLE_THRESHOLD
  let peakHeapBytes = process.memoryUsage().heapUsed
  let peakRssBytes = process.memoryUsage().rss
  const updateMemory = () => {
    const memory = process.memoryUsage()
    peakHeapBytes = Math.max(peakHeapBytes, memory.heapUsed)
    peakRssBytes = Math.max(peakRssBytes, memory.rss)
  }
  const source = await loadSegmentationSource(input.outcomeJobId)
  const metrics: TriggerOutcomeRobustnessPerformance = {
    totalMs: 0,
    manifestLoadMs: source.manifestLoadMs,
    outcomeNdjsonReadMs: 0,
    outcomeParsingMs: 0,
    historicalArtifactReadMs: 0,
    historicalParsingMs: 0,
    episodeBuildMs: 0,
    tickerAggregationMs: 0,
    segmentationMs: 0,
    percentileMs: 0,
    serializationMs: 0,
    dbQueryCount: 1,
    ohlcvQueryCount: 0,
    outcomeRowsRead: 0,
    historicalEventsRead: 0,
    artifactReadCount: 4,
    peakHeapBytes,
    peakRssBytes,
    resultBytes: 0,
  }
  const rows = await readOutcomeRows({ file: source.rowsFile, performance: metrics, updateMemory })
  const episodeResult = await attachEpisodes({
    file: source.historicalEventsFile,
    rows,
    performance: metrics,
    updateMemory,
  })
  if (episodeResult.unmatchedOutcomeRowCount > 0) {
    throw new TriggerOutcomeSegmentationSourceError('outcome_historical_event_mismatch')
  }
  const timing = { tickerAggregationMs: 0, percentileMs: 0 }
  const overall = buildBlock({
    observations: episodeResult.observations,
    horizons: source.outcome.request.horizons,
    smallSampleThreshold,
    savedEventHorizons: source.outcome.summary.horizons,
    syntheticBaselineEpisodeCount: episodeResult.syntheticBaselineEpisodeCount,
    timing,
  })
  let segmentation: TriggerOutcomeRobustnessResponse['segmentation'] = null
  if (dimensions.length > 0) {
    const segmentationStartedAt = performance.now()
    const groups = new Map<string, {
      keys: Partial<Record<TriggerOutcomeSegmentDimension, TriggerOutcomeSegmentValue>>
      observations: EpisodeOutcomeObservation[]
    }>(dimensionCartesian(dimensions).map((values) => [
      groupKey(values),
      {
        keys: Object.fromEntries(dimensions.map((dimension, index) => [dimension, values[index]])),
        observations: [],
      },
    ]))
    for (const observation of episodeResult.observations) {
      const values = dimensions.map((dimension) => dimensionValue(observation.row, dimension))
      groups.get(groupKey(values))?.observations.push(observation)
    }
    const results: TriggerOutcomeRobustnessSegmentGroup[] = Array.from(groups.values(), (group) => ({
      keys: group.keys,
      ...buildBlock({
        observations: group.observations,
        horizons: source.outcome.request.horizons,
        smallSampleThreshold,
        syntheticBaselineEpisodeCount: new Set(group.observations.filter(
          (observation) => observation.syntheticBaseline,
        ).map((observation) => observation.episodeId)).size,
        timing,
      }),
    }))
    segmentation = { dimensions, groups: results }
    metrics.segmentationMs = performance.now() - segmentationStartedAt
  }
  metrics.tickerAggregationMs = timing.tickerAggregationMs
  metrics.percentileMs = timing.percentileMs
  updateMemory()
  metrics.peakHeapBytes = peakHeapBytes
  metrics.peakRssBytes = peakRssBytes
  const response: TriggerOutcomeRobustnessResponse = {
    contractVersion: TRIGGER_OUTCOME_ROBUSTNESS_CONTRACT_VERSION,
    meta: {
      dimensions,
      smallSampleThreshold,
      source: sourceMetadata(source.outcome, source.historical),
      definitions: {
        event: '保存済みOutcome Eventを1 Observationとして集計します。',
        episode: '同一tickerのENTEREDまたはRE_ENTRYからEXITEDまでを1単位とし、selectorとsegment内の最初のEventを代表Anchorにします。',
        syntheticBaselineEpisode: 'scan開始時点の候補は最初のSTATUS_CHANGEDまたはEXITEDから内部Episodeを構築し、Historical Event自体は変更しません。',
        tickerEqualWeight: 'Episode代表値をticker内で中央値化し、各tickerを1 Observationとして均等集計します。',
        tickerRepresentative: 'MEDIAN_OF_ELIGIBLE_EPISODE_REPRESENTATIVES_PER_HORIZON',
        positiveRatio: {
          EVENT: 'POSITIVE_EVENT_RETURN_RATIO',
          EPISODE: 'POSITIVE_EPISODE_REPRESENTATIVE_RETURN_RATIO',
          TICKER_EQUAL_WEIGHT: 'POSITIVE_TICKER_REPRESENTATIVE_RETURN_RATIO',
        },
        tickerUnavailableReason: 'FIRST_EPISODE_REPRESENTATIVE_AVAILABILITY_IN_CHRONOLOGICAL_ORDER',
        smallSample: 'ELIGIBLE_OBSERVATIONS_LT_30',
        outcomeSource: 'SAVED_OUTCOME_NDJSON',
        episodeSource: 'SAVED_HISTORICAL_EVENT_NDJSON',
      },
      generatedAt: new Date().toISOString(),
      performance: metrics,
    },
    overall,
    segmentation,
    integrity: {
      sourceRowsMatchedToHistoricalEvents: true,
      unmatchedOutcomeRowCount: 0,
      eventSummaryMatchesSavedOutcome: sameSummary(overall.units.EVENT, source.outcome),
      overallCountInvariant: overall.countInvariant,
      segmentCountInvariants: segmentation?.groups.every((group) => group.countInvariant) ?? true,
      sourceArtifactsReadOnly: true,
    },
  }
  const serializationStartedAt = performance.now()
  let serialized = JSON.stringify(response)
  metrics.serializationMs = performance.now() - serializationStartedAt
  metrics.totalMs = performance.now() - startedAt
  metrics.resultBytes = Buffer.byteLength(serialized)
  serialized = JSON.stringify(response)
  metrics.resultBytes = Buffer.byteLength(serialized)
  return response
}

export { TriggerOutcomeSegmentationInputError, TriggerOutcomeSegmentationSourceError }
