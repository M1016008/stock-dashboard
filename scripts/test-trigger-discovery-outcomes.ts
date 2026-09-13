import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { execAll, execGet, execRun } from '@/lib/db/client'
import {
  aggregateOutcomeRows,
  calculateEventOutcome,
  outcomeEventMatches,
  type OutcomeOhlcvRow,
} from '@/lib/server/trigger-discovery-outcome-analysis'
import {
  cancelOutcomeAnalysisJob,
  claimNextOutcomeJob,
  createOutcomeAnalysisJob,
  executeOutcomeAnalysisJob,
  getOutcomeAnalysisJob,
  getOutcomeAnalysisResult,
  outcomeResultPaths,
  parseOutcomeResultQuery,
  parseTriggerOutcomeRequest,
  recoverStaleOutcomeJobs,
  TriggerOutcomeInputError,
  TriggerOutcomeSourceError,
} from '@/lib/server/trigger-discovery-outcome-jobs'
import {
  claimNextHistoricalScanJob,
  historicalScanResultPaths,
} from '@/lib/server/trigger-discovery-historical-scan-jobs'
import type { TriggerHistoricalScanEvent } from '@/lib/trigger-discovery-historical-scan-contract'

const SIDE_EFFECT_TABLES = [
  'trigger_evaluations',
  'trigger_evaluation_members',
  'trigger_lifecycle_events',
  'notification_outbox',
  'notification_delivery_attempts',
] as const

function scoreBreakdown(total = 70) {
  return {
    proximity: 25,
    approach: 15,
    maTrend: 10,
    stageStructure: 12,
    liquidity: 8,
    total,
    stageCoverage: 1,
    stageAvailableAxes: 6,
    maximums: { proximity: 30, approach: 20, maTrend: 20, stageStructure: 20, liquidity: 10 },
    explanations: { proximity: '', approach: '', maTrend: '', stageStructure: '', liquidity: '' },
  }
}

function fixtureEvent(index: number, status: 'NEAR' | 'IN_ZONE'): TriggerHistoricalScanEvent {
  return {
    date: '2025-01-02',
    ticker: String(1000 + index),
    companyName: `Outcome Fixture ${index}`,
    eventType: 'STATUS_CHANGED',
    previousStatus: 'APPROACHING',
    currentStatus: status,
    snapshotBasis: 'CURRENT',
    price: 100 + index,
    ma1: 95,
    ma2: 90,
    zoneDistancePct: 1,
    triggerScore: 60 + index,
    scoreBreakdown: scoreBreakdown(60 + index),
    priceDate: '2025-01-02',
    maDate: '2025-01-02',
    stageDate: '2025-01-02',
    dayAStage: 1,
    dayBStage: 2,
    weekAStage: 3,
    weekBStage: 4,
    monthAStage: 5,
    monthBStage: 6,
  }
}

function utcDate(offset: number): string {
  const date = new Date(Date.UTC(2025, 0, 2 + offset))
  return date.toISOString().slice(0, 10)
}

function fixtureSeries(ticker: string, anchor: number, sessions = 246): OutcomeOhlcvRow[] {
  return Array.from({ length: sessions }, (_, index) => ({
    ticker,
    date: utcDate(index),
    close: anchor + index,
    high: index === 0 ? anchor * 20 : anchor + index + 2,
    low: index === 0 ? anchor * 0.01 : anchor + index - 2,
  }))
}

