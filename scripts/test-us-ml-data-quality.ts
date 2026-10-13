import assert from 'node:assert/strict'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClient, type Client } from '@libsql/client'

const root = process.cwd()
const tsx = path.join(root, 'node_modules', '.bin', 'tsx')
const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'stockboard-us-ml-quality-'))

function runScript(
  script: string,
  databasePath: string,
  extraEnv: Record<string, string> = {},
): SpawnSyncReturns<string> {
  return spawnSync(tsx, [script], {
    cwd: root,
    env: {
      ...process.env,
      TURSO_DATABASE_URL: '',
      TURSO_AUTH_TOKEN: '',
      USE_LOCAL_DB: '1',
      EXTERNAL_STORAGE_REQUIRED: 'false',
      STOCKBOARD_DB_ROLE: '',
      STOCKBOARD_DB_PATH: databasePath,
      SKIP_SCHEMA_ENSURE: '1',
      ...extraEnv,
    },
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
  })
}

function commandOutput(result: SpawnSyncReturns<string>): string {
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim()
}

async function executeAll(client: Client, statements: string[]): Promise<void> {
  await client.batch(statements.map((sql) => ({ sql, args: [] })), 'write')
}

async function countRows(client: Client, sql: string, args: Array<string | number> = []): Promise<number> {
  const result = await client.execute({ sql, args })
  return Number(result.rows[0]?.count ?? 0)
}

