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
import { getActiveUpdateLocks } from '@/lib/server/update-lock'

type DateRow = { date: string | null }
type EpochRow = { value: number | null }
type ActiveLockRow = { jobType: string }
type LaunchdState = {
  installed: boolean
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
  status?: string
  startedAt?: string | null
  finishedAt?: string | null
}
type WeeklyFreshness = {
  state: WeeklyState
  ageHours: number | null
  usModelAgeHours: number | null
  lastActivityAt: number | null
  fresh: boolean
}

const supportDir = path.join(os.homedir(), 'Library', 'Application Support', 'StockBoard')
const guardStatePath = path.join(supportDir, 'data-freshness-guard-state.json')
const reportPath = path.join(supportDir, 'data-freshness-latest.json')
const weeklyStatePath = path.join(supportDir, 'weekly-optimization-state.json')
const uid = typeof process.getuid === 'function' ? process.getuid() : Number(process.env.UID)
const dryRun = process.env.DATA_FRESHNESS_GUARD_DRY_RUN === '1'
const force = process.env.DATA_FRESHNESS_GUARD_FORCE === '1'
const nowSec = Math.floor(Date.now() / 1000)

const services = {
  jpCore: {
    key: 'jp-core',
    label: 'com.stockboard.update-latest',
    cooldownSeconds: 90 * 60,
    requiresIdleWriter: true,
  },
  jpMl: {
    key: 'jp-ml',
    label: 'com.stockboard.ml-freshness-guard',
    cooldownSeconds: 2 * 60 * 60,
    requiresIdleWriter: true,
  },
  us: {
    key: 'us',
    label: 'com.stockboard.us-update-latest',
    cooldownSeconds: 2 * 60 * 60,
    requiresIdleWriter: true,
  },
  themes: {
    key: 'themes',
    label: 'com.stockboard.kabutan-themes',
    cooldownSeconds: 60 * 60,
    requiresIdleWriter: true,
  },
  materials: {
    key: 'materials',
    label: 'com.stockboard.kabutan-material-news',
    cooldownSeconds: 60 * 60,
    requiresIdleWriter: true,
  },
  earnings: {
    key: 'earnings',
    label: 'com.stockboard.earnings-refresh',
    cooldownSeconds: 6 * 60 * 60,
    requiresIdleWriter: true,
  },
  weekly: {
    key: 'weekly-optimization',
    label: 'com.stockboard.weekly-optimization',
    cooldownSeconds: 6 * 60 * 60,
    requiresIdleWriter: true,
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
  if (result.status !== 0) return { installed: false, running: false, state: null }
  const state = result.stdout.match(/^\s*state = (.+)$/m)?.[1]?.trim() ?? null
  return {
    installed: true,
    running: state === 'running',
    state,
  }
}

function kickstart(label: string): { ok: boolean; error: string | null } {
  const result = spawnSync('launchctl', ['kickstart', `gui/${uid}/${label}`], {
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
}> {
  const [themes, materials, earnings] = await Promise.all([
    execGet<EpochRow>(
      "SELECT MAX(finished_at) AS value FROM kabutan_theme_runs WHERE status = 'success'",
    ),
    execGet<EpochRow>(
      "SELECT MAX(finished_at) AS value FROM kabutan_material_news_runs WHERE status = 'success'",
    ),
    execGet<EpochRow>(
      "SELECT MAX(finished_at) AS value FROM batch_runs WHERE job_type = 'earnings_refresh' AND status = 'success'",
    ),
  ])
  return {
    themes: sourceState(themes?.value ?? null, 36),
    materials: sourceState(materials?.value ?? null, 3),
    earnings: sourceState(earnings?.value ?? null, 36),
  }
}

async function weeklyFreshness(): Promise<WeeklyFreshness> {
  const state = readJson<WeeklyState>(weeklyStatePath, {})
  const fileReference = state.status === 'running' ? state.startedAt : state.finishedAt
  const fileTimestampMs = fileReference ? Date.parse(fileReference) : Number.NaN
  const [fallback, usModel] = await Promise.all([
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
    hasUsAnalyticsDb()
      ? execUsAnalyticsGet<EpochRow>('SELECT MAX(trained_at) AS value FROM ml_models')
      : Promise.resolve(undefined),
  ])
  const fallbackSuccessMs = fallback?.lastSuccessAt == null
    ? Number.NaN
    : Number(fallback.lastSuccessAt) * 1000
  const fileCompletedMs = state.status === 'completed' && Number.isFinite(fileTimestampMs)
    ? fileTimestampMs
    : 0
  const jpWeeklySuccessMs = Math.max(
    fileCompletedMs,
    Number.isFinite(fallbackSuccessMs) ? fallbackSuccessMs : 0,
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
    Number(fallback?.lastActivityAt ?? 0),
  ) || null
  return {
    state,
    ageHours: ageHours == null ? null : Math.round(ageHours * 10) / 10,
    usModelAgeHours: usModelAgeHours == null ? null : Math.round(usModelAgeHours * 10) / 10,
    lastActivityAt,
    fresh:
      state.status === 'running'
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
): Promise<Action> {
  const launchd = launchdState(service.label)
  if (!launchd.installed) {
    return { key: service.key, label: service.label, state: 'missing', reason: `${reason}; launchd service is not installed` }
  }
  if (!needed) return { key: service.key, label: service.label, state: 'fresh', reason }
  if (launchd.running) {
    return { key: service.key, label: service.label, state: 'running', reason }
  }
  if (service.requiresIdleWriter && activeLocks.length > 0) {
    return {
      key: service.key,
      label: service.label,
      state: 'deferred',
      reason: `${reason}; active writer: ${activeLocks.map((lock) => lock.jobType).join(', ')}`,
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

  const result = kickstart(service.label)
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
  const expectedJp = expectedLatestTradingDate()
  const expectedUs = expectedLatestUsTradingDate()
  const [jpDates, usDates, sources, activeLocks] = await Promise.all([
    loadJpDates(),
    loadUsDates(),
    loadSourceStates(),
    getActiveUpdateLocks().then(
      (locks) => locks.map((lock) => ({ jobType: lock.jobType })),
    ),
  ])
  const weekly = await weeklyFreshness()

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
      'mlRlPolicy',
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
      'mlRlPolicy',
    ],
  )

  const actions: Action[] = []
  const writerReservations = [...activeLocks]
  const reconcile = async (
    service: Service,
    needed: boolean,
    reason: string,
    sourceLastRunAt: number | null = null,
  ): Promise<void> => {
    const action = await maybeTrigger(
      service,
      needed,
      reason,
      writerReservations,
      state,
      sourceLastRunAt,
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
    !usPrice || usPrice < expectedUs || usStale.length > 0,
    `expected=${expectedUs}, price=${usPrice ?? '-'}, stale=${usStale.join(',') || '-'}`,
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
  await reconcile(
    services.weekly,
    !weekly.fresh,
    `status=${weekly.state.status ?? 'missing'}, jpAge=${weekly.ageHours ?? '-'}h, usModelAge=${weekly.usModelAgeHours ?? '-'}h`,
    weekly.lastActivityAt,
  )

  const report = {
    status: actions.every((action) => action.state === 'fresh' || action.state === 'running')
      ? 'ok'
      : 'attention',
    checkedAt: new Date().toISOString(),
    dryRun,
    expected: { jp: expectedJp, us: expectedUs },
    dates: { jp: jpDates, us: usDates },
    sources,
    weekly,
    activeLocks: activeLocks.map((lock) => lock.jobType),
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
