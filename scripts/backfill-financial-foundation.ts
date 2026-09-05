import fs from 'node:fs'
import { performance } from 'node:perf_hooks'
import { ensureReady, execAll, execGet, execRun, localDbPath } from '@/lib/db/client'
import {
  fetchJQuantsFinsSummary,
  fetchJQuantsFinsSummaryByDate,
  type JFinsSummaryRow,
} from '@/lib/jquants'
import {
  backfillLegacyFinancialSummaries,
  countTickerFoundationRows,
  finalizeTickerFinancialFoundation,
  finishFinancialBackfillCheckpoint,
  getFinancialBackfillCheckpoint,
  loadActiveJapaneseTickers,
  loadKnownFinancialDisclosureDates,
  persistJQuantsBackfillRows,
  startFinancialBackfillCheckpoint,
} from '@/lib/server/financial-foundation-backfill'

type BackfillMode = 'auto' | 'local_only' | 'api_only' | 'finalize_only'

const mode = (process.env.FINANCIAL_BACKFILL_MODE ?? 'auto') as BackfillMode
const force = process.env.FINANCIAL_BACKFILL_FORCE === '1'
const rateLimitMs = Math.max(0, Number(process.env.FINANCIAL_BACKFILL_RATE_LIMIT_MS ?? 250))
const fetchConcurrency = Math.max(1, Math.min(6, Number(process.env.FINANCIAL_BACKFILL_CONCURRENCY ?? 4)))
const apiRequestIntervalMs = Math.max(0, Number(process.env.FINANCIAL_BACKFILL_API_INTERVAL_MS ?? 1_250))
const progressEvery = Math.max(1, Number(process.env.FINANCIAL_BACKFILL_PROGRESS_EVERY ?? 100))
const requestedTickers = (process.env.TICKERS ?? '')
  .split(',')
  .map((ticker) => ticker.trim().replace(/\.T$/i, ''))
  .filter(Boolean)
const fromDate = process.env.FINANCIAL_BACKFILL_FROM?.trim() || null
const toDate = process.env.FINANCIAL_BACKFILL_TO?.trim() || null
const rollingApiStart = new Date()
rollingApiStart.setUTCFullYear(rollingApiStart.getUTCFullYear() - 10)
const apiStartDate = process.env.FINANCIAL_BACKFILL_API_START?.trim()
  || rollingApiStart.toISOString().slice(0, 10)

if (!['auto', 'local_only', 'api_only', 'finalize_only'].includes(mode)) {
  throw new Error(`Unsupported FINANCIAL_BACKFILL_MODE: ${mode}`)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
let apiGate: Promise<void> = Promise.resolve()
let nextApiStartAt = 0

async function waitForApiSlot(): Promise<void> {
  let release!: () => void
  const previous = apiGate
  apiGate = new Promise<void>((resolve) => { release = resolve })
  await previous
  const waitMs = Math.max(0, nextApiStartAt - Date.now())
  if (waitMs > 0) await sleep(waitMs)
  nextApiStartAt = Date.now() + apiRequestIntervalMs
  release()
}

interface DbStats {
  fileBytes: number
  pageSize: number
  pageCount: number
  freelistCount: number
}

async function dbStats(): Promise<DbStats> {
  const [pageSize, pageCount, freelistCount] = await Promise.all([
    execGet<Record<string, unknown>>('PRAGMA page_size'),
    execGet<Record<string, unknown>>('PRAGMA page_count'),
    execGet<Record<string, unknown>>('PRAGMA freelist_count'),
  ])
  const firstNumber = (row: Record<string, unknown> | undefined) => Number(Object.values(row ?? {})[0] ?? 0)
  return {
    fileBytes: fs.statSync(localDbPath).size,
    pageSize: firstNumber(pageSize),
    pageCount: firstNumber(pageCount),
    freelistCount: firstNumber(freelistCount),
  }
}

async function withRetry<T>(label: string, run: () => Promise<T>, attempts = 5): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await waitForApiSlot()
      return await run()
    } catch (error) {
      lastError = error
      const message = error instanceof Error ? error.message : String(error)
      if (/失敗[^:]*:\s*4\d\d\b/.test(message) && !/失敗[^:]*:\s*429\b/.test(message)) break
      if (attempt === attempts) break
      const delay = /失敗[^:]*:\s*429\b/.test(message)
        ? Math.max(65_000, apiRequestIntervalMs * 4)
        : Math.min(8_000, 500 * (2 ** (attempt - 1)))
      console.warn(`[financial-backfill] retry ${label} attempt=${attempt + 1}/${attempts} waitMs=${delay}`)
      await sleep(delay)
    }
  }
  throw lastError
}

