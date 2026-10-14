import path from 'node:path'
import { execAll, execBatch, localDbPath } from '@/lib/db/client'
import {
  US_ANALYTICAL_PRICE_ROW_EXCLUSIONS,
  usAnalyticalPricePolicyWindowSql,
  usAnalyticsPriceEligibleSql,
  usAnalyticsPriceIneligibleSql,
} from '@/lib/us-market-data-quality'

const POLICY_VERSION = 'us_market_data_quality_v1'
const APPLY = process.argv.includes('--apply')

const DERIVED_TICKER_TABLES = [
  'compute_state',
  'feature_snapshots',
  'forward_extrema',
  'forward_returns',
  'ml_feature_vectors',
  'ml_feature_vectors_v2',
  'ml_physics_feature_policy_cache',
  'ml_physics_feature_statuses',
  'ml_prediction_outcomes',
  'ml_predictions',
  'ml_short_labels',
  'ml_training_labels',
  'model_features',
  'model_labels',
  'rl_training_states',
  'rl_training_states_v2',
  'serving_backtest_details',
  'serving_backtest_results',
  'serving_latest_signals',
  'serving_ml_candidates',
  'serving_ml_physics_candidates',
  'serving_signal_evidence',
  'serving_stock_metrics',
  'serving_stock_move_periods',
  'technical_signals',
  'weekly_ohlcv',
] as const

type CountRow = { count: number }
type TableRow = { name: string }

function assertUsAnalyticsTarget(): void {
  if (process.env.STOCKBOARD_DB_ROLE !== 'us-analytics') {
    throw new Error('STOCKBOARD_DB_ROLE=us-analytics is required')
  }
  const configured = process.env.US_ANALYTICS_DB_PATH?.trim()
  if (!configured || path.resolve(configured) !== path.resolve(localDbPath)) {
    throw new Error('STOCKBOARD_DB_PATH must resolve to US_ANALYTICS_DB_PATH')
  }
  const source = process.env.STOCKBOARD_SOURCE_DB_PATH?.trim()
  if (source && path.resolve(source) === path.resolve(localDbPath)) {
    throw new Error('US analytics target must not be the primary source database')
  }
}

async function count(sql: string, args: string[] = []): Promise<number> {
  const rows = await execAll<CountRow>(sql, args)
  return Number(rows[0]?.count ?? 0)
}

async function main(): Promise<void> {
  assertUsAnalyticsTarget()
  const existingTables = new Set((await execAll<TableRow>(
    `SELECT name FROM sqlite_master WHERE type = 'table'`,
  )).map((row) => row.name))
  const tickers = US_ANALYTICAL_PRICE_ROW_EXCLUSIONS.map((policy) => policy.ticker)
  const placeholders = tickers.map(() => '?').join(', ')
  const counts: Record<string, number> = {}

  if (existingTables.has('ohlcv_daily')) {
    counts.ohlcv_daily = await count(
      `SELECT COUNT(*) AS count FROM ohlcv_daily WHERE ${usAnalyticsPriceIneligibleSql('ohlcv_daily')}`,
    )
  }
  if (existingTables.has('daily_snapshots')) {
    counts.daily_snapshots = await count(
      `SELECT COUNT(*) AS count
       FROM daily_snapshots
       WHERE (${usAnalyticalPricePolicyWindowSql('daily_snapshots')})
         AND NOT EXISTS (
           SELECT 1 FROM ohlcv_daily observed
           WHERE observed.ticker = daily_snapshots.ticker
             AND observed.date = daily_snapshots.date
             AND ${usAnalyticsPriceEligibleSql('observed')}
         )`,
    )
  }
  for (const table of DERIVED_TICKER_TABLES) {
    if (!existingTables.has(table)) continue
    counts[table] = await count(
      `SELECT COUNT(*) AS count FROM ${table} WHERE ticker IN (${placeholders})`,
      tickers,
    )
  }

  const report = {
    mode: APPLY ? 'APPLY' : 'DRY_RUN',
    policyVersion: POLICY_VERSION,
    database: localDbPath,
    rawSourceChanged: false,
    affectedRows: counts,
    totalAffectedRows: Object.values(counts).reduce((sum, value) => sum + value, 0),
  }
  console.log(JSON.stringify(report, null, 2))
  if (!APPLY) return

  const statements: Array<{ sql: string; args: string[] }> = []
  if (existingTables.has('ohlcv_daily')) {
    statements.push({
      sql: `DELETE FROM ohlcv_daily WHERE ${usAnalyticsPriceIneligibleSql('ohlcv_daily')}`,
      args: [],
    })
  }
  if (existingTables.has('daily_snapshots')) {
    statements.push({
      sql: `DELETE FROM daily_snapshots
            WHERE (${usAnalyticalPricePolicyWindowSql('daily_snapshots')})
              AND NOT EXISTS (
                SELECT 1 FROM ohlcv_daily observed
                WHERE observed.ticker = daily_snapshots.ticker
                  AND observed.date = daily_snapshots.date
              )`,
      args: [],
    })
  }
  for (const table of DERIVED_TICKER_TABLES) {
    if (!existingTables.has(table)) continue
    statements.push({
      sql: `DELETE FROM ${table} WHERE ticker IN (${placeholders})`,
      args: tickers,
    })
  }
  if (existingTables.has('us_analytics_metadata')) {
    statements.push({
      sql: `INSERT INTO us_analytics_metadata (key, value, updated_at)
            VALUES ('market_data_quality_policy', ?, unixepoch())
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()`,
      args: [POLICY_VERSION],
    })
  }
  await execBatch(statements)
  console.log(`US market-data quality policy applied: ${POLICY_VERSION}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
