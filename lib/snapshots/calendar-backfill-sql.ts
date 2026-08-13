import type { Args } from '@/lib/db/client'
import { STAGE_COMPARISON_RELATIVE_EPSILON } from '@/lib/hex-stage'

export const CALENDAR_STAGE_VERSION = 'calendar_week_month_v2_tolerant_ties'

export type SnapshotBackfillMarket = 'JP' | 'US'

type Statement = { sql: string; args: Args }

const WEEK_BUCKET_SQL = `CAST((julianday(date) - julianday('1970-01-05')) / 7 AS INTEGER)`
const MONTH_BUCKET_SQL = `((CAST(substr(date, 1, 4) AS INTEGER) - 1970) * 12 + CAST(substr(date, 6, 2) AS INTEGER) - 1)`

function stageCase(shortMa: string, middleMa: string, longMa: string): string {
  const greaterThan = (left: string, right: string) => (
    `((${left}) - (${right})) > ${STAGE_COMPARISON_RELATIVE_EPSILON} * MAX(1.0, ABS(${left}), ABS(${right}))`
  )
  return `CASE
    WHEN ${greaterThan(shortMa, middleMa)} AND ${greaterThan(middleMa, longMa)} THEN 1
    WHEN ${greaterThan(middleMa, shortMa)} AND ${greaterThan(shortMa, longMa)} THEN 2
    WHEN ${greaterThan(middleMa, longMa)} AND ${greaterThan(longMa, shortMa)} THEN 3
    WHEN ${greaterThan(longMa, middleMa)} AND ${greaterThan(middleMa, shortMa)} THEN 4
    WHEN ${greaterThan(longMa, shortMa)} AND ${greaterThan(shortMa, middleMa)} THEN 5
    WHEN ${greaterThan(shortMa, longMa)} AND ${greaterThan(longMa, middleMa)} THEN 6
    ELSE NULL
  END`
}

export function buildCalendarStageClassificationStatement(
  market: SnapshotBackfillMarket,
  ticker: string,
): Statement {
  const isUs = market === 'US'
  const targetTable = isUs ? 'market_daily_snapshots' : 'daily_snapshots'
  const targetWhere = isUs ? `target.market = 'US' AND target.ticker = ?` : 'target.ticker = ?'
  return {
    sql: `
      UPDATE ${targetTable} AS target
      SET
        weekly_a_stage = ${stageCase('weekly_ma_5', 'weekly_ma_13', 'weekly_ma_25')},
        weekly_b_stage = ${stageCase('weekly_ma_25', 'weekly_ma_50', 'weekly_ma_100')},
        monthly_a_stage = ${stageCase('monthly_ma_3', 'monthly_ma_5', 'monthly_ma_10')},
        monthly_b_stage = ${stageCase('monthly_ma_10', 'monthly_ma_20', 'monthly_ma_25')},
        computed_at = unixepoch()
      WHERE ${targetWhere}
    `,
    args: [ticker],
  }
}

