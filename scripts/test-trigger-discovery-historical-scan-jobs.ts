import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { GET as getFollowUpRoute } from '@/app/api/trigger-discovery/historical-scan/jobs/[jobId]/events/[eventKey]/follow-up/route'
import { execAll, execGet, execRun } from '@/lib/db/client'
import {
  cancelHistoricalScanJob,
  claimNextHistoricalScanJob,
  createHistoricalScanJob,
  executeHistoricalScanJob,
  getHistoricalScanJob,
  getHistoricalScanJobResult,
  getHistoricalScanEventByKey,
  historicalScanResultPaths,
  parseHistoricalScanResultPagination,
  recoverStaleHistoricalScanJobs,
} from '@/lib/server/trigger-discovery-historical-scan-jobs'
import type { TriggerHistoricalScanOptions } from '@/lib/server/trigger-discovery-historical-scan'
import { TRIGGER_DISCOVERY_HISTORICAL_SCAN_CONTRACT_VERSION } from '@/lib/trigger-discovery-historical-scan-contract'
import type {
  TriggerHistoricalScanEvent,
  TriggerHistoricalScanResponse,
} from '@/lib/trigger-discovery-historical-scan-contract'

const SOURCE_TABLES = [
  'trigger_evaluations',
  'trigger_evaluation_members',
  'trigger_lifecycle_events',
  'notification_outbox',
  'notification_delivery_attempts',
] as const

function scoreBreakdown() {
  return {
    proximity: 20,
    approach: 10,
    maTrend: 10,
    stageStructure: 10,
    liquidity: 5,
    total: 55,
    stageCoverage: 1,
    stageAvailableAxes: 6,
    maximums: { proximity: 30, approach: 20, maTrend: 20, stageStructure: 20, liquidity: 10 },
    explanations: { proximity: '', approach: '', maTrend: '', stageStructure: '', liquidity: '' },
  }
}

function event(index: number): TriggerHistoricalScanEvent {
  const eventType = (['ENTERED', 'RE_ENTRY', 'STATUS_CHANGED', 'EXITED'] as const)[index % 4]
  const changedStatus = Math.floor(index / 4) % 2 === 0 ? 'NEAR' : 'IN_ZONE'
  return {
    date: `2026-01-${String((index % 28) + 1).padStart(2, '0')}`,
    ticker: String(1000 + index),
    companyName: `Fixture ${index}`,
    eventType,
    previousStatus: eventType === 'ENTERED' ? null : eventType === 'RE_ENTRY' ? 'NOT_MATCHED' : eventType === 'STATUS_CHANGED' ? 'APPROACHING' : 'NEAR',
    currentStatus: eventType === 'EXITED'
      ? null
      : eventType === 'ENTERED'
        ? 'APPROACHING'
        : eventType === 'STATUS_CHANGED'
          ? changedStatus
          : 'NEAR',
    snapshotBasis: eventType === 'EXITED' ? 'PREVIOUS' : 'CURRENT',
    price: 100 + index,
    ma1: 95,
    ma2: 90,
    zoneDistancePct: 1,
    triggerScore: 55,
    scoreBreakdown: scoreBreakdown(),
    priceDate: '2026-01-30',
    maDate: '2026-01-30',
    stageDate: '2026-01-30',
    dayAStage: 1,
    dayBStage: 2,
    weekAStage: 3,
    weekBStage: 4,
    monthAStage: 5,
    monthBStage: 6,
  }
}

