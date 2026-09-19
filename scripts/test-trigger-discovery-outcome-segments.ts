import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { execGet, execRun } from '@/lib/db/client'
import { historicalScanResultPaths, historicalScanResultSignature } from '@/lib/server/trigger-discovery-historical-scan-jobs'
import { aggregateOutcomeRows } from '@/lib/server/trigger-discovery-outcome-analysis'
import { listRecentCompletedOutcomeJobs, outcomeResultPaths } from '@/lib/server/trigger-discovery-outcome-jobs'
import {
  aggregateOutcomeSegmentsFromRows,
  compareOutcomeSegments,
  getOutcomeSegmentation,
  parseOutcomeSegmentDimensions,
  parseOutcomeSegmentationUrl,
  scoreBandForOutcomeScore,
  TriggerOutcomeSegmentationInputError,
  TriggerOutcomeSegmentationSourceError,
} from '@/lib/server/trigger-discovery-outcome-segmentation'
import type { TriggerHistoricalScanResponse } from '@/lib/trigger-discovery-historical-scan-contract'
import type {
  TriggerOutcomeAvailability,
  TriggerOutcomeHorizon,
  TriggerOutcomeManifest,
  TriggerOutcomeRequest,
  TriggerOutcomeRow,
} from '@/lib/trigger-discovery-outcome-contract'
import type {
  TriggerOutcomeSegmentDimension,
  TriggerOutcomeSegmentGroup,
  TriggerOutcomeSegmentValue,
} from '@/lib/trigger-discovery-outcome-segmentation'

const SIDE_EFFECT_TABLES = [
  'trigger_evaluations',
  'trigger_evaluation_members',
  'trigger_lifecycle_events',
  'notification_outbox',
  'notification_delivery_attempts',
] as const

const HORIZONS = [20, 60, 120, 245] as const

function row(index: number, overrides: Partial<TriggerOutcomeRow> = {}): TriggerOutcomeRow {
  const available120 = index % 4 !== 0
  const available245 = index % 3 === 0
  const value = (index - 20) / 100
  return {
    eventDate: `2025-${String(1 + Math.floor(index / 27)).padStart(2, '0')}-${String(1 + (index % 27)).padStart(2, '0')}`,
    ticker: String(1000 + (index % 17)),
    companyName: `Segment Fixture ${index}`,
    eventType: 'STATUS_CHANGED',
    previousStatus: 'APPROACHING',
    currentStatus: 'NEAR',
    anchorPrice: 100 + index,
    triggerScore: index % 101,
    dayAStage: (index % 6) + 1,
    dayBStage: ((index + 1) % 6) + 1,
    weekAStage: ((index + 2) % 6) + 1,
    weekBStage: ((index + 3) % 6) + 1,
    monthAStage: index === 0 ? null : ((index + 4) % 6) + 1,
    monthBStage: ((index + 5) % 6) + 1,
    return20: value,
    return60: value * 1.5,
    return120: available120 ? value * 2 : null,
    return245: available245 ? value * 3 : null,
    mfe20: Math.abs(value) + 0.05,
    mfe60: Math.abs(value) + 0.08,
    mfe120: available120 ? Math.abs(value) + 0.12 : null,
    mfe245: available245 ? Math.abs(value) + 0.2 : null,
    mae20: -Math.abs(value) - 0.03,
    mae60: -Math.abs(value) - 0.05,
    mae120: available120 ? -Math.abs(value) - 0.08 : null,
    mae245: available245 ? -Math.abs(value) - 0.1 : null,
    availability20: 'AVAILABLE',
    availability60: 'AVAILABLE',
    availability120: available120 ? 'AVAILABLE' : 'INSUFFICIENT_FUTURE_DATA',
    availability245: available245 ? 'AVAILABLE' : 'INSUFFICIENT_FUTURE_DATA',
    ...overrides,
  }
}

function quantile(values: number[], probability: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const position = (sorted.length - 1) * probability
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower] ?? null
  return (sorted[lower] ?? 0) * (1 - (position - lower))
    + (sorted[upper] ?? 0) * (position - lower)
}

