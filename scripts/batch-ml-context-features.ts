// scripts/batch-ml-context-features.ts
//
// ML候補の地合い補正用に、市場全体と17/33業種の短期コンテキストを保存する。

import { execGet, execRun } from '@/lib/db/client'

const RECENT_DAYS = Number(process.env.ML_CONTEXT_RECENT_DAYS ?? 260)
const START_DATE = process.env.ML_CONTEXT_START_DATE?.trim() || null
const END_DATE = process.env.ML_CONTEXT_END_DATE?.trim() || null

async function dateBoundary(): Promise<{ start: string | null; lookbackStart: string | null; end: string | null }> {
  const end = END_DATE ?? (await execGet<{ date: string | null }>(
    `SELECT MAX(date) AS date FROM ohlcv_daily`,
  ))?.date ?? null
  if (!end) return { start: null, lookbackStart: null, end: null }
  const start = START_DATE ?? (RECENT_DAYS > 0
    ? (await execGet<{ date: string | null }>(
        `
        SELECT MIN(date) AS date
        FROM (
          SELECT DISTINCT date
          FROM ohlcv_daily
          WHERE date <= ?
          ORDER BY date DESC
          LIMIT ?
        )
        `,
        [end, RECENT_DAYS],
      ))?.date ?? null
    : null)
  const lookbackStart = start
    ? (await execGet<{ date: string | null }>(
        `
        SELECT MIN(date) AS date
        FROM (
          SELECT DISTINCT date
          FROM ohlcv_daily
          WHERE date <= ?
          ORDER BY date DESC
          LIMIT 40
        )
        `,
        [start],
      ))?.date ?? start
    : null
  return { start, lookbackStart, end }
}

