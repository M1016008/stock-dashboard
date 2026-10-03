import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { execGet } from '@/lib/db/client'
import {
  aggregateOutcomeRows,
  outcomeQuantile,
} from '@/lib/server/trigger-discovery-outcome-analysis'
import {
  DEFAULT_OUTCOME_SEGMENT_SMALL_SAMPLE_THRESHOLD,
  dimensionValue,
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
  TRIGGER_EPISODE_ALGORITHM_VERSION,
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
  type TriggerOutcomeEpisodeMetadata,
} from '@/lib/trigger-discovery-outcome-robustness'
import {
  TRIGGER_OUTCOME_SCORE_BANDS,
  TRIGGER_OUTCOME_SPREAD_BUCKETS,
  TRIGGER_OUTCOME_STAGE_BUCKETS,
  type TriggerOutcomeSegmentDimension,
  type TriggerOutcomeSegmentValue,
} from '@/lib/trigger-discovery-outcome-segmentation'

export interface EpisodeOutcomeObservation {
  row: TriggerOutcomeRow
  episodeId: string
  syntheticBaseline: boolean
  sourceSequence: number
}

type EpisodeState = {
  metadata: TriggerOutcomeEpisodeMetadata
  lastStatus: string | null
  eventCount: number
  sequenceInvalid: boolean
  mappingInvalid: boolean
}

function eventIdentity(event: TriggerHistoricalScanEvent): string {
  return JSON.stringify([
    event.date, event.ticker, event.eventType, event.previousStatus, event.currentStatus,
    event.price, event.triggerScore, event.dayAStage, event.dayBStage,
    event.weekAStage, event.weekBStage, event.monthAStage, event.monthBStage,
  ])
}

function outcomeIdentity(row: TriggerOutcomeRow): string {
  return JSON.stringify([
    row.eventDate, row.ticker, row.eventType, row.previousStatus, row.currentStatus,
    row.anchorPrice, row.triggerScore, row.dayAStage, row.dayBStage,
    row.weekAStage, row.weekBStage, row.monthAStage, row.monthBStage,
  ])
}

export class OutcomeEpisodeBuilder {
  private readonly pendingRows = new Map<string, TriggerOutcomeRow[]>()
  private readonly matchedSourceCounts = new Map<string, number>()
  private readonly matchingEpisodes = new Map<string, Set<EpisodeState>>()
  private readonly openEpisodes = new Map<string, EpisodeState>()
  private readonly seenTickers = new Set<string>()
  private readonly episodeSequence = new Map<string, number>()
  private readonly episodes: EpisodeState[] = []
  private readonly candidateObservations: Array<EpisodeOutcomeObservation & { identity: string; episode: EpisodeState }> = []
  private lastDate: string | null = null
  historicalEventsRead = 0
  syntheticBaselineEpisodeCount = 0
  sequenceAnomalyCount = 0
  outcomeMappingMs = 0

  constructor(rows: readonly TriggerOutcomeRow[], private readonly source: {
    historicalScanJobId: string
    scanStartDate: string
  } = { historicalScanJobId: 'direct', scanStartDate: '' }) {
    for (const row of rows) {
      const identity = outcomeIdentity(row)
      const pending = this.pendingRows.get(identity) ?? []
      pending.push(row)
      this.pendingRows.set(identity, pending)
    }
  }

  private newEpisode(event: TriggerHistoricalScanEvent, synthetic: boolean): EpisodeState {
    const ticker = event.ticker
    const sequence = (this.episodeSequence.get(ticker) ?? 0) + 1
    this.episodeSequence.set(ticker, sequence)
    const episode: EpisodeState = {
      metadata: {
        episodeKey: `${this.source.historicalScanJobId}:${ticker}:${sequence}`,
        ticker,
        observedEpisodeStartDate: synthetic ? null : event.date,
        observedFromDate: synthetic ? this.source.scanStartDate || event.date : event.date,
        episodeEndDate: null,
        leftCensored: synthetic,
        rightCensored: false,
        startEventType: event.eventType,
        selectedEventCount: 0,
        selectedAnchorEventDate: null,
        selectedAnchorEventType: null,
        selectedAnchorSourceSequence: null,
        excludedForSequenceIntegrity: false,
        excludedForMappingIntegrity: false,
      },
      lastStatus: synthetic ? event.previousStatus : event.currentStatus,
      eventCount: 0,
      sequenceInvalid: false,
      mappingInvalid: false,
    }
    this.episodes.push(episode)
    this.openEpisodes.set(ticker, episode)
    this.seenTickers.add(ticker)
    if (synthetic) this.syntheticBaselineEpisodeCount += 1
    return episode
  }

