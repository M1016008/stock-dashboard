// Tiingo EODから米国株OHLCVを取得し、market_ohlcv_dailyへ保存する。

import { db, ensureReady, execAll, execGet } from '@/lib/db/client'
import { marketDataRuns, marketOhlcvDaily } from '@/lib/db/schema'
import { fetchTiingoDailyPrices, isTiingoRateLimitError } from '@/lib/tiingo'
import { usInvestableSymbolSql } from '@/lib/us-symbol-quality'
import { eq, sql } from 'drizzle-orm'

const MARKET = 'US'
const HISTORY_FROM = process.env.US_HISTORY_FROM ?? '1900-01-01'
const RATE_LIMIT_MS = Number(process.env.US_OHLCV_RATE_LIMIT_MS ?? 250)
const CONCURRENCY = Math.max(1, Number(process.env.US_OHLCV_CONCURRENCY ?? 3))
const INSERT_CHUNK = Math.max(10, Number(process.env.US_OHLCV_INSERT_CHUNK ?? 50))
const LIMIT = Number(process.env.US_OHLCV_LIMIT ?? 0)
const INCLUDE_INACTIVE = process.env.US_INCLUDE_INACTIVE === '1'
const REQUIRE_DATE_RANGE = process.env.US_REQUIRE_DATE_RANGE !== '0'
const BACKFILL_EARLY = process.env.US_BACKFILL_EARLY !== '0'
const TARGET_END_DATE = process.env.US_TARGET_END_DATE?.trim() || null
const TICKERS = process.env.TICKERS?.split(',').map((value) => value.trim().toUpperCase()).filter(Boolean)

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function conciseError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .split('\n')[0]
    .replace(/params:.*/i, 'params:<redacted>')
    .slice(0, 300)
}

function isProviderUnavailableTicker(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /HTTP 404/i.test(message) && /ticker .* not found/i.test(message)
}

function laterDate(a: string, b: string | null): string {
  if (!b) return a
  return a > b ? a : b
}

function nextStartDate(lastDate: string | null, listedStartDate: string | null): string {
  if (!lastDate) return laterDate(HISTORY_FROM, listedStartDate)
  const date = new Date(`${lastDate}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + 1)
  return date.toISOString().slice(0, 10)
}

function previousDate(dateString: string): string {
  const date = new Date(`${dateString}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() - 1)
  return date.toISOString().slice(0, 10)
}

type Target = {
  ticker: string
  firstDate: string | null
  lastDate: string | null
  startDate: string | null
  endDate: string | null
}

async function loadTargets(): Promise<Target[]> {
  if (TICKERS?.length) {
    const rows = await execAll<Target>(
      `
      SELECT t.ticker, MIN(o.date) AS firstDate, MAX(o.date) AS lastDate, u.start_date AS startDate, u.end_date AS endDate
      FROM (
        SELECT value AS ticker
        FROM json_each(?)
      ) t
      LEFT JOIN market_universe u ON u.market = ? AND u.ticker = t.ticker
      LEFT JOIN market_ohlcv_daily o ON o.market = ? AND o.ticker = t.ticker
      GROUP BY t.ticker, u.start_date, u.end_date
      `,
      [JSON.stringify(TICKERS), MARKET, MARKET],
    )
    return rows
  }

  const rows = await execAll<Target>(
    `
    SELECT u.ticker, MIN(o.date) AS firstDate, MAX(o.date) AS lastDate, u.start_date AS startDate, u.end_date AS endDate
    FROM market_universe u
    LEFT JOIN market_ohlcv_daily o
      ON o.market = u.market AND o.ticker = u.ticker
    WHERE u.market = ?
      AND (? = 1 OR u.active = 1)
      AND ${usInvestableSymbolSql('u.ticker')}
      AND (? = 0 OR u.start_date IS NOT NULL OR u.end_date IS NOT NULL)
    GROUP BY u.ticker, u.start_date, u.end_date
    ORDER BY
      CASE WHEN MAX(o.date) IS NULL THEN 0 ELSE 1 END,
      MAX(o.date),
      u.ticker
    ${LIMIT > 0 ? 'LIMIT ?' : ''}
    `,
    LIMIT > 0 ? [MARKET, INCLUDE_INACTIVE ? 1 : 0, REQUIRE_DATE_RANGE ? 1 : 0, LIMIT] : [MARKET, INCLUDE_INACTIVE ? 1 : 0, REQUIRE_DATE_RANGE ? 1 : 0],
  )
  return rows
}

