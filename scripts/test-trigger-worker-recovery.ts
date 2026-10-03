import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { client, ensureReady, execGet, execRun } from '@/lib/db/client'
import {
  cancelHistoricalScanJob,
  claimNextHistoricalScanJob,
  createHistoricalScanJob,
  executeHistoricalScanJob,
  getHistoricalScanJobResult,
  historicalScanResultPaths,
  recoverStaleHistoricalScanJobs,
} from '@/lib/server/trigger-discovery-historical-scan-jobs'
import {
  cancelOutcomeAnalysisJob,
  claimNextOutcomeJob,
  createOutcomeAnalysisJob,
  executeOutcomeAnalysisJob,
  getOutcomeAnalysisResult,
  outcomeResultPaths,
  recoverStaleOutcomeJobs,
} from '@/lib/server/trigger-discovery-outcome-jobs'
import {
  acquireHistoricalWorker,
  createWorkerIdentity,
  ownerLiveness,
  recoverWorkerJobs,
  releaseHistoricalWorker,
} from '@/lib/server/trigger-historical-worker-ownership'
import type { TriggerHistoricalScanEvent } from '@/lib/trigger-discovery-historical-scan-contract'

const qaIds: { historical: string[]; outcome: string[] } = { historical: [], outcome: [] }
const activeChildren = new Set<ChildProcess>()
const event = {
  date: '2025-01-02', ticker: '1000', companyName: 'Recovery Fixture',
  eventType: 'ENTERED', previousStatus: 'NOT_MATCHED', currentStatus: 'NEAR',
  snapshotBasis: 'CURRENT', price: 100, ma1: 95, ma2: 90, zoneDistancePct: 1,
  triggerScore: 70, scoreBreakdown: {
    proximity: 25, approach: 15, maTrend: 10, stageStructure: 12, liquidity: 8,
    total: 70, stageCoverage: 1, stageAvailableAxes: 6,
    maximums: { proximity: 30, approach: 20, maTrend: 20, stageStructure: 20, liquidity: 10 },
    explanations: { proximity: '', approach: '', maTrend: '', stageStructure: '', liquidity: '' },
  },
  priceDate: '2025-01-02', maDate: '2025-01-02', stageDate: '2025-01-02',
  dayAStage: 1, dayBStage: 2, weekAStage: 3, weekBStage: 4, monthAStage: 5, monthBStage: 6,
} as TriggerHistoricalScanEvent

const fixtureScan = (async (_input: unknown, options?: {
  onProgress?: (progress: { processedTradingDays: number; totalTradingDays: number }) => Promise<void>
  onEvents?: (date: string, events: TriggerHistoricalScanEvent[]) => Promise<void>
}) => {
  await options?.onProgress?.({ processedTradingDays: 1, totalTradingDays: 2 })
  await options?.onEvents?.(event.date, [event])
  await options?.onProgress?.({ processedTradingDays: 2, totalTradingDays: 2 })
  return {
    contractVersion: 'trigger-discovery-historical-scan-v1',
    scanMeta: {
      requestedStartDate: '2025-01-01', requestedEndDate: '2025-01-03',
      resolvedStartDate: '2025-01-02', resolvedEndDate: '2025-01-03',
      tradingDayCount: 2, processedTradingDays: 2, timeframe: 'MONTHLY',
      ma1Period: 20, ma2Period: 25,
    },
    summary: {
      tradingDays: 2, uniqueCandidateCount: 1, enteredCount: 1, reEntryCount: 0,
      statusChangeCount: 0, exitedCount: 0, totalEventCount: 1,
      maxDailyCandidates: 1, averageDailyCandidates: 0.5,
    },
    dailyCounts: [
      { date: '2025-01-02', candidateCount: 1, approachingCount: 0, nearCount: 1, inZoneCount: 0 },
      { date: '2025-01-03', candidateCount: 0, approachingCount: 0, nearCount: 0, inZoneCount: 0 },
    ],
    events: [], eventPage: { offset: 0, limit: 1, returnedCount: 0, totalCount: 1, hasMore: true },
  }
}) as unknown as NonNullable<NonNullable<Parameters<typeof executeHistoricalScanJob>[1]>['scan']>

