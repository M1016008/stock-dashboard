// lib/db/migrate.ts
// libsql ベースのスキーマ初期化。
// テーブルが無ければ CREATE する。drizzle-kit を別途実行しなくてもよい。
//
// schema.ts に新しいテーブルを追加したら、ここにも追記する。

import type { Client } from '@libsql/client'

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS ohlcv (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL,
    market TEXT NOT NULL,
    date TEXT NOT NULL,
    open REAL NOT NULL,
    high REAL NOT NULL,
    low REAL NOT NULL,
    close REAL NOT NULL,
    volume INTEGER NOT NULL,
    adjusted_close REAL,
    source TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS hex_stages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    sector_large TEXT,
    market_cap REAL,
    stage_a INTEGER NOT NULL,
    stage_b INTEGER,
    timeframe TEXT NOT NULL,
    close REAL,
    sma5 REAL,
    sma25 REAL,
    sma75 REAL,
    rsi14 REAL,
    macd REAL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS tv_indicators (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL,
    date TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    close REAL,
    sma5 REAL,
    sma25 REAL,
    sma75 REAL,
    sma200 REAL,
    ema5 REAL,
    ema25 REAL,
    rsi14 REAL,
    macd REAL,
    macd_signal REAL,
    macd_histogram REAL,
    bb_upper REAL,
    bb_middle REAL,
    bb_lower REAL,
    volume INTEGER,
    volume_ratio REAL,
    source TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS tv_daily_snapshots (
    date TEXT NOT NULL,
    ticker TEXT NOT NULL,
    name TEXT NOT NULL,
    price REAL,
    currency TEXT,
    change_percent_1d REAL,
    volume_1d INTEGER,
    avg_volume_10d INTEGER,
    avg_volume_30d INTEGER,
    market_cap REAL,
    market_cap_currency TEXT,
    per REAL,
    dividend_yield_pct REAL,
    perf_pct_1w REAL,
    perf_pct_1m REAL,
    perf_pct_3m REAL,
    perf_pct_6m REAL,
    perf_pct_ytd REAL,
    sma_5d REAL,
    sma_25d REAL,
    sma_75d REAL,
    sma_150d REAL,
    sma_300d REAL,
    sma_5w REAL,
    sma_13w REAL,
    sma_25w REAL,
    sma_50w REAL,
    sma_100w REAL,
    sma_3m REAL,
    sma_5m REAL,
    sma_10m REAL,
    sma_20m REAL,
    sma_25m REAL,
    earnings_last_date TEXT,
    earnings_next_date TEXT,
    imported_at TEXT NOT NULL,
    source_file TEXT,
    PRIMARY KEY (date, ticker)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tv_snapshots_ticker ON tv_daily_snapshots(ticker)`,
  `CREATE INDEX IF NOT EXISTS idx_tv_snapshots_earnings_next ON tv_daily_snapshots(earnings_next_date)`,
  `CREATE TABLE IF NOT EXISTS csv_imports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    file_name TEXT NOT NULL,
    row_count INTEGER NOT NULL,
    imported_at TEXT NOT NULL,
    detection_method TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS sector_master (
    ticker TEXT PRIMARY KEY,
    name TEXT,
    sector_large TEXT,
    sector_small TEXT,
    updated_at TEXT NOT NULL,
    source_file TEXT
  )`,
]

/** 廃止されたテーブル。存在していれば DROP する（再実行しても無害）。 */
const DEPRECATED_DROPS: string[] = [
  `DROP TABLE IF EXISTS screener_snapshots`,
]

/** 既存テーブルに後から追加するカラム。重複エラーは握りつぶす。 */
const ADD_COLUMN_IF_MISSING: string[] = [
  `ALTER TABLE sector_master ADD COLUMN market_segment TEXT`,
  `ALTER TABLE sector_master ADD COLUMN sector33 TEXT`,
  `ALTER TABLE sector_master ADD COLUMN margin_type TEXT`,
]

export async function ensureSchema(client: Client): Promise<void> {
  for (const sql of STATEMENTS) {
    await client.execute(sql)
  }
  for (const sql of DEPRECATED_DROPS) {
    try { await client.execute(sql) } catch { /* 無視 */ }
  }
  for (const sql of ADD_COLUMN_IF_MISSING) {
    try { await client.execute(sql) } catch (e) {
      const msg = (e as Error).message ?? ''
      if (!/duplicate column name/i.test(msg)) {
        // 致命的でないので警告のみ
        console.warn('[migrate] ADD COLUMN warning:', msg)
      }
    }
  }
}
