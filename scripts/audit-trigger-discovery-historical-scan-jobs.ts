import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { execGet, execRun } from '@/lib/db/client'
import { getTriggerHistoricalScan } from '@/lib/server/trigger-discovery-historical-scan'
import {
  createHistoricalScanJob,
  getHistoricalScanJob,
  getHistoricalScanJobResult,
  historicalScanResultPaths,
  runHistoricalScanWorkerOnce,
} from '@/lib/server/trigger-discovery-historical-scan-jobs'
import type {
  TriggerHistoricalScanEvent,
  TriggerHistoricalScanResponse,
} from '@/lib/trigger-discovery-historical-scan-contract'
import type { TriggerDiscoveryTimeframe } from '@/lib/trigger-discovery-timeframe'

type Case = {
  label: string
  startDate: string
  endDate: string
  timeframe: TriggerDiscoveryTimeframe
}

type SideEffects = {
  evaluations: number
  members: number
  lifecycle: number
  outbox: number
  deliveryAttempts: number
}

async function sideEffects(): Promise<SideEffects> {
  const row = await execGet<Record<string, number>>(`SELECT
    (SELECT COUNT(*) FROM trigger_evaluations) AS evaluations,
    (SELECT COUNT(*) FROM trigger_evaluation_members) AS members,
    (SELECT COUNT(*) FROM trigger_lifecycle_events) AS lifecycle,
    (SELECT COUNT(*) FROM notification_outbox) AS outbox,
    (SELECT COUNT(*) FROM notification_delivery_attempts) AS delivery_attempts`)
  return {
    evaluations: Number(row?.evaluations ?? 0),
    members: Number(row?.members ?? 0),
    lifecycle: Number(row?.lifecycle ?? 0),
    outbox: Number(row?.outbox ?? 0),
    deliveryAttempts: Number(row?.delivery_attempts ?? 0),
  }
}

async function removeQaJob(id: string): Promise<void> {
  const paths = historicalScanResultPaths(id)
  await Promise.all(Object.values(paths).map((file) => rm(file, { force: true })))
  await execRun('DELETE FROM historical_trigger_scan_jobs WHERE id=?', [id])
}

async function allEvents(id: string, total: number): Promise<TriggerHistoricalScanEvent[]> {
  const result: TriggerHistoricalScanEvent[] = []
  for (let offset = 0; offset < total; offset += 5_000) {
    const page = await getHistoricalScanJobResult({ id, eventOffset: offset, eventLimit: 5_000 })
    assert.ok(page && typeof page === 'object')
    result.push(...page.events)
  }
  return result
}

function comparable(response: TriggerHistoricalScanResponse) {
  return {
    contractVersion: response.contractVersion,
    scanMeta: response.scanMeta,
    criteria: response.criteria,
    summary: response.summary,
    dailyCounts: response.dailyCounts,
  }
}

