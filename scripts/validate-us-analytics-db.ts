// Validate that the US analytics SQLite is complete enough before running ML.

import path from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { expectedLatestUsTradingDate } from '@/lib/server/us-data-freshness'
import { US_ADJUSTED_PRICE_BASIS } from '@/lib/us-adjusted-ohlcv'

const configuredTargetPath = process.env.US_ANALYTICS_DB_PATH?.trim()
const TARGET_PATH = path.resolve(configuredTargetPath || 'data/stockboard-us.db')
const MIN_COPY_DONE = Number(process.env.US_ANALYTICS_MIN_COPY_DONE ?? 20500)
const MIN_OHLCV_TICKERS = Number(process.env.US_ANALYTICS_MIN_OHLCV_TICKERS ?? 18000)
const MIN_SNAPSHOT_TICKERS = Number(process.env.US_ANALYTICS_MIN_SNAPSHOT_TICKERS ?? 18000)
const MIN_OHLCV_ROWS = Number(process.env.US_ANALYTICS_MIN_OHLCV_ROWS ?? 40000000)
const MIN_SNAPSHOT_ROWS = Number(process.env.US_ANALYTICS_MIN_SNAPSHOT_ROWS ?? 40000000)
const MIN_LATEST_COVERAGE_PCT = Number(process.env.US_ANALYTICS_MIN_LATEST_COVERAGE_PCT ?? 95)
const EXPECTED_DATE = process.env.US_ANALYTICS_EXPECTED_DATE?.trim() || expectedLatestUsTradingDate()
const REQUIRE_DERIVED_BASIS = process.env.US_ANALYTICS_REQUIRE_DERIVED_BASIS === '1'

type ScalarRow = { value: number | string | null }

async function scalarNumber(client: Client, sql: string): Promise<number> {
  const result = await client.execute(sql)
  const row = result.rows[0] as unknown as ScalarRow | undefined
  return Number(row?.value ?? 0)
}

async function scalarText(client: Client, sql: string): Promise<string | null> {
  const result = await client.execute(sql)
  const row = result.rows[0] as unknown as ScalarRow | undefined
  return row?.value == null ? null : String(row.value)
}

function assertThreshold(name: string, actual: number, expected: number): string | null {
  return actual >= expected ? null : `${name}: ${actual} < ${expected}`
}

