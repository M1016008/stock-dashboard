// US market_* tablesから、既存JP分析パイプライン互換のUS専用SQLite DBを作る。
// 生成後は STOCKBOARD_DB_PATH=<US_ANALYTICS_DB_PATH> npm run batch:ml-full のように既存MLを流用できる。

import path from 'node:path'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createClient, type Client } from '@libsql/client'
import { execAll, localDbPath } from '@/lib/db/client'
import { ensureSchema } from '@/lib/db/migrate'
import { US_SEC_SIC_TAXONOMY } from '@/lib/us-classification'
import { US_ADJUSTED_PRICE_BASIS } from '@/lib/us-adjusted-ohlcv'
import { isUsInvestableSymbol } from '@/lib/us-symbol-quality'

const configuredTargetPath = process.env.US_ANALYTICS_DB_PATH?.trim()
const TARGET_PATH = path.resolve(configuredTargetPath || 'data/stockboard-us.db')
const LIMIT = Number(process.env.US_ANALYTICS_LIMIT ?? 0)
const requestedCopyChunk = Math.max(1, Number(process.env.US_ANALYTICS_CHUNK ?? 10))
const maxCopyChunk = Math.max(1, Number(process.env.US_ANALYTICS_MAX_CHUNK ?? 10))
const COPY_CHUNK = Math.min(requestedCopyChunk, maxCopyChunk)
const BATCH_CHUNK = Math.max(25, Math.min(Number(process.env.US_ANALYTICS_BATCH_CHUNK ?? 100), 200))
const NATIVE_COPY = process.env.US_ANALYTICS_NATIVE_COPY !== '0'
const NATIVE_COPY_CHUNK = Math.max(
  10,
  Math.min(
    Number(process.env.US_ANALYTICS_NATIVE_CHUNK ?? 50),
    Number(process.env.US_ANALYTICS_NATIVE_MAX_CHUNK ?? 50),
    250,
  ),
)
const NATIVE_BUSY_TIMEOUT_MS = Math.max(
  60_000,
  Math.min(Number(process.env.US_ANALYTICS_NATIVE_BUSY_TIMEOUT_MS ?? 300_000), 900_000),
)
const NATIVE_BUSY_RETRIES = Math.max(
  1,
  Math.min(Number(process.env.US_ANALYTICS_NATIVE_BUSY_RETRIES ?? 8), 20),
)
const NATIVE_SYNC_RECENT_DAYS = Math.max(1, Number(process.env.US_ANALYTICS_SYNC_RECENT_DAYS ?? 45))
const REBUILD_PRICE_BASIS = process.env.US_ANALYTICS_REBUILD_PRICE_BASIS === '1'

async function run(client: Client, sql: string, args: Array<string | number | null> = []) {
  await client.execute({ sql, args })
}

async function batch(client: Client, statements: Array<{ sql: string; args: Array<string | number | null> }>) {
  for (let i = 0; i < statements.length; i += BATCH_CHUNK) {
    await client.batch(statements.slice(i, i + BATCH_CHUNK))
  }
}

function assertSafeTarget() {
  const fullRun = LIMIT === 0
  const allowLocalFallback = process.env.US_ANALYTICS_ALLOW_LOCAL === '1'

  if (fullRun && !configuredTargetPath && !allowLocalFallback) {
    throw new Error(
      'US_ANALYTICS_DB_PATH is required for a full US analytics build. '
      + 'Set it to the external SSD path before running, or set US_ANALYTICS_ALLOW_LOCAL=1 for an intentional small local test.',
    )
  }

  const defaultLocalPath = path.resolve('data/stockboard-us.db')
  if (fullRun && TARGET_PATH === defaultLocalPath && !allowLocalFallback) {
    throw new Error(
      `Refusing full US analytics build on the local fallback DB: ${defaultLocalPath}. `
      + 'Use US_ANALYTICS_DB_PATH on the external SSD.',
    )
  }

  const sourceDbPath = process.env.STOCKBOARD_DB_PATH ? path.resolve(process.env.STOCKBOARD_DB_PATH) : null
  if (sourceDbPath && sourceDbPath === TARGET_PATH) {
    throw new Error(
      `US analytics target must not be the same file as STOCKBOARD_DB_PATH: ${TARGET_PATH}`,
    )
  }
}

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function runSqlite(dbPath: string, sql: string): string {
  const result = spawnSync('sqlite3', ['-batch', dbPath], {
    input: sql,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 32,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `sqlite3 failed (${result.status ?? 'signal'}${result.signal ? `/${result.signal}` : ''}): `
      + `${result.stderr || result.stdout || 'no output'}`,
    )
  }
  return result.stdout
}

function waitSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

function nativeCopyChunk(sourcePath: string, chunk: string[]): { ohlcvRows: number; snapshotRows: number } {
  const values = chunk.map((ticker) => `(${sqlLiteral(ticker)})`).join(',\n')
  let output = ''
  for (let attempt = 1; attempt <= NATIVE_BUSY_RETRIES; attempt += 1) {
    try {
      output = runSqlite(TARGET_PATH, `
.bail on
PRAGMA busy_timeout = ${NATIVE_BUSY_TIMEOUT_MS};
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = FILE;
ATTACH DATABASE ${sqlLiteral(sourcePath)} AS src;
CREATE TEMP TABLE copy_tickers (ticker TEXT PRIMARY KEY);
INSERT INTO copy_tickers (ticker) VALUES
${values};
BEGIN IMMEDIATE;
INSERT OR REPLACE INTO ohlcv_daily (ticker, date, open, high, low, close, volume, split_factor)
  SELECT
    m.ticker,
    m.date,
    CASE WHEN m.adj_open IS NOT NULL THEN m.adj_open WHEN m.adj_close IS NOT NULL AND m.close <> 0 THEN m.open * m.adj_close / m.close ELSE m.open END,
    CASE WHEN m.adj_high IS NOT NULL THEN m.adj_high WHEN m.adj_close IS NOT NULL AND m.close <> 0 THEN m.high * m.adj_close / m.close ELSE m.high END,
    CASE WHEN m.adj_low IS NOT NULL THEN m.adj_low WHEN m.adj_close IS NOT NULL AND m.close <> 0 THEN m.low * m.adj_close / m.close ELSE m.low END,
    COALESCE(m.adj_close, m.close),
    COALESCE(m.adj_volume, m.volume),
    m.split_factor
  FROM copy_tickers t
  JOIN src.market_ohlcv_daily m INDEXED BY market_ohlcv_market_ticker_date_idx
    ON m.market = 'US'
   AND m.ticker = t.ticker;
INSERT OR REPLACE INTO daily_snapshots (
  ticker, date, ma_5, ma_25, ma_75, ma_150, ma_300,
  weekly_ma_5, weekly_ma_13, weekly_ma_25, weekly_ma_50, weekly_ma_100,
  monthly_ma_3, monthly_ma_5, monthly_ma_10, monthly_ma_20, monthly_ma_25,
  daily_a_stage, daily_b_stage, weekly_a_stage, weekly_b_stage, monthly_a_stage, monthly_b_stage,
  computed_at
)
  SELECT
    m.ticker, m.date, m.ma_5, m.ma_25, m.ma_75, m.ma_150, m.ma_300,
    m.weekly_ma_5, m.weekly_ma_13, m.weekly_ma_25, m.weekly_ma_50, m.weekly_ma_100,
    m.monthly_ma_3, m.monthly_ma_5, m.monthly_ma_10, m.monthly_ma_20, m.monthly_ma_25,
    m.daily_a_stage, m.daily_b_stage, m.weekly_a_stage, m.weekly_b_stage, m.monthly_a_stage, m.monthly_b_stage,
    unixepoch()
  FROM copy_tickers t
  JOIN src.market_daily_snapshots m INDEXED BY sqlite_autoindex_market_daily_snapshots_1
    ON m.market = 'US'
   AND m.ticker = t.ticker;
INSERT OR REPLACE INTO us_analytics_copy_state (ticker, status, ohlcv_rows, snapshot_rows, price_basis, updated_at)
  SELECT
    t.ticker,
    'done',
    COALESCE((SELECT COUNT(*) FROM ohlcv_daily o WHERE o.ticker = t.ticker), 0),
    COALESCE((SELECT COUNT(*) FROM daily_snapshots d WHERE d.ticker = t.ticker), 0),
    ${sqlLiteral(US_ADJUSTED_PRICE_BASIS)},
    unixepoch()
  FROM copy_tickers t;
COMMIT;
SELECT 'copied|' ||
  COALESCE((SELECT SUM(ohlcv_rows) FROM us_analytics_copy_state WHERE ticker IN (SELECT ticker FROM copy_tickers)), 0) ||
  '|' ||
  COALESCE((SELECT SUM(snapshot_rows) FROM us_analytics_copy_state WHERE ticker IN (SELECT ticker FROM copy_tickers)), 0);
DETACH DATABASE src;
`)
      break
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!/database is locked|database is busy|SQLITE_BUSY/i.test(message) || attempt >= NATIVE_BUSY_RETRIES) {
        throw error
      }
      const delayMs = Math.min(30_000, 2_000 * attempt)
      console.warn(`US analytics copy lock retry ${attempt}/${NATIVE_BUSY_RETRIES}; waiting ${delayMs}ms`)
      waitSync(delayMs)
    }
  }
  const line = output.trim().split(/\r?\n/).find((row) => row.startsWith('copied|'))
  const [, ohlcvRows, snapshotRows] = (line ?? 'copied|0|0').split('|')
  return {
    ohlcvRows: Number(ohlcvRows ?? 0),
    snapshotRows: Number(snapshotRows ?? 0),
  }
}