function response(totalEvents: number, days = 10): TriggerHistoricalScanResponse {
  return {
    contractVersion: TRIGGER_DISCOVERY_HISTORICAL_SCAN_CONTRACT_VERSION,
    scanMeta: {
      requestedStartDate: '2999-01-01',
      resolvedStartDate: '2999-01-01',
      requestedEndDate: '2999-01-10',
      resolvedEndDate: '2999-01-10',
      tradingDayCount: days,
      processedTradingDays: days,
      timeframe: 'MONTHLY',
      ma1Period: 20,
      ma2Period: 25,
      sampling: 'EACH_MARKET_TRADING_DAY',
      baselineDate: '2999-01-01',
      baselineCandidateCount: 0,
      universeContract: 'reconstructed_from_currently_held_trade_history',
      universeNote: 'fixture',
    },
    criteria: {
      maxApproachDistancePct: 5,
      nearDistancePct: 2,
      liquidityLookbackSessions: 20,
      maxPriceStalenessSessions: 3,
      markets: null,
      priceMin: null,
      priceMax: null,
      averageVolumeMin: null,
      averageVolumeMax: null,
      averageTradingValueMin: null,
      averageTradingValueMax: null,
      stageFilters: {},
    },
    summary: {
      tradingDays: days,
      uniqueCandidateCount: totalEvents,
      enteredCount: totalEvents,
      reEntryCount: 0,
      statusChangeCount: 0,
      exitedCount: 0,
      totalEventCount: totalEvents,
      maxDailyCandidates: totalEvents,
      averageDailyCandidates: totalEvents,
    },
    dailyCounts: Array.from({ length: days }, (_, index) => ({
      date: `2999-01-${String(index + 1).padStart(2, '0')}`,
      candidateCount: totalEvents,
      approachingCount: totalEvents,
      nearCount: 0,
      inZoneCount: 0,
    })),
    events: [],
    eventPage: { offset: 0, limit: 1, returnedCount: 0, totalCount: totalEvents, hasMore: totalEvents > 0 },
    performance: {
      totalMs: 10,
      queryCount: 5,
      tradingDays: days,
      sourceTickerCount: totalEvents,
      sourceRows: { ohlcv: 0, storedMonthlyMa: 0, weeklyOhlcv: 0, stage: 0 },
      sqlMs: { marketSessions: 0, universe: 0, ohlcv: 0, storedMonthlyMa: 0, weeklyOhlcv: 0, stage: 0, total: 0 },
      seriesBuildMs: 0,
      maPreparationMs: 0,
      liquidityMs: 0,
      universeFilterMs: 0,
      triggerEngineMs: 0,
      stageJoinMs: 0,
      scoreMs: 0,
      eventDerivationMs: 0,
      peakHeapBytes: 0,
      peakRssBytes: 0,
      heapDeltaBytes: 0,
    },
  }
}

function fakeScan(totalEvents = 1_000, fail = false) {
  return async (_input: Parameters<NonNullable<HistoricalScanTestRunner>>[0], options: TriggerHistoricalScanOptions = {}) => {
    await options.onProgress?.({ processedTradingDays: 0, totalTradingDays: 10 })
    for (let processed = 1; processed <= 10; processed += 1) {
      await options.onProgress?.({ processedTradingDays: processed, totalTradingDays: 10 })
    }
    if (fail) throw new Error('fixture failure')
    const events = Array.from({ length: totalEvents }, (_, index) => event(index))
    await options.onEvents?.('2999-01-10', events)
    return response(totalEvents)
  }
}

type HistoricalScanTestRunner = Parameters<typeof executeHistoricalScanJob>[1] extends { scan?: infer T }
  ? T
  : never

async function removeResult(id: string): Promise<void> {
  const paths = historicalScanResultPaths(id)
  await Promise.all(Object.values(paths).map((file) => rm(file, { force: true })))
}

async function reset(): Promise<void> {
  const ids = await execAll<{ id: string }>('SELECT id FROM historical_trigger_scan_jobs')
  for (const row of ids) await removeResult(row.id)
  await execRun('DELETE FROM historical_trigger_scan_jobs')
}

