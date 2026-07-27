// scripts/run-us-physical-momentum-full.ts
//
// Full-history US PMS can be too large for one Node process.  Run raw metric
// generation by ticker chunks, then run cross-sectional normalization by date
// chunks.  Each child uses UPSERTs, so retries are safe and do not delete
// existing serving data first.

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClient } from '@libsql/client'
import { waitForMemoryHeadroom, withMemoryGuardEnv } from '@/lib/system/memory-guard'

const DEFAULT_US_ANALYTICS_DB = '/Volumes/OWC Express 1M2 80G/stockboard-data/us/stockboard-us.db'
type Mode = 'full' | 'raw' | 'normalize'

const TICKER_CHUNK = Math.max(1, Number(process.env.US_PMS_TICKER_CHUNK ?? 250))
const DATE_CHUNK = Math.max(1, Number(process.env.US_PMS_DATE_CHUNK ?? 50))
const TICKER_START_OFFSET = Math.max(0, Number(process.env.US_PMS_TICKER_START_OFFSET ?? 0))
const DATE_START_OFFSET = Math.max(0, Number(process.env.US_PMS_DATE_START_OFFSET ?? 0))
const RECENT_DAYS = Math.max(
  0,
  Number(process.env.US_PMS_RECENT_DAYS ?? process.env.US_PMS_DAILY_RECENT_DAYS ?? process.env.PMS_RECENT_DAYS ?? 0),
)

type CountRow = { count: number }
type ValueRow = { value: string | null }
type DbProfile = {
  tickers: number
  dates: number
  latestDate: string | null
  priceBasis: string | null
}
type CheckpointState = {
  version: 1
  inputKey: string
  dbPath: string
  recentDays: number
  latestDate: string | null
  priceBasis: string | null
  nextTickerOffset: number
  nextDateOffset: number
  rawComplete: boolean
  normalizeComplete: boolean
  updatedAt: string
}

const CHECKPOINT_VERSION = 1 as const

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function numberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function dbPath(): string {
  return process.env.US_ANALYTICS_DB_PATH?.trim()
    || DEFAULT_US_ANALYTICS_DB
}

function checkpointEnabled(): boolean {
  return process.env.US_PMS_CHECKPOINT_ENABLED !== '0'
}

function explicitOffset(name: string, fallback: number): number | null {
  if (process.env[name] == null || process.env[name]?.trim() === '') return null
  const value = Number(process.env[name])
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback
}

function modeFromArg(value: string | undefined): Mode {
  if (value === undefined || value === 'full') return 'full'
  if (value === 'raw' || value === 'normalize') return value
  throw new Error('Usage: tsx scripts/run-us-physical-momentum-full.ts [full|raw|normalize]')
}

async function usDbProfile(dbFile: string): Promise<DbProfile> {
  const client = createClient({ url: `file:${dbFile}` })
  await client.execute('PRAGMA busy_timeout=60000')
  try {
    const tickerRows = RECENT_DAYS > 0
      ? await client.execute({
          sql: `
            SELECT COUNT(DISTINCT ticker) AS count
            FROM ohlcv_daily
            WHERE date >= (
              SELECT MIN(date)
              FROM (
                SELECT DISTINCT date
                FROM ohlcv_daily
                ORDER BY date DESC
                LIMIT ?
              )
            )
          `,
          args: [RECENT_DAYS],
        })
      : await client.execute('SELECT COUNT(DISTINCT ticker) AS count FROM ohlcv_daily')
    const dateRows = RECENT_DAYS > 0
      ? await client.execute({
          sql: `
            SELECT COUNT(*) AS count
            FROM (
              SELECT DISTINCT date
              FROM ohlcv_daily
              ORDER BY date DESC
              LIMIT ?
            )
          `,
          args: [RECENT_DAYS],
        })
      : await client.execute('SELECT COUNT(DISTINCT date) AS count FROM ohlcv_daily')
    const latestRows = await client.execute('SELECT MAX(date) AS value FROM ohlcv_daily')
    let priceBasis: string | null = null
    try {
      const metadataRows = await client.execute(
        `SELECT value FROM us_analytics_metadata WHERE key = 'ohlcv_price_basis' LIMIT 1`,
      )
      priceBasis = String((metadataRows.rows[0] as unknown as ValueRow | undefined)?.value ?? '') || null
    } catch {
      priceBasis = null
    }
    return {
      tickers: Number((tickerRows.rows[0] as unknown as CountRow | undefined)?.count ?? 0),
      dates: Number((dateRows.rows[0] as unknown as CountRow | undefined)?.count ?? 0),
      latestDate: String((latestRows.rows[0] as unknown as ValueRow | undefined)?.value ?? '') || null,
      priceBasis,
    }
  } finally {
    client.close()
  }
}

