import path from 'node:path'
import { execAll, execBatch, execGet, localDbPath } from '@/lib/db/client'
import { MAX_CONTIGUOUS_BAR_GAP_DAYS } from '@/lib/backtest/forward-extrema'

type CountRow = { count: number }
type TableRow = { name: string }

const APPLY = process.argv.includes('--apply') || process.env.US_ML_CONTINUITY_APPLY === '1'
const DIRECT_DEPENDENCIES = [
  { table: 'model_labels', dateColumn: 'date' },
  { table: 'ml_training_labels', dateColumn: 'date' },
  { table: 'ml_short_labels', dateColumn: 'date' },
  { table: 'rl_training_states', dateColumn: 'date' },
  { table: 'rl_training_states_v2', dateColumn: 'date' },
  { table: 'ml_prediction_outcomes', dateColumn: 'as_of_date' },
] as const

async function tableExists(name: string): Promise<boolean> {
  const row = await execGet<TableRow>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    [name],
  )
  return row?.name === name
}

async function count(sql: string): Promise<number> {
  const rows = await execAll<CountRow>(sql)
  return Number(rows[0]?.count ?? 0)
}

function assertApplyTarget(): void {
  if (!APPLY) return
  const configuredUsPath = process.env.US_ANALYTICS_DB_PATH?.trim()
  if (process.env.STOCKBOARD_DB_ROLE !== 'us-analytics') {
    throw new Error('continuity repair apply requires STOCKBOARD_DB_ROLE=us-analytics')
  }
  if (!configuredUsPath || path.resolve(configuredUsPath) !== path.resolve(localDbPath)) {
    throw new Error('continuity repair apply requires STOCKBOARD_DB_PATH to match US_ANALYTICS_DB_PATH')
  }
}

async function buildRepairPlan(): Promise<void> {
  await execBatch([
    { sql: 'DROP TABLE IF EXISTS temp.continuity_gaps', args: [] },
    { sql: 'DROP TABLE IF EXISTS temp.continuity_invalid_extrema', args: [] },
    { sql: 'DROP TABLE IF EXISTS temp.continuity_invalid_returns', args: [] },
    {
      sql: `
        CREATE TEMP TABLE continuity_gaps (
          ticker TEXT NOT NULL,
          previous_date TEXT NOT NULL,
          next_date TEXT NOT NULL,
          PRIMARY KEY (ticker, previous_date, next_date)
        )
      `,
      args: [],
    },
    {
      sql: `
        INSERT INTO continuity_gaps (ticker, previous_date, next_date)
        WITH ordered AS (
          SELECT
            ticker,
            date,
            LAG(date) OVER (PARTITION BY ticker ORDER BY date) AS previous_date
          FROM ohlcv_daily
        )
        SELECT ticker, previous_date, date
        FROM ordered
        WHERE julianday(date) - julianday(previous_date) > ${MAX_CONTIGUOUS_BAR_GAP_DAYS}
      `,
      args: [],
    },
    {
      sql: `
        CREATE TEMP TABLE continuity_invalid_extrema (
          ticker TEXT NOT NULL,
          date TEXT NOT NULL,
          horizon_days INTEGER NOT NULL,
          PRIMARY KEY (ticker, date, horizon_days)
        )
      `,
      args: [],
    },
    {
      sql: `
        INSERT OR IGNORE INTO continuity_invalid_extrema (ticker, date, horizon_days)
        SELECT fe.ticker, fe.date, fe.horizon_days
        FROM continuity_gaps gaps
        CROSS JOIN forward_extrema fe INDEXED BY sqlite_autoindex_forward_extrema_1
          ON fe.ticker = gaps.ticker
         AND fe.date <= gaps.previous_date
         AND fe.end_date >= gaps.next_date
      `,
      args: [],
    },
    {
      sql: `
        CREATE TEMP TABLE continuity_invalid_returns (
          ticker TEXT NOT NULL,
          date TEXT NOT NULL,
          horizon_days INTEGER NOT NULL,
          PRIMARY KEY (ticker, date, horizon_days)
        )
      `,
      args: [],
    },
    {
      sql: `
        INSERT OR IGNORE INTO continuity_invalid_returns (ticker, date, horizon_days)
        SELECT fr.ticker, fr.date, fr.horizon_days
        FROM continuity_gaps gaps
        CROSS JOIN forward_returns fr INDEXED BY sqlite_autoindex_forward_returns_1
          ON fr.ticker = gaps.ticker
         AND fr.date <= gaps.previous_date
         AND fr.end_date >= gaps.next_date
      `,
      args: [],
    },
  ])
}

