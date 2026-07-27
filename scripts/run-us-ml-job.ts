// scripts/run-us-ml-job.ts
//
// US ML jobs must always run against the external US analytics DB.  This
// wrapper gives both daily and full-history jobs the same guarded environment,
// so a direct npm invocation cannot accidentally write US artifacts into the JP
// stockboard database.

import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import { exactForwardExtremaRecomputeBars } from '@/lib/backtest/forward-extrema'
import { ML_PRIMARY_HORIZON_LIST } from '@/lib/backtest/ml-horizons'
import { waitForMemoryHeadroom, withMemoryGuardEnv } from '@/lib/system/memory-guard'

const DEFAULT_US_ANALYTICS_DB = '/Volumes/OWC Express 1M2 80G/stockboard-data/us/stockboard-us.db'

type Mode = 'daily' | 'full' | 'after-pms'
type EnvOverrides = Record<string, string | undefined>

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function numberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function modeFromArg(value: string | undefined): Mode {
  if (value === 'daily' || value === 'full' || value === 'after-pms') return value
  throw new Error('Usage: tsx scripts/run-us-ml-job.ts <daily|full|after-pms>')
}

async function runNpmOnce(script: string, env: NodeJS.ProcessEnv, overrides: EnvOverrides = {}): Promise<void> {
  await waitForMemoryHeadroom({ label: `npm run ${script}` })
  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['run', script], {
      cwd: process.cwd(),
      env: withMemoryGuardEnv({ ...env, ...overrides }),
      stdio: 'inherit',
    })
    child.on('error', reject)
    child.on('close', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`npm run ${script} failed: code=${code}, signal=${signal ?? 'none'}`))
    })
  })
}

function sqliteInt(dbPath: string, sql: string): number {
  const output = execFileSync('sqlite3', ['-cmd', '.timeout 30000', dbPath, sql], { encoding: 'utf8' }).trim()
  const value = Number(output)
  return Number.isFinite(value) ? value : 0
}

function sqliteText(dbPath: string, sql: string): string {
  return execFileSync('sqlite3', ['-cmd', '.timeout 30000', dbPath, sql], { encoding: 'utf8' }).trim()
}

function physicsEvaluationWindow(env: NodeJS.ProcessEnv, recentDaysValue: string): {
  trainStartDate: string
  startYear: string
  endYear: string
} {
  const dbPath = env.STOCKBOARD_DB_PATH
  const latestDate = dbPath ? sqliteText(dbPath, 'SELECT MAX(date) FROM ohlcv_daily') : ''
  const latestYear = /^\d{4}-\d{2}-\d{2}$/.test(latestDate)
    ? Number(latestDate.slice(0, 4))
    : new Date().getUTCFullYear()
  const recentDays = Number(recentDaysValue)
  const evaluationYears = Math.max(1, Math.ceil((Number.isFinite(recentDays) ? recentDays : 420) / 252))
  const startYear = latestYear - evaluationYears + 1

  return {
    trainStartDate: `${startYear - 1}-01-01`,
    startYear: String(startYear),
    endYear: String(latestYear),
  }
}

function sqlQuote(value: string): string {
  return value.replaceAll("'", "''")
}

function latestEligibleMissingFeatureCount(env: NodeJS.ProcessEnv, minHistoryDays: string): number {
  const dbPath = env.STOCKBOARD_DB_PATH
  if (!dbPath) return 0
  const minRows = Number(minHistoryDays) || 1
  return sqliteInt(
    dbPath,
    `
    SELECT COUNT(*)
    FROM (
      SELECT o.ticker
      FROM ohlcv_daily o
      WHERE o.date = (SELECT MAX(date) FROM ohlcv_daily)
        AND (SELECT COUNT(*) FROM ohlcv_daily h WHERE h.ticker = o.ticker) >= ${minRows}
        AND NOT EXISTS (
          SELECT 1
          FROM ml_feature_vectors f
          WHERE f.ticker = o.ticker AND f.date = o.date
        )
      GROUP BY o.ticker
      )
    `,
  )
}