async function childMain(type: 'historical' | 'outcome') {
  await ensureReady()
  const identity = createWorkerIdentity()
  assert.equal(await acquireHistoricalWorker(identity, () => false), true)
  const job = type === 'historical'
    ? await claimNextHistoricalScanJob(identity.jobOwner())
    : await claimNextOutcomeJob(identity.jobOwner())
  assert.ok(job)
  process.stdout.write(`READY ${job.id} ${identity.owner}\n`)
  setInterval(() => undefined, 1_000)
}

async function startOwner(type: 'historical' | 'outcome', expectedId: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--import', 'tsx', path.resolve(process.argv[1]!), '--child', type], {
    cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  activeChildren.add(child)
  const ready = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('child did not claim job')), 15_000)
    let output = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString()
      const line = output.match(/READY ([^ ]+) ([^\n]+)\n/)
      if (line) { clearTimeout(timeout); resolve(line[1]!) }
    })
    child.once('error', reject)
    child.once('exit', (code) => reject(new Error(`child exited before claim: ${code}`)))
  })
  assert.equal(ready, expectedId)
  return child
}

async function killOwner(child: ChildProcess): Promise<void> {
  const exit = once(child, 'exit')
  assert.equal(child.kill('SIGKILL'), true)
  await exit
  activeChildren.delete(child)
}

async function cloneHistorical(source: string, createdOffset: number): Promise<string> {
  const id = randomUUID()
  qaIds.historical.push(id)
  await execRun(`INSERT INTO historical_trigger_scan_jobs (
    id,status,request_json,request_signature,source_fingerprint,requested_start,requested_end,
    timeframe,created_at,total_trading_days,expires_at
  ) SELECT ?, 'QUEUED', request_json, request_signature, source_fingerprint, requested_start, requested_end,
    timeframe, created_at+?, total_trading_days, expires_at
    FROM historical_trigger_scan_jobs WHERE id=?`, [id, createdOffset, source])
  return id
}

async function cloneOutcome(source: string, createdOffset: number): Promise<string> {
  const id = randomUUID()
  qaIds.outcome.push(id)
  await execRun(`INSERT INTO trigger_outcome_analysis_jobs (
    id,status,historical_scan_job_id,request_json,request_signature,source_fingerprint,
    analysis_cutoff_date,created_at,expires_at
  ) SELECT ?, 'QUEUED', historical_scan_job_id, request_json, ?, source_fingerprint,
    analysis_cutoff_date,created_at+?,expires_at
    FROM trigger_outcome_analysis_jobs WHERE id=?`, [id, `qa-${id}`, createdOffset, source])
  return id
}

async function insertPriceSeries(): Promise<void> {
  for (let index = 0; index <= 65; index += 1) {
    const date = new Date(Date.UTC(2025, 0, 2 + index)).toISOString().slice(0, 10)
    const close = 100 + index
    await execRun(`INSERT OR REPLACE INTO ohlcv_daily
      (ticker,date,open,high,low,close,volume) VALUES ('1000',?,?,?,?,?,1000)`,
    [date, close, close + 2, close - 2, close])
  }
}

async function cleanQa(): Promise<void> {
  for (const child of activeChildren) {
    if (child.exitCode == null) child.kill('SIGKILL')
  }
  for (const id of qaIds.outcome) {
    await execRun('DELETE FROM trigger_outcome_analysis_jobs WHERE id=?', [id])
    await Promise.all(Object.values(outcomeResultPaths(id)).map((file) => rm(file, { force: true })))
  }
  for (const id of qaIds.historical) {
    await execRun('DELETE FROM historical_trigger_scan_jobs WHERE id=?', [id])
    await Promise.all(Object.values(historicalScanResultPaths(id)).map((file) => rm(file, { force: true })))
  }
  await execRun("DELETE FROM ohlcv_daily WHERE ticker='1000' AND date BETWEEN '2025-01-02' AND '2025-03-10'")
}

