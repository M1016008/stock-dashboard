import { createClient } from '@libsql/client'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  resolveMaTrajectoryArtifactDirectory,
  resolveMaTrajectoryShadowDbPath,
  resolveMaTrajectorySourceDbPath,
} from '@/lib/ma-trajectory/paths'
import {
  getActiveUpdateLocks,
  JP_STOCKBOARD_UPDATE_JOB_TYPES,
  US_ISOLATED_UPDATE_JOB_TYPES,
} from '@/lib/server/update-lock'
import { waitForMemoryHeadroom, withMemoryGuardEnv } from '@/lib/system/memory-guard'
import { US_ADJUSTED_PRICE_BASIS } from '@/lib/us-adjusted-ohlcv'
import {
  MA_TRAJECTORY_FEATURE_VERSION,
  MA_TRAJECTORY_MODEL_VERSION,
} from '@/lib/ma-trajectory/core'

type Market = 'JP' | 'US'
type RunMode = 'train' | 'predict' | 'auto'

const PYTHON = path.join(process.cwd(), '.venv-analog-encoder', 'bin', 'python3')
const TRAINER = path.join(process.cwd(), 'scripts', 'train-ma-trajectory-shadow.py')
let ownedLock: string | null = null

class DeferredExecutionError extends Error {}

function marketFromArgs(): Market {
  return process.argv[2]?.trim().toUpperCase() === 'US' ? 'US' : 'JP'
}

function modeFromArgs(): RunMode {
  const configured = process.argv[3]?.trim().toLowerCase() || process.env.MA_TRAJECTORY_MODE?.trim().toLowerCase()
  if (configured === 'predict' || configured === 'auto') return configured
  return 'train'
}

function integerEnv(key: string, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(process.env[key])
  return Number.isFinite(parsed)
    ? Math.min(maximum, Math.max(minimum, Math.floor(parsed)))
    : fallback
}

function releaseLock(): void {
  if (!ownedLock) return
  try {
    if (Number(fs.readFileSync(ownedLock, 'utf8').trim()) === process.pid) fs.unlinkSync(ownedLock)
  } catch {
    // A missing or replaced lock is no longer owned by this process.
  }
  ownedLock = null
}

function acquireLock(directory: string, market: Market): boolean {
  fs.mkdirSync(directory, { recursive: true })
  const lock = path.join(directory, `.${market.toLowerCase()}-ma-trajectory.lock`)
  try {
    const handle = fs.openSync(lock, 'wx', 0o600)
    fs.writeFileSync(handle, `${process.pid}\n`)
    fs.closeSync(handle)
    ownedLock = lock
    process.once('exit', releaseLock)
    process.once('SIGINT', () => {
      releaseLock()
      process.exit(130)
    })
    process.once('SIGTERM', () => {
      releaseLock()
      process.exit(143)
    })
    return true
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error
    const owner = Number(fs.readFileSync(lock, 'utf8').trim())
    try {
      process.kill(owner, 0)
      console.log(`MA trajectory shadow is already active for ${market} (pid=${owner}).`)
      return false
    } catch {
      fs.unlinkSync(lock)
      return acquireLock(directory, market)
    }
  }
}

async function scalar(dbPath: string, sql: string, args: string[] = []): Promise<string | null> {
  const client = createClient({ url: `file:${dbPath}` })
  try {
    await client.execute('PRAGMA query_only=ON')
    await client.execute('PRAGMA busy_timeout=30000')
    const result = await client.execute({ sql, args })
    const value = result.rows[0]?.value
    return value == null ? null : String(value)
  } finally {
    client.close()
  }
}

async function alreadyComplete(shadowDb: string, market: Market, sourceDate: string): Promise<boolean> {
  if (!fs.existsSync(shadowDb)) return false
  const report = await scalar(
    shadowDb,
    `SELECT report_json AS value FROM ma_trajectory_runs
     WHERE market=? AND model_version=? AND feature_version=? AND source_date=? LIMIT 1`,
    [market, MA_TRAJECTORY_MODEL_VERSION, MA_TRAJECTORY_FEATURE_VERSION, sourceDate],
  )
  if (!report) return false
  try {
    return Boolean(JSON.parse(report)?.metrics?.methods?.lightgbm_lambdarank)
  } catch {
    return false
  }
}

async function hasEligibleModel(shadowDb: string, market: Market): Promise<boolean> {
  if (!fs.existsSync(shadowDb)) return false
  try {
    return await scalar(
      shadowDb,
      `SELECT COUNT(*) AS value FROM ma_trajectory_runs
       WHERE market=? AND model_version=? AND feature_version=? AND promotion_eligible=1`,
      [market, MA_TRAJECTORY_MODEL_VERSION, MA_TRAJECTORY_FEATURE_VERSION],
    ) !== '0'
  } catch {
    return false
  }
}

