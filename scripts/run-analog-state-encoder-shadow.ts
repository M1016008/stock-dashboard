import { createClient } from '@libsql/client'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveAnalogSequenceIndexPath, readAnalogSequenceIndexMeta } from '@/lib/db/analog-sequence-index'
import { localDbPath } from '@/lib/db/client'
import { resolveUsAnalyticsDbPath } from '@/lib/db/us-analytics'
import { waitForMemoryHeadroom, withMemoryGuardEnv } from '@/lib/system/memory-guard'
import { US_ADJUSTED_PRICE_BASIS } from '@/lib/us-adjusted-ohlcv'

type Market = 'JP' | 'US'

const PROJECT_VENV_PYTHON = path.join(process.cwd(), '.venv-analog-encoder', 'bin', 'python3')
const TRAINER_PATH = path.join(process.cwd(), 'scripts', 'train-analog-state-encoder.py')
let ownedLock: string | null = null

function marketFromArgs(): Market {
  return process.argv[2]?.trim().toUpperCase() === 'US' ? 'US' : 'JP'
}

function integerEnv(key: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(process.env[key])
  return Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, Math.floor(value)))
    : fallback
}

function numberEnv(key: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(process.env[key])
  return Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback
}

function sourceDbPath(market: Market): string {
  if (market === 'US') {
    return path.resolve(process.env.US_ANALYTICS_DB_PATH?.trim() || resolveUsAnalyticsDbPath())
  }
  return path.resolve(
    process.env.STOCKBOARD_DB_PATH?.trim()
      || process.env.LOCAL_DB_PATH?.trim()
      || localDbPath,
  )
}

function outputDirectory(market: Market, sourceDb: string): string {
  const configured = process.env.ANALOG_ENCODER_SHADOW_DIR?.trim()
  return configured
    ? path.resolve(configured, market.toLowerCase())
    : path.join(path.dirname(sourceDb), 'analog-encoder-shadow', market.toLowerCase())
}

function pidIsActive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function releaseLock(): void {
  if (!ownedLock) return
  try {
    const owner = Number(fs.readFileSync(ownedLock, 'utf8').trim())
    if (owner === process.pid) fs.unlinkSync(ownedLock)
  } catch {
    // A missing or replaced lock no longer belongs to this process.
  }
  ownedLock = null
}

function acquireLock(directory: string, market: Market): boolean {
  fs.mkdirSync(directory, { recursive: true })
  const lockPath = path.join(directory, `.${market.toLowerCase()}-shadow-training.lock`)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = fs.openSync(lockPath, 'wx', 0o600)
      fs.writeFileSync(handle, `${process.pid}\n`)
      fs.closeSync(handle)
      ownedLock = lockPath
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
      const owner = Number(fs.readFileSync(lockPath, 'utf8').trim())
      if (pidIsActive(owner)) {
        console.log(`Analog encoder shadow training is already active for ${market} (pid=${owner}).`)
        return false
      }
      fs.unlinkSync(lockPath)
    }
  }
  return false
}

async function scalarText(dbPath: string, sql: string, args: string[] = []): Promise<string | null> {
  const client = createClient({ url: `file:${dbPath}` })
  try {
    await client.execute('PRAGMA query_only=ON')
    await client.execute('PRAGMA busy_timeout=60000')
    const result = await client.execute({ sql, args })
    const value = result.rows[0]?.value
    return value == null ? null : String(value)
  } finally {
    client.close()
  }
}

async function sourceDate(dbPath: string): Promise<string | null> {
  return scalarText(dbPath, 'SELECT MAX(date) AS value FROM ohlcv_daily')
}

async function usFoundationReady(dbPath: string): Promise<boolean> {
  const table = await scalarText(
    dbPath,
    `
      SELECT name AS value
      FROM sqlite_master
      WHERE type = 'table' AND name = 'us_analytics_metadata'
      LIMIT 1
    `,
  )
  if (!table) return false
  const values = await Promise.all(
    ['ohlcv_price_basis', 'derived_price_basis', 'analog_index_price_basis'].map((key) =>
      scalarText(
        dbPath,
        'SELECT value FROM us_analytics_metadata WHERE key = ? LIMIT 1',
        [key],
      ),
    ),
  )
  return values.every((value) => value === US_ADJUSTED_PRICE_BASIS)
}

