import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { execGet, execRun } from '@/lib/db/client'
import { historicalScanResultPaths } from '@/lib/server/trigger-discovery-historical-scan-jobs'
import { aggregateOutcomeRows } from '@/lib/server/trigger-discovery-outcome-analysis'
import { outcomeResultPaths } from '@/lib/server/trigger-discovery-outcome-jobs'
import {
  assignOutcomeRowsToEpisodes,
  getOutcomeRobustness,
  parseOutcomeRobustnessDimensions,
  TriggerOutcomeSegmentationInputError,
} from '@/lib/server/trigger-discovery-outcome-robustness'
import type {
  TriggerHistoricalScanEvent,
  TriggerHistoricalScanResponse,
} from '@/lib/trigger-discovery-historical-scan-contract'
import type {
  TriggerOutcomeHorizon,
  TriggerOutcomeManifest,
  TriggerOutcomeRequest,
  TriggerOutcomeRow,
} from '@/lib/trigger-discovery-outcome-contract'
import type { TriggerScoreBreakdown } from '@/lib/trigger-score'

const HORIZONS = [20, 60, 120, 245] as const
const SIDE_EFFECT_TABLES = [
  'trigger_evaluations',
  'trigger_evaluation_members',
  'trigger_lifecycle_events',
  'notification_outbox',
  'notification_delivery_attempts',
] as const

function scoreBreakdown(total: number): TriggerScoreBreakdown {
  return {
    proximity: 20,
    approach: 10,
    maTrend: 10,
    stageStructure: 10,
    liquidity: Math.max(0, total - 50),
    total,
    stageCoverage: 1,
    stageAvailableAxes: 6,
    maximums: { proximity: 30, approach: 20, maTrend: 20, stageStructure: 20, liquidity: 10 },
    explanations: {
      proximity: 'fixture', approach: 'fixture', maTrend: 'fixture',
      stageStructure: 'fixture', liquidity: 'fixture',
    },
  }
}

function event(input: {
  date: string
  ticker?: string
  eventType: TriggerHistoricalScanEvent['eventType']
  previousStatus?: TriggerHistoricalScanEvent['previousStatus']
  currentStatus?: TriggerHistoricalScanEvent['currentStatus']
  score?: number
  weekAStage?: number | null
  monthAStage?: number | null
}): TriggerHistoricalScanEvent {
  const ticker = input.ticker ?? '7003'
  const currentStatus = input.currentStatus ?? null
  const previousStatus = input.previousStatus ?? null
  const score = input.score ?? 65
  return {
    date: input.date,
    ticker,
    companyName: `Fixture ${ticker}`,
    eventType: input.eventType,
    previousStatus,
    currentStatus,
    snapshotBasis: input.eventType === 'EXITED' ? 'PREVIOUS' : 'CURRENT',
    price: 100,
    ma1: 95,
    ma2: 90,
    zoneDistancePct: 1,
    triggerScore: score,
    scoreBreakdown: scoreBreakdown(score),
    priceDate: input.date,
    maDate: input.date,
    stageDate: input.date,
    dayAStage: 1,
    dayBStage: 2,
    weekAStage: input.weekAStage ?? 3,
    weekBStage: 4,
    monthAStage: input.monthAStage ?? 5,
    monthBStage: 6,
  }
}

function outcome(source: TriggerHistoricalScanEvent, value: number, input: {
  available120?: boolean
  available245?: boolean
} = {}): TriggerOutcomeRow {
  const available120 = input.available120 ?? true
  const available245 = input.available245 ?? false
  return {
    eventDate: source.date,
    ticker: source.ticker,
    companyName: source.companyName,
    eventType: source.eventType,
    previousStatus: source.previousStatus,
    currentStatus: source.currentStatus,
    anchorPrice: source.price,
    triggerScore: source.triggerScore,
    dayAStage: source.dayAStage,
    dayBStage: source.dayBStage,
    weekAStage: source.weekAStage,
    weekBStage: source.weekBStage,
    monthAStage: source.monthAStage,
    monthBStage: source.monthBStage,
    return20: value,
    return60: value + 0.01,
    return120: available120 ? value + 0.02 : null,
    return245: available245 ? value + 0.03 : null,
    mfe20: value + 0.1,
    mfe60: value + 0.11,
    mfe120: available120 ? value + 0.12 : null,
    mfe245: available245 ? value + 0.13 : null,
    mae20: value - 0.1,
    mae60: value - 0.11,
    mae120: available120 ? value - 0.12 : null,
    mae245: available245 ? value - 0.13 : null,
    availability20: 'AVAILABLE',
    availability60: 'AVAILABLE',
    availability120: available120 ? 'AVAILABLE' : 'INSUFFICIENT_FUTURE_DATA',
    availability245: available245 ? 'AVAILABLE' : 'INSUFFICIENT_FUTURE_DATA',
  }
}