async function fetchAndStore(ticker: string, startDate: string, endDate: string | undefined): Promise<number> {
  const rows = await fetchTiingoDailyPrices(ticker, startDate, endDate)
  if (RATE_LIMIT_MS > 0) await sleep(RATE_LIMIT_MS)
  if (rows.length === 0) return 0

  const CHUNK = INSERT_CHUNK
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK)
    await db.insert(marketOhlcvDaily).values(chunk.map((row) => ({
      market: MARKET,
      ticker,
      date: row.date,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      adjOpen: row.adjustedOpen,
      adjHigh: row.adjustedHigh,
      adjLow: row.adjustedLow,
      adjClose: row.adjustedClose,
      volume: row.volume,
      adjVolume: row.adjustedVolume,
      divCash: row.divCash,
      splitFactor: row.splitFactor,
      source: 'tiingo',
    }))).onConflictDoUpdate({
      target: [marketOhlcvDaily.market, marketOhlcvDaily.ticker, marketOhlcvDaily.date],
      set: {
        open: sql`excluded.open`,
        high: sql`excluded.high`,
        low: sql`excluded.low`,
        close: sql`excluded.close`,
        adjOpen: sql`excluded.adj_open`,
        adjHigh: sql`excluded.adj_high`,
        adjLow: sql`excluded.adj_low`,
        adjClose: sql`excluded.adj_close`,
        volume: sql`excluded.volume`,
        adjVolume: sql`excluded.adj_volume`,
        divCash: sql`excluded.div_cash`,
        splitFactor: sql`excluded.split_factor`,
        importedAt: sql`unixepoch()`,
      },
    })
  }
  return rows.length
}

async function storeTicker(target: Target): Promise<number> {
  const desiredStartDate = laterDate(HISTORY_FROM, target.startDate)
  const today = new Date().toISOString().slice(0, 10)
  const requestedEndDate = TARGET_END_DATE && TARGET_END_DATE < today ? TARGET_END_DATE : today
  const finalEndDate = target.endDate && target.endDate < requestedEndDate
    ? target.endDate
    : requestedEndDate
  if (desiredStartDate > today) return 0

  if (BACKFILL_EARLY && target.firstDate && desiredStartDate < target.firstDate) {
    const earlyEndDate = previousDate(target.firstDate)
    if (desiredStartDate <= earlyEndDate) {
      return fetchAndStore(target.ticker, desiredStartDate, earlyEndDate)
    }
  }

  const startDate = nextStartDate(target.lastDate, target.startDate)
  if (startDate > finalEndDate) return 0
  return fetchAndStore(target.ticker, startDate, finalEndDate)
}