function independentSummary(rows: TriggerOutcomeRow[], horizon: TriggerOutcomeHorizon) {
  const eligible = rows.filter((item) => item[`availability${horizon}`] === 'AVAILABLE')
  const returns = eligible.map((item) => item[`return${horizon}`]).filter((value): value is number => value != null)
  const mfe = eligible.map((item) => item[`mfe${horizon}`]).filter((value): value is number => value != null)
  const mae = eligible.map((item) => item[`mae${horizon}`]).filter((value): value is number => value != null)
  const unavailableByReason: Partial<Record<TriggerOutcomeAvailability, number>> = {}
  for (const item of rows) {
    const availability = item[`availability${horizon}`]
    if (availability === 'AVAILABLE') continue
    unavailableByReason[availability] = (unavailableByReason[availability] ?? 0) + 1
  }
  return {
    totalEventCount: rows.length,
    eligibleCount: eligible.length,
    unavailableCount: rows.length - eligible.length,
    censoredCount: unavailableByReason.INSUFFICIENT_FUTURE_DATA ?? 0,
    unavailableByReason,
    meanReturn: returns.length ? returns.reduce((sum, value) => sum + value, 0) / returns.length : null,
    medianReturn: quantile(returns, 0.5),
    positiveReturnRatio: returns.length ? returns.filter((value) => value > 0).length / returns.length : null,
    p25Return: quantile(returns, 0.25),
    p75Return: quantile(returns, 0.75),
    medianMfe: quantile(mfe, 0.5),
    medianMae: quantile(mae, 0.5),
  }
}

function independentValue(item: TriggerOutcomeRow, dimension: TriggerOutcomeSegmentDimension): TriggerOutcomeSegmentValue {
  if (dimension === 'scoreBand') {
    const score = item.triggerScore as number | null
    if (score == null || !Number.isFinite(score) || score < 0 || score > 100) return 'UNKNOWN'
    if (score < 40) return 'LOW'
    if (score < 60) return 'MID_LOW'
    if (score < 80) return 'MID_HIGH'
    return 'HIGH'
  }
  if (dimension === 'spreadExpansion') {
    if (item.snapshotBasis !== 'CURRENT' || !item.spreadDiagnosticDate
      || item.spreadDiagnosticDate > item.eventDate || item.spreadExpansionAvailable !== true
      || typeof item.bullishMaOrder !== 'boolean' || !Number.isFinite(item.maSpreadPct)
      || !Number.isFinite(item.maSpreadSlope) || !Number.isFinite(item.maSpreadExpansionRatio)) return 'UNKNOWN'
    return item.spreadExpansionPass === true ? 'PASS' : item.spreadExpansionPass === false ? 'FAIL' : 'UNKNOWN'
  }
  const field = `${dimension.slice(6)}Stage` as keyof TriggerOutcomeRow
  const stage = item[field]
  return Number.isInteger(stage) && Number(stage) >= 1 && Number(stage) <= 6
    ? `S${stage}` as TriggerOutcomeSegmentValue
    : 'UNKNOWN'
}

function rowsForGroup(
  rows: TriggerOutcomeRow[],
  dimensions: TriggerOutcomeSegmentDimension[],
  group: TriggerOutcomeSegmentGroup,
): TriggerOutcomeRow[] {
  return rows.filter((item) => dimensions.every(
    (dimension) => independentValue(item, dimension) === group.keys[dimension],
  ))
}

function close(left: number | null, right: number | null, message: string): void {
  if (left == null || right == null) {
    assert.equal(left, right, message)
    return
  }
  assert.ok(Math.abs(left - right) <= 1e-12, `${message}: ${left} !== ${right}`)
}

