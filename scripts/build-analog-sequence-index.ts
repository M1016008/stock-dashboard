import { createClient, type Client, type InValue } from '@libsql/client'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveUsAnalyticsDbPath } from '@/lib/db/us-analytics'
import {
  MA_SEQUENCE_BAND_COUNT,
  MA_SEQUENCE_EMBEDDING_FEATURE_LENGTH,
  MA_SEQUENCE_INDEX_STRIDE,
  MA_SEQUENCE_MONTHLY_PERIODS,
  MA_SEQUENCE_PERIODS,
  MA_SEQUENCE_VERSION,
  MA_SEQUENCE_WEEKLY_PERIODS,
  MA_SEQUENCE_YEARLY_PERIODS,
  buildMaSequenceEmbedding,
  prepareMaSequence,
  stageCodeAt,
  type MaSequencePriceRow,
} from '@/lib/ml/ma-sequence'

type Market = 'JP' | 'US'
type Mode = 'full' | 'incremental'

type TickerRow = { ticker: string }
type SourcePriceRow = { date: string; close: number }
type ExistingRow = { ticker: string; latest_date: string | null }

const SQLITE_BUSY_TIMEOUT_MS = Math.max(10_000, Number(process.env.SQLITE_BUSY_TIMEOUT_MS ?? 60_000))
const INSERT_BATCH_SIZE = Math.min(1_000, Math.max(50, Number(process.env.ANALOG_INDEX_INSERT_BATCH ?? 300)))
const INCREMENTAL_LOOKBACK_ROWS = Math.max(
  2_800,
  Number(process.env.ANALOG_INDEX_INCREMENTAL_LOOKBACK_ROWS ?? 3_000),
)
const MAX_GAP_DAYS = 60
let ownedProcessLock: string | null = null

function pidExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function releaseProcessLock(): void {
  if (!ownedProcessLock) return
  try {
    const owner = Number(fs.readFileSync(ownedProcessLock, 'utf8').trim())
    if (owner === process.pid) fs.unlinkSync(ownedProcessLock)
  } catch {
    // Missing or replaced locks no longer belong to this process.
  }
  ownedProcessLock = null
}

function acquireProcessLock(target: string): boolean {
  const lockPath = `${target}.process.lock`
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = fs.openSync(lockPath, 'wx', 0o600)
      fs.writeFileSync(handle, `${process.pid}\n`)
      fs.closeSync(handle)
      ownedProcessLock = lockPath
      process.once('exit', releaseProcessLock)
      return true
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error
      const owner = Number(fs.readFileSync(lockPath, 'utf8').trim())
      if (pidExists(owner)) {
        console.log(`Analog index build already running for ${target} (pid=${owner}); skipping duplicate.`)
        return false
      }
      fs.unlinkSync(lockPath)
    }
  }
  return false
}

function lowerProcessPriority(): void {
  try {
    os.setPriority(process.pid, 15)
  } catch (error) {
    console.warn('[analog-sequence-index] could not lower CPU priority:', error)
  }
  if (process.platform !== 'darwin') return
  try {
    execFileSync('taskpolicy', ['-b', '-p', String(process.pid)], { stdio: 'ignore' })
  } catch (error) {
    console.warn('[analog-sequence-index] could not lower macOS I/O priority:', error)
  }
}

function normalizeMarket(value: string | undefined): Market {
  return value?.trim().toUpperCase() === 'US' ? 'US' : 'JP'
}

function normalizeMode(value: string | undefined): Mode {
  return value?.trim().toLowerCase() === 'full' ? 'full' : 'incremental'
}

function sourcePath(market: Market): string {
  if (market === 'US') {
    const configured = process.env.US_ANALYTICS_DB_PATH?.trim()
    const candidate = configured ? path.resolve(configured) : resolveUsAnalyticsDbPath()
    return fs.existsSync(candidate) ? fs.realpathSync(candidate) : candidate
  }
  const configured = process.env.STOCKBOARD_DB_PATH?.trim() || process.env.LOCAL_DB_PATH?.trim()
  const candidate = configured
    ? path.resolve(configured)
    : path.join(process.cwd(), 'data', 'stockboard.db')
  return fs.existsSync(candidate) ? fs.realpathSync(candidate) : candidate
}