async function main() {
  await ensureReady()
  const [run] = await db.insert(marketDataRuns).values({
    market: MARKET,
    jobType: 'tiingo_ohlcv',
    status: 'running',
    payloadJson: JSON.stringify({
      historyFrom: HISTORY_FROM,
      targetEndDate: TARGET_END_DATE,
      limit: LIMIT || null,
      tickers: TICKERS ?? null,
    }),
  }).returning({ id: marketDataRuns.id })

  const targets = await loadTargets()
  let nextIndex = 0
  let succeeded = 0
  let failed = 0
  let unavailable = 0
  let rowsInserted = 0
  let quotaExhausted = false
  let quotaRetryAfterSeconds: number | null = null
  const errors: string[] = []
  const unavailableTickers: string[] = []
  let progressSave = Promise.resolve()

  async function saveProgress() {
    await db.update(marketDataRuns).set({
      status: 'running',
      totalTickers: targets.length,
      succeeded,
      failed,
      rowsInserted,
      errorSummary: JSON.stringify(errors.slice(0, 20)),
      payloadJson: JSON.stringify({
        historyFrom: HISTORY_FROM,
        targetEndDate: TARGET_END_DATE,
        limit: LIMIT || null,
        tickers: TICKERS ?? null,
        unavailable,
        deferred: quotaExhausted ? Math.max(0, targets.length - succeeded - failed - unavailable) : 0,
        quotaExhausted,
        quotaRetryAfterSeconds,
        unavailableTickers: unavailableTickers.slice(0, 50),
      }),
    }).where(eq(marketDataRuns.id, run.id))
  }

  function queueProgressSave() {
    progressSave = progressSave.then(saveProgress).catch((error) => {
      console.error(`progress save failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  async function markInterrupted(signal: NodeJS.Signals) {
    await progressSave
    await db.update(marketDataRuns).set({
      status: 'interrupted',
      finishedAt: new Date(),
      totalTickers: targets.length,
      succeeded,
      failed,
      rowsInserted,
      errorSummary: JSON.stringify([`${signal}: interrupted`, ...errors].slice(0, 20)),
    }).where(eq(marketDataRuns.id, run.id))
  }

  process.once('SIGINT', () => {
    markInterrupted('SIGINT').finally(() => process.exit(130))
  })
  process.once('SIGTERM', () => {
    markInterrupted('SIGTERM').finally(() => process.exit(143))
  })

  console.log(`US OHLCV fetch start: targets=${targets.length}, concurrency=${CONCURRENCY}`)
  queueProgressSave()
  async function worker(workerId: number) {
    while (true) {
      if (quotaExhausted) return
      const target = targets[nextIndex++]
      if (!target) return
      try {
        const count = await storeTicker(target)
        succeeded += 1
        rowsInserted += count
        const processed = succeeded + failed + unavailable
        if (processed % 50 === 0 || processed === targets.length) {
          console.log(`[${processed}/${targets.length}] rows=${rowsInserted}, failed=${failed}, unavailable=${unavailable}`)
          queueProgressSave()
        }
      } catch (error) {
        if (isTiingoRateLimitError(error)) {
          quotaExhausted = true
          quotaRetryAfterSeconds = error.retryAfterSeconds
          console.warn(
            `worker=${workerId} Tiingo quota reached at ${target.ticker}; remaining tickers are deferred to the next scheduled run`,
          )
          queueProgressSave()
          return
        } else if (isProviderUnavailableTicker(error)) {
          unavailable += 1
          unavailableTickers.push(target.ticker)
          console.warn(`worker=${workerId} ${target.ticker}: provider reports ticker unavailable; skipped`)
        } else {
          failed += 1
          const msg = `${target.ticker}: ${conciseError(error)}`
          errors.push(msg)
          console.error(`worker=${workerId} ${msg}`)
        }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, (_, i) => worker(i + 1)))
  await progressSave
  const deferred = quotaExhausted
    ? Math.max(0, targets.length - succeeded - failed - unavailable)
    : 0
  await db.update(marketDataRuns).set({
    status: failed === 0 && deferred === 0 ? 'success' : succeeded === 0 && deferred === 0 ? 'failed' : 'partial',
    finishedAt: new Date(),
    totalTickers: targets.length,
    succeeded,
    failed,
    rowsInserted,
    errorSummary: JSON.stringify(errors.slice(0, 20)),
    payloadJson: JSON.stringify({
      historyFrom: HISTORY_FROM,
      targetEndDate: TARGET_END_DATE,
      limit: LIMIT || null,
      tickers: TICKERS ?? null,
      unavailable,
      deferred,
      quotaExhausted,
      quotaRetryAfterSeconds,
      unavailableTickers: unavailableTickers.slice(0, 50),
    }),
  }).where(eq(marketDataRuns.id, run.id))
  const latest = await execGet<{ date: string | null }>(
    `SELECT MAX(date) AS date FROM market_ohlcv_daily WHERE market = ?`,
    [MARKET],
  )
  console.log(
    `US OHLCV complete: succeeded=${succeeded}, failed=${failed}, unavailable=${unavailable}, deferred=${deferred}, `
    + `rows=${rowsInserted}, latest=${latest?.date ?? '-'}`,
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
