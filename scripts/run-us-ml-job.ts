// scripts/run-us-ml-job.ts
//
// US ML jobs must always run against the external US analytics DB.  This
// wrapper gives both daily and full-history jobs the same guarded environment,
// so a direct npm invocation cannot accidentally write US artifacts into the JP
// stockboard database.

import { spawn } from 'node:child_process'
import fs from 'node:fs'

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

function runNpmOnce(script: string, env: NodeJS.ProcessEnv, overrides: EnvOverrides = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['run', script], {
      cwd: process.cwd(),
      env: { ...env, ...overrides },
      stdio: 'inherit',
    })
    child.on('error', reject)
    child.on('close', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`npm run ${script} failed: code=${code}, signal=${signal ?? 'none'}`))
    })
  })
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
  const horizons = '5,10,20,40,60,90'

  if (!options.skipPms) {
    await runNpm('batch:physical-momentum:us-full', env)
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
    await runNpm('batch:forward-extrema:ml', env, {
      BACKTEST_RECENT_DAYS: '0',
      ML_FULL_START_DATE: startDate,
      FORWARD_EXTREMA_START_DATE: startDate,
      FORWARD_EXTREMA_HORIZONS: horizons,
      FORWARD_EXTREMA_WRITE_MODEL_LABELS: '0',
    })
  }
  if (env.US_ML_SKIP_ML_FEATURES === '1') {
    console.log('US ML full-history: skipping ml-features by US_ML_SKIP_ML_FEATURES=1')
  } else {
    await runNpm('batch:ml-features', env, {
      ML_RECENT_DAYS: env.US_ML_FEATURE_RECENT_DAYS ?? '0',
      ML_MIN_HISTORY_DAYS: env.US_ML_FEATURE_MIN_HISTORY_DAYS ?? '1',
      ML_START_DATE: startDate,
      ML_HORIZONS: horizons,
    })
  }
  if (env.US_ML_SKIP_ML_LABELS === '1') {
    console.log('US ML full-history: skipping ml-labels by US_ML_SKIP_ML_LABELS=1')
  } else {
    await runNpm('batch:ml-labels', env, { ML_LABEL_RECENT_DAYS: env.US_ML_LABEL_RECENT_DAYS ?? '0' })
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
      ML_CONTEXT_RECENT_DAYS: env.US_ML_CONTEXT_RECENT_DAYS ?? '20',
      ML_CONTEXT_START_DATE: startDate,
    })
  }
  if (env.US_ML_SKIP_PHYSICS_FEATURES === '1') {
    console.log('US ML full-history: skipping ml-physics-features by US_ML_SKIP_PHYSICS_FEATURES=1')
  } else {
    await runNpm('batch:ml-physics-features', env, {
      ML_PHYSICS_RECENT_DAYS: env.US_ML_PHYSICS_RECENT_DAYS ?? '20',
      ML_PHYSICS_MIN_HISTORY_DAYS: env.US_ML_PHYSICS_MIN_HISTORY_DAYS ?? '200',
      ML_PHYSICS_START_DATE: startDate,
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
      ML_SHORT_LABEL_RECENT_DAYS: env.US_ML_SHORT_LABEL_RECENT_DAYS ?? '20',
      ML_SHORT_LABEL_START_DATE: startDate,
      ML_SHORT_WRITE_RL_STATES: '0',
      ML_SHORT_LABEL_DATE_CHUNK_DAYS: env.US_ML_SHORT_LABEL_DATE_CHUNK_DAYS ?? '90',
    })
    await runNpm('batch:ml-short-labels', env, {
      ML_SHORT_HORIZONS: horizons,
      ML_SHORT_LABEL_RECENT_DAYS: env.US_ML_SHORT_LABEL_RECENT_DAYS ?? '20',
      ML_SHORT_LABEL_START_DATE: startDate,
      ML_SHORT_SKIP_LABEL_SYNC: '1',
      ML_SHORT_WRITE_RL_STATES: '1',
    })
  }
  await runNpm('batch:ml-rl-policy', env, {
    ML_RL_HORIZONS: horizons,
    ML_RL_RECENT_DAYS: '0',
    ML_RL_START_DATE: startDate,
    ML_RL_SQL_AGG: '1',
    ML_RL_PAGE_DATES: env.US_ML_RL_PAGE_DATES ?? '100',
  })
  await runNpm('batch:ml-physics-status-evaluate', env, {
    ML_PHYSICS_STATUS_HORIZONS: horizons,
    ML_PHYSICS_STATUS_RECENT_DAYS: '0',
    ML_PHYSICS_STATUS_START_DATE: startDate,
  })
  await runNpm('batch:ml-physics-evaluate', env, {
    ML_PHYSICS_EVAL_TRAIN_START_DATE: startDate,
  })
  await runNpm('batch:us-ml-health', env)
  await runNpm('batch:ml-accuracy-health', env)
}