async function assertReady(market: Market, sourceDb: string, indexDb: string): Promise<string | null> {
  if (!fs.existsSync(sourceDb)) throw new Error(`${market} source DB not found: ${sourceDb}`)
  if (!fs.existsSync(indexDb)) throw new Error(`${market} analog index not found: ${indexDb}`)
  const [currentSourceDate, indexMeta] = await Promise.all([
    sourceDate(sourceDb),
    readAnalogSequenceIndexMeta(market),
  ])
  if (market === 'US' && !await usFoundationReady(sourceDb)) {
    console.log(
      'US adjusted foundation is not promoted yet; analog encoder shadow training remains deferred.',
    )
    return null
  }
  if (
    !currentSourceDate
    || !indexMeta?.completed
    || indexMeta.sourceDate !== currentSourceDate
  ) {
    console.log(
      `${market} analog index is not current; shadow training deferred: `
      + `source=${currentSourceDate ?? '-'} index=${indexMeta?.sourceDate ?? '-'} `
      + `completed=${indexMeta?.completed ?? false}`,
    )
    return null
  }
  return currentSourceDate
}

function pythonCommand(): string {
  const configured = process.env.ANALOG_ENCODER_PYTHON?.trim()
  if (configured) return path.resolve(configured)
  if (fs.existsSync(PROJECT_VENV_PYTHON)) return PROJECT_VENV_PYTHON
  throw new Error(
    'Analog encoder Python environment is missing. Run `npm run setup:analog-encoder` first.',
  )
}

async function runPython(args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const python = pythonCommand()
  const command = process.platform === 'darwin' && fs.existsSync('/usr/bin/taskpolicy')
    ? '/usr/bin/taskpolicy'
    : '/usr/bin/nice'
  const commandArgs = command.endsWith('taskpolicy')
    ? ['-b', '/usr/bin/nice', '-n', '15', python, ...args]
    : ['-n', '15', python, ...args]
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: process.cwd(),
      stdio: 'inherit',
      env,
    })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(
        `analog encoder Python failed: code=${code ?? 'null'} signal=${signal ?? 'none'}`,
      ))
    })
  })
}

