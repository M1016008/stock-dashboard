// scripts/run-weekly-optimization.ts
//
// Sunday maintenance orchestrator. Heavy JP/US learning stays sequential so
// the two large SQLite databases never compete for memory or write bandwidth.

import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openExistingGuardedClient } from '@/lib/storage/guarded-libsql-client'
import { resolveConfiguredStoragePath } from '@/lib/storage-paths'
import { waitForMemoryHeadroom, withMemoryGuardEnv } from '@/lib/system/memory-guard'

type StepStatus = 'pending' | 'running' | 'completed' | 'failed'

type Step = {
  id: string
  label: string
  npmScript: string
  env?: NodeJS.ProcessEnv
  modelDbPath?: string
  rollbackScripts?: string[]
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

type ModelSnapshotRow = {
  model_name: string
  model_type: string
  direction: string
  horizon_days: number
  feature_names_json: string
  weights_json: string
  intercept: number
  metrics_json: string
  trained_at: number
}

const supportDir = path.join(os.homedir(), 'Library', 'Application Support', 'StockBoard')
const lockPath = path.join(supportDir, 'weekly-optimization.lock')
const statePath = path.join(supportDir, 'weekly-optimization-state.json')
const dryRun = process.argv.includes('--dry-run') || process.env.WEEKLY_OPTIMIZATION_DRY_RUN === '1'
const defaultUsDb = '/Volumes/OWC Express 1M2 80G/stockboard-data/us/stockboard-us.db'
let lockOwned = false
let shutdownSignal: NodeJS.Signals | null = null
const signalledPids = new Set<number>()
let resignalTimer: NodeJS.Timeout | null = null
let rollbackInProgress = false

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
  const jpDbPath = resolveConfiguredStoragePath(path.resolve(
    process.env.STOCKBOARD_DB_PATH?.trim()
      || path.join(process.cwd(), 'data', 'stockboard.db'),
  ))
  const usDbPath = resolveConfiguredStoragePath(path.resolve(
    process.env.US_ANALYTICS_DB_PATH?.trim() || defaultUsDb,
  ))
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    USE_LOCAL_DB: '1',
    SQLITE_BUSY_TIMEOUT_MS: process.env.SQLITE_BUSY_TIMEOUT_MS ?? '30000',
    SQLITE_BUSY_RETRIES: process.env.SQLITE_BUSY_RETRIES ?? '20',
    ML_FEATURE_HEALTH_STRICT: '1',
    ML_ACCURACY_STRICT: '1',
    UPDATE_CHILD_TIMEOUT_MINUTES: process.env.UPDATE_CHILD_TIMEOUT_MINUTES ?? '2880',
    ML_MODEL_DETERIORATION_STRICT: '1',
    US_ANALYTICS_DB_PATH: usDbPath,
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
        STOCKBOARD_DB_PATH: jpDbPath,
      },
      modelDbPath: jpDbPath,
      rollbackScripts: [
        'batch:ml-candidates',
        'batch:ml-predict',
        'batch:ml-physics-candidates',
        'batch:ml-insights',
        'batch:dashboard-cache',
      ],
    },
    {
      id: 'us-features-models',
      label: 'US feature/model governance',
      npmScript: 'batch:us-ml-weekly-efficient',
      env: {
        ...baseEnv,
        STOCKBOARD_DB_ROLE: 'us-analytics',
        STOCKBOARD_SOURCE_DB_PATH: jpDbPath,
        STOCKBOARD_DB_PATH: usDbPath,
      },
      modelDbPath: usDbPath,
      rollbackScripts: [
        'batch:ml-candidates',
        'batch:ml-predict',
        'batch:ml-physics-candidates',
        'batch:ml-insights',
        'batch:us-ml-health',
      ],
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

async function snapshotModels(dbPath: string | undefined): Promise<ModelSnapshotRow[] | null> {
  if (!dbPath || !fs.existsSync(dbPath)) return null
  const client = openExistingGuardedClient(dbPath, 'weekly-model-snapshot')
  try {
    await client.execute('PRAGMA busy_timeout=60000')
    const table = await client.execute(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ml_models' LIMIT 1`,
    )
    if (table.rows.length === 0) return null
    const rows = await client.execute(`
      SELECT model_name, model_type, direction, horizon_days, feature_names_json,
             weights_json, intercept, metrics_json, trained_at
      FROM ml_models
    `)
    return rows.rows.map((row) => ({
      model_name: String(row.model_name),
      model_type: String(row.model_type),
      direction: String(row.direction),
      horizon_days: Number(row.horizon_days),
      feature_names_json: String(row.feature_names_json),
      weights_json: String(row.weights_json),
      intercept: Number(row.intercept),
      metrics_json: String(row.metrics_json),
      trained_at: Number(row.trained_at),
    }))
  } finally {
    client.close()
  }
}

function modelGroup(row: Pick<ModelSnapshotRow, 'model_type' | 'direction' | 'horizon_days'>): string {
  return `${row.model_type}\u0000${row.direction}\u0000${row.horizon_days}`
}

async function restoreValidatedModels(dbPath: string, snapshot: ModelSnapshotRow[]): Promise<number> {
  if (snapshot.length === 0) return 0
  const client = openExistingGuardedClient(dbPath, 'weekly-model-restore')
  try {
    await client.execute('PRAGMA busy_timeout=60000')
    const current = await client.execute(`
      SELECT model_name, model_type, direction, horizon_days
      FROM ml_models
    `)
    const previousNames = new Set(snapshot.map((row) => row.model_name))
    const previousGroups = new Set(snapshot.map(modelGroup))
    const failedGenerationNames = current.rows
      .map((row) => ({
        model_name: String(row.model_name),
        model_type: String(row.model_type),
        direction: String(row.direction),
        horizon_days: Number(row.horizon_days),
      }))
      .filter((row) => !previousNames.has(row.model_name) && previousGroups.has(modelGroup(row)))
      .map((row) => row.model_name)

    const statements = [
      ...failedGenerationNames.map((modelName) => ({
        sql: `UPDATE ml_models SET trained_at = 0 WHERE model_name = ?`,
        args: [modelName],
      })),
      ...snapshot.map((row) => ({
        sql: `
          INSERT OR REPLACE INTO ml_models
            (model_name, model_type, direction, horizon_days, feature_names_json,
             weights_json, intercept, metrics_json, trained_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        args: [
          row.model_name,
          row.model_type,
          row.direction,
          row.horizon_days,
          row.feature_names_json,
          row.weights_json,
          row.intercept,
          row.metrics_json,
          row.trained_at,
        ],
      })),
    ]
    if (statements.length > 0) await client.batch(statements, 'write')
    return failedGenerationNames.length
  } finally {
    client.close()
  }
}

async function runStep(step: Step, rollbackPublication = false): Promise<{
  exitCode: number | null
  signal: NodeJS.Signals | null
}> {
  await waitForMemoryHeadroom({ label: step.label })
  if (shutdownSignal && !rollbackPublication) return { exitCode: null, signal: shutdownSignal }
  console.log(`\n[weekly-optimization] START ${step.id}: npm run ${step.npmScript}`)
  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['run', step.npmScript], {
      cwd: process.cwd(),
      env: withMemoryGuardEnv({ ...process.env, ...step.env }),
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal }))
  })
}

async function republishValidatedModels(step: Step): Promise<void> {
  for (const npmScript of step.rollbackScripts ?? []) {
    const recoveryStep: Step = {
      id: `${step.id}-rollback-${npmScript}`,
      label: `${step.label} rollback publication: ${npmScript}`,
      npmScript,
      env: step.env,
    }
    const result = await runStep(recoveryStep, true)
    if (result.exitCode !== 0) {
      throw new Error(
        `rollback publication failed: npm run ${npmScript}, exit=${result.exitCode}, signal=${result.signal ?? 'none'}`,
      )
    }
  }
}

// Every live descendant of this runner (children, grandchildren, ...), excluding the ps this runs.
// When launchd started the job (the group leader is an ancestor whose parent is launchd), the
// process group belongs to this job alone, so non-ancestor members of it are included as well:
// that catches a grandchild re-parented to launchd before it was seen. Started any other way,
// only descendants are selected, so other processes sharing the group are never signalled.
function stepProcesses(): number[] | null {
  let table = ''
  try {
    table = execFileSync('/bin/ps', ['-A', '-o', 'pid=,ppid=,pgid=,comm='], { encoding: 'utf8' })
  } catch {
    return null
  }
  const rows = table.trim().split('\n').map((line) => line.trim().split(/\s+/))
    .map(([pid, ppid, pgid, comm]) => ({ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), comm }))
  const parentOf = new Map(rows.map((row) => [row.pid, row.ppid]))
  const ancestors = new Set<number>()
  for (let pid = process.pid; pid > 1 && !ancestors.has(pid); pid = parentOf.get(pid) ?? 0) ancestors.add(pid)
  const group = rows.find((row) => row.pid === process.pid)?.pgid ?? -1
  const launchdOwnsGroup = ancestors.has(group) && parentOf.get(group) === 1
  // Roots: this runner and every signalled process still alive (its subtree may have been re-parented).
  const roots = new Set([process.pid, ...[...signalledPids].filter((pid) => parentOf.has(pid))])
  const descendants = new Set<number>()
  for (let grew = true; grew;) {
    grew = false
    for (const row of rows) {
      if (descendants.has(row.pid) || row.pid === process.pid) continue
      if (!roots.has(row.ppid) && !descendants.has(row.ppid)) continue
      descendants.add(row.pid)
      grew = true
    }
  }
  return rows
    .filter((row) => descendants.has(row.pid) || (launchdOwnsGroup && row.pgid === group && !ancestors.has(row.pid)))
    .filter((row) => !(row.ppid === process.pid && /(^|\/)ps$/.test(row.comm ?? '')))
    .map((row) => row.pid)
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// Wait for the current descendants and for every PID signalled at shutdown (a grandchild whose
// parent exits first is re-parented and stops being a descendant, but must still be waited for).
function signalStepProcesses(): number[] | null {
  const current = stepProcesses()
  for (const pid of current ?? []) {
    if (signalledPids.has(pid)) continue
    signalledPids.add(pid)
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // Already gone.
    }
  }
  return current
}

async function waitForStepProcessesExit(): Promise<void> {
  for (let waitedSeconds = 0; ; waitedSeconds += 5) {
    // Descendants that appear after the signal are signalled too; a failed ps keeps waiting.
    const current = signalStepProcesses()
    const remaining = [...new Set([...(current ?? []), ...[...signalledPids].filter(pidAlive)])]
    if (current && remaining.length === 0) {
      // Stop re-signalling before rollback publication starts its own child processes.
      if (resignalTimer) clearInterval(resignalTimer)
      resignalTimer = null
      return
    }
    if (waitedSeconds % 60 === 0) {
      console.error(`[weekly-optimization] waiting for step processes to exit: ${remaining.join(',')}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000))
  }
}

function installSignalHandlers(): void {
  const handler = (signal: NodeJS.Signals) => {
    if (shutdownSignal) return
    shutdownSignal = signal
    if (rollbackInProgress) {
      // Never interrupt a rollback: let it finish, then the run stops as failed.
      console.error(`[weekly-optimization] received ${signal} during rollback; finishing the rollback first`)
      return
    }
    console.error(`[weekly-optimization] received ${signal}; stopping every step process`)
    signalStepProcesses()
    // Keep re-signalling (new descendants, a failed ps) even while the step's npm is still open.
    // unref: the timer never keeps the runner alive on its own.
    resignalTimer = setInterval(signalStepProcesses, 5_000).unref()
  }
  process.on('SIGINT', handler)
  process.on('SIGTERM', handler)
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
    if (shutdownSignal) break
    const result = state.steps[index]
    if (result.status === 'completed') {
      console.log(`[weekly-optimization] RESUME ${step.id}: same week, data dates, and implementation`)
      continue
    }
    result.status = 'running'
    result.startedAt = isoNow()
    state.heartbeatAt = isoNow()
    writeState(state)
    let modelSnapshot: ModelSnapshotRow[] | null = null
    const heartbeatTimer = setInterval(() => {
      state.heartbeatAt = isoNow()
      writeState(state)
    }, 60_000)
    try {
      modelSnapshot = await snapshotModels(step.modelDbPath)
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
      // Roll back and release the lock only after every step process has exited.
      await waitForStepProcessesExit()
      result.status = 'failed'
      result.error = `interrupted by ${shutdownSignal}`
      writeState(state)
    }
    if (result.status === 'failed') {
      if (step.modelDbPath && modelSnapshot && modelSnapshot.length > 0) {
        rollbackInProgress = true
        try {
          const demoted = await restoreValidatedModels(step.modelDbPath, modelSnapshot)
          console.warn(
            `[weekly-optimization] ROLLBACK ${step.id}: restored validated model generation; demoted=${demoted}`,
          )
          await republishValidatedModels(step)
        } catch (error) {
          const rollbackError = errorMessage(error)
          result.error = `${result.error ?? 'step failed'}; rollback failed: ${rollbackError}`
          writeState(state)
          console.error(`[weekly-optimization] ROLLBACK FAILED ${step.id}: ${rollbackError}`)
        } finally {
          rollbackInProgress = false
        }
      }
      console.error(`[weekly-optimization] STOP ${step.id}: downstream publication was not started`)
      break
    }
  }

  const failed = state.steps.filter((step) => step.status === 'failed')
  state.heartbeatAt = isoNow()
  state.finishedAt = isoNow()
  state.status = failed.length === 0 && !shutdownSignal ? 'completed' : 'failed'
  writeState(state)
  releaseProcessLock()

  console.log(JSON.stringify({
    status: state.status,
    runKey: state.runKey,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    steps: state.steps,
  }, null, 2))
  if (failed.length > 0 || shutdownSignal) process.exitCode = 1
}

main().catch((error) => {
  console.error('[weekly-optimization] failed:', error)
  releaseProcessLock()
  process.exitCode = 1
})