async function completed(type: Parameters<typeof getFinancialBackfillCheckpoint>[0], key: string): Promise<boolean> {
  if (force) return false
  const checkpoint = await getFinancialBackfillCheckpoint(type, key)
  return checkpoint?.status === 'complete' || checkpoint?.status === 'no_data'
}

async function persistDate(
  date: string,
  activeTickers: ReadonlySet<string>,
  importedAt: number,
): Promise<{ apiRows: number; targetRows: number; persistedRows: number }> {
  await startFinancialBackfillCheckpoint('jquants_date', date)
  try {
    const rows = await withRetry(`date:${date}`, () => fetchJQuantsFinsSummaryByDate(date))
    const result = await persistJQuantsBackfillRows(rows, activeTickers, importedAt)
    await finishFinancialBackfillCheckpoint({
      checkpointType: 'jquants_date',
      checkpointKey: date,
      status: 'complete',
      sourceRows: result.sourceRows,
      persistedRows: result.persistedRows,
      details: { targetRows: result.targetRows },
    })
    return { apiRows: result.sourceRows, targetRows: result.targetRows, persistedRows: result.persistedRows }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await finishFinancialBackfillCheckpoint({
      checkpointType: 'jquants_date', checkpointKey: date, status: 'error', errorMessage: message,
    })
    throw error
  }
}

async function persistTicker(
  ticker: string,
  activeTickers: ReadonlySet<string>,
  importedAt: number,
): Promise<{ apiRows: number; persistedRows: number; noData: boolean }> {
  await startFinancialBackfillCheckpoint('jquants_ticker', ticker)
  try {
    const rows = await withRetry(`ticker:${ticker}`, () => fetchJQuantsFinsSummary(ticker))
    const result = await persistJQuantsBackfillRows(rows, activeTickers, importedAt)
    const noData = rows.length === 0
    await finishFinancialBackfillCheckpoint({
      checkpointType: 'jquants_ticker',
      checkpointKey: ticker,
      status: noData ? 'no_data' : 'complete',
      sourceRows: result.sourceRows,
      persistedRows: result.persistedRows,
      details: { targetRows: result.targetRows },
    })
    return { apiRows: result.sourceRows, persistedRows: result.persistedRows, noData }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await finishFinancialBackfillCheckpoint({
      checkpointType: 'jquants_ticker', checkpointKey: ticker, status: 'error', errorMessage: message,
    })
    throw error
  }
}

async function sourceFactTickers(): Promise<Set<string>> {
  const rows = await execAll<{ ticker: string }>(`
    SELECT DISTINCT ticker
    FROM normalized_financial_facts
    WHERE is_derived = 0
  `)
  return new Set(rows.map((row) => row.ticker))
}

async function calendarTickers(): Promise<Set<string>> {
  const rows = await execAll<{ ticker: string }>(`
    SELECT DISTINCT e.ticker
    FROM earnings_calendar e
    JOIN ticker_universe u ON u.ticker = e.ticker AND u.active = 1
    WHERE e.source = 'jquants_fins_summary'
  `)
  return new Set(rows.map((row) => row.ticker))
}

async function finalCoverage(targetTickers: string[]) {
  const tickerSet = new Set(targetTickers)
  const rows = await execAll<Record<string, unknown>>(`
    SELECT ticker,
           COUNT(*) AS facts,
           SUM(CASE WHEN is_derived = 0 THEN 1 ELSE 0 END) AS source_facts,
           SUM(CASE WHEN accumulation_kind = 'LTM' THEN 1 ELSE 0 END) AS ltm_facts
    FROM normalized_financial_facts
    GROUP BY ticker
  `)
  const covered = rows.filter((row) => tickerSet.has(String(row.ticker)))
  const forecastRows = await execAll<{ ticker: string }>(`
    SELECT DISTINCT ticker FROM financial_forecast_snapshots
  `)
  const metricRows = await execAll<{ ticker: string }>(`
    SELECT DISTINCT ticker FROM calculated_financial_metrics
  `)
  const forecastSet = new Set(forecastRows.map((row) => row.ticker))
  const metricSet = new Set(metricRows.map((row) => row.ticker))
  return {
    targetTickers: targetTickers.length,
    factTickers: covered.length,
    forecastTickers: targetTickers.filter((ticker) => forecastSet.has(ticker)).length,
    metricTickers: targetTickers.filter((ticker) => metricSet.has(ticker)).length,
    ltmTickers: covered.filter((row) => Number(row.ltm_facts) > 0).length,
    noFactTickers: targetTickers.length - covered.length,
  }
}