async function main() {
  const target = createClient({ url: `file:${TARGET_PATH}` })

  const copyDone = await scalarNumber(
    target,
    `SELECT COUNT(*) AS value FROM us_analytics_copy_state WHERE status = 'done'`,
  )
  const ohlcvRows = await scalarNumber(target, `SELECT COUNT(*) AS value FROM ohlcv_daily`)
  const ohlcvTickers = await scalarNumber(target, `SELECT COUNT(DISTINCT ticker) AS value FROM ohlcv_daily`)
  const ohlcvMinDate = await scalarText(target, `SELECT MIN(date) AS value FROM ohlcv_daily`)
  const ohlcvMaxDate = await scalarText(target, `SELECT MAX(date) AS value FROM ohlcv_daily`)
  const snapshotRows = await scalarNumber(target, `SELECT COUNT(*) AS value FROM daily_snapshots`)
  const snapshotTickers = await scalarNumber(target, `SELECT COUNT(DISTINCT ticker) AS value FROM daily_snapshots`)
  const snapshotMinDate = await scalarText(target, `SELECT MIN(date) AS value FROM daily_snapshots`)
  const snapshotMaxDate = await scalarText(target, `SELECT MAX(date) AS value FROM daily_snapshots`)
  const activeUniverse = await scalarNumber(target, `SELECT COUNT(*) AS value FROM ticker_universe WHERE active = 1`)
  const latestOhlcvActiveTickers = await scalarNumber(
    target,
    `SELECT COUNT(DISTINCT o.ticker) AS value
     FROM ohlcv_daily o
     INNER JOIN ticker_universe u ON u.ticker = o.ticker AND u.active = 1
     WHERE o.date = (SELECT MAX(date) FROM ohlcv_daily)`,
  )
  const latestSnapshotActiveTickers = await scalarNumber(
    target,
    `SELECT COUNT(DISTINCT d.ticker) AS value
     FROM daily_snapshots d
     INNER JOIN ticker_universe u ON u.ticker = d.ticker AND u.active = 1
     WHERE d.date = (SELECT MAX(date) FROM daily_snapshots)`,
  )
  const latestOhlcvCoveragePct = activeUniverse > 0
    ? 100 * latestOhlcvActiveTickers / activeUniverse
    : 0
  const latestSnapshotCoveragePct = activeUniverse > 0
    ? 100 * latestSnapshotActiveTickers / activeUniverse
    : 0
  const priceBasis = await scalarText(
    target,
    `SELECT value
     FROM us_analytics_metadata
     WHERE key = 'ohlcv_price_basis'`,
  )
  const derivedPriceBasis = await scalarText(
    target,
    `SELECT value
     FROM us_analytics_metadata
     WHERE key = 'derived_price_basis'`,
  )
  const derivedPriceDate = await scalarText(
    target,
    `SELECT value
     FROM us_analytics_metadata
     WHERE key = 'derived_price_date'`,
  )
  const analogPriceBasis = await scalarText(
    target,
    `SELECT value
     FROM us_analytics_metadata
     WHERE key = 'analog_index_price_basis'`,
  )
  const analogPriceDate = await scalarText(
    target,
    `SELECT value
     FROM us_analytics_metadata
     WHERE key = 'analog_index_price_date'`,
  )
  const backtestFeatureDate = await scalarText(target, `SELECT MAX(date) AS value FROM model_features`)
  const patternStatsRows = await scalarNumber(target, `SELECT COUNT(*) AS value FROM pattern_stats`)
  const transitionAxes = await scalarNumber(target, `SELECT COUNT(DISTINCT axis) AS value FROM stage_transitions`)
  const servingBacktestDate = await scalarText(target, `SELECT MAX(date) AS value FROM serving_backtest_dates`)
  const latestModelEvaluationDate = await scalarText(
    target,
    `SELECT MAX(evaluation_date) AS value
     FROM ml_model_evaluations
     WHERE evaluation_date <= (SELECT MAX(date) FROM ohlcv_daily)`,
  )
  const latestModelTrainDate = await scalarText(
    target,
    `SELECT MAX(train_end_date) AS value FROM ml_model_evaluations`,
  )
  const latestPhysicsEvaluationDate = await scalarText(
    target,
    `SELECT MAX(evaluation_date) AS value
     FROM ml_physics_status_evaluations
     WHERE evaluation_date <= (SELECT MAX(date) FROM ohlcv_daily)`,
  )
  const latestPhysicsDataDate = await scalarText(
    target,
    `SELECT MAX(end_date) AS value FROM ml_physics_status_evaluations`,
  )
  const latestRlEvaluationDate = await scalarText(
    target,
    `SELECT MAX(evaluation_date) AS value
     FROM ml_rl_policy_evaluations
     WHERE evaluation_date <= (SELECT MAX(date) FROM ohlcv_daily)`,
  )
  const latestRlDataDate = await scalarText(
    target,
    `SELECT MAX(end_date) AS value FROM ml_rl_policy_evaluations`,
  )

  console.log(
    [
      `US analytics validation: ${TARGET_PATH}`,
      `copyDone=${copyDone}`,
      `ohlcvRows=${ohlcvRows}`,
      `ohlcvTickers=${ohlcvTickers}`,
      `ohlcvRange=${ohlcvMinDate ?? '-'}..${ohlcvMaxDate ?? '-'}`,
      `snapshotRows=${snapshotRows}`,
      `snapshotTickers=${snapshotTickers}`,
      `snapshotRange=${snapshotMinDate ?? '-'}..${snapshotMaxDate ?? '-'}`,
      `expectedDate=${EXPECTED_DATE}`,
      `activeUniverse=${activeUniverse}`,
      `latestOhlcvCoverage=${latestOhlcvActiveTickers}/${activeUniverse}(${latestOhlcvCoveragePct.toFixed(2)}%)`,
      `latestSnapshotCoverage=${latestSnapshotActiveTickers}/${activeUniverse}(${latestSnapshotCoveragePct.toFixed(2)}%)`,
      `priceBasis=${priceBasis ?? '-'}`,
      `derivedPriceBasis=${derivedPriceBasis ?? '-'}`,
      `derivedPriceDate=${derivedPriceDate ?? '-'}`,
      `analogPriceBasis=${analogPriceBasis ?? '-'}`,
      `analogPriceDate=${analogPriceDate ?? '-'}`,
      `backtestFeatureDate=${backtestFeatureDate ?? '-'}`,
      `patternStatsRows=${patternStatsRows}`,
      `transitionAxes=${transitionAxes}`,
      `servingBacktestDate=${servingBacktestDate ?? '-'}`,
      `latestModelEvaluationDate=${latestModelEvaluationDate ?? '-'}`,
      `latestModelTrainDate=${latestModelTrainDate ?? '-'}`,
      `latestPhysicsEvaluationDate=${latestPhysicsEvaluationDate ?? '-'}`,
      `latestPhysicsDataDate=${latestPhysicsDataDate ?? '-'}`,
      `latestRlEvaluationDate=${latestRlEvaluationDate ?? '-'}`,
      `latestRlDataDate=${latestRlDataDate ?? '-'}`,
    ].join(' '),
  )

  const failures = [
    assertThreshold('copyDone', copyDone, MIN_COPY_DONE),
    assertThreshold('ohlcvTickers', ohlcvTickers, MIN_OHLCV_TICKERS),
    assertThreshold('snapshotTickers', snapshotTickers, MIN_SNAPSHOT_TICKERS),
    assertThreshold('ohlcvRows', ohlcvRows, MIN_OHLCV_ROWS),
    assertThreshold('snapshotRows', snapshotRows, MIN_SNAPSHOT_ROWS),
    !ohlcvMaxDate || ohlcvMaxDate < EXPECTED_DATE
      ? `ohlcvMaxDate: ${ohlcvMaxDate ?? 'missing'} < ${EXPECTED_DATE}`
      : null,
    snapshotMaxDate !== ohlcvMaxDate
      ? `snapshotMaxDate: ${snapshotMaxDate ?? 'missing'} != ohlcvMaxDate ${ohlcvMaxDate ?? 'missing'}`
      : null,
    assertThreshold('latestOhlcvCoveragePct', latestOhlcvCoveragePct, MIN_LATEST_COVERAGE_PCT),
    assertThreshold('latestSnapshotCoveragePct', latestSnapshotCoveragePct, MIN_LATEST_COVERAGE_PCT),
    priceBasis !== US_ADJUSTED_PRICE_BASIS
      ? `priceBasis: ${priceBasis ?? 'missing'} != ${US_ADJUSTED_PRICE_BASIS}`
      : null,
    REQUIRE_DERIVED_BASIS && derivedPriceBasis !== US_ADJUSTED_PRICE_BASIS
      ? `derivedPriceBasis: ${derivedPriceBasis ?? 'missing'} != ${US_ADJUSTED_PRICE_BASIS}`
      : null,
    REQUIRE_DERIVED_BASIS && derivedPriceDate !== ohlcvMaxDate
      ? `derivedPriceDate: ${derivedPriceDate ?? 'missing'} != ohlcvMaxDate ${ohlcvMaxDate ?? 'missing'}`
      : null,
    REQUIRE_DERIVED_BASIS && analogPriceBasis !== US_ADJUSTED_PRICE_BASIS
      ? `analogPriceBasis: ${analogPriceBasis ?? 'missing'} != ${US_ADJUSTED_PRICE_BASIS}`
      : null,
    REQUIRE_DERIVED_BASIS && analogPriceDate !== ohlcvMaxDate
      ? `analogPriceDate: ${analogPriceDate ?? 'missing'} != ohlcvMaxDate ${ohlcvMaxDate ?? 'missing'}`
      : null,
    REQUIRE_DERIVED_BASIS && backtestFeatureDate !== ohlcvMaxDate
      ? `backtestFeatureDate: ${backtestFeatureDate ?? 'missing'} != ohlcvMaxDate ${ohlcvMaxDate ?? 'missing'}`
      : null,
    REQUIRE_DERIVED_BASIS && patternStatsRows <= 0
      ? 'patternStatsRows: missing'
      : null,
    REQUIRE_DERIVED_BASIS && transitionAxes < 6
      ? `transitionAxes: ${transitionAxes} < 6`
      : null,
    REQUIRE_DERIVED_BASIS && !servingBacktestDate
      ? 'servingBacktestDate: missing'
      : null,
    REQUIRE_DERIVED_BASIS && !latestModelEvaluationDate
      ? 'latestModelEvaluationDate: no evaluation at or before ohlcvMaxDate'
      : null,
    REQUIRE_DERIVED_BASIS && latestModelTrainDate && ohlcvMaxDate && latestModelTrainDate > ohlcvMaxDate
      ? `latestModelTrainDate: ${latestModelTrainDate} > ohlcvMaxDate ${ohlcvMaxDate}`
      : null,
    REQUIRE_DERIVED_BASIS && !latestPhysicsEvaluationDate
      ? 'latestPhysicsEvaluationDate: no evaluation at or before ohlcvMaxDate'
      : null,
    REQUIRE_DERIVED_BASIS && latestPhysicsDataDate && ohlcvMaxDate && latestPhysicsDataDate > ohlcvMaxDate
      ? `latestPhysicsDataDate: ${latestPhysicsDataDate} > ohlcvMaxDate ${ohlcvMaxDate}`
      : null,
    REQUIRE_DERIVED_BASIS && !latestRlEvaluationDate
      ? 'latestRlEvaluationDate: no evaluation at or before ohlcvMaxDate'
      : null,
    REQUIRE_DERIVED_BASIS && latestRlDataDate && ohlcvMaxDate && latestRlDataDate > ohlcvMaxDate
      ? `latestRlDataDate: ${latestRlDataDate} > ohlcvMaxDate ${ohlcvMaxDate}`
      : null,
  ].filter((failure): failure is string => failure != null)

  if (failures.length > 0) {
    throw new Error(`US analytics validation failed: ${failures.join('; ')}`)
  }

  console.log('US analytics validation passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
