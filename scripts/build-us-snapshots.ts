// market_ohlcv_daily(market='US') からUS用ステージスナップショットを生成する。

import { db, ensureReady, execAll, execGet } from '@/lib/db/client'
import { marketDailySnapshots, marketDataRuns } from '@/lib/db/schema'
import { buildSnapshotCalculations } from '@/lib/snapshots/continuous-ma'
import {
  US_ADJUSTED_PRICE_BASIS,
  toAdjustedUsOhlcvRows,
  type UsRawOhlcvRow,
} from '@/lib/us-adjusted-ohlcv'
import { usInvestableSymbolSql } from '@/lib/us-symbol-quality'
import { computeUsScreenerPeriodMetrics } from '@/lib/us-screener-period-metrics'
import type { OHLCV } from '@/types/stock'
import { eq, sql } from 'drizzle-orm'

const MARKET = 'US'
const CONCURRENCY = Math.max(1, Number(process.env.US_SNAPSHOT_CONCURRENCY ?? 4))
const LIMIT = Number(process.env.US_SNAPSHOT_LIMIT ?? 0)
const INCLUDE_INACTIVE = process.env.US_INCLUDE_INACTIVE === '1'
const REBUILD = process.env.US_SNAPSHOT_REBUILD === '1'
const PROGRESS_EVERY = Math.max(10, Number(process.env.US_SNAPSHOT_PROGRESS_EVERY ?? 50))
const TICKER_START = process.env.US_SNAPSHOT_TICKER_START?.trim().toUpperCase() || null
const TICKER_END = process.env.US_SNAPSHOT_TICKER_END?.trim().toUpperCase() || null
const TICKERS = process.env.TICKERS?.split(',').map((value) => value.trim().toUpperCase()).filter(Boolean)

async function loadTargets(): Promise<string[]> {
  if (TICKERS?.length) return TICKERS
  const where = [
    `u.market = ?`,
    `(? = 1 OR u.active = 1)`,
    usInvestableSymbolSql('u.ticker'),
    `EXISTS (
      SELECT 1 FROM market_ohlcv_daily o
      WHERE o.market = u.market AND o.ticker = u.ticker
    )`,
  ]
  const args: Array<string | number> = [MARKET, INCLUDE_INACTIVE ? 1 : 0]
  if (TICKER_START) {
    where.push('u.ticker >= ?')
    args.push(TICKER_START)
  }
  if (TICKER_END) {
    where.push('u.ticker <= ?')
    args.push(TICKER_END)
  }
  if (LIMIT > 0) args.push(LIMIT)
  const rows = await execAll<{ ticker: string }>(
    `
    SELECT u.ticker
    FROM market_universe u
    WHERE ${where.join('\n      AND ')}
    ORDER BY u.ticker
    ${LIMIT > 0 ? 'LIMIT ?' : ''}
    `,
    args,
  )
  return rows.map((row) => row.ticker)
}

async function loadMarketDates(): Promise<string[]> {
  const rows = await execAll<{ date: string }>(
    `SELECT DISTINCT date
     FROM market_ohlcv_daily INDEXED BY market_ohlcv_market_date_idx
     WHERE market = ?
     ORDER BY date`,
    [MARKET],
  )
  return rows.map((row) => row.date)
}