  consume(event: TriggerHistoricalScanEvent): void {
    this.historicalEventsRead += 1
    const sourceSequence = this.historicalEventsRead
    const outOfOrder = this.lastDate != null && event.date < this.lastDate
    this.lastDate = event.date
    let episode = this.openEpisodes.get(event.ticker)
    if (event.eventType === 'ENTERED' || event.eventType === 'RE_ENTRY') {
      if (episode) {
        episode.sequenceInvalid = true
        this.sequenceAnomalyCount += 1
      } else {
        episode = this.newEpisode(event, false)
      }
    } else if (!episode) {
      if (this.seenTickers.has(event.ticker)) {
        this.sequenceAnomalyCount += 1
        return
      }
      episode = this.newEpisode(event, true)
    }
    if (outOfOrder) {
      episode.sequenceInvalid = true
      this.sequenceAnomalyCount += 1
    }
    if ((event.eventType === 'STATUS_CHANGED' || event.eventType === 'EXITED')
      && episode.eventCount > 0 && episode.lastStatus != null
      && event.previousStatus !== episode.lastStatus) {
      episode.sequenceInvalid = true
      this.sequenceAnomalyCount += 1
    }

    const mappingStartedAt = performance.now()
    const identity = eventIdentity(event)
    const pending = this.pendingRows.get(identity)
    if (pending) {
      const matches = this.matchingEpisodes.get(identity) ?? new Set<EpisodeState>()
      matches.add(episode)
      this.matchingEpisodes.set(identity, matches)
      const count = (this.matchedSourceCounts.get(identity) ?? 0) + 1
      this.matchedSourceCounts.set(identity, count)
      if (pending.length === 1 && count === 1) {
        this.candidateObservations.push({
          row: pending[0]!, identity, episode,
          episodeId: episode.metadata.episodeKey,
          syntheticBaseline: episode.metadata.leftCensored,
          sourceSequence,
        })
      }
    }
    this.outcomeMappingMs += performance.now() - mappingStartedAt

    if (event.eventType === 'EXITED') {
      episode.metadata.episodeEndDate = event.date
      this.openEpisodes.delete(event.ticker)
    } else {
      episode.lastStatus = event.currentStatus
    }
    episode.eventCount += 1
  }

