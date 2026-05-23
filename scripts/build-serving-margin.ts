// scripts/build-serving-margin.ts
//
// weekly_margin_interest の最新週だけを画面表示用に圧縮する。

import { execRun } from '@/lib/db/client'

async function main() {
  await execRun(`DELETE FROM serving_margin_latest`)
  await execRun(`
    INSERT OR REPLACE INTO serving_margin_latest
      (ticker, as_of_date, margin_type, long_margin, short_margin, long_change, short_change,
       credit_ratio, short_ratio, computed_at)
    WITH latest_wmi AS (
      SELECT
        ticker,
        date,
        long_margin,
        short_margin,
        long_change,
        short_change,
        ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY date DESC) AS rn
      FROM weekly_margin_interest
    )
    SELECT
      w.ticker,
      w.date AS as_of_date,
      COALESCE(tu.margin_type, sm.margin_type) AS margin_type,
      w.long_margin,
      w.short_margin,
      w.long_change,
      w.short_change,
      CASE WHEN COALESCE(w.short_margin, 0) > 0 THEN w.long_margin / w.short_margin END AS credit_ratio,
      CASE
        WHEN COALESCE(w.long_margin, 0) + COALESCE(w.short_margin, 0) > 0
        THEN 100.0 * COALESCE(w.short_margin, 0) / (COALESCE(w.long_margin, 0) + COALESCE(w.short_margin, 0))
      END AS short_ratio,
      unixepoch()
    FROM latest_wmi w
    LEFT JOIN ticker_universe tu ON tu.ticker = w.ticker
    LEFT JOIN sector_master sm ON sm.ticker = w.ticker OR sm.ticker = w.ticker || '.T'
    WHERE w.rn = 1
  `)
  console.log('serving_margin_latest updated')
}

main().catch((error) => {
  console.error('build-serving-margin failed:', error)
  process.exit(1)
})