async function main() {
  const started = performance.now()
  await ensureReady()
  await execRun(`
    UPDATE financial_foundation_backfill_checkpoints
    SET status = 'no_data',
        details_json = json_object('reason', 'outside_api_subscription', 'apiStartDate', ?),
        error_message = NULL,
        finished_at = unixepoch(),
        updated_at = unixepoch()
    WHERE checkpoint_type = 'jquants_date'
      AND checkpoint_key < ?
      AND status IN ('running', 'error')
  `, [apiStartDate, apiStartDate])
  const before = await dbStats()
  const allActive = await loadActiveJapaneseTickers()
  const requested = new Set(requestedTickers)
  const targetTickers = requested.size > 0
    ? allActive.filter((ticker) => requested.has(ticker))
    : allActive
  const activeSet = new Set(targetTickers)
  const importedAt = Math.floor(Date.now() / 1000)
  const summary = {
    mode,
    targetTickers: targetTickers.length,
    local: { skipped: false, sourceRows: 0, persistedRows: 0 },
    dates: { total: 0, skipped: 0, completed: 0, errors: 0, apiRows: 0, targetRows: 0, persistedRows: 0 },
    tickerFetches: { total: 0, skipped: 0, completed: 0, noData: 0, errors: 0, apiRows: 0, persistedRows: 0 },
    finalize: { total: targetTickers.length, skipped: 0, completed: 0, noData: 0, errors: 0, facts: 0, forecasts: 0, metrics: 0 },
  }

  if (mode === 'auto' || mode === 'local_only') {
    if (await completed('local_legacy', 'all')) {
      summary.local.skipped = true
    } else {
      await startFinancialBackfillCheckpoint('local_legacy', 'all')
      try {
        const result = await backfillLegacyFinancialSummaries(importedAt)
        summary.local.sourceRows = result.sourceRows
        summary.local.persistedRows = result.persistedRows
        await finishFinancialBackfillCheckpoint({
          checkpointType: 'local_legacy', checkpointKey: 'all', status: 'complete',
          sourceRows: result.sourceRows, persistedRows: result.persistedRows,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await finishFinancialBackfillCheckpoint({
          checkpointType: 'local_legacy', checkpointKey: 'all', status: 'error', errorMessage: message,
        })
        throw error
      }
    }
  }

  if (mode === 'auto' || mode === 'api_only') {
    if (requestedTickers.length === 0) {
      const dates = (await loadKnownFinancialDisclosureDates())
        .filter((date) => (
          date >= apiStartDate
          && (!fromDate || date >= fromDate)
          && (!toDate || date <= toDate)
        ))
      summary.dates.total = dates.length
      for (let index = 0; index < dates.length; index += fetchConcurrency) {
        const batch = dates.slice(index, index + fetchConcurrency)
        const results = await Promise.all(batch.map(async (date) => {
          if (await completed('jquants_date', date)) return { date, skipped: true as const }
          try {
            return { date, skipped: false as const, result: await persistDate(date, activeSet, importedAt) }
          } catch (error) {
            return { date, skipped: false as const, error }
          }
        }))
        for (const item of results) {
          if (item.skipped) {
            summary.dates.skipped++
          } else if ('error' in item) {
            summary.dates.errors++
            console.error(`[financial-backfill] date failed date=${item.date} message=${item.error instanceof Error ? item.error.message : String(item.error)}`)
          } else {
            summary.dates.completed++
            summary.dates.apiRows += item.result.apiRows
            summary.dates.targetRows += item.result.targetRows
            summary.dates.persistedRows += item.result.persistedRows
          }
        }
        const processed = index + batch.length
        if (processed % progressEvery < fetchConcurrency || processed === dates.length) {
          console.info(`[financial-backfill] dates ${processed}/${dates.length} complete=${summary.dates.completed} skipped=${summary.dates.skipped} errors=${summary.dates.errors}`)
        }
        if (rateLimitMs > 0) await sleep(rateLimitMs)
      }
      if (summary.dates.errors > 0) {
        throw new Error(`${summary.dates.errors} disclosure-date fetches failed; rerun will resume from checkpoints`)
      }
    }

    const knownCalendar = await calendarTickers()
    const knownFacts = await sourceFactTickers()
    const fallbackTickers = requestedTickers.length > 0
      ? targetTickers
      : targetTickers.filter((ticker) => !knownCalendar.has(ticker) || !knownFacts.has(ticker))
    summary.tickerFetches.total = fallbackTickers.length
    for (let index = 0; index < fallbackTickers.length; index++) {
      const ticker = fallbackTickers[index]
      if (await completed('jquants_ticker', ticker)) {
        summary.tickerFetches.skipped++
        continue
      }
      try {
        const result = await persistTicker(ticker, activeSet, importedAt)
        if (result.noData) summary.tickerFetches.noData++
        else summary.tickerFetches.completed++
        summary.tickerFetches.apiRows += result.apiRows
        summary.tickerFetches.persistedRows += result.persistedRows
      } catch (error) {
        summary.tickerFetches.errors++
        console.error(`[financial-backfill] ticker failed ticker=${ticker} message=${error instanceof Error ? error.message : String(error)}`)
      }
      if ((index + 1) % progressEvery === 0 || index + 1 === fallbackTickers.length) {
        console.info(`[financial-backfill] ticker fetches ${index + 1}/${fallbackTickers.length} complete=${summary.tickerFetches.completed} noData=${summary.tickerFetches.noData} errors=${summary.tickerFetches.errors}`)
      }
      if (rateLimitMs > 0) await sleep(rateLimitMs)
    }
    if (summary.tickerFetches.errors > 0) {
      throw new Error(`${summary.tickerFetches.errors} ticker fetches failed; rerun will resume from checkpoints`)
    }
  }

  if (mode !== 'local_only') {
    for (let index = 0; index < targetTickers.length; index++) {
      const ticker = targetTickers[index]
      if (await completed('ticker_finalize', ticker)) {
        summary.finalize.skipped++
        continue
      }
      await startFinancialBackfillCheckpoint('ticker_finalize', ticker)
      try {
        const result = await finalizeTickerFinancialFoundation(ticker, importedAt)
        if (!result) {
          summary.finalize.noData++
          await finishFinancialBackfillCheckpoint({
            checkpointType: 'ticker_finalize', checkpointKey: ticker, status: 'no_data',
            details: { reason: 'no_jquants_financial_facts' },
          })
        } else {
          const counts = await countTickerFoundationRows(ticker)
          summary.finalize.completed++
          summary.finalize.facts += counts.facts
          summary.finalize.forecasts += counts.forecasts
          summary.finalize.metrics += counts.metrics
          await finishFinancialBackfillCheckpoint({
            checkpointType: 'ticker_finalize', checkpointKey: ticker, status: 'complete',
            sourceRows: result.sourceFacts,
            persistedRows: result.derivedFacts + result.calculatedMetrics,
            details: { ...counts, metricsAsOf: result.metricsAsOf, foundationVersion: 'v1' },
          })
        }
      } catch (error) {
        summary.finalize.errors++
        const message = error instanceof Error ? error.message : String(error)
        await finishFinancialBackfillCheckpoint({
          checkpointType: 'ticker_finalize', checkpointKey: ticker, status: 'error', errorMessage: message,
        })
        console.error(`[financial-backfill] finalize failed ticker=${ticker} message=${message}`)
      }
      if ((index + 1) % Math.max(progressEvery, 100) === 0 || index + 1 === targetTickers.length) {
        console.info(`[financial-backfill] finalize ${index + 1}/${targetTickers.length} complete=${summary.finalize.completed} noData=${summary.finalize.noData} errors=${summary.finalize.errors}`)
      }
    }
  }

  const after = await dbStats()
  const coverage = await finalCoverage(targetTickers)
  const elapsedMs = Math.round(performance.now() - started)
  console.log(JSON.stringify({
    summary,
    coverage,
    performance: {
      elapsedMs,
      elapsedSeconds: Number((elapsedMs / 1000).toFixed(2)),
      dbFileBytesBefore: before.fileBytes,
      dbFileBytesAfter: after.fileBytes,
      dbFileBytesDelta: after.fileBytes - before.fileBytes,
      allocatedBytesDelta: ((after.pageCount - after.freelistCount) - (before.pageCount - before.freelistCount)) * after.pageSize,
      before,
      after,
    },
  }, null, 2))
  if (summary.finalize.errors > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(`Financial foundation backfill failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
