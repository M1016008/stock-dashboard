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
  // ─── Phase 2: 銘柄ユニバース ───
  `CREATE TABLE IF NOT EXISTS ticker_universe (
    ticker TEXT PRIMARY KEY,
    name TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    added_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  // ─── Phase 2: 日足 OHLCV 履歴 ───
  `CREATE TABLE IF NOT EXISTS ohlcv_daily (
    ticker TEXT NOT NULL,
    date TEXT NOT NULL,
    open REAL NOT NULL,
    high REAL NOT NULL,
    low REAL NOT NULL,
    close REAL NOT NULL,
    volume INTEGER NOT NULL,
    PRIMARY KEY (ticker, date)
  )`,
  `CREATE INDEX IF NOT EXISTS ohlcv_date_idx ON ohlcv_daily(date)`,
  // ─── Phase 2: 日次スナップショット (MA + ステージ) ───
  `CREATE TABLE IF NOT EXISTS daily_snapshots (
    ticker TEXT NOT NULL,
    date TEXT NOT NULL,
    ma_5 REAL,
    ma_25 REAL,
    ma_75 REAL,
    ma_150 REAL,
    ma_300 REAL,
    weekly_ma_5 REAL,
    weekly_ma_13 REAL,
    weekly_ma_25 REAL,
    weekly_ma_50 REAL,
    weekly_ma_100 REAL,
    monthly_ma_3 REAL,
    monthly_ma_5 REAL,
    monthly_ma_10 REAL,
    monthly_ma_20 REAL,
    monthly_ma_25 REAL,
    daily_a_stage INTEGER,
    daily_b_stage INTEGER,
    weekly_a_stage INTEGER,
    weekly_b_stage INTEGER,
    monthly_a_stage INTEGER,
    monthly_b_stage INTEGER,
    computed_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (ticker, date)
  )`,
  `CREATE INDEX IF NOT EXISTS snapshots_date_idx ON daily_snapshots(date)`,
  // ─── Phase 2: バッチ実行履歴 ───
  `CREATE TABLE IF NOT EXISTS batch_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_type TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    status TEXT NOT NULL,
    total_tickers INTEGER,
    succeeded INTEGER DEFAULT 0,
    failed INTEGER DEFAULT 0,
    rows_inserted INTEGER DEFAULT 0,
    error_summary TEXT
  )`,
  // ─── Phase 3: 特徴量スナップショット (3 timescale × 30+ 次元) ───
  `CREATE TABLE IF NOT EXISTS feature_snapshots (
    ticker TEXT NOT NULL,
    date TEXT NOT NULL,
    timescale TEXT NOT NULL,
    bin_order_a_12 INTEGER, bin_order_a_13 INTEGER, bin_order_a_23 INTEGER,
    bin_order_b_12 INTEGER, bin_order_b_13 INTEGER, bin_order_b_23 INTEGER,
    rel_dist_a_12 REAL, rel_dist_a_13 REAL, rel_dist_a_23 REAL,
    rel_dist_b_12 REAL, rel_dist_b_13 REAL, rel_dist_b_23 REAL,
    divergence_a REAL, divergence_b REAL,
    divergence_a_delta REAL, divergence_b_delta REAL,
    fan_uniformity REAL, divergence_percentile REAL,
    stage_a_age INTEGER, stage_b_age INTEGER,
    slope_m1 REAL, accel_m1 REAL,
    slope_m2 REAL, accel_m2 REAL,
    slope_m3 REAL, accel_m3 REAL,
    slope_m4 REAL, accel_m4 REAL,
    slope_m5 REAL, accel_m5 REAL,
    angle_synchrony REAL,
    stage_a_oh TEXT, stage_b_oh TEXT,
    computed_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (ticker, date, timescale)
  )`,
  `CREATE INDEX IF NOT EXISTS feat_date_idx ON feature_snapshots(date)`,
  `CREATE INDEX IF NOT EXISTS feat_ts_idx ON feature_snapshots(timescale, date)`,
  // ─── Phase 3: フォワードリターン (4 horizon) ───
  `CREATE TABLE IF NOT EXISTS forward_returns (
    ticker TEXT NOT NULL,
    date TEXT NOT NULL,
    horizon_days INTEGER NOT NULL,
    return_pct REAL NOT NULL,
    return_category TEXT NOT NULL,
    end_date TEXT NOT NULL,
    PRIMARY KEY (ticker, date, horizon_days)
  )`,
  `CREATE INDEX IF NOT EXISTS fwd_date_idx ON forward_returns(date)`,
  // ─── Phase 3: パターン統計 (6桁コード × horizon) ───
  `CREATE TABLE IF NOT EXISTS pattern_stats (
    pattern_code TEXT NOT NULL,
    horizon_days INTEGER NOT NULL,
    count INTEGER NOT NULL,
    p05 REAL, p25 REAL, p50 REAL, p75 REAL, p95 REAL,
    very_up_count INTEGER NOT NULL DEFAULT 0,
    up_count INTEGER NOT NULL DEFAULT 0,
    flat_count INTEGER NOT NULL DEFAULT 0,
    down_count INTEGER NOT NULL DEFAULT 0,
    very_down_count INTEGER NOT NULL DEFAULT 0,
    computed_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (pattern_code, horizon_days)
  )`,
  `CREATE INDEX IF NOT EXISTS pstat_code_idx ON pattern_stats(pattern_code)`,
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