function implementationFingerprint(): string {
  const sourcePath = path.join(process.cwd(), 'scripts', 'batch-physical-momentum.ts')
  const hash = createHash('sha256')
  hash.update(fs.readFileSync(sourcePath))
  return hash.digest('hex').slice(0, 16)
}

function checkpointInputKey(dbFile: string, profile: DbProfile): string {
  return createHash('sha256')
    .update(JSON.stringify({
      version: CHECKPOINT_VERSION,
      dbPath: path.resolve(dbFile),
      recentDays: RECENT_DAYS,
      latestDate: profile.latestDate,
      priceBasis: profile.priceBasis,
      tickers: profile.tickers,
      dates: profile.dates,
      implementation: implementationFingerprint(),
    }))
    .digest('hex')
}

function checkpointPath(dbFile: string): string {
  const override = process.env.US_PMS_CHECKPOINT_PATH?.trim()
  if (override) return path.resolve(override)
  const id = createHash('sha256')
    .update(`${path.resolve(dbFile)}:${RECENT_DAYS}`)
    .digest('hex')
    .slice(0, 16)
  return path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'StockBoard',
    'checkpoints',
    `us-pms-${id}.json`,
  )
}

function freshCheckpoint(dbFile: string, profile: DbProfile, inputKey: string): CheckpointState {
  return {
    version: CHECKPOINT_VERSION,
    inputKey,
    dbPath: path.resolve(dbFile),
    recentDays: RECENT_DAYS,
    latestDate: profile.latestDate,
    priceBasis: profile.priceBasis,
    nextTickerOffset: 0,
    nextDateOffset: 0,
    rawComplete: false,
    normalizeComplete: false,
    updatedAt: new Date().toISOString(),
  }
}

function readCheckpoint(file: string, initial: CheckpointState): CheckpointState {
  if (!checkpointEnabled() || process.env.US_PMS_RESET_CHECKPOINT === '1') return initial
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as CheckpointState
    return saved.version === CHECKPOINT_VERSION && saved.inputKey === initial.inputKey
      ? saved
      : initial
  } catch {
    return initial
  }
}

function writeCheckpoint(file: string, state: CheckpointState): void {
  if (!checkpointEnabled()) return
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  state.updatedAt = new Date().toISOString()
  const temporaryPath = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temporaryPath, file)
}

function runNpm(script: string, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['run', script], {
      cwd: process.cwd(),
      env: withMemoryGuardEnv(env),
      stdio: 'inherit',
    })
    child.on('error', reject)
    child.on('close', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`npm run ${script} failed: code=${code}, signal=${signal ?? 'none'}`))
    })
  })
}

