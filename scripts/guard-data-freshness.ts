// Reconcile every persisted StockBoard data family with its expected cadence.
// This process is read-mostly: it never edits market databases and only asks
// launchd to start an existing, independently locked updater when necessary.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execGet } from '@/lib/db/client'
import { execUsAnalyticsGet, hasUsAnalyticsDb } from '@/lib/db/us-analytics'
import { expectedLatestTradingDate } from '@/lib/server/data-freshness'
import { expectedLatestUsTradingDate } from '@/lib/server/us-data-freshness'
import { ML_PIPELINE_GENERATION_VERSION, ML_PIPELINE_NAME } from '@/lib/ml/pipeline-generation'
import {
  cleanupOrphanedUpdateLocks,
  EXCLUSIVE_UPDATE_JOB_TYPES,
  getActiveUpdateLocks,
  US_ISOLATED_UPDATE_JOB_TYPES,
} from '@/lib/server/update-lock'
import { US_ADJUSTED_PRICE_BASIS } from '@/lib/us-adjusted-ohlcv'
import { usInvestableSymbolSql } from '@/lib/us-symbol-quality'

type DateRow = { date: string | null }
type EpochRow = { value: number | null }
type ActiveLockRow = { jobType: string }
type LaunchdState = {
  installed: boolean
  enabled: boolean
  running: boolean
  state: string | null
}
type GuardState = {
  lastTriggeredAt: Record<string, number>
}
type ActionState =
  | 'fresh'
  | 'triggered'
  | 'would_trigger'
  | 'running'
  | 'deferred'
  | 'cooldown'
  | 'missing'
type Action = {
  key: string
  label: string
  state: ActionState
  reason: string
}
type DateMap = Record<string, string | null>
type SourceState = {
  latestSuccessAt: number | null
  ageHours: number | null
  fresh: boolean
}
type WeeklyState = {
  pid?: number
  status?: string
  startedAt?: string | null
  heartbeatAt?: string | null
  finishedAt?: string | null
}
type WeeklyFreshness = {
  state: WeeklyState
  ageHours: number | null
  jpModelDate: string | null
  usModelAgeHours: number | null
  lastActivityAt: number | null
  runningHealthy: boolean
  fresh: boolean
}
type CountRow = { count: number | null }
type RunRow = {
  status: string
  payloadJson: string
}
type PipelineGenerationRow = {
  status: string
  generationVersion: string
  lastDeltaSourceDate: string
  lastDeltaCompletedAt: number
}
type UsAutomationState = {
  universe: number
  covered: number
  coveragePct: number | null
  ingestionStatus: string | null
  ingestionNeedsRetry: boolean
  priceBasis: string | null
  derivedPriceBasis: string | null
  analogPriceBasis: string | null
  priceBasisCurrent: boolean
}
type UsCoverageHealth = {
  pmsStatus: string | null
  pmsDate: string | null
  featureStatus: string | null
  featureDate: string | null
}

const supportDir = path.join(os.homedir(), 'Library', 'Application Support', 'StockBoard')
const guardStatePath = path.join(supportDir, 'data-freshness-guard-state.json')
const reportPath = path.join(supportDir, 'data-freshness-latest.json')
const weeklyStatePath = path.join(supportDir, 'weekly-optimization-state.json')
const uid = typeof process.getuid === 'function' ? process.getuid() : Number(process.env.UID)
const cliArgs = new Set(process.argv.slice(2))
const dryRun = process.env.DATA_FRESHNESS_GUARD_DRY_RUN === '1' || cliArgs.has('--dry-run')
const force = process.env.DATA_FRESHNESS_GUARD_FORCE === '1' || cliArgs.has('--force')
const nowSec = Math.floor(Date.now() / 1000)
const legacyWeeklyLabels = [
  'com.stockboard.ml-weekly-governance',
  'com.stockboard.us-ml-weekly',
] as const

function disabledLaunchdLabels(): Set<string> {
  const result = spawnSync('launchctl', ['print-disabled', `gui/${uid}`], {
    encoding: 'utf8',
    timeout: 5_000,
  })
  if (result.status !== 0) return new Set()
  return new Set(
    [...result.stdout.matchAll(/"([^"]+)"\s*=>\s*disabled/g)]
      .map((match) => match[1])
      .filter(Boolean),
  )
}

const disabledLabels = disabledLaunchdLabels()
const jpSupplementalIgnoredWriters = [
  ...US_ISOLATED_UPDATE_JOB_TYPES,
  'heavy_us_ml_process',
] as const