function nativeCopyPending(pendingTickers: string[], doneSize: number): boolean {
  const sourcePath = localDbPath
  if (!NATIVE_COPY || !fs.existsSync(sourcePath)) return false
  let copied = 0
  let snapshotsCopied = 0
  for (let i = 0; i < pendingTickers.length; i += NATIVE_COPY_CHUNK) {
    const chunk = pendingTickers.slice(i, i + NATIVE_COPY_CHUNK)
    const result = nativeCopyChunk(sourcePath, chunk)
    copied += result.ohlcvRows
    snapshotsCopied += result.snapshotRows
    console.log(
      `[${Math.min(i + NATIVE_COPY_CHUNK, pendingTickers.length)}/${pendingTickers.length}] native copied ohlcv=${copied} snapshots=${snapshotsCopied} skipped=${doneSize}`,
    )
  }
  return true
}

function nativeSyncLatest(sourcePath: string): { ohlcvRows: number; snapshotRows: number; ohlcvAfter: string | null; snapshotAfter: string | null } {
  if (!NATIVE_COPY || !fs.existsSync(sourcePath)) {
    return { ohlcvRows: 0, snapshotRows: 0, ohlcvAfter: null, snapshotAfter: null }
  }

  const output = runSqlite(TARGET_PATH, `
.bail on
PRAGMA busy_timeout = ${NATIVE_BUSY_TIMEOUT_MS};
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = FILE;
ATTACH DATABASE ${sqlLiteral(sourcePath)} AS src;
CREATE TEMP TABLE sync_bounds AS
  SELECT
    (SELECT MAX(date) FROM ohlcv_daily) AS ohlcv_after,
    (SELECT MAX(date) FROM daily_snapshots) AS snapshot_after,
    (SELECT MAX(date) FROM src.market_ohlcv_daily WHERE market = 'US') AS source_ohlcv_latest,
    (SELECT MAX(date) FROM src.market_daily_snapshots WHERE market = 'US') AS source_snapshot_latest;
CREATE TEMP TABLE sync_recent_bounds AS
  SELECT
    CASE
      WHEN source_ohlcv_latest IS NOT NULL THEN date(source_ohlcv_latest, '-${NATIVE_SYNC_RECENT_DAYS} days')
      ELSE NULL
    END AS ohlcv_start,
    CASE
      WHEN source_snapshot_latest IS NOT NULL THEN date(source_snapshot_latest, '-${NATIVE_SYNC_RECENT_DAYS} days')
      ELSE NULL
    END AS snapshot_start
  FROM sync_bounds;
BEGIN IMMEDIATE;
INSERT OR REPLACE INTO ohlcv_daily (ticker, date, open, high, low, close, volume, split_factor)
  SELECT
    m.ticker,
    m.date,
    CASE WHEN m.adj_open IS NOT NULL THEN m.adj_open WHEN m.adj_close IS NOT NULL AND m.close <> 0 THEN m.open * m.adj_close / m.close ELSE m.open END,
    CASE WHEN m.adj_high IS NOT NULL THEN m.adj_high WHEN m.adj_close IS NOT NULL AND m.close <> 0 THEN m.high * m.adj_close / m.close ELSE m.high END,
    CASE WHEN m.adj_low IS NOT NULL THEN m.adj_low WHEN m.adj_close IS NOT NULL AND m.close <> 0 THEN m.low * m.adj_close / m.close ELSE m.low END,
    COALESCE(m.adj_close, m.close),
    COALESCE(m.adj_volume, m.volume),
    m.split_factor
  FROM src.market_ohlcv_daily m
  WHERE m.market = 'US'
    AND (
      (
        (SELECT ohlcv_after FROM sync_bounds) IS NOT NULL
        AND m.date > (SELECT ohlcv_after FROM sync_bounds)
      )
      OR (
        (SELECT ohlcv_start FROM sync_recent_bounds) IS NOT NULL
        AND m.date >= (SELECT ohlcv_start FROM sync_recent_bounds)
      )
    );
INSERT OR REPLACE INTO daily_snapshots (
  ticker, date, ma_5, ma_25, ma_75, ma_150, ma_300,
  weekly_ma_5, weekly_ma_13, weekly_ma_25, weekly_ma_50, weekly_ma_100,
  monthly_ma_3, monthly_ma_5, monthly_ma_10, monthly_ma_20, monthly_ma_25,
  daily_a_stage, daily_b_stage, weekly_a_stage, weekly_b_stage, monthly_a_stage, monthly_b_stage,
  computed_at
)
  SELECT
    m.ticker, m.date, m.ma_5, m.ma_25, m.ma_75, m.ma_150, m.ma_300,
    m.weekly_ma_5, m.weekly_ma_13, m.weekly_ma_25, m.weekly_ma_50, m.weekly_ma_100,
    m.monthly_ma_3, m.monthly_ma_5, m.monthly_ma_10, m.monthly_ma_20, m.monthly_ma_25,
    m.daily_a_stage, m.daily_b_stage, m.weekly_a_stage, m.weekly_b_stage, m.monthly_a_stage, m.monthly_b_stage,
    unixepoch()
  FROM src.market_daily_snapshots m
  WHERE m.market = 'US'
    AND (
      (
        (SELECT snapshot_after FROM sync_bounds) IS NOT NULL
        AND m.date > (SELECT snapshot_after FROM sync_bounds)
      )
      OR (
        (SELECT snapshot_start FROM sync_recent_bounds) IS NOT NULL
        AND m.date >= (SELECT snapshot_start FROM sync_recent_bounds)
      )
    );
COMMIT;
SELECT 'synced|' ||
  COALESCE((SELECT COUNT(*) FROM ohlcv_daily WHERE date >= COALESCE((SELECT ohlcv_start FROM sync_recent_bounds), '9999-12-31')), 0) ||
  '|' ||
  COALESCE((SELECT COUNT(*) FROM daily_snapshots WHERE date >= COALESCE((SELECT snapshot_start FROM sync_recent_bounds), '9999-12-31')), 0) ||
  '|' ||
  COALESCE((SELECT ohlcv_after FROM sync_bounds), '') ||
  '|' ||
  COALESCE((SELECT snapshot_after FROM sync_bounds), '');
DETACH DATABASE src;
`)
  const line = output.trim().split(/\r?\n/).find((row) => row.startsWith('synced|'))
  const [, ohlcvRows, snapshotRows, ohlcvAfter, snapshotAfter] = (line ?? 'synced|0|0||').split('|')
  return {
    ohlcvRows: Number(ohlcvRows ?? 0),
    snapshotRows: Number(snapshotRows ?? 0),
    ohlcvAfter: ohlcvAfter || null,
    snapshotAfter: snapshotAfter || null,
  }
}