function assertGroupsExact(
  rows: TriggerOutcomeRow[],
  dimensions: TriggerOutcomeSegmentDimension[],
  groups: TriggerOutcomeSegmentGroup[],
): void {
  for (const group of groups) {
    const selected = rowsForGroup(rows, dimensions, group)
    assert.equal(group.eventCount, selected.length)
    assert.equal(group.uniqueTickerCount, new Set(selected.map((item) => item.ticker)).size)
    for (const horizon of group.horizons) {
      const expected = independentSummary(selected, horizon.horizonSessions)
      for (const key of ['totalEventCount', 'eligibleCount', 'unavailableCount', 'censoredCount'] as const) {
        assert.equal(horizon[key], expected[key], `${dimensions.join(' x ')} ${JSON.stringify(group.keys)} ${key}`)
      }
      assert.deepEqual(horizon.unavailableByReason, expected.unavailableByReason)
      for (const key of [
        'meanReturn', 'medianReturn', 'positiveReturnRatio', 'p25Return', 'p75Return', 'medianMfe', 'medianMae',
      ] as const) close(horizon[key], expected[key], `${dimensions.join(' x ')} ${JSON.stringify(group.keys)} ${key}`)
      assert.equal(horizon.smallSample, expected.eligibleCount < 30)
    }
  }
}

function historicalManifest(
  timeframe: 'MONTHLY' | 'BIWEEKLY',
  spreadExpansionEnabled = false,
): TriggerHistoricalScanResponse {
  return {
    contractVersion: 'trigger-discovery-historical-scan-v1',
    scanMeta: {
      requestedStartDate: '2025-01-01', resolvedStartDate: '2025-01-06',
      requestedEndDate: '2025-12-31', resolvedEndDate: '2025-12-30',
      tradingDayCount: 240, processedTradingDays: 240, timeframe,
      ma1Period: 20, ma2Period: 25, sampling: 'EACH_MARKET_TRADING_DAY',
      baselineDate: '2024-12-30', baselineCandidateCount: 10,
      universeContract: 'reconstructed_from_currently_held_trade_history',
      universeNote: 'Historical universe fixture caveat.',
    },
    criteria: {
      maxApproachDistancePct: 5, nearDistancePct: 2,
      spreadExpansionEnabled,
      spreadLookbackIntervals: 4,
      minExpansionRatio: 0.7,
      requireBullishMaOrder: true,
      liquidityLookbackSessions: 20, maxPriceStalenessSessions: 3,
      markets: ['プライム'], priceMin: 100, priceMax: null,
      averageVolumeMin: 10_000, averageVolumeMax: null,
      averageTradingValueMin: 100_000_000, averageTradingValueMax: null,
      stageFilters: { monthAStage: [1, 'unknown'] },
    },
    summary: {
      tradingDays: 240, uniqueCandidateCount: 0, enteredCount: 0, reEntryCount: 0,
      statusChangeCount: 0, exitedCount: 0, totalEventCount: 0,
      maxDailyCandidates: 0, averageDailyCandidates: 0,
    },
    dailyCounts: [], events: [],
    eventPage: { offset: 0, limit: 0, returnedCount: 0, totalCount: 0, hasMore: false },
    performance: {
      totalMs: 0, queryCount: 0, tradingDays: 240, sourceTickerCount: 0,
      sourceRows: { ohlcv: 0, storedMonthlyMa: 0, weeklyOhlcv: 0, stage: 0 },
      sqlMs: { marketSessions: 0, universe: 0, ohlcv: 0, storedMonthlyMa: 0, weeklyOhlcv: 0, stage: 0, total: 0 },
      seriesBuildMs: 0, maPreparationMs: 0, liquidityMs: 0, universeFilterMs: 0,
      triggerEngineMs: 0, stageJoinMs: 0, scoreMs: 0, eventDerivationMs: 0,
      peakHeapBytes: 0, peakRssBytes: 0, heapDeltaBytes: 0,
    },
  }
}

