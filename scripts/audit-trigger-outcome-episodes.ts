import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { historicalScanResultPaths } from '@/lib/server/trigger-discovery-historical-scan-jobs'
import { outcomeResultPaths } from '@/lib/server/trigger-discovery-outcome-jobs'
import { getOutcomeRobustness } from '@/lib/server/trigger-discovery-outcome-robustness'
import { dimensionValue } from '@/lib/server/trigger-discovery-outcome-segmentation'
import type { TriggerHistoricalScanEvent, TriggerHistoricalScanResponse } from '@/lib/trigger-discovery-historical-scan-contract'
import type {
  TriggerOutcomeHorizon, TriggerOutcomeManifest, TriggerOutcomeRow,
} from '@/lib/trigger-discovery-outcome-contract'
import type { TriggerOutcomeEpisodeMetadata } from '@/lib/trigger-discovery-outcome-robustness'
import type { TriggerOutcomeSegmentDimension } from '@/lib/trigger-discovery-outcome-segmentation'

function identity(input: TriggerHistoricalScanEvent | TriggerOutcomeRow): string {
  const event = 'eventDate' in input ? input as TriggerOutcomeRow : null
  const source = event ? null : input as TriggerHistoricalScanEvent
  return JSON.stringify([
    event?.eventDate ?? source?.date, input.ticker, input.eventType,
    input.previousStatus, input.currentStatus,
    event?.anchorPrice ?? source?.price, input.triggerScore,
    input.dayAStage, input.dayBStage, input.weekAStage,
    input.weekBStage, input.monthAStage, input.monthBStage,
  ])
}

function hash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function equalNumber(left: number | null, right: number | null, label: string): void {
  if (left == null || right == null) assert.equal(left, right, label)
  else assert.ok(Math.abs(left - right) <= 1e-12, `${label}: ${left} != ${right}`)
}

function independentQuantile(values: number[], probability: number): number | null {
  if (values.length === 0) return null
  const sorted = values.toSorted((a, b) => a - b)
  const rank = (sorted.length - 1) * probability
  const lower = Math.floor(rank)
  return sorted[lower]! + (sorted[Math.ceil(rank)]! - sorted[lower]!) * (rank - lower)
}

function independentSummary(rows: TriggerOutcomeRow[], horizon: TriggerOutcomeHorizon) {
  const eligible = rows.filter((row) => row[`availability${horizon}`] === 'AVAILABLE')
  const returns = eligible.map((row) => row[`return${horizon}`]).filter((value): value is number => value !== null)
  const mfe = eligible.map((row) => row[`mfe${horizon}`]).filter((value): value is number => value !== null)
  const mae = eligible.map((row) => row[`mae${horizon}`]).filter((value): value is number => value !== null)
  return {
    total: rows.length,
    eligibleCount: eligible.length,
    unavailableCount: rows.length - eligible.length,
    meanReturn: returns.length ? returns.reduce((sum, value) => sum + value, 0) / returns.length : null,
    medianReturn: independentQuantile(returns, 0.5),
    positiveReturnRatio: returns.length ? returns.filter((value) => value > 0).length / returns.length : null,
    p25Return: independentQuantile(returns, 0.25),
    p75Return: independentQuantile(returns, 0.75),
    medianMfe: independentQuantile(mfe, 0.5),
    medianMae: independentQuantile(mae, 0.5),
  }
}

function checkSummary(
  observed: ReturnType<typeof independentSummary>,
  expected: ReturnType<typeof independentSummary>,
  label: string,
): void {
  assert.equal(observed.total, expected.total, `${label}/total`)
  assert.equal(observed.eligibleCount, expected.eligibleCount, `${label}/eligible`)
  assert.equal(observed.unavailableCount, expected.unavailableCount, `${label}/unavailable`)
  for (const key of ['meanReturn', 'medianReturn', 'positiveReturnRatio',
    'p25Return', 'p75Return', 'medianMfe', 'medianMae'] as const) {
    equalNumber(observed[key], expected[key], `${label}/${key}`)
  }
}

