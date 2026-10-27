// scripts/run-weekly-optimization.ts
//
// Sunday maintenance orchestrator. Heavy JP/US learning stays sequential so
// the two large SQLite databases never compete for memory or write bandwidth.

import { createHash } from 'node:crypto'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openExistingGuardedClient } from '@/lib/storage/guarded-libsql-client'
import { ML_PIPELINE_NAME } from '@/lib/ml/pipeline-generation'
import { CURRENT_SERVING_PRICE_BASIS } from '@/lib/research/six-stage-current-serving-adapter'
import { expectedLatestTradingDate } from '@/lib/server/data-freshness'
import { expectedLatestUsTradingDate } from '@/lib/server/us-data-freshness'
import { resolveConfiguredStoragePath } from '@/lib/storage-paths'
import { waitForMemoryHeadroom, withMemoryGuardEnv } from '@/lib/system/memory-guard'
import { usUniverseActivityCutoff } from '@/lib/us-universe-activity'
import { acquirePidProcessLock, type PidProcessLock } from '@/lib/pid-process-lock'
import { signalProcessGroup, waitForProcessGroupExit } from '@/lib/child-process-group'
import {
  assessWeeklyPromotionReadiness,
  assessWeeklySourceReadiness,
  createWeeklyOptimizationRunContract,
  weeklyOptimizationContractEnv,
  type WeeklyOptimizationRunContract,
  type WeeklyServingObservation,
  type WeeklySourceObservation,
} from '@/lib/weekly-optimization-run-contract'

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
  contract?: WeeklyOptimizationRunContract
  error?: string | null
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
let activeChild: ChildProcess | null = null
let activeChildProcessGroupId: number | null = null
let weeklyProcessLock: PidProcessLock | null = null
let shutdownSignal: NodeJS.Signals | null = null

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isoNow(): string {
  return new Date().toISOString()
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

function sqliteJsonRow<T extends Record<string, unknown>>(dbPath: string, sql: string): T {
  try {
    if (!fs.existsSync(dbPath)) throw new Error('database file does not exist')
    const output = execFileSync(
      'sqlite3',
      ['-readonly', '-json', '-cmd', '.timeout 5000', dbPath, sql],
      { encoding: 'utf8', timeout: 10_000 },
    ).trim()
    const rows = JSON.parse(output || '[]') as T[]
    if (!rows[0]) throw new Error('query returned no row')
    return rows[0]
  } catch (error) {
    throw new Error(`weekly optimization lineage query failed for ${dbPath}: ${errorMessage(error)}`)
  }
}

function databasePaths(): { jpDbPath: string; usDbPath: string } {
  return {
    jpDbPath: resolveConfiguredStoragePath(path.resolve(
      process.env.STOCKBOARD_DB_PATH?.trim()
        || path.join(process.cwd(), 'data', 'stockboard.db'),
    )),
    usDbPath: resolveConfiguredStoragePath(path.resolve(
      process.env.US_ANALYTICS_DB_PATH?.trim() || defaultUsDb,
    )),
  }
}

function sourceObservation(
  market: 'JP' | 'US',
  jpDbPath: string,
): WeeklySourceObservation {
  const row = market === 'JP'
    ? sqliteJsonRow<Record<string, unknown>>(jpDbPath, `
        WITH relevant AS (
          SELECT id, status, started_at, finished_at
          FROM batch_runs
          WHERE job_type = 'ohlcv_fetch:jquants'
        ), latest AS (
          SELECT * FROM relevant ORDER BY id DESC LIMIT 1
        )
        SELECT
          COALESCE((SELECT id FROM latest), 0) AS latestRunId,
          COALESCE((SELECT MAX(id) FROM relevant WHERE status IN ('success', 'partial')), 0) AS latestPublishableRunId,
          COALESCE((SELECT status FROM latest), 'missing') AS latestRunStatus,
          (SELECT COUNT(*) FROM relevant WHERE status = 'running') AS runningCount,
          (SELECT started_at FROM latest) AS startedAt,
          (SELECT finished_at FROM latest) AS finishedAt,
          COALESCE((SELECT MAX(date) FROM ohlcv_daily), '') AS priceDate,
          (SELECT finished_at FROM latest) AS maxImportedAt,
          COALESCE((
            SELECT GROUP_CONCAT(value, '|') FROM (
              SELECT job_type || ':' || COALESCE(owner, '') AS value
              FROM update_locks
              WHERE status = 'running' AND lease_expires_at > unixepoch()
              ORDER BY job_type, owner
            )
          ), '') AS activeWriterLocks
      `)
    : sqliteJsonRow<Record<string, unknown>>(jpDbPath, `
        WITH relevant AS (
          SELECT id, status, started_at, finished_at
          FROM market_data_runs
          WHERE market = 'US' AND job_type = 'tiingo_ohlcv'
        ), latest AS (
          SELECT * FROM relevant ORDER BY id DESC LIMIT 1
        ), universe_relevant AS (
          SELECT id, status, finished_at
          FROM market_data_runs
          WHERE market = 'US' AND job_type = 'tiingo_universe'
        ), universe_latest AS (
          SELECT * FROM universe_relevant ORDER BY id DESC LIMIT 1
        )
        SELECT
          COALESCE((SELECT id FROM latest), 0) AS latestRunId,
          COALESCE((SELECT MAX(id) FROM relevant WHERE status IN ('success', 'partial')), 0) AS latestPublishableRunId,
          COALESCE((SELECT status FROM latest), 'missing') AS latestRunStatus,
          (SELECT COUNT(*) FROM relevant WHERE status = 'running') AS runningCount,
          (SELECT started_at FROM latest) AS startedAt,
          (SELECT finished_at FROM latest) AS finishedAt,
          COALESCE((SELECT MAX(date) FROM market_ohlcv_daily WHERE market = 'US'), '') AS priceDate,
          (SELECT MAX(imported_at) FROM market_ohlcv_daily WHERE market = 'US') AS maxImportedAt,
          COALESCE((
            SELECT GROUP_CONCAT(value, '|') FROM (
              SELECT job_type || ':' || COALESCE(owner, '') AS value
              FROM update_locks
              WHERE status = 'running' AND lease_expires_at > unixepoch()
              ORDER BY job_type, owner
            )
          ), '') AS activeWriterLocks,
          COALESCE((SELECT id FROM universe_latest), 0) AS universeLatestRunId,
          COALESCE((SELECT MAX(id) FROM universe_relevant WHERE status IN ('success', 'partial')), 0)
            AS universeLatestPublishableRunId,
          COALESCE((SELECT status FROM universe_latest), 'missing') AS universeLatestRunStatus,
          (SELECT COUNT(*) FROM universe_relevant WHERE status = 'running') AS universeRunningCount,
          (SELECT finished_at FROM universe_latest) AS universeFinishedAt,
          (SELECT MAX(updated_at) FROM market_universe WHERE market = 'US') AS universeMaxUpdatedAt,
          (SELECT COUNT(*) FROM market_universe WHERE market = 'US' AND active = 1) AS universeActiveCount
      `)
  const numberOrNull = (value: unknown): number | null => value == null ? null : Number(value)
  return {
    latestRunId: Number(row.latestRunId ?? 0),
    latestPublishableRunId: Number(row.latestPublishableRunId ?? 0),
    latestRunStatus: String(row.latestRunStatus ?? 'missing'),
    runningCount: Number(row.runningCount ?? 0),
    startedAt: numberOrNull(row.startedAt),
    finishedAt: numberOrNull(row.finishedAt),
    priceDate: String(row.priceDate ?? ''),
    maxImportedAt: numberOrNull(row.maxImportedAt),
    priceBasis: CURRENT_SERVING_PRICE_BASIS[market],
    activeWriterLocks: String(row.activeWriterLocks ?? '').split('|').filter(Boolean),
    universeGeneration: market === 'US'
      ? {
          latestRunId: Number(row.universeLatestRunId ?? 0),
          latestPublishableRunId: Number(row.universeLatestPublishableRunId ?? 0),
          latestRunStatus: String(row.universeLatestRunStatus ?? 'missing'),
          runningCount: Number(row.universeRunningCount ?? 0),
          finishedAt: numberOrNull(row.universeFinishedAt),
          maxUpdatedAt: numberOrNull(row.universeMaxUpdatedAt),
          activeCount: Number(row.universeActiveCount ?? 0),
        }
      : null,
  }
}

function servingObservation(
  market: 'JP' | 'US',
  dbPath: string,
): WeeklyServingObservation {
  const row = sqliteJsonRow<Record<string, unknown>>(dbPath, `
    SELECT
      generation_version AS generationVersion,
      status,
      baseline_source_date AS baselineSourceDate,
      last_delta_source_date AS lastDeltaSourceDate,
      price_basis AS priceBasis,
      updated_at AS updatedAt
    FROM ml_pipeline_generations
    WHERE market = '${market}' AND pipeline = '${ML_PIPELINE_NAME}'
    LIMIT 1
  `)
  return {
    generationVersion: String(row.generationVersion ?? ''),
    status: String(row.status ?? ''),
    baselineSourceDate: String(row.baselineSourceDate ?? ''),
    lastDeltaSourceDate: String(row.lastDeltaSourceDate ?? ''),
    priceBasis: String(row.priceBasis ?? ''),
    updatedAt: Number(row.updatedAt ?? 0),
  }
}

function captureRunContract(paths: { jpDbPath: string; usDbPath: string }): WeeklyOptimizationRunContract {
  const referenceAt = new Date().toISOString()
  const reference = new Date(referenceAt)
  const observe = () => ({
    JP: {
      source: sourceObservation('JP', paths.jpDbPath),
      serving: servingObservation('JP', paths.jpDbPath),
    },
    US: {
      source: sourceObservation('US', paths.jpDbPath),
      serving: servingObservation('US', paths.usDbPath),
    },
  })
  const first = observe()
  const second = observe()
  if (JSON.stringify(first) !== JSON.stringify(second)) {
    throw new Error('weekly optimization lineage changed while the run contract was captured')
  }
  const capturedAt = new Date().toISOString()
  return createWeeklyOptimizationRunContract({
    referenceAt,
    capturedAt,
    markets: {
      JP: {
        expectedTradingDate: expectedLatestTradingDate(reference),
        universeActivityCutoff: null,
        priceBasis: CURRENT_SERVING_PRICE_BASIS.JP,
        source: second.JP.source,
        serving: second.JP.serving,
      },
      US: {
        expectedTradingDate: expectedLatestUsTradingDate(reference),
        universeActivityCutoff: usUniverseActivityCutoff(reference),
        priceBasis: CURRENT_SERVING_PRICE_BASIS.US,
        source: second.US.source,
        serving: second.US.serving,
      },
    },
  })
}

function stepMarket(step: Step): 'JP' | 'US' | null {
  if (step.id.startsWith('jp-')) return 'JP'
  if (step.id.startsWith('us-')) return 'US'
  return null
}

function assertStepLineageUnchanged(
  step: Step,
  contract: WeeklyOptimizationRunContract,
  paths: { jpDbPath: string; usDbPath: string },
): void {
  const market = stepMarket(step)
  if (!market) return
  const source = sourceObservation(market, paths.jpDbPath)
  const strictServingGate = step.id === 'jp-features-models' || step.id === 'us-features-models'
  const assessment = strictServingGate
    ? assessWeeklyPromotionReadiness(contract.markets[market], {
        source,
        serving: servingObservation(market, market === 'JP' ? paths.jpDbPath : paths.usDbPath),
      })
    : assessWeeklySourceReadiness(contract.markets[market], source)
  if (!assessment.ok) {
    throw new Error(`${step.id} pinned lineage gate failed: ${assessment.issues.join(', ')}`)
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
    'scripts/check-us-ml-health.ts',
    'scripts/build-analog-sequence-index.ts',
    'scripts/build-us-analytics-db.ts',
    'scripts/validate-us-analytics-db.ts',
    'lib/backtest/forward-extrema.ts',
    'lib/analog-generation-lineage.ts',
    'lib/child-process-group.ts',
    'lib/pid-process-lock.ts',
    'lib/sqlite-generation-promotion.ts',
    'lib/us-ml-process-lock.ts',
    'lib/weekly-optimization-run-contract.ts',
  ]
  const hash = createHash('sha256')
  for (const file of files) {
    const absolute = path.join(process.cwd(), file)
    hash.update(file)
    hash.update(fs.existsSync(absolute) ? fs.readFileSync(absolute) : 'missing')
  }
  return hash.digest('hex').slice(0, 16)
}

function buildRunKey(
  configuredSteps: Step[],
  contract: WeeklyOptimizationRunContract,
): string {
  const input = {
    version: 4,
    week: currentJstWeek(),
    lineage: contract.lineageSha256,
    implementation: implementationFingerprint(),
    steps: configuredSteps.map((step) => ({ id: step.id, npmScript: step.npmScript })),
  }
  return createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 24)
}