async function runNpmWithRetry(script: string, env: NodeJS.ProcessEnv): Promise<void> {
  const attempts = numberEnv('US_PMS_STEP_MAX_ATTEMPTS', 3)
  const retryDelaySeconds = numberEnv('US_PMS_STEP_RETRY_DELAY_SECONDS', 300)
  let lastError: unknown = null

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await waitForMemoryHeadroom({ label: `US PMS ${script} attempt ${attempt}` })
      if (attempt > 1) console.log(`US PMS retry ${attempt}/${attempts}: npm run ${script}`)
      await runNpm(script, env)
      return
    } catch (error) {
      lastError = error
      const message = error instanceof Error ? error.message : String(error)
      console.error(`US PMS step failed ${attempt}/${attempts}: ${message}`)
      if (attempt >= attempts) break
      await sleep(retryDelaySeconds * 1000)
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

async function main(): Promise<void> {
  const mode = modeFromArg(process.argv[2])
  const path = dbPath()
  if (!fs.existsSync(path)) throw new Error(`US analytics DB not found: ${path}`)

  await waitForMemoryHeadroom({ label: 'US PMS database profiling' })
  const profile = await usDbProfile(path)
  const { tickers, dates } = profile
  if (tickers <= 0 || dates <= 0) throw new Error(`US OHLCV is empty: tickers=${tickers}, dates=${dates}`)
  const inputKey = checkpointInputKey(path, profile)
  const progressPath = checkpointPath(path)
  const state = readCheckpoint(progressPath, freshCheckpoint(path, profile, inputKey))
  const explicitTickerOffset = explicitOffset('US_PMS_TICKER_START_OFFSET', TICKER_START_OFFSET)
  const explicitDateOffset = explicitOffset('US_PMS_DATE_START_OFFSET', DATE_START_OFFSET)
  const tickerStartOffset = explicitTickerOffset ?? state.nextTickerOffset
  const dateStartOffset = explicitDateOffset ?? state.nextDateOffset

  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    USE_LOCAL_DB: '1',
    STOCKBOARD_DB_PATH: path,
    US_ANALYTICS_DB_PATH: path,
    SQLITE_BUSY_RETRIES: process.env.SQLITE_BUSY_RETRIES ?? '12',
    PMS_RECENT_DAYS: String(RECENT_DAYS),
    PMS_OUTPUT_MARKET: 'US',
    PMS_BATCH_CHUNK: process.env.US_PMS_BATCH_CHUNK ?? process.env.PMS_BATCH_CHUNK ?? '300',
  }

  console.log(`US PMS chunked full: db=${path}`)
  console.log(`US PMS chunked full: mode=${mode}, tickers=${tickers}, dates=${dates}, recentDays=${RECENT_DAYS}, tickerChunk=${TICKER_CHUNK}, dateChunk=${DATE_CHUNK}`)
  console.log(`US PMS checkpoint: enabled=${checkpointEnabled()}, path=${progressPath}, rawOffset=${tickerStartOffset}, dateOffset=${dateStartOffset}`)

  if (mode === 'full' || mode === 'raw') {
    if (state.rawComplete && explicitTickerOffset === null) {
      console.log('US PMS raw phase already complete for this input; resuming at normalization')
    } else {
      for (let offset = tickerStartOffset; offset < tickers; offset += TICKER_CHUNK) {
        await waitForMemoryHeadroom({ label: `US PMS raw chunk offset=${offset}` })
        console.log(`US PMS raw chunk: offset=${offset}, limit=${TICKER_CHUNK}`)
        await runNpmWithRetry('batch:physical-momentum', {
          ...baseEnv,
          PMS_RUN_JOB_TYPE: 'physical_momentum_us_raw_chunk',
          PMS_RAW_ONLY: '1',
          PMS_TICKER_OFFSET: String(offset),
          PMS_TICKER_LIMIT: String(TICKER_CHUNK),
        })
        state.nextTickerOffset = Math.min(tickers, offset + TICKER_CHUNK)
        writeCheckpoint(progressPath, state)
      }
      state.nextTickerOffset = tickers
      state.rawComplete = true
      writeCheckpoint(progressPath, state)
    }
  }

  if (mode === 'full' || mode === 'normalize') {
    if (state.normalizeComplete && explicitDateOffset === null) {
      console.log('US PMS normalization already complete for this input')
    } else {
      for (let offset = dateStartOffset; offset < dates; offset += DATE_CHUNK) {
        await waitForMemoryHeadroom({ label: `US PMS normalize chunk offset=${offset}` })
        console.log(`US PMS normalize chunk: offset=${offset}, limit=${DATE_CHUNK}`)
        await runNpmWithRetry('batch:physical-momentum', {
          ...baseEnv,
          PMS_RUN_JOB_TYPE: 'physical_momentum_us_normalize_chunk',
          PMS_NORMALIZE_ONLY: '1',
          PMS_DATE_OFFSET: String(offset),
          PMS_DATE_LIMIT: String(DATE_CHUNK),
        })
        state.nextDateOffset = Math.min(dates, offset + DATE_CHUNK)
        writeCheckpoint(progressPath, state)
      }
      state.nextDateOffset = dates
      state.normalizeComplete = true
      writeCheckpoint(progressPath, state)
    }
  }

  console.log('US PMS chunked full complete')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