  finish(): {
    observations: EpisodeOutcomeObservation[]
    episodes: TriggerOutcomeEpisodeMetadata[]
    mappedOutcomeRowCount: number
    unmatchedOutcomeRowCount: number
    ambiguousOutcomeRowCount: number
    excludedForSequenceIntegrity: number
    excludedForMappingIntegrity: number
  } {
    for (const episode of this.openEpisodes.values()) episode.metadata.rightCensored = true
    let mappedOutcomeRowCount = 0
    let unmatchedOutcomeRowCount = 0
    let ambiguousOutcomeRowCount = 0
    for (const [identity, rows] of this.pendingRows) {
      const sourceCount = this.matchedSourceCounts.get(identity) ?? 0
      if (rows.length > 1 || sourceCount > 1) {
        ambiguousOutcomeRowCount += rows.length
        for (const episode of this.matchingEpisodes.get(identity) ?? []) episode.mappingInvalid = true
      }
      else if (sourceCount === 0) unmatchedOutcomeRowCount += rows.length
      else mappedOutcomeRowCount += rows.length
    }
    const observations: EpisodeOutcomeObservation[] = []
    for (const candidate of this.candidateObservations) {
      if (this.matchedSourceCounts.get(candidate.identity) !== 1
        || candidate.episode.sequenceInvalid || candidate.episode.mappingInvalid) continue
      observations.push({
        row: candidate.row, episodeId: candidate.episodeId,
        syntheticBaseline: candidate.syntheticBaseline, sourceSequence: candidate.sourceSequence,
      })
      const metadata = candidate.episode.metadata
      metadata.selectedEventCount += 1
      if (metadata.selectedAnchorSourceSequence === null) {
        metadata.selectedAnchorSourceSequence = candidate.sourceSequence
        metadata.selectedAnchorEventDate = candidate.row.eventDate
        metadata.selectedAnchorEventType = candidate.row.eventType
      }
    }
    for (const episode of this.episodes) {
      episode.metadata.excludedForSequenceIntegrity = episode.sequenceInvalid
      episode.metadata.excludedForMappingIntegrity = episode.mappingInvalid
    }
    return {
      observations,
      episodes: this.episodes.map(({ metadata }) => metadata),
      mappedOutcomeRowCount,
      unmatchedOutcomeRowCount,
      ambiguousOutcomeRowCount,
      excludedForSequenceIntegrity: this.episodes.filter(({ sequenceInvalid }) => sequenceInvalid).length,
      excludedForMappingIntegrity: this.episodes.filter(({ mappingInvalid }) => mappingInvalid).length,
    }
  }
}

export function assignOutcomeRowsToEpisodes(input: {
  rows: readonly TriggerOutcomeRow[]
  historicalEvents: readonly TriggerHistoricalScanEvent[]
}): {
  observations: EpisodeOutcomeObservation[]
  unmatchedOutcomeRowCount: number
  ambiguousOutcomeRowCount: number
  mappedOutcomeRowCount: number
  excludedForSequenceIntegrity: number
  excludedForMappingIntegrity: number
  syntheticBaselineEpisodeCount: number
  episodes: TriggerOutcomeEpisodeMetadata[]
  sequenceAnomalyCount: number
} {
  const builder = new OutcomeEpisodeBuilder(input.rows)
  for (const event of input.historicalEvents) builder.consume(event)
  return {
    ...builder.finish(),
    syntheticBaselineEpisodeCount: builder.syntheticBaselineEpisodeCount,
    sequenceAnomalyCount: builder.sequenceAnomalyCount,
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
      p25Return: difference(leftHorizon.p25Return, rightHorizon.p25Return),
      p75Return: difference(leftHorizon.p75Return, rightHorizon.p75Return),
      medianMfe: difference(leftHorizon.medianMfe, rightHorizon.medianMfe),
      medianMae: difference(leftHorizon.medianMae, rightHorizon.medianMae),
    }
  })
}

function buildBlock(input: {
  eventRows: readonly TriggerOutcomeRow[]
  episodeObservations: readonly EpisodeOutcomeObservation[]
  horizons: readonly TriggerOutcomeHorizon[]
  smallSampleThreshold: number
  savedEventHorizons?: readonly TriggerOutcomeHorizonSummary[]
  syntheticBaselineEpisodeCount: number
  timing: { tickerAggregationMs: number; percentileMs: number }
}): TriggerOutcomeRobustnessBlock {
  const eventRows = input.eventRows
  const episodeRows = input.episodeObservations
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
      && diagnostics.episodeObservationCount >= new Set(episodeRows.map(
        (observation) => observation.row.ticker,
      )).size,
  }
}

