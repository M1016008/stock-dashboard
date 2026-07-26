// scripts/run-weekly-optimization.ts
//
// Sunday maintenance orchestrator. Heavy JP/US learning stays sequential so
// the two large SQLite databases never compete for memory or write bandwidth.

import { createHash } from 'node:crypto'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { waitForMemoryHeadroom, withMemoryGuardEnv } from '@/lib/system/memory-guard'

type StepStatus = 'pending' | 'running' | 'completed' | 'failed'

type Step = {
  id: string
  label: string
  npmScript: string
  env?: NodeJS.ProcessEnv
}

type StepResult = {
  id: string
  label: string
  status: StepStatus
  startedAt: string | null
  finishedAt: string | null
  exitCode: number | null
  signal: NodeJS.Signals | null
  error: string | null
}

type RunState = {
  pid: number
  runKey: string
  startedAt: string
  heartbeatAt: string
  finishedAt: string | null
  status: 'running' | 'completed' | 'failed'
  steps: StepResult[]
}

const supportDir = path.join(os.homedir(), 'Library', 'Application Support', 'StockBoard')
const lockPath = path.join(supportDir, 'weekly-optimization.lock')
const statePath = path.join(supportDir, 'weekly-optimization-state.json')
const dryRun = process.argv.includes('--dry-run') || process.env.WEEKLY_OPTIMIZATION_DRY_RUN === '1'
const defaultUsDb = '/Volumes/OWC Express 1M2 80G/stockboard-data/us/stockboard-us.db'
let activeChild: ChildProcess | null = null
let lockOwned = false
let shutdownSignal: NodeJS.Signals | null = null

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isoNow(): string {
  return new Date().toISOString()
}

function pidExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function writeState(state: RunState): void {
  const temporaryPath = `${statePath}.${process.pid}.tmp`
  fs.writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temporaryPath, statePath)
}

function readState(): RunState | null {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8')) as RunState
  } catch {
    return null
  }
}

function sqliteScalar(dbPath: string, sql: string): string {
  try {
    return execFileSync(
      'sqlite3',
      ['-cmd', '.timeout 5000', dbPath, sql],
      { encoding: 'utf8', timeout: 10_000 },
    ).trim() || 'missing'
  } catch {
    return 'missing'
  }
}