function latestEligibleMissingPhysicsFeatureCount(env: NodeJS.ProcessEnv, minHistoryDays: string): number {
  const dbPath = env.STOCKBOARD_DB_PATH
  if (!dbPath) return 0
  const featureSet = env.ML_PHYSICS_FEATURE_SET?.trim() || 'ma_physics_v4'
  const minRows = Number(minHistoryDays) || 1
  return sqliteInt(
    dbPath,
    `
    SELECT COUNT(*)
    FROM (
      SELECT d.ticker
      FROM daily_snapshots d
      WHERE d.date = (SELECT MAX(date) FROM daily_snapshots)
        AND (SELECT COUNT(*) FROM ohlcv_daily h WHERE h.ticker = d.ticker) >= ${minRows}
        AND NOT EXISTS (
          SELECT 1
          FROM ml_feature_vectors_v2 f
          WHERE f.ticker = d.ticker
            AND f.date = d.date
            AND f.feature_set = '${sqlQuote(featureSet)}'
        )
      GROUP BY d.ticker
      )
    `,
  )
}

async function runNpm(script: string, env: NodeJS.ProcessEnv, overrides: EnvOverrides = {}): Promise<void> {
  const attempts = numberEnv('US_ML_STEP_MAX_ATTEMPTS', 3)
  const retryDelaySeconds = numberEnv('US_ML_STEP_RETRY_DELAY_SECONDS', 300)
  let lastError: unknown = null

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      if (attempt > 1) console.log(`US ML retry ${attempt}/${attempts}: npm run ${script}`)
      await runNpmOnce(script, env, overrides)
      return
    } catch (error) {
      lastError = error
      console.error(`US ML step failed ${attempt}/${attempts}: npm run ${script}: ${errorMessage(error)}`)
      if (attempt >= attempts) break
      await sleep(retryDelaySeconds * 1000)
    }
  }

  throw lastError instanceof Error ? lastError : new Error(errorMessage(lastError))
}