async function usAdjustedFoundationReady(sourceDb: string): Promise<boolean> {
  const table = await scalar(
    sourceDb,
    `SELECT name AS value FROM sqlite_master
     WHERE type='table' AND name='us_analytics_metadata' LIMIT 1`,
  )
  if (!table) return false
  const values = await Promise.all(
    ['ohlcv_price_basis', 'derived_price_basis', 'analog_index_price_basis'].map((key) =>
      scalar(sourceDb, 'SELECT value FROM us_analytics_metadata WHERE key=? LIMIT 1', [key]),
    ),
  )
  return values.every((value) => value === US_ADJUSTED_PRICE_BASIS)
}

async function runPython(args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const command = process.platform === 'darwin' && fs.existsSync('/usr/bin/taskpolicy')
    ? '/usr/bin/taskpolicy'
    : '/usr/bin/nice'
  const commandArgs = command.endsWith('taskpolicy')
    ? ['-b', '/usr/bin/nice', '-n', '15', PYTHON, ...args]
    : ['-n', '15', PYTHON, ...args]
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, commandArgs, { cwd: process.cwd(), env, stdio: 'inherit' })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) resolve()
      else if (code === 75) reject(new DeferredExecutionError('MA trajectory safely deferred by the runtime guard.'))
      else reject(new Error(`MA trajectory Python failed: code=${code ?? 'null'} signal=${signal ?? 'none'}`))
    })
  })
}

