import { spawn, type ChildProcess } from 'node:child_process'
import { ML_PHYSICS_FEATURE_SET } from '@/lib/backtest/ml-physics'
import { execAll, execGet, execRun } from '@/lib/db/client'
import { ML_PIPELINE_GENERATION_VERSION } from '@/lib/ml/pipeline-generation'
import { waitForMemoryHeadroom, withMemoryGuardEnv } from '@/lib/system/memory-guard'

type Phase = {
  name: string
  script: string
  env?: Record<string, string>
}

const fullStartDate = process.env.ML_FULL_START_DATE?.trim() || '1900-01-01'
const horizons = '5,10,20,40,60,90,200'
const checkpointJob = `ml_refresh_${ML_PIPELINE_GENERATION_VERSION.replace(/[^a-zA-Z0-9_]/g, '_')}`
const requestedFeatureTickerBatchSize = Number(process.env.ML_FEATURE_TICKER_BATCH_SIZE ?? 50)
const featureTickerBatchSize = Number.isFinite(requestedFeatureTickerBatchSize)
  ? Math.max(1, Math.floor(requestedFeatureTickerBatchSize))
  : 50
const requestedPhysicsTickerBatchSize = Number(process.env.ML_PHYSICS_TICKER_BATCH_SIZE ?? 40)
const physicsTickerBatchSize = Number.isFinite(requestedPhysicsTickerBatchSize)
  ? Math.max(1, Math.floor(requestedPhysicsTickerBatchSize))
  : 40
let activeChild: ChildProcess | null = null

