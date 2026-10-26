import { US_SEC_SIC_TAXONOMY } from '@/lib/us-classification'
import type { UsHexTimeframe, UsHexWireRow } from '@/lib/us-hex-wire'
import { getUsDisplayName } from '@/lib/us-symbol-aliases'
import { usInvestableSymbolSql } from '@/lib/us-symbol-quality'

export type UsHexRawRow = {
  ticker: string
  snapshot_ticker: string | null
  name: string | null
  exchange: string | null
  asset_type: string | null
  sector: string | null
  industry: string | null
  shares_outstanding: number | null
  price: number | null
  perf_1d: number | null
  perf_1w: number | null
  perf_1m: number | null
  perf_3m: number | null
  perf_6m: number | null
  perf_ytd: number | null
  daily_a_stage: number | null
  daily_b_stage: number | null
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
  ma_5: number | null
  ma_25: number | null
  ma_75: number | null
  ma_300: number | null
  prev_ma_5: number | null
  prev_ma_25: number | null
  prev_ma_75: number | null
  prev_ma_300: number | null
  prev2_ma_5: number | null
  prev2_ma_25: number | null
  prev2_ma_75: number | null
  prev2_ma_300: number | null
}

function buildUsHexRowsSql(historical: boolean): string {
  const baseTicker = historical ? 's.ticker' : 'u.ticker'
  const identityColumns = historical
    ? `s.ticker,
  s.ticker AS snapshot_ticker,
  COALESCE(u.name, s.ticker) AS name,
  NULL AS exchange,
  NULL AS asset_type,
  'Unclassified' AS sector,
  NULL AS industry,
  NULL AS shares_outstanding`
    : `u.ticker,
  s.ticker AS snapshot_ticker,
  u.name,
  u.exchange,
  u.asset_type,
  COALESCE(c.sector_name, u.sector, 'Unclassified') AS sector,
  COALESCE(c.industry_name, u.industry) AS industry,
  u.shares_outstanding`
  const source = historical
    ? `FROM anchors a
JOIN market_daily_snapshots s INDEXED BY market_snapshots_market_date_ticker_idx
  ON s.market = 'US' AND s.date = a.current_date
LEFT JOIN market_universe u ON u.market = 'US' AND u.ticker = s.ticker`
    : `FROM market_universe u INDEXED BY market_universe_market_active_idx
CROSS JOIN anchors a
LEFT JOIN market_daily_snapshots s INDEXED BY market_snapshots_market_date_ticker_idx
  ON s.market = 'US' AND s.ticker = u.ticker AND s.date = a.current_date
LEFT JOIN market_classifications c
  ON c.market = 'US'
 AND c.ticker = u.ticker
 AND c.taxonomy = ?
 AND c.effective_from = '0000-01-01'`
  const where = historical
    ? `WHERE ${usInvestableSymbolSql('s.ticker')}`
    : `WHERE u.market = 'US'
  AND u.active = 1
  AND ${usInvestableSymbolSql('u.ticker')}`

  return `
WITH anchors AS (
  SELECT
    ? AS current_date,
    (SELECT MAX(date) FROM market_daily_snapshots WHERE market = 'US' AND date < ?) AS prev_snapshot,
    (SELECT MAX(date) FROM market_daily_snapshots
      WHERE market = 'US'
        AND date < (SELECT MAX(date) FROM market_daily_snapshots WHERE market = 'US' AND date < ?)
    ) AS prev2_snapshot,
    (SELECT MAX(date) FROM market_ohlcv_daily WHERE market = 'US' AND date < ?) AS day_1,
    (SELECT MAX(date) FROM market_ohlcv_daily WHERE market = 'US' AND date <= date(?, '-7 days')) AS week_1,
    (SELECT MAX(date) FROM market_ohlcv_daily WHERE market = 'US' AND date <= date(?, '-1 month')) AS month_1,
    (SELECT MAX(date) FROM market_ohlcv_daily WHERE market = 'US' AND date <= date(?, '-3 months')) AS month_3,
    (SELECT MAX(date) FROM market_ohlcv_daily WHERE market = 'US' AND date <= date(?, '-6 months')) AS month_6,
    (SELECT MAX(date) FROM market_ohlcv_daily WHERE market = 'US' AND date <= substr(?, 1, 4) || '-01-01') AS year_start
),
price_dates AS (
  SELECT a.current_date AS date FROM anchors a
  UNION SELECT a.day_1 FROM anchors a
  UNION SELECT a.week_1 FROM anchors a
  UNION SELECT a.month_1 FROM anchors a
  UNION SELECT a.month_3 FROM anchors a
  UNION SELECT a.month_6 FROM anchors a
  UNION SELECT a.year_start FROM anchors a
),
price_rows AS (
  SELECT p.ticker, p.date, COALESCE(p.adj_close, p.close) AS price
  FROM price_dates d
  JOIN market_ohlcv_daily p INDEXED BY market_ohlcv_market_date_ticker_idx
    ON p.market = 'US' AND p.date = d.date
  WHERE d.date IS NOT NULL
),
prices AS (
  SELECT
    p.ticker,
    MAX(CASE WHEN p.date = a.current_date THEN p.price END) AS price,
    MAX(CASE WHEN p.date = a.day_1 THEN p.price END) AS price_1d,
    MAX(CASE WHEN p.date = a.week_1 THEN p.price END) AS price_1w,
    MAX(CASE WHEN p.date = a.month_1 THEN p.price END) AS price_1m,
    MAX(CASE WHEN p.date = a.month_3 THEN p.price END) AS price_3m,
    MAX(CASE WHEN p.date = a.month_6 THEN p.price END) AS price_6m,
    MAX(CASE WHEN p.date = a.year_start THEN p.price END) AS price_ytd
  FROM price_rows p
  CROSS JOIN anchors a
  GROUP BY p.ticker
)
SELECT
  ${identityColumns},
  px.price,
  CASE WHEN px.price_1d > 0 THEN 100.0 * (px.price - px.price_1d) / px.price_1d END AS perf_1d,
  CASE WHEN px.price_1w > 0 THEN 100.0 * (px.price - px.price_1w) / px.price_1w END AS perf_1w,
  CASE WHEN px.price_1m > 0 THEN 100.0 * (px.price - px.price_1m) / px.price_1m END AS perf_1m,
  CASE WHEN px.price_3m > 0 THEN 100.0 * (px.price - px.price_3m) / px.price_3m END AS perf_3m,
  CASE WHEN px.price_6m > 0 THEN 100.0 * (px.price - px.price_6m) / px.price_6m END AS perf_6m,
  CASE WHEN px.price_ytd > 0 THEN 100.0 * (px.price - px.price_ytd) / px.price_ytd END AS perf_ytd,
  s.daily_a_stage,
  s.daily_b_stage,
  s.weekly_a_stage,
  s.weekly_b_stage,
  s.monthly_a_stage,
  s.monthly_b_stage,
  s.ma_5,
  s.ma_25,
  s.ma_75,
  s.ma_300,
  prev.ma_5 AS prev_ma_5,
  prev.ma_25 AS prev_ma_25,
  prev.ma_75 AS prev_ma_75,
  prev.ma_300 AS prev_ma_300,
  prev2.ma_5 AS prev2_ma_5,
  prev2.ma_25 AS prev2_ma_25,
  prev2.ma_75 AS prev2_ma_75,
  prev2.ma_300 AS prev2_ma_300
${source}
LEFT JOIN market_daily_snapshots prev
  ON prev.market = 'US' AND prev.ticker = ${baseTicker} AND prev.date = a.prev_snapshot
LEFT JOIN market_daily_snapshots prev2
  ON prev2.market = 'US' AND prev2.ticker = ${baseTicker} AND prev2.date = a.prev2_snapshot
LEFT JOIN prices px ON px.ticker = ${baseTicker}
${where}
ORDER BY ${baseTicker}
`
}