async function ensureTarget(client: Client) {
  await run(client, `PRAGMA journal_mode=WAL`)
  await run(client, `CREATE TABLE IF NOT EXISTS ticker_universe (
    ticker TEXT PRIMARY KEY,
    name TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    added_at INTEGER NOT NULL DEFAULT (unixepoch()),
    shares_outstanding INTEGER,
    shares_updated_at INTEGER,
    sector17_code TEXT,
    sector17_name TEXT,
    sector33_code TEXT,
    sector33_name TEXT,
    market_segment TEXT,
    margin_code TEXT,
    margin_type TEXT
  )`)
  await run(client, `CREATE TABLE IF NOT EXISTS ohlcv_daily (
    ticker TEXT NOT NULL,
    date TEXT NOT NULL,
    open REAL NOT NULL,
    high REAL NOT NULL,
    low REAL NOT NULL,
    close REAL NOT NULL,
    volume INTEGER NOT NULL,
    split_factor REAL,
    PRIMARY KEY (ticker, date)
  )`)
  try {
    await run(client, 'ALTER TABLE ohlcv_daily ADD COLUMN split_factor REAL')
  } catch (error) {
    if (!String(error).includes('duplicate column name')) throw error
  }
  await run(client, `CREATE INDEX IF NOT EXISTS ohlcv_date_idx ON ohlcv_daily(date)`)
  await run(client, `CREATE INDEX IF NOT EXISTS ohlcv_date_ticker_idx ON ohlcv_daily(date, ticker)`)
  await run(client, `CREATE TABLE IF NOT EXISTS us_analytics_copy_state (
    ticker TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    ohlcv_rows INTEGER NOT NULL DEFAULT 0,
    snapshot_rows INTEGER NOT NULL DEFAULT 0,
    price_basis TEXT,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`)
  try {
    await run(client, 'ALTER TABLE us_analytics_copy_state ADD COLUMN price_basis TEXT')
  } catch (error) {
    if (!/duplicate column name/i.test(error instanceof Error ? error.message : String(error))) throw error
  }
  await run(client, `CREATE TABLE IF NOT EXISTS us_analytics_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`)
}