async function runFullHistory(env: NodeJS.ProcessEnv, options: { skipPms?: boolean } = {}): Promise<void> {
  const startDate = env.US_ML_FULL_START_DATE ?? '1900-01-01'
  const horizons = ML_PRIMARY_HORIZON_LIST
  const weeklyRecentDays = env.US_ML_WEEKLY_RECENT_DAYS ?? '420'
  const exactExtremaRecomputeBars = String(
    exactForwardExtremaRecomputeBars(horizons.split(',').map(Number)),
  )
  const physicsEvalWindow = physicsEvaluationWindow(env, weeklyRecentDays)

  if (!options.skipPms) {
    await runNpm('batch:physical-momentum:us-full', env, {
      US_PMS_RECENT_DAYS: env.US_PMS_WEEKLY_RECENT_DAYS ?? weeklyRecentDays,
      US_PMS_TICKER_CHUNK: env.US_PMS_WEEKLY_TICKER_CHUNK ?? '250',
      US_PMS_DATE_CHUNK: env.US_PMS_WEEKLY_DATE_CHUNK ?? '50',
    })
  }
  if (env.US_ML_SKIP_FORWARD_RETURNS === '1') {
    console.log('US ML full-history: skipping forward_returns by US_ML_SKIP_FORWARD_RETURNS=1')
  } else {
    await runNpm('batch:forward-returns:ml', env, {
      FORWARD_RETURN_HORIZONS: env.US_ML_FORWARD_RETURN_HORIZONS ?? horizons,
      FORWARD_RETURNS_TICKER_CHUNK_SIZE: env.FORWARD_RETURNS_TICKER_CHUNK_SIZE ?? '250',
    })
  }
  if (env.US_ML_SKIP_FORWARD_EXTREMA === '1') {
    console.log('US ML full-history: skipping forward_extrema by US_ML_SKIP_FORWARD_EXTREMA=1')
  } else {
    await runNpm('batch:forward-extrema:ml-recent', env, {
      ML_WEEKLY_EXTREMA_RECENT_DAYS:
        env.US_ML_WEEKLY_EXTREMA_RECALC_DAYS ?? exactExtremaRecomputeBars,
      ML_FULL_START_DATE: startDate,
      FORWARD_EXTREMA_START_DATE: startDate,
      FORWARD_EXTREMA_HORIZONS: horizons,
      FORWARD_EXTREMA_WRITE_MODEL_LABELS: '0',
      FORWARD_EXTREMA_ACTIVE_ONLY: '1',
      FORWARD_EXTREMA_PROGRESS_EVERY: env.FORWARD_EXTREMA_PROGRESS_EVERY ?? '25',
      FORWARD_EXTREMA_RESUME: env.FORWARD_EXTREMA_RESUME ?? '1',
    })
  }
  if (env.US_ML_SKIP_ML_FEATURES === '1') {
    console.log('US ML full-history: skipping ml-features by US_ML_SKIP_ML_FEATURES=1')
  } else {
    await runNpm('batch:ml-features', env, {
      ML_RECENT_DAYS: env.US_ML_FEATURE_RECENT_DAYS ?? weeklyRecentDays,
      ML_MIN_HISTORY_DAYS: env.US_ML_FEATURE_MIN_HISTORY_DAYS ?? '1',
      ML_START_DATE: startDate,
      ML_HORIZONS: horizons,
      ML_TICKER_START: env.US_ML_FEATURE_TICKER_START,
      ML_TICKER_END: env.US_ML_FEATURE_TICKER_END,
      ML_FEATURE_ACTIVE_ONLY: '1',
    })
  }
  if (env.US_ML_SKIP_ML_LABELS === '1') {
    console.log('US ML full-history: skipping ml-labels by US_ML_SKIP_ML_LABELS=1')
  } else {
    await runNpm('batch:ml-labels', env, {
      ML_LABEL_RECENT_DAYS: env.US_ML_LABEL_RECENT_DAYS ?? weeklyRecentDays,
      ML_LABEL_DATE_CHUNK_DAYS: env.US_ML_LABEL_DATE_CHUNK_DAYS ?? '365',
    })
  }
  if (env.US_ML_SKIP_ML_TRAIN === '1') {
    console.log('US ML full-history: skipping ml-train by US_ML_SKIP_ML_TRAIN=1')
  } else {
    await runNpm('batch:ml-train', env, {
      ML_HORIZONS: horizons,
      ML_TRAIN_START_DATE: startDate,
      ML_TRAIN_SAMPLE_MODE: env.US_ML_TRAIN_SAMPLE_MODE ?? 'yearly',
      ML_TRAIN_LIMIT: env.US_ML_TRAIN_LIMIT ?? '240000',
      ML_TRAIN_PER_YEAR_LIMIT: env.US_ML_TRAIN_PER_YEAR_LIMIT ?? '5000',
      ML_TRAIN_LABEL_SOURCE: 'extrema',
    })
  }
  await runNpm('batch:ml-candidates', env)
  await runNpm('batch:ml-predict', env)
  if (env.US_ML_SKIP_CONTEXT_FEATURES === '1') {
    console.log('US ML full-history: skipping ml-context-features by US_ML_SKIP_CONTEXT_FEATURES=1')
  } else {
    await runNpm('batch:ml-context-features', env, {
      ML_CONTEXT_RECENT_DAYS: env.US_ML_CONTEXT_RECENT_DAYS ?? weeklyRecentDays,
      ML_CONTEXT_START_DATE: startDate,
    })
  }
  if (env.US_ML_SKIP_PHYSICS_FEATURES === '1') {
    console.log('US ML full-history: skipping ml-physics-features by US_ML_SKIP_PHYSICS_FEATURES=1')
  } else {
    await runNpm('batch:ml-physics-features', env, {
      ML_PHYSICS_RECENT_DAYS: env.US_ML_PHYSICS_RECENT_DAYS ?? weeklyRecentDays,
      ML_PHYSICS_MIN_HISTORY_DAYS: env.US_ML_PHYSICS_MIN_HISTORY_DAYS ?? '1',
      ML_PHYSICS_START_DATE: startDate,
      ML_PHYSICS_TICKER_START: env.US_ML_PHYSICS_TICKER_START,
      ML_PHYSICS_TICKER_END: env.US_ML_PHYSICS_TICKER_END,
      ML_PHYSICS_ACTIVE_ONLY: '1',
    })
  }
  if (env.US_ML_SKIP_PHYSICS_TRAIN === '1') {
    console.log('US ML full-history: skipping ml-physics-train by US_ML_SKIP_PHYSICS_TRAIN=1')
  } else {
    await runNpm('batch:ml-physics-train', env, {
      ML_PHYSICS_HORIZONS: horizons,
      ML_PHYSICS_TRAIN_START_DATE: startDate,
      ML_PHYSICS_TRAIN_SAMPLE_MODE: env.US_ML_PHYSICS_TRAIN_SAMPLE_MODE ?? 'yearly',
      ML_PHYSICS_TRAIN_LIMIT: env.US_ML_PHYSICS_TRAIN_LIMIT ?? '240000',
      ML_PHYSICS_TRAIN_PER_YEAR_LIMIT: env.US_ML_PHYSICS_TRAIN_PER_YEAR_LIMIT ?? '5000',
    })
  }
  if (env.US_ML_SKIP_PHYSICS_CANDIDATES === '1') {
    console.log('US ML full-history: skipping ml-physics-candidates by US_ML_SKIP_PHYSICS_CANDIDATES=1')
  } else {
    await runNpm('batch:ml-physics-candidates', env, {
      ML_PHYSICS_HORIZONS: horizons,
      ML_PHYSICS_CANDIDATE_LIMIT: '120',
    })
  }
  if (env.US_ML_SKIP_INSIGHTS === '1') {
    console.log('US ML full-history: skipping ml-insights by US_ML_SKIP_INSIGHTS=1')
  } else {
    await runNpm('batch:ml-insights', env)
  }
  if (env.US_ML_SKIP_SHORT_LABELS === '1') {
    console.log('US ML full-history: skipping ml-short-labels by US_ML_SKIP_SHORT_LABELS=1')
  } else {
    await runNpm('batch:ml-short-labels', env, {
      ML_SHORT_HORIZONS: horizons,
      ML_SHORT_LABEL_RECENT_DAYS: env.US_ML_SHORT_LABEL_RECENT_DAYS ?? weeklyRecentDays,
      ML_SHORT_LABEL_START_DATE: startDate,
      ML_SHORT_WRITE_RL_STATES: '0',
      ML_SHORT_LABEL_DATE_CHUNK_DAYS: env.US_ML_SHORT_LABEL_DATE_CHUNK_DAYS ?? '365',
    })
    await runNpm('batch:ml-short-labels', env, {
      ML_SHORT_HORIZONS: horizons,
      ML_SHORT_LABEL_RECENT_DAYS: env.US_ML_SHORT_LABEL_RECENT_DAYS ?? weeklyRecentDays,
      ML_SHORT_LABEL_START_DATE: startDate,
      ML_SHORT_SKIP_LABEL_SYNC: '1',
      ML_SHORT_WRITE_RL_STATES: '1',
    })
  }
  await runNpm('batch:ml-rl-policy', env, {
    ML_RL_HORIZONS: horizons,
    ML_RL_RECENT_DAYS: env.US_ML_RL_RECENT_DAYS ?? weeklyRecentDays,
    ML_RL_START_DATE: startDate,
    ML_RL_SQL_AGG: '1',
    ML_RL_PAGE_DATES: env.US_ML_RL_PAGE_DATES ?? '100',
  })
  await runNpm('batch:ml-physics-status-evaluate', env, {
    ML_PHYSICS_STATUS_HORIZONS: horizons,
    ML_PHYSICS_STATUS_RECENT_DAYS: env.US_ML_STATUS_RECENT_DAYS ?? weeklyRecentDays,
    ML_PHYSICS_STATUS_START_DATE: startDate,
    ML_PHYSICS_STATUS_SQL_AGG: env.US_ML_STATUS_SQL_AGG ?? '1',
  })
  await runNpm('batch:ml-physics-evaluate', env, {
    ML_PHYSICS_HORIZONS: horizons,
    ML_PHYSICS_EVAL_TRAIN_START_DATE:
      env.US_ML_PHYSICS_EVAL_TRAIN_START_DATE ?? physicsEvalWindow.trainStartDate,
    ML_PHYSICS_EVAL_START_YEAR:
      env.US_ML_PHYSICS_EVAL_START_YEAR ?? physicsEvalWindow.startYear,
    ML_PHYSICS_EVAL_END_YEAR:
      env.US_ML_PHYSICS_EVAL_END_YEAR ?? physicsEvalWindow.endYear,
  })
  if (env.US_ML_SKIP_ANALYSIS_FOUNDATION === '1') {
    console.log('US ML full-history: skipping analysis foundation by US_ML_SKIP_ANALYSIS_FOUNDATION=1')
  } else {
    await runNpm('batch:weekly-ohlcv', env)
    await runNpm('batch:technical-signals', env, {
      BACKTEST_RECENT_DAYS: env.US_BACKTEST_RECENT_DAYS ?? '0',
    })
    await runNpm('batch:pattern-stats', env, {
      PATTERN_STAT_HORIZONS: env.US_PATTERN_STAT_HORIZONS ?? horizons,
    })
    await runNpm('batch:stage-transitions', env)
    await runNpm('batch:signal-stats', env, {
      BACKTEST_RECENT_DAYS: env.US_BACKTEST_RECENT_DAYS ?? '0',
      SIGNAL_STATS_LIMIT_GROUPS: '0',
      SIGNAL_STATS_DATE_CHUNK: env.US_SIGNAL_STATS_DATE_CHUNK ?? '20',
    })
    await runNpm('batch:signal-return-stats', env, {
      BACKTEST_RECENT_DAYS: env.US_BACKTEST_RECENT_DAYS ?? '0',
      SIGNAL_RETURN_HORIZONS: env.US_SIGNAL_RETURN_HORIZONS ?? horizons,
    })
    await runNpm('batch:serving-backtest:full', env, {
      SERVING_DATE_LIMIT: '0',
      SERVING_SUMMARY_DATE_CHUNK: env.US_SERVING_SUMMARY_DATE_CHUNK ?? '40',
    })
  }
  await runNpm('batch:us-ml-health', env, {
    US_ML_HEALTH_WRITE: '1',
  })
  await runNpm('batch:ml-accuracy-health', env, {
    ML_ACCURACY_STRICT: '1',
  })
}

