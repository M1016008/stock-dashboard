import { client, ensureReady, execGet } from '@/lib/db/client'
import { acquireJpStockboardUpdateLock } from '@/lib/server/update-lock'

async function main(): Promise<void> {
  await ensureReady()
  const lock = await acquireJpStockboardUpdateLock('post_ohlcv_refresh', 30 * 60)
  if (!lock) {
    console.warn('US screener metric backfill deferred because another JP database writer is active.')
    process.exitCode = 75
    return
  }
  try {
    const latest = await execGet<{ date: string | null }>(`
      SELECT MAX(date) AS date FROM market_daily_snapshots WHERE market = 'US'
    `)
    if (!latest?.date) {
      console.log('US screener metric backfill skipped: no US snapshot date.')
      return
    }
    const result = await client.execute({ sql: `
      WITH lookback_dates AS (
        SELECT date, ROW_NUMBER() OVER (ORDER BY date DESC) AS rn
        FROM (
          SELECT DISTINCT date
          FROM market_ohlcv_daily INDEXED BY market_ohlcv_market_date_idx
          WHERE market = 'US' AND date <= ?
          ORDER BY date DESC
          LIMIT 201
        )
      ),
      periods AS (
        SELECT
          o.ticker,
          MAX(CASE WHEN d.rn = 2 THEN COALESCE(o.adj_close, o.close) END) AS prev_close,
          MAX(CASE WHEN d.rn = 6 THEN COALESCE(o.adj_close, o.close) END) AS close_5d,
          MAX(CASE WHEN d.rn = 21 THEN COALESCE(o.adj_close, o.close) END) AS close_20d,
          MAX(CASE WHEN d.rn = 61 THEN COALESCE(o.adj_close, o.close) END) AS close_60d,
          MAX(CASE WHEN d.rn = 121 THEN COALESCE(o.adj_close, o.close) END) AS close_120d,
          AVG(CASE WHEN d.rn <= 20 THEN COALESCE(o.adj_volume, o.volume) END) AS avg_volume_20,
          AVG(CASE WHEN d.rn <= 200 THEN COALESCE(o.adj_close, o.close) END) AS ma_200,
          AVG(CASE WHEN d.rn BETWEEN 2 AND 201 THEN COALESCE(o.adj_close, o.close) END) AS ma_200_prev,
          COUNT(CASE WHEN d.rn <= 200 THEN 1 END) AS ma_200_observations
        FROM market_ohlcv_daily o
        INNER JOIN lookback_dates d ON d.date = o.date
        WHERE o.market = 'US'
        GROUP BY o.ticker
      )
      UPDATE market_daily_snapshots AS snapshot
      SET prev_close = periods.prev_close,
          close_5d = periods.close_5d,
          close_20d = periods.close_20d,
          close_60d = periods.close_60d,
          close_120d = periods.close_120d,
          avg_volume_20 = periods.avg_volume_20,
          ma_200 = periods.ma_200,
          ma_200_prev = periods.ma_200_prev,
          ma_200_observations = periods.ma_200_observations,
          computed_at = unixepoch()
      FROM periods
      WHERE snapshot.market = 'US'
        AND snapshot.date = ?
        AND snapshot.ticker = periods.ticker
    `, args: [latest.date, latest.date] })
    console.log(`US screener metrics backfilled: date=${latest.date}, rows=${result.rowsAffected}`)
  } finally {
    await lock.release()
  }
}

main().catch((error) => {
  console.error('US screener metric backfill failed:', error)
  process.exit(1)
})
