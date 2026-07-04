// scripts/run-us-ml-physics-features-full.ts
//
// Build US physics ML feature vectors over the full evaluable history in small
// ticker chunks. The underlying batch uses INSERT OR REPLACE, so reruns are
// resumable and do not delete existing feature rows.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { createClient } from '@libsql/client'

const DEFAULT_US_ANALYTICS_DB = '/Volumes/OWC Express 1M2 80G/stockboard-data/us/stockboard-us.db'
const DEFAULT_START_DATE = '1980-12-12'

const TICKER_CHUNK = Math.max(1, Number(process.env.US_ML_PHYSICS_FEATURE_TICKER_CHUNK ?? 200))
const START_OFFSET = Math.max(0, Number(process.env.US_ML_PHYSICS_FEATURE_START_OFFSET ?? 0))
const END_OFFSET = Number(process.env.US_ML_PHYSICS_FEATURE_END_OFFSET ?? 0)

type TickerRow = { ticker: string }

function dbPath(): string {
  return process.env.US_ANALYTICS_DB_PATH?.trim() || DEFAULT_US_ANALYTICS_DB
}

async function loadTickers(path: string): Promise<string[]> {
  const client = createClient({ url: `file:${path}` })
  await client.execute('PRAGMA busy_timeout=60000')
  const rows = await client.execute(`
    SELECT ticker
    FROM ohlcv_daily
    GROUP BY ticker
    ORDER BY ticker
  `)
  return rows.rows.map((row) => String((row as unknown as TickerRow).ticker)).filter(Boolean)
}

function runChunk(env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'npx',
      ['tsx', '--env-file=.env.local', 'scripts/batch-ml-physics-features.ts'],
      {
        cwd: process.cwd(),
        env,
        stdio: 'inherit',
      },
    )
    child.on('error', reject)
    child.on('close', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`batch-ml-physics-features failed: code=${code}, signal=${signal ?? 'none'}`))
    })
  })
}

async function main(): Promise<void> {
  const path = dbPath()
  if (!fs.existsSync(path)) throw new Error(`US analytics DB not found: ${path}`)
  const tickers = await loadTickers(path)
  if (tickers.length === 0) throw new Error(`US OHLCV is empty: ${path}`)

  const endOffset = END_OFFSET > 0 ? Math.min(END_OFFSET, tickers.length) : tickers.length
  const startOffset = Math.min(START_OFFSET, endOffset)
  console.log(`US ML physics features full: db=${path}`)
  console.log(`US ML physics features full: tickers=${tickers.length}, rangeOffset=${startOffset}..${endOffset}, chunk=${TICKER_CHUNK}`)

  for (let start = startOffset; start < endOffset; start += TICKER_CHUNK) {
    const end = Math.min(start + TICKER_CHUNK, endOffset)
    const startTicker = tickers[start]
    const endTicker = tickers[end - 1]
    if (!startTicker || !endTicker) continue
    console.log(`US ML physics features full chunk: ${start + 1}-${end}/${tickers.length} ${startTicker}..${endTicker}`)
    await runChunk({
      ...process.env,
      USE_LOCAL_DB: '1',
      STOCKBOARD_DB_PATH: path,
      US_ANALYTICS_DB_PATH: path,
      SQLITE_BUSY_RETRIES: process.env.SQLITE_BUSY_RETRIES ?? '720',
      ML_PHYSICS_START_DATE: process.env.ML_PHYSICS_START_DATE ?? DEFAULT_START_DATE,
      ML_PHYSICS_RECENT_DAYS: '0',
      ML_PHYSICS_MIN_HISTORY_DAYS: process.env.ML_PHYSICS_MIN_HISTORY_DAYS ?? '220',
      ML_PHYSICS_BATCH_CHUNK: process.env.ML_PHYSICS_BATCH_CHUNK ?? '1000',
      ML_PHYSICS_TICKER_START: startTicker,
      ML_PHYSICS_TICKER_END: endTicker,
    })
  }

  console.log('US ML physics features full complete')
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