export const US_HEX_ROWS_SQL = buildUsHexRowsSql(false)
export const US_HEX_HISTORICAL_ROWS_SQL = buildUsHexRowsSql(true)

export function usHexRowsParams(date: string, historical = false): string[] {
  const params = [date, date, date, date, date, date, date, date, date]
  return historical ? params : [...params, US_SEC_SIC_TAXONOMY]
}

/** 旧 (legacy-v1) レスポンスの行。compact-v1 と columnar wire はこの行から派生する。 */
export type UsHexRow = UsHexWireRow & {
  sector17_name?: string | null
  sector33_name?: string | null
  ml_candidate_direction?: 'up' | 'down' | null
  ml_candidate_rank?: number | null
  ml_candidate_summary?: string | null
}

export function numeric(value: unknown): number | null {
  if (value == null || value === '') return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function percentChange(current: number | null, previous: number | null): number | null {
  if (current == null || previous == null || previous <= 0) return null
  return 100 * (current - previous) / previous
}

function stageForTimeframe(row: UsHexRawRow, timeframe: UsHexTimeframe): number | null {
  if (timeframe === 'weekly') return numeric(row.weekly_a_stage)
  if (timeframe === 'monthly') return numeric(row.monthly_a_stage)
  return numeric(row.daily_a_stage)
}

export function buildUsHexRow(
  row: UsHexRawRow,
  timeframe: UsHexTimeframe,
  physicalMomentum: Map<string, number | null>,
): UsHexRow {
  const price = numeric(row.price)
  const sector = row.sector || 'Unclassified'
  const stages = [
    row.daily_a_stage,
    row.daily_b_stage,
    row.weekly_a_stage,
    row.weekly_b_stage,
    row.monthly_a_stage,
    row.monthly_b_stage,
  ]
  const dataStatus: UsHexRow['data_status'] = price == null
    ? 'price_pending'
    : row.snapshot_ticker == null
      ? 'snapshot_pending'
      : stages.some((value) => numeric(value) == null)
        ? 'partial_stage'
        : 'ready'
  return {
    code: row.ticker,
    name: getUsDisplayName(row.ticker, row.name),
    sector_large: sector,
    sector_small: row.industry,
    sector17_name: sector,
    sector33_name: row.industry,
    market_segment: row.exchange,
    margin_type: row.asset_type,
    market_cap: row.shares_outstanding && price != null && price > 0 ? row.shares_outstanding * price : null,
    price,
    daily_change: numeric(row.perf_1d),
    weekly_change: numeric(row.perf_1w),
    monthly_change: numeric(row.perf_1m),
    months3_change: numeric(row.perf_3m),
    months6_change: numeric(row.perf_6m),
    ytd_change: numeric(row.perf_ytd),
    data_status: dataStatus,
    stage: stageForTimeframe(row, timeframe),
    daily_a_stage: numeric(row.daily_a_stage),
    daily_b_stage: numeric(row.daily_b_stage),
    weekly_a_stage: numeric(row.weekly_a_stage),
    weekly_b_stage: numeric(row.weekly_b_stage),
    monthly_a_stage: numeric(row.monthly_a_stage),
    monthly_b_stage: numeric(row.monthly_b_stage),
    sma_angles: {
      sma5: percentChange(numeric(row.ma_5), numeric(row.prev_ma_5)),
      sma25: percentChange(numeric(row.ma_25), numeric(row.prev_ma_25)),
      sma75: percentChange(numeric(row.ma_75), numeric(row.prev_ma_75)),
      sma300: percentChange(numeric(row.ma_300), numeric(row.prev_ma_300)),
    },
    prev_sma_angles: {
      sma5: percentChange(numeric(row.prev_ma_5), numeric(row.prev2_ma_5)),
      sma25: percentChange(numeric(row.prev_ma_25), numeric(row.prev2_ma_25)),
      sma75: percentChange(numeric(row.prev_ma_75), numeric(row.prev2_ma_75)),
      sma300: percentChange(numeric(row.prev_ma_300), numeric(row.prev2_ma_300)),
    },
    ml_candidate_direction: null,
    ml_candidate_rank: null,
    ml_candidate_summary: null,
    physical_momentum_score: physicalMomentum.get(row.ticker) ?? null,
  }
}

/** compact=1: 常に null の ML 列と sector エイリアスを落とした行。columnar wire もこの形を運ぶ。 */
export function compactUsHexRow(row: UsHexRow): UsHexRow {
  const compact = { ...row }
  delete compact.sector17_name
  delete compact.sector33_name
  delete compact.ml_candidate_direction
  delete compact.ml_candidate_rank
  delete compact.ml_candidate_summary
  return compact
}