async function runCase(input: Case) {
  const request = {
    startDate: input.startDate,
    endDate: input.endDate,
    timeframe: input.timeframe,
    ma1Period: 20,
    ma2Period: 25,
    eventOffset: 0,
    eventLimit: 1,
  } as const
  const directEvents: TriggerHistoricalScanEvent[] = []
  const directStartedAt = performance.now()
  const direct = await getTriggerHistoricalScan({
    requestedStartDate: input.startDate,
    requestedEndDate: input.endDate,
    timeframe: input.timeframe,
    criteria: { triggerConfig: { ma1Period: 20, ma2Period: 25 } },
    eventOffset: 0,
    eventLimit: 1,
  }, { onEvents: (_date, events) => { directEvents.push(...events) } })
  const directWallMs = performance.now() - directStartedAt

  const startStartedAt = performance.now()
  const started = await createHistoricalScanJob(request)
  const startMs = performance.now() - startStartedAt
  assert.equal(started.reused, false, `${input.label} must use a fresh QA job`)
  let poll: ReturnType<typeof setInterval> | null = null
  try {
    const progressSamples: number[] = []
    let pollPending = false
    poll = setInterval(() => {
      if (pollPending) return
      pollPending = true
      void getHistoricalScanJob(started.jobId)
        .then((job) => { if (job) progressSamples.push(job.progress.processedTradingDays) })
        .finally(() => { pollPending = false })
    }, 250)
    const workerStartedAt = performance.now()
    const worked = await runHistoricalScanWorkerOnce()
    const workerWallMs = performance.now() - workerStartedAt
    assert.equal(worked?.jobId, started.jobId)
    assert.equal(worked?.status, 'COMPLETED')
    const job = await getHistoricalScanJob(started.jobId)
    assert.equal(job?.status, 'COMPLETED')
    if (job) progressSamples.push(job.progress.processedTradingDays)
    const workerResponse = await getHistoricalScanJobResult({
      id: started.jobId,
      eventOffset: 0,
      eventLimit: 1,
    })
    assert.ok(workerResponse && typeof workerResponse === 'object')
    const workerEvents = await allEvents(started.jobId, workerResponse.summary.totalEventCount)
    assert.deepEqual(comparable(workerResponse), comparable(direct), `${input.label} response contract`)
    assert.deepEqual(workerEvents, directEvents, `${input.label} events`)
    assert.equal(workerResponse.performance.queryCount, 5, `${input.label} SQL count`)
    assert.equal(job?.progress.processedTradingDays, job?.progress.totalTradingDays)
    return {
      label: input.label,
      tradingDays: direct.scanMeta.tradingDayCount,
      events: direct.summary.totalEventCount,
      directWallMs: Math.round(directWallMs),
      workerWallMs: Math.round(workerWallMs),
      jobStartMs: Math.round(startMs * 100) / 100,
      jobDurationMs: Math.round(job?.durationMs ?? 0),
      resultSizeBytes: job?.resultSizeBytes ?? 0,
      progressMinimum: Math.min(0, ...progressSamples),
      progressMaximum: Math.max(0, ...progressSamples),
      exactMatch: true,
    }
  } finally {
    if (poll) clearInterval(poll)
    await removeQaJob(started.jobId)
  }
}

async function main() {
  const before = await sideEffects()
  const cases: Case[] = process.env.HISTORICAL_SCAN_JOB_SKIP_SHORT === '1' ? [] : [
    { label: 'monthly-3m', startDate: '2026-06-01', endDate: '2026-08-31', timeframe: 'MONTHLY' },
    { label: 'biweekly-3m', startDate: '2026-06-01', endDate: '2026-08-31', timeframe: 'BIWEEKLY' },
  ]
  if (process.env.HISTORICAL_SCAN_JOB_ONE_YEAR === '1') {
    cases.push(
      { label: 'monthly-1y', startDate: '2025-09-01', endDate: '2026-08-31', timeframe: 'MONTHLY' },
      { label: 'biweekly-1y', startDate: '2025-09-01', endDate: '2026-08-31', timeframe: 'BIWEEKLY' },
    )
  }
  if (process.env.HISTORICAL_SCAN_JOB_TWO_YEAR === '1') {
    cases.push({
      label: 'biweekly-2y',
      startDate: '2024-09-02',
      endDate: '2026-08-31',
      timeframe: 'BIWEEKLY',
    })
  }
  const selectedCases = process.env.HISTORICAL_SCAN_JOB_CASE
    ? cases.filter((item) => item.label === process.env.HISTORICAL_SCAN_JOB_CASE)
    : cases
  assert.ok(selectedCases.length > 0, 'No historical scan audit case selected')
  const results = []
  for (const item of selectedCases) results.push(await runCase(item))
  const after = await sideEffects()
  assert.deepEqual(after, before, 'Historical Scan Jobs must remain isolated from persistent Trigger side effects')
  console.log(JSON.stringify({ results, sideEffectsBefore: before, sideEffectsAfter: after }, null, 2))
  console.log('Trigger Discovery historical scan job real-data audit passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