const services = {
  jpCore: {
    key: 'jp-core',
    label: 'com.stockboard.update-latest',
    cooldownSeconds: 15 * 60,
    requiresIdleWriter: true,
    ignoredWriterJobTypes: ['us_adjusted_foundation'],
  },
  jpMl: {
    key: 'jp-ml',
    label: 'com.stockboard.ml-freshness-guard',
    cooldownSeconds: 2 * 60 * 60,
    requiresIdleWriter: true,
    ignoredWriterJobTypes: [],
  },
  us: {
    key: 'us',
    label: 'com.stockboard.us-update-latest',
    cooldownSeconds: 2 * 60 * 60,
    requiresIdleWriter: true,
    ignoredWriterJobTypes: [],
  },
  themes: {
    key: 'themes',
    label: 'com.stockboard.kabutan-themes',
    cooldownSeconds: 60 * 60,
    requiresIdleWriter: true,
    ignoredWriterJobTypes: jpSupplementalIgnoredWriters,
  },
  materials: {
    key: 'materials',
    label: 'com.stockboard.kabutan-material-news',
    cooldownSeconds: 60 * 60,
    requiresIdleWriter: true,
    ignoredWriterJobTypes: jpSupplementalIgnoredWriters,
  },
  earnings: {
    key: 'earnings',
    label: 'com.stockboard.earnings-refresh',
    cooldownSeconds: 90 * 60,
    requiresIdleWriter: true,
    ignoredWriterJobTypes: jpSupplementalIgnoredWriters,
  },
  usEarnings: {
    key: 'us-earnings',
    label: 'com.stockboard.us-earnings',
    cooldownSeconds: 2 * 60 * 60,
    requiresIdleWriter: false,
    ignoredWriterJobTypes: [],
  },
  weekly: {
    key: 'weekly-optimization',
    label: 'com.stockboard.weekly-optimization',
    cooldownSeconds: 6 * 60 * 60,
    requiresIdleWriter: true,
    ignoredWriterJobTypes: [],
  },
} as const
type Service = (typeof services)[keyof typeof services]

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
  } catch {
    return fallback
  }
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${process.pid}.tmp`
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temporaryPath, filePath)
}

function launchdState(label: string): LaunchdState {
  const result = spawnSync('launchctl', ['print', `gui/${uid}/${label}`], {
    encoding: 'utf8',
    timeout: 5_000,
  })
  if (result.status !== 0) {
    return { installed: false, enabled: !disabledLabels.has(label), running: false, state: null }
  }
  const state = result.stdout.match(/^\s*state = (.+)$/m)?.[1]?.trim() ?? null
  return {
    installed: true,
    enabled: !disabledLabels.has(label),
    running: state === 'running',
    state,
  }
}

function setLaunchdEnabled(label: string, enabled: boolean): { ok: boolean; error: string | null } {
  if (dryRun) return { ok: true, error: null }
  const result = spawnSync(
    'launchctl',
    [enabled ? 'enable' : 'disable', `gui/${uid}/${label}`],
    { encoding: 'utf8', timeout: 5_000 },
  )
  if (result.status === 0) {
    if (enabled) disabledLabels.delete(label)
    else disabledLabels.add(label)
  }
  return {
    ok: result.status === 0,
    error: result.status === 0
      ? null
      : (result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`),
  }
}

function enforceWeeklySchedulePolicy(): Array<{
  label: string
  expected: 'disabled'
  state: 'disabled' | 'would_disable' | 'repaired' | 'error'
  error?: string
}> {
  return legacyWeeklyLabels.map((label) => {
    if (disabledLabels.has(label)) return { label, expected: 'disabled', state: 'disabled' }
    if (dryRun) return { label, expected: 'disabled', state: 'would_disable' }
    const result = setLaunchdEnabled(label, false)
    return result.ok
      ? { label, expected: 'disabled', state: 'repaired' }
      : { label, expected: 'disabled', state: 'error', error: result.error ?? 'unknown error' }
  })
}

