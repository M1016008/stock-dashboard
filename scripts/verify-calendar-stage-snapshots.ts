import { execAll } from '@/lib/db/client'
import { buildSnapshotCalculations } from '@/lib/snapshots/continuous-ma'
import { toAdjustedUsOhlcvRows, type UsRawOhlcvRow } from '@/lib/us-adjusted-ohlcv'
import type { OHLCV } from '@/types/stock'

const market = String(process.env.STAGE_SNAPSHOT_VERIFY_MARKET ?? process.argv[2] ?? 'JP').toUpperCase()
if (market !== 'JP' && market !== 'US') throw new Error(`unsupported market: ${market}`)

const requestedTickers = process.env.TICKERS?.split(',').map((value) => value.trim().toUpperCase()).filter(Boolean)
if (!requestedTickers?.length) throw new Error('TICKERS is required for calendar stage verification')
const tickers = requestedTickers
const startDate = process.env.STAGE_SNAPSHOT_VERIFY_START_DATE?.trim() || null
const endDate = process.env.STAGE_SNAPSHOT_VERIFY_END_DATE?.trim() || null

const valueKeys = [
  'weekly_ma_5', 'weekly_ma_13', 'weekly_ma_25', 'weekly_ma_50', 'weekly_ma_100',
  'monthly_ma_3', 'monthly_ma_5', 'monthly_ma_10', 'monthly_ma_20', 'monthly_ma_25',
  'weekly_a_stage', 'weekly_b_stage', 'monthly_a_stage', 'monthly_b_stage',
] as const

type StoredSnapshot = { date: string } & Record<(typeof valueKeys)[number], number | null>

function valuesEqual(actual: number | null, expected: number | null): boolean {
  if (actual === null || expected === null) return actual === expected
  return Math.abs(actual - expected) < 1e-9
}

async function loadPrices(ticker: string): Promise<OHLCV[]> {
  if (market === 'US') {
    const rows = await execAll<UsRawOhlcvRow>(
      `SELECT date, open, high, low, close, volume,
         adj_open AS adjustedOpen, adj_high AS adjustedHigh, adj_low AS adjustedLow,
         adj_close AS adjustedClose, adj_volume AS adjustedVolume
       FROM market_ohlcv_daily
       WHERE market = 'US' AND ticker = ? ORDER BY date`,
      [ticker],
    )
    return toAdjustedUsOhlcvRows(rows)
  }
  return execAll<OHLCV>(
    `SELECT date, open, high, low, close, volume
     FROM ohlcv_daily WHERE ticker = ? ORDER BY date`,
    [ticker],
  )
}

async function loadSnapshots(ticker: string): Promise<StoredSnapshot[]> {
  const columns = valueKeys.join(', ')
  const dateWhere = [startDate ? 'date >= ?' : null, endDate ? 'date <= ?' : null].filter(Boolean)
  const dateSql = dateWhere.length > 0 ? ` AND ${dateWhere.join(' AND ')}` : ''
  const dateArgs = [startDate, endDate].filter((value): value is string => value != null)
  return market === 'US'
    ? execAll<StoredSnapshot>(
      `SELECT date, ${columns} FROM market_daily_snapshots
       WHERE market = 'US' AND ticker = ?${dateSql} ORDER BY date`,
      [ticker, ...dateArgs],
    )
    : execAll<StoredSnapshot>(
      `SELECT date, ${columns} FROM daily_snapshots
       WHERE ticker = ?${dateSql} ORDER BY date`,
      [ticker, ...dateArgs],
    )
}

async function main(): Promise<void> {
  let totalRows = 0
  const mismatchTotals = Object.fromEntries(valueKeys.map((key) => [key, 0])) as Record<(typeof valueKeys)[number], number>
  const mismatchExamples: Array<{
    ticker: string
    date: string
    key: (typeof valueKeys)[number]
    actual: number | null
    expected: number | null
  }> = []

  for (const ticker of tickers) {
    const [prices, snapshots] = await Promise.all([loadPrices(ticker), loadSnapshots(ticker)])
    const expectedByDate = new Map(
      buildSnapshotCalculations(prices, { includeWarmup: true }).map((row) => [row.date, row]),
    )
    totalRows += snapshots.length
    for (const snapshot of snapshots) {
      const expected = expectedByDate.get(snapshot.date)
      if (!expected) continue
      for (const key of valueKeys) {
        if (!valuesEqual(snapshot[key], expected[key])) {
          mismatchTotals[key] += 1
          if (mismatchExamples.length < 20) {
            mismatchExamples.push({
              ticker,
              date: snapshot.date,
              key,
              actual: snapshot[key],
              expected: expected[key],
            })
          }
        }
      }
    }
  }

  const mismatches = Object.values(mismatchTotals).reduce((sum, count) => sum + count, 0)
  console.log(JSON.stringify({
    market,
    tickers,
    startDate,
    endDate,
    totalRows,
    mismatches,
    mismatchTotals,
    mismatchExamples,
  }, null, 2))
  if (mismatches > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