async function runDailyServing(env: NodeJS.ProcessEnv): Promise<void> {
  const startDate = env.US_ML_FULL_START_DATE ?? '1900-01-01'
  const horizons = '5,10,20,40,60,90'

  await runNpm('batch:physical-momentum', env, {
    PMS_RECENT_DAYS: env.US_PMS_DAILY_RECENT_DAYS ?? '420',
    PMS_OUTPUT_MARKET: 'US',
    PMS_RUN_JOB_TYPE: 'physical_momentum_us',
  })
  await runNpm('batch:ml-features', env, {
    ML_RECENT_DAYS: env.US_ML_DAILY_RECENT_DAYS ?? '420',
    ML_MIN_HISTORY_DAYS: env.US_ML_DAILY_MIN_HISTORY_DAYS ?? '220',
    ML_START_DATE: startDate,
    ML_HORIZONS: horizons,
  })
  await runNpm('batch:ml-labels', env, { ML_LABEL_RECENT_DAYS: env.US_ML_DAILY_LABEL_RECENT_DAYS ?? '520' })
  await runNpm('batch:ml-outcomes', env)
  await runNpm('batch:ml-candidates', env)
  await runNpm('batch:ml-predict', env)
  await runNpm('batch:ml-context-features', env, {
    ML_CONTEXT_RECENT_DAYS: env.US_ML_CONTEXT_DAILY_RECENT_DAYS ?? '420',
    ML_CONTEXT_START_DATE: startDate,
  })
  await runNpm('batch:ml-physics-features', env, {
    ML_PHYSICS_RECENT_DAYS: env.US_ML_PHYSICS_DAILY_RECENT_DAYS ?? '420',
    ML_PHYSICS_MIN_HISTORY_DAYS: env.US_ML_PHYSICS_DAILY_MIN_HISTORY_DAYS ?? '220',
    ML_PHYSICS_START_DATE: startDate,
  })
  await runNpm('batch:ml-physics-candidates', env, {
    ML_PHYSICS_HORIZONS: horizons,
    ML_PHYSICS_CANDIDATE_LIMIT: '120',
  })
  await runNpm('batch:ml-insights', env)
  await runNpm('batch:ml-short-labels', env, {
    ML_SHORT_HORIZONS: horizons,
    ML_SHORT_LABEL_RECENT_DAYS: env.US_ML_DAILY_RL_RECENT_DAYS ?? '260',
    ML_SHORT_LABEL_START_DATE: startDate,
    ML_SHORT_WRITE_RL_STATES: '1',
  })
  await runNpm('batch:ml-rl-policy', env, {
    ML_RL_HORIZONS: horizons,
    ML_RL_RECENT_DAYS: env.US_ML_DAILY_RL_RECENT_DAYS ?? '260',
    ML_RL_START_DATE: startDate,
    ML_RL_SQL_AGG: '1',
    ML_RL_PAGE_DATES: env.US_ML_RL_PAGE_DATES ?? '100',
  })
  await runNpm('batch:ml-physics-status-evaluate', env, {
    ML_PHYSICS_STATUS_HORIZONS: horizons,
    ML_PHYSICS_STATUS_RECENT_DAYS: env.US_ML_DAILY_STATUS_RECENT_DAYS ?? '1560',
    ML_PHYSICS_STATUS_START_DATE: startDate,
  })
  await runNpm('batch:us-ml-health', env)
  await runNpm('batch:ml-accuracy-health', env)
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
    STOCKBOARD_DB_PATH: usAnalyticsDbPath,
    US_ANALYTICS_DB_PATH: usAnalyticsDbPath,
    SQLITE_BUSY_RETRIES: process.env.SQLITE_BUSY_RETRIES ?? '720',
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