async function main() {
  const { start, lookbackStart, end } = await dateBoundary()
  if (!end) {
    console.log('ml context features skipped: no ohlcv dates')
    return
  }
  const whereDate = start ? 'date >= ? AND date <= ?' : 'date <= ?'
  const deleteArgs = start ? [start, end] : [end]
  await execRun(`DELETE FROM ml_market_context_features WHERE ${whereDate}`, deleteArgs)
  await execRun(`DELETE FROM ml_sector_context_features WHERE ${whereDate}`, deleteArgs)

  const baseDateWhere = [
    lookbackStart ? 'o.date >= ?' : null,
    'o.date <= ?',
  ].filter(Boolean).join(' AND ')
  const baseDateArgs = [...(lookbackStart ? [lookbackStart] : []), end]
  const marketArgs = [...baseDateArgs, ...(start ? [start] : [])]
  const sectorArgs = [...baseDateArgs, ...(start ? [start, start] : [])]
  const outputWhere = start ? 'WHERE date >= ?' : ''

  await execRun(
    `
    INSERT OR REPLACE INTO ml_market_context_features
      (date, market_return_5, market_return_20, market_above_sma25_rate,
       market_above_sma75_rate, advancers_rate_5, sample_count, payload_json, computed_at)
    WITH base AS (
      SELECT
        o.ticker,
        o.date,
        o.close,
        d.ma_25,
        d.ma_75,
        LAG(o.close, 5) OVER (PARTITION BY o.ticker ORDER BY o.date) AS close_5,
        LAG(o.close, 20) OVER (PARTITION BY o.ticker ORDER BY o.date) AS close_20
      FROM ohlcv_daily o
      LEFT JOIN daily_snapshots d ON d.ticker = o.ticker AND d.date = o.date
      WHERE ${baseDateWhere}
    ),
    features AS (
      SELECT
        date,
        CASE WHEN close_5 > 0 THEN ((close - close_5) / close_5) * 100 END AS return_5,
        CASE WHEN close_20 > 0 THEN ((close - close_20) / close_20) * 100 END AS return_20,
        CASE WHEN ma_25 > 0 THEN close >= ma_25 END AS above_25,
        CASE WHEN ma_75 > 0 THEN close >= ma_75 END AS above_75
      FROM base
    )
    SELECT
      date,
      ROUND(AVG(return_5), 4),
      ROUND(AVG(return_20), 4),
      ROUND(AVG(CASE WHEN above_25 THEN 1.0 ELSE 0.0 END) * 100, 4),
      ROUND(AVG(CASE WHEN above_75 THEN 1.0 ELSE 0.0 END) * 100, 4),
      ROUND(AVG(CASE WHEN return_5 > 0 THEN 1.0 ELSE 0.0 END) * 100, 4),
      COUNT(*),
      json_object('source', 'ohlcv_daily_daily_snapshots', 'recentDays', ?, 'computedEnd', ?),
      unixepoch()
    FROM features
    ${outputWhere}
    GROUP BY date
    `,
    [...marketArgs, RECENT_DAYS, end],
  )

  await execRun(
    `
    INSERT OR REPLACE INTO ml_sector_context_features
      (date, sector_type, sector_name, return_5, return_20, above_sma25_rate,
       rank_pct, sample_count, payload_json, computed_at)
    WITH base AS (
      SELECT
        o.ticker,
        o.date,
        o.close,
        d.ma_25,
        COALESCE(NULLIF(u.sector17_name, ''), '未分類') AS sector17_name,
        COALESCE(NULLIF(u.sector33_name, ''), '未分類') AS sector33_name,
        LAG(o.close, 5) OVER (PARTITION BY o.ticker ORDER BY o.date) AS close_5,
        LAG(o.close, 20) OVER (PARTITION BY o.ticker ORDER BY o.date) AS close_20
      FROM ohlcv_daily o
      LEFT JOIN daily_snapshots d ON d.ticker = o.ticker AND d.date = o.date
      LEFT JOIN ticker_universe u ON u.ticker = o.ticker
      WHERE ${baseDateWhere}
    ),
    features AS (
      SELECT
        date,
        sector17_name,
        sector33_name,
        CASE WHEN close_5 > 0 THEN ((close - close_5) / close_5) * 100 END AS return_5,
        CASE WHEN close_20 > 0 THEN ((close - close_20) / close_20) * 100 END AS return_20,
        CASE WHEN ma_25 > 0 THEN close >= ma_25 END AS above_25
      FROM base
    ),
    sector_raw AS (
      SELECT date, '17' AS sector_type, sector17_name AS sector_name,
             ROUND(AVG(return_5), 4) AS return_5,
             ROUND(AVG(return_20), 4) AS return_20,
             ROUND(AVG(CASE WHEN above_25 THEN 1.0 ELSE 0.0 END) * 100, 4) AS above_sma25_rate,
             COUNT(*) AS sample_count
      FROM features
      ${outputWhere}
      GROUP BY date, sector17_name
      UNION ALL
      SELECT date, '33' AS sector_type, sector33_name AS sector_name,
             ROUND(AVG(return_5), 4) AS return_5,
             ROUND(AVG(return_20), 4) AS return_20,
             ROUND(AVG(CASE WHEN above_25 THEN 1.0 ELSE 0.0 END) * 100, 4) AS above_sma25_rate,
             COUNT(*) AS sample_count
      FROM features
      ${outputWhere}
      GROUP BY date, sector33_name
    ),
    ranked AS (
      SELECT
        *,
        ROW_NUMBER() OVER (PARTITION BY date, sector_type ORDER BY return_5 DESC) AS rn,
        COUNT(*) OVER (PARTITION BY date, sector_type) AS group_count
      FROM sector_raw
    )
    SELECT
      date,
      sector_type,
      sector_name,
      return_5,
      return_20,
      above_sma25_rate,
      CASE WHEN group_count > 1 THEN ROUND(((rn - 1) * 100.0) / (group_count - 1), 4) ELSE 50 END AS rank_pct,
      sample_count,
      json_object('source', 'ohlcv_daily_daily_snapshots', 'recentDays', ?, 'computedEnd', ?),
      unixepoch()
    FROM ranked
    `,
    [...sectorArgs, RECENT_DAYS, end],
  )

  console.log(`ml context features complete: start=${start ?? '-'}, end=${end}, recent_days=${RECENT_DAYS || 'all'}`)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