function historicalManifest(timeframe: 'MONTHLY' | 'BIWEEKLY'): TriggerHistoricalScanResponse {
  return {
    contractVersion: 'trigger-discovery-historical-scan-v1',
    scanMeta: {
      requestedStartDate: '2025-01-01', resolvedStartDate: '2025-01-02',
      requestedEndDate: '2025-12-31', resolvedEndDate: '2025-12-30',
      tradingDayCount: 240, processedTradingDays: 240, timeframe,
      ma1Period: 20, ma2Period: 25, sampling: 'EACH_MARKET_TRADING_DAY',
      baselineDate: '2024-12-30', baselineCandidateCount: 1,
      universeContract: 'reconstructed_from_currently_held_trade_history',
      universeNote: 'Robustness fixture universe.',
    },
    criteria: {
      maxApproachDistancePct: 5, nearDistancePct: 2,
      liquidityLookbackSessions: 20, maxPriceStalenessSessions: 3,
      markets: null, priceMin: null, priceMax: null,
      averageVolumeMin: null, averageVolumeMax: null,
      averageTradingValueMin: null, averageTradingValueMax: null,
      stageFilters: {},
    },
    summary: {
      tradingDays: 240, uniqueCandidateCount: 2, enteredCount: 1, reEntryCount: 1,
      statusChangeCount: 6, exitedCount: 2, totalEventCount: 10,
      maxDailyCandidates: 2, averageDailyCandidates: 1,
    },
    dailyCounts: [], events: [],
    eventPage: { offset: 0, limit: 0, returnedCount: 0, totalCount: 10, hasMore: true },
    performance: {
      totalMs: 0, queryCount: 0, tradingDays: 240, sourceTickerCount: 2,
      sourceRows: { ohlcv: 0, storedMonthlyMa: 0, weeklyOhlcv: 0, stage: 0 },
      sqlMs: { marketSessions: 0, universe: 0, ohlcv: 0, storedMonthlyMa: 0, weeklyOhlcv: 0, stage: 0, total: 0 },
      seriesBuildMs: 0, maPreparationMs: 0, liquidityMs: 0, universeFilterMs: 0,
      triggerEngineMs: 0, stageJoinMs: 0, scoreMs: 0, eventDerivationMs: 0,
      peakHeapBytes: 0, peakRssBytes: 0, heapDeltaBytes: 0,
    },
  }
}