function currentJstWeek(): string {
  const formatted = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
  const date = new Date(`${formatted}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() - date.getUTCDay())
  return date.toISOString().slice(0, 10)
}

function implementationFingerprint(): string {
  const files = [
    'package.json',
    'scripts/run-weekly-optimization.ts',
    'scripts/run-ml-learning.ts',
    'scripts/run-us-ml-job.ts',
    'scripts/ensure-us-adjusted-foundation.ts',
    'scripts/build-us-analytics-db.ts',
    'scripts/validate-us-analytics-db.ts',
    'lib/backtest/forward-extrema.ts',
  ]
  const hash = createHash('sha256')
  for (const file of files) {
    const absolute = path.join(process.cwd(), file)
    hash.update(file)
    hash.update(fs.existsSync(absolute) ? fs.readFileSync(absolute) : 'missing')
  }
  return hash.digest('hex').slice(0, 16)
}

function buildRunKey(configuredSteps: Step[]): string {
  const jpDb = path.resolve(
    process.env.STOCKBOARD_DB_PATH?.trim()
      || path.join(process.cwd(), 'data', 'stockboard.db'),
  )
  const usDb = path.resolve(
    process.env.US_ANALYTICS_DB_PATH?.trim()
      || defaultUsDb,
  )
  const input = {
    version: 1,
    week: currentJstWeek(),
    jpPriceDate: sqliteScalar(jpDb, 'SELECT MAX(date) FROM ohlcv_daily'),
    usPriceDate: sqliteScalar(usDb, 'SELECT MAX(date) FROM ohlcv_daily'),
    usPriceBasis: sqliteScalar(
      usDb,
      `SELECT value FROM us_analytics_metadata WHERE key = 'ohlcv_price_basis'`,
    ),
    implementation: implementationFingerprint(),
    steps: configuredSteps.map((step) => ({ id: step.id, npmScript: step.npmScript })),
  }
  return createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 24)
}

function acquireProcessLock(): boolean {
  fs.mkdirSync(supportDir, { recursive: true })
  try {
    const handle = fs.openSync(lockPath, 'wx', 0o600)
    fs.writeFileSync(handle, `${process.pid}\n`)
    fs.closeSync(handle)
    lockOwned = true
    return true
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error
  }

  const existingPid = Number(fs.readFileSync(lockPath, 'utf8').trim())
  if (pidExists(existingPid)) {
    console.log(`Weekly optimization already running (pid=${existingPid}); skipping duplicate launch.`)
    return false
  }

  fs.unlinkSync(lockPath)
  return acquireProcessLock()
}

function releaseProcessLock(): void {
  if (!lockOwned) return
  try {
    const owner = Number(fs.readFileSync(lockPath, 'utf8').trim())
    if (owner === process.pid) fs.unlinkSync(lockPath)
  } catch {
    // A missing stale lock is already released.
  }
  lockOwned = false
}

function steps(): Step[] {
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    USE_LOCAL_DB: '1',
    SQLITE_BUSY_TIMEOUT_MS: process.env.SQLITE_BUSY_TIMEOUT_MS ?? '30000',
    SQLITE_BUSY_RETRIES: process.env.SQLITE_BUSY_RETRIES ?? '20',
    ML_FEATURE_HEALTH_STRICT: '1',
    ML_ACCURACY_STRICT: '1',
    UPDATE_CHILD_TIMEOUT_MINUTES: process.env.UPDATE_CHILD_TIMEOUT_MINUTES ?? '2880',
    US_ANALYTICS_DB_PATH: process.env.US_ANALYTICS_DB_PATH?.trim() || defaultUsDb,
  }
  return [
    {
      id: 'jp-features-models',
      label: 'JP feature/model governance',
      npmScript: 'batch:ml-learning-daily',
      env: {
        ...baseEnv,
        ML_LEARNING_IGNORE_MARKET_CALENDAR: '1',
        ML_LEARNING_MAX_ATTEMPTS: process.env.ML_LEARNING_MAX_ATTEMPTS ?? '2',
        ML_LEARNING_RETRY_DELAY_SECONDS: process.env.ML_LEARNING_RETRY_DELAY_SECONDS ?? '1800',
        ML_LEARNING_LOCK_WAIT_MINUTES: process.env.ML_LEARNING_LOCK_WAIT_MINUTES ?? '2880',
        ML_LEARNING_BATCH_WAIT_MINUTES: process.env.ML_LEARNING_BATCH_WAIT_MINUTES ?? '2880',
        ML_LEARNING_NPM_SCRIPT: 'batch:ml-weekly-governance',
      },
    },
    {
      id: 'us-features-models',
      label: 'US feature/model governance',
      npmScript: 'batch:us-ml-weekly-efficient',
      env: baseEnv,
    },
    {
      id: 'jp-analog-index',
      label: 'JP analog search index refresh',
      npmScript: 'batch:analog-index:jp',
      env: baseEnv,
    },
    {
      id: 'us-analog-index',
      label: 'US analog search index refresh',
      npmScript: 'batch:analog-index:us',
      env: baseEnv,
    },
    {
      id: 'dashboard-cache',
      label: 'Dashboard cache refresh',
      npmScript: 'batch:dashboard-cache',
      env: baseEnv,
    },
    {
      id: 'database-maintenance',
      label: 'JP/US database optimize and WAL checkpoint',
      npmScript: 'db:maintenance:all',
      env: {
        ...baseEnv,
        DB_MAINT_TARGETS: 'jp,us',
        DB_MAINT_CHECK_MODE: process.env.DB_MAINT_CHECK_MODE ?? 'smoke',
        DB_MAINT_CLEAN_STALE_WITH_ACTIVE: '1',
      },
    },
  ]
}

async function runStep(step: Step): Promise<{
  exitCode: number | null
  signal: NodeJS.Signals | null
}> {
  await waitForMemoryHeadroom({ label: step.label })
  console.log(`\n[weekly-optimization] START ${step.id}: npm run ${step.npmScript}`)
  return new Promise((resolve, reject) => {
    activeChild = spawn('npm', ['run', step.npmScript], {
      cwd: process.cwd(),
      env: withMemoryGuardEnv({ ...process.env, ...step.env }),
      stdio: 'inherit',
    })
    activeChild.once('error', reject)
    activeChild.once('close', (exitCode, signal) => {
      activeChild = null
      resolve({ exitCode, signal })
    })
  })
}

function installSignalHandlers(): void {
  const handler = (signal: NodeJS.Signals) => {
    shutdownSignal = signal
    console.error(`[weekly-optimization] received ${signal}`)
    if (activeChild && activeChild.exitCode === null && activeChild.signalCode === null) {
      activeChild.kill('SIGTERM')
    }
  }
  process.once('SIGINT', handler)
  process.once('SIGTERM', handler)
  process.once('exit', releaseProcessLock)
}

async function main(): Promise<void> {
  const configuredSteps = steps()
  if (dryRun) {
    console.log(JSON.stringify({
      dryRun: true,
      cwd: process.cwd(),
      steps: configuredSteps.map(({ id, label, npmScript }) => ({ id, label, npmScript })),
    }, null, 2))
    return
  }

  if (!acquireProcessLock()) return
  installSignalHandlers()

  const runKey = buildRunKey(configuredSteps)
  const previousState = readState()
  const reusableSteps = previousState?.runKey === runKey
    ? new Map(
        previousState.steps
          .filter((step) => step.status === 'completed')
          .map((step) => [step.id, step]),
      )
    : new Map<string, StepResult>()
  const state: RunState = {
    pid: process.pid,
    runKey,
    startedAt: isoNow(),
    heartbeatAt: isoNow(),
    finishedAt: null,
    status: 'running',
    steps: configuredSteps.map((step) => {
      const reusable = reusableSteps.get(step.id)
      return reusable
        ? { ...reusable }
        : {
            id: step.id,
            label: step.label,
            status: 'pending',
            startedAt: null,
            finishedAt: null,
            exitCode: null,
            signal: null,
            error: null,
          }
    }),
  }
  writeState(state)

  for (const [index, step] of configuredSteps.entries()) {
    const result = state.steps[index]
    if (result.status === 'completed') {
      console.log(`[weekly-optimization] RESUME ${step.id}: same week, data dates, and implementation`)
      continue
    }
    result.status = 'running'
    result.startedAt = isoNow()
    state.heartbeatAt = isoNow()
    writeState(state)
    const heartbeatTimer = setInterval(() => {
      state.heartbeatAt = isoNow()
      writeState(state)
    }, 60_000)
    try {
      const completed = await runStep(step)
      result.exitCode = completed.exitCode
      result.signal = completed.signal
      result.status = completed.exitCode === 0 ? 'completed' : 'failed'
      if (completed.exitCode !== 0) {
        result.error = `exit=${completed.exitCode}, signal=${completed.signal ?? 'none'}`
      }
    } catch (error) {
      result.status = 'failed'
      result.error = errorMessage(error)
    } finally {
      clearInterval(heartbeatTimer)
      state.heartbeatAt = isoNow()
      result.finishedAt = isoNow()
      writeState(state)
    }
    if (shutdownSignal) {
      result.status = 'failed'
      result.error = `interrupted by ${shutdownSignal}`
      writeState(state)
      break
    }
    if (result.status === 'failed') {
      console.error(`[weekly-optimization] STOP ${step.id}: downstream publication was not started`)
      break
    }
  }

  const failed = state.steps.filter((step) => step.status === 'failed')
  state.heartbeatAt = isoNow()
  state.finishedAt = isoNow()
  state.status = failed.length === 0 ? 'completed' : 'failed'
  writeState(state)
  releaseProcessLock()

  console.log(JSON.stringify({
    status: state.status,
    runKey: state.runKey,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    steps: state.steps,
  }, null, 2))
  if (failed.length > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error('[weekly-optimization] failed:', error)
  releaseProcessLock()
  process.exitCode = 1
})
