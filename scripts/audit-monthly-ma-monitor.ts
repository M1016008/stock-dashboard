import assert from 'node:assert/strict'
import { execAll, execGet } from '@/lib/db/client'
import {
  MONTHLY_MA_CLUSTER_CONFIG,
  MONTHLY_MA_MONITOR_CONFIG,
  MONTHLY_MA_MONITOR_PERIODS,
} from '@/lib/monthly-ma-monitor'

type CountRow = { count: number }

async function count(sql: string, args: Array<string | number> = []): Promise<number> {
  const row = await execGet<CountRow>(sql, args)
  return Number(row?.count ?? 0)
}

async function main(): Promise<void> {
  const source = await execGet<{ date: string | null }>('SELECT MAX(date) AS date FROM ohlcv_daily')
  const monitor = await execGet<{ date: string | null }>('SELECT MAX(date) AS date FROM monthly_ma_monitor_latest')
  assert.ok(source?.date, 'OHLCV source date is missing')
  assert.equal(monitor?.date, source.date, 'monitor latest date differs from OHLCV source date')

  const date = source.date
  const failures: Record<string, number> = {}
  const check = async (name: string, sql: string, args: Array<string | number> = []) => {
    failures[name] = await count(sql, args)
  }

  await check('daily_duplicates', `
    SELECT COUNT(*) AS count FROM (
      SELECT ticker, period, date FROM monthly_ma_monitor_daily
      GROUP BY ticker, period, date HAVING COUNT(*) > 1
    )`)
  await check('latest_duplicates', `
    SELECT COUNT(*) AS count FROM (
      SELECT ticker, period FROM monthly_ma_monitor_latest
      GROUP BY ticker, period HAVING COUNT(*) > 1
    )`)
  await check('cluster_daily_duplicates', `
    SELECT COUNT(*) AS count FROM (
      SELECT ticker, cluster_key, date FROM monthly_ma_cluster_daily
      GROUP BY ticker, cluster_key, date HAVING COUNT(*) > 1
    )`)
  await check('cluster_latest_duplicates', `
    SELECT COUNT(*) AS count FROM (
      SELECT ticker, cluster_key FROM monthly_ma_cluster_latest
      GROUP BY ticker, cluster_key HAVING COUNT(*) > 1
    )`)
  await check('unexpected_periods', `
    SELECT COUNT(*) AS count FROM monthly_ma_monitor_latest
    WHERE period NOT IN (${MONTHLY_MA_MONITOR_PERIODS.map(() => '?').join(',')})`, [...MONTHLY_MA_MONITOR_PERIODS])
  await check('bad_distance_formula', `
    SELECT COUNT(*) AS count FROM monthly_ma_monitor_daily
    WHERE ABS(distance_pct - ((close - ma_value) / ma_value * 100.0)) > 0.0001`)
  await check('bad_absolute_distance', `
    SELECT COUNT(*) AS count FROM monthly_ma_monitor_daily
    WHERE ABS(abs_distance_pct - ABS(distance_pct)) > 0.000001`)
  await check('bad_position_side', `
    SELECT COUNT(*) AS count FROM monthly_ma_monitor_daily
    WHERE position_side <> CASE
      WHEN ABS(distance_pct) < 0.000000001 THEN 'on_line'
      WHEN distance_pct > 0 THEN 'above' ELSE 'below' END`)
  await check('bad_contact_flag', `
    SELECT COUNT(*) AS count FROM monthly_ma_monitor_daily
    WHERE is_contact_default <> CASE WHEN abs_distance_pct <= ? THEN 1 ELSE 0 END`, [MONTHLY_MA_MONITOR_CONFIG.contactThresholdPct])
  await check('bad_score_range', `
    SELECT COUNT(*) AS count FROM monthly_ma_monitor_daily
    WHERE approach_score < 0 OR approach_score > 100
       OR closeness_score < 0 OR movement_score < 0 OR event_score < 0`)
  await check('bad_touch_flag', `
    SELECT COUNT(*) AS count
    FROM monthly_ma_monitor_daily m
    INNER JOIN ohlcv_daily o ON o.ticker = m.ticker AND o.date = m.date
    WHERE m.is_touch <> CASE WHEN o.low <= m.ma_value AND o.high >= m.ma_value THEN 1 ELSE 0 END`)
  await check('bad_cross_direction', `
    SELECT COUNT(*) AS count FROM (
      SELECT *, LAG(distance_pct) OVER (PARTITION BY ticker, period ORDER BY date) AS previous_distance
      FROM monthly_ma_monitor_daily
    ) x
    WHERE cross_direction IS NOT NULL AND NOT (
      (cross_direction = 'up' AND previous_distance < 0 AND distance_pct > 0)
      OR (cross_direction = 'down' AND previous_distance > 0 AND distance_pct < 0)
    )`)
  await check('missing_strict_cross', `
    SELECT COUNT(*) AS count FROM (
      SELECT *, LAG(distance_pct) OVER (PARTITION BY ticker, period ORDER BY date) AS previous_distance
      FROM monthly_ma_monitor_daily
    ) x
    WHERE (previous_distance < 0 AND distance_pct > 0 AND COALESCE(cross_direction, '') <> 'up')
       OR (previous_distance > 0 AND distance_pct < 0 AND COALESCE(cross_direction, '') <> 'down')`)
  await check('bad_touch_event_state', `
    SELECT COUNT(*) AS count FROM monthly_ma_monitor_daily
    WHERE (is_touch = 1 AND (touch_age_sessions <> 0 OR last_touch_date <> date))
       OR (touch_age_sessions = 0 AND is_touch <> 1)
       OR (touch_age_sessions IS NULL AND last_touch_date IS NOT NULL)
       OR (touch_age_sessions IS NOT NULL AND last_touch_date IS NULL)`)
  await check('bad_cross_event_state', `
    SELECT COUNT(*) AS count FROM monthly_ma_monitor_daily
    WHERE (cross_direction IS NOT NULL AND (cross_age_sessions <> 0 OR last_cross_date <> date OR last_cross_direction <> cross_direction))
       OR (cross_age_sessions = 0 AND cross_direction IS NULL)
       OR (cross_age_sessions IS NULL AND (last_cross_date IS NOT NULL OR last_cross_direction IS NOT NULL))
       OR (cross_age_sessions IS NOT NULL AND (last_cross_date IS NULL OR last_cross_direction IS NULL))`)
  await check('latest_without_daily_source', `
    SELECT COUNT(*) AS count
    FROM monthly_ma_monitor_latest l
    LEFT JOIN monthly_ma_monitor_daily d
      ON d.ticker = l.ticker AND d.period = l.period AND d.date = l.date
    WHERE d.ticker IS NULL`)
  await check('stale_latest_rows', `
    SELECT COUNT(*) AS count FROM monthly_ma_monitor_latest WHERE date <> ?`, [date])
  await check('cluster_bad_spread_flag', `
    SELECT COUNT(*) AS count FROM monthly_ma_cluster_latest
    WHERE is_cluster <> CASE WHEN spread_pct <= ? THEN 1 ELSE 0 END`, [MONTHLY_MA_CLUSTER_CONFIG.spreadThresholdPct])
  await check('cluster_bad_strength', `
    SELECT COUNT(*) AS count FROM monthly_ma_cluster_latest
    WHERE is_strong <> CASE WHEN period_count >= ? THEN 1 ELSE 0 END`, [MONTHLY_MA_CLUSTER_CONFIG.strongMinimumPeriods])
  await check('cluster_bad_period_json', `
    SELECT COUNT(*) AS count FROM monthly_ma_cluster_latest
    WHERE json_array_length(periods_json) <> period_count OR period_count < ?`, [MONTHLY_MA_CLUSTER_CONFIG.minimumPeriods])
  await check('cluster_band_source_mismatch', `
    SELECT COUNT(*) AS count FROM (
      SELECT c.ticker, c.cluster_key, c.band_low, c.band_high, c.band_average, c.period_count,
             COUNT(m.period) AS matched_periods,
             MIN(m.ma_value) AS source_low,
             MAX(m.ma_value) AS source_high,
             AVG(m.ma_value) AS source_average
      FROM monthly_ma_cluster_latest c
      JOIN json_each(c.periods_json) j
      LEFT JOIN monthly_ma_monitor_latest m
        ON m.ticker = c.ticker AND m.period = CAST(j.value AS INTEGER) AND m.date = c.date
      WHERE c.date = ?
      GROUP BY c.ticker, c.cluster_key
      HAVING matched_periods <> c.period_count
         OR ABS(source_low - c.band_low) > 0.0001
         OR ABS(source_high - c.band_high) > 0.0001
         OR ABS(source_average - c.band_average) > 0.0001
    )`, [date])
  await check('cluster_non_maximal_marked', `
    SELECT COUNT(*) AS count
    FROM monthly_ma_cluster_latest c
    WHERE c.date = ? AND c.is_cluster = 1 AND c.is_maximal = 1
      AND EXISTS (
        SELECT 1 FROM monthly_ma_cluster_latest wider
        WHERE wider.ticker = c.ticker AND wider.date = c.date
          AND wider.is_cluster = 1 AND wider.period_count > c.period_count
          AND NOT EXISTS (
            SELECT 1 FROM json_each(c.periods_json) member
            WHERE CAST(member.value AS INTEGER) NOT IN (
              SELECT CAST(value AS INTEGER) FROM json_each(wider.periods_json)
            )
          )
      )`, [date])
  await check('cluster_daily_threshold_violation', `
    SELECT COUNT(*) AS count FROM monthly_ma_cluster_daily
    WHERE spread_pct > ?`, [MONTHLY_MA_CLUSTER_CONFIG.spreadThresholdPct])
  await check('cluster_daily_bad_touch', `
    SELECT COUNT(*) AS count
    FROM monthly_ma_cluster_daily c
    INNER JOIN ohlcv_daily o ON o.ticker = c.ticker AND o.date = c.date
    WHERE c.is_touch <> CASE WHEN o.low <= c.band_high AND o.high >= c.band_low THEN 1 ELSE 0 END`)

  const sourceTickers = await count(`
    SELECT COUNT(DISTINCT u.ticker) AS count
    FROM ticker_universe u
    INNER JOIN ohlcv_daily o ON o.ticker = u.ticker AND o.date = ?
    WHERE u.active = 1`, [date])
  const processedTickers = await count(`
    SELECT COUNT(*) AS count FROM compute_state
    WHERE job_type = ? AND last_processed_date = ?`, [`monthly_ma_monitor_${MONTHLY_MA_MONITOR_PERIODS.join('_')}`, date])
  assert.equal(processedTickers, sourceTickers, 'daily compute state does not cover the complete source-date universe')

  const periodCoverage = await execAll<{ period: number; tickers: number }>(`
    SELECT period, COUNT(DISTINCT ticker) AS tickers
    FROM monthly_ma_monitor_latest WHERE date = ? GROUP BY period ORDER BY period`, [date])
  const retention = await execGet<{ firstDate: string; lastDate: string; rows: number }>(`
    SELECT MIN(date) AS firstDate, MAX(date) AS lastDate, COUNT(*) AS rows FROM monthly_ma_monitor_daily`)
  const clusterCounts = await execGet<{ active: number; maximal: number; strong: number }>(`
    SELECT
      SUM(CASE WHEN is_cluster = 1 THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN is_cluster = 1 AND is_maximal = 1 THEN 1 ELSE 0 END) AS maximal,
      SUM(CASE WHEN is_cluster = 1 AND is_maximal = 1 AND is_strong = 1 THEN 1 ELSE 0 END) AS strong
    FROM monthly_ma_cluster_latest WHERE date = ?`, [date])

  const failed = Object.entries(failures).filter(([, value]) => value !== 0)
  console.log(JSON.stringify({
    date,
    sourceTickers,
    processedTickers,
    periodCoverage,
    retention,
    clusterCounts,
    checks: failures,
  }, null, 2))
  assert.deepEqual(failed, [], `monthly MA audit failures: ${JSON.stringify(failed)}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