async function markPriceBasisIfComplete(client: Client, expectedCount: number): Promise<void> {
  const result = await client.execute({
    sql: `SELECT COUNT(*) AS count
          FROM us_analytics_copy_state
          WHERE status = 'done' AND price_basis = ?`,
    args: [US_ADJUSTED_PRICE_BASIS],
  })
  const count = Number(result.rows[0]?.count ?? 0)
  if (expectedCount === 0 || count < expectedCount) return
  await run(
    client,
    `INSERT INTO us_analytics_metadata (key, value, updated_at)
     VALUES ('ohlcv_price_basis', ?, unixepoch())
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()`,
    [US_ADJUSTED_PRICE_BASIS],
  )
}

async function main() {
  assertSafeTarget()
  console.log(`US analytics target: ${TARGET_PATH}`)
  console.log(
    `US analytics chunks: tickers=${COPY_CHUNK}, statements=${BATCH_CHUNK}, native=${NATIVE_COPY ? NATIVE_COPY_CHUNK : 'off'}`,
  )
  fs.mkdirSync(path.dirname(TARGET_PATH), { recursive: true })
  let target = createClient({ url: `file:${TARGET_PATH}` })
  await ensureTarget(target)
  await ensureSchema(target)

  const universe = await execAll<{
    ticker: string
    name: string | null
    active: number
    exchange: string | null
    sector: string | null
    industry: string | null
    shares_outstanding: number | null
  }>(
    `
    SELECT
      u.ticker,
      u.name,
      u.active,
      u.exchange,
      COALESCE(c.sector_name, u.sector) AS sector,
      COALESCE(c.industry_name, u.industry) AS industry,
      u.shares_outstanding
    FROM market_universe u
    LEFT JOIN market_classifications c
      ON c.market = u.market
     AND c.ticker = u.ticker
     AND c.taxonomy = ?
     AND c.effective_from = '0000-01-01'
    WHERE u.market = 'US'
    ORDER BY u.ticker
    ${LIMIT > 0 ? 'LIMIT ?' : ''}
    `,
    LIMIT > 0 ? [US_SEC_SIC_TAXONOMY, LIMIT] : [US_SEC_SIC_TAXONOMY],
  )
  await batch(target, universe.map((row) => ({
    sql: `
      INSERT INTO ticker_universe
        (ticker, name, active, shares_outstanding, sector17_name, sector33_name, market_segment, margin_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ticker) DO UPDATE SET
        name = excluded.name,
        active = excluded.active,
        shares_outstanding = excluded.shares_outstanding,
        sector17_name = excluded.sector17_name,
        sector33_name = excluded.sector33_name,
        market_segment = excluded.market_segment,
        margin_type = excluded.margin_type
    `,
    args: [
      row.ticker,
      row.name,
      isUsInvestableSymbol(row.ticker) ? row.active : 0,
      row.shares_outstanding,
      row.sector,
      row.industry,
      row.exchange,
      'US対象外',
    ],
  })))

  const tickers = universe.map((row) => row.ticker)
  const nativeCopyAvailable = NATIVE_COPY && fs.existsSync(localDbPath)
  if (nativeCopyAvailable) target.close()
  const synced = nativeSyncLatest(localDbPath)
  if (synced.ohlcvRows > 0 || synced.snapshotRows > 0) {
    console.log(
      `US analytics latest sync: ohlcvRows=${synced.ohlcvRows} after=${synced.ohlcvAfter ?? 'none'}, snapshots=${synced.snapshotRows} after=${synced.snapshotAfter ?? 'none'}`,
    )
  }
  if (nativeCopyAvailable) target = createClient({ url: `file:${TARGET_PATH}` })
  const doneRows = await target.execute({
    sql: REBUILD_PRICE_BASIS
      ? `SELECT ticker FROM us_analytics_copy_state WHERE status = 'done' AND price_basis = ?`
      : `SELECT ticker FROM us_analytics_copy_state WHERE status = 'done'`,
    args: REBUILD_PRICE_BASIS ? [US_ADJUSTED_PRICE_BASIS] : [],
  })
  const done = new Set(doneRows.rows.map((row) => String(row.ticker)))
  const pendingTickers = tickers.filter((ticker) => !done.has(ticker))
  if (nativeCopyAvailable) target.close()
  if (nativeCopyPending(pendingTickers, done.size)) {
    const finalTarget = createClient({ url: `file:${TARGET_PATH}` })
    try {
      await markPriceBasisIfComplete(finalTarget, tickers.length)
    } finally {
      finalTarget.close()
    }
    console.log(
      `US analytics DB ready: ${TARGET_PATH}, universe=${universe.length}, copied via native SQLite, skipped=${done.size}`,
    )
    return
  }
  let copied = 0
  let snapshotsCopied = 0
  for (let i = 0; i < pendingTickers.length; i += COPY_CHUNK) {
    const chunk = pendingTickers.slice(i, i + COPY_CHUNK)
    const placeholders = chunk.map(() => '?').join(',')
    const rows = await execAll<{
      ticker: string
      date: string
      open: number
      high: number
      low: number
      close: number
      volume: number
      splitFactor: number | null
    }>(
      `
      SELECT
        ticker,
        date,
        CASE WHEN adj_open IS NOT NULL THEN adj_open WHEN adj_close IS NOT NULL AND close <> 0 THEN open * adj_close / close ELSE open END AS open,
        CASE WHEN adj_high IS NOT NULL THEN adj_high WHEN adj_close IS NOT NULL AND close <> 0 THEN high * adj_close / close ELSE high END AS high,
        CASE WHEN adj_low IS NOT NULL THEN adj_low WHEN adj_close IS NOT NULL AND close <> 0 THEN low * adj_close / close ELSE low END AS low,
        COALESCE(adj_close, close) AS close,
        COALESCE(adj_volume, volume) AS volume,
        split_factor AS splitFactor
      FROM market_ohlcv_daily
      WHERE market = 'US' AND ticker IN (${placeholders})
      ORDER BY ticker, date
      `,
      chunk,
    )
    copied += rows.length
    await batch(target, rows.map((row) => ({
      sql: `
        INSERT INTO ohlcv_daily (ticker, date, open, high, low, close, volume, split_factor)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(ticker, date) DO UPDATE SET
          open = excluded.open,
          high = excluded.high,
          low = excluded.low,
          close = excluded.close,
          volume = excluded.volume,
          split_factor = excluded.split_factor
      `,
      args: [row.ticker, row.date, row.open, row.high, row.low, row.close, row.volume, row.splitFactor],
    })))

    const snapshotRows = await execAll<{
      ticker: string
      date: string
      ma_5: number | null
      ma_25: number | null
      ma_75: number | null
      ma_150: number | null
      ma_300: number | null
      weekly_ma_5: number | null
      weekly_ma_13: number | null
      weekly_ma_25: number | null
      weekly_ma_50: number | null
      weekly_ma_100: number | null
      monthly_ma_3: number | null
      monthly_ma_5: number | null
      monthly_ma_10: number | null
      monthly_ma_20: number | null
      monthly_ma_25: number | null
      daily_a_stage: number | null
      daily_b_stage: number | null
      weekly_a_stage: number | null
      weekly_b_stage: number | null
      monthly_a_stage: number | null
      monthly_b_stage: number | null
    }>(
      `
      SELECT ticker, date, ma_5, ma_25, ma_75, ma_150, ma_300,
             weekly_ma_5, weekly_ma_13, weekly_ma_25, weekly_ma_50, weekly_ma_100,
             monthly_ma_3, monthly_ma_5, monthly_ma_10, monthly_ma_20, monthly_ma_25,
             daily_a_stage, daily_b_stage, weekly_a_stage, weekly_b_stage, monthly_a_stage, monthly_b_stage
      FROM market_daily_snapshots
      WHERE market = 'US' AND ticker IN (${placeholders})
      ORDER BY ticker, date
      `,
      chunk,
    )
    snapshotsCopied += snapshotRows.length
    await batch(target, snapshotRows.map((row) => ({
      sql: `
        INSERT INTO daily_snapshots (
          ticker, date, ma_5, ma_25, ma_75, ma_150, ma_300,
          weekly_ma_5, weekly_ma_13, weekly_ma_25, weekly_ma_50, weekly_ma_100,
          monthly_ma_3, monthly_ma_5, monthly_ma_10, monthly_ma_20, monthly_ma_25,
          daily_a_stage, daily_b_stage, weekly_a_stage, weekly_b_stage, monthly_a_stage, monthly_b_stage
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(ticker, date) DO UPDATE SET
          ma_5 = excluded.ma_5,
          ma_25 = excluded.ma_25,
          ma_75 = excluded.ma_75,
          ma_150 = excluded.ma_150,
          ma_300 = excluded.ma_300,
          weekly_ma_5 = excluded.weekly_ma_5,
          weekly_ma_13 = excluded.weekly_ma_13,
          weekly_ma_25 = excluded.weekly_ma_25,
          weekly_ma_50 = excluded.weekly_ma_50,
          weekly_ma_100 = excluded.weekly_ma_100,
          monthly_ma_3 = excluded.monthly_ma_3,
          monthly_ma_5 = excluded.monthly_ma_5,
          monthly_ma_10 = excluded.monthly_ma_10,
          monthly_ma_20 = excluded.monthly_ma_20,
          monthly_ma_25 = excluded.monthly_ma_25,
          daily_a_stage = excluded.daily_a_stage,
          daily_b_stage = excluded.daily_b_stage,
          weekly_a_stage = excluded.weekly_a_stage,
          weekly_b_stage = excluded.weekly_b_stage,
          monthly_a_stage = excluded.monthly_a_stage,
          monthly_b_stage = excluded.monthly_b_stage,
          computed_at = unixepoch()
      `,
      args: [
        row.ticker,
        row.date,
        row.ma_5,
        row.ma_25,
        row.ma_75,
        row.ma_150,
        row.ma_300,
        row.weekly_ma_5,
        row.weekly_ma_13,
        row.weekly_ma_25,
        row.weekly_ma_50,
        row.weekly_ma_100,
        row.monthly_ma_3,
        row.monthly_ma_5,
        row.monthly_ma_10,
        row.monthly_ma_20,
        row.monthly_ma_25,
        row.daily_a_stage,
        row.daily_b_stage,
        row.weekly_a_stage,
        row.weekly_b_stage,
        row.monthly_a_stage,
        row.monthly_b_stage,
      ],
    })))
    const ohlcvByTicker = new Map<string, number>()
    for (const row of rows) ohlcvByTicker.set(row.ticker, (ohlcvByTicker.get(row.ticker) ?? 0) + 1)
    const snapshotsByTicker = new Map<string, number>()
    for (const row of snapshotRows) {
      snapshotsByTicker.set(row.ticker, (snapshotsByTicker.get(row.ticker) ?? 0) + 1)
    }
    await batch(target, chunk.map((ticker) => ({
      sql: `
        INSERT INTO us_analytics_copy_state (ticker, status, ohlcv_rows, snapshot_rows, price_basis, updated_at)
        VALUES (?, 'done', ?, ?, ?, unixepoch())
        ON CONFLICT(ticker) DO UPDATE SET
          status = 'done',
          ohlcv_rows = excluded.ohlcv_rows,
          snapshot_rows = excluded.snapshot_rows,
          price_basis = excluded.price_basis,
          updated_at = unixepoch()
      `,
      args: [
        ticker,
        ohlcvByTicker.get(ticker) ?? 0,
        snapshotsByTicker.get(ticker) ?? 0,
        US_ADJUSTED_PRICE_BASIS,
      ],
    })))
    console.log(
      `[${Math.min(i + COPY_CHUNK, pendingTickers.length)}/${pendingTickers.length}] copied ohlcv=${copied} snapshots=${snapshotsCopied} skipped=${done.size}`,
    )
  }
  await markPriceBasisIfComplete(target, tickers.length)
  target.close()
  console.log(
    `US analytics DB ready: ${TARGET_PATH}, universe=${universe.length}, copiedOhlcv=${copied}, copiedSnapshots=${snapshotsCopied}, skipped=${done.size}`,
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