function targetPath(market: Market, source: string): string {
  const configured = market === 'US'
    ? process.env.ANALOG_US_DB_PATH?.trim()
    : process.env.ANALOG_JP_DB_PATH?.trim()
  return configured
    ? path.resolve(configured)
    : path.join(
        path.dirname(source),
        `analog-sequence-${market.toLowerCase()}-v${MA_SEQUENCE_VERSION}.db`,
      )
}

function calendarDays(from: string, to: string): number {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000
}

function splitContinuous(rows: MaSequencePriceRow[]): MaSequencePriceRow[][] {
  if (rows.length === 0) return []
  const segments: MaSequencePriceRow[][] = []
  let current = [rows[0]]
  for (let index = 1; index < rows.length; index += 1) {
    if (calendarDays(rows[index - 1].date, rows[index].date) > MAX_GAP_DAYS) {
      segments.push(current)
      current = []
    }
    current.push(rows[index])
  }
  segments.push(current)
  return segments
}

async function all<T>(client: Client, sql: string, args: InValue[] = []): Promise<T[]> {
  const result = await client.execute({ sql, args })
  return result.rows.map((row) => ({ ...row })) as unknown as T[]
}

async function getValue(client: Client, key: string): Promise<string | null> {
  const rows = await all<{ value: string }>(
    client,
    `SELECT value FROM analog_sequence_meta WHERE key = ? LIMIT 1`,
    [key],
  )
  return rows[0]?.value ?? null
}

async function setMeta(client: Client, values: Record<string, string>): Promise<void> {
  await client.batch(
    Object.entries(values).map(([key, value]) => ({
      sql: `
        INSERT INTO analog_sequence_meta(key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `,
      args: [key, value],
    })),
  )
}

async function ensureSchema(client: Client): Promise<void> {
  await client.execute(`PRAGMA busy_timeout=${SQLITE_BUSY_TIMEOUT_MS}`)
  await client.execute('PRAGMA journal_mode=WAL')
  await client.execute('PRAGMA synchronous=NORMAL')
  await client.execute('PRAGMA temp_store=FILE')
  await client.execute('PRAGMA cache_size=-131072')
  await client.execute('PRAGMA mmap_size=0')
  await client.batch([
    {
      sql: `
        CREATE TABLE IF NOT EXISTS analog_sequence_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        ) WITHOUT ROWID
      `,
    },
    {
      sql: `
        CREATE TABLE IF NOT EXISTS analog_sequence_index (
          ticker TEXT NOT NULL,
          date TEXT NOT NULL,
          stage_code TEXT,
          embedding BLOB NOT NULL,
          coverage_mask INTEGER NOT NULL,
          band0 INTEGER NOT NULL,
          band1 INTEGER NOT NULL,
          band2 INTEGER NOT NULL,
          band3 INTEGER NOT NULL,
          PRIMARY KEY (ticker, date)
        ) WITHOUT ROWID
      `,
    },
  ])
}

async function ensureIndexes(client: Client, analyze: boolean): Promise<void> {
  for (let index = 0; index < MA_SEQUENCE_BAND_COUNT; index += 1) {
    console.log(`Creating/verifying band index ${index + 1}/${MA_SEQUENCE_BAND_COUNT}`)
    await client.execute(`
      CREATE INDEX IF NOT EXISTS analog_sequence_band${index}_idx
      ON analog_sequence_index(band${index}, date, ticker)
    `)
  }
  console.log('Creating/verifying stage index')
  await client.execute(`
    CREATE INDEX IF NOT EXISTS analog_sequence_stage_idx
    ON analog_sequence_index(stage_code, date, ticker)
  `)
  if (analyze) await client.execute('ANALYZE')
}

function normalizedRows(rows: SourcePriceRow[]): MaSequencePriceRow[] {
  return rows
    .map((row) => ({ date: String(row.date), close: Number(row.close) }))
    .filter((row) => row.date && Number.isFinite(row.close) && row.close > 0)
}

type PendingInsert = {
  sql: string
  args: InValue[]
}