async function writeFixture(input: {
  events: TriggerHistoricalScanEvent[]
  rows: TriggerOutcomeRow[]
  eventFilter: TriggerOutcomeRequest['eventFilter']
  timeframe?: 'MONTHLY' | 'BIWEEKLY'
}): Promise<{ historicalId: string; outcomeId: string; files: string[] }> {
  const historicalId = randomUUID()
  const outcomeId = randomUUID()
  const now = Math.floor(Date.now() / 1_000)
  const timeframe = input.timeframe ?? 'MONTHLY'
  const request: TriggerOutcomeRequest = {
    historicalScanJobId: historicalId,
    eventFilter: input.eventFilter,
    horizons: [...HORIZONS],
    ticker: null,
    triggerScoreMin: null,
    triggerScoreMax: null,
    stageFilters: {},
  }
  const manifest: TriggerOutcomeManifest = {
    contractVersion: 'trigger-discovery-outcome-v1',
    outcomeJobId: outcomeId,
    historicalScanJobId: historicalId,
    sourceFingerprint: 'robustness-fixture',
    request,
    metadata: {
      analysisCutoffDate: '2026-09-11', sourceTimeframe: timeframe,
      adjustmentBasis: 'JQUANTS_ADJUSTED_OHLCV',
      anchorPriceBasis: 'HISTORICAL_EVENT_CLOSE',
      excursionWindow: 'NEXT_SESSION_THROUGH_HORIZON',
      observationIndependenceNote: 'Fixture repeated events.',
    },
    summary: {
      selectedEventCount: input.rows.length,
      uniqueTickerCount: new Set(input.rows.map((row) => row.ticker)).size,
      horizons: aggregateOutcomeRows(input.rows, HORIZONS),
    },
    performance: {
      totalMs: 0, sqlMs: 0, calculationMs: 0, aggregationMs: 0,
      serializationMs: 0, saveMs: 0, queryCount: 0,
      selectedEventCount: input.rows.length,
      uniqueTickerCount: new Set(input.rows.map((row) => row.ticker)).size,
      ohlcvRowCount: 0, peakHeapBytes: 0, peakRssBytes: 0,
    },
    generatedAt: new Date().toISOString(),
  }
  await execRun(`INSERT INTO historical_trigger_scan_jobs (
    id,status,request_json,request_signature,source_fingerprint,requested_start,requested_end,
    resolved_start,resolved_end,timeframe,created_at,completed_at,result_location,result_size_bytes,expires_at
  ) VALUES (?, 'COMPLETED', '{}', 'robustness-source', 'robustness-source', '2025-01-01', '2025-12-31',
    '2025-01-02', '2025-12-30', ?, ?, ?, ?, 1, ?)`,
  [historicalId, timeframe, now, now, historicalId, now + 86_400])
  await execRun(`INSERT INTO trigger_outcome_analysis_jobs (
    id,status,historical_scan_job_id,request_json,request_signature,source_fingerprint,
    analysis_cutoff_date,created_at,completed_at,total_events,processed_events,total_tickers,
    processed_tickers,result_location,result_size_bytes,expires_at
  ) VALUES (?, 'COMPLETED', ?, ?, 'robustness-request', 'robustness-fixture', '2026-09-11',
    ?, ?, ?, ?, ?, ?, ?, 1, ?)`, [
    outcomeId, historicalId, JSON.stringify(request), now, now,
    input.rows.length, input.rows.length, manifest.summary.uniqueTickerCount,
    manifest.summary.uniqueTickerCount, outcomeId, now + 86_400,
  ])
  const historicalPaths = historicalScanResultPaths(historicalId)
  const outcomePaths = outcomeResultPaths(outcomeId)
  await mkdir(historicalPaths.manifest.slice(0, historicalPaths.manifest.lastIndexOf('/')), { recursive: true })
  await mkdir(outcomePaths.manifest.slice(0, outcomePaths.manifest.lastIndexOf('/')), { recursive: true })
  const eventPayload = `${input.events.map((item) => JSON.stringify(item)).join('\n')}\n`
  const outcomePayload = `${input.rows.map((item) => JSON.stringify(item)).join('\n')}\n`
  await writeFile(historicalPaths.manifest, JSON.stringify(historicalManifest(timeframe)))
  await writeFile(historicalPaths.events, eventPayload)
  await writeFile(outcomePaths.manifest, JSON.stringify(manifest))
  await writeFile(outcomePaths.rowsByDate, outcomePayload)
  await writeFile(outcomePaths.rowsByTicker, outcomePayload)
  return {
    historicalId,
    outcomeId,
    files: [historicalPaths.manifest, historicalPaths.events,
      outcomePaths.manifest, outcomePaths.rowsByDate, outcomePaths.rowsByTicker],
  }
}

async function sha256(file: string): Promise<string> {
  return createHash('sha256').update(await readFile(file)).digest('hex')
}

async function sideEffects(): Promise<Record<string, number>> {
  const values: Record<string, number> = {}
  for (const table of SIDE_EFFECT_TABLES) {
    values[table] = Number((await execGet<{ count: number }>(
      `SELECT COUNT(*) AS count FROM ${table}`,
    ))?.count ?? 0)
  }
  return values
}

async function cleanup(fixtures: Array<{ historicalId: string; outcomeId: string }>): Promise<void> {
  for (const fixture of fixtures) {
    await Promise.all(Object.values(historicalScanResultPaths(fixture.historicalId))
      .map((file) => rm(file, { force: true })))
    await Promise.all(Object.values(outcomeResultPaths(fixture.outcomeId))
      .map((file) => rm(file, { force: true })))
  }
  await execRun('DELETE FROM trigger_outcome_analysis_jobs')
  await execRun('DELETE FROM historical_trigger_scan_jobs')
}

function horizon<T extends { horizonSessions: TriggerOutcomeHorizon }>(
  values: readonly T[],
  sessions: TriggerOutcomeHorizon,
): T {
  return values.find((value) => value.horizonSessions === sessions)!
}