async function sideEffects(): Promise<Record<string, number>> {
  const values: Record<string, number> = {}
  for (const table of SOURCE_TABLES) {
    const row = await execGet<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`)
    values[table] = Number(row?.count ?? 0)
  }
  return values
}

async function main() {
  await reset()
  const before = await sideEffects()
  assert.throws(() => parseHistoricalScanResultPagination('http://localhost/?eventLimit=5001'), /eventLimit/)
  assert.throws(() => parseHistoricalScanResultPagination('http://localhost/?eventType=UNKNOWN'), /eventType/)
  assert.throws(() => parseHistoricalScanResultPagination('http://localhost/?currentStatus=UNKNOWN'), /currentStatus/)
  assert.throws(() => parseHistoricalScanResultPagination('http://localhost/?eventDate=2026-02-30'), /eventDate/)
  assert.throws(() => parseHistoricalScanResultPagination('http://localhost/?eventOrder=sideways'), /eventOrder/)
  assert.deepEqual(
    parseHistoricalScanResultPagination('http://localhost/?eventOffset=100&eventLimit=50&eventType=STATUS_CHANGED&currentStatus=NEAR&eventDate=2026-01-03&eventSearch=Fixture%209&eventOrder=desc'),
    {
      eventOffset: 100,
      eventLimit: 50,
      eventType: 'STATUS_CHANGED',
      currentStatus: 'NEAR',
      eventDate: '2026-01-03',
      eventSearch: 'Fixture 9',
      eventOrder: 'desc',
    },
  )
  await assert.rejects(() => createHistoricalScanJob({
    startDate: 'invalid', endDate: '2999-01-10', timeframe: 'MONTHLY',
  }), /YYYY-MM-DD/)

  const first = await createHistoricalScanJob({
    startDate: '2999-01-01', endDate: '2999-01-10', timeframe: 'MONTHLY', ma1Period: 20, ma2Period: 25,
  })
  assert.equal(first.status, 'QUEUED')
  assert.equal(first.reused, false)
  const duplicate = await createHistoricalScanJob({
    startDate: '2999-01-01', endDate: '2999-01-10', timeframe: 'MONTHLY', ma1Period: 20, ma2Period: 25,
  })
  assert.equal(duplicate.jobId, first.jobId)
  assert.equal(duplicate.reused, true)
  assert.equal((await getHistoricalScanJob(first.jobId))?.progress.processedTradingDays, 0)
  assert.equal(await getHistoricalScanJobResult({ id: first.jobId, eventOffset: 0, eventLimit: 10 }), 'NOT_READY')
  assert.equal(await getHistoricalScanEventByKey({ id: first.jobId, eventKey: 'e0' }), 'NOT_READY')

  const cancelledQueued = await cancelHistoricalScanJob(first.jobId)
  assert.equal(cancelledQueued?.status, 'CANCELLED')

  const spreadJob = await createHistoricalScanJob({
    startDate: '2999-01-01',
    endDate: '2999-01-10',
    timeframe: 'MONTHLY',
    ma1Period: 20,
    ma2Period: 25,
    spreadExpansionEnabled: true,
    spreadLookbackIntervals: 4,
    minExpansionRatio: 0.7,
    requireBullishMaOrder: true,
  })
  assert.notEqual(spreadJob.jobId, first.jobId, 'Spread ON must have a distinct Historical Job signature')
  const storedSpreadJob = await getHistoricalScanJob(spreadJob.jobId)
  assert.equal(storedSpreadJob?.request.spreadExpansionEnabled, true)
  assert.equal(storedSpreadJob?.request.spreadLookbackIntervals, 4)
  assert.equal(storedSpreadJob?.request.minExpansionRatio, 0.7)
  assert.equal(await cancelHistoricalScanJob(spreadJob.jobId).then((job) => job?.status), 'CANCELLED')

  const completedStart = await createHistoricalScanJob({
    startDate: '2999-02-01', endDate: '2999-02-10', timeframe: 'MONTHLY', ma1Period: 20, ma2Period: 25,
  })
  const completedClaim = await claimNextHistoricalScanJob('11111111-1111-4111-8111-111111111111')
  assert.equal(completedClaim?.id, completedStart.jobId)

  const second = await createHistoricalScanJob({
    startDate: '2999-03-01', endDate: '2999-03-10', timeframe: 'BIWEEKLY', ma1Period: 20, ma2Period: 25,
  })
  assert.equal(await claimNextHistoricalScanJob('22222222-2222-4222-8222-222222222222'), null,
    'Concurrency=1 must not claim a second job while one is running')

  assert.equal(await executeHistoricalScanJob(completedClaim!, { scan: fakeScan() as HistoricalScanTestRunner }), 'COMPLETED')
  const completed = await getHistoricalScanJob(completedStart.jobId)
  assert.equal(completed?.status, 'COMPLETED')
  assert.deepEqual(completed?.progress, { processedTradingDays: 10, totalTradingDays: 10 })
  assert.ok((completed?.resultSizeBytes ?? 0) > 0)
  const firstPage = await getHistoricalScanJobResult({ id: completedStart.jobId, eventOffset: 0, eventLimit: 100 })
  const lastPage = await getHistoricalScanJobResult({ id: completedStart.jobId, eventOffset: 900, eventLimit: 100 })
  assert.ok(firstPage && typeof firstPage === 'object')
  assert.ok(lastPage && typeof lastPage === 'object')
  assert.equal(firstPage.events.length, 100)
  assert.equal(firstPage.eventPage.totalCount, 1_000)
  assert.equal(firstPage.eventPage.hasMore, true)
  assert.equal(lastPage.events.length, 100)
  assert.equal(lastPage.eventPage.hasMore, false)
  assert.equal(firstPage.events[0].ticker, '1000')
  assert.equal(firstPage.events[0].eventKey, 'e0')
  assert.equal(lastPage.events[0].ticker, '1900')
  assert.equal(lastPage.events[0].eventKey, 'ep0')
  const byKey = await getHistoricalScanEventByKey({ id: completedStart.jobId, eventKey: lastPage.events[0].eventKey! })
  assert.ok(byKey && typeof byKey === 'object')
  assert.equal(byKey.event.ticker, '1900')
  assert.equal(byKey.event.price, 1000)
  assert.equal(byKey.timeframe, 'MONTHLY')
  assert.equal(await getHistoricalScanEventByKey({ id: completedStart.jobId, eventKey: 'einvalid!' }), null)
  assert.equal(await getHistoricalScanEventByKey({ id: completedStart.jobId, eventKey: 'ezzzzzz' }), null)

  const descendingFirst = await getHistoricalScanJobResult({
    id: completedStart.jobId, eventOffset: 0, eventLimit: 100, eventOrder: 'desc',
  })
  const descendingSecond = await getHistoricalScanJobResult({
    id: completedStart.jobId, eventOffset: 100, eventLimit: 100, eventOrder: 'desc',
  })
  assert.ok(descendingFirst && typeof descendingFirst === 'object')
  assert.ok(descendingSecond && typeof descendingSecond === 'object')
  assert.equal(descendingFirst.events[0].ticker, '1999')
  assert.equal(descendingSecond.events[0].ticker, '1899')
  assert.equal(
    descendingFirst.events.some((item) => descendingSecond.events.some((next) => next.ticker === item.ticker)),
    false,
    'Adjacent descending pages must not overlap',
  )

  const entered = await getHistoricalScanJobResult({
    id: completedStart.jobId, eventOffset: 0, eventLimit: 50, eventType: 'ENTERED', eventOrder: 'desc',
  })
  assert.ok(entered && typeof entered === 'object')
  assert.equal(entered.eventPage.totalCount, 250)
  assert.ok(entered.events.every((item) => item.eventType === 'ENTERED'))
  assert.equal(entered.events[0].ticker, '1996')
  assert.equal(entered.events[0].eventKey, 'ero')
  assert.equal((await getHistoricalScanEventByKey({ id: completedStart.jobId, eventKey: entered.events[0].eventKey! }) as { event: TriggerHistoricalScanEvent }).event.ticker, '1996')

  const nearEntries = await getHistoricalScanJobResult({
    id: completedStart.jobId,
    eventOffset: 0,
    eventLimit: 20,
    eventType: 'STATUS_CHANGED',
    currentStatus: 'NEAR',
    eventOrder: 'asc',
  })
  const nearEntriesSecondPage = await getHistoricalScanJobResult({
    id: completedStart.jobId,
    eventOffset: 20,
    eventLimit: 20,
    eventType: 'STATUS_CHANGED',
    currentStatus: 'NEAR',
    eventOrder: 'asc',
  })
  assert.ok(nearEntries && typeof nearEntries === 'object')
  assert.ok(nearEntriesSecondPage && typeof nearEntriesSecondPage === 'object')
  assert.equal(nearEntries.eventPage.totalCount, 125)
  assert.ok(nearEntries.events.every((item) => item.eventType === 'STATUS_CHANGED' && item.currentStatus === 'NEAR'))
  assert.equal(nearEntries.events.some((item) => item.currentStatus === 'IN_ZONE'), false)
  assert.equal(
    nearEntries.events.some((item) => nearEntriesSecondPage.events.some((next) => next.ticker === item.ticker)),
    false,
    'Adjacent NEAR-entry pages must not overlap',
  )

  const inZoneEntries = await getHistoricalScanJobResult({
    id: completedStart.jobId,
    eventOffset: 0,
    eventLimit: 20,
    eventType: 'STATUS_CHANGED',
    currentStatus: 'IN_ZONE',
    eventOrder: 'desc',
  })
  assert.ok(inZoneEntries && typeof inZoneEntries === 'object')
  assert.equal(inZoneEntries.eventPage.totalCount, 125)
  assert.ok(inZoneEntries.events.every((item) => item.eventType === 'STATUS_CHANGED' && item.currentStatus === 'IN_ZONE'))
  assert.equal(inZoneEntries.events.some((item) => item.currentStatus === 'NEAR'), false)

  const dateOnly = await getHistoricalScanJobResult({
    id: completedStart.jobId,
    eventOffset: 0,
    eventLimit: 100,
    eventDate: '2026-01-03',
    eventOrder: 'asc',
  })
  assert.ok(dateOnly && typeof dateOnly === 'object')
  assert.equal(dateOnly.eventPage.totalCount, 36)
  assert.ok(dateOnly.events.every((item) => item.date === '2026-01-03'))

  const dateAndNear = await getHistoricalScanJobResult({
    id: completedStart.jobId,
    eventOffset: 0,
    eventLimit: 100,
    eventType: 'STATUS_CHANGED',
    currentStatus: 'NEAR',
    eventDate: '2026-01-03',
    eventOrder: 'asc',
  })
  const dateAndInZone = await getHistoricalScanJobResult({
    id: completedStart.jobId,
    eventOffset: 0,
    eventLimit: 100,
    eventType: 'STATUS_CHANGED',
    currentStatus: 'IN_ZONE',
    eventDate: '2026-01-03',
    eventOrder: 'desc',
  })
  assert.ok(dateAndNear && typeof dateAndNear === 'object')
  assert.ok(dateAndInZone && typeof dateAndInZone === 'object')
  assert.equal(dateAndNear.eventPage.totalCount, 18)
  assert.equal(dateAndInZone.eventPage.totalCount, 18)
  assert.ok(dateAndNear.events.every((item) => item.date === '2026-01-03' && item.currentStatus === 'NEAR'))
  assert.ok(dateAndInZone.events.every((item) => item.date === '2026-01-03' && item.currentStatus === 'IN_ZONE'))
  assert.equal(dateAndNear.events[0].ticker, '1002', 'Ascending date/status sort must start at the first matching event')
  assert.equal(dateAndInZone.events[0].ticker, '1982', 'Descending date/status sort must start at the last matching event')

  const dateNearAndTicker = await getHistoricalScanJobResult({
    id: completedStart.jobId,
    eventOffset: 0,
    eventLimit: 20,
    eventType: 'STATUS_CHANGED',
    currentStatus: 'NEAR',
    eventDate: '2026-01-03',
    eventSearch: '1002',
    eventOrder: 'asc',
  })
  assert.ok(dateNearAndTicker && typeof dateNearAndTicker === 'object')
  assert.equal(dateNearAndTicker.eventPage.totalCount, 1)
  assert.equal(dateNearAndTicker.events[0].ticker, '1002')

  const searched = await getHistoricalScanJobResult({
    id: completedStart.jobId, eventOffset: 0, eventLimit: 50, eventSearch: '1000', eventOrder: 'desc',
  })
  assert.ok(searched && typeof searched === 'object')
  assert.equal(searched.eventPage.totalCount, 1)
  assert.equal(searched.events[0].ticker, '1000')

  const reusedCompleted = await createHistoricalScanJob({
    startDate: '2999-02-01', endDate: '2999-02-10', timeframe: 'MONTHLY', ma1Period: 20, ma2Period: 25,
  })
  assert.equal(reusedCompleted.jobId, completedStart.jobId)
  assert.equal(reusedCompleted.status, 'COMPLETED')

  const signatureRow = await execGet<{ request_signature: string }>(
    'SELECT request_signature FROM historical_trigger_scan_jobs WHERE id=?', [completedStart.jobId],
  )
  assert.ok(signatureRow)
  await execRun('UPDATE historical_trigger_scan_jobs SET request_signature=? WHERE id=?',
    ['legacy-algorithm', completedStart.jobId])
  assert.equal((await getHistoricalScanJob(completedStart.jobId))?.resultAvailable, false)
  assert.equal(await getHistoricalScanJobResult({ id: completedStart.jobId, eventOffset: 0, eventLimit: 10 }), 'EXPIRED')
  assert.equal(await getHistoricalScanEventByKey({ id: completedStart.jobId, eventKey: 'e0' }), 'EXPIRED')
  const expiredRoute = await getFollowUpRoute(
    new Request(`http://localhost/api/trigger-discovery/historical-scan/jobs/${completedStart.jobId}/events/e0/follow-up`),
    { params: Promise.resolve({ jobId: completedStart.jobId, eventKey: 'e0' }) },
  )
  assert.equal(expiredRoute.status, 410)
  await execRun('UPDATE historical_trigger_scan_jobs SET request_signature=? WHERE id=?',
    [signatureRow.request_signature, completedStart.jobId])
  assert.equal((await getHistoricalScanJob(completedStart.jobId))?.resultAvailable, true)

  await execRun('UPDATE historical_trigger_scan_jobs SET expires_at=1 WHERE id=?', [completedStart.jobId])
  assert.equal(
    await getHistoricalScanJobResult({ id: completedStart.jobId, eventOffset: 0, eventLimit: 100 }),
    'EXPIRED',
  )
  assert.equal(await getHistoricalScanEventByKey({ id: completedStart.jobId, eventKey: 'e0' }), 'EXPIRED')
  assert.equal((await getHistoricalScanJob(completedStart.jobId))?.resultAvailable, false)

  const secondClaim = await claimNextHistoricalScanJob('33333333-3333-4333-8333-333333333333')
  assert.equal(secondClaim?.id, second.jobId)
  await execRun(`UPDATE historical_trigger_scan_jobs SET status='CANCEL_REQUESTED', cancel_requested=1 WHERE id=?`, [second.jobId])
  assert.equal(await executeHistoricalScanJob(secondClaim!, { scan: fakeScan(10) as HistoricalScanTestRunner }), 'CANCELLED')
  assert.equal((await getHistoricalScanJob(second.jobId))?.status, 'CANCELLED')

  const failedStart = await createHistoricalScanJob({
    startDate: '2999-04-01', endDate: '2999-04-10', timeframe: 'MONTHLY', ma1Period: 20, ma2Period: 25,
  })
  const failedClaim = await claimNextHistoricalScanJob('44444444-4444-4444-8444-444444444444')
  assert.equal(failedClaim?.id, failedStart.jobId)
  await assert.rejects(
    () => executeHistoricalScanJob(failedClaim!, { scan: fakeScan(0, true) as HistoricalScanTestRunner }),
    /fixture failure/,
  )
  assert.equal((await getHistoricalScanJob(failedStart.jobId))?.status, 'FAILED')

  const emptyStart = await createHistoricalScanJob({
    startDate: '2999-04-11', endDate: '2999-04-20', timeframe: 'BIWEEKLY', ma1Period: 20, ma2Period: 25,
  })
  const emptyClaim = await claimNextHistoricalScanJob('66666666-6666-4666-8666-666666666666')
  assert.equal(emptyClaim?.id, emptyStart.jobId)
  assert.equal(await executeHistoricalScanJob(emptyClaim!, { scan: fakeScan(0) as HistoricalScanTestRunner }), 'COMPLETED')
  const emptyResult = await getHistoricalScanJobResult({ id: emptyStart.jobId, eventOffset: 0, eventLimit: 100 })
  assert.ok(emptyResult && typeof emptyResult === 'object')
  assert.equal(emptyResult.events.length, 0)
  assert.equal(emptyResult.eventPage.totalCount, 0)

  const staleStart = await createHistoricalScanJob({
    startDate: '2999-05-01', endDate: '2999-05-10', timeframe: 'BIWEEKLY', ma1Period: 20, ma2Period: 25,
  })
  const staleClaim = await claimNextHistoricalScanJob('55555555-5555-4555-8555-555555555555')
  assert.equal(staleClaim?.id, staleStart.jobId)
  await execRun(`UPDATE historical_trigger_scan_jobs SET heartbeat_at=1 WHERE id=?`, [staleStart.jobId])
  const recovery = await recoverStaleHistoricalScanJobs(() => Date.now() + 10 * 60_000, () => false)
  assert.equal(recovery.requeued, 1)
  assert.equal((await getHistoricalScanJob(staleStart.jobId))?.status, 'QUEUED')
  await execRun(`UPDATE historical_trigger_scan_jobs SET
    status='RUNNING', owner_token='stale-owner', heartbeat_at=1, attempt_count=2
    WHERE id=?`, [staleStart.jobId])
  const exhaustedRecovery = await recoverStaleHistoricalScanJobs(() => Date.now() + 20 * 60_000, () => false)
  assert.equal(exhaustedRecovery.failed, 1)
  assert.equal((await getHistoricalScanJob(staleStart.jobId))?.status, 'FAILED')

  const after = await sideEffects()
  assert.deepEqual(after, before, 'Historical Scan Jobs must not affect Evaluation/Lifecycle/Notification tables')
  console.log(JSON.stringify({
    completedJob: completedStart.jobId,
    resultSizeBytes: completed?.resultSizeBytes,
    pagination: { first: firstPage.eventPage, last: lastPage.eventPage },
    cancellation: 'CANCELLED',
    failure: 'FAILED',
    staleRecovery: { first: recovery, exhausted: exhaustedRecovery },
    sideEffects: after,
  }, null, 2))
  await reset()
  console.log('Trigger Discovery historical scan job tests passed')
}

main().catch(async (error) => {
  console.error(error)
  await reset().catch(() => undefined)
  process.exitCode = 1
})
