// scripts/batch-credit-short.ts
//
// Phase 4 B10: J-Quants /markets/margin-interest を取得 (週次)。
// 標準は date 指定の一括取得。銘柄別取得は補修用に残す。
//
// 使い方:
//   USE_LOCAL_DB=1 npm run batch:credit-short
//
// 環境変数:
//   CREDIT_FETCH_MODE=ticker  銘柄別取得に切替
//   TICKERS=7203,9984         銘柄別取得の対象銘柄
//   FROM_DATE=2026-01-01      銘柄別取得の from パラメータ
//   MARGIN_DATE=2026-05-15    date 一括取得の日付を固定
//   CREDIT_HISTORY_WEEKS=4    date 自動取得時に保存する直近週数

import { db, client, ensureReady } from '@/lib/db/client'
import { weeklyMarginInterest, tickerUniverse, batchRuns } from '@/lib/db/schema'
import { fetchJQuantsWeeklyMargin, fetchJQuantsWeeklyMarginByDate, type JMarginRow } from '@/lib/jquants'
import { and, eq, inArray } from 'drizzle-orm'

const RATE_LIMIT_MS = Number(process.env.CREDIT_RATE_LIMIT_MS ?? 350)
const CONCURRENCY = Math.max(1, Number(process.env.CREDIT_CONCURRENCY ?? 2))
const MAX_RETRIES = Math.max(0, Number(process.env.CREDIT_MAX_RETRIES ?? 4))
const RETRY_BASE_MS = Number(process.env.CREDIT_RETRY_BASE_MS ?? 1200)
const PROGRESS_EVERY = Number(process.env.CREDIT_PROGRESS_EVERY ?? 200)
const FETCH_MODE = (process.env.CREDIT_FETCH_MODE ?? 'date').trim()
const DATE_LOOKBACK_DAYS = Math.max(1, Number(process.env.CREDIT_DATE_LOOKBACK_DAYS ?? 45))
const HISTORY_WEEKS = Math.max(1, Number(process.env.CREDIT_HISTORY_WEEKS ?? 4))

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function numeric(value: string | number | undefined): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string') return parseFloat(value)
  return NaN
}

function longVolume(row: JMarginRow): number {
  return numeric(row.LongVol ?? row.LongMarginTradeVolume)
}

function shortVolume(row: JMarginRow): number {
  return numeric(row.ShrtVol ?? row.ShortMarginTradeVolume)
}

function normalizeCode(code: string): string {
  const trimmed = code.trim()
  return trimmed.length === 5 && trimmed.endsWith('0') ? trimmed.slice(0, 4) : trimmed
}

function isRateLimit(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /\b429\b|Rate limit/i.test(message)
}

async function fetchMarginWithRetry(ticker: string, fromDate?: string): Promise<JMarginRow[]> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetchJQuantsWeeklyMargin(ticker, fromDate)
    } catch (error) {
      if (!isRateLimit(error) || attempt >= MAX_RETRIES) throw error
      const wait = RETRY_BASE_MS * 2 ** attempt + Math.floor(Math.random() * 350)
      await sleep(wait)
    }
  }
}

async function fetchAndStore(ticker: string, fromDate?: string): Promise<number> {
  const rows = await fetchMarginWithRetry(ticker, fromDate)
  if (rows.length === 0) return 0

  const sorted = [...rows].sort((a, b) => b.Date.localeCompare(a.Date))
  const dedup = new Map<string, typeof sorted[number]>()
  for (const r of sorted) dedup.set(r.Date, r)
  const items = Array.from(dedup.values()).slice(0, 4)

  let inserted = 0
  for (let j = 0; j < items.length; j++) {
    const cur = items[j]
    const prev = items[j + 1]
    const longCur = longVolume(cur)
    const shortCur = shortVolume(cur)
    const longPrev = prev ? longVolume(prev) : NaN
    const shortPrev = prev ? shortVolume(prev) : NaN
    await client.execute({
      sql: `INSERT INTO weekly_margin_interest (ticker, date, long_margin, short_margin, long_change, short_change, imported_at)
            VALUES (?, ?, ?, ?, ?, ?, unixepoch())
            ON CONFLICT(ticker, date) DO UPDATE SET
              long_margin = excluded.long_margin,
              short_margin = excluded.short_margin,
              long_change = excluded.long_change,
              short_change = excluded.short_change`,
      args: [
        ticker,
        cur.Date,
        Number.isFinite(longCur) ? longCur : null,
        Number.isFinite(shortCur) ? shortCur : null,
        Number.isFinite(longCur) && Number.isFinite(longPrev) ? longCur - longPrev : null,
        Number.isFinite(shortCur) && Number.isFinite(shortPrev) ? shortCur - shortPrev : null,
      ],
    })
    inserted++
  }
  return inserted
}