const phases: Phase[] = [
  {
    name: 'targets_recent',
    script: 'batch:forward-extrema:ml-recent',
    env: {
      FORWARD_EXTREMA_INCREMENTAL_UPSERT: '1',
      FORWARD_EXTREMA_RESUME: '1',
      FORWARD_EXTREMA_PROGRESS_EVERY: '100',
    },
  },
  { name: 'targets_verify', script: 'verify:forward-extrema' },
  {
    name: 'stage_features_full',
    script: 'batch:ml-features',
    env: {
      ML_RECENT_DAYS: '0',
      ML_MIN_HISTORY_DAYS: '1',
      ML_START_DATE: fullStartDate,
      // Targets are unchanged by calendar-stage correction. Dedicated short-label
      // and RL-state phases below rebuild their own v2 tables exactly once.
      ML_FEATURE_WRITE_LABELS: '0',
      ML_FEATURE_WRITE_RL_STATES: '0',
    },
  },
  {
    name: 'normal_labels_full',
    script: 'batch:ml-labels',
    env: {
      ML_HORIZONS: horizons,
      ML_LABEL_START_DATE: fullStartDate,
      ML_LABEL_RECENT_DAYS: '0',
      ML_LABEL_DATE_CHUNK_DAYS: '365',
      ML_LABEL_INCREMENTAL_UPSERT: '1',
      ML_LABEL_CHANGED_ONLY: '0',
    },
  },
  { name: 'normal_labels_verify', script: 'verify:ml-labels' },
  {
    name: 'normal_models_full',
    script: 'batch:ml-train',
    env: {
      ML_HORIZONS: horizons,
      ML_TRAIN_START_DATE: fullStartDate,
      ML_TRAIN_SAMPLE_MODE: 'all_paged',
      ML_TRAIN_LIMIT: '0',
      ML_TRAIN_LABEL_SOURCE: 'extrema',
      ML_TRAIN_PAGE_DATES: '40',
    },
  },
  { name: 'normal_candidates', script: 'batch:ml-candidates' },
  { name: 'normal_predictions', script: 'batch:ml-predict' },
  {
    name: 'context_features_full',
    script: 'batch:ml-context-features',
    env: { ML_CONTEXT_RECENT_DAYS: '0', ML_CONTEXT_START_DATE: fullStartDate },
  },
  {
    name: 'physics_features_full',
    script: 'batch:ml-physics-features',
    env: { ML_PHYSICS_RECENT_DAYS: '0', ML_PHYSICS_MIN_HISTORY_DAYS: '1', ML_PHYSICS_START_DATE: fullStartDate },
  },
  { name: 'historical_universe', script: 'batch:historical-universe' },
  {
    name: 'short_labels_full',
    script: 'batch:ml-short-labels',
    env: {
      ML_SHORT_HORIZONS: horizons,
      ML_SHORT_LABEL_RECENT_DAYS: '0',
      ML_SHORT_LABEL_START_DATE: fullStartDate,
      ML_SHORT_WRITE_RL_STATES: '0',
      ML_SHORT_LABEL_DATE_CHUNK_DAYS: '365',
    },
  },
  {
    name: 'rl_states_full',
    script: 'batch:ml-short-labels',
    env: {
      ML_SHORT_HORIZONS: horizons,
      ML_SHORT_LABEL_RECENT_DAYS: '0',
      ML_SHORT_LABEL_START_DATE: fullStartDate,
      ML_SHORT_SKIP_LABEL_SYNC: '1',
      ML_SHORT_WRITE_RL_STATES: '1',
    },
  },
  {
    name: 'physics_status_full',
    script: 'batch:ml-physics-status-evaluate',
    env: {
      ML_PHYSICS_STATUS_HORIZONS: horizons,
      ML_PHYSICS_STATUS_RECENT_DAYS: '0',
      ML_PHYSICS_STATUS_START_DATE: fullStartDate,
    },
  },
  {
    name: 'physics_models_full',
    script: 'batch:ml-physics-train',
    env: {
      ML_PHYSICS_HORIZONS: horizons,
      ML_PHYSICS_TRAIN_START_DATE: fullStartDate,
      ML_PHYSICS_TRAIN_SAMPLE_MODE: 'all_paged',
      ML_PHYSICS_TRAIN_LIMIT: '0',
      ML_PHYSICS_TRAIN_PAGE_DATES: '10',
    },
  },
  { name: 'physics_candidates', script: 'batch:ml-physics-candidates', env: { ML_PHYSICS_HORIZONS: horizons } },
  { name: 'insights', script: 'batch:ml-insights' },
  { name: 'similarity', script: 'batch:ml-similarity-evaluate' },
  {
    name: 'rl_policy_full',
    script: 'batch:ml-rl-policy',
    env: { ML_RL_HORIZONS: horizons, ML_RL_RECENT_DAYS: '0', ML_RL_START_DATE: fullStartDate },
  },
  { name: 'feature_health', script: 'batch:ml-feature-health' },
  { name: 'accuracy_health', script: 'batch:ml-accuracy-health' },
]

function installSignalHandlers(): void {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      console.warn(`JP calendar-stage refresh received ${signal}`)
      activeChild?.kill(signal)
    })
  }
}

async function sourceDate(): Promise<string> {
  const row = await execGet<{ date: string | null }>('SELECT MAX(date) AS date FROM ohlcv_daily')
  if (!row?.date) throw new Error('ohlcv_daily is empty')
  const requested = process.env.ML_REFRESH_SOURCE_DATE?.trim()
  if (!requested) return row.date
  if (!/^\d{4}-\d{2}-\d{2}$/.test(requested)) {
    throw new Error(`invalid ML_REFRESH_SOURCE_DATE: ${requested}`)
  }
  if (requested > row.date) {
    throw new Error(`ML_REFRESH_SOURCE_DATE is newer than OHLCV: requested=${requested}, latest=${row.date}`)
  }
  return requested
}

async function isComplete(phase: string, date: string): Promise<boolean> {
  const row = await execGet<{ date: string | null }>(
    'SELECT last_processed_date AS date FROM compute_state WHERE job_type = ? AND ticker = ?',
    [checkpointJob, phase],
  )
  return row?.date === date
}