async function main(): Promise<void> {
  await ensureReady()
  const started = await createHistoricalScanJob({
    startDate: '2025-01-01', endDate: '2025-01-03', timeframe: 'MONTHLY', ma1Period: 20, ma2Period: 25,
  })
  qaIds.historical.push(started.jobId)
  const baselineClaim = await claimNextHistoricalScanJob()
  assert.equal(baselineClaim?.id, started.jobId)
  assert.equal(await executeHistoricalScanJob(baselineClaim!, { scan: fixtureScan }), 'COMPLETED')
  const baseline = await getHistoricalScanJobResult({ id: started.jobId, eventOffset: 0, eventLimit: 10 })
  assert.ok(baseline && typeof baseline === 'object')

  const a = await cloneHistorical(started.jobId, 1)
  const b = await cloneHistorical(started.jobId, 2)
  const child = await startOwner('historical', a)
  const activeOwner = await execGet<{ owner_token: string; heartbeat_at: number }>(
    'SELECT owner_token,heartbeat_at FROM historical_trigger_scan_jobs WHERE id=?', [a],
  )
  assert.equal(ownerLiveness(activeOwner!.owner_token), 'alive')
  assert.deepEqual(await recoverWorkerJobs('historical_trigger_scan_jobs', 'startup'),
    { requeued: 0, failed: 0, cancelled: 0 })
  assert.deepEqual(await recoverStaleHistoricalScanJobs(() => Date.now() + 10 * 60_000),
    { requeued: 0, failed: 0, cancelled: 0 })
  const rival = createWorkerIdentity()
  assert.equal(await acquireHistoricalWorker(rival, () => false), false)
  assert.equal(await claimNextHistoricalScanJob(), null)
  await killOwner(child)
  assert.equal(ownerLiveness(activeOwner!.owner_token), 'dead')
  assert.equal(await acquireHistoricalWorker(rival, () => false), true)
  const recoveryStarted = performance.now()
  assert.equal((await recoverWorkerJobs('historical_trigger_scan_jobs', 'startup')).requeued, 1)
  const recoveryMs = performance.now() - recoveryStarted
  assert.ok(Math.floor(Date.now() / 1_000) - Number(activeOwner!.heartbeat_at) < 180)
  const partial = historicalScanResultPaths(a)
  await mkdir(path.dirname(partial.manifest), { recursive: true })
  await writeFile(partial.manifestTemp, '{"partial":true}')
  await writeFile(partial.eventsTemp, '{"partial":true}\n')
  assert.equal(await getHistoricalScanJobResult({ id: a, eventOffset: 0, eventLimit: 10 }), 'NOT_READY')
  const aClaim = await claimNextHistoricalScanJob(rival.jobOwner())
  assert.equal(aClaim?.id, a)
  assert.equal(await executeHistoricalScanJob(aClaim!, { scan: fixtureScan }), 'COMPLETED')
  const bClaim = await claimNextHistoricalScanJob(rival.jobOwner())
  assert.equal(bClaim?.id, b)
  assert.equal(await executeHistoricalScanJob(bClaim!, { scan: fixtureScan }), 'COMPLETED')
  const recovered = await getHistoricalScanJobResult({ id: a, eventOffset: 0, eventLimit: 10 })
  assert.ok(recovered && typeof recovered === 'object')
  assert.deepEqual(recovered.summary, baseline.summary)
  assert.deepEqual(recovered.dailyCounts, baseline.dailyCounts)
  assert.deepEqual(recovered.events, baseline.events)
  assert.equal((await readFile(partial.manifest, 'utf8')).includes('partial'), false)
  assert.equal(Number((await execGet<{ count: number }>(
    "SELECT COUNT(*) AS count FROM historical_trigger_scan_jobs WHERE id=? AND status='COMPLETED'", [a],
  ))?.count), 1)
  const gracefulHistorical = await cloneHistorical(started.jobId, 5)
  const gracefulClaim = await claimNextHistoricalScanJob(rival.jobOwner())
  assert.equal(gracefulClaim?.id, gracefulHistorical)
  const shutdown = new AbortController()
  shutdown.abort()
  assert.equal(await executeHistoricalScanJob(gracefulClaim!, { scan: fixtureScan, shutdownSignal: shutdown.signal }),
    'QUEUED')
  assert.equal((await execGet<{ attempt_count: number }>(
    'SELECT attempt_count FROM historical_trigger_scan_jobs WHERE id=?', [gracefulHistorical],
  ))?.attempt_count, 0)
  const resumedGracefully = await claimNextHistoricalScanJob(rival.jobOwner())
  assert.equal(resumedGracefully?.id, gracefulHistorical)
  assert.equal(await executeHistoricalScanJob(resumedGracefully!, { scan: fixtureScan }), 'COMPLETED')
  const exhausted = await cloneHistorical(started.jobId, 6)
  await execRun(`UPDATE historical_trigger_scan_jobs SET status='RUNNING', owner_token=?,
    attempt_count=2, heartbeat_at=unixepoch() WHERE id=?`, [activeOwner!.owner_token, exhausted])
  assert.equal((await recoverWorkerJobs('historical_trigger_scan_jobs', 'startup')).failed, 1)
  assert.equal((await execGet<{ status: string }>(
    'SELECT status FROM historical_trigger_scan_jobs WHERE id=?', [exhausted],
  ))?.status, 'FAILED')
  await releaseHistoricalWorker(rival)

  await insertPriceSeries()
  const outcomeStart = await createOutcomeAnalysisJob({ eventFilter: 'ENTERED', horizons: [20] }, started.jobId)
  qaIds.outcome.push(outcomeStart.jobId)
  const outcomeBaselineClaim = await claimNextOutcomeJob()
  assert.equal(outcomeBaselineClaim?.id, outcomeStart.jobId)
  assert.equal(await executeOutcomeAnalysisJob(outcomeBaselineClaim!), 'COMPLETED')
  const outcomeBaseline = await getOutcomeAnalysisResult({
    id: outcomeStart.jobId, query: { offset: 0, limit: 10, sortBy: 'eventDate', sortOrder: 'asc' },
  })
  assert.ok(outcomeBaseline && typeof outcomeBaseline === 'object')
  const outcomeA = await cloneOutcome(outcomeStart.jobId, 1)
  const outcomeB = await cloneOutcome(outcomeStart.jobId, 2)
  const outcomeChild = await startOwner('outcome', outcomeA)
  const outcomeOwner = await execGet<{ owner_token: string; heartbeat_at: number }>(
    'SELECT owner_token,heartbeat_at FROM trigger_outcome_analysis_jobs WHERE id=?', [outcomeA],
  )
  assert.deepEqual(await recoverWorkerJobs('trigger_outcome_analysis_jobs', 'startup'),
    { requeued: 0, failed: 0, cancelled: 0 })
  assert.deepEqual(await recoverStaleOutcomeJobs(() => Date.now() + 10 * 60_000),
    { requeued: 0, failed: 0, cancelled: 0 })
  await killOwner(outcomeChild)
  assert.equal((await recoverWorkerJobs('trigger_outcome_analysis_jobs', 'startup')).requeued, 1)
  assert.ok(Math.floor(Date.now() / 1_000) - Number(outcomeOwner!.heartbeat_at) < 180)
  const outcomeAClaim = await claimNextOutcomeJob()
  assert.equal(outcomeAClaim?.id, outcomeA)
  assert.equal(await executeOutcomeAnalysisJob(outcomeAClaim!), 'COMPLETED')
  const outcomeBClaim = await claimNextOutcomeJob()
  assert.equal(outcomeBClaim?.id, outcomeB)
  assert.equal(await executeOutcomeAnalysisJob(outcomeBClaim!), 'COMPLETED')
  const outcomeRecovered = await getOutcomeAnalysisResult({
    id: outcomeA, query: { offset: 0, limit: 10, sortBy: 'eventDate', sortOrder: 'asc' },
  })
  assert.ok(outcomeRecovered && typeof outcomeRecovered === 'object')
  assert.deepEqual(outcomeRecovered.summary, outcomeBaseline.summary)
  assert.deepEqual(outcomeRecovered.rows, outcomeBaseline.rows)
  assert.equal(outcomeRecovered.rows[0]?.return20, outcomeBaseline.rows[0]?.return20)
  assert.equal(outcomeRecovered.rows[0]?.mfe20, outcomeBaseline.rows[0]?.mfe20)
  assert.equal(outcomeRecovered.rows[0]?.mae20, outcomeBaseline.rows[0]?.mae20)
  const gracefulOutcome = await cloneOutcome(outcomeStart.jobId, 5)
  const gracefulOutcomeClaim = await claimNextOutcomeJob()
  assert.equal(gracefulOutcomeClaim?.id, gracefulOutcome)
  const outcomeShutdown = new AbortController()
  outcomeShutdown.abort()
  assert.equal(await executeOutcomeAnalysisJob(gracefulOutcomeClaim!, outcomeShutdown.signal), 'QUEUED')
  assert.equal((await execGet<{ attempt_count: number }>(
    'SELECT attempt_count FROM trigger_outcome_analysis_jobs WHERE id=?', [gracefulOutcome],
  ))?.attempt_count, 0)
  const resumedOutcome = await claimNextOutcomeJob()
  assert.equal(resumedOutcome?.id, gracefulOutcome)
  assert.equal(await executeOutcomeAnalysisJob(resumedOutcome!), 'COMPLETED')

  const cancelA = await cloneHistorical(started.jobId, 3)
  const cancelChild = await startOwner('historical', cancelA)
  assert.equal((await cancelHistoricalScanJob(cancelA))?.status, 'CANCEL_REQUESTED')
  await killOwner(cancelChild)
  assert.equal((await recoverWorkerJobs('historical_trigger_scan_jobs', 'startup')).cancelled, 1)
  assert.equal((await execGet<{ status: string }>(
    'SELECT status FROM historical_trigger_scan_jobs WHERE id=?', [cancelA],
  ))?.status, 'CANCELLED')

  const cancelOutcome = await cloneOutcome(outcomeStart.jobId, 3)
  const cancelOutcomeChild = await startOwner('outcome', cancelOutcome)
  assert.equal((await cancelOutcomeAnalysisJob(cancelOutcome))?.status, 'CANCEL_REQUESTED')
  await killOwner(cancelOutcomeChild)
  assert.equal((await recoverWorkerJobs('trigger_outcome_analysis_jobs', 'startup')).cancelled, 1)
  assert.equal((await execGet<{ status: string }>(
    'SELECT status FROM trigger_outcome_analysis_jobs WHERE id=?', [cancelOutcome],
  ))?.status, 'CANCELLED')

  const failed = await cloneHistorical(started.jobId, 4)
  await execRun("UPDATE historical_trigger_scan_jobs SET status='FAILED' WHERE id=?", [failed])
  assert.deepEqual(await recoverWorkerJobs('historical_trigger_scan_jobs', 'startup'),
    { requeued: 0, failed: 0, cancelled: 0 })
  assert.equal((await execGet<{ status: string }>(
    'SELECT status FROM historical_trigger_scan_jobs WHERE id=?', [failed],
  ))?.status, 'FAILED')
  const sideEffects = await execGet<{ count: number }>(
    'SELECT COUNT(*) AS count FROM notification_delivery_attempts',
  )
  assert.equal(Number(sideEffects?.count ?? 0), 0)
  console.log(JSON.stringify({ passed: true, recoveryMs, historical: [a, b], outcome: [outcomeA, outcomeB],
    freshHeartbeatRecovery: true, singleton: true, cancel: true, staleAliveProtected: true,
    resultIntegrity: true, gmailDeliveries: 0 }))
}

if (process.argv[2] === '--child') {
  childMain(process.argv[3] as 'historical' | 'outcome').catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
} else {
  main().finally(cleanQa).catch((error) => { console.error(error); process.exitCode = 1 })
}