async function latestOhlcvDate(): Promise<string | null> {
  const row = await client.execute(`SELECT MAX(date) AS date FROM ohlcv_daily`)
  return (row.rows[0]?.date as string | null | undefined) ?? null
}

function addDays(date: string, delta: number): string {
  const d = new Date(`${date}T00:00:00+09:00`)
  d.setDate(d.getDate() + delta)
  return d.toISOString().slice(0, 10)
}

async function resolveMarginDates(): Promise<Array<{ date: string; rows: JMarginRow[] }>> {
  const fixed = process.env.MARGIN_DATE?.trim()
  if (fixed) return [{ date: fixed, rows: await fetchJQuantsWeeklyMarginByDate(fixed) }]

  const latest = await latestOhlcvDate()
  if (!latest) return []
  const found: Array<{ date: string; rows: JMarginRow[] }> = []
  for (let i = 0; i <= DATE_LOOKBACK_DAYS; i += 1) {
    const date = addDays(latest, -i)
    const rows = await fetchJQuantsWeeklyMarginByDate(date)
    if (rows.length > 0) {
      found.push({ date, rows })
      if (found.length >= HISTORY_WEEKS) return found
    }
    if (RATE_LIMIT_MS > 0) await sleep(Math.min(RATE_LIMIT_MS, 1000))
  }
  return found
}

async function storeDateRows(rows: JMarginRow[]): Promise<number> {
  const dedup = new Map<string, JMarginRow>()
  for (const row of rows) {
    if (!row.Code || !row.Date) continue
    dedup.set(`${normalizeCode(row.Code)}\t${row.Date}`, row)
  }
  let inserted = 0
  const CHUNK = 300
  const items = Array.from(dedup.values())
  for (let i = 0; i < items.length; i += CHUNK) {
    const chunk = items.slice(i, i + CHUNK)
    await client.batch(chunk.map((row) => {
      const ticker = normalizeCode(row.Code)
      const longCur = longVolume(row)
      const shortCur = shortVolume(row)
      return {
        sql: `INSERT INTO weekly_margin_interest (ticker, date, long_margin, short_margin, long_change, short_change, imported_at)
              VALUES (?, ?, ?, ?, NULL, NULL, unixepoch())
              ON CONFLICT(ticker, date) DO UPDATE SET
                long_margin = excluded.long_margin,
                short_margin = excluded.short_margin,
                imported_at = excluded.imported_at`,
        args: [
          ticker,
          row.Date,
          Number.isFinite(longCur) ? longCur : null,
          Number.isFinite(shortCur) ? shortCur : null,
        ],
      }
    }))
    inserted += chunk.length
  }

  const dates = Array.from(new Set(items.map((row) => row.Date))).sort()
  for (const date of dates) {
    await client.execute({
      sql: `
        UPDATE weekly_margin_interest
        SET
          long_change = CASE
            WHEN (
              SELECT prev.long_margin
              FROM weekly_margin_interest prev
              WHERE prev.ticker = weekly_margin_interest.ticker
                AND prev.date < weekly_margin_interest.date
              ORDER BY prev.date DESC
              LIMIT 1
            ) IS NULL THEN NULL
            ELSE long_margin - (
              SELECT prev.long_margin
              FROM weekly_margin_interest prev
              WHERE prev.ticker = weekly_margin_interest.ticker
                AND prev.date < weekly_margin_interest.date
              ORDER BY prev.date DESC
              LIMIT 1
            )
          END,
          short_change = CASE
            WHEN (
              SELECT prev.short_margin
              FROM weekly_margin_interest prev
              WHERE prev.ticker = weekly_margin_interest.ticker
                AND prev.date < weekly_margin_interest.date
              ORDER BY prev.date DESC
              LIMIT 1
            ) IS NULL THEN NULL
            ELSE short_margin - (
              SELECT prev.short_margin
              FROM weekly_margin_interest prev
              WHERE prev.ticker = weekly_margin_interest.ticker
                AND prev.date < weekly_margin_interest.date
              ORDER BY prev.date DESC
              LIMIT 1
            )
          END
        WHERE date = ?
      `,
      args: [date],
    })
  }

  return inserted
}