async function applyRepair(): Promise<void> {
  const statements: Parameters<typeof execBatch>[0] = []
  for (const { table, dateColumn } of DIRECT_DEPENDENCIES) {
    if (!await tableExists(table)) continue
    statements.push({
      sql: `
        DELETE FROM ${table}
        WHERE EXISTS (
          SELECT 1
          FROM continuity_invalid_extrema invalid
          WHERE invalid.ticker = ${table}.ticker
            AND invalid.date = ${table}.${dateColumn}
            AND invalid.horizon_days = ${table}.horizon_days
        )
      `,
      args: [],
    })
  }
  statements.push(
    {
      sql: `
        DELETE FROM forward_extrema
        WHERE EXISTS (
          SELECT 1
          FROM continuity_invalid_extrema invalid
          WHERE invalid.ticker = forward_extrema.ticker
            AND invalid.date = forward_extrema.date
            AND invalid.horizon_days = forward_extrema.horizon_days
        )
      `,
      args: [],
    },
    {
      sql: `
        DELETE FROM forward_returns
        WHERE EXISTS (
          SELECT 1
          FROM continuity_invalid_returns invalid
          WHERE invalid.ticker = forward_returns.ticker
            AND invalid.date = forward_returns.date
            AND invalid.horizon_days = forward_returns.horizon_days
        )
      `,
      args: [],
    },
  )
  if (await tableExists('forward_extrema_date_coverage')) {
    statements.push({
      sql: `
        DELETE FROM forward_extrema_date_coverage
        WHERE NOT EXISTS (
          SELECT 1
          FROM forward_extrema fe
          WHERE fe.horizon_days = forward_extrema_date_coverage.horizon_days
            AND fe.date = forward_extrema_date_coverage.date
        )
      `,
      args: [],
    })
  }
  await execBatch(statements)
}

async function main(): Promise<void> {
  assertApplyTarget()
  await buildRepairPlan()
  const before = {
    gapBoundaries: await count('SELECT COUNT(*) AS count FROM continuity_gaps'),
    gapTickers: await count('SELECT COUNT(DISTINCT ticker) AS count FROM continuity_gaps'),
    invalidExtrema: await count('SELECT COUNT(*) AS count FROM continuity_invalid_extrema'),
    invalidExtremaTickers: await count('SELECT COUNT(DISTINCT ticker) AS count FROM continuity_invalid_extrema'),
    invalidReturns: await count('SELECT COUNT(*) AS count FROM continuity_invalid_returns'),
    invalidReturnTickers: await count('SELECT COUNT(DISTINCT ticker) AS count FROM continuity_invalid_returns'),
  }

  if (!APPLY) {
    console.log(JSON.stringify({ mode: 'DRY_RUN', database: localDbPath, maxGapDays: MAX_CONTIGUOUS_BAR_GAP_DAYS, before }, null, 2))
    return
  }

  await applyRepair()
  const after = {
    invalidExtrema: await count(`
      SELECT COUNT(*) AS count
      FROM forward_extrema source
      INNER JOIN continuity_invalid_extrema invalid
        ON invalid.ticker = source.ticker
       AND invalid.date = source.date
       AND invalid.horizon_days = source.horizon_days
    `),
    invalidReturns: await count(`
      SELECT COUNT(*) AS count
      FROM forward_returns source
      INNER JOIN continuity_invalid_returns invalid
        ON invalid.ticker = source.ticker
       AND invalid.date = source.date
       AND invalid.horizon_days = source.horizon_days
    `),
  }
  if (after.invalidExtrema !== 0 || after.invalidReturns !== 0) {
    throw new Error(`continuity repair incomplete: extrema=${after.invalidExtrema}, returns=${after.invalidReturns}`)
  }
  console.log(JSON.stringify({
    mode: 'APPLY',
    database: localDbPath,
    maxGapDays: MAX_CONTIGUOUS_BAR_GAP_DAYS,
    before,
    after,
    rebuildRequired: [
      'ml_similarity_evaluations',
      'ml_rl_policy_evaluations',
      'ml_physics_status_evaluations',
      'serving_backtest_results',
    ],
  }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