async function writeCompletedFixture(input: {
  rows: TriggerOutcomeRow[]
  timeframe: 'MONTHLY' | 'BIWEEKLY'
  spreadExpansionEnabled?: boolean
  eventFilter?: 'NEAR_ENTERED' | 'IN_ZONE_ENTERED'
}): Promise<{ historicalId: string; outcomeId: string; rowsPath: string }> {
  const historicalId = randomUUID()
  const outcomeId = randomUUID()
  const now = Math.floor(Date.now() / 1_000)
  await execRun(`INSERT INTO historical_trigger_scan_jobs (
    id,status,request_json,request_signature,source_fingerprint,requested_start,requested_end,
    resolved_start,resolved_end,timeframe,created_at,completed_at,result_location,result_size_bytes,expires_at
  ) VALUES (?, 'COMPLETED', '{}', ?, 'segment-source', '2025-01-01', '2025-12-31',
    '2025-01-06', '2025-12-30', ?, ?, ?, ?, 1, ?)`,
  [historicalId, historicalScanResultSignature('{}'), input.timeframe, now, now, historicalId, now + 86_400])
  const historicalPaths = historicalScanResultPaths(historicalId)
  await mkdir(historicalPaths.manifest.slice(0, historicalPaths.manifest.lastIndexOf('/')), { recursive: true })
  await writeFile(historicalPaths.manifest, JSON.stringify(historicalManifest(
    input.timeframe,
    input.spreadExpansionEnabled,
  )))
  await writeFile(historicalPaths.events, '')
  const request: TriggerOutcomeRequest = {
    historicalScanJobId: historicalId,
    eventFilter: input.eventFilter ?? 'NEAR_ENTERED',
    horizons: [...HORIZONS], ticker: null, triggerScoreMin: 10, triggerScoreMax: 95,
    stageFilters: { weekBStage: [1, 2] },
  }
  const manifest: TriggerOutcomeManifest = {
    contractVersion: 'trigger-discovery-outcome-v1',
    outcomeJobId: outcomeId,
    historicalScanJobId: historicalId,
    sourceFingerprint: 'segment-outcome-source',
    request,
    metadata: {
      analysisCutoffDate: '2026-09-11', sourceTimeframe: input.timeframe,
      adjustmentBasis: 'JQUANTS_ADJUSTED_OHLCV', anchorPriceBasis: 'HISTORICAL_EVENT_CLOSE',
      excursionWindow: 'NEXT_SESSION_THROUGH_HORIZON',
      observationIndependenceNote: 'Repeated Event fixture caveat.',
    },
    summary: {
      selectedEventCount: input.rows.length,
      uniqueTickerCount: new Set(input.rows.map((item) => item.ticker)).size,
      horizons: aggregateOutcomeRows(input.rows, HORIZONS),
    },
    performance: {
      totalMs: 0, sqlMs: 0, calculationMs: 0, aggregationMs: 0, serializationMs: 0,
      saveMs: 0, queryCount: 0, selectedEventCount: input.rows.length,
      uniqueTickerCount: new Set(input.rows.map((item) => item.ticker)).size,
      ohlcvRowCount: 0, peakHeapBytes: 0, peakRssBytes: 0,
    },
    generatedAt: new Date().toISOString(),
  }
  await execRun(`INSERT INTO trigger_outcome_analysis_jobs (
    id,status,historical_scan_job_id,request_json,request_signature,source_fingerprint,
    analysis_cutoff_date,created_at,completed_at,total_events,processed_events,total_tickers,
    processed_tickers,result_location,result_size_bytes,expires_at
  ) VALUES (?, 'COMPLETED', ?, ?, 'segment-request', 'segment-outcome-source', '2026-09-11',
    ?, ?, ?, ?, ?, ?, ?, 1, ?)`, [
    outcomeId, historicalId, JSON.stringify(request), now, now, input.rows.length, input.rows.length,
    manifest.summary.uniqueTickerCount, manifest.summary.uniqueTickerCount, outcomeId, now + 86_400,
  ])
  const outcomePaths = outcomeResultPaths(outcomeId)
  await mkdir(outcomePaths.manifest.slice(0, outcomePaths.manifest.lastIndexOf('/')), { recursive: true })
  const payload = `${input.rows.map((item) => JSON.stringify(item)).join('\n')}\n`
  await writeFile(outcomePaths.manifest, JSON.stringify(manifest))
  await writeFile(outcomePaths.rowsByDate, payload)
  await writeFile(outcomePaths.rowsByTicker, payload)
  return { historicalId, outcomeId, rowsPath: outcomePaths.rowsByDate }
}