async function main() {
  await ensureReady()

  const [run] = await db
    .insert(batchRuns)
    .values({ jobType: 'credit_short', startedAt: new Date(), status: 'running' })
    .returning({ id: batchRuns.id })
  const runId = run.id

  if (FETCH_MODE !== 'ticker') {
    const dateRows = await resolveMarginDates()
    const rows = dateRows.flatMap((item) => item.rows)
    const dates = dateRows.map((item) => item.date)
    console.log(`Credit-short date fetch: dates=${dates.join(',') || '-'}, rows=${rows.length.toLocaleString()}`)
    const rowsInserted = await storeDateRows(rows)
    await db
      .update(batchRuns)
      .set({
        finishedAt: new Date(),
        status: rowsInserted > 0 ? 'success' : 'empty',
        totalTickers: rows.length,
        succeeded: rows.length,
        failed: 0,
        rowsInserted,
        errorSummary: rowsInserted > 0 ? null : JSON.stringify({ message: 'J-Quants margin-interest returned no rows', dates }),
      })
      .where(eq(batchRuns.id, runId))
    console.log(`完了: ${rowsInserted.toLocaleString()} 行 / ${rows.length.toLocaleString()} レコード / dates=${dates.join(',') || '-'}`)
    return
  }

  const fromDate = process.env.FROM_DATE
  const filter = process.env.TICKERS?.split(',').map(s => s.trim()).filter(Boolean)

  let tickers: string[]
  if (filter && filter.length > 0) {
    tickers = filter
  } else {
    const rows = await db
      .select({ ticker: tickerUniverse.ticker })
      .from(tickerUniverse)
      .where(and(
        eq(tickerUniverse.active, true),
        inArray(tickerUniverse.margin_type, ['貸借', '信用']),
      ))
    tickers = rows.map(r => r.ticker)
  }

  let succeeded = 0
  let failed = 0
  let rowsInserted = 0
  const errors: string[] = []
  const startTime = Date.now()

  console.log(`Credit-short fetch 開始: ${tickers.length} 銘柄 (from=${fromDate ?? 'all'}, CONCURRENCY=${CONCURRENCY}, RATE_LIMIT_MS=${RATE_LIMIT_MS}, RETRIES=${MAX_RETRIES})`)

  let nextIndex = 0
  let processed = 0

  async function worker(workerId: number) {
    while (true) {
      const i = nextIndex++
      const ticker = tickers[i]
      if (!ticker) return
      try {
        rowsInserted += await fetchAndStore(ticker, fromDate)
        succeeded++
      } catch (err) {
        failed++
        const msg = `${ticker}: ${err instanceof Error ? err.message : String(err)}`
        errors.push(msg)
        console.error(`✗ worker=${workerId} ${msg}`)
      } finally {
        processed++
        if (processed % PROGRESS_EVERY === 0 || processed === tickers.length) {
          const pct = ((processed / tickers.length) * 100).toFixed(1)
          const elapsedMin = ((Date.now() - startTime) / 60000).toFixed(1)
          console.log(`[${processed}/${tickers.length} ${pct}%] 累計 ${rowsInserted}, 失敗 ${failed}, ${elapsedMin}min`)
        }
        if (RATE_LIMIT_MS > 0) await sleep(RATE_LIMIT_MS)
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, tickers.length) }, (_, i) => worker(i + 1)),
  )

  const finalStatus = failed === 0 ? 'success' : succeeded === 0 ? 'failed' : 'partial'
  await db
    .update(batchRuns)
    .set({
      finishedAt: new Date(),
      status: finalStatus,
      totalTickers: tickers.length,
      succeeded,
      failed,
      rowsInserted,
      errorSummary: JSON.stringify(errors.slice(0, 10)),
    })
    .where(eq(batchRuns.id, runId))

  console.log(`完了: ${succeeded} 成功 / ${failed} 失敗 / ${rowsInserted} 行 / ${finalStatus}`)
}

main().catch(err => { console.error('Fatal:', err); process.exit(1) })