async function testForwardReturnContinuity(): Promise<void> {
  const databasePath = path.join(temporaryDirectory, 'forward-returns.db')
  const client = createClient({ url: `file:${databasePath}` })
  await executeAll(client, [
    `CREATE TABLE batch_runs (
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
    `CREATE TABLE ohlcv_daily (
      ticker TEXT NOT NULL,
      date TEXT NOT NULL,
      close REAL NOT NULL,
      PRIMARY KEY (ticker, date)
    )`,
    `CREATE TABLE forward_returns (
      ticker TEXT NOT NULL,
      date TEXT NOT NULL,
      horizon_days INTEGER NOT NULL,
      return_pct REAL NOT NULL,
      return_category TEXT NOT NULL,
      end_date TEXT NOT NULL,
      PRIMARY KEY (ticker, date, horizon_days)
    )`,
  ])
  const dates = [
    ...Array.from({ length: 6 }, (_, index) => `2019-03-${String(index + 1).padStart(2, '0')}`),
    ...Array.from({ length: 6 }, (_, index) => `2026-06-${String(index + 1).padStart(2, '0')}`),
  ]
  await client.batch(dates.map((date, index) => ({
    sql: 'INSERT INTO ohlcv_daily (ticker, date, close) VALUES (?, ?, ?)',
    args: ['REUSED', date, index < 6 ? 0.000001 + index * 0.00000001 : 90 + index],
  })), 'write')
  await client.execute({
    sql: `INSERT INTO forward_returns
      (ticker, date, horizon_days, return_pct, return_category, end_date)
      VALUES ('REUSED', '2019-03-02', 5, 999999999, 'very_up', '2026-06-01')`,
    args: [],
  })
  client.close()

  const result = runScript('scripts/batch-forward-returns.ts', databasePath, {
    TICKERS: 'REUSED',
    FORWARD_RETURN_HORIZONS: '5',
  })
  assert.equal(result.status, 0, commandOutput(result))

  const verify = createClient({ url: `file:${databasePath}` })
  const rows = await verify.execute(
    'SELECT date, end_date FROM forward_returns ORDER BY date',
  )
  assert.deepEqual(rows.rows.map((row) => [String(row.date), String(row.end_date)]), [
    ['2019-03-01', '2019-03-06'],
    ['2026-06-01', '2026-06-06'],
  ], commandOutput(result))
  verify.close()
}

async function testEmptyExtremaCleanup(): Promise<void> {
  const databasePath = path.join(temporaryDirectory, 'forward-extrema.db')
  const client = createClient({ url: `file:${databasePath}` })
  await executeAll(client, [
    `CREATE TABLE ohlcv_daily (
      ticker TEXT NOT NULL,
      date TEXT NOT NULL,
      high REAL NOT NULL,
      low REAL NOT NULL,
      close REAL NOT NULL,
      PRIMARY KEY (ticker, date)
    )`,
    `CREATE TABLE forward_extrema (
      ticker TEXT NOT NULL,
      date TEXT NOT NULL,
      horizon_days INTEGER NOT NULL,
      return_pct REAL,
      end_date TEXT,
      max_return_pct REAL,
      max_return_date TEXT,
      days_to_max INTEGER,
      min_return_pct REAL,
      min_return_date TEXT,
      days_to_min INTEGER,
      hit_10 INTEGER NOT NULL DEFAULT 0,
      hit_20 INTEGER NOT NULL DEFAULT 0,
      hit_40 INTEGER NOT NULL DEFAULT 0,
      days_to_10 INTEGER,
      days_to_20 INTEGER,
      days_to_40 INTEGER,
      computed_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (ticker, date, horizon_days)
    )`,
    'CREATE INDEX fext_horizon_date_idx ON forward_extrema(horizon_days, date)',
    `CREATE TABLE forward_extrema_date_coverage (
      horizon_days INTEGER NOT NULL,
      date TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (horizon_days, date)
    )`,
    `CREATE TABLE model_labels (
      ticker TEXT NOT NULL,
      date TEXT NOT NULL,
      horizon_days INTEGER NOT NULL,
      return_pct REAL,
      max_return_pct REAL,
      min_return_pct REAL,
      days_to_max INTEGER,
      hit_10 INTEGER NOT NULL DEFAULT 0,
      hit_20 INTEGER NOT NULL DEFAULT 0,
      hit_40 INTEGER NOT NULL DEFAULT 0,
      reward_score REAL,
      label_json TEXT,
      computed_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (ticker, date, horizon_days)
    )`,
  ])
  await client.batch([
    ...['2026-01-01', '2026-01-02', '2026-01-03'].map((date, index) => ({
      sql: 'INSERT INTO ohlcv_daily (ticker, date, high, low, close) VALUES (?, ?, ?, ?, ?)',
      args: ['SHORT', date, 101 + index, 99 + index, 100 + index],
    })),
    {
      sql: `INSERT INTO forward_extrema
        (ticker, date, horizon_days, return_pct, end_date, max_return_pct, max_return_date, days_to_max,
         min_return_pct, min_return_date, days_to_min)
        VALUES ('SHORT', '2026-01-01', 5, 10, '2026-02-01', 10, '2026-02-01', 5, -1, '2026-01-02', 1)`,
      args: [],
    },
    {
      sql: `INSERT INTO model_labels
        (ticker, date, horizon_days, return_pct, max_return_pct, min_return_pct, days_to_max, label_json)
        VALUES ('SHORT', '2026-01-01', 5, 10, 10, -1, 5, '{}')`,
      args: [],
    },
    {
      sql: "INSERT INTO forward_extrema_date_coverage (horizon_days, date) VALUES (5, '2026-01-01')",
      args: [],
    },
  ], 'write')
  client.close()

  const result = runScript('scripts/batch-forward-extrema.ts', databasePath, {
    TICKERS: 'SHORT',
    BACKTEST_RECENT_DAYS: '0',
    FORWARD_EXTREMA_HORIZONS: '5',
    FORWARD_EXTREMA_WRITE_MODEL_LABELS: '1',
    FORWARD_EXTREMA_INCREMENTAL_UPSERT: '0',
  })
  assert.equal(result.status, 0, commandOutput(result))

  const verify = createClient({ url: `file:${databasePath}` })
  assert.equal(await countRows(verify, 'SELECT COUNT(*) AS count FROM forward_extrema'), 0)
  assert.equal(await countRows(verify, 'SELECT COUNT(*) AS count FROM model_labels'), 0)
  assert.equal(await countRows(verify, 'SELECT COUNT(*) AS count FROM forward_extrema_date_coverage'), 0)
  verify.close()
}

async function testOrphanCleanup(): Promise<void> {
  const databasePath = path.join(temporaryDirectory, 'short-labels.db')
  const client = createClient({ url: `file:${databasePath}` })
  await executeAll(client, [
    `CREATE TABLE forward_extrema (
      ticker TEXT NOT NULL,
      date TEXT NOT NULL,
      horizon_days INTEGER NOT NULL,
      return_pct REAL,
      max_return_pct REAL,
      min_return_pct REAL,
      max_return_date TEXT,
      min_return_date TEXT,
      days_to_max INTEGER,
      days_to_min INTEGER,
      PRIMARY KEY (ticker, date, horizon_days)
    )`,
    'CREATE INDEX fext_date_horizon_idx ON forward_extrema(date, horizon_days)',
    `CREATE TABLE ml_short_labels (
      ticker TEXT NOT NULL,
      date TEXT NOT NULL,
      horizon_days INTEGER NOT NULL,
      return_pct REAL,
      max_return_pct REAL,
      min_return_pct REAL,
      up_label INTEGER NOT NULL DEFAULT 0,
      down_label INTEGER NOT NULL DEFAULT 0,
      wait_label INTEGER NOT NULL DEFAULT 0,
      reward_long REAL,
      reward_short REAL,
      reward_wait REAL,
      label_json TEXT NOT NULL,
      computed_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (ticker, date, horizon_days)
    )`,
    `CREATE TABLE ml_feature_vectors_v2 (
      ticker TEXT NOT NULL,
      date TEXT NOT NULL,
      feature_set TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      feature_json TEXT NOT NULL,
      vector_json TEXT NOT NULL,
      PRIMARY KEY (ticker, date, feature_set)
    )`,
    `CREATE TABLE rl_training_states_v2 (
      ticker TEXT NOT NULL,
      date TEXT NOT NULL,
      horizon_days INTEGER NOT NULL,
      action TEXT NOT NULL,
      state_json TEXT NOT NULL,
      reward REAL,
      next_state_json TEXT,
      computed_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (ticker, date, horizon_days, action)
    )`,
  ])
  await client.batch([
    {
      sql: `INSERT INTO forward_extrema
        (ticker, date, horizon_days, return_pct, max_return_pct, min_return_pct,
         max_return_date, min_return_date, days_to_max, days_to_min)
        VALUES ('VALID', '2026-01-02', 5, 4, 6, -2, '2026-01-06', '2026-01-03', 4, 1)`,
      args: [],
    },
    {
      sql: `INSERT INTO ml_feature_vectors_v2
        (ticker, date, feature_set, version, feature_json, vector_json)
        VALUES ('VALID', '2026-01-02', 'ma_physics_v4', 4, '{}', '[]')`,
      args: [],
    },
    {
      sql: `INSERT INTO ml_short_labels
        (ticker, date, horizon_days, label_json)
        VALUES ('ORPHAN', '2019-01-01', 5, '{}')`,
      args: [],
    },
    {
      sql: `INSERT INTO rl_training_states_v2
        (ticker, date, horizon_days, action, state_json)
        VALUES ('ORPHAN', '2019-01-01', 5, 'wait', '{}')`,
      args: [],
    },
    {
      sql: `INSERT INTO ml_short_labels
        (ticker, date, horizon_days, label_json)
        VALUES ('UNRELATED', '2018-01-01', 5, '{}')`,
      args: [],
    },
    {
      sql: `INSERT INTO rl_training_states_v2
        (ticker, date, horizon_days, action, state_json)
        VALUES ('UNRELATED', '2018-01-01', 5, 'wait', '{}')`,
      args: [],
    },
  ], 'write')
  client.close()

  const result = runScript('scripts/batch-ml-short-labels.ts', databasePath, {
    TICKERS: 'VALID,ORPHAN',
    ML_SHORT_HORIZONS: '5',
    ML_SHORT_LABEL_RECENT_DAYS: '0',
    ML_SHORT_WRITE_RL_STATES: '1',
    ML_SHORT_LABEL_AUTO_CHUNK_DAYS: '30',
    ML_SHORT_RL_DATE_CHUNK_DAYS: '90',
  })
  assert.equal(result.status, 0, commandOutput(result))

  const verify = createClient({ url: `file:${databasePath}` })
  assert.equal(await countRows(verify, "SELECT COUNT(*) AS count FROM ml_short_labels WHERE ticker = 'ORPHAN'"), 0)
  assert.equal(await countRows(verify, "SELECT COUNT(*) AS count FROM rl_training_states_v2 WHERE ticker = 'ORPHAN'"), 0)
  assert.equal(await countRows(verify, "SELECT COUNT(*) AS count FROM ml_short_labels WHERE ticker = 'VALID'"), 1)
  assert.equal(await countRows(verify, "SELECT COUNT(*) AS count FROM rl_training_states_v2 WHERE ticker = 'VALID'"), 3)
  assert.equal(await countRows(verify, "SELECT COUNT(*) AS count FROM ml_short_labels WHERE ticker = 'UNRELATED'"), 1)
  assert.equal(await countRows(verify, "SELECT COUNT(*) AS count FROM rl_training_states_v2 WHERE ticker = 'UNRELATED'"), 1)
  verify.close()
}

async function testSimilarityStrictGate(): Promise<void> {
  const databasePath = path.join(temporaryDirectory, 'similarity.db')
  const client = createClient({ url: `file:${databasePath}` })
  await executeAll(client, [
    'CREATE TABLE ohlcv_daily (ticker TEXT NOT NULL, date TEXT NOT NULL, close REAL NOT NULL)',
    `CREATE TABLE ml_short_labels (
      ticker TEXT NOT NULL,
      date TEXT NOT NULL,
      horizon_days INTEGER NOT NULL,
      return_pct REAL,
      max_return_pct REAL,
      min_return_pct REAL,
      up_label INTEGER NOT NULL DEFAULT 0,
      down_label INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (ticker, date, horizon_days)
    )`,
    `CREATE TABLE serving_current_similars (
      as_of_date TEXT NOT NULL,
      base_ticker TEXT NOT NULL,
      rank INTEGER NOT NULL,
      similar_ticker TEXT NOT NULL,
      similarity_score REAL NOT NULL,
      PRIMARY KEY (as_of_date, base_ticker, rank)
    )`,
    `CREATE TABLE ml_similarity_evaluations (
      as_of_date TEXT NOT NULL,
      horizon_days INTEGER NOT NULL,
      source TEXT NOT NULL,
      base_count INTEGER NOT NULL DEFAULT 0,
      pair_count INTEGER NOT NULL DEFAULT 0,
      up_rate REAL,
      down_rate REAL,
      median_return_pct REAL,
      avg_return_pct REAL,
      max_drawdown_pct REAL,
      payload_json TEXT NOT NULL,
      computed_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (as_of_date, horizon_days, source)
    )`,
  ])
  await client.batch([
    ...Array.from({ length: 7 }, (_, index) => ({
      sql: 'INSERT INTO ohlcv_daily (ticker, date, close) VALUES (?, ?, ?)',
      args: ['BASE', `2026-01-${String(index + 1).padStart(2, '0')}`, 100 + index],
    })),
    {
      sql: `INSERT INTO serving_current_similars
        (as_of_date, base_ticker, rank, similar_ticker, similarity_score)
        VALUES ('2026-01-02', 'BASE', 1, 'SIM', 0.95)`,
      args: [],
    },
    {
      sql: `INSERT INTO ml_short_labels
        (ticker, date, horizon_days, return_pct, max_return_pct, min_return_pct, up_label, down_label)
        VALUES ('SIM', '2026-01-01', 5, 3, 5, -1, 1, 0)`,
      args: [],
    },
  ], 'write')
  client.close()

  const strictEnv = {
    ML_SIMILARITY_EVAL_HORIZONS: '5',
    ML_SIMILARITY_EVAL_STRICT: '1',
    ML_SIMILARITY_EVAL_TOP_RANK: '5',
  }
  const stale = runScript('scripts/batch-ml-similarity-evaluate.ts', databasePath, strictEnv)
  assert.notEqual(stale.status, 0, 'stale similarity labels must fail closed')
  assert.match(commandOutput(stale), /similarity labels stale/)

  const update = createClient({ url: `file:${databasePath}` })
  await update.execute({
    sql: `INSERT INTO ml_short_labels
      (ticker, date, horizon_days, return_pct, max_return_pct, min_return_pct, up_label, down_label)
      VALUES ('SIM', '2026-01-02', 5, 4, 7, -2, 1, 0)`,
    args: [],
  })
  update.close()

  const current = runScript('scripts/batch-ml-similarity-evaluate.ts', databasePath, strictEnv)
  assert.equal(current.status, 0, commandOutput(current))
  const verify = createClient({ url: `file:${databasePath}` })
  assert.equal(await countRows(verify, 'SELECT COUNT(*) AS count FROM ml_similarity_evaluations'), 1)
  verify.close()
}

async function main(): Promise<void> {
  try {
    await testForwardReturnContinuity()
    await testEmptyExtremaCleanup()
    await testOrphanCleanup()
    await testSimilarityStrictGate()
    console.log('US ML data-quality regression passed')
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
