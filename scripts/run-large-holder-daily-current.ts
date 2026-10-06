import { spawn } from 'node:child_process'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  classifyLargeHolderDailyFailure,
  planLargeHolderDailyCurrent,
  type LargeHolderDailyFailure,
  type LargeHolderDailySnapshotStatus,
} from '@/lib/large-holders/daily-current-automation'

type Result = LargeHolderDailyFailure | 'ALREADY_CURRENT' | 'REFRESHED'
type Event = {
  started_at: string
  completed_at: string
  market_date: string | null
  price_evidence_date: string | null
  previous_snapshot_date: string | null
  action: string
  result: Result
  new_snapshot_date: string | null
  certification_status: string | null
  duration_ms: number
  failure_reason: string | null
  source_discovery: 'ENABLED' | 'SKIPPED_NO_API_KEY' | 'NOT_RUN'
}

const args = new Set(process.argv.slice(2))
const statusOnly = args.has('status')
const dryRun = args.has('--dry-run')
const operationsDir = process.env.LARGE_HOLDER_OPERATIONS_DIR
  ?? join(homedir(), 'Library', 'Application Support', 'StockBoard', 'large-holder-operations')
const eventPath = join(operationsDir, 'daily-current-events.ndjson')

function finalJson<T>(output: string): T {
  const lines = output.trim().split('\n').filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(lines.slice(index).join('\n')) as T }
    catch { /* Try the next possible JSON boundary. */ }
  }
  throw new Error('large_holder_operation_missing_json')
}

async function operation(command: 'status' | 'snapshot-refresh' | 'update-daily'): Promise<unknown> {
  const script = join(process.cwd(), 'scripts', 'run-large-holder-operations.ts')
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', script, command], {
      cwd: process.cwd(),
      env: { ...process.env, USE_LOCAL_DB: '1', SKIP_SCHEMA_ENSURE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let statusTimedOut = false
    const configuredStatusTimeout = Number(process.env.LARGE_HOLDER_AUTOMATION_STATUS_TIMEOUT_SECONDS ?? 120)
    const statusTimeoutMs = Math.max(10, Math.min(300,
      Number.isFinite(configuredStatusTimeout) ? configuredStatusTimeout : 120)) * 1_000
    const timeout = command === 'status' ? setTimeout(() => {
      statusTimedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref()
    }, statusTimeoutMs) : null
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('error', (error) => { if (timeout) clearTimeout(timeout); reject(error) })
    child.on('close', (code) => {
      if (timeout) clearTimeout(timeout)
      if (statusTimedOut) {
        reject(new Error('large_holder_status_timeout'))
      } else if (code === 0) resolve(finalJson(stdout))
      else reject(new Error(stderr.trim().slice(-4_000) || `${command}_exit_${code}`))
    })
  })
}

async function appendEvent(event: Event): Promise<void> {
  if (dryRun) return
  await mkdir(operationsDir, { recursive: true, mode: 0o700 })
  await appendFile(eventPath, `${JSON.stringify(event)}\n`, { mode: 0o600 })
}

async function lastAutomationEvent(): Promise<Event | null> {
  const text = await readFile(eventPath, 'utf8').catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  })
  const line = text.trim().split('\n').filter(Boolean).at(-1)
  return line ? JSON.parse(line) as Event : null
}

function publicStatus(status: LargeHolderDailySnapshotStatus, lastResult: Event | null) {
  return {
    marketDate: status.state.marketDate,
    priceEvidenceDate: status.state.priceEvidenceDate,
    certifiedSnapshotDate: status.snapshotPriceDate,
    canonicalState: status.status,
    certificationStatus: status.certificationStatus,
    lastRefresh: status.currentGeneratedAt,
    lastResult: lastResult?.result ?? null,
    sourceDiscovery: process.env.EDINET_API_KEY?.trim() ? 'ENABLED' : 'SKIPPED_NO_API_KEY',
  }
}

async function main() {
  const startedAt = new Date().toISOString()
  const started = Date.now()
  const before = await operation('status') as LargeHolderDailySnapshotStatus
  const previousEvent = await lastAutomationEvent()
  if (statusOnly) {
    console.log(JSON.stringify(publicStatus(before, previousEvent), null, 2))
    return
  }

  const plan = planLargeHolderDailyCurrent(before)
  if (dryRun) {
    console.log(JSON.stringify({ dryRun: true, ...publicStatus(before, previousEvent),
      intendedAction: plan.action, reason: plan.reason, writes: 0 }, null, 2))
    return
  }

  let result: Result = plan.action === 'REFRESH' ? 'FAILED' : plan.action
  let failureReason: string | null = plan.action === 'VALIDATION_FAILED' ? plan.reason : null
  let sourceDiscovery: Event['source_discovery'] = 'NOT_RUN'
  let after = before
  if (plan.action === 'REFRESH') {
    sourceDiscovery = process.env.EDINET_API_KEY?.trim() ? 'ENABLED' : 'SKIPPED_NO_API_KEY'
    try {
      await operation(sourceDiscovery === 'ENABLED' ? 'update-daily' : 'snapshot-refresh')
      after = await operation('status') as LargeHolderDailySnapshotStatus
      if (after.status !== 'CURRENT' || after.snapshotPriceDate !== after.state.marketDate) {
        throw new Error('refresh_completed_without_current_snapshot')
      }
      result = 'REFRESHED'
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      result = classifyLargeHolderDailyFailure(message)
      failureReason = result
    }
  }

  const event: Event = {
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    market_date: before.state.marketDate || null,
    price_evidence_date: before.state.priceEvidenceDate || null,
    previous_snapshot_date: before.snapshotPriceDate,
    action: plan.action,
    result,
    new_snapshot_date: after.snapshotPriceDate,
    certification_status: after.certificationStatus,
    duration_ms: Date.now() - started,
    failure_reason: failureReason,
    source_discovery: sourceDiscovery,
  }
  await appendEvent(event)
  console.log(JSON.stringify(event, null, 2))
  if (!['ALREADY_CURRENT', 'REFRESHED', 'WAITING_FOR_PRICE_EVIDENCE', 'ALREADY_RUNNING'].includes(result)) {
    process.exitCode = 75
  }
}

main().catch(async (error) => {
  const result = classifyLargeHolderDailyFailure(error instanceof Error ? error.message : String(error))
  await appendEvent({
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    market_date: null,
    price_evidence_date: null,
    previous_snapshot_date: null,
    action: 'STATUS_FAILED',
    result,
    new_snapshot_date: null,
    certification_status: null,
    duration_ms: 0,
    failure_reason: result,
    source_discovery: 'NOT_RUN',
  }).catch(() => undefined)
  console.error(result)
  process.exitCode = 75
})