export function buildCalendarStageBackfillStatements(
  market: SnapshotBackfillMarket,
  ticker: string,
): Statement[] {
  const isUs = market === 'US'
  const sourceTable = isUs ? 'market_ohlcv_daily' : 'ohlcv_daily'
  const targetTable = isUs ? 'market_daily_snapshots' : 'daily_snapshots'
  const closeSql = isUs ? 'COALESCE(adj_close, close)' : 'close'
  const sourceWhere = isUs ? `market = 'US' AND ticker = ?` : 'ticker = ?'
  const targetWhere = isUs ? `target.market = 'US' AND target.ticker = ?` : 'target.ticker = ?'

  const maSql = `
    WITH raw AS (
      SELECT date, ${closeSql} AS close
      FROM ${sourceTable}
      WHERE ${sourceWhere}
      ORDER BY date
    ),
    boundaries AS (
      SELECT
        date,
        close,
        CASE
          WHEN julianday(date) - julianday(LAG(date) OVER (ORDER BY date)) > 60 THEN 1
          ELSE 0
        END AS starts_segment
      FROM raw
    ),
    segmented AS (
      SELECT
        date,
        close,
        SUM(starts_segment) OVER (ORDER BY date ROWS UNBOUNDED PRECEDING) AS segment,
        ${WEEK_BUCKET_SQL} AS week_bucket,
        ${MONTH_BUCKET_SQL} AS month_bucket
      FROM boundaries
    ),
    weekly_ranked AS (
      SELECT
        segment,
        week_bucket,
        close,
        ROW_NUMBER() OVER (PARTITION BY segment, week_bucket ORDER BY date DESC) AS row_number
      FROM segmented
    ),
    weekly_ends AS (
      SELECT segment, week_bucket, close
      FROM weekly_ranked
      WHERE row_number = 1
    ),
    weekly_roll AS (
      SELECT
        segment,
        week_bucket,
        COUNT(close) OVER (PARTITION BY segment ORDER BY week_bucket ROWS BETWEEN 4 PRECEDING AND 1 PRECEDING) AS count_4,
        SUM(close) OVER (PARTITION BY segment ORDER BY week_bucket ROWS BETWEEN 4 PRECEDING AND 1 PRECEDING) AS sum_4,
        COUNT(close) OVER (PARTITION BY segment ORDER BY week_bucket ROWS BETWEEN 12 PRECEDING AND 1 PRECEDING) AS count_12,
        SUM(close) OVER (PARTITION BY segment ORDER BY week_bucket ROWS BETWEEN 12 PRECEDING AND 1 PRECEDING) AS sum_12,
        COUNT(close) OVER (PARTITION BY segment ORDER BY week_bucket ROWS BETWEEN 24 PRECEDING AND 1 PRECEDING) AS count_24,
        SUM(close) OVER (PARTITION BY segment ORDER BY week_bucket ROWS BETWEEN 24 PRECEDING AND 1 PRECEDING) AS sum_24,
        COUNT(close) OVER (PARTITION BY segment ORDER BY week_bucket ROWS BETWEEN 49 PRECEDING AND 1 PRECEDING) AS count_49,
        SUM(close) OVER (PARTITION BY segment ORDER BY week_bucket ROWS BETWEEN 49 PRECEDING AND 1 PRECEDING) AS sum_49,
        COUNT(close) OVER (PARTITION BY segment ORDER BY week_bucket ROWS BETWEEN 99 PRECEDING AND 1 PRECEDING) AS count_99,
        SUM(close) OVER (PARTITION BY segment ORDER BY week_bucket ROWS BETWEEN 99 PRECEDING AND 1 PRECEDING) AS sum_99
      FROM weekly_ends
    ),
    monthly_ranked AS (
      SELECT
        segment,
        month_bucket,
        close,
        ROW_NUMBER() OVER (PARTITION BY segment, month_bucket ORDER BY date DESC) AS row_number
      FROM segmented
    ),
    monthly_ends AS (
      SELECT segment, month_bucket, close
      FROM monthly_ranked
      WHERE row_number = 1
    ),
    monthly_roll AS (
      SELECT
        segment,
        month_bucket,
        COUNT(close) OVER (PARTITION BY segment ORDER BY month_bucket ROWS BETWEEN 2 PRECEDING AND 1 PRECEDING) AS count_2,
        SUM(close) OVER (PARTITION BY segment ORDER BY month_bucket ROWS BETWEEN 2 PRECEDING AND 1 PRECEDING) AS sum_2,
        COUNT(close) OVER (PARTITION BY segment ORDER BY month_bucket ROWS BETWEEN 4 PRECEDING AND 1 PRECEDING) AS count_4,
        SUM(close) OVER (PARTITION BY segment ORDER BY month_bucket ROWS BETWEEN 4 PRECEDING AND 1 PRECEDING) AS sum_4,
        COUNT(close) OVER (PARTITION BY segment ORDER BY month_bucket ROWS BETWEEN 9 PRECEDING AND 1 PRECEDING) AS count_9,
        SUM(close) OVER (PARTITION BY segment ORDER BY month_bucket ROWS BETWEEN 9 PRECEDING AND 1 PRECEDING) AS sum_9,
        COUNT(close) OVER (PARTITION BY segment ORDER BY month_bucket ROWS BETWEEN 19 PRECEDING AND 1 PRECEDING) AS count_19,
        SUM(close) OVER (PARTITION BY segment ORDER BY month_bucket ROWS BETWEEN 19 PRECEDING AND 1 PRECEDING) AS sum_19,
        COUNT(close) OVER (PARTITION BY segment ORDER BY month_bucket ROWS BETWEEN 24 PRECEDING AND 1 PRECEDING) AS count_24,
        SUM(close) OVER (PARTITION BY segment ORDER BY month_bucket ROWS BETWEEN 24 PRECEDING AND 1 PRECEDING) AS sum_24
      FROM monthly_ends
    ),
    calculated AS (
      SELECT
        daily.date,
        CASE WHEN weekly.count_4 = 4 THEN (weekly.sum_4 + daily.close) / 5 END AS weekly_ma_5,
        CASE WHEN weekly.count_12 = 12 THEN (weekly.sum_12 + daily.close) / 13 END AS weekly_ma_13,
        CASE WHEN weekly.count_24 = 24 THEN (weekly.sum_24 + daily.close) / 25 END AS weekly_ma_25,
        CASE WHEN weekly.count_49 = 49 THEN (weekly.sum_49 + daily.close) / 50 END AS weekly_ma_50,
        CASE WHEN weekly.count_99 = 99 THEN (weekly.sum_99 + daily.close) / 100 END AS weekly_ma_100,
        CASE WHEN monthly.count_2 = 2 THEN (monthly.sum_2 + daily.close) / 3 END AS monthly_ma_3,
        CASE WHEN monthly.count_4 = 4 THEN (monthly.sum_4 + daily.close) / 5 END AS monthly_ma_5,
        CASE WHEN monthly.count_9 = 9 THEN (monthly.sum_9 + daily.close) / 10 END AS monthly_ma_10,
        CASE WHEN monthly.count_19 = 19 THEN (monthly.sum_19 + daily.close) / 20 END AS monthly_ma_20,
        CASE WHEN monthly.count_24 = 24 THEN (monthly.sum_24 + daily.close) / 25 END AS monthly_ma_25
      FROM segmented AS daily
      JOIN weekly_roll AS weekly
        ON weekly.segment = daily.segment AND weekly.week_bucket = daily.week_bucket
      JOIN monthly_roll AS monthly
        ON monthly.segment = daily.segment AND monthly.month_bucket = daily.month_bucket
    )
    UPDATE ${targetTable} AS target
    SET
      weekly_ma_5 = calculated.weekly_ma_5,
      weekly_ma_13 = calculated.weekly_ma_13,
      weekly_ma_25 = calculated.weekly_ma_25,
      weekly_ma_50 = calculated.weekly_ma_50,
      weekly_ma_100 = calculated.weekly_ma_100,
      monthly_ma_3 = calculated.monthly_ma_3,
      monthly_ma_5 = calculated.monthly_ma_5,
      monthly_ma_10 = calculated.monthly_ma_10,
      monthly_ma_20 = calculated.monthly_ma_20,
      monthly_ma_25 = calculated.monthly_ma_25,
      computed_at = unixepoch()
    FROM calculated
    WHERE ${targetWhere}
      AND target.date = calculated.date
  `

  return [
    { sql: maSql, args: [ticker, ticker] },
    buildCalendarStageClassificationStatement(market, ticker),
  ]
}
