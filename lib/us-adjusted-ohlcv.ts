import type { OHLCV } from '@/types/stock'

export const US_ADJUSTED_PRICE_BASIS = 'tiingo_adj_ohlc_ratio_v1'

export type UsRawOhlcvRow = OHLCV & {
  adjustedOpen?: number | null
  adjustedHigh?: number | null
  adjustedLow?: number | null
  adjustedVolume?: number | null
}

function finiteOrNull(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) ? value : null
}

export function toAdjustedUsOhlcv(row: UsRawOhlcvRow): OHLCV {
  const adjustedClose = finiteOrNull(row.adjustedClose)
  const directOpen = finiteOrNull(row.adjustedOpen)
  const directHigh = finiteOrNull(row.adjustedHigh)
  const directLow = finiteOrNull(row.adjustedLow)
  const ratio = adjustedClose != null && row.close !== 0
    ? adjustedClose / row.close
    : 1

  const open = directOpen ?? row.open * ratio
  const high = directHigh ?? row.high * ratio
  const low = directLow ?? row.low * ratio
  const close = adjustedClose ?? row.close

  return {
    date: row.date,
    open,
    high: Math.max(open, high, low, close),
    low: Math.min(open, high, low, close),
    close,
    volume: finiteOrNull(row.adjustedVolume) ?? row.volume,
    adjustedClose: close,
  }
}

export function toAdjustedUsOhlcvRows(rows: UsRawOhlcvRow[]): OHLCV[] {
  return rows.map(toAdjustedUsOhlcv)
}

export const US_ADJUSTED_OPEN_SQL = `
  CASE
    WHEN adj_open IS NOT NULL THEN adj_open
    WHEN adj_close IS NOT NULL AND close <> 0 THEN open * adj_close / close
    ELSE open
  END
`.trim()

export const US_ADJUSTED_HIGH_SQL = `
  CASE
    WHEN adj_high IS NOT NULL THEN adj_high
    WHEN adj_close IS NOT NULL AND close <> 0 THEN high * adj_close / close
    ELSE high
  END
`.trim()

export const US_ADJUSTED_LOW_SQL = `
  CASE
    WHEN adj_low IS NOT NULL THEN adj_low
    WHEN adj_close IS NOT NULL AND close <> 0 THEN low * adj_close / close
    ELSE low
  END
`.trim()

export const US_ADJUSTED_CLOSE_SQL = 'COALESCE(adj_close, close)'
export const US_ADJUSTED_VOLUME_SQL = 'COALESCE(adj_volume, volume)'