function episodeDiagnostics(input: {
  episodes: readonly TriggerOutcomeEpisodeMetadata[]
  eventCount: number
  mappedOutcomeRows: number
  unmappedOutcomeRows: number
  ambiguousOutcomeRows: number
  sequenceAnomalyCount: number
  excludedForSequenceIntegrity: number
  excludedForMappingIntegrity: number
}): TriggerOutcomeRobustnessResponse['episodeDiagnostics'] {
  const selected = input.episodes.filter((episode) => episode.selectedEventCount > 0)
  const counts = selected.map((episode) => episode.selectedEventCount)
  return {
    observedEpisodeCount: input.episodes.length,
    selectedEpisodeCount: selected.length,
    leftCensoredCount: input.episodes.filter((episode) => episode.leftCensored).length,
    rightCensoredCount: input.episodes.filter((episode) => episode.rightCensored).length,
    selectedLeftCensoredCount: selected.filter((episode) => episode.leftCensored).length,
    selectedRightCensoredCount: selected.filter((episode) => episode.rightCensored).length,
    sequenceAnomalyCount: input.sequenceAnomalyCount,
    excludedForSequenceIntegrity: input.excludedForSequenceIntegrity,
    excludedForMappingIntegrity: input.excludedForMappingIntegrity,
    mappedOutcomeRows: input.mappedOutcomeRows,
    unmappedOutcomeRows: input.unmappedOutcomeRows,
    ambiguousOutcomeRows: input.ambiguousOutcomeRows,
    episodesWithOneSelectedEvent: counts.filter((count) => count === 1).length,
    episodesWithRepeatedSelectedEvents: counts.filter((count) => count >= 2).length,
    selectedEventsPerEpisode: {
      mean: counts.length ? counts.reduce((sum, count) => sum + count, 0) / counts.length : null,
      median: outcomeQuantile(counts, 0.5),
      p95: outcomeQuantile(counts, 0.95),
      max: counts.length ? Math.max(...counts) : 0,
    },
    episodeToEventObservationRatio: input.eventCount > 0 ? selected.length / input.eventCount : null,
  }
}

function dimensionValues(
  dimension: TriggerOutcomeSegmentDimension,
): readonly TriggerOutcomeSegmentValue[] {
  return dimension === 'scoreBand' ? TRIGGER_OUTCOME_SCORE_BANDS
    : dimension === 'spreadExpansion' ? TRIGGER_OUTCOME_SPREAD_BUCKETS : TRIGGER_OUTCOME_STAGE_BUCKETS
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
  historicalScanJobId: string
  scanStartDate: string
  performance: TriggerOutcomeRobustnessPerformance
  updateMemory: () => void
}): Promise<{
  observations: EpisodeOutcomeObservation[]
  episodes: TriggerOutcomeEpisodeMetadata[]
  mappedOutcomeRowCount: number
  unmatchedOutcomeRowCount: number
  ambiguousOutcomeRowCount: number
  sequenceAnomalyCount: number
  excludedForSequenceIntegrity: number
  excludedForMappingIntegrity: number
  syntheticBaselineEpisodeCount: number
}> {
  try {
    await stat(/* turbopackIgnore: true */ input.file)
  } catch {
    throw new TriggerOutcomeSegmentationSourceError('historical_scan_event_artifact_expired')
  }
  const builder = new OutcomeEpisodeBuilder(input.rows, {
    historicalScanJobId: input.historicalScanJobId,
    scanStartDate: input.scanStartDate,
  })
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
  input.performance.outcomeMappingMs = builder.outcomeMappingMs
  input.performance.episodeBuildMs = Math.max(0, input.performance.episodeBuildMs - builder.outcomeMappingMs)
  return {
    ...builder.finish(),
    sequenceAnomalyCount: builder.sequenceAnomalyCount,
    syntheticBaselineEpisodeCount: builder.syntheticBaselineEpisodeCount,
  }
}