async function runDailyServing(env: NodeJS.ProcessEnv): Promise<void> {
  const startDate = env.US_ML_FULL_START_DATE ?? '1900-01-01'
  const horizons = ML_PRIMARY_HORIZON_LIST
  const dailyRecentDays = env.US_ML_DAILY_RECENT_DAYS ?? '2'
  const dailyMinHistoryDays = env.US_ML_DAILY_MIN_HISTORY_DAYS ?? '220'

  if (env.US_ML_SKIP_DAILY_PMS === '1') {
    console.log('US ML daily: skipping PMS by US_ML_SKIP_DAILY_PMS=1')
  } else {
    await runNpm('batch:physical-momentum:us-full', env, {
      US_PMS_RECENT_DAYS: env.US_PMS_DAILY_RECENT_DAYS ?? '30',
      US_PMS_TICKER_CHUNK: env.US_PMS_DAILY_TICKER_CHUNK ?? '250',
      US_PMS_DATE_CHUNK: env.US_PMS_DAILY_DATE_CHUNK ?? '50',
    })
  }
  const featureMissingOnlyDate = env.US_ML_DAILY_FEATURE_MISSING_ONLY_DATE ?? 'latest'
  const featureTickerLimit = env.US_ML_DAILY_FEATURE_TICKER_LIMIT ?? '750'
  const featureMaxPasses = numberEnv('US_ML_DAILY_FEATURE_MAX_PASSES', 80)
  if (featureMissingOnlyDate === 'latest') {
    for (let pass = 1; pass <= featureMaxPasses; pass += 1) {
      console.log(`US ML daily features pass ${pass}/${featureMaxPasses}: counting eligible_missing...`)
      const missing = latestEligibleMissingFeatureCount(env, dailyMinHistoryDays)
      console.log(`US ML daily features pass ${pass}/${featureMaxPasses}: eligible_missing=${missing}, ticker_limit=${featureTickerLimit}`)
      if (missing <= 0) break
      await runNpm('batch:ml-features', env, {
        ML_RECENT_DAYS: dailyRecentDays,
        ML_MIN_HISTORY_DAYS: dailyMinHistoryDays,
        ML_START_DATE: startDate,
        ML_HORIZONS: horizons,
        ML_MISSING_ONLY_DATE: featureMissingOnlyDate,
        ML_TICKER_LIMIT: featureTickerLimit,
      })
    }
  } else {
    await runNpm('batch:ml-features', env, {
      ML_RECENT_DAYS: dailyRecentDays,
      ML_MIN_HISTORY_DAYS: dailyMinHistoryDays,
      ML_START_DATE: startDate,
      ML_HORIZONS: horizons,
      ML_MISSING_ONLY_DATE: featureMissingOnlyDate,
      ML_TICKER_LIMIT: env.US_ML_DAILY_FEATURE_TICKER_LIMIT,
    })
  }
  if (env.US_ML_DAILY_REFRESH_LABELS === '1') {
    await runNpm('batch:ml-labels', env, {
      ML_LABEL_RECENT_DAYS: env.US_ML_DAILY_LABEL_RECENT_DAYS ?? '10',
      ML_LABEL_DATE_CHUNK_DAYS: env.US_ML_DAILY_LABEL_DATE_CHUNK_DAYS ?? '7',
    })
    await runNpm('batch:ml-outcomes', env)
  } else {
    console.log('US ML daily: skipping labels/outcomes; weekly full ML refresh owns training data')
  }
  await runNpm('batch:ml-candidates', env)
  await runNpm('batch:ml-predict', env)
  await runNpm('batch:ml-context-features', env, {
    ML_CONTEXT_RECENT_DAYS: env.US_ML_CONTEXT_DAILY_RECENT_DAYS ?? '2',
    ML_CONTEXT_START_DATE: startDate,
  })
  const physicsMissingOnlyDate = env.US_ML_DAILY_PHYSICS_MISSING_ONLY_DATE ?? 'latest'
  const physicsTickerLimit = env.US_ML_DAILY_PHYSICS_TICKER_LIMIT ?? '500'
  const physicsMaxPasses = numberEnv('US_ML_DAILY_PHYSICS_MAX_PASSES', 80)
  const physicsMinHistoryDays = env.US_ML_PHYSICS_DAILY_MIN_HISTORY_DAYS ?? '220'
  if (physicsMissingOnlyDate === 'latest') {
    for (let pass = 1; pass <= physicsMaxPasses; pass += 1) {
      console.log(`US ML daily physics features pass ${pass}/${physicsMaxPasses}: counting eligible_missing...`)
      const missing = latestEligibleMissingPhysicsFeatureCount(env, physicsMinHistoryDays)
      console.log(`US ML daily physics features pass ${pass}/${physicsMaxPasses}: eligible_missing=${missing}, ticker_limit=${physicsTickerLimit}`)
      if (missing <= 0) break
      await runNpm('batch:ml-physics-features', env, {
        ML_PHYSICS_RECENT_DAYS: env.US_ML_PHYSICS_DAILY_RECENT_DAYS ?? '2',
        ML_PHYSICS_MIN_HISTORY_DAYS: physicsMinHistoryDays,
        ML_PHYSICS_START_DATE: startDate,
        ML_PHYSICS_MISSING_ONLY_DATE: physicsMissingOnlyDate,
        ML_PHYSICS_TICKER_LIMIT: physicsTickerLimit,
      })
    }
  } else {
    await runNpm('batch:ml-physics-features', env, {
      ML_PHYSICS_RECENT_DAYS: env.US_ML_PHYSICS_DAILY_RECENT_DAYS ?? '2',
      ML_PHYSICS_MIN_HISTORY_DAYS: physicsMinHistoryDays,
      ML_PHYSICS_START_DATE: startDate,
      ML_PHYSICS_MISSING_ONLY_DATE: physicsMissingOnlyDate,
      ML_PHYSICS_TICKER_LIMIT: env.US_ML_DAILY_PHYSICS_TICKER_LIMIT,
    })
  }
  await runNpm('batch:ml-physics-candidates', env, {
    ML_PHYSICS_HORIZONS: horizons,
    ML_PHYSICS_CANDIDATE_LIMIT: '120',
  })
  await runNpm('batch:ml-insights', env)
  if (env.US_ML_DAILY_REFRESH_RL === '1') {
    await runNpm('batch:ml-short-labels', env, {
      ML_SHORT_HORIZONS: horizons,
      ML_SHORT_LABEL_RECENT_DAYS: env.US_ML_DAILY_RL_RECENT_DAYS ?? '60',
      ML_SHORT_LABEL_START_DATE: startDate,
      ML_SHORT_RL_DATE_CHUNK_DAYS: env.US_ML_DAILY_RL_DATE_CHUNK_DAYS ?? '7',
      ML_SHORT_WRITE_RL_STATES: '1',
    })
    await runNpm('batch:ml-rl-policy', env, {
      ML_RL_HORIZONS: horizons,
      ML_RL_RECENT_DAYS: env.US_ML_DAILY_RL_RECENT_DAYS ?? '60',
      ML_RL_START_DATE: startDate,
      ML_RL_SQL_AGG: '1',
      ML_RL_PAGE_DATES: env.US_ML_RL_PAGE_DATES ?? '100',
    })
  } else {
    console.log('US ML daily: skipping RL state/policy refresh; weekly full ML refresh owns RL updates')
  }
  if (env.US_ML_DAILY_REFRESH_STATUS === '1') {
    await runNpm('batch:ml-physics-status-evaluate', env, {
      ML_PHYSICS_STATUS_HORIZONS: horizons,
      ML_PHYSICS_STATUS_RECENT_DAYS: env.US_ML_DAILY_STATUS_RECENT_DAYS ?? '60',
      ML_PHYSICS_STATUS_START_DATE: startDate,
    })
  } else {
    console.log('US ML daily: skipping physics status evaluation; weekly full ML refresh owns status evaluation')
  }
  await runNpm('batch:us-ml-health', env, {
    US_ML_HEALTH_WRITE: '1',
    US_ML_HEALTH_MIN_HISTORY_DAYS: physicsMinHistoryDays,
  })
  if (env.US_ML_DAILY_ACCURACY_HEALTH === '1') {
    await runNpm('batch:ml-accuracy-health', env, {
      ML_ACCURACY_STRICT: '1',
    })
  }
}

