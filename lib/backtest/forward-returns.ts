import { MAX_CONTIGUOUS_BAR_GAP_DAYS } from '@/lib/backtest/forward-extrema'

export function forwardReturnsProjectionSql(tickerWhere = ''): string {
  return `
    WITH ordered AS (
      SELECT
        ticker,
        date,
        close,
        CASE
          WHEN julianday(date) - julianday(
            LAG(date) OVER (PARTITION BY ticker ORDER BY date)
          ) > ${MAX_CONTIGUOUS_BAR_GAP_DAYS}
          THEN 1 ELSE 0
        END AS segment_break
      FROM ohlcv_daily
      ${tickerWhere}
    ),
    segmented AS (
      SELECT
        ticker,
        date,
        close,
        SUM(segment_break) OVER (
          PARTITION BY ticker
          ORDER BY date
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS continuity_segment
      FROM ordered
    ),
    projected AS (
      SELECT
        ticker,
        date,
        close,
        LEAD(date, ?) OVER (
          PARTITION BY ticker, continuity_segment ORDER BY date
        ) AS future_date,
        LEAD(close, ?) OVER (
          PARTITION BY ticker, continuity_segment ORDER BY date
        ) AS future_close,
        100.0 * (
          LEAD(close, ?) OVER (
            PARTITION BY ticker, continuity_segment ORDER BY date
          ) - close
        ) / close AS return_pct
      FROM segmented
    )
    SELECT ticker, date, close, future_date, future_close, return_pct
    FROM projected
  `
}
