// J-Quants財務サマリから実開示時刻を補完し、次回決算の予想時刻を再計算する。

import { eq } from 'drizzle-orm'
import { db, client, ensureReady } from '@/lib/db/client'
import { batchRuns } from '@/lib/db/schema'
import {
  classifyEarningsTime,
  normalizeEarningsTime,
  predictEarningsTime,
} from '@/lib/earnings-time'
import { fetchJQuantsFinsSummaryByDate, type JFinsSummaryRow } from '@/lib/jquants'

const MODE = process.env.EARNINGS_TIME_MODE ?? 'incremental'
const LOOKBACK_DAYS = Math.max(1, Number(process.env.EARNINGS_TIME_LOOKBACK_DAYS ?? (MODE === 'backfill' ? 1095 : 14)))
const RATE_LIMIT_MS = Math.max(0, Number(process.env.EARNINGS_TIME_RATE_LIMIT_MS ?? 850))
const RETRY_MAX = Math.max(0, Number(process.env.EARNINGS_TIME_RETRY_MAX ?? 4))
const RETRY_BASE_MS = Math.max(1000, Number(process.env.EARNINGS_TIME_RETRY_BASE_MS ?? 15000))
const SOURCE_URL = 'https://jpx-jquants.com/ja/spec/fins-summary'

type DateRow = { announce_date: string }
type ActualRow = {
  ticker: string
  actual_disclosed_time: string | null
}
type FutureRow = {
  ticker: string
  announce_date: string
  scheduled_time: string | null
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function isFinancialStatement(row: JFinsSummaryRow): boolean {
  const extended = row as JFinsSummaryRow & { TypeOfDocument?: string }
  const docType = `${extended.DocType ?? ''} ${extended.TypeOfDocument ?? ''}`
  return (
    Boolean(row.DiscDate) &&
    ['1Q', '2Q', '3Q', 'FY'].includes(row.CurPerType) &&
    /FinancialStatements/i.test(docType)
  )
}

function tickerFromCode(code: string): string {
  return code.replace(/\D/g, '').slice(0, 4)
}

function fiscalPeriod(row: JFinsSummaryRow): string | null {
  return [row.CurPerEn, row.CurPerType].filter(Boolean).join(' ') || null
}

function isRateLimitError(error: unknown): boolean {
  return /429|Rate limit exceeded/i.test(error instanceof Error ? error.message : String(error))
}

async function fetchDateWithRetry(date: string): Promise<JFinsSummaryRow[]> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetchJQuantsFinsSummaryByDate(date)
    } catch (error) {
      if (!isRateLimitError(error) || attempt >= RETRY_MAX) throw error
      await sleep(RETRY_BASE_MS * (attempt + 1))
    }
  }
}

async function loadTargetDates(): Promise<string[]> {
  const startDate = process.env.EARNINGS_TIME_START_DATE
  const endDate = process.env.EARNINGS_TIME_END_DATE
  if (startDate || endDate) {
    const from = startDate ?? endDate
    const to = endDate ?? startDate
    const rows = await client.execute({
      sql: `
        SELECT DISTINCT announce_date
        FROM earnings_calendar
        WHERE announce_date BETWEEN ? AND ?
        ORDER BY announce_date
      `,
      args: [from!, to!],
    })
    return (rows.rows as unknown as DateRow[]).map((row) => row.announce_date)
  }

  const rows = await client.execute({
    sql: `
      SELECT DISTINCT announce_date
      FROM earnings_calendar
      WHERE announce_date <= date('now', 'localtime')
        AND announce_date >= date('now', 'localtime', '-' || ? || ' days')
        AND (
          actual_disclosed_time IS NULL
          OR announce_date >= date('now', 'localtime', '-14 days')
        )
      ORDER BY announce_date
    `,
    args: [LOOKBACK_DAYS],
  })
  return (rows.rows as unknown as DateRow[]).map((row) => row.announce_date)
}