async function main(): Promise<void> {
  await cleanup([])
  const fixtures: Array<{ historicalId: string; outcomeId: string; files: string[] }> = []
  const effectsBefore = await sideEffects()
  assert.deepEqual(parseOutcomeRobustnessDimensions([]), [])
  assert.deepEqual(parseOutcomeRobustnessDimensions(['scoreBand']), ['scoreBand'])
  assert.throws(
    () => parseOutcomeRobustnessDimensions(['scoreBand', 'stage:weekA', 'stage:monthA']),
    TriggerOutcomeSegmentationInputError,
  )

  const lifecycle = [
    event({ date: '2025-01-02', eventType: 'ENTERED', currentStatus: 'APPROACHING' }),
    event({ date: '2025-01-03', eventType: 'STATUS_CHANGED', previousStatus: 'APPROACHING', currentStatus: 'NEAR', score: 35, weekAStage: 1 }),
    event({ date: '2025-01-06', eventType: 'STATUS_CHANGED', previousStatus: 'NEAR', currentStatus: 'IN_ZONE' }),
    event({ date: '2025-01-07', eventType: 'STATUS_CHANGED', previousStatus: 'IN_ZONE', currentStatus: 'NEAR', score: 65, weekAStage: 2 }),
    event({ date: '2025-01-08', eventType: 'STATUS_CHANGED', previousStatus: 'NEAR', currentStatus: 'IN_ZONE' }),
    event({ date: '2025-01-09', eventType: 'EXITED', previousStatus: 'IN_ZONE' }),
    event({ date: '2025-01-10', eventType: 'RE_ENTRY', currentStatus: 'APPROACHING' }),
    event({ date: '2025-01-13', eventType: 'STATUS_CHANGED', previousStatus: 'APPROACHING', currentStatus: 'NEAR', score: 85, weekAStage: 3 }),
  ]
  const selected = [
    outcome(lifecycle[1]!, 0.1, { available120: false }),
    outcome(lifecycle[3]!, 0.3),
    outcome(lifecycle[7]!, 0.5),
  ]
  const direct = assignOutcomeRowsToEpisodes({ rows: selected, historicalEvents: lifecycle })
  assert.equal(direct.observations.length, 3)
  assert.equal(new Set(direct.observations.map((item) => item.episodeId)).size, 2)
  assert.equal(new Set(direct.observations.map((item) => item.row.ticker)).size, 1)

  const baselineNear = event({
    date: '2025-01-03', ticker: '7203', eventType: 'STATUS_CHANGED',
    previousStatus: 'APPROACHING', currentStatus: 'NEAR', score: 55,
  })
  const baselineExit = event({
    date: '2025-01-09', ticker: '7203', eventType: 'EXITED', previousStatus: 'NEAR',
  })
  const baselineDirect = assignOutcomeRowsToEpisodes({
    rows: [outcome(baselineNear, 0.2, { available120: false })],
    historicalEvents: [baselineNear, baselineExit],
  })
  assert.equal(baselineDirect.syntheticBaselineEpisodeCount, 1)
  assert.equal(baselineDirect.observations[0]?.syntheticBaseline, true)

  const repeatedFixture = await writeFixture({
    events: [...lifecycle, baselineNear, baselineExit].sort((left, right) => (
      left.date.localeCompare(right.date) || left.ticker.localeCompare(right.ticker)
    )),
    rows: [...selected, outcome(baselineNear, 0.2, { available120: false })].sort(
      (left, right) => left.eventDate.localeCompare(right.eventDate) || left.ticker.localeCompare(right.ticker),
    ),
    eventFilter: 'NEAR_ENTERED',
  })
  fixtures.push(repeatedFixture)
  const hashesBefore = await Promise.all(repeatedFixture.files.map(sha256))
  const result = await getOutcomeRobustness({ outcomeJobId: repeatedFixture.outcomeId })
  assert.equal(result.overall.diagnostics.sourceEventCount, 4)
  assert.equal(result.overall.diagnostics.episodeObservationCount, 3)
  assert.equal(result.overall.diagnostics.uniqueTickerCount, 2)
  assert.equal(result.overall.diagnostics.syntheticBaselineEpisodeCount, 1)
  assert.equal(result.overall.diagnostics.selectedSyntheticBaselineEpisodeCount, 1)
  assert.equal(result.overall.units.EVENT.observationCount, 4)
  assert.equal(result.overall.units.EPISODE.observationCount, 3)
  assert.equal(result.overall.units.TICKER_EQUAL_WEIGHT.observationCount, 2)
  assert.equal(result.overall.countInvariant, true)
  assert.equal(result.integrity.eventSummaryMatchesSavedOutcome, true)
  assert.equal(result.integrity.sourceRowsMatchedToHistoricalEvents, true)
  assert.equal(result.meta.performance.ohlcvQueryCount, 0)
  assert.equal(result.meta.performance.dbQueryCount, 1)
  assert.equal(result.meta.performance.outcomeRowsRead, 4)
  assert.equal(result.meta.performance.historicalEventsRead, 10)
  assert.equal(horizon(result.overall.units.EVENT.horizons, 120).eligibleCount, 2)
  assert.equal(horizon(result.overall.units.EPISODE.horizons, 120).eligibleCount, 1)
  assert.equal(horizon(result.overall.units.TICKER_EQUAL_WEIGHT.horizons, 120).eligibleCount, 1)
  assert.equal(horizon(result.overall.units.TICKER_EQUAL_WEIGHT.horizons, 120).unavailableCount, 1)
  assert.equal(horizon(result.overall.units.TICKER_EQUAL_WEIGHT.horizons, 120).medianReturn, 0.52)

  for (const dimension of [
    'scoreBand', 'stage:dayA', 'stage:dayB', 'stage:weekA',
    'stage:weekB', 'stage:monthA', 'stage:monthB',
  ] as const) {
    const segmented = await getOutcomeRobustness({
      outcomeJobId: repeatedFixture.outcomeId,
      dimensions: [dimension],
    })
    assert.equal(segmented.integrity.segmentCountInvariants, true)
    assert.equal(segmented.segmentation?.groups.length, dimension === 'scoreBand' ? 5 : 7)
  }
  const pair = await getOutcomeRobustness({
    outcomeJobId: repeatedFixture.outcomeId,
    dimensions: ['stage:weekA', 'stage:monthA'],
  })
  assert.equal(pair.segmentation?.groups.length, 49)
  assert.equal(pair.integrity.segmentCountInvariants, true)
  const hashesAfter = await Promise.all(repeatedFixture.files.map(sha256))
  assert.deepEqual(hashesAfter, hashesBefore)

  const independentEvents = [
    event({ date: '2025-02-03', ticker: '1001', eventType: 'ENTERED', currentStatus: 'NEAR' }),
    event({ date: '2025-02-04', ticker: '1002', eventType: 'ENTERED', currentStatus: 'NEAR' }),
    event({ date: '2025-02-05', ticker: '1003', eventType: 'ENTERED', currentStatus: 'NEAR' }),
  ]
  const independentRows = independentEvents.map((item, index) => outcome(item, 0.1 * (index + 1)))
  const independentFixture = await writeFixture({
    events: independentEvents,
    rows: independentRows,
    eventFilter: 'ALL',
  })
  fixtures.push(independentFixture)
  const independent = await getOutcomeRobustness({ outcomeJobId: independentFixture.outcomeId })
  assert.deepEqual(independent.overall.units.EVENT.horizons, independent.overall.units.EPISODE.horizons)
  assert.deepEqual(independent.overall.units.EPISODE.horizons, independent.overall.units.TICKER_EQUAL_WEIGHT.horizons)
  assert.equal(independent.overall.units.EVENT.observationCount, 3)
  assert.equal(independent.overall.units.EPISODE.observationCount, 3)
  assert.equal(independent.overall.units.TICKER_EQUAL_WEIGHT.observationCount, 3)

  assert.deepEqual(await sideEffects(), effectsBefore)
  console.log(JSON.stringify({
    passed: true,
    fixture: { EVENT: 3, EPISODE: 2, TICKER_EQUAL_WEIGHT: 1 },
    baselineSyntheticEpisode: true,
    repeatedApiCounts: {
      EVENT: result.overall.units.EVENT.observationCount,
      EPISODE: result.overall.units.EPISODE.observationCount,
      TICKER_EQUAL_WEIGHT: result.overall.units.TICKER_EQUAL_WEIGHT.observationCount,
    },
    noDuplicationModesEqual: true,
    stageAxesChecked: 6,
    pairCellsChecked: pair.segmentation?.groups.length,
    ohlcvQueries: result.meta.performance.ohlcvQueryCount,
    artifactHashesUnchanged: true,
    sideEffectsUnchanged: true,
  }, null, 2))
  await cleanup(fixtures)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
