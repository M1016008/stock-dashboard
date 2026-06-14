// scripts/repair-gap-adjusted-snapshots.ts
//
// ohlcv_daily に大きな履歴ギャップがある銘柄について、daily_snapshots を連続セグメント単位で再計算する。
// コード再利用・再上場・長期売買停止により、旧履歴を混ぜて長期MA/6ステージが埋まる事故を補正する。

import { execAll, execBatch, execRun } from '@/lib/db/client'
import { buildSnapshotCalculations } from '@/lib/snapshots/continuous-ma'
import type { OHLCV } from '@/types/stock'

const DRY_RUN = process.env.SNAPSHOT_GAP_REPAIR_DRY_RUN === '1'
const CHUNK_SIZE = Math.max(1, Number(process.env.SNAPSHOT_GAP_REPAIR_CHUNK_SIZE ?? 200))

type GapTicker = {
  ticker: string
  activeStartDate: string
  maxGapDays: number
}

const SNAPSHOT_COLUMNS = [
  'ma_5',
  'ma_25',
  'ma_75',
  'ma_150',
  'ma_300',
  'weekly_ma_5',
  'weekly_ma_13',
  'weekly_ma_25',
  'weekly_ma_50',
  'weekly_ma_100',
  'monthly_ma_3',
  'monthly_ma_5',
  'monthly_ma_10',
  'monthly_ma_20',
  'monthly_ma_25',
  'daily_a_stage',
  'daily_b_stage',
  'weekly_a_stage',
  'weekly_b_stage',
  'monthly_a_stage',
  'monthly_b_stage',
] as const

const UPSERT_SQL = `
  INSERT INTO daily_snapshots (
    ticker, date,
    ma_5, ma_25, ma_75, ma_150, ma_300,
    weekly_ma_5, weekly_ma_13, weekly_ma_25, weekly_ma_50, weekly_ma_100,
    monthly_ma_3, monthly_ma_5, monthly_ma_10, monthly_ma_20, monthly_ma_25,
    daily_a_stage, daily_b_stage, weekly_a_stage, weekly_b_stage, monthly_a_stage, monthly_b_stage,
    computed_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
  ON CONFLICT(ticker, date) DO UPDATE SET
    ma_5 = excluded.ma_5,
    ma_25 = excluded.ma_25,
    ma_75 = excluded.ma_75,
    ma_150 = excluded.ma_150,
    ma_300 = excluded.ma_300,
    weekly_ma_5 = excluded.weekly_ma_5,
    weekly_ma_13 = excluded.weekly_ma_13,
    weekly_ma_25 = excluded.weekly_ma_25,
    weekly_ma_50 = excluded.weekly_ma_50,
    weekly_ma_100 = excluded.weekly_ma_100,
    monthly_ma_3 = excluded.monthly_ma_3,
    monthly_ma_5 = excluded.monthly_ma_5,
    monthly_ma_10 = excluded.monthly_ma_10,
    monthly_ma_20 = excluded.monthly_ma_20,
    monthly_ma_25 = excluded.monthly_ma_25,
    daily_a_stage = excluded.daily_a_stage,
    daily_b_stage = excluded.daily_b_stage,
    weekly_a_stage = excluded.weekly_a_stage,
    weekly_b_stage = excluded.weekly_b_stage,
    monthly_a_stage = excluded.monthly_a_stage,
    monthly_b_stage = excluded.monthly_b_stage,
    computed_at = unixepoch()
`

const NULLIFY_SQL = `
  UPDATE daily_snapshots
  SET
    ma_5 = NULL,
    ma_25 = NULL,
    ma_75 = NULL,
    ma_150 = NULL,
    ma_300 = NULL,
    weekly_ma_5 = NULL,
    weekly_ma_13 = NULL,
    weekly_ma_25 = NULL,
    weekly_ma_50 = NULL,
    weekly_ma_100 = NULL,
    monthly_ma_3 = NULL,
    monthly_ma_5 = NULL,
    monthly_ma_10 = NULL,
    monthly_ma_20 = NULL,
    monthly_ma_25 = NULL,
    daily_a_stage = NULL,
    daily_b_stage = NULL,
    weekly_a_stage = NULL,
    weekly_b_stage = NULL,
    monthly_a_stage = NULL,
    monthly_b_stage = NULL,
    computed_at = unixepoch()
  WHERE ticker = ? AND date = ?
`

function toArgs(ticker: string, row: ReturnType<typeof buildSnapshotCalculations>[number]) {
  return [
    ticker,
    row.date,
    row.ma_5,
    row.ma_25,
    row.ma_75,
    row.ma_150,
    row.ma_300,
    row.weekly_ma_5,
    row.weekly_ma_13,
    row.weekly_ma_25,
    row.weekly_ma_50,
    row.weekly_ma_100,
    row.monthly_ma_3,
    row.monthly_ma_5,
    row.monthly_ma_10,
    row.monthly_ma_20,
    row.monthly_ma_25,
    row.daily_a_stage,
    row.daily_b_stage,
    row.weekly_a_stage,
    row.weekly_b_stage,
    row.monthly_a_stage,
    row.monthly_b_stage,
  ]
}

