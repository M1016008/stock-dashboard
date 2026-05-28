// US market_* tablesから、既存JP分析パイプライン互換のUS専用SQLite DBを作る。
// 生成後は STOCKBOARD_DB_PATH=<US_ANALYTICS_DB_PATH> npm run batch:ml-full のように既存MLを流用できる。

import path from 'node:path'
import fs from 'node:fs'
import { createClient, type Client } from '@libsql/client'
import { execAll } from '@/lib/db/client'
import { ensureSchema } from '@/lib/db/migrate'
import { US_SEC_SIC_TAXONOMY } from '@/lib/us-classification'

const TARGET_PATH = path.resolve(process.env.US_ANALYTICS_DB_PATH ?? 'data/stockboard-us.db')
const LIMIT = Number(process.env.US_ANALYTICS_LIMIT ?? 0)
const COPY_CHUNK = Math.max(1, Number(process.env.US_ANALYTICS_CHUNK ?? 50))

async function run(client: Client, sql: string, args: Array<string | number | null> = []) {
  await client.execute({ sql, args })
}

async function batch(client: Client, statements: Array<{ sql: string; args: Array<string | number | null> }>) {
  const CHUNK = 500
  for (let i = 0; i < statements.length; i += CHUNK) {
    await client.batch(statements.slice(i, i + CHUNK))
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
    PRIMARY KEY (ticker, date)
  )`)
  await run(client, `CREATE INDEX IF NOT EXISTS ohlcv_date_idx ON ohlcv_daily(date)`)
  await run(client, `CREATE INDEX IF NOT EXISTS ohlcv_date_ticker_idx ON ohlcv_daily(date, ticker)`)
  await run(client, `CREATE TABLE IF NOT EXISTS us_analytics_copy_state (
    ticker TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    ohlcv_rows INTEGER NOT NULL DEFAULT 0,
    snapshot_rows INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`)
}

async function main() {
  fs.mkdirSync(path.dirname(TARGET_PATH), { recursive: true })
  const target = createClient({ url: `file:${TARGET_PATH}` })
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
      row.active,
      row.shares_outstanding,
      row.sector,
      row.industry,
      row.exchange,
      'US対象外',
    ],
  })))

  const tickers = universe.map((row) => row.ticker)
  const doneRows = await target.execute({
    sql: `SELECT ticker FROM us_analytics_copy_state WHERE status = 'done'`,
    args: [],
  })
  const done = new Set(doneRows.rows.map((row) => String(row.ticker)))
  const pendingTickers = tickers.filter((ticker) => !done.has(ticker))
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
    }>(
      `
      SELECT ticker, date, open, high, low, close, volume
      FROM market_ohlcv_daily
      WHERE market = 'US' AND ticker IN (${placeholders})
      ORDER BY ticker, date
      `,
      chunk,
    )
    copied += rows.length
    await batch(target, rows.map((row) => ({
      sql: `
        INSERT INTO ohlcv_daily (ticker, date, open, high, low, close, volume)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(ticker, date) DO UPDATE SET
          open = excluded.open,
          high = excluded.high,
          low = excluded.low,
          close = excluded.close,
          volume = excluded.volume
      `,
      args: [row.ticker, row.date, row.open, row.high, row.low, row.close, row.volume],
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
        INSERT INTO us_analytics_copy_state (ticker, status, ohlcv_rows, snapshot_rows, updated_at)
        VALUES (?, 'done', ?, ?, unixepoch())
        ON CONFLICT(ticker) DO UPDATE SET
          status = 'done',
          ohlcv_rows = excluded.ohlcv_rows,
          snapshot_rows = excluded.snapshot_rows,
          updated_at = unixepoch()
      `,
      args: [ticker, ohlcvByTicker.get(ticker) ?? 0, snapshotsByTicker.get(ticker) ?? 0],
    })))
    console.log(
      `[${Math.min(i + COPY_CHUNK, pendingTickers.length)}/${pendingTickers.length}] copied ohlcv=${copied} snapshots=${snapshotsCopied} skipped=${done.size}`,
    )
  }
  console.log(
    `US analytics DB ready: ${TARGET_PATH}, universe=${universe.length}, copiedOhlcv=${copied}, copiedSnapshots=${snapshotsCopied}, skipped=${done.size}`,
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