function acquireProcessLock(): boolean {
  weeklyProcessLock = acquirePidProcessLock(lockPath, 'Weekly optimization')
  return weeklyProcessLock != null
}

function releaseProcessLock(): void {
  weeklyProcessLock?.release()
  weeklyProcessLock = null
}

function steps(
  paths = databasePaths(),
  contract?: WeeklyOptimizationRunContract,
): Step[] {
  const { jpDbPath, usDbPath } = paths
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    USE_LOCAL_DB: '1',
    SQLITE_BUSY_TIMEOUT_MS: process.env.SQLITE_BUSY_TIMEOUT_MS ?? '30000',
    SQLITE_BUSY_RETRIES: process.env.SQLITE_BUSY_RETRIES ?? '20',
    ML_FEATURE_HEALTH_STRICT: '1',
    ML_ACCURACY_STRICT: '1',
    WEEKLY_OPTIMIZATION_IMPLEMENTATION_FINGERPRINT: implementationFingerprint(),
    UPDATE_CHILD_TIMEOUT_MINUTES: process.env.UPDATE_CHILD_TIMEOUT_MINUTES ?? '2880',
    ML_MODEL_DETERIORATION_STRICT: '1',
    US_ANALYTICS_DB_PATH: usDbPath,
    ...(contract ? weeklyOptimizationContractEnv(contract) : {}),
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

async function runStep(step: Step): Promise<{
  exitCode: number | null
  signal: NodeJS.Signals | null
}> {
  await waitForMemoryHeadroom({ label: step.label })
  console.log(`\n[weekly-optimization] START ${step.id}: npm run ${step.npmScript}`)
  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['run', step.npmScript], {
      cwd: process.cwd(),
      env: withMemoryGuardEnv({ ...process.env, ...step.env }),
      detached: true,
      stdio: 'inherit',
    })
    activeChild = child
    activeChildProcessGroupId = child.pid ?? null
    child.once('error', (error) => {
      if (activeChild === child) activeChild = null
      if (activeChildProcessGroupId === child.pid) activeChildProcessGroupId = null
      reject(error)
    })
    child.once('close', (exitCode, signal) => {
      const processGroupId = child.pid
      void (async () => {
        if (processGroupId) await waitForProcessGroupExit(processGroupId)
        if (activeChild === child) activeChild = null
        if (activeChildProcessGroupId === processGroupId) activeChildProcessGroupId = null
        resolve({ exitCode, signal })
      })().catch(reject)
    })
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
    const result = await runStep(recoveryStep)
    if (result.exitCode !== 0) {
      throw new Error(
        `rollback publication failed: npm run ${npmScript}, exit=${result.exitCode}, signal=${result.signal ?? 'none'}`,
      )
    }
  }
}

