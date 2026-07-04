// scripts/run-us-physical-momentum-full.ts
//
// Full-history US PMS can be too large for one Node process.  Run raw metric
// generation by ticker chunks, then run cross-sectional normalization by date
// chunks.  Each child uses UPSERTs, so retries are safe and do not delete
// existing serving data first.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { createClient } from '@libsql/client'

const DEFAULT_US_ANALYTICS_DB = '/Volumes/OWC Express 1M2 80G/stockboard-data/us/stockboard-us.db'
type Mode = 'full' | 'raw' | 'normalize'

const TICKER_CHUNK = Math.max(1, Number(process.env.US_PMS_TICKER_CHUNK ?? 500))
const DATE_CHUNK = Math.max(1, Number(process.env.US_PMS_DATE_CHUNK ?? 100))
const TICKER_START_OFFSET = Math.max(0, Number(process.env.US_PMS_TICKER_START_OFFSET ?? 0))
const DATE_START_OFFSET = Math.max(0, Number(process.env.US_PMS_DATE_START_OFFSET ?? 0))

type CountRow = { count: number }

function dbPath(): string {
  return process.env.US_ANALYTICS_DB_PATH?.trim()
    || DEFAULT_US_ANALYTICS_DB
}

function modeFromArg(value: string | undefined): Mode {
  if (value === undefined || value === 'full') return 'full'
  if (value === 'raw' || value === 'normalize') return value
  throw new Error('Usage: tsx scripts/run-us-physical-momentum-full.ts [full|raw|normalize]')
}

async function countUsDbRows(path: string): Promise<{ tickers: number; dates: number }> {
  const client = createClient({ url: `file:${path}` })
  await client.execute('PRAGMA busy_timeout=60000')
  const tickerRows = await client.execute('SELECT COUNT(DISTINCT ticker) AS count FROM ohlcv_daily')
  const dateRows = await client.execute('SELECT COUNT(DISTINCT date) AS count FROM ohlcv_daily')
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

async function main(): Promise<void> {
  const mode = modeFromArg(process.argv[2])
  const path = dbPath()
  if (!fs.existsSync(path)) throw new Error(`US analytics DB not found: ${path}`)

  const { tickers, dates } = await countUsDbRows(path)
  if (tickers <= 0 || dates <= 0) throw new Error(`US OHLCV is empty: tickers=${tickers}, dates=${dates}`)

  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    USE_LOCAL_DB: '1',
    STOCKBOARD_DB_PATH: path,
    US_ANALYTICS_DB_PATH: path,
    SQLITE_BUSY_RETRIES: process.env.SQLITE_BUSY_RETRIES ?? '720',
    PMS_RECENT_DAYS: '0',
    PMS_OUTPUT_MARKET: 'US',
    PMS_BATCH_CHUNK: process.env.US_PMS_BATCH_CHUNK ?? process.env.PMS_BATCH_CHUNK ?? '300',
  }

  console.log(`US PMS chunked full: db=${path}`)
  console.log(`US PMS chunked full: mode=${mode}, tickers=${tickers}, dates=${dates}, tickerChunk=${TICKER_CHUNK}, dateChunk=${DATE_CHUNK}`)

  if (mode === 'full' || mode === 'raw') {
    for (let offset = TICKER_START_OFFSET; offset < tickers; offset += TICKER_CHUNK) {
      console.log(`US PMS raw chunk: offset=${offset}, limit=${TICKER_CHUNK}`)
      await runNpm('batch:physical-momentum', {
        ...baseEnv,
        PMS_RUN_JOB_TYPE: 'physical_momentum_us_raw_chunk',
        PMS_RAW_ONLY: '1',
        PMS_TICKER_OFFSET: String(offset),
        PMS_TICKER_LIMIT: String(TICKER_CHUNK),
      })
    }
  }

  if (mode === 'full' || mode === 'normalize') {
    for (let offset = DATE_START_OFFSET; offset < dates; offset += DATE_CHUNK) {
      console.log(`US PMS normalize chunk: offset=${offset}, limit=${DATE_CHUNK}`)
      await runNpm('batch:physical-momentum', {
        ...baseEnv,
        PMS_RUN_JOB_TYPE: 'physical_momentum_us_normalize_chunk',
        PMS_NORMALIZE_ONLY: '1',
        PMS_DATE_OFFSET: String(offset),
        PMS_DATE_LIMIT: String(DATE_CHUNK),
      })
    }
  }

  console.log('US PMS chunked full complete')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