async function main(): Promise<void> {
  const market = marketFromArgs()
  let mode = modeFromArgs()
  if (market === 'US' && process.env.MA_TRAJECTORY_US_ENABLED !== '1') {
    console.log('US MA trajectory remains disabled until JP promotion (set MA_TRAJECTORY_US_ENABLED=1 after approval).')
    process.exitCode = 75
    return
  }
  if (!fs.existsSync(PYTHON)) throw new Error('Run `npm run setup:analog-encoder` before MA trajectory training.')
  if (!fs.existsSync(TRAINER)) throw new Error(`Trainer not found: ${TRAINER}`)

  const sourceDb = resolveMaTrajectorySourceDbPath(market)
  if (!fs.existsSync(sourceDb)) throw new Error(`${market} source DB not found: ${sourceDb}`)
  if (market === 'US' && !await usAdjustedFoundationReady(sourceDb)) {
    console.log('US MA trajectory deferred: adjusted OHLCV, derived, and analog price bases are not aligned.')
    process.exitCode = 75
    return
  }
  const sourceDate = await scalar(sourceDb, 'SELECT MAX(date) AS value FROM ohlcv_daily')
  if (!sourceDate) throw new Error(`${market} OHLCV source date is unavailable.`)
  const shadowDb = resolveMaTrajectoryShadowDbPath(market)
  if (mode === 'auto') {
    mode = await hasEligibleModel(shadowDb, market) ? 'predict' : 'train'
    console.log(`${market} MA trajectory automatic refresh selected mode=${mode}.`)
  }
  if (process.env.MA_TRAJECTORY_FORCE !== '1' && await alreadyComplete(shadowDb, market, sourceDate)) {
    console.log(`MA trajectory shadow already complete: market=${market} source_date=${sourceDate}`)
    return
  }
  if (mode === 'predict' && !await hasEligibleModel(shadowDb, market)) {
    console.log(`${market} MA trajectory daily prediction deferred: no promoted shadow model is available.`)
    process.exitCode = 75
    return
  }

  const jobTypes = market === 'US' ? US_ISOLATED_UPDATE_JOB_TYPES : JP_STOCKBOARD_UPDATE_JOB_TYPES
  const activeLocks = await getActiveUpdateLocks(jobTypes)
  if (activeLocks.length > 0) {
    console.log(`MA trajectory deferred while ${market} writers are active: ${activeLocks.map((lock) => lock.jobType).join(', ')}`)
    process.exitCode = 75
    return
  }

  const artifactDir = resolveMaTrajectoryArtifactDirectory(market)
  if (!acquireLock(path.dirname(shadowDb), market)) return
  const workerThreads = integerEnv('MA_TRAJECTORY_NUM_THREADS', 2, 1, 4)
  const trainingProfile = process.env.MA_TRAJECTORY_TRAINING_PROFILE?.trim().toLowerCase() === 'balanced'
    ? 'balanced'
    : 'accuracy'
  const accuracyProfile = mode === 'train' && trainingProfile === 'accuracy'
  const maxTickers = integerEnv('MA_TRAJECTORY_MAX_TICKERS', 0, 0, 20_000)
  const defaultMaxSamples = accuracyProfile
    ? (market === 'US' ? 220_000 : 180_000)
    : (market === 'US' ? 180_000 : 140_000)
  const maxSamples = integerEnv('MA_TRAJECTORY_MAX_SAMPLES', defaultMaxSamples, 5_000, 500_000)
  const boundedPilot = maxTickers > 0 && maxTickers <= 300 && maxSamples <= 10_000
  const defaultMinAvailableMb = boundedPilot ? 1_200 : 4_096
  const minimumMinAvailableMb = boundedPilot ? 1_024 : 2_048
  const env = withMemoryGuardEnv({
    ...process.env,
    OPENBLAS_NUM_THREADS: String(workerThreads),
    VECLIB_MAXIMUM_THREADS: String(workerThreads),
    OMP_NUM_THREADS: String(workerThreads),
    NUMEXPR_NUM_THREADS: String(workerThreads),
  })
  try {
    await waitForMemoryHeadroom({
      label: `${market} MA trajectory shadow`,
      minFreePercent: integerEnv('MA_TRAJECTORY_MIN_FREE_PERCENT', 35, 20, 80),
      minAvailableMb: integerEnv('MA_TRAJECTORY_MIN_FREE_MB', defaultMinAvailableMb, minimumMinAvailableMb, 16_000),
    })
    const locksAfterMemoryWait = await getActiveUpdateLocks(jobTypes)
    if (locksAfterMemoryWait.length > 0) {
      console.log(`MA trajectory safely deferred after memory wait while ${market} writers are active: ${locksAfterMemoryWait.map((lock) => lock.jobType).join(', ')}`)
      process.exitCode = 75
      return
    }
    console.log(JSON.stringify({
      market,
      mode,
      sourceDate,
      sourceDb,
      shadowDb,
      artifactDir,
      hostMemoryGb: Number((os.totalmem() / 1_073_741_824).toFixed(1)),
      workerThreads,
      trainingProfile,
      maxTickers,
      maxSamples,
      memoryGuardTier: boundedPilot ? 'bounded_pilot' : 'full_training',
      productionChanged: false,
      comparison: ['weighted_distance', 'lightgbm_lambdarank', 'deep_state_encoder'],
    }, null, 2))
    await runPython(['-c', 'import lightgbm, numpy; print("MA trajectory Python import self-test passed")'], env)
    await runPython([
      TRAINER,
      market,
      '--source-db', sourceDb,
      '--shadow-db', shadowDb,
      '--artifact-dir', artifactDir,
      '--max-tickers', String(maxTickers),
      '--max-samples', String(maxSamples),
      '--samples-per-ticker', String(integerEnv('MA_TRAJECTORY_SAMPLES_PER_TICKER', accuracyProfile ? 90 : 60, 12, 240)),
      '--prediction-tickers', String(integerEnv('MA_TRAJECTORY_PREDICTION_TICKERS', 0, 0, 20_000)),
      '--epochs', String(integerEnv('MA_TRAJECTORY_EPOCHS', accuracyProfile ? 48 : 28, 4, 80)),
      '--encoder-patience', String(integerEnv('MA_TRAJECTORY_ENCODER_PATIENCE', accuracyProfile ? 8 : 5, 3, 16)),
      '--top-k', String(integerEnv('MA_TRAJECTORY_TOP_K', accuracyProfile ? 32 : 24, 8, 64)),
      '--bandit-candidates', String(integerEnv('MA_TRAJECTORY_BANDIT_CANDIDATES', accuracyProfile ? 96 : 64, 16, 192)),
      '--bandit-queries', String(integerEnv('MA_TRAJECTORY_BANDIT_QUERIES', accuracyProfile ? 2_400 : 1_200, 80, 10_000)),
      '--ranker-train-queries', String(integerEnv('MA_TRAJECTORY_RANKER_TRAIN_QUERIES', accuracyProfile ? 900 : 500, 40, 4_000)),
      '--ranker-validation-queries', String(integerEnv('MA_TRAJECTORY_RANKER_VALIDATION_QUERIES', accuracyProfile ? 240 : 120, 20, 1_000)),
      '--ranker-candidates', String(integerEnv('MA_TRAJECTORY_RANKER_CANDIDATES', accuracyProfile ? 96 : 64, 16, 192)),
      '--ranker-rounds', String(integerEnv('MA_TRAJECTORY_RANKER_ROUNDS', accuracyProfile ? 420 : 240, 40, 1_000)),
      '--ranker-early-stopping', String(integerEnv('MA_TRAJECTORY_RANKER_EARLY_STOPPING', accuracyProfile ? 40 : 25, 8, 100)),
      '--num-threads', String(workerThreads),
      '--purge-days', '300',
      ...(process.env.MA_TRAJECTORY_FORCE === '1' ? ['--force'] : []),
      ...(process.env.MA_TRAJECTORY_WRITE_REJECTED === '1' ? ['--write-rejected-predictions'] : []),
      ...(mode === 'predict' ? ['--predict-only'] : []),
    ], env)
  } finally {
    releaseLock()
  }
}

main().catch((error) => {
  releaseLock()
  if (error instanceof DeferredExecutionError) {
    console.warn(`[ma-trajectory-shadow] ${error.message}`)
    process.exitCode = 75
    return
  }
  console.error('[ma-trajectory-shadow] failed:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