export async function getOutcomeRobustness(input: {
  outcomeJobId: string
  dimensions?: readonly TriggerOutcomeSegmentDimension[]
  smallSampleThreshold?: number
  episodeOffset?: number
  episodeLimit?: number
}): Promise<TriggerOutcomeRobustnessResponse> {
  const startedAt = performance.now()
  const dimensions = parseOutcomeRobustnessDimensions(input.dimensions ?? [])
  const smallSampleThreshold = input.smallSampleThreshold
    ?? DEFAULT_OUTCOME_SEGMENT_SMALL_SAMPLE_THRESHOLD
  const episodeOffset = input.episodeOffset ?? 0
  const episodeLimit = input.episodeLimit ?? 0
  if (!Number.isSafeInteger(episodeOffset) || episodeOffset < 0
    || !Number.isSafeInteger(episodeLimit) || episodeLimit < 0 || episodeLimit > 100) {
    throw new TriggerOutcomeSegmentationInputError('episodeOffset or episodeLimit is invalid')
  }
  let peakHeapBytes = process.memoryUsage().heapUsed
  let peakRssBytes = process.memoryUsage().rss
  const updateMemory = () => {
    const memory = process.memoryUsage()
    peakHeapBytes = Math.max(peakHeapBytes, memory.heapUsed)
    peakRssBytes = Math.max(peakRssBytes, memory.rss)
  }
  const source = await loadSegmentationSource(input.outcomeJobId)
  const historicalJob = await execGet<{ expires_at: number; status: string }>(
    'SELECT expires_at, status FROM historical_trigger_scan_jobs WHERE id=?',
    [source.outcome.historicalScanJobId],
  )
  if (!historicalJob || historicalJob.status !== 'COMPLETED'
    || Number(historicalJob.expires_at) <= Math.floor(Date.now() / 1_000)) {
    throw new TriggerOutcomeSegmentationSourceError('historical_scan_event_artifact_expired')
  }
  const metrics: TriggerOutcomeRobustnessPerformance = {
    totalMs: 0,
    manifestLoadMs: source.manifestLoadMs,
    outcomeNdjsonReadMs: 0,
    outcomeParsingMs: 0,
    historicalArtifactReadMs: 0,
    historicalParsingMs: 0,
    episodeBuildMs: 0,
    outcomeMappingMs: 0,
    dedupMs: 0,
    tickerAggregationMs: 0,
    segmentationMs: 0,
    percentileMs: 0,
    serializationMs: 0,
    dbQueryCount: 2,
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
    historicalScanJobId: source.outcome.historicalScanJobId,
    scanStartDate: source.historical.scanMeta.resolvedStartDate
      ?? source.historical.scanMeta.requestedStartDate,
    performance: metrics,
    updateMemory,
  })
  const dedupStartedAt = performance.now()
  const representatives = episodeRepresentatives(episodeResult.observations)
  metrics.dedupMs = performance.now() - dedupStartedAt
  const timing = { tickerAggregationMs: 0, percentileMs: 0 }
  const overall = buildBlock({
    eventRows: rows,
    episodeObservations: representatives,
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
      eventRows: TriggerOutcomeRow[]
      episodeObservations: EpisodeOutcomeObservation[]
    }>(dimensionCartesian(dimensions).map((values) => [
      groupKey(values),
      {
        keys: Object.fromEntries(dimensions.map((dimension, index) => [dimension, values[index]])),
        eventRows: [],
        episodeObservations: [],
      },
    ]))
    for (const row of rows) {
      const values = dimensions.map((dimension) => dimensionValue(row, dimension))
      groups.get(groupKey(values))?.eventRows.push(row)
    }
    for (const observation of representatives) {
      const values = dimensions.map((dimension) => dimensionValue(observation.row, dimension))
      groups.get(groupKey(values))?.episodeObservations.push(observation)
    }
    const results: TriggerOutcomeRobustnessSegmentGroup[] = Array.from(groups.values(), (group) => ({
      keys: group.keys,
      ...buildBlock({
        eventRows: group.eventRows,
        episodeObservations: group.episodeObservations,
        horizons: source.outcome.request.horizons,
        smallSampleThreshold,
        syntheticBaselineEpisodeCount: new Set(group.episodeObservations.filter(
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
  const diagnostic = episodeDiagnostics({
    episodes: episodeResult.episodes,
    eventCount: rows.length,
    mappedOutcomeRows: episodeResult.mappedOutcomeRowCount,
    unmappedOutcomeRows: episodeResult.unmatchedOutcomeRowCount,
    ambiguousOutcomeRows: episodeResult.ambiguousOutcomeRowCount,
    sequenceAnomalyCount: episodeResult.sequenceAnomalyCount,
    excludedForSequenceIntegrity: episodeResult.excludedForSequenceIntegrity,
    excludedForMappingIntegrity: episodeResult.excludedForMappingIntegrity,
  })
  const episodeSegmentEligibleMatchesOverall: Record<string, boolean> = {}
  const episodeSegmentWeightedMeanMatchesOverall: Record<string, boolean> = {}
  for (const summary of overall.units.EPISODE.horizons) {
    const grouped = segmentation?.groups.map((group) => group.units.EPISODE.horizons.find(
      (item) => item.horizonSessions === summary.horizonSessions,
    )!) ?? []
    episodeSegmentEligibleMatchesOverall[String(summary.horizonSessions)] = segmentation === null
      || grouped.reduce((sum, item) => sum + item.eligibleCount, 0) === summary.eligibleCount
    const weightedSum = grouped.reduce((sum, item) => sum + (item.meanReturn ?? 0) * item.eligibleCount, 0)
    const groupedEligible = grouped.reduce((sum, item) => sum + item.eligibleCount, 0)
    const weightedMean = groupedEligible ? weightedSum / groupedEligible : null
    episodeSegmentWeightedMeanMatchesOverall[String(summary.horizonSessions)] = segmentation === null
      || (summary.meanReturn == null ? weightedMean == null
        : weightedMean != null && Math.abs(summary.meanReturn - weightedMean) <= 1e-12)
  }
  updateMemory()
  metrics.peakHeapBytes = peakHeapBytes
  metrics.peakRssBytes = peakRssBytes
  const response: TriggerOutcomeRobustnessResponse = {
    contractVersion: TRIGGER_OUTCOME_ROBUSTNESS_CONTRACT_VERSION,
    meta: {
      dimensions,
      episodeAlgorithmVersion: TRIGGER_EPISODE_ALGORITHM_VERSION,
      smallSampleThreshold,
      source: sourceMetadata(source.outcome, source.historical),
      definitions: {
        event: '保存済みOutcome Eventを1 Observationとして集計します。',
        episode: '同一tickerのENTEREDまたはRE_ENTRYからEXITEDまでを1単位とし、Episode内で最初のOutcome対象Eventを代表Anchorにします。SegmentはそのAnchorの保存値で分類します。',
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
      expiresAt: new Date(Math.min(source.outcomeExpiresAt, Number(historicalJob.expires_at)) * 1_000).toISOString(),
      performance: metrics,
    },
    overall,
    episodeDiagnostics: diagnostic,
    episodePage: {
      offset: episodeOffset,
      limit: episodeLimit,
      totalCount: episodeResult.episodes.length,
      episodes: episodeLimit ? episodeResult.episodes.slice(episodeOffset, episodeOffset + episodeLimit) : [],
    },
    segmentation,
    integrity: {
      sourceRowsMatchedToHistoricalEvents: episodeResult.unmatchedOutcomeRowCount === 0
        && episodeResult.ambiguousOutcomeRowCount === 0,
      unmatchedOutcomeRowCount: episodeResult.unmatchedOutcomeRowCount,
      ambiguousOutcomeRowCount: episodeResult.ambiguousOutcomeRowCount,
      sequenceAnomalyCount: episodeResult.sequenceAnomalyCount,
      eventSummaryMatchesSavedOutcome: sameSummary(overall.units.EVENT, source.outcome),
      overallCountInvariant: overall.countInvariant,
      segmentCountInvariants: segmentation?.groups.every((group) => group.countInvariant) ?? true,
      episodeSegmentCountMatchesOverall: segmentation === null
        || segmentation.groups.reduce((sum, group) => sum + group.units.EPISODE.observationCount, 0)
          === overall.units.EPISODE.observationCount,
      episodeSegmentEligibleMatchesOverall,
      episodeSegmentWeightedMeanMatchesOverall,
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
