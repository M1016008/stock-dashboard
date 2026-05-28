// market_ohlcv_daily(market='US') からUS用ステージスナップショットを生成する。

import { db, ensureReady, execAll, execGet, execRun } from '@/lib/db/client'
import { marketDailySnapshots, marketDataRuns } from '@/lib/db/schema'
import { calculateAllStages, type MaValues } from '@/lib/hex-stage'
import type { OHLCV } from '@/types/stock'
import { eq, sql } from 'drizzle-orm'

const MARKET = 'US'
const CONCURRENCY = Math.max(1, Number(process.env.US_SNAPSHOT_CONCURRENCY ?? 4))
const LIMIT = Number(process.env.US_SNAPSHOT_LIMIT ?? 0)
const INCLUDE_INACTIVE = process.env.US_INCLUDE_INACTIVE === '1'
const REBUILD = process.env.US_SNAPSHOT_REBUILD === '1'
const TICKERS = process.env.TICKERS?.split(',').map((value) => value.trim().toUpperCase()).filter(Boolean)

function prefix(rows: OHLCV[]): number[] {
  const values = [0]
  for (const row of rows) values.push(values[values.length - 1] + row.close)
  return values
}

function dailySmaAt(values: number[], index: number, period: number): number | null {
  const end = index + 1
  if (end < period) return null
  return (values[end] - values[end - period]) / period
}

function sampledSmaAt(rows: OHLCV[], index: number, step: number, period: number): number | null {
  const firstIndex = index - (period - 1) * step
  if (firstIndex < 0) return null
  let sum = 0
  for (let i = 0; i < period; i += 1) sum += rows[index - i * step].close
  return sum / period
}

function maAt(rows: OHLCV[], values: number[], index: number): MaValues {
  return {
    ma_5: dailySmaAt(values, index, 5),
    ma_25: dailySmaAt(values, index, 25),
    ma_75: dailySmaAt(values, index, 75),
    ma_150: dailySmaAt(values, index, 150),
    ma_300: dailySmaAt(values, index, 300),
    weekly_ma_5: sampledSmaAt(rows, index, 5, 5),
    weekly_ma_13: sampledSmaAt(rows, index, 5, 13),
    weekly_ma_25: sampledSmaAt(rows, index, 5, 25),
    weekly_ma_50: sampledSmaAt(rows, index, 5, 50),
    weekly_ma_100: sampledSmaAt(rows, index, 5, 100),
    monthly_ma_3: sampledSmaAt(rows, index, 21, 3),
    monthly_ma_5: sampledSmaAt(rows, index, 21, 5),
    monthly_ma_10: sampledSmaAt(rows, index, 21, 10),
    monthly_ma_20: sampledSmaAt(rows, index, 21, 20),
    monthly_ma_25: sampledSmaAt(rows, index, 21, 25),
  }
}

async function loadTargets(): Promise<string[]> {
  if (TICKERS?.length) return TICKERS
  const rows = await execAll<{ ticker: string }>(
    `
    SELECT u.ticker
    FROM market_universe u
    WHERE u.market = ?
      AND (? = 1 OR u.active = 1)
      AND EXISTS (
        SELECT 1 FROM market_ohlcv_daily o
        WHERE o.market = u.market AND o.ticker = u.ticker
      )
    ORDER BY u.ticker
    ${LIMIT > 0 ? 'LIMIT ?' : ''}
    `,
    LIMIT > 0 ? [MARKET, INCLUDE_INACTIVE ? 1 : 0, LIMIT] : [MARKET, INCLUDE_INACTIVE ? 1 : 0],
  )
  return rows.map((row) => row.ticker)
}

