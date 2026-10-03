import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import {
  addOutcomeRowToSummary, createOutcomeSummaryAccumulator, finalizeOutcomeSummary,
  type OutcomeSummaryAccumulator,
} from '@/lib/server/trigger-discovery-outcome-analysis'
import { dimensionValue } from '@/lib/server/trigger-discovery-outcome-segmentation'
import { getPathResearchArtifact } from '@/lib/server/trigger-path-research-jobs'
import {
  TRIGGER_OUTCOME_SCORE_BANDS, TRIGGER_OUTCOME_SPREAD_BUCKETS,
  TRIGGER_OUTCOME_SEGMENT_DIMENSIONS, TRIGGER_OUTCOME_STAGE_BUCKETS,
} from '@/lib/trigger-discovery-outcome-segmentation'
import { TRIGGER_OUTCOME_HORIZONS, type TriggerOutcomeHorizon, type TriggerOutcomeRow } from '@/lib/trigger-discovery-outcome-contract'
import { isPathDimension, pathBand, pathBandOrder } from '@/lib/trigger-path-bands'
import {
  PATH_RESEARCH_CONTRACT_VERSION, PATH_SEGMENTATION_VERSION,
  type PathResearchCohort, type PathResearchDimension, type PathResearchRow,
  type PathResearchSegmentsResponse, type PathResearchUnit,
} from '@/lib/trigger-path-research-contract'

export class PathResearchInputError extends Error {}

export function parsePathResearchQuery(url: string): {
  dimensions: PathResearchDimension[]; horizon: TriggerOutcomeHorizon
  unit: PathResearchUnit; cohort: PathResearchCohort | null
} {
  const params = new URL(url).searchParams
  const dimensions = params.getAll('dimension')
  if (dimensions.length < 1 || dimensions.length > 2 || new Set(dimensions).size !== dimensions.length
    || dimensions.some((dimension) => !isPathDimension(dimension)
      && !TRIGGER_OUTCOME_SEGMENT_DIMENSIONS.includes(dimension as typeof TRIGGER_OUTCOME_SEGMENT_DIMENSIONS[number]))) {
    throw new PathResearchInputError('1〜2個の有効な分析軸を指定してください。')
  }
  const horizon = Number(params.get('horizon') ?? '60')
  if (!TRIGGER_OUTCOME_HORIZONS.includes(horizon as TriggerOutcomeHorizon)) throw new PathResearchInputError('invalid horizon')
  const unit = params.get('unit') ?? 'EVENT'
  if (unit !== 'EVENT' && unit !== 'EPISODE') throw new PathResearchInputError('invalid unit')
  let cohort: PathResearchCohort | null = null
  if (params.has('cohortMetric')) {
    const metric = params.get('cohortMetric')
    const cohortHorizon = Number(params.get('cohortHorizon') ?? horizon)
    const minText = params.get('cohortMin')
    const maxText = params.get('cohortMax')
    const min = minText == null || minText === '' ? null : Number(minText)
    const max = maxText == null || maxText === '' ? null : Number(maxText)
    if ((metric !== 'return' && metric !== 'mfe' && metric !== 'mae')
      || !TRIGGER_OUTCOME_HORIZONS.includes(cohortHorizon as TriggerOutcomeHorizon)
      || (min == null && max == null) || (min != null && !Number.isFinite(min))
      || (max != null && !Number.isFinite(max)) || (min != null && max != null && min > max)) {
      throw new PathResearchInputError('invalid outcome cohort')
    }
    cohort = { metric, horizon: cohortHorizon as TriggerOutcomeHorizon, min, max }
  } else if (params.has('cohortHorizon') || params.has('cohortMin') || params.has('cohortMax')) {
    throw new PathResearchInputError('cohort metric is required')
  }
  return { dimensions: dimensions as PathResearchDimension[], horizon: horizon as TriggerOutcomeHorizon, unit, cohort }
}

function dimensionOrder(dimension: PathResearchDimension): string[] {
  if (isPathDimension(dimension)) return pathBandOrder(dimension)
  if (dimension === 'scoreBand') return [...TRIGGER_OUTCOME_SCORE_BANDS]
  if (dimension === 'spreadExpansion') return [...TRIGGER_OUTCOME_SPREAD_BUCKETS]
  return [...TRIGGER_OUTCOME_STAGE_BUCKETS]
}

function selectedPath(row: PathResearchRow, horizon: TriggerOutcomeHorizon) {
  const fixed = row.pathProfile?.horizonPaths.find((item) => item.horizonSessions === horizon)
  return fixed?.availability ? fixed.path : null
}

function cohortMatches(row: TriggerOutcomeRow, cohort: PathResearchCohort | null): boolean {
  if (!cohort) return true
  const horizon = cohort.horizon
  if (row[`availability${horizon}`] !== 'AVAILABLE') return false
  const value = row[`${cohort.metric}${horizon}`]
  return value != null && Number.isFinite(value)
    && (cohort.min == null || value >= cohort.min) && (cohort.max == null || value <= cohort.max)
}

function selectedRows(rows: readonly PathResearchRow[], unit: PathResearchUnit): PathResearchRow[] {
  if (unit === 'EVENT') return [...rows]
  const byEpisode = new Map<string, PathResearchRow>()
  for (const row of rows) {
    if (!row.episodeKey) continue
    const previous = byEpisode.get(row.episodeKey)
    if (!previous || row.eventDate < previous.eventDate
      || (row.eventDate === previous.eventDate
        && Number.parseInt(row.eventKey.slice(1), 36) < Number.parseInt(previous.eventKey.slice(1), 36))) {
      byEpisode.set(row.episodeKey, row)
    }
  }
  return [...byEpisode.values()]
}