async function sideEffects(): Promise<Record<string, number>> {
  const values: Record<string, number> = {}
  for (const table of SIDE_EFFECT_TABLES) {
    values[table] = Number((await execGet<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`))?.count ?? 0)
  }
  return values
}

async function removeFiles(id: string, kind: 'source' | 'outcome'): Promise<void> {
  const paths = kind === 'source' ? historicalScanResultPaths(id) : outcomeResultPaths(id)
  await Promise.all(Object.values(paths).map((file) => rm(file, { force: true })))
}

async function reset(): Promise<void> {
  const sourceIds = await execAll<{ id: string }>('SELECT id FROM historical_trigger_scan_jobs')
  const outcomeIds = await execAll<{ id: string }>('SELECT id FROM trigger_outcome_analysis_jobs')
  for (const row of sourceIds) await removeFiles(row.id, 'source')
  for (const row of outcomeIds) await removeFiles(row.id, 'outcome')
  await execRun('DELETE FROM trigger_outcome_analysis_jobs')
  await execRun('DELETE FROM historical_trigger_scan_jobs')
  await execRun('DELETE FROM ohlcv_daily')
}

async function createCompletedSource(events: TriggerHistoricalScanEvent[]): Promise<string> {
  const id = randomUUID()
  const now = Math.floor(Date.now() / 1_000)
  await execRun(`INSERT INTO historical_trigger_scan_jobs (
    id, status, request_json, request_signature, source_fingerprint, requested_start,
    requested_end, resolved_start, resolved_end, timeframe, created_at, completed_at,
    heartbeat_at, total_trading_days, processed_trading_days, result_location,
    result_size_bytes, duration_ms, serialization_ms, expires_at
  ) VALUES (?, 'COMPLETED', '{}', 'fixture-request', 'fixture-source', '2025-01-02',
    '2025-12-31', '2025-01-02', '2025-12-31', 'MONTHLY', ?, ?, ?, 250, 250,
    ?, 1, 1, 1, ?)`, [id, now, now, now, id, now + 86_400])
  const paths = historicalScanResultPaths(id)
  await mkdir(paths.manifest.slice(0, paths.manifest.lastIndexOf('/')), { recursive: true })
  await writeFile(paths.manifest, JSON.stringify({ contractVersion: 'trigger-discovery-historical-scan-v1' }))
  await writeFile(paths.events, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`)
  return id
}

async function insertSeries(events: TriggerHistoricalScanEvent[]): Promise<void> {
  for (const event of events) {
    const rows = fixtureSeries(event.ticker, event.price)
    for (let index = 0; index < rows.length; index += 100) {
      const chunk = rows.slice(index, index + 100)
      const placeholders = chunk.map(() => '(?,?,?,?,?,?,?)').join(',')
      await execRun(`INSERT INTO ohlcv_daily (ticker,date,open,high,low,close,volume) VALUES ${placeholders}`,
        chunk.flatMap((row) => [row.ticker, row.date, row.close, row.high, row.low, row.close, 1_000]))
    }
  }
}

async function main() {
  await reset()
  const beforeSideEffects = await sideEffects()

  const event = fixtureEvent(0, 'NEAR')
  const series = fixtureSeries(event.ticker, event.price)
  const direct = calculateEventOutcome(event, series)
  assert.equal(direct.availability20, 'AVAILABLE')
  assert.ok(Math.abs((direct.return20 ?? 99) - 0.2) < 1e-12,
    '20-session return must use the exact 20th future row')
  assert.ok(Math.abs((direct.mfe20 ?? 99) - 0.22) < 1e-12,
    'event-day extreme high must be excluded')
  assert.ok(Math.abs((direct.mae20 ?? 99) - (-0.01)) < 1e-12,
    'event-day extreme low must be excluded')
  assert.ok(Math.abs((direct.return245 ?? 99) - 2.45) < 1e-12)

  const recent = calculateEventOutcome(event, series.slice(0, 21))
  assert.equal(recent.availability20, 'AVAILABLE')
  assert.equal(recent.availability60, 'INSUFFICIENT_FUTURE_DATA')
  assert.equal(recent.return60, null)
  assert.equal(recent.mfe60, null)
  assert.equal(recent.mae60, null)
  const onlyTwenty = calculateEventOutcome(event, series, [20])
  assert.equal(onlyTwenty.availability20, 'AVAILABLE')
  assert.equal(onlyTwenty.availability60, 'NOT_REQUESTED')

  const missingAnchor = calculateEventOutcome({ ...event, date: '2024-12-31' }, series)
  assert.equal(missingAnchor.availability20, 'ANCHOR_SESSION_NOT_FOUND')
  const interrupted = calculateEventOutcome(
    event,
    series.filter((_, index) => index !== 10),
    [20],
    series.map((row) => row.date),
  )
  assert.equal(interrupted.availability20, 'INSUFFICIENT_FUTURE_DATA',
    'a missing ticker row inside the exact market-session horizon must be censored')
  const invalidAnchor = calculateEventOutcome({ ...event, price: 0 }, series)
  assert.equal(invalidAnchor.availability20, 'INVALID_ANCHOR_PRICE')

  const splitAdjustedSeries = fixtureSeries(event.ticker, 100).map((row, index) => ({
    ...row,
    close: 100 + index * 0.1,
    high: 101 + index * 0.1,
    low: 99 + index * 0.1,
  }))
  const splitOutcome = calculateEventOutcome(event, splitAdjustedSeries)
  assert.ok((splitOutcome.return245 ?? 99) < 0.3, 'adjusted series must not introduce a split-sized return')

  assert.equal(outcomeEventMatches({
    event, eventFilter: 'NEAR_ENTERED', ticker: null, triggerScoreMin: null,
    triggerScoreMax: null, stageFilters: {},
  }), true)
  assert.equal(outcomeEventMatches({
    event, eventFilter: 'IN_ZONE_ENTERED', ticker: null, triggerScoreMin: null,
    triggerScoreMax: null, stageFilters: {},
  }), false)
  assert.equal(outcomeEventMatches({
    event, eventFilter: 'NEAR_ENTERED', ticker: null, triggerScoreMin: 60,
    triggerScoreMax: 60, stageFilters: { monthBStage: [6] },
  }), true)
  assert.equal(outcomeEventMatches({
    event, eventFilter: 'NEAR_ENTERED', ticker: null, triggerScoreMin: null,
    triggerScoreMax: null, stageFilters: { monthBStage: [1] },
  }), false)

  const aggregate = aggregateOutcomeRows([direct, recent], [20, 60])
  assert.equal(aggregate[0]?.eligibleCount, 2)
  assert.equal(aggregate[1]?.eligibleCount, 1)
  assert.equal(aggregate[1]?.censoredCount, 1)
  assert.equal(aggregate[0]?.positiveReturnRatio, 1)

  assert.throws(() => parseTriggerOutcomeRequest({ historicalScanJobId: 'bad', eventFilter: 'ALL' }), TriggerOutcomeInputError)
  assert.throws(() => parseTriggerOutcomeRequest({
    historicalScanJobId: randomUUID(), eventFilter: 'UNKNOWN', horizons: [20],
  }), TriggerOutcomeInputError)
  assert.throws(() => parseTriggerOutcomeRequest({
    historicalScanJobId: randomUUID(), eventFilter: 'ALL', horizons: [21],
  }), TriggerOutcomeInputError)
  assert.throws(() => parseOutcomeResultQuery('http://localhost/?limit=1001'), TriggerOutcomeInputError)

  const events = Array.from({ length: 30 }, (_, index) => fixtureEvent(index, index < 15 ? 'NEAR' : 'IN_ZONE'))
  await insertSeries(events)
  const sourceId = await createCompletedSource(events)
  const sourcePath = historicalScanResultPaths(sourceId).events
  const beforeHash = createHash('sha256').update(await readFile(sourcePath)).digest('hex')

  const nearStart = await createOutcomeAnalysisJob({
    eventFilter: 'NEAR_ENTERED', horizons: [20, 60, 120, 245],
  }, sourceId)
  assert.equal(nearStart.status, 'QUEUED')
  const nearDuplicate = await createOutcomeAnalysisJob({
    eventFilter: 'NEAR_ENTERED', horizons: [20, 60, 120, 245],
  }, sourceId)
  assert.equal(nearDuplicate.jobId, nearStart.jobId)
  assert.equal(nearDuplicate.reused, true)
  const nearClaim = await claimNextOutcomeJob('11111111-1111-4111-8111-111111111111')
  assert.equal(nearClaim?.id, nearStart.jobId)
  assert.equal(await executeOutcomeAnalysisJob(nearClaim!), 'COMPLETED')
  const nearJob = await getOutcomeAnalysisJob(nearStart.jobId)
  assert.equal(nearJob?.status, 'COMPLETED')
  assert.deepEqual(nearJob?.progress, {
    processedEvents: 15, totalEvents: 15, processedTickers: 15, totalTickers: 15,
  })
  const nearResult = await getOutcomeAnalysisResult({
    id: nearStart.jobId,
    query: { offset: 0, limit: 100, sortBy: 'eventDate', sortOrder: 'asc' },
  })
  assert.ok(nearResult && typeof nearResult === 'object')
  assert.equal(nearResult.rows.length, 15)
  assert.ok(nearResult.rows.every((row) => row.eventType === 'STATUS_CHANGED' && row.currentStatus === 'NEAR'))
  assert.ok(nearResult.rows.every((row) => row.triggerScore === Number(row.ticker) - 940))
  assert.ok(nearResult.rows.every((row) => row.dayAStage === 1 && row.monthBStage === 6))
  assert.equal(nearResult.metadata.anchorPriceBasis, 'HISTORICAL_EVENT_CLOSE')
  assert.equal(nearResult.metadata.excursionWindow, 'NEXT_SESSION_THROUGH_HORIZON')
  assert.equal(nearResult.metadata.adjustmentBasis, 'JQUANTS_ADJUSTED_OHLCV')
  assert.equal(nearResult.performance.queryCount, 2,
    'one market-session query plus one batched OHLCV query must replace per-event SQL')

  const zoneStart = await createOutcomeAnalysisJob({
    eventFilter: 'IN_ZONE_ENTERED', horizons: [20, 60], triggerScoreMin: 75,
    stageFilters: { dayAStage: [1] },
  }, sourceId)
  const zoneClaim = await claimNextOutcomeJob('22222222-2222-4222-8222-222222222222')
  assert.equal(zoneClaim?.id, zoneStart.jobId)
  assert.equal(await executeOutcomeAnalysisJob(zoneClaim!), 'COMPLETED')
  const zoneResult = await getOutcomeAnalysisResult({
    id: zoneStart.jobId,
    query: { offset: 0, limit: 5, sortBy: 'ticker', sortOrder: 'desc' },
  })
  assert.ok(zoneResult && typeof zoneResult === 'object')
  assert.equal(zoneResult.rowPage.totalCount, 15)
  assert.equal(zoneResult.rows[0]?.ticker, '1029')
  assert.ok(zoneResult.rows.every((row) => row.currentStatus === 'IN_ZONE'))

  const cancelStart = await createOutcomeAnalysisJob({ eventFilter: 'ENTERED', horizons: [20] }, sourceId)
  assert.equal((await cancelOutcomeAnalysisJob(cancelStart.jobId))?.status, 'CANCELLED')

  const staleId = randomUUID()
  const now = Math.floor(Date.now() / 1_000)
  await execRun(`INSERT INTO trigger_outcome_analysis_jobs (
    id,status,historical_scan_job_id,request_json,request_signature,source_fingerprint,
    analysis_cutoff_date,created_at,started_at,heartbeat_at,owner_token,attempt_count,expires_at
  ) VALUES (?, 'RUNNING', ?, '{}', 'stale', 'stale', '2025-12-31', ?, ?, ?, 'stale-owner', 1, ?)`,
  [staleId, sourceId, now - 1_000, now - 1_000, now - 1_000, now + 86_400])
  const recovered = await recoverStaleOutcomeJobs(() => Date.now())
  assert.equal(recovered.requeued, 1)
  assert.equal((await getOutcomeAnalysisJob(staleId))?.status, 'QUEUED')

  const blockingHistoricalId = randomUUID()
  await execRun(`INSERT INTO historical_trigger_scan_jobs (
    id,status,request_json,request_signature,source_fingerprint,requested_start,requested_end,
    timeframe,created_at,heartbeat_at,owner_token,attempt_count,expires_at
  ) VALUES (?, 'RUNNING', '{}', 'blocking', 'blocking', '2025-01-01', '2025-01-02',
    'MONTHLY', ?, ?, 'historical-owner', 1, ?)`, [blockingHistoricalId, now, now, now + 86_400])
  assert.equal(await claimNextOutcomeJob(), null,
    'Outcome must not start while a Historical Scan job is running')
  await execRun(`UPDATE historical_trigger_scan_jobs SET status='CANCELLED', owner_token=NULL WHERE id=?`,
    [blockingHistoricalId])
  const runningOutcome = await claimNextOutcomeJob('33333333-3333-4333-8333-333333333333')
  assert.equal(runningOutcome?.id, staleId)
  const queuedHistoricalId = randomUUID()
  await execRun(`INSERT INTO historical_trigger_scan_jobs (
    id,status,request_json,request_signature,source_fingerprint,requested_start,requested_end,
    timeframe,created_at,expires_at
  ) VALUES (?, 'QUEUED', '{}', 'queued', 'queued', '2025-01-01', '2025-01-02',
    'MONTHLY', ?, ?)`, [queuedHistoricalId, now + 1, now + 86_400])
  assert.equal(await claimNextHistoricalScanJob(), null,
    'Historical Scan must not start while an Outcome job is running')
  await execRun(`UPDATE trigger_outcome_analysis_jobs SET status='CANCELLED', owner_token=NULL WHERE id=?`, [staleId])
  await execRun(`UPDATE historical_trigger_scan_jobs SET status='CANCELLED' WHERE id=?`, [queuedHistoricalId])

  await execRun(`UPDATE historical_trigger_scan_jobs SET status='RUNNING' WHERE id=?`, [sourceId])
  await assert.rejects(() => createOutcomeAnalysisJob({ eventFilter: 'ALL', horizons: [20] }, sourceId),
    (error: unknown) => error instanceof TriggerOutcomeSourceError
      && error.code === 'historical_scan_job_not_completed')
  await execRun(`UPDATE historical_trigger_scan_jobs SET status='COMPLETED', expires_at=? WHERE id=?`, [now - 1, sourceId])
  await assert.rejects(() => createOutcomeAnalysisJob({ eventFilter: 'ALL', horizons: [20] }, sourceId),
    (error: unknown) => error instanceof TriggerOutcomeSourceError
      && error.code === 'historical_scan_job_result_expired')

  const afterHash = createHash('sha256').update(await readFile(sourcePath)).digest('hex')
  assert.equal(afterHash, beforeHash, 'Outcome analysis must not mutate Historical Event rows')
  assert.deepEqual(await sideEffects(), beforeSideEffects, 'Outcome analysis must not create evaluation/lifecycle/outbox side effects')

  console.log(JSON.stringify({
    passed: true,
    independentlyCheckedEvents: 30,
    nearEvents: nearResult.rows.length,
    inZoneEvents: zoneResult.rowPage.totalCount,
    sourceEventHashUnchanged: true,
    sideEffectsUnchanged: true,
  }, null, 2))
  await reset()
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