async function upsertActual(row: JFinsSummaryRow, importedAt: number): Promise<boolean> {
  const ticker = tickerFromCode(row.Code)
  const actualTime = normalizeEarningsTime(row.DiscTime)
  if (!ticker || !actualTime) return false
  const actualAt = `${row.DiscDate}T${actualTime}:00+09:00`
  await client.execute({
    sql: `
      INSERT INTO earnings_calendar (
        ticker, announce_date, fiscal_period, source, source_url,
        actual_disclosed_date, actual_disclosed_time, actual_disclosed_at,
        actual_source, actual_source_url, time_bucket, time_updated_at, imported_at
      )
      VALUES (?, ?, ?, 'jquants_fins_summary', ?, ?, ?, ?, 'jquants_fins_summary', ?, ?, ?, ?)
      ON CONFLICT(ticker, announce_date) DO UPDATE SET
        fiscal_period = COALESCE(earnings_calendar.fiscal_period, excluded.fiscal_period),
        source = CASE
          WHEN earnings_calendar.source IN ('jpx', 'jquants') THEN earnings_calendar.source
          ELSE excluded.source
        END,
        source_url = COALESCE(earnings_calendar.source_url, excluded.source_url),
        actual_disclosed_date = excluded.actual_disclosed_date,
        actual_disclosed_time = excluded.actual_disclosed_time,
        actual_disclosed_at = excluded.actual_disclosed_at,
        actual_source = excluded.actual_source,
        actual_source_url = excluded.actual_source_url,
        time_bucket = excluded.time_bucket,
        time_updated_at = excluded.time_updated_at,
        imported_at = MAX(earnings_calendar.imported_at, excluded.imported_at)
    `,
    args: [
      ticker,
      row.DiscDate,
      fiscalPeriod(row),
      SOURCE_URL,
      row.DiscDate,
      actualTime,
      actualAt,
      SOURCE_URL,
      classifyEarningsTime(actualTime, row.DiscDate),
      importedAt,
      importedAt,
    ],
  })
  return true
}

async function rebuildPredictions(importedAt: number): Promise<number> {
  const actualResult = await client.execute(`
    SELECT ticker, actual_disclosed_time
    FROM earnings_calendar
    WHERE actual_disclosed_time IS NOT NULL
    ORDER BY ticker, announce_date DESC
  `)
  const timesByTicker = new Map<string, string[]>()
  for (const row of actualResult.rows as unknown as ActualRow[]) {
    const values = timesByTicker.get(row.ticker) ?? []
    if (values.length < 8 && row.actual_disclosed_time) values.push(row.actual_disclosed_time)
    timesByTicker.set(row.ticker, values)
  }

  const futureResult = await client.execute(`
    SELECT ticker, announce_date, scheduled_time
    FROM earnings_calendar
    WHERE announce_date >= date('now', 'localtime')
    ORDER BY announce_date, ticker
  `)
  let updated = 0
  for (const row of futureResult.rows as unknown as FutureRow[]) {
    const prediction = predictEarningsTime(timesByTicker.get(row.ticker) ?? [])
    const effectiveTime = normalizeEarningsTime(row.scheduled_time) ?? prediction?.time ?? null
    await client.execute({
      sql: `
        UPDATE earnings_calendar
        SET predicted_time = ?,
            prediction_confidence = ?,
            prediction_sample_count = ?,
            prediction_mode_count = ?,
            time_bucket = ?,
            time_updated_at = ?
        WHERE ticker = ? AND announce_date = ?
      `,
      args: [
        prediction?.time ?? null,
        prediction?.confidence ?? null,
        prediction?.sampleCount ?? null,
        prediction?.modeCount ?? null,
        classifyEarningsTime(effectiveTime, row.announce_date),
        importedAt,
        row.ticker,
        row.announce_date,
      ],
    })
    updated += 1
  }
  return updated
}

async function main() {
  await ensureReady()
  const [run] = await db
    .insert(batchRuns)
    .values({ jobType: 'earnings_times', startedAt: new Date(), status: 'running' })
    .returning({ id: batchRuns.id })
  const importedAt = Math.floor(Date.now() / 1000)
  let fetchedDates = 0
  let actualRows = 0

  try {
    const dates = await loadTargetDates()
    console.log(`earnings times: mode=${MODE}, dates=${dates.length}, lookback=${LOOKBACK_DAYS}`)
    for (const [index, date] of dates.entries()) {
      const rows = (await fetchDateWithRetry(date)).filter(isFinancialStatement)
      for (const row of rows) {
        if (await upsertActual(row, importedAt)) actualRows += 1
      }
      fetchedDates += 1
      if ((index + 1) % 25 === 0 || index === dates.length - 1) {
        console.log(`[${index + 1}/${dates.length}] ${date}: actual=${actualRows}`)
      }
      if (RATE_LIMIT_MS > 0) await sleep(RATE_LIMIT_MS)
    }
    const predictedRows = await rebuildPredictions(importedAt)
    await db
      .update(batchRuns)
      .set({
        finishedAt: new Date(),
        status: 'success',
        totalTickers: fetchedDates,
        succeeded: fetchedDates,
        rowsInserted: actualRows + predictedRows,
      })
      .where(eq(batchRuns.id, run.id))
    console.log(`earnings times complete: dates=${fetchedDates}, actual=${actualRows}, future=${predictedRows}`)
  } catch (error) {
    await db
      .update(batchRuns)
      .set({
        finishedAt: new Date(),
        status: 'failed',
        failed: 1,
        rowsInserted: actualRows,
        errorSummary: error instanceof Error ? error.message : String(error),
      })
      .where(eq(batchRuns.id, run.id))
    throw error
  }
}

main().catch((error) => {
  console.error('Fatal:', error)
  process.exit(1)
})