async function computeTicker(ticker: string): Promise<number> {
  if (REBUILD) {
    await execRun(`DELETE FROM market_daily_snapshots WHERE market = ? AND ticker = ?`, [MARKET, ticker])
  }
  const [existing, rows] = await Promise.all([
    execGet<{ maxDate: string | null }>(
      `SELECT MAX(date) AS maxDate FROM market_daily_snapshots WHERE market = ? AND ticker = ?`,
      [MARKET, ticker],
    ),
    execAll<OHLCV>(
      `SELECT date, open, high, low, close, volume FROM market_ohlcv_daily WHERE market = ? AND ticker = ? ORDER BY date`,
      [MARKET, ticker],
    ),
  ])
  if (rows.length < 5) return 0
  const values = prefix(rows)
  const inserts: Array<typeof marketDailySnapshots.$inferInsert> = []
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]
    if (!REBUILD && existing?.maxDate && row.date <= existing.maxDate) continue
    const ma = maAt(rows, values, i)
    inserts.push({ market: MARKET, ticker, date: row.date, ...ma, ...calculateAllStages(ma) })
  }
  const CHUNK = 300
  for (let i = 0; i < inserts.length; i += CHUNK) {
    await db.insert(marketDailySnapshots)
      .values(inserts.slice(i, i + CHUNK))
      .onConflictDoUpdate({
        target: [marketDailySnapshots.market, marketDailySnapshots.ticker, marketDailySnapshots.date],
        set: {
          ma_5: sql`excluded.ma_5`,
          ma_25: sql`excluded.ma_25`,
          ma_75: sql`excluded.ma_75`,
          ma_150: sql`excluded.ma_150`,
          ma_300: sql`excluded.ma_300`,
          weekly_ma_5: sql`excluded.weekly_ma_5`,
          weekly_ma_13: sql`excluded.weekly_ma_13`,
          weekly_ma_25: sql`excluded.weekly_ma_25`,
          weekly_ma_50: sql`excluded.weekly_ma_50`,
          weekly_ma_100: sql`excluded.weekly_ma_100`,
          monthly_ma_3: sql`excluded.monthly_ma_3`,
          monthly_ma_5: sql`excluded.monthly_ma_5`,
          monthly_ma_10: sql`excluded.monthly_ma_10`,
          monthly_ma_20: sql`excluded.monthly_ma_20`,
          monthly_ma_25: sql`excluded.monthly_ma_25`,
          daily_a_stage: sql`excluded.daily_a_stage`,
          daily_b_stage: sql`excluded.daily_b_stage`,
          weekly_a_stage: sql`excluded.weekly_a_stage`,
          weekly_b_stage: sql`excluded.weekly_b_stage`,
          monthly_a_stage: sql`excluded.monthly_a_stage`,
          monthly_b_stage: sql`excluded.monthly_b_stage`,
          computedAt: sql`unixepoch()`,
        },
      })
  }
  return inserts.length
}

async function main() {
  await ensureReady()
  const [run] = await db.insert(marketDataRuns).values({
    market: MARKET,
    jobType: 'snapshot_compute',
    status: 'running',
    payloadJson: JSON.stringify({ rebuild: REBUILD, includeInactive: INCLUDE_INACTIVE, limit: LIMIT || null, tickers: TICKERS ?? null }),
  }).returning({ id: marketDataRuns.id })
  const tickers = await loadTargets()
  let nextIndex = 0
  let succeeded = 0
  let failed = 0
  let rowsInserted = 0
  const errors: string[] = []
  async function worker() {
    while (true) {
      const ticker = tickers[nextIndex++]
      if (!ticker) return
      try {
        const count = await computeTicker(ticker)
        rowsInserted += count
        succeeded += 1
      } catch (error) {
        failed += 1
        errors.push(`${ticker}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tickers.length) }, () => worker()))
  await db.update(marketDataRuns).set({
    status: failed === 0 ? 'success' : succeeded === 0 ? 'failed' : 'partial',
    finishedAt: new Date(),
    totalTickers: tickers.length,
    succeeded,
    failed,
    rowsInserted,
    errorSummary: JSON.stringify(errors.slice(0, 20)),
  }).where(eq(marketDataRuns.id, run.id))
  console.log(`US snapshots complete: tickers=${tickers.length}, rows=${rowsInserted}, failed=${failed}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