function addSummary(accumulator: OutcomeSummaryAccumulator, row: PathResearchRow, horizon: TriggerOutcomeHorizon): void {
  const saved = row.outcome
  if (selectedPath(row, horizon)) addOutcomeRowToSummary(accumulator, saved)
  else addOutcomeRowToSummary(accumulator, { ...saved, [`availability${horizon}`]: 'INSUFFICIENT_FUTURE_DATA' })
}

export function aggregatePathResearch(input: {
  rows: readonly PathResearchRow[]
  manifest: { jobId: string; outcomeJobId: string; analysisCutoffDate: string; eventSelector: string;
    timeframe: 'MONTHLY' | 'BIWEEKLY'; ma1Period: number; ma2Period: number; sourceObservationCount: number }
  dimensions: readonly PathResearchDimension[]; horizon: TriggerOutcomeHorizon
  unit: PathResearchUnit; cohort: PathResearchCohort | null
}): PathResearchSegmentsResponse {
  const observed = selectedRows(input.rows, input.unit).filter((row) => cohortMatches(row.outcome, input.cohort))
  const anchorSemanticsCounts = {
    EVENT_SAVED_PRICE: observed.filter((row) => row.anchorSemantics === 'EVENT_SAVED_PRICE').length,
    PREVIOUS_CANDIDATE_SAVED_PRICE: observed.filter((row) => row.anchorSemantics === 'PREVIOUS_CANDIDATE_SAVED_PRICE').length,
  }
  const overall = createOutcomeSummaryAccumulator([input.horizon])
  const order = Object.fromEntries(input.dimensions.map((dimension) => [dimension, dimensionOrder(dimension)]))
  const groups = new Map<string, { keys: Record<string, string>; summary: OutcomeSummaryAccumulator }>()
  let excludedForMissingFixedPath = 0
  for (const row of observed) {
    const fixed = selectedPath(row, input.horizon)
    if (!fixed) excludedForMissingFixedPath += 1
    addSummary(overall, row, input.horizon)
    const values = input.dimensions.map((dimension) => isPathDimension(dimension)
      ? pathBand(fixed, dimension) : dimensionValue(row.outcome, dimension))
    const id = JSON.stringify(values)
    let group = groups.get(id)
    if (!group) {
      group = { keys: Object.fromEntries(input.dimensions.map((dimension, index) => [dimension, values[index]])),
        summary: createOutcomeSummaryAccumulator([input.horizon]) }
      groups.set(id, group)
    }
    addSummary(group.summary, row, input.horizon)
  }
  const ordered = [...groups.values()].sort((left, right) => {
    for (const dimension of input.dimensions) {
      const difference = order[dimension].indexOf(left.keys[dimension]) - order[dimension].indexOf(right.keys[dimension])
      if (difference) return difference
    }
    return 0
  })
  const groupResults = ordered.map(({ keys, summary }) => {
    const horizon = finalizeOutcomeSummary(summary)[0]
    return { keys, eventCount: summary.rowCount, uniqueTickerCount: summary.tickers.size,
      horizon, smallSample: horizon.eligibleCount < 30 }
  })
  const overallHorizon = finalizeOutcomeSummary(overall)[0]
  return {
    contractVersion: PATH_RESEARCH_CONTRACT_VERSION,
    meta: {
      pathSegmentationVersion: PATH_SEGMENTATION_VERSION,
      outcomeJobId: input.manifest.outcomeJobId, jobId: input.manifest.jobId,
      analysisCutoffDate: input.manifest.analysisCutoffDate, eventSelector: input.manifest.eventSelector,
      timeframe: input.manifest.timeframe, ma1Period: input.manifest.ma1Period, ma2Period: input.manifest.ma2Period,
      horizon: input.horizon, dimensions: [...input.dimensions], unit: input.unit,
      outcomeConditioned: input.cohort != null, cohort: input.cohort,
      sourceObservationCount: input.manifest.sourceObservationCount,
      selectedObservationCount: observed.length, anchorSemanticsCounts, excludedForMissingFixedPath,
      excludedForEpisodeMapping: input.unit === 'EPISODE' ? input.rows.filter((row) => !row.episodeKey).length : 0,
      postEventDescriptiveOnly: true, smallSampleThreshold: 30, bandOrder: order,
    },
    overall: { eventCount: overall.rowCount, uniqueTickerCount: overall.tickers.size, horizon: overallHorizon },
    groups: groupResults,
    integrity: {
      groupCountMatchesOverall: groupResults.reduce((sum, group) => sum + group.eventCount, 0) === overall.rowCount,
      eligibleCountsMatchOverall: groupResults.reduce((sum, group) => sum + group.horizon.eligibleCount, 0) === overallHorizon.eligibleCount,
      sourceRowsComplete: input.rows.length === input.manifest.sourceObservationCount,
    },
  }
}

export async function getPathResearchSegments(jobId: string, query: ReturnType<typeof parsePathResearchQuery>) {
  const artifact = await getPathResearchArtifact(jobId)
  if (artifact === null || typeof artifact === 'string') return artifact
  const rows: PathResearchRow[] = []
  const stream = createReadStream(/* turbopackIgnore: true */ artifact.rowsFile, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  try { for await (const line of lines) if (line) rows.push(JSON.parse(line) as PathResearchRow) }
  finally { lines.close(); stream.destroy() }
  return aggregatePathResearch({ rows, manifest: artifact.manifest, ...query })
}