function createInsert(
  ticker: string,
  date: string,
  stageCode: string | null,
  embedding: ReturnType<typeof buildMaSequenceEmbedding> & {},
): PendingInsert {
  return {
    sql: `
      INSERT INTO analog_sequence_index(
        ticker, date, stage_code, embedding, coverage_mask,
        band0, band1, band2, band3
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ticker, date) DO UPDATE SET
        stage_code = excluded.stage_code,
        embedding = excluded.embedding,
        coverage_mask = excluded.coverage_mask,
        band0 = excluded.band0,
        band1 = excluded.band1,
        band2 = excluded.band2,
        band3 = excluded.band3
    `,
    args: [
      ticker,
      date,
      stageCode,
      embedding.quantized.buffer as ArrayBuffer,
      embedding.coverageMask,
      ...embedding.bands,
    ],
  }
}

async function flush(client: Client, pending: PendingInsert[]): Promise<number> {
  if (pending.length === 0) return 0
  await client.batch(pending)
  const count = pending.length
  pending.length = 0
  return count
}

async function main(): Promise<void> {
  lowerProcessPriority()
  const market = normalizeMarket(process.argv[2] ?? process.env.ANALOG_INDEX_MARKET)
  const mode = normalizeMode(process.argv[3] ?? process.env.ANALOG_INDEX_MODE)
  const source = sourcePath(market)
  const target = targetPath(market, source)
  if (!fs.existsSync(source)) throw new Error(`Source DB not found: ${source}`)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  if (!acquireProcessLock(target)) return

  const sourceClient = createClient({ url: `file:${source}` })
  const targetClient = createClient({ url: `file:${target}` })
  await sourceClient.execute(`PRAGMA busy_timeout=${SQLITE_BUSY_TIMEOUT_MS}`)
  await sourceClient.execute('PRAGMA query_only=ON')
  await targetClient.execute(`PRAGMA busy_timeout=${SQLITE_BUSY_TIMEOUT_MS}`)
  await ensureSchema(targetClient)

  const sourceDateRows = await all<{ date: string | null }>(
    sourceClient,
    'SELECT MAX(date) AS date FROM ohlcv_daily',
  )
  const sourceDate = sourceDateRows[0]?.date ?? null
  if (!sourceDate) throw new Error(`${market} OHLCV has no rows.`)
  const existingVersion = Number(await getValue(targetClient, 'version') ?? 0)
  const existingSourceDate = await getValue(targetClient, 'source_date')
  const existingCompleted = await getValue(targetClient, 'completed')
  if (
    mode === 'incremental'
    && existingVersion === MA_SEQUENCE_VERSION
    && existingSourceDate === sourceDate
    && existingCompleted === '1'
  ) {
    await ensureIndexes(targetClient, false)
    console.log(`${market} analog sequence index is already fresh: ${sourceDate}`)
    await sourceClient.close()
    await targetClient.close()
    return
  }

  const existingRows = await all<ExistingRow>(
    targetClient,
    'SELECT ticker, MAX(date) AS latest_date FROM analog_sequence_index GROUP BY ticker',
  )
  const latestByTicker = new Map(existingRows.map((row) => [row.ticker, row.latest_date]))
  const tickerRows = await all<TickerRow>(
    sourceClient,
    'SELECT DISTINCT ticker FROM ohlcv_daily ORDER BY ticker',
  )
  const resumeTicker = mode === 'full'
    && existingCompleted !== '1'
    && existingVersion === MA_SEQUENCE_VERSION
    && existingSourceDate === sourceDate
    ? await getValue(targetClient, 'progress_ticker')
    : null
  await setMeta(targetClient, {
    market,
    version: String(MA_SEQUENCE_VERSION),
    feature_schema: [
      `D:${MA_SEQUENCE_PERIODS.join(',')}`,
      `W:${MA_SEQUENCE_WEEKLY_PERIODS.join(',')}`,
      `M:${MA_SEQUENCE_MONTHLY_PERIODS.join(',')}`,
      `Y:${MA_SEQUENCE_YEARLY_PERIODS.join(',')}`,
    ].join('|'),
    embedding_bytes: String(MA_SEQUENCE_EMBEDDING_FEATURE_LENGTH + 5),
    source_date: sourceDate,
    completed: '0',
    mode,
    started_at: new Date().toISOString(),
  })

  let inserted = 0
  let processed = 0
  const pending: PendingInsert[] = []
  const startedAt = Date.now()
  for (const [tickerIndex, tickerRow] of tickerRows.entries()) {
    const ticker = String(tickerRow.ticker)
    if (resumeTicker && ticker <= resumeTicker) continue
    const latestIndexed = latestByTicker.get(ticker)
    const incrementalExisting = mode === 'incremental' && Boolean(latestIndexed)
    const rows = normalizedRows(await all<SourcePriceRow>(
      sourceClient,
      incrementalExisting
        ? `
          SELECT date, close
          FROM (
            SELECT date, close
            FROM ohlcv_daily
            WHERE ticker = ?
            ORDER BY date DESC
            LIMIT ?
          )
          ORDER BY date
        `
        : 'SELECT date, close FROM ohlcv_daily WHERE ticker = ? ORDER BY date',
      incrementalExisting ? [ticker, INCREMENTAL_LOOKBACK_ROWS] : [ticker],
    ))
    for (const segment of splitContinuous(rows)) {
      const prepared = prepareMaSequence(segment)
      const anchorIndexes: number[] = incrementalExisting
        ? prepared.rows
          .map((row, index) => ({ date: row.date, index }))
          .filter((row) => row.index >= 240 && latestIndexed && row.date > latestIndexed)
          .map((row) => row.index)
        : []
      if (!incrementalExisting) {
        for (let index = 240; index < prepared.rows.length; index += MA_SEQUENCE_INDEX_STRIDE) {
          anchorIndexes.push(index)
        }
      }
      if (
        !incrementalExisting
        && prepared.rows.length > 240
        && anchorIndexes.at(-1) !== prepared.rows.length - 1
      ) {
        anchorIndexes.push(prepared.rows.length - 1)
      }
      for (const index of anchorIndexes) {
        const date = prepared.rows[index].date
        if (mode === 'incremental' && latestIndexed && date <= latestIndexed) continue
        const embedding = buildMaSequenceEmbedding(prepared, index)
        if (!embedding) continue
        pending.push(createInsert(ticker, date, stageCodeAt(prepared, index), embedding))
        if (pending.length >= INSERT_BATCH_SIZE) inserted += await flush(targetClient, pending)
      }
    }
    processed += 1
    if (tickerIndex % 25 === 0 || tickerIndex === tickerRows.length - 1) {
      inserted += await flush(targetClient, pending)
      await setMeta(targetClient, {
        progress_ticker: ticker,
        progress_tickers: String(processed),
        progress_rows: String(inserted),
        updated_at: new Date().toISOString(),
      })
      const elapsedSeconds = Math.max(1, (Date.now() - startedAt) / 1_000)
      console.log(
        `[${market}] ${tickerIndex + 1}/${tickerRows.length}`
        + ` ticker=${ticker} written=${inserted.toLocaleString()}`
        + ` rate=${Math.round(inserted / elapsedSeconds).toLocaleString()} rows/s`,
      )
    }
  }
  inserted += await flush(targetClient, pending)
  await ensureIndexes(targetClient, mode === 'full')
  const [coverage] = await all<{
    coverage_from: string | null
    coverage_to: string | null
    row_count: number
  }>(
    targetClient,
    `
    SELECT
      MIN(date) AS coverage_from,
      MAX(date) AS coverage_to,
      COUNT(*) AS row_count
    FROM analog_sequence_index
    `,
  )
  await setMeta(targetClient, {
    coverage_from: coverage?.coverage_from ?? '',
    coverage_to: coverage?.coverage_to ?? '',
    row_count: String(Number(coverage?.row_count ?? 0)),
    completed: '1',
    completed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  })
  await targetClient.execute('PRAGMA wal_checkpoint(TRUNCATE)')
  console.log(JSON.stringify({
    market,
    mode,
    source,
    target,
    sourceDate,
    processedTickers: processed,
    writtenRows: inserted,
    indexedRows: Number(coverage?.row_count ?? 0),
    coverageFrom: coverage?.coverage_from ?? null,
    coverageTo: coverage?.coverage_to ?? null,
    elapsedSeconds: Math.round((Date.now() - startedAt) / 1_000),
  }, null, 2))
  await sourceClient.close()
  await targetClient.close()
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('[analog-sequence-index] failed:', error instanceof Error ? error.stack : String(error))
    process.exit(1)
  })