async function main(): Promise<void> {
  const market = marketFromArgs()
  const sourceDb = sourceDbPath(market)
  const indexDb = resolveAnalogSequenceIndexPath(market)
  const outputDir = outputDirectory(market, sourceDb)
  const readyDate = await assertReady(market, sourceDb, indexDb)
  if (!readyDate) {
    process.exitCode = 75
    return
  }
  if (!acquireLock(outputDir, market)) return
  await waitForMemoryHeadroom({
    label: `${market} analog encoder shadow`,
    minFreePercent: integerEnv('ANALOG_ENCODER_MIN_FREE_PERCENT', 35, 20, 80),
    minAvailableMb: integerEnv('ANALOG_ENCODER_MIN_FREE_MB', 5_000, 2_048, 12_000),
  })
  const maxSamples = integerEnv(
    'ANALOG_ENCODER_MAX_SAMPLES',
    market === 'US' ? 240_000 : 180_000,
    5_000,
    500_000,
  )
  const workerThreads = integerEnv('ANALOG_ENCODER_NUM_THREADS', 2, 1, 4)
  const args = [
    TRAINER_PATH,
    '--market', market,
    '--source-db', sourceDb,
    '--index-db', indexDb,
    '--output-dir', outputDir,
    '--shadow-db', path.join(outputDir, `analog-encoder-shadow-${market.toLowerCase()}.db`),
    '--max-samples', String(maxSamples),
    '--samples-per-ticker', String(integerEnv('ANALOG_ENCODER_SAMPLES_PER_TICKER', 64, 8, 256)),
    '--epochs', String(integerEnv('ANALOG_ENCODER_EPOCHS', 24, 4, 80)),
    '--batch-size', String(integerEnv('ANALOG_ENCODER_BATCH_SIZE', 192, 32, 512)),
    '--learning-rate', String(numberEnv('ANALOG_ENCODER_LEARNING_RATE', 0.002, 0.0001, 0.02)),
    '--lightgbm-train-queries', String(integerEnv(
      'ANALOG_ENCODER_LIGHTGBM_TRAIN_QUERIES',
      market === 'US' ? 2_200 : 1_800,
      200,
      5_000,
    )),
    '--lightgbm-validation-queries', String(integerEnv(
      'ANALOG_ENCODER_LIGHTGBM_VALIDATION_QUERIES',
      400,
      100,
      1_500,
    )),
    '--lightgbm-candidates-per-query', String(integerEnv(
      'ANALOG_ENCODER_LIGHTGBM_CANDIDATES',
      96,
      24,
      256,
    )),
    '--lightgbm-estimators', String(integerEnv(
      'ANALOG_ENCODER_LIGHTGBM_ESTIMATORS',
      300,
      50,
      800,
    )),
    '--lightgbm-learning-rate', String(numberEnv(
      'ANALOG_ENCODER_LIGHTGBM_LEARNING_RATE',
      0.05,
      0.005,
      0.2,
    )),
    '--lightgbm-num-leaves', String(integerEnv(
      'ANALOG_ENCODER_LIGHTGBM_NUM_LEAVES',
      31,
      7,
      127,
    )),
    '--lightgbm-minimum-data-in-leaf', String(integerEnv(
      'ANALOG_ENCODER_LIGHTGBM_MIN_DATA_IN_LEAF',
      40,
      10,
      500,
    )),
    '--lightgbm-threads', String(workerThreads),
    '--reference-limit', String(integerEnv('ANALOG_ENCODER_REFERENCE_LIMIT', 30_000, 2_000, 80_000)),
    '--query-limit', String(integerEnv('ANALOG_ENCODER_QUERY_LIMIT', 1_200, 200, 5_000)),
    '--top-k', String(integerEnv('ANALOG_ENCODER_TOP_K', 10, 3, 50)),
    '--purge-days', String(integerEnv('ANALOG_ENCODER_PURGE_DAYS', 300, 200, 500)),
    '--minimum-queries', String(integerEnv('ANALOG_ENCODER_MIN_QUERIES', 500, 100, 3_000)),
    '--minimum-mae-improvement', String(numberEnv('ANALOG_ENCODER_MIN_MAE_IMPROVEMENT', 0.03, 0, 0.25)),
    '--minimum-direction-improvement', String(numberEnv('ANALOG_ENCODER_MIN_DIRECTION_IMPROVEMENT', 0.01, 0, 0.2)),
    '--seed', String(integerEnv('ANALOG_ENCODER_SEED', 42, 1, 1_000_000)),
  ]
  console.log(JSON.stringify({
    market,
    mode: 'shadow',
    sourceDate: readyDate,
    sourceDb,
    indexDb,
    outputDir,
    productionRankingChanged: false,
    hostMemoryGb: Number((os.totalmem() / 1_073_741_824).toFixed(1)),
    maxSamples,
    benchmark: 'euclidean + LightGBM LambdaRank',
    promotionRule: 'encoder must beat both baselines',
    workerThreads,
  }, null, 2))
  try {
    await runPython(
      args,
      withMemoryGuardEnv({
        ...process.env,
        ANALOG_ENCODER_MARKET: market,
        ANALOG_ENCODER_MODE: 'shadow',
        OPENBLAS_NUM_THREADS: String(workerThreads),
        VECLIB_MAXIMUM_THREADS: String(workerThreads),
        OMP_NUM_THREADS: String(workerThreads),
        NUMEXPR_NUM_THREADS: String(workerThreads),
      }),
    )
  } finally {
    releaseLock()
  }
}

main().catch((error) => {
  releaseLock()
  console.error('[analog-encoder-shadow] failed:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