async function markComplete(phase: string, date: string): Promise<void> {
  await execRun(
    `INSERT INTO compute_state(job_type, ticker, last_processed_date, updated_at)
     VALUES (?, ?, ?, unixepoch())
     ON CONFLICT(job_type, ticker) DO UPDATE SET
       last_processed_date = excluded.last_processed_date,
       updated_at = unixepoch()`,
    [checkpointJob, phase, date],
  )
}

async function runPhase(phase: Phase): Promise<void> {
  await waitForMemoryHeadroom({ label: `JP calendar-stage refresh ${phase.name}` })
  await new Promise<void>((resolve, reject) => {
    activeChild = spawn('npm', ['run', phase.script], {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: withMemoryGuardEnv({
        ...process.env,
        USE_LOCAL_DB: '1',
        ...phase.env,
      }),
    })
    activeChild.on('error', reject)
    activeChild.on('close', (code, signal) => {
      activeChild = null
      if (code === 0) resolve()
      else reject(new Error(`${phase.name} failed: code=${code}, signal=${signal ?? 'none'}`))
    })
  })
}

async function runStageFeaturesChunked(phase: Phase, date: string): Promise<void> {
  const rows = await execAll<{ ticker: string }>(
    'SELECT ticker FROM ohlcv_daily GROUP BY ticker ORDER BY ticker',
  )
  const tickers = rows.map((row) => row.ticker)
  console.log(
    `JP calendar-stage ML refresh: ${phase.name} chunked tickers=${tickers.length}, batch=${featureTickerBatchSize}`,
  )
  for (let offset = 0; offset < tickers.length; offset += featureTickerBatchSize) {
    const chunk = tickers.slice(offset, offset + featureTickerBatchSize)
    const start = chunk[0]
    const end = chunk[chunk.length - 1]
    const checkpoint = `${phase.name}:${start}:${end}`
    if (await isComplete(checkpoint, date)) {
      console.log(`JP calendar-stage ML refresh: skip ${checkpoint}`)
      continue
    }
    console.log(
      `JP calendar-stage ML refresh: ${phase.name} ${offset + 1}-${offset + chunk.length}/${tickers.length} (${start}..${end})`,
    )
    await runPhase({
      ...phase,
      env: {
        ...phase.env,
        ML_TICKER_START: start,
        ML_TICKER_END: end,
        ML_FEATURE_INCREMENTAL_UPSERT: '1',
      },
    })
    await markComplete(checkpoint, date)
  }
}

async function physicsRangeCoverage(
  start: string,
  end: string,
  date: string,
): Promise<{ expected: number; actual: number }> {
  const row = await execGet<{ expected: number; actual: number }>(
    `SELECT
       (SELECT COUNT(*)
        FROM ohlcv_daily o
        WHERE o.ticker >= ? AND o.ticker <= ? AND o.date >= ? AND o.date <= ?) AS expected,
       (SELECT COUNT(*)
        FROM ml_feature_vectors_v2 f
        WHERE f.ticker >= ? AND f.ticker <= ?
          AND f.date >= ? AND f.date <= ? AND f.feature_set = ?) AS actual`,
    [
      start,
      end,
      fullStartDate,
      date,
      start,
      end,
      fullStartDate,
      date,
      ML_PHYSICS_FEATURE_SET,
    ],
  )
  return { expected: Number(row?.expected ?? 0), actual: Number(row?.actual ?? 0) }
}