function heavyMlProcessReservations(): ActiveLockRow[] {
  const result = spawnSync(
    'pgrep',
    [
      '-fl',
      [
        'run-weekly-optimization',
        'run-us-ml-job',
        'run-ml-learning',
        'batch-forward-extrema',
        'batch-ml-features',
        'batch-ml-physics-features',
        'batch-ml-short-labels',
        'batch-ml-physics-train',
      ].join('|'),
    ],
    { encoding: 'utf8', timeout: 5_000 },
  )
  if (result.status !== 0) return []
  const lines = result.stdout
    .split('\n')
    .filter(Boolean)
    .filter((line) => !line.includes('guard-data-freshness'))
  const reservations: ActiveLockRow[] = []
  const hasUsOrchestrator = lines.some((line) => /run-us-ml-job/.test(line))
  if (hasUsOrchestrator) {
    reservations.push({ jobType: 'heavy_us_ml_process' })
  }
  const hasJpOrGlobalOrchestrator = lines.some(
    (line) => /run-weekly-optimization|run-ml-learning/.test(line),
  )
  if (hasJpOrGlobalOrchestrator || (!hasUsOrchestrator && lines.length > 0)) {
    reservations.push({ jobType: 'heavy_ml_process' })
  }
  return reservations
}

function kickstart(label: string, restart = false): { ok: boolean; error: string | null } {
  const result = spawnSync('launchctl', ['kickstart', ...(restart ? ['-k'] : []), `gui/${uid}/${label}`], {
    encoding: 'utf8',
    timeout: 15_000,
  })
  return {
    ok: result.status === 0,
    error: result.status === 0
      ? null
      : (result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`),
  }
}

function pidExists(pid: number | undefined): boolean {
  if (!Number.isInteger(pid) || Number(pid) <= 0) return false
  try {
    process.kill(Number(pid), 0)
    return true
  } catch {
    return false
  }
}

function maxDate(
  query: (sql: string, args?: readonly (string | number | null)[]) => Promise<DateRow | undefined>,
  table: string,
  column: 'date' | 'as_of_date' | 'evaluation_date',
  where = '',
): Promise<string | null> {
  return query(`SELECT MAX(${column}) AS date FROM ${table} ${where}`)
    .then((row) => row?.date ?? null)
}

function isAligned(value: string | null, target: string | null): boolean {
  return Boolean(value && target && value >= target)
}

function staleDateEntries(dates: DateMap, target: string | null, keys: readonly string[]): string[] {
  return keys.filter((key) => !isAligned(dates[key] ?? null, target))
}

function sourceState(value: number | null, maxAgeHours: number): SourceState {
  const ageHours = value == null ? null : Math.max(0, (nowSec - value) / 3600)
  return {
    latestSuccessAt: value,
    ageHours: ageHours == null ? null : Math.round(ageHours * 10) / 10,
    fresh: ageHours != null && ageHours <= maxAgeHours,
  }
}

async function loadJpDates(): Promise<DateMap> {
  const query = (sql: string, args: readonly (string | number | null)[] = []) => execGet<DateRow>(sql, args)
  const entries = await Promise.all([
    maxDate(query, 'ohlcv_daily', 'date').then((date) => ['price', date] as const),
    maxDate(query, 'daily_snapshots', 'date').then((date) => ['snapshot', date] as const),
    maxDate(query, 'indices_daily', 'date').then((date) => ['indices', date] as const),
    maxDate(query, 'dashboard_cache', 'date').then((date) => ['dashboardCache', date] as const),
    maxDate(
      query,
      'physical_momentum_metrics',
      'date',
      "WHERE market = 'JP' AND physical_momentum_score IS NOT NULL AND physical_force_score IS NOT NULL AND physical_energy_score IS NOT NULL",
    ).then((date) => ['physicalScores', date] as const),
    maxDate(query, 'feature_snapshots', 'date').then((date) => ['feature', date] as const),
    maxDate(query, 'model_features', 'date').then((date) => ['modelFeature', date] as const),
    maxDate(query, 'ml_feature_vectors', 'date').then((date) => ['mlFeature', date] as const),
    maxDate(query, 'ml_market_context_features', 'date').then((date) => ['mlContext', date] as const),
    maxDate(query, 'ml_feature_vectors_v2', 'date').then((date) => ['mlPhysicsFeature', date] as const),
    maxDate(query, 'serving_ml_candidates', 'as_of_date').then((date) => ['mlCandidate', date] as const),
    maxDate(query, 'ml_predictions', 'as_of_date').then((date) => ['mlPrediction', date] as const),
    maxDate(query, 'serving_ml_physics_candidates', 'as_of_date').then((date) => ['mlPhysicsCandidate', date] as const),
    maxDate(query, 'serving_current_similars', 'as_of_date').then((date) => ['mlSimilar', date] as const),
    maxDate(query, 'ml_rl_policy_evaluations', 'evaluation_date').then((date) => ['mlRlPolicy', date] as const),
  ])
  return Object.fromEntries(entries) as DateMap
}

async function loadUsDates(): Promise<DateMap> {
  if (!hasUsAnalyticsDb()) return {}
  const query = (sql: string, args: readonly (string | number | null)[] = []) => execUsAnalyticsGet<DateRow>(sql, args)
  const entries = await Promise.all([
    maxDate(query, 'ohlcv_daily', 'date').then((date) => ['price', date] as const),
    maxDate(query, 'daily_snapshots', 'date').then((date) => ['snapshot', date] as const),
    maxDate(query, 'dashboard_cache', 'date').then((date) => ['dashboardCache', date] as const),
    maxDate(
      query,
      'physical_momentum_metrics',
      'date',
      "WHERE market = 'US' AND physical_momentum_score IS NOT NULL AND physical_force_score IS NOT NULL AND physical_energy_score IS NOT NULL",
    ).then((date) => ['physicalScores', date] as const),
    maxDate(query, 'ml_feature_vectors', 'date').then((date) => ['mlFeature', date] as const),
    maxDate(query, 'ml_market_context_features', 'date').then((date) => ['mlContext', date] as const),
    maxDate(query, 'ml_feature_vectors_v2', 'date').then((date) => ['mlPhysicsFeature', date] as const),
    maxDate(query, 'serving_ml_candidates', 'as_of_date').then((date) => ['mlCandidate', date] as const),
    maxDate(query, 'ml_predictions', 'as_of_date').then((date) => ['mlPrediction', date] as const),
    maxDate(query, 'serving_ml_physics_candidates', 'as_of_date').then((date) => ['mlPhysicsCandidate', date] as const),
    maxDate(query, 'serving_current_similars', 'as_of_date').then((date) => ['mlSimilar', date] as const),
    maxDate(query, 'ml_rl_policy_evaluations', 'evaluation_date').then((date) => ['mlRlPolicy', date] as const),
  ])
  return Object.fromEntries(entries) as DateMap
}

async function loadSourceStates(): Promise<{
  themes: SourceState
  materials: SourceState
  earnings: SourceState
  usEarnings: SourceState
}> {
  const [themes, materials, earnings, usEarnings] = await Promise.all([
    execGet<EpochRow>(
      "SELECT MAX(finished_at) AS value FROM kabutan_theme_runs WHERE status = 'success'",
    ),
    execGet<EpochRow>(
      "SELECT MAX(finished_at) AS value FROM kabutan_material_news_runs WHERE status = 'success'",
    ),
    execGet<EpochRow>(
      "SELECT MAX(finished_at) AS value FROM batch_runs WHERE job_type = 'earnings_refresh' AND status = 'success'",
    ),
    execGet<EpochRow>(
      "SELECT MAX(finished_at) AS value FROM market_data_runs WHERE market = 'US' AND job_type = 'finnhub_earnings' AND status = 'success'",
    ),
  ])
  return {
    themes: sourceState(themes?.value ?? null, 36),
    materials: sourceState(materials?.value ?? null, 3),
    earnings: sourceState(earnings?.value ?? null, 36),
    usEarnings: sourceState(usEarnings?.value ?? null, 36),
  }
}

async function loadUsCoverageHealth(): Promise<UsCoverageHealth> {
  if (!hasUsAnalyticsDb()) {
    return { pmsStatus: null, pmsDate: null, featureStatus: null, featureDate: null }
  }
  const [pms, features] = await Promise.all([
    execUsAnalyticsGet<{ status: string; expectedDate: string | null }>(
      `SELECT status, expected_date AS expectedDate
       FROM ml_feature_health_checks
       WHERE check_key = 'us_physical_momentum_metrics'
       ORDER BY computed_at DESC
       LIMIT 1`,
    ).catch(() => undefined),
    execUsAnalyticsGet<{ status: string; expectedDate: string | null }>(
      `SELECT status, expected_date AS expectedDate
       FROM ml_feature_health_checks
       WHERE check_key = 'us_ml_feature_vectors_v2'
       ORDER BY computed_at DESC
       LIMIT 1`,
    ).catch(() => undefined),
  ])
  return {
    pmsStatus: pms?.status ?? null,
    pmsDate: pms?.expectedDate ?? null,
    featureStatus: features?.status ?? null,
    featureDate: features?.expectedDate ?? null,
  }
}

async function loadUsAutomationState(expectedDate: string): Promise<UsAutomationState> {
  const [universeRow, coveredRow, runRow, basisRow, derivedBasisRow, analogBasisRow] = await Promise.all([
    execGet<CountRow>(
      `SELECT COUNT(*) AS count
       FROM market_universe
       WHERE market = 'US'
         AND active = 1
         AND ${usInvestableSymbolSql('ticker')}`,
    ),
    execGet<CountRow>(
      `SELECT COUNT(*) AS count
       FROM market_universe u INDEXED BY market_universe_market_active_idx
       INNER JOIN market_ohlcv_daily o INDEXED BY market_ohlcv_market_date_ticker_idx
         ON o.market = 'US' AND o.date = ? AND o.ticker = u.ticker
       WHERE u.market = 'US'
         AND u.active = 1
         AND ${usInvestableSymbolSql('u.ticker')}`,
      [expectedDate],
    ),
    execGet<RunRow>(
      `SELECT status, payload_json AS payloadJson
       FROM market_data_runs
       WHERE market = 'US' AND job_type = 'tiingo_ohlcv'
       ORDER BY started_at DESC
       LIMIT 1`,
    ),
    hasUsAnalyticsDb()
      ? execUsAnalyticsGet<{ value: string }>(
          `SELECT value
           FROM us_analytics_metadata
           WHERE key = 'ohlcv_price_basis'`,
        ).catch(() => undefined)
      : Promise.resolve(undefined),
    hasUsAnalyticsDb()
      ? execUsAnalyticsGet<{ value: string }>(
          `SELECT value
           FROM us_analytics_metadata
           WHERE key = 'derived_price_basis'`,
        ).catch(() => undefined)
      : Promise.resolve(undefined),
    hasUsAnalyticsDb()
      ? execUsAnalyticsGet<{ value: string }>(
          `SELECT value
           FROM us_analytics_metadata
           WHERE key = 'analog_index_price_basis'`,
        ).catch(() => undefined)
      : Promise.resolve(undefined),
  ])
  const universe = Number(universeRow?.count ?? 0)
  const covered = Number(coveredRow?.count ?? 0)
  let ingestionNeedsRetry = runRow?.status === 'failed'
    || runRow?.status === 'interrupted'
    || runRow?.status === 'partial'
  if (runRow?.payloadJson) {
    try {
      const payload = JSON.parse(runRow.payloadJson) as { deferred?: unknown; quotaExhausted?: unknown }
      ingestionNeedsRetry = ingestionNeedsRetry
        || Number(payload.deferred ?? 0) > 0
        || payload.quotaExhausted === true
    } catch {
      ingestionNeedsRetry = true
    }
  }
  const priceBasis = basisRow?.value ?? null
  const derivedPriceBasis = derivedBasisRow?.value ?? null
  const analogPriceBasis = analogBasisRow?.value ?? null
  return {
    universe,
    covered,
    coveragePct: universe > 0 ? Math.round((100 * covered / universe) * 100) / 100 : null,
    ingestionStatus: runRow?.status ?? null,
    ingestionNeedsRetry,
    priceBasis,
    derivedPriceBasis,
    analogPriceBasis,
    priceBasisCurrent:
      priceBasis === US_ADJUSTED_PRICE_BASIS
      && derivedPriceBasis === US_ADJUSTED_PRICE_BASIS
      && analogPriceBasis === US_ADJUSTED_PRICE_BASIS,
  }
}

async function weeklyFreshness(): Promise<WeeklyFreshness> {
  const state = readJson<WeeklyState>(weeklyStatePath, {})
  const heartbeatReference = state.heartbeatAt ?? state.startedAt
  const heartbeatMs = heartbeatReference ? Date.parse(heartbeatReference) : Number.NaN
  const runningHealthy = state.status === 'running'
    && pidExists(state.pid)
    && Number.isFinite(heartbeatMs)
    && Date.now() - heartbeatMs <= 10 * 60 * 1_000
  const fileReference = runningHealthy ? heartbeatReference : state.finishedAt
  const fileTimestampMs = fileReference ? Date.parse(fileReference) : Number.NaN
  const [fallback, jpPipeline, usModel] = await Promise.all([
    execGet<{
      lastSuccessAt: number | null
      lastActivityAt: number | null
    }>(
      `SELECT
         MAX(CASE
           WHEN status = 'success' AND finished_at - started_at >= 7200
           THEN finished_at
         END) AS lastSuccessAt,
         MAX(COALESCE(finished_at, started_at)) AS lastActivityAt
       FROM batch_runs
       WHERE job_type = 'ml_learning'
         AND started_at >= unixepoch('now', '-14 days')
         AND (
           finished_at - started_at >= 7200
           OR status = 'running'
         )`,
    ),
    execGet<PipelineGenerationRow>(
      `SELECT
         status,
         generation_version AS generationVersion,
         last_delta_source_date AS lastDeltaSourceDate,
         last_delta_completed_at AS lastDeltaCompletedAt
       FROM ml_pipeline_generations
       WHERE market = 'JP' AND pipeline = ?
       LIMIT 1`,
      [ML_PIPELINE_NAME],
    ).catch(() => undefined),
    hasUsAnalyticsDb()
      ? execUsAnalyticsGet<EpochRow>('SELECT MAX(trained_at) AS value FROM ml_models')
      : Promise.resolve(undefined),
  ])
  const fallbackSuccessMs = fallback?.lastSuccessAt == null
    ? Number.NaN
    : Number(fallback.lastSuccessAt) * 1000
  const pipelineSuccessMs = jpPipeline?.status === 'complete'
    && jpPipeline.generationVersion === ML_PIPELINE_GENERATION_VERSION
    ? Number(jpPipeline.lastDeltaCompletedAt) * 1000
    : 0
  const fileCompletedMs = state.status === 'completed' && Number.isFinite(fileTimestampMs)
    ? fileTimestampMs
    : 0
  const jpWeeklySuccessMs = Math.max(
    fileCompletedMs,
    Number.isFinite(fallbackSuccessMs) ? fallbackSuccessMs : 0,
    Number.isFinite(pipelineSuccessMs) ? pipelineSuccessMs : 0,
  )
  const usModelMs = usModel?.value == null ? 0 : Number(usModel.value) * 1000
  const ageHours = jpWeeklySuccessMs > 0
    ? Math.max(0, (Date.now() - jpWeeklySuccessMs) / 3_600_000)
    : null
  const usModelAgeHours = usModelMs > 0
    ? Math.max(0, (Date.now() - usModelMs) / 3_600_000)
    : null
  const lastActivityAt = Math.max(
    Number.isFinite(fileTimestampMs) ? Math.floor(fileTimestampMs / 1000) : 0,
    Number.isFinite(heartbeatMs) ? Math.floor(heartbeatMs / 1000) : 0,
    Number(fallback?.lastActivityAt ?? 0),
    Number.isFinite(pipelineSuccessMs) ? Math.floor(pipelineSuccessMs / 1000) : 0,
  ) || null
  const reportState = state.status === 'failed'
    && pipelineSuccessMs > 0
    && (!Number.isFinite(fileTimestampMs) || pipelineSuccessMs > fileTimestampMs)
    ? {
        status: 'superseded_by_pipeline_delta',
        finishedAt: new Date(pipelineSuccessMs).toISOString(),
      }
    : state
  return {
    state: reportState,
    ageHours: ageHours == null ? null : Math.round(ageHours * 10) / 10,
    jpModelDate: jpPipeline?.lastDeltaSourceDate ?? null,
    usModelAgeHours: usModelAgeHours == null ? null : Math.round(usModelAgeHours * 10) / 10,
    lastActivityAt,
    runningHealthy,
    fresh:
      runningHealthy
      || (
        ageHours != null
        && ageHours <= 8 * 24
        && usModelAgeHours != null
        && usModelAgeHours <= 8 * 24
      ),
  }
}

async function maybeTrigger(
  service: Service,
  needed: boolean,
  reason: string,
  activeLocks: readonly ActiveLockRow[],
  state: GuardState,
  sourceLastRunAt: number | null = null,
  restartRunning = false,
): Promise<Action> {
  const launchd = launchdState(service.label)
  if (!launchd.installed) {
    return { key: service.key, label: service.label, state: 'missing', reason: `${reason}; launchd service is not installed` }
  }
  let scheduleRepair = ''
  if (!launchd.enabled) {
    if (dryRun) {
      return {
        key: service.key,
        label: service.label,
        state: 'missing',
        reason: `${reason}; launchd service is disabled`,
      }
    }
    const enabled = setLaunchdEnabled(service.label, true)
    if (!enabled.ok) {
      return {
        key: service.key,
        label: service.label,
        state: 'missing',
        reason: `${reason}; launchd enable failed: ${enabled.error ?? 'unknown error'}`,
      }
    }
    scheduleRepair = '; disabled schedule was re-enabled'
  }
  if (!needed) {
    return { key: service.key, label: service.label, state: 'fresh', reason: `${reason}${scheduleRepair}` }
  }
  if (launchd.running && !restartRunning) {
    return { key: service.key, label: service.label, state: 'running', reason }
  }
  const ignoredWriterJobTypes: readonly string[] = service.ignoredWriterJobTypes
  const blockingLocks = activeLocks.filter(
    (lock) => !ignoredWriterJobTypes.includes(lock.jobType),
  )
  if (service.requiresIdleWriter && blockingLocks.length > 0) {
    return {
      key: service.key,
      label: service.label,
      state: 'deferred',
      reason: `${reason}; active writer: ${blockingLocks.map((lock) => lock.jobType).join(', ')}`,
    }
  }

  const latestKnownStart = Math.max(
    state.lastTriggeredAt[service.label] ?? 0,
    sourceLastRunAt ?? 0,
  )
  const remaining = latestKnownStart + service.cooldownSeconds - nowSec
  if (!force && remaining > 0) {
    return {
      key: service.key,
      label: service.label,
      state: 'cooldown',
      reason: `${reason}; retry in ${Math.ceil(remaining / 60)} minutes`,
    }
  }
  if (dryRun) {
    return { key: service.key, label: service.label, state: 'would_trigger', reason }
  }

  const result = kickstart(service.label, launchd.running && restartRunning)
  if (!result.ok) {
    return {
      key: service.key,
      label: service.label,
      state: 'deferred',
      reason: `${reason}; kickstart failed: ${result.error ?? 'unknown error'}`,
    }
  }
  state.lastTriggeredAt[service.label] = nowSec
  writeJson(guardStatePath, state)
  return { key: service.key, label: service.label, state: 'triggered', reason }
}

async function main(): Promise<void> {
  const state = readJson<GuardState>(guardStatePath, { lastTriggeredAt: {} })
  const weeklySchedulePolicy = enforceWeeklySchedulePolicy()
  const expectedJp = expectedLatestTradingDate()
  const expectedUs = expectedLatestUsTradingDate()
  const clearedOrphanedLocks = await cleanupOrphanedUpdateLocks(EXCLUSIVE_UPDATE_JOB_TYPES)
  const [jpDates, usDates, sources, activeLocks, usAutomation, usCoverageHealth] = await Promise.all([
    loadJpDates(),
    loadUsDates(),
    loadSourceStates(),
    getActiveUpdateLocks().then(
      (locks) => locks.map((lock) => ({ jobType: lock.jobType })),
    ),
    loadUsAutomationState(expectedUs),
    loadUsCoverageHealth(),
  ])
  const weekly = await weeklyFreshness()
  const heavyMlReservations = heavyMlProcessReservations()

  const jpPrice = jpDates.price
  const jpCoreStale = staleDateEntries(
    jpDates,
    jpPrice,
    ['snapshot', 'indices', 'dashboardCache', 'physicalScores', 'feature', 'modelFeature'],
  )
  const jpMlStale = staleDateEntries(
    jpDates,
    jpPrice,
    [
      'mlFeature',
      'mlContext',
      'mlPhysicsFeature',
      'mlCandidate',
      'mlPrediction',
      'mlPhysicsCandidate',
      'mlSimilar',
    ],
  )
  const usPrice = usDates.price
  const usStale = staleDateEntries(
    usDates,
    usPrice,
    [
      'snapshot',
      'dashboardCache',
      'physicalScores',
      'mlFeature',
      'mlContext',
      'mlPhysicsFeature',
      'mlCandidate',
      'mlPrediction',
      'mlPhysicsCandidate',
      'mlSimilar',
    ],
  )
  const usCoverageIncomplete = Boolean(
    (usCoverageHealth.pmsStatus && usCoverageHealth.pmsStatus !== 'ok')
    || (usCoverageHealth.featureStatus && usCoverageHealth.featureStatus !== 'ok')
    || (usPrice && usCoverageHealth.pmsDate !== usPrice)
    || (usPrice && usCoverageHealth.featureDate !== usPrice),
  )

  const actions: Action[] = []
  const writerReservations = [
    ...activeLocks,
    ...heavyMlReservations,
  ]
  const reconcile = async (
    service: Service,
    needed: boolean,
    reason: string,
    sourceLastRunAt: number | null = null,
    restartRunning = false,
  ): Promise<void> => {
    const action = await maybeTrigger(
      service,
      needed,
      reason,
      writerReservations,
      state,
      sourceLastRunAt,
      restartRunning,
    )
    actions.push(action)
    if (
      service.requiresIdleWriter
      && (action.state === 'triggered' || action.state === 'running')
    ) {
      writerReservations.push({ jobType: service.key })
    }
  }

  await reconcile(
    services.jpCore,
    !jpPrice || jpPrice < expectedJp || jpCoreStale.length > 0,
    `expected=${expectedJp}, price=${jpPrice ?? '-'}, stale=${jpCoreStale.join(',') || '-'}`,
  )
  await reconcile(
    services.jpMl,
    Boolean(jpPrice) && jpMlStale.length > 0,
    `price=${jpPrice ?? '-'}, stale=${jpMlStale.join(',') || '-'}`,
  )
  await reconcile(
    services.us,
    !usPrice
      || usPrice < expectedUs
      || usStale.length > 0
      || usCoverageIncomplete
      || usAutomation.ingestionNeedsRetry
      || (usAutomation.coveragePct != null && usAutomation.coveragePct < 95),
    `expected=${expectedUs}, price=${usPrice ?? '-'}, stale=${usStale.join(',') || '-'}, `
      + `coverageHealth=pms:${usCoverageHealth.pmsStatus ?? '-'}@${usCoverageHealth.pmsDate ?? '-'}`
      + `/features:${usCoverageHealth.featureStatus ?? '-'}@${usCoverageHealth.featureDate ?? '-'}, `
      + `coverage=${usAutomation.coveragePct ?? '-'}%, ingestion=${usAutomation.ingestionStatus ?? '-'}`,
  )
  await reconcile(
    services.themes,
    !sources.themes.fresh,
    `last success age=${sources.themes.ageHours ?? '-'}h`,
    sources.themes.latestSuccessAt,
  )
  await reconcile(
    services.materials,
    !sources.materials.fresh,
    `last success age=${sources.materials.ageHours ?? '-'}h`,
    sources.materials.latestSuccessAt,
  )
  await reconcile(
    services.earnings,
    !sources.earnings.fresh,
    `last success age=${sources.earnings.ageHours ?? '-'}h`,
    sources.earnings.latestSuccessAt,
  )
  if (process.env.FINNHUB_API_KEY?.trim()) {
    await reconcile(
      services.usEarnings,
      !sources.usEarnings.fresh,
      `last success age=${sources.usEarnings.ageHours ?? '-'}h`,
      sources.usEarnings.latestSuccessAt,
    )
  } else {
    actions.push({
      key: services.usEarnings.key,
      label: services.usEarnings.label,
      state: 'fresh',
      reason: 'optional source disabled because FINNHUB_API_KEY is not configured',
    })
  }
  await reconcile(
    services.weekly,
    !weekly.fresh || !usAutomation.priceBasisCurrent,
    `status=${weekly.state.status ?? 'missing'}, jpDate=${weekly.jpModelDate ?? '-'}, jpAge=${weekly.ageHours ?? '-'}h, `
      + `usModelAge=${weekly.usModelAgeHours ?? '-'}h, `
      + `priceBasis=${usAutomation.priceBasis ?? 'missing'}, `
      + `derivedBasis=${usAutomation.derivedPriceBasis ?? 'missing'}, `
      + `analogBasis=${usAutomation.analogPriceBasis ?? 'missing'}`
      + `/${US_ADJUSTED_PRICE_BASIS}`,
    weekly.lastActivityAt,
    weekly.state.status === 'running' && !weekly.runningHealthy,
  )

  const report = {
    status: actions.every((action) => action.state === 'fresh' || action.state === 'running')
      && weeklySchedulePolicy.every((item) => item.state === 'disabled' || item.state === 'repaired')
      ? 'ok'
      : 'attention',
    checkedAt: new Date().toISOString(),
    dryRun,
    expected: { jp: expectedJp, us: expectedUs },
    dates: { jp: jpDates, us: usDates },
    usAutomation,
    usCoverageHealth,
    sources,
    weekly,
    weeklySchedulePolicy,
    clearedOrphanedLocks,
    activeLocks: writerReservations.map((lock) => lock.jobType),
    actions,
  }
  if (!dryRun) writeJson(reportPath, report)
  console.log(JSON.stringify(report, null, 2))
}

main().catch((error) => {
  const report = {
    status: 'unavailable',
    checkedAt: new Date().toISOString(),
    error: errorMessage(error),
  }
  if (!dryRun) writeJson(reportPath, report)
  console.error(JSON.stringify(report, null, 2))
  process.exitCode = 1
})