function installSignalHandlers(): void {
  const handler = (signal: NodeJS.Signals) => {
    shutdownSignal = signal
    console.error(`[weekly-optimization] received ${signal}`)
    if (activeChildProcessGroupId) {
      signalProcessGroup(activeChildProcessGroupId, 'SIGTERM')
    } else if (activeChild && activeChild.exitCode === null && activeChild.signalCode === null) {
      activeChild.kill('SIGTERM')
    }
  }
  process.on('SIGINT', handler)
  process.on('SIGTERM', handler)
  process.once('exit', releaseProcessLock)
}

async function main(): Promise<void> {
  const paths = databasePaths()
  if (dryRun) {
    const configuredSteps = steps(paths)
    console.log(JSON.stringify({
      dryRun: true,
      cwd: process.cwd(),
      steps: configuredSteps.map(({ id, label, npmScript }) => ({ id, label, npmScript })),
    }, null, 2))
    return
  }

  if (!acquireProcessLock()) return
  installSignalHandlers()

  const captureStartedAt = isoNow()
  let contract: WeeklyOptimizationRunContract
  try {
    contract = captureRunContract(paths)
  } catch (error) {
    const failure = errorMessage(error)
    const finishedAt = isoNow()
    writeState({
      pid: process.pid,
      runKey: `contract-capture-failed-${createHash('sha256').update(failure).digest('hex').slice(0, 12)}`,
      startedAt: captureStartedAt,
      heartbeatAt: finishedAt,
      finishedAt,
      status: 'failed',
      error: failure,
      steps: steps(paths).map((step) => ({
        id: step.id,
        label: step.label,
        status: 'pending',
        startedAt: null,
        finishedAt: null,
        exitCode: null,
        signal: null,
        error: null,
      })),
    })
    throw error
  }
  const configuredSteps = steps(paths, contract)
  const runKey = buildRunKey(configuredSteps, contract)
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
    contract,
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
    let modelSnapshot: ModelSnapshotRow[] | null = null
    const heartbeatTimer = setInterval(() => {
      state.heartbeatAt = isoNow()
      writeState(state)
    }, 60_000)
    try {
      assertStepLineageUnchanged(step, contract, paths)
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
      result.status = 'failed'
      result.error = `interrupted by ${shutdownSignal}`
      writeState(state)
      break
    }
    if (result.status === 'failed') {
      if (step.modelDbPath && modelSnapshot && modelSnapshot.length > 0) {
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
        }
      }
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
