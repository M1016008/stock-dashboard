import { execAll, execGet, execRun, type Args } from '@/lib/db/client'
import type { OHLCV } from '@/types/stock'

interface ManualOhlcvRawRow {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

let schemaReady: Promise<void> | null = null

export function normalizeManualTicker(rawTicker: string): string {
  const ticker = rawTicker.trim().replace(/\.T$/i, '').toUpperCase()
  if (!ticker) throw new Error('ticker is required')
  return ticker
}

export async function ensureManualOhlcvSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await execRun(`
        CREATE TABLE IF NOT EXISTS manual_ohlcv_daily (
          market TEXT NOT NULL DEFAULT 'JP',
          ticker TEXT NOT NULL,
          date TEXT NOT NULL,
          open REAL NOT NULL,
          high REAL NOT NULL,
          low REAL NOT NULL,
          close REAL NOT NULL,
          volume INTEGER NOT NULL DEFAULT 0,
          source_name TEXT,
          source_note TEXT,
          imported_at INTEGER NOT NULL DEFAULT (unixepoch()),
          PRIMARY KEY (market, ticker, date)
        )
      `)
      await execRun(`
        CREATE INDEX IF NOT EXISTS manual_ohlcv_market_ticker_date_idx
        ON manual_ohlcv_daily(market, ticker, date)
      `)
    })()
  }
  return schemaReady
}

export async function loadManualOhlcvRows(
  rawTicker: string,
  options: { fromDate?: string | null; asOfDate?: string | null } = {},
): Promise<OHLCV[]> {
  await ensureManualOhlcvSchema()
  const ticker = normalizeManualTicker(rawTicker)
  const where = ["market = 'JP'", 'ticker = ?']
  const args: Array<string | number> = [ticker]
  if (options.fromDate) {
    where.push('date >= ?')
    args.push(options.fromDate)
  }
  if (options.asOfDate) {
    where.push('date <= ?')
    args.push(options.asOfDate)
  }
  const rows = await execAll<ManualOhlcvRawRow>(
    `
      SELECT date, open, high, low, close, volume
      FROM manual_ohlcv_daily
      WHERE ${where.join(' AND ')}
      ORDER BY date
    `,
    args as Args,
  )
  return rows.map(toOhlcv)
}

export async function loadManualLatestOhlcvRows(rawTicker: string, limit = 2): Promise<OHLCV[]> {
  await ensureManualOhlcvSchema()
  const ticker = normalizeManualTicker(rawTicker)
  const rows = await execAll<ManualOhlcvRawRow>(
    `
      SELECT date, open, high, low, close, volume
      FROM manual_ohlcv_daily
      WHERE market = 'JP'
        AND ticker = ?
      ORDER BY date DESC
      LIMIT ?
    `,
    [ticker, limit],
  )
  return rows.map(toOhlcv)
}

export async function getManualOhlcvHiLo(rawTicker: string, sinceDate: string): Promise<{ hi?: number; lo?: number }> {
  await ensureManualOhlcvSchema()
  const ticker = normalizeManualTicker(rawTicker)
  const row = await execGet<{ hi: number | null; lo: number | null }>(
    `
      SELECT MAX(high) AS hi, MIN(low) AS lo
      FROM manual_ohlcv_daily
      WHERE market = 'JP'
        AND ticker = ?
        AND date >= ?
    `,
    [ticker, sinceDate],
  )
  return {
    hi: row?.hi ?? undefined,
    lo: row?.lo ?? undefined,
  }
}

function toOhlcv(row: ManualOhlcvRawRow): OHLCV {
  return {
    date: row.date,
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume),
  }
}
