// scripts/run-jp-physical-momentum-full.ts
//
// Full-history JP PMS can be too large for one Node process. Run raw metric
// generation by ticker chunks, then run cross-sectional normalization by date
// chunks. Each child uses UPSERTs, so retries are safe and do not delete
// existing serving data first.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { createClient } from '@libsql/client'
import { localDbPath } from '@/lib/db/client'

type Mode = 'full' | 'raw' | 'normalize'
type CountRow = { count: number }

const TICKER_CHUNK = Math.max(1, Number(process.env.JP_PMS_TICKER_CHUNK ?? 250))
const DATE_CHUNK = Math.max(1, Number(process.env.JP_PMS_DATE_CHUNK ?? 100))
const TICKER_START_OFFSET = Math.max(0, Number(process.env.JP_PMS_TICKER_START_OFFSET ?? 0))
const DATE_START_OFFSET = Math.max(0, Number(process.env.JP_PMS_DATE_START_OFFSET ?? 0))
const RECENT_DAYS = Math.max(
  0,
  Number(process.env.JP_PMS_RECENT_DAYS ?? process.env.PMS_RECENT_DAYS ?? 0),
)

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function numberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function modeFromArg(value: string | undefined): Mode {
  if (value === undefined || value === 'full') return 'full'
  if (value === 'raw' || value === 'normalize') return value
  throw new Error('Usage: tsx scripts/run-jp-physical-momentum-full.ts [full|raw|normalize]')
}

async function countJpDbRows(path: string): Promise<{ tickers: number; dates: number }> {
  const client = createClient({ url: `file:${path}` })
  await client.execute('PRAGMA busy_timeout=60000')
  const tickerRows = await client.execute('SELECT COUNT(DISTINCT ticker) AS count FROM ohlcv_daily')
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
  return {
    tickers: Number((tickerRows.rows[0] as unknown as CountRow | undefined)?.count ?? 0),
    dates: Number((dateRows.rows[0] as unknown as CountRow | undefined)?.count ?? 0),
  }
}

function runNpm(script: string, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['run', script], {
      cwd: process.cwd(),
      env,
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
  const attempts = numberEnv('JP_PMS_STEP_MAX_ATTEMPTS', 3)
  const retryDelaySeconds = numberEnv('JP_PMS_STEP_RETRY_DELAY_SECONDS', 300)
  let lastError: unknown = null

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      if (attempt > 1) console.log(`JP PMS retry ${attempt}/${attempts}: npm run ${script}`)
      await runNpm(script, env)
      return
    } catch (error) {
      lastError = error
      const message = error instanceof Error ? error.message : String(error)
      console.error(`JP PMS step failed ${attempt}/${attempts}: ${message}`)
      if (attempt >= attempts) break
      await sleep(retryDelaySeconds * 1000)
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

async function main(): Promise<void> {
  const mode = modeFromArg(process.argv[2])
  const path = localDbPath
  if (!fs.existsSync(path)) throw new Error(`JP DB not found: ${path}`)

  const { tickers, dates } = await countJpDbRows(path)
  if (tickers <= 0 || dates <= 0) throw new Error(`JP OHLCV is empty: tickers=${tickers}, dates=${dates}`)

  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    USE_LOCAL_DB: '1',
    STOCKBOARD_DB_PATH: path,
    SQLITE_BUSY_RETRIES: process.env.SQLITE_BUSY_RETRIES ?? '720',
    PMS_MARKETS: 'JP',
    PMS_RECENT_DAYS: String(RECENT_DAYS),
    PMS_BATCH_CHUNK: process.env.JP_PMS_BATCH_CHUNK ?? process.env.PMS_BATCH_CHUNK ?? '300',
  }

  console.log(`JP PMS chunked full: db=${path}`)
  console.log(`JP PMS chunked full: mode=${mode}, tickers=${tickers}, dates=${dates}, recentDays=${RECENT_DAYS}, tickerChunk=${TICKER_CHUNK}, dateChunk=${DATE_CHUNK}`)

  if (mode === 'full' || mode === 'raw') {
    for (let offset = TICKER_START_OFFSET; offset < tickers; offset += TICKER_CHUNK) {
      console.log(`JP PMS raw chunk: offset=${offset}, limit=${TICKER_CHUNK}`)
      await runNpmWithRetry('batch:physical-momentum', {
        ...baseEnv,
        PMS_RUN_JOB_TYPE: 'physical_momentum_jp_raw_chunk',
        PMS_RAW_ONLY: '1',
        PMS_TICKER_OFFSET: String(offset),
        PMS_TICKER_LIMIT: String(TICKER_CHUNK),
      })
    }
  }

  if (mode === 'full' || mode === 'normalize') {
    for (let offset = DATE_START_OFFSET; offset < dates; offset += DATE_CHUNK) {
      console.log(`JP PMS normalize chunk: offset=${offset}, limit=${DATE_CHUNK}`)
      await runNpmWithRetry('batch:physical-momentum', {
        ...baseEnv,
        PMS_RUN_JOB_TYPE: 'physical_momentum_jp_normalize_chunk',
        PMS_NORMALIZE_ONLY: '1',
        PMS_DATE_OFFSET: String(offset),
        PMS_DATE_LIMIT: String(DATE_CHUNK),
      })
    }
  }

  console.log('JP PMS chunked full complete')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