async function sideEffects(): Promise<Record<string, number>> {
  const result: Record<string, number> = {}
  for (const table of SIDE_EFFECT_TABLES) {
    result[table] = Number((await execGet<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`))?.count ?? 0)
  }
  return result
}

async function cleanup(ids: Array<{ historicalId: string; outcomeId: string }>): Promise<void> {
  for (const item of ids) {
    await Promise.all(Object.values(outcomeResultPaths(item.outcomeId)).map((file) => rm(file, { force: true })))
    await Promise.all(Object.values(historicalScanResultPaths(item.historicalId)).map((file) => rm(file, { force: true })))
  }
  await execRun('DELETE FROM trigger_outcome_analysis_jobs')
  await execRun('DELETE FROM historical_trigger_scan_jobs')
}

async function main(): Promise<void> {
  await cleanup([])
  const beforeSideEffects = await sideEffects()

  const boundaryScores = [0, 39.999, 40, 59.999, 60, 79.999, 80, 100, null] as const
  assert.deepEqual(boundaryScores.map(scoreBandForOutcomeScore), [
    'LOW', 'LOW', 'MID_LOW', 'MID_LOW', 'MID_HIGH', 'MID_HIGH', 'HIGH', 'HIGH', 'UNKNOWN',
  ])
  assert.throws(() => parseOutcomeSegmentDimensions([]), TriggerOutcomeSegmentationInputError)
  assert.throws(() => parseOutcomeSegmentDimensions(['scoreBand', 'stage:weekA', 'stage:monthA']), TriggerOutcomeSegmentationInputError)
  assert.throws(() => parseOutcomeSegmentDimensions(['scoreBand', 'scoreBand']), TriggerOutcomeSegmentationInputError)
  assert.throws(() => parseOutcomeSegmentDimensions(['stage:unknown']), TriggerOutcomeSegmentationInputError)
  assert.deepEqual(parseOutcomeSegmentationUrl('http://localhost/?dimension=stage:weekA&dimension=stage:monthA'), [
    'stage:weekA', 'stage:monthA',
  ])

  const boundaryRows = boundaryScores.map((score, index) => row(index, {
    triggerScore: score as number,
    monthAStage: index === 8 ? null : 1,
  }))
  const boundaryGroups = aggregateOutcomeSegmentsFromRows({
    rows: boundaryRows, dimensions: ['scoreBand'], horizons: HORIZONS,
  })
  assert.deepEqual(boundaryGroups.map((group) => group.eventCount), [2, 2, 2, 2, 1])
  const stageUnknown = aggregateOutcomeSegmentsFromRows({
    rows: boundaryRows, dimensions: ['stage:monthA'], horizons: [20],
  })
  assert.equal(stageUnknown.find((group) => group.keys['stage:monthA'] === 'UNKNOWN')?.eventCount, 1)

  const smallSampleRows = [
    ...Array.from({ length: 29 }, (_, index) => row(index, { triggerScore: 20 })),
    ...Array.from({ length: 30 }, (_, index) => row(index + 29, { triggerScore: 80 })),
  ]
  const smallGroups = aggregateOutcomeSegmentsFromRows({
    rows: smallSampleRows, dimensions: ['scoreBand'], horizons: [20],
  })
  assert.equal(smallGroups.find((group) => group.keys.scoreBand === 'LOW')?.horizons[0]?.smallSample, true)
  assert.equal(smallGroups.find((group) => group.keys.scoreBand === 'HIGH')?.horizons[0]?.smallSample, false)
  const repeated = aggregateOutcomeSegmentsFromRows({
    rows: [row(0, { ticker: '7003' }), row(1, { ticker: '7003' })],
    dimensions: ['scoreBand'], horizons: [20],
  }).find((group) => group.keys.scoreBand === 'LOW')
  assert.equal(repeated?.eventCount, 2)
  assert.equal(repeated?.uniqueTickerCount, 1)

  const rows = Array.from({ length: 85 }, (_, index) => row(index))
  const spreadRows = rows.map((item, index) => ({
    ...item,
    snapshotBasis: index === 80 ? 'PREVIOUS' as const : 'CURRENT' as const,
    spreadDiagnosticDate: index === 70 ? '2026-01-01' : index === 69 ? '2025-03-15' : item.eventDate,
    spreadExpansionAvailable: index < 80,
    spreadExpansionPass: index < 35,
    bullishMaOrder: index < 35,
    maSpreadPct: index < 35 ? 4.5 : -1.2,
    maSpreadSlope: index < 35 ? 0.5 : -0.2,
    maSpreadExpansionRatio: index < 35 ? 0.75 : 0.25,
  }))
  const monthly = await writeCompletedFixture({ rows, timeframe: 'MONTHLY' })
  const monthlyConditioned = await writeCompletedFixture({ rows: spreadRows, timeframe: 'MONTHLY' })
  const biweekly = await writeCompletedFixture({ rows, timeframe: 'BIWEEKLY' })
  const monthlySpread = await writeCompletedFixture({
    rows,
    timeframe: 'MONTHLY',
    spreadExpansionEnabled: true,
  })
  const cleanupIds = [monthly, monthlyConditioned, biweekly, monthlySpread]
  const beforeHash = createHash('sha256').update(await readFile(monthly.rowsPath)).digest('hex')

  const scoreResult = await getOutcomeSegmentation({
    outcomeJobId: monthly.outcomeId, dimensions: ['scoreBand'],
  })
  assert.equal(scoreResult.meta.performance.ohlcvQueryCount, 0)
  assert.equal(scoreResult.meta.performance.dbQueryCount, 1)
  assert.equal(scoreResult.meta.performance.rowsRead, rows.length)
  assert.equal(scoreResult.meta.source.filters.outcomeScore.min, 10)
  assert.deepEqual(scoreResult.meta.source.filters.historicalStage, { monthAStage: [1, 'unknown'] })
  assert.deepEqual(scoreResult.meta.source.filters.outcomeStage, { weekBStage: [1, 2] })
  assert.equal(scoreResult.meta.source.maPeriods.unit, 'MONTHLY_BARS')
  assert.equal(scoreResult.meta.source.historicalUniverseCaveat, 'Historical universe fixture caveat.')
  assertGroupsExact(rows, ['scoreBand'], scoreResult.segmentation.groups)
  assert.equal(scoreResult.integrity.eventCountMatchesOverall, true)
  assert.ok(Object.values(scoreResult.integrity.eligibleCountsMatchOverall).every(Boolean))
  assert.ok(Object.values(scoreResult.integrity.weightedMeanMatchesOverall).every(Boolean))

  const oldSpread = await getOutcomeSegmentation({ outcomeJobId: monthly.outcomeId, dimensions: ['spreadExpansion'] })
  assert.equal(oldSpread.meta.analysisType, 'CONDITIONED_EVENT_COMPARISON')
  assert.equal(oldSpread.meta.spreadDiagnosticsStatus, 'SPREAD_DIAGNOSTICS_UNAVAILABLE')
  assert.deepEqual(oldSpread.segmentation.groups.map((group) => group.eventCount), [0, 0, 85])
  const conditioned = await getOutcomeSegmentation({ outcomeJobId: monthlyConditioned.outcomeId, dimensions: ['spreadExpansion'] })
  assert.equal(conditioned.meta.spreadDiagnosticsStatus, 'AVAILABLE')
  assert.deepEqual(conditioned.segmentation.groups.map((group) => group.eventCount), [35, 44, 6])
  assertGroupsExact(spreadRows, ['spreadExpansion'], conditioned.segmentation.groups)
  assert.equal(conditioned.integrity.eventCountMatchesOverall, true)
  assert.ok(Object.values(conditioned.integrity.eligibleCountsMatchOverall).every(Boolean))
  assert.ok(Object.values(conditioned.integrity.weightedMeanMatchesOverall).every(Boolean))
  assert.equal(conditioned.meta.performance.ohlcvQueryCount, 0)

  for (const dimension of [
    'stage:dayA', 'stage:dayB', 'stage:weekA', 'stage:weekB', 'stage:monthA', 'stage:monthB',
  ] as TriggerOutcomeSegmentDimension[]) {
    const result = await getOutcomeSegmentation({ outcomeJobId: monthly.outcomeId, dimensions: [dimension] })
    assertGroupsExact(rows, [dimension], result.segmentation.groups)
    assert.equal(result.segmentation.groups.length, 7)
  }

  const pairResult = await getOutcomeSegmentation({
    outcomeJobId: monthly.outcomeId, dimensions: ['stage:weekA', 'stage:monthA'],
  })
  assert.equal(pairResult.segmentation.groups.length, 49)
  assertGroupsExact(rows, ['stage:weekA', 'stage:monthA'], pairResult.segmentation.groups)
  assert.equal(pairResult.integrity.eventCountMatchesOverall, true)
  assert.ok(Object.values(pairResult.integrity.eligibleCountsMatchOverall).every(Boolean))
  const scoreStage = await getOutcomeSegmentation({
    outcomeJobId: monthly.outcomeId, dimensions: ['scoreBand', 'stage:monthA'],
  })
  assert.equal(scoreStage.segmentation.groups.length, 35)
  assertGroupsExact(rows, ['scoreBand', 'stage:monthA'], scoreStage.segmentation.groups)

  const comparison = await compareOutcomeSegments({
    leftOutcomeJobId: monthly.outcomeId,
    rightOutcomeJobId: biweekly.outcomeId,
    dimensions: ['scoreBand'],
  })
  assert.deepEqual(comparison.compatibility.differences, ['timeframe', 'maPeriods'])
  assert.equal(comparison.compatibility.samePopulationFilters, true)
  assert.equal(comparison.compatibility.sameDateRange, true)
  assert.equal(comparison.compatibility.sameEventSelector, true)
  assert.equal(comparison.compatibility.sameHorizons, true)
  assert.equal(comparison.compatibility.sameTimeframe, false)
  assert.equal(comparison.compatibility.sameMaPeriods, false)
  assert.equal(comparison.left.meta.source.maPeriods.unit, 'MONTHLY_BARS')
  assert.equal(comparison.right.meta.source.maPeriods.unit, 'BIWEEKLY_BARS')
  const recent = await listRecentCompletedOutcomeJobs()
  assert.ok(recent.some((job) => job.jobId === monthly.outcomeId && job.timeframe === 'MONTHLY'))
  assert.ok(recent.some((job) => job.jobId === biweekly.outcomeId && job.timeframe === 'BIWEEKLY'))
  assert.ok(recent.every((job) => job.eventSelector === 'NEAR_ENTERED'))

  const spreadComparison = await compareOutcomeSegments({
    leftOutcomeJobId: monthly.outcomeId,
    rightOutcomeJobId: monthlySpread.outcomeId,
    dimensions: ['scoreBand'],
  })
  assert.deepEqual(spreadComparison.compatibility.differences, ['triggerFilters'])
  assert.equal(spreadComparison.analysisType, 'OPERATIONAL_SCAN_COMPARISON')
  assert.equal(spreadComparison.compatibility.samePopulationFilters, false)
  assert.equal(spreadComparison.right.meta.source.filters.triggerCore.spreadExpansionEnabled, true)
  assert.equal(spreadComparison.right.meta.source.filters.triggerCore.spreadLookbackIntervals, 4)
  assert.equal(spreadComparison.right.meta.source.filters.triggerCore.minExpansionRatio, 0.7)

  const afterHash = createHash('sha256').update(await readFile(monthly.rowsPath)).digest('hex')
  assert.equal(afterHash, beforeHash, 'Segmentation must not mutate Outcome Result rows')
  assert.deepEqual(await sideEffects(), beforeSideEffects)

  const queuedId = randomUUID()
  const now = Math.floor(Date.now() / 1_000)
  await execRun(`INSERT INTO trigger_outcome_analysis_jobs (
    id,status,historical_scan_job_id,request_json,request_signature,source_fingerprint,created_at,expires_at
  ) VALUES (?, 'QUEUED', ?, '{}', 'queued', 'queued', ?, ?)`,
  [queuedId, monthly.historicalId, now, now + 86_400])
  await assert.rejects(
    () => getOutcomeSegmentation({ outcomeJobId: queuedId, dimensions: ['scoreBand'] }),
    (error: unknown) => error instanceof TriggerOutcomeSegmentationSourceError
      && error.code === 'outcome_analysis_job_not_completed',
  )
  await execRun('UPDATE trigger_outcome_analysis_jobs SET status=\'COMPLETED\', result_location=id, expires_at=? WHERE id=?', [now - 1, queuedId])
  await assert.rejects(
    () => getOutcomeSegmentation({ outcomeJobId: queuedId, dimensions: ['scoreBand'] }),
    (error: unknown) => error instanceof TriggerOutcomeSegmentationSourceError
      && error.code === 'outcome_analysis_job_result_expired',
  )

  const missingOutcome = await writeCompletedFixture({ rows: rows.slice(0, 3), timeframe: 'MONTHLY' })
  cleanupIds.push(missingOutcome)
  await rm(outcomeResultPaths(missingOutcome.outcomeId).rowsByDate, { force: true })
  await assert.rejects(
    () => getOutcomeSegmentation({ outcomeJobId: missingOutcome.outcomeId, dimensions: ['scoreBand'] }),
    (error: unknown) => error instanceof TriggerOutcomeSegmentationSourceError
      && error.code === 'outcome_analysis_job_result_expired',
  )

  const missingHistorical = await writeCompletedFixture({ rows: rows.slice(0, 3), timeframe: 'MONTHLY' })
  cleanupIds.push(missingHistorical)
  await execRun('UPDATE historical_trigger_scan_jobs SET request_signature=? WHERE id=?',
    ['legacy-algorithm', missingHistorical.historicalId])
  await assert.rejects(
    () => getOutcomeSegmentation({ outcomeJobId: missingHistorical.outcomeId, dimensions: ['scoreBand'] }),
    (error: unknown) => error instanceof TriggerOutcomeSegmentationSourceError
      && error.code === 'historical_scan_source_metadata_expired',
  )
  await execRun('UPDATE historical_trigger_scan_jobs SET request_signature=? WHERE id=?',
    [historicalScanResultSignature('{}'), missingHistorical.historicalId])
  await rm(historicalScanResultPaths(missingHistorical.historicalId).manifest, { force: true })
  await assert.rejects(
    () => getOutcomeSegmentation({ outcomeJobId: missingHistorical.outcomeId, dimensions: ['scoreBand'] }),
    (error: unknown) => error instanceof TriggerOutcomeSegmentationSourceError
      && error.code === 'historical_scan_source_metadata_expired',
  )

  console.log(JSON.stringify({
    passed: true,
    scoreBoundaryBands: boundaryGroups.map((group) => ({ key: group.keys.scoreBand, count: group.eventCount })),
    stageAxesChecked: 6,
    pairCellsChecked: pairResult.segmentation.groups.length,
    scoreStageCellsChecked: scoreStage.segmentation.groups.length,
    rowsRead: scoreResult.meta.performance.rowsRead,
    ohlcvQueries: scoreResult.meta.performance.ohlcvQueryCount,
    eventHashUnchanged: true,
    sideEffectsUnchanged: true,
    comparisonDifferences: comparison.compatibility.differences,
    spreadComparisonDifferences: spreadComparison.compatibility.differences,
    conditionedEventGroups: conditioned.segmentation.groups.map((group) => ({ bucket: group.keys.spreadExpansion, count: group.eventCount })),
  }, null, 2))
  await execRun('DELETE FROM trigger_outcome_analysis_jobs WHERE id=?', [queuedId])
  await cleanup(cleanupIds)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