async function findGapTickers(): Promise<GapTicker[]> {
  const tickerFilter = process.env.TICKERS?.split(',').map((ticker) => ticker.trim()).filter(Boolean)
  if (tickerFilter && tickerFilter.length > 0) {
    return tickerFilter.map((ticker) => ({ ticker, activeStartDate: '', maxGapDays: 0 }))
  }

  return execAll<GapTicker>(`
    WITH ordered AS (
      SELECT ticker, date, LAG(date) OVER (PARTITION BY ticker ORDER BY date) AS prev_date
      FROM ohlcv_daily
    ),
    gaps AS (
      SELECT ticker, date AS activeStartDate, julianday(date) - julianday(prev_date) AS maxGapDays
      FROM ordered
      WHERE prev_date IS NOT NULL
        AND julianday(date) - julianday(prev_date) > 60
    ),
    latest_gap AS (
      SELECT ticker, activeStartDate, maxGapDays
      FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY activeStartDate DESC) AS rn
        FROM gaps
      )
      WHERE rn = 1
    )
    SELECT ticker, activeStartDate, maxGapDays
    FROM latest_gap
    ORDER BY maxGapDays DESC, ticker
  `)
}

async function refreshSnapshotDateCache(dates: Iterable<string>): Promise<void> {
  const uniqueDates = Array.from(new Set(dates)).sort()
  if (uniqueDates.length === 0 || DRY_RUN) return

  await execRun(`
    CREATE TABLE IF NOT EXISTS serving_daily_snapshot_dates (
      date TEXT PRIMARY KEY,
      tickers INTEGER NOT NULL,
      computed_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `)

  for (let i = 0; i < uniqueDates.length; i += CHUNK_SIZE) {
    const chunk = uniqueDates.slice(i, i + CHUNK_SIZE)
    const placeholders = chunk.map(() => '?').join(', ')
    await execRun(
      `
        INSERT OR REPLACE INTO serving_daily_snapshot_dates (date, tickers, computed_at)
        SELECT date, COUNT(*) AS tickers, unixepoch()
        FROM daily_snapshots
        WHERE date IN (${placeholders})
        GROUP BY date
      `,
      chunk,
    )
  }
}

async function repairTicker(ticker: string) {
  const rows = await execAll<OHLCV>(
    `
      SELECT date, open, high, low, close, volume
      FROM ohlcv_daily
      WHERE ticker = ?
      ORDER BY date
    `,
    [ticker],
  )

  const calculations = buildSnapshotCalculations(rows)
  const calculatedDates = new Set(calculations.map((row) => row.date))
  const nullDates = rows
    .map((row) => row.date)
    .filter((date) => !calculatedDates.has(date))

  if (!DRY_RUN) {
    for (let i = 0; i < calculations.length; i += CHUNK_SIZE) {
      const chunk = calculations.slice(i, i + CHUNK_SIZE)
      await execBatch(chunk.map((row) => ({ sql: UPSERT_SQL, args: toArgs(ticker, row) })))
    }

    for (let i = 0; i < nullDates.length; i += CHUNK_SIZE) {
      const chunk = nullDates.slice(i, i + CHUNK_SIZE)
      await execBatch(chunk.map((date) => ({ sql: NULLIFY_SQL, args: [ticker, date] })))
    }
  }

  return {
    ticker,
    ohlcvRows: rows.length,
    recalculatedRows: calculations.length,
    nullifiedDates: nullDates.length,
    touchedDates: [...calculatedDates, ...nullDates],
  }
}

async function main() {
  const gapTickers = await findGapTickers()
  const touchedDates = new Set<string>()
  let recalculatedRows = 0
  let nullifiedDates = 0

  console.log(`gap-adjusted snapshot repair: tickers=${gapTickers.length} dryRun=${DRY_RUN ? 'yes' : 'no'}`)

  for (let i = 0; i < gapTickers.length; i++) {
    const item = gapTickers[i]
    const result = await repairTicker(item.ticker)
    recalculatedRows += result.recalculatedRows
    nullifiedDates += result.nullifiedDates
    for (const date of result.touchedDates) touchedDates.add(date)
    console.log(
      `[${i + 1}/${gapTickers.length}] ${item.ticker}: ohlcv=${result.ohlcvRows} recalculated=${result.recalculatedRows} nullified=${result.nullifiedDates}`,
    )
  }

  await refreshSnapshotDateCache(touchedDates)

  console.log(
    `done: tickers=${gapTickers.length} recalculated=${recalculatedRows} nullified=${nullifiedDates} touchedDates=${touchedDates.size} dryRun=${DRY_RUN ? 'yes' : 'no'}`,
  )
  console.log(`columns repaired: ${SNAPSHOT_COLUMNS.join(', ')}`)
}

main().catch((error) => {
  console.error('Fatal:', error)
  process.exit(1)
})