async function runPhysicsFeaturesChunked(phase: Phase, date: string): Promise<void> {
  const rows = await execAll<{ ticker: string }>(
    'SELECT ticker FROM ohlcv_daily GROUP BY ticker ORDER BY ticker',
  )
  const tickers = rows.map((row) => row.ticker)
  console.log(
    `JP calendar-stage ML refresh: ${phase.name} chunked tickers=${tickers.length}, batch=${physicsTickerBatchSize}`,
  )
  for (let offset = 0; offset < tickers.length; offset += physicsTickerBatchSize) {
    const chunk = tickers.slice(offset, offset + physicsTickerBatchSize)
    const start = chunk[0]
    const end = chunk[chunk.length - 1]
    const checkpoint = `${phase.name}:${start}:${end}`
    if (await isComplete(checkpoint, date)) {
      console.log(`JP calendar-stage ML refresh: skip ${checkpoint}`)
      continue
    }

    const before = await physicsRangeCoverage(start, end, date)
    console.log(
      `JP calendar-stage ML refresh: ${phase.name} ${offset + 1}-${offset + chunk.length}/${tickers.length} (${start}..${end}) rows=${before.actual.toLocaleString()}/${before.expected.toLocaleString()}`,
    )
    await runPhase({
      ...phase,
      env: {
        ...phase.env,
        ML_PHYSICS_TICKER_START: start,
        ML_PHYSICS_TICKER_END: end,
        ML_PHYSICS_END_DATE: date,
        ML_PHYSICS_INCREMENTAL_UPSERT: '0',
      },
    })
    const after = await physicsRangeCoverage(start, end, date)
    if (after.expected <= 0 || after.actual !== after.expected) {
      throw new Error(
        `${checkpoint} coverage mismatch: actual=${after.actual}, expected=${after.expected}`,
      )
    }
    await markComplete(checkpoint, date)
  }
}

async function runModelHorizonsChunked(
  phase: Phase,
  date: string,
  horizonEnv: 'ML_HORIZONS' | 'ML_PHYSICS_HORIZONS',
  versionEnv: 'ML_MODEL_VERSION' | 'ML_PHYSICS_MODEL_VERSION',
): Promise<void> {
  const modelVersion = `${date.replaceAll('-', '')}_${ML_PIPELINE_GENERATION_VERSION.replace(/[^a-zA-Z0-9_]/g, '_')}`
  const horizonGroups = horizonEnv === 'ML_HORIZONS'
    ? [['5', '10', '20'], ['40', '60'], ['90', '200']]
    : [horizons.split(',')]
  for (const horizonGroup of horizonGroups) {
    const groupValue = horizonGroup.join(',')
    const checkpoint = `${phase.name}:h${horizonGroup.join('_')}`
    if (await isComplete(checkpoint, date)) {
      console.log(`JP calendar-stage ML refresh: skip ${checkpoint}`)
      continue
    }
    console.log(`JP calendar-stage ML refresh: ${phase.name} horizons=${groupValue}`)
    await runPhase({
      ...phase,
      env: {
        ...phase.env,
        [horizonEnv]: groupValue,
        [versionEnv]: modelVersion,
      },
    })
    await markComplete(checkpoint, date)
  }
}

async function main(): Promise<void> {
  installSignalHandlers()
  const date = await sourceDate()
  console.log(`JP calendar-stage ML refresh: version=${ML_PIPELINE_GENERATION_VERSION}, sourceDate=${date}`)
  for (const phase of phases) {
    if (await isComplete(phase.name, date)) {
      console.log(`JP calendar-stage ML refresh: skip completed phase ${phase.name}`)
      continue
    }
    console.log(`\nJP calendar-stage ML refresh: phase ${phase.name}`)
    if (phase.name === 'stage_features_full') await runStageFeaturesChunked(phase, date)
    else if (phase.name === 'physics_features_full') await runPhysicsFeaturesChunked(phase, date)
    else if (phase.name === 'normal_models_full') {
      await runModelHorizonsChunked(phase, date, 'ML_HORIZONS', 'ML_MODEL_VERSION')
    } else if (phase.name === 'physics_models_full') {
      await runModelHorizonsChunked(phase, date, 'ML_PHYSICS_HORIZONS', 'ML_PHYSICS_MODEL_VERSION')
    } else await runPhase(phase)
    await markComplete(phase.name, date)
  }
  console.log('JP calendar-stage ML refresh complete')
}

main().catch((error) => {
  console.error('JP calendar-stage ML refresh failed:', error)
  process.exit(1)
})