async function audit(jobId: string): Promise<Record<string, unknown>> {
  const outcomeFiles = outcomeResultPaths(jobId)
  const outcomeManifestBytes = await readFile(outcomeFiles.manifest)
  const manifest = JSON.parse(outcomeManifestBytes.toString()) as TriggerOutcomeManifest
  const historicalFiles = historicalScanResultPaths(manifest.historicalScanJobId)
  const sourceFiles = [
    outcomeFiles.manifest, outcomeFiles.rowsByDate,
    historicalFiles.manifest, historicalFiles.events,
  ]
  const sourceHashes = await Promise.all(sourceFiles.map(async (file) => hash(await readFile(file))))
  const historical = JSON.parse((await readFile(historicalFiles.manifest)).toString()) as TriggerHistoricalScanResponse
  const rows = (await readFile(outcomeFiles.rowsByDate, 'utf8')).split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as TriggerOutcomeRow)
  const rowByIdentity = new Map<string, TriggerOutcomeRow>()
  for (const row of rows) {
    const key = identity(row)
    assert.ok(!rowByIdentity.has(key), `duplicate Outcome identity: ${row.ticker}/${row.eventDate}`)
    rowByIdentity.set(key, row)
  }

  type IndependentEpisode = {
    metadata: TriggerOutcomeEpisodeMetadata
    selectedRows: TriggerOutcomeRow[]
  }
  const episodes: IndependentEpisode[] = []
  const active = new Map<string, IndependentEpisode>()
  const seen = new Set<string>()
  const ordinal = new Map<string, number>()
  const mapped = new Set<string>()
  let sequence = 0
  let priorDate = ''
  for (const line of (await readFile(historicalFiles.events, 'utf8')).split('\n')) {
    if (!line) continue
    const event = JSON.parse(line) as TriggerHistoricalScanEvent
    sequence += 1
    assert.ok(event.date >= priorDate, `source order inversion at ${sequence}`)
    priorDate = event.date
    let episode = active.get(event.ticker)
    if (event.eventType === 'ENTERED' || event.eventType === 'RE_ENTRY') {
      assert.ok(!episode, `entry while active: ${event.ticker}/${event.date}`)
    } else if (!episode) {
      assert.ok(!seen.has(event.ticker), `event after exit without re-entry: ${event.ticker}/${event.date}`)
    }
    if (!episode) {
      const left = event.eventType === 'STATUS_CHANGED' || event.eventType === 'EXITED'
      const n = (ordinal.get(event.ticker) ?? 0) + 1
      ordinal.set(event.ticker, n)
      seen.add(event.ticker)
      episode = {
        metadata: {
          episodeKey: `${manifest.historicalScanJobId}:${event.ticker}:${n}`,
          ticker: event.ticker,
          observedEpisodeStartDate: left ? null : event.date,
          observedFromDate: left ? historical.scanMeta.resolvedStartDate ?? historical.scanMeta.requestedStartDate : event.date,
          episodeEndDate: null,
          leftCensored: left,
          rightCensored: false,
          startEventType: event.eventType,
          selectedEventCount: 0,
          selectedAnchorEventDate: null,
          selectedAnchorEventType: null,
          selectedAnchorSourceSequence: null,
          excludedForSequenceIntegrity: false,
          excludedForMappingIntegrity: false,
        },
        selectedRows: [],
      }
      episodes.push(episode)
      active.set(event.ticker, episode)
    }
    assert.ok(episode)
    const key = identity(event)
    const row = rowByIdentity.get(key)
    if (row) {
      assert.ok(!mapped.has(key), `ambiguous source event: ${event.ticker}/${event.date}`)
      mapped.add(key)
      episode.selectedRows.push(row)
      episode.metadata.selectedEventCount += 1
      if (episode.metadata.selectedAnchorSourceSequence === null) {
        episode.metadata.selectedAnchorSourceSequence = sequence
        episode.metadata.selectedAnchorEventDate = event.date
        episode.metadata.selectedAnchorEventType = event.eventType
      }
    }
    if (event.eventType === 'EXITED') {
      episode.metadata.episodeEndDate = event.date
      active.delete(event.ticker)
    }
  }
  for (const episode of active.values()) episode.metadata.rightCensored = true
  assert.equal(mapped.size, rows.length, 'all saved Outcome rows must map to one source event')
  const anchors = episodes.flatMap((episode) => episode.selectedRows.slice(0, 1))
  const result = await getOutcomeRobustness({ outcomeJobId: jobId, episodeLimit: 100 })
  assert.equal(result.episodeDiagnostics.sequenceAnomalyCount, 0)
  assert.equal(result.episodeDiagnostics.unmappedOutcomeRows, 0)
  assert.equal(result.episodeDiagnostics.ambiguousOutcomeRows, 0)
  assert.equal(result.episodeDiagnostics.observedEpisodeCount, episodes.length)
  assert.equal(result.overall.units.EVENT.observationCount, rows.length)
  assert.equal(result.overall.units.EPISODE.observationCount, anchors.length)
  assert.equal(result.integrity.eventSummaryMatchesSavedOutcome, true)
  let countToCheck = 0
  let selectedChecked = 0
  while (selectedChecked < 30 && countToCheck < episodes.length) {
    const page = countToCheck === 0 ? result : await getOutcomeRobustness({
      outcomeJobId: jobId, episodeOffset: countToCheck, episodeLimit: 100,
    })
    const actual = page.episodePage.episodes
    assert.deepEqual(actual, episodes.slice(countToCheck, countToCheck + actual.length)
      .map((item) => item.metadata))
    selectedChecked += actual.filter((episode) => episode.selectedEventCount > 0).length
    countToCheck += actual.length
    assert.ok(actual.length > 0, 'episode page made no progress')
  }
  assert.ok(selectedChecked >= 30, `expected 30 selected episode anchors, got ${selectedChecked}`)
  for (const unit of ['EVENT', 'EPISODE'] as const) {
    const unitRows = unit === 'EVENT' ? rows : anchors
    const actual = result.overall.units[unit]
    assert.equal(actual.uniqueTickerCount, new Set(unitRows.map((row) => row.ticker)).size)
    for (const horizon of manifest.request.horizons) {
      const observed = actual.horizons.find((item) => item.horizonSessions === horizon)!
      checkSummary({ ...observed, total: observed.totalObservationCount },
        independentSummary(unitRows, horizon), `${unit}/${horizon}`)
    }
  }
  for (const dimensions of [
    ['scoreBand'], ['stage:monthA'], ['stage:weekA', 'stage:monthA'], ['spreadExpansion'],
  ] as TriggerOutcomeSegmentDimension[][]) {
    const segmented = await getOutcomeRobustness({ outcomeJobId: jobId, dimensions })
    for (const group of segmented.segmentation!.groups) {
      for (const unit of ['EVENT', 'EPISODE'] as const) {
        const source = unit === 'EVENT' ? rows : anchors
        const selected = source.filter((row) => dimensions.every((dimension) =>
          dimensionValue(row, dimension) === group.keys[dimension]))
        assert.equal(group.units[unit].observationCount, selected.length)
        assert.equal(group.units[unit].uniqueTickerCount,
          new Set(selected.map((row) => row.ticker)).size)
        for (const horizon of manifest.request.horizons) {
          const observed = group.units[unit].horizons.find((item) => item.horizonSessions === horizon)!
          checkSummary({ ...observed, total: observed.totalObservationCount },
            independentSummary(selected, horizon), `${dimensions}/${unit}/${horizon}/${JSON.stringify(group.keys)}`)
        }
      }
    }
    assert.equal(segmented.integrity.episodeSegmentCountMatchesOverall, true)
    assert.ok(Object.values(segmented.integrity.episodeSegmentEligibleMatchesOverall).every(Boolean))
    assert.ok(Object.values(segmented.integrity.episodeSegmentWeightedMeanMatchesOverall).every(Boolean))
  }
  const hashesAfter = await Promise.all(sourceFiles.map(async (file) => hash(await readFile(file))))
  assert.deepEqual(hashesAfter, sourceHashes, 'source artifacts must remain unchanged')
  return {
    jobId,
    selector: manifest.request.eventFilter,
    timeframe: manifest.metadata.sourceTimeframe,
    scanPeriod: historical.scanMeta,
    eventObservations: rows.length,
    episodeObservations: anchors.length,
    uniqueTickers: result.overall.units.EPISODE.uniqueTickerCount,
    firstEpisodesCrossChecked: countToCheck,
    selectedEpisodesCrossChecked: selectedChecked,
    diagnostics: result.episodeDiagnostics,
    eventHorizons: result.overall.units.EVENT.horizons,
    episodeHorizons: result.overall.units.EPISODE.horizons,
    performance: result.meta.performance,
    hashes: Object.fromEntries(sourceFiles.map((file, index) => [file, sourceHashes[index]])),
  }
}

async function main(): Promise<void> {
  const ids = process.argv.slice(2)
  assert.ok(ids.length > 0, 'usage: audit-trigger-outcome-episodes.ts OUTCOME_JOB_ID...')
  for (const id of ids) console.log(JSON.stringify(await audit(id)))
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