async function computeTicker(ticker: string, marketDates: string[]): Promise<number> {
  const [existing, rawRows] = await Promise.all([
    execGet<{ maxDate: string | null; maxMetricDate: string | null }>(
      `SELECT
         MAX(date) AS maxDate,
         MAX(CASE WHEN avg_volume_20 IS NOT NULL THEN date END) AS maxMetricDate
       FROM market_daily_snapshots WHERE market = ? AND ticker = ?`,
      [MARKET, ticker],
    ),
    execAll<UsRawOhlcvRow>(
      `SELECT
         date, open, high, low, close, volume,
         adj_open AS adjustedOpen,
         adj_high AS adjustedHigh,
         adj_low AS adjustedLow,
         adj_close AS adjustedClose,
         adj_volume AS adjustedVolume
       FROM market_ohlcv_daily
       WHERE market = ? AND ticker = ?
       ORDER BY date`,
      [MARKET, ticker],
    ),
  ])
  const rows: OHLCV[] = toAdjustedUsOhlcvRows(rawRows)
  if (rows.length < 5) return 0
  const calculationsByDate = new Map(
    buildSnapshotCalculations(rows, { includeWarmup: true }).map((calculation) => [calculation.date, calculation]),
  )
  const periodMetrics = computeUsScreenerPeriodMetrics(rows, marketDates)
  const inserts: Array<typeof marketDailySnapshots.$inferInsert> = []
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]
    const latestNeedsMetricBackfill = Boolean(
      existing?.maxDate
      && row.date === existing.maxDate
      && existing.maxMetricDate !== existing.maxDate,
    )
    if (!REBUILD && existing?.maxDate && row.date <= existing.maxDate && !latestNeedsMetricBackfill) continue
    const calculation = calculationsByDate.get(row.date)
    if (!calculation) continue
    const {
      date: _date,
      activeDays: _activeDays,
      segmentStartDate: _segmentStartDate,
      ...snapshotValues
    } = calculation
    const metrics = periodMetrics[i]
    inserts.push({
      market: MARKET,
      ticker,
      date: row.date,
      ...snapshotValues,
      ...metrics,
    })
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
          prevClose: sql`excluded.prev_close`,
          close5d: sql`excluded.close_5d`,
          close20d: sql`excluded.close_20d`,
          close60d: sql`excluded.close_60d`,
          close120d: sql`excluded.close_120d`,
          avgVolume20: sql`excluded.avg_volume_20`,
          ma200: sql`excluded.ma_200`,
          ma200Prev: sql`excluded.ma_200_prev`,
          ma200Observations: sql`excluded.ma_200_observations`,
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
    payloadJson: JSON.stringify({
      stage: 'targets',
      priceBasis: US_ADJUSTED_PRICE_BASIS,
      rebuild: REBUILD,
      includeInactive: INCLUDE_INACTIVE,
      tickerStart: TICKER_START,
      tickerEnd: TICKER_END,
      limit: LIMIT || null,
      tickers: TICKERS ?? null,
      heartbeatAt: new Date().toISOString(),
    }),
  }).returning({ id: marketDataRuns.id })
  const [tickers, marketDates] = await Promise.all([loadTargets(), loadMarketDates()])
  await db.update(marketDataRuns).set({
    totalTickers: tickers.length,
    payloadJson: JSON.stringify({
      stage: 'snapshots',
      priceBasis: US_ADJUSTED_PRICE_BASIS,
      rebuild: REBUILD,
      includeInactive: INCLUDE_INACTIVE,
      tickerStart: TICKER_START,
      tickerEnd: TICKER_END,
      limit: LIMIT || null,
      tickers: TICKERS ?? null,
      heartbeatAt: new Date().toISOString(),
    }),
  }).where(eq(marketDataRuns.id, run.id))
  let nextIndex = 0
  let succeeded = 0
  let failed = 0
  let rowsInserted = 0
  let lastPersisted = 0
  let lastContiguousIndex = -1
  let lastCompletedTicker: string | null = null
  let progressSave = Promise.resolve()
  const completedIndices = new Set<number>()
  const errors: string[] = []

  async function persistProgress(force = false) {
    const completed = succeeded + failed
    if (!force && completed - lastPersisted < PROGRESS_EVERY) return
    lastPersisted = completed
    const snapshot = {
      succeeded,
      failed,
      rowsInserted,
      errorSummary: JSON.stringify(errors.slice(0, 20)),
      payloadJson: JSON.stringify({
        stage: 'snapshots',
        priceBasis: US_ADJUSTED_PRICE_BASIS,
        rebuild: REBUILD,
        includeInactive: INCLUDE_INACTIVE,
        tickerStart: TICKER_START,
        tickerEnd: TICKER_END,
        lastCompletedTicker,
        limit: LIMIT || null,
        tickers: TICKERS ?? null,
        heartbeatAt: new Date().toISOString(),
      }),
    }
    progressSave = progressSave.then(async () => {
      await db.update(marketDataRuns).set(snapshot).where(eq(marketDataRuns.id, run.id))
    })
    await progressSave
    console.log(
      `US snapshots progress: ${completed}/${tickers.length}, rows=${rowsInserted}, failed=${failed}`,
    )
  }

  async function worker() {
    while (true) {
      const index = nextIndex++
      const ticker = tickers[index]
      if (!ticker) return
      try {
        const count = await computeTicker(ticker, marketDates)
        rowsInserted += count
        succeeded += 1
        completedIndices.add(index)
        while (completedIndices.has(lastContiguousIndex + 1)) {
          completedIndices.delete(lastContiguousIndex + 1)
          lastContiguousIndex += 1
        }
        lastCompletedTicker = tickers[lastContiguousIndex] ?? null
      } catch (error) {
        failed += 1
        errors.push(`${ticker}: ${error instanceof Error ? error.message : String(error)}`)
      }
      await persistProgress()
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tickers.length) }, () => worker()))
    await persistProgress(true)
    await db.update(marketDataRuns).set({
      status: failed === 0 ? 'success' : succeeded === 0 ? 'failed' : 'partial',
      finishedAt: new Date(),
      totalTickers: tickers.length,
      succeeded,
      failed,
      rowsInserted,
      errorSummary: JSON.stringify(errors.slice(0, 20)),
      payloadJson: JSON.stringify({
        stage: 'complete',
        priceBasis: US_ADJUSTED_PRICE_BASIS,
        rebuild: REBUILD,
        includeInactive: INCLUDE_INACTIVE,
        tickerStart: TICKER_START,
        tickerEnd: TICKER_END,
        lastCompletedTicker,
        limit: LIMIT || null,
        tickers: TICKERS ?? null,
        heartbeatAt: new Date().toISOString(),
      }),
    }).where(eq(marketDataRuns.id, run.id))
    if (failed > 0) {
      throw new Error(`US snapshot rebuild incomplete: ${failed} ticker(s) failed`)
    }
    console.log(`US snapshots complete: tickers=${tickers.length}, rows=${rowsInserted}, failed=${failed}`)
  } catch (error) {
    await progressSave.catch(() => undefined)
    await db.update(marketDataRuns).set({
      status: 'failed',
      finishedAt: new Date(),
      totalTickers: tickers.length,
      succeeded,
      failed,
      rowsInserted,
      errorSummary: error instanceof Error ? error.message : String(error),
      payloadJson: JSON.stringify({
        stage: 'failed',
        priceBasis: US_ADJUSTED_PRICE_BASIS,
        rebuild: REBUILD,
        tickerStart: TICKER_START,
        tickerEnd: TICKER_END,
        lastCompletedTicker,
        heartbeatAt: new Date().toISOString(),
      }),
    }).where(eq(marketDataRuns.id, run.id)).catch(() => undefined)
    throw error
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