async function main(): Promise<void> {
  const mode = modeFromArg(process.argv[2])
  const usAnalyticsDbPath = process.env.US_ANALYTICS_DB_PATH?.trim() || DEFAULT_US_ANALYTICS_DB

  if (!fs.existsSync(usAnalyticsDbPath)) {
    throw new Error(`US analytics DB not found: ${usAnalyticsDbPath}`)
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    USE_LOCAL_DB: '1',
    STOCKBOARD_DB_ROLE: 'us-analytics',
    STOCKBOARD_DB_PATH: usAnalyticsDbPath,
    US_ANALYTICS_DB_PATH: usAnalyticsDbPath,
    SQLITE_BUSY_RETRIES: process.env.SQLITE_BUSY_RETRIES ?? '12',
    UPDATE_CHILD_TIMEOUT_MINUTES: process.env.UPDATE_CHILD_TIMEOUT_MINUTES ?? '2880',
    US_ML_FULL_START_DATE: process.env.US_ML_FULL_START_DATE ?? '1900-01-01',
    US_ML_STEP_MAX_ATTEMPTS: process.env.US_ML_STEP_MAX_ATTEMPTS ?? '3',
    US_ML_STEP_RETRY_DELAY_SECONDS: process.env.US_ML_STEP_RETRY_DELAY_SECONDS ?? '300',
  }

  console.log(`US ML ${mode} job: db=${usAnalyticsDbPath}`)
  if (mode === 'full') await runFullHistory(env)
  else if (mode === 'after-pms') await runFullHistory(env, { skipPms: true })
  else await runDailyServing(env)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
