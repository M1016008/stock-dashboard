import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { ML_PRIMARY_HORIZON_LIST } from '@/lib/backtest/ml-horizons'
import { waitForMemoryHeadroom, withMemoryGuardEnv } from '@/lib/system/memory-guard'

const JP_DB = '/Volumes/OWC Express 1M2 80G/stock-dashboard/stockboard.db'
const US_DB = '/Volumes/OWC Express 1M2 80G/stockboard-data/us/stockboard-us.db'
const TARGET_HORIZON = '200'

type Market = 'jp' | 'us'
type Overrides = Record<string, string | undefined>

function marketFromArg(value: string | undefined): Market {
  if (value === 'jp' || value === 'us') return value
  throw new Error('Usage: tsx scripts/run-ml-horizon-backfill.ts <jp|us>')
}

function runNpm(script: string, env: NodeJS.ProcessEnv, overrides: Overrides = {}): Promise<void> {
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

async function step(label: string, script: string, env: NodeJS.ProcessEnv, overrides: Overrides = {}): Promise<void> {
  await waitForMemoryHeadroom({ label })
  console.log(`\n=== ${label} ===`)
  await runNpm(script, env, overrides)
}

async function main(): Promise<void> {
  const market = marketFromArg(process.argv[2])
  const dbPath = market === 'us' ? US_DB : JP_DB
  if (!fs.existsSync(dbPath)) throw new Error(`${market.toUpperCase()} DB not found: ${dbPath}`)

  const fullStartDate = market === 'us'
    ? process.env.US_ML_FULL_START_DATE ?? '1900-01-01'
    : process.env.ML_FULL_START_DATE ?? '1900-01-01'
  const recentDays = market === 'us'
    ? process.env.US_ML_WEEKLY_RECENT_DAYS ?? '420'
    : process.env.ML_WEEKLY_RECENT_DAYS ?? '420'
  const allPaged = market === 'jp'
  const currentYear = new Date().getFullYear()
  const evaluationStartYear = String(currentYear - 1)
  const evaluationEndYear = String(currentYear)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    USE_LOCAL_DB: '1',
    STOCKBOARD_DB_PATH: dbPath,
    STOCKBOARD_DB_ROLE: market === 'us' ? 'us-analytics' : 'jp',
    US_ANALYTICS_DB_PATH: market === 'us' ? dbPath : process.env.US_ANALYTICS_DB_PATH,
    SQLITE_BUSY_RETRIES: process.env.SQLITE_BUSY_RETRIES ?? '12',
    ML_FULL_START_DATE: fullStartDate,
    ML_ACCURACY_REQUIRED_HORIZONS: ML_PRIMARY_HORIZON_LIST,
  }

  console.log(`ML ${TARGET_HORIZON}-day backfill start: market=${market.toUpperCase()}, db=${dbPath}`)

  await step('200-day forward returns', 'batch:forward-returns', env, {
    FORWARD_RETURN_HORIZONS: TARGET_HORIZON,
    FORWARD_RETURNS_TICKER_CHUNK_SIZE: process.env.FORWARD_RETURNS_TICKER_CHUNK_SIZE ?? '250',
  })
  await step('200-day forward extrema', 'batch:forward-extrema', env, {
    BACKTEST_RECENT_DAYS: '0',
    FORWARD_EXTREMA_START_DATE: fullStartDate,
    FORWARD_EXTREMA_HORIZONS: TARGET_HORIZON,
    FORWARD_EXTREMA_WRITE_MODEL_LABELS: '0',
    FORWARD_EXTREMA_ACTIVE_ONLY: market === 'us' ? '1' : '0',
    FORWARD_EXTREMA_PROGRESS_EVERY: process.env.FORWARD_EXTREMA_PROGRESS_EVERY ?? '25',
  })
  await step('200-day standard labels', 'batch:ml-labels', env, {
    ML_HORIZONS: TARGET_HORIZON,
    ML_LABEL_RECENT_DAYS: '0',
    ML_LABEL_START_DATE: fullStartDate,
    ML_LABEL_DATE_CHUNK_DAYS: process.env.ML_LABEL_DATE_CHUNK_DAYS ?? '365',
  })
  await step('200-day standard model', 'batch:ml-train', env, {
    ML_HORIZONS: TARGET_HORIZON,
    ML_TRAIN_START_DATE: fullStartDate,
    ML_TRAIN_SAMPLE_MODE: allPaged ? 'all_paged' : 'yearly',
    ML_TRAIN_LIMIT: allPaged ? '0' : process.env.US_ML_TRAIN_LIMIT ?? '240000',
    ML_TRAIN_PER_YEAR_LIMIT: allPaged ? '0' : process.env.US_ML_TRAIN_PER_YEAR_LIMIT ?? '5000',
    ML_TRAIN_LABEL_SOURCE: 'extrema',
  })
  await step('200-day standard model evaluation', 'batch:ml-evaluate', env, {
    ML_HORIZONS: TARGET_HORIZON,
    ML_EVAL_TRAIN_START_DATE: fullStartDate,
    ML_EVAL_START_YEAR: evaluationStartYear,
    ML_EVAL_END_YEAR: evaluationEndYear,
  })
  await step('200-day short labels', 'batch:ml-short-labels', env, {
    ML_SHORT_HORIZONS: TARGET_HORIZON,
    ML_SHORT_LABEL_RECENT_DAYS: recentDays,
    ML_SHORT_LABEL_START_DATE: fullStartDate,
    ML_SHORT_WRITE_RL_STATES: '0',
    ML_SHORT_LABEL_DATE_CHUNK_DAYS: process.env.ML_SHORT_LABEL_DATE_CHUNK_DAYS ?? '365',
  })
  await step('200-day physics model', 'batch:ml-physics-train', env, {
    ML_PHYSICS_HORIZONS: TARGET_HORIZON,
    ML_PHYSICS_TRAIN_START_DATE: fullStartDate,
    ML_PHYSICS_TRAIN_SAMPLE_MODE: allPaged ? 'all_paged' : 'yearly',
    ML_PHYSICS_TRAIN_LIMIT: allPaged ? '0' : process.env.US_ML_PHYSICS_TRAIN_LIMIT ?? '240000',
    ML_PHYSICS_TRAIN_PER_YEAR_LIMIT: allPaged ? '0' : process.env.US_ML_PHYSICS_TRAIN_PER_YEAR_LIMIT ?? '5000',
  })
  await step('200-day physics candidates', 'batch:ml-physics-candidates', env, {
    ML_PHYSICS_HORIZONS: TARGET_HORIZON,
    ML_PHYSICS_CANDIDATE_LIMIT: '120',
  })
  await step('200-day RL states', 'batch:ml-short-labels', env, {
    ML_SHORT_HORIZONS: TARGET_HORIZON,
    ML_SHORT_LABEL_RECENT_DAYS: recentDays,
    ML_SHORT_LABEL_START_DATE: fullStartDate,
    ML_SHORT_SKIP_LABEL_SYNC: '1',
    ML_SHORT_WRITE_RL_STATES: '1',
  })
  await step('200-day RL policy', 'batch:ml-rl-policy', env, {
    ML_RL_HORIZONS: TARGET_HORIZON,
    ML_RL_RECENT_DAYS: recentDays,
    ML_RL_START_DATE: fullStartDate,
    ML_RL_SQL_AGG: '1',
    ML_RL_PAGE_DATES: '100',
  })
  await step('200-day physics status evaluation', 'batch:ml-physics-status-evaluate', env, {
    ML_PHYSICS_STATUS_HORIZONS: TARGET_HORIZON,
    ML_PHYSICS_STATUS_RECENT_DAYS: recentDays,
    ML_PHYSICS_STATUS_START_DATE: fullStartDate,
    ML_PHYSICS_STATUS_SQL_AGG: '1',
  })
  await step('200-day physics model evaluation', 'batch:ml-physics-evaluate', env, {
    ML_PHYSICS_HORIZONS: TARGET_HORIZON,
    ML_PHYSICS_EVAL_TRAIN_START_DATE: fullStartDate,
    ML_PHYSICS_EVAL_START_YEAR: evaluationStartYear,
    ML_PHYSICS_EVAL_END_YEAR: evaluationEndYear,
  })
  await step('200-day serving insights', 'batch:ml-insights', env)
  await step('ML feature health', 'batch:ml-feature-health', env)
  if (market === 'us') await step('US ML health', 'batch:us-ml-health', env)
  await step('ML accuracy health', 'batch:ml-accuracy-health', env)
  if (market === 'jp') {
    await step('JP dashboard cache', 'batch:dashboard-cache', env)
    await step('JP ML freshness', 'ml:freshness-check', env)
  }

  console.log(`ML ${TARGET_HORIZON}-day backfill complete: market=${market.toUpperCase()}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
