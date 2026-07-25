// Authorized supplemental company-data sync from Traders Web.
// Stock prices and analytics remain J-Quants based. This job reads the JP
// universe once, then writes only to an isolated supplemental SQLite DB.

import fs from 'node:fs'
import path from 'node:path'
import {
  asDbArgs,
  ensureTradersCompanyDataSchema,
  normalizeJpTicker,
  parseTradersCompanyDataHtml,
  tradersCompanyDataClient,
  tradersCompanyDataDbPath,
  TRADERS_COMPANY_SOURCE_BASE_URL,
} from '@/lib/traders-company-data'
import { execAll } from '@/lib/db/client'

type UniverseRow = {
  ticker: string
  name: string | null
  market_segment: string | null
}

type QueueStatusRow = {
  ticker: string
  last_attempt_at: number
}

type SyncCounts = {
  total: number
  processed: number
  success: number
  skipped: number
  failed: number
}

type FetchResult = {
  html: string
  status: number
  finalUrl: string
  rateLimitEvents: number
}

class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message)
  }
}

class SyncInterruptedError extends Error {}

const USER_AGENT = 'StockBoardCompanyDataSync/1.0 (authorized internal supplemental data sync)'
const stopState = { requested: false }
let activeRequestController: AbortController | null = null

function requestStop(): void {
  stopState.requested = true
  activeRequestController?.abort()
}

process.on('SIGINT', requestStop)
process.on('SIGTERM', requestStop)

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.floor(value)))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function interruptibleSleep(ms: number): Promise<void> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (stopState.requested) throw new SyncInterruptedError('sync interrupted')
    await sleep(Math.min(500, until - Date.now()))
  }
}

function requestedTickers(): string[] {
  const configured = process.env.TRADERS_COMPANY_TICKERS?.trim()
  if (!configured) return []
  return configured
    .split(',')
    .map((value) => normalizeJpTicker(value))
    .filter((value): value is string => Boolean(value))
}

async function loadUniverse(): Promise<UniverseRow[]> {
  const selected = requestedTickers()
  const rows = await execAll<UniverseRow>(
    `SELECT ticker, name, market_segment
     FROM ticker_universe
     WHERE active = 1
     ORDER BY ticker`,
  )
  const selectedSet = new Set(selected)
  const valid = rows.filter((row) => normalizeJpTicker(row.ticker))
  if (selected.length > 0) {
    const byTicker = new Map(valid.map((row) => [normalizeJpTicker(row.ticker) as string, row]))
    return selected.map((ticker) => byTicker.get(ticker) ?? {
      ticker,
      name: null,
      market_segment: null,
    })
  }
  const limit = envInt('TRADERS_COMPANY_LIMIT', 0, 0, 10_000)
  const prioritized = await prioritizeOldestAttempts(valid)
  return limit > 0 ? prioritized.slice(0, limit) : prioritized
}

async function prioritizeOldestAttempts(rows: UniverseRow[]): Promise<UniverseRow[]> {
  const result = await tradersCompanyDataClient().execute(
    `SELECT ticker, last_attempt_at
     FROM traders_company_data_status`,
  )
  const attempts = new Map(
    (result.rows as unknown as QueueStatusRow[])
      .map((row) => [normalizeJpTicker(row.ticker), Number(row.last_attempt_at)] as const)
      .filter((entry): entry is [string, number] => Boolean(entry[0])),
  )
  return [...rows].sort((a, b) => {
    const aTicker = normalizeJpTicker(a.ticker) ?? a.ticker
    const bTicker = normalizeJpTicker(b.ticker) ?? b.ticker
    const attemptDifference = (attempts.get(aTicker) ?? 0) - (attempts.get(bTicker) ?? 0)
    return attemptDifference || aTicker.localeCompare(bTicker)
  })
}

function acquireProcessLock(dbPath: string): () => void {
  const lockPath = `${dbPath}.sync.lock`
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  try {
    const handle = fs.openSync(lockPath, 'wx')
    fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, startedAt: nowSec() }))
    fs.closeSync(handle)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const existing = readLock(lockPath)
    if (existing?.pid && processExists(existing.pid)) {
      throw new Error(`company-data sync is already running (pid=${existing.pid})`)
    }
    fs.rmSync(lockPath, { force: true })
    const handle = fs.openSync(lockPath, 'wx')
    fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, startedAt: nowSec() }))
    fs.closeSync(handle)
  }
  return () => fs.rmSync(lockPath, { force: true })
}

function readLock(lockPath: string): { pid?: number } | null {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { pid?: number }
  } catch {
    return null
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function fetchCompanyPage(ticker: string): Promise<FetchResult> {
  const timeoutMs = envInt('TRADERS_COMPANY_FETCH_TIMEOUT_MS', 20_000, 3_000, 60_000)
  const retryCount = envInt('TRADERS_COMPANY_RETRIES', 4, 0, 8)
  const rateLimitBackoffMs = envInt(
    'TRADERS_COMPANY_RATE_LIMIT_BACKOFF_MS',
    60_000,
    15_000,
    900_000,
  )
  const url = `${TRADERS_COMPANY_SOURCE_BASE_URL}/stocks/${encodeURIComponent(ticker)}/`
  let rateLimitEvents = 0

  for (let attempt = 0; ; attempt += 1) {
    if (stopState.requested) throw new SyncInterruptedError('sync interrupted')
    const controller = new AbortController()
    activeRequestController = controller
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(url, {
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'ja,en-US;q=0.7,en;q=0.5',
        },
      })
      if (response.status === 404) {
        throw new HttpStatusError(404, 'page_not_found')
      }
      if (!response.ok) {
        throw new HttpStatusError(
          response.status,
          `HTTP ${response.status}`,
          parseRetryAfterMs(response.headers.get('retry-after')),
        )
      }
      return {
        html: await response.text(),
        status: response.status,
        finalUrl: response.url || url,
        rateLimitEvents,
      }
    } catch (error) {
      if (stopState.requested) throw new SyncInterruptedError('sync interrupted')
      const status = error instanceof HttpStatusError ? error.status : 0
      const retryable = status === 0 || status === 429 || status >= 500
      if (!retryable || attempt >= retryCount) throw error
      if (status === 429) {
        rateLimitEvents += 1
        const retryAfterMs = error instanceof HttpStatusError ? error.retryAfterMs : null
        const backoffMs = Math.min(
          900_000,
          Math.max(retryAfterMs ?? 0, rateLimitBackoffMs * 2 ** attempt),
        )
        console.warn(
          `[traders-company] rate limited ticker=${ticker}`
          + ` attempt=${attempt + 1}/${retryCount + 1} wait=${Math.ceil(backoffMs / 1000)}s`,
        )
        await interruptibleSleep(backoffMs)
      } else {
        await interruptibleSleep(Math.min(30_000, 1_500 * 2 ** attempt))
      }
    } finally {
      clearTimeout(timeout)
      if (activeRequestController === controller) activeRequestController = null
    }
  }
}

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(900_000, Math.ceil(seconds * 1_000))
  }
  const dateMs = Date.parse(value)
  if (!Number.isFinite(dateMs)) return null
  return Math.min(900_000, Math.max(0, dateMs - Date.now()))
}

async function startRun(total: number): Promise<number> {
  const client = tradersCompanyDataClient()
  const startedAt = nowSec()
  await client.execute({
    sql: `UPDATE traders_company_data_runs
      SET status = 'interrupted', finished_at = ?
      WHERE status = 'running'`,
    args: [startedAt],
  })
  const result = await client.execute({
    sql: `INSERT INTO traders_company_data_runs(started_at, status, total_count)
      VALUES (?, 'running', ?)
      RETURNING id`,
    args: [startedAt, total],
  })
  return Number(result.rows[0]?.id)
}

async function updateRun(
  runId: number,
  counts: SyncCounts,
  errors: string[],
  status = 'running',
  finishedAt: number | null = null,
): Promise<void> {
  await tradersCompanyDataClient().execute({
    sql: `UPDATE traders_company_data_runs
      SET finished_at = ?,
          status = ?,
          processed_count = ?,
          success_count = ?,
          skipped_count = ?,
          failed_count = ?,
          error_summary_json = ?
      WHERE id = ?`,
    args: [
      finishedAt,
      status,
      counts.processed,
      counts.success,
      counts.skipped,
      counts.failed,
      JSON.stringify(errors.slice(-100)),
      runId,
    ],
  })
}

async function recordSuccess(
  ticker: string,
  fallbackName: string | null,
  fetched: FetchResult,
): Promise<boolean> {
  const parsed = parseTradersCompanyDataHtml(fetched.html)
  if (!parsed) {
    await recordUnavailable(ticker, fetched.status, 'company_data_missing')
    return false
  }

  const timestamp = nowSec()
  const client = tradersCompanyDataClient()
  await client.batch([
    {
      sql: `INSERT INTO traders_company_data(
          ticker, name, feature_summary, company_url, listing_date, fields_json,
          source_url, content_hash, fetched_at, first_seen_at, last_changed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(ticker) DO UPDATE SET
          name = excluded.name,
          feature_summary = excluded.feature_summary,
          company_url = excluded.company_url,
          listing_date = excluded.listing_date,
          fields_json = excluded.fields_json,
          source_url = excluded.source_url,
          fetched_at = excluded.fetched_at,
          last_changed_at = CASE
            WHEN traders_company_data.content_hash = excluded.content_hash
              THEN traders_company_data.last_changed_at
            ELSE excluded.last_changed_at
          END,
          content_hash = excluded.content_hash`,
      args: asDbArgs([
        ticker,
        parsed.pageName ?? fallbackName,
        parsed.featureSummary,
        parsed.companyUrl,
        parsed.listingDate,
        JSON.stringify(parsed.fields),
        fetched.finalUrl,
        parsed.contentHash,
        timestamp,
        timestamp,
        timestamp,
      ]),
    },
    {
      sql: `INSERT INTO traders_company_data_status(
          ticker, status, last_http_status, last_attempt_at, last_success_at, error_summary
        ) VALUES (?, 'ok', ?, ?, ?, NULL)
        ON CONFLICT(ticker) DO UPDATE SET
          status = 'ok',
          last_http_status = excluded.last_http_status,
          last_attempt_at = excluded.last_attempt_at,
          last_success_at = excluded.last_success_at,
          error_summary = NULL`,
      args: [ticker, fetched.status, timestamp, timestamp],
    },
  ], 'write')
  return true
}

async function recordUnavailable(ticker: string, httpStatus: number | null, reason: string): Promise<void> {
  const timestamp = nowSec()
  await tradersCompanyDataClient().execute({
    sql: `INSERT INTO traders_company_data_status(
        ticker, status, last_http_status, last_attempt_at, last_success_at, error_summary
      ) VALUES (?, 'unavailable', ?, ?, NULL, ?)
      ON CONFLICT(ticker) DO UPDATE SET
        status = 'unavailable',
        last_http_status = excluded.last_http_status,
        last_attempt_at = excluded.last_attempt_at,
        error_summary = excluded.error_summary`,
    args: [ticker, httpStatus, timestamp, reason],
  })
}

async function recordError(ticker: string, httpStatus: number | null, message: string): Promise<void> {
  const timestamp = nowSec()
  await tradersCompanyDataClient().execute({
    sql: `INSERT INTO traders_company_data_status(
        ticker, status, last_http_status, last_attempt_at, last_success_at, error_summary
      ) VALUES (?, 'error', ?, ?, NULL, ?)
      ON CONFLICT(ticker) DO UPDATE SET
        status = 'error',
        last_http_status = excluded.last_http_status,
        last_attempt_at = excluded.last_attempt_at,
        error_summary = excluded.error_summary`,
    args: [ticker, httpStatus, timestamp, message.slice(0, 300)],
  })
}

async function main(): Promise<void> {
  if (process.env.TRADERS_COMPANY_DATA_AUTHORIZED !== '1') {
    throw new Error(
      'TRADERS_COMPANY_DATA_AUTHORIZED=1 is required. Run only with explicit source authorization.',
    )
  }

  const dbPath = tradersCompanyDataDbPath()
  const releaseLock = acquireProcessLock(dbPath)
  const requestDelayMs = envInt('TRADERS_COMPANY_REQUEST_DELAY_MS', 3_000, 1_000, 30_000)
  const maximumDelayMs = envInt(
    'TRADERS_COMPANY_MAX_REQUEST_DELAY_MS',
    15_000,
    requestDelayMs,
    60_000,
  )
  const progressEvery = envInt('TRADERS_COMPANY_PROGRESS_EVERY', 50, 1, 1_000)
  const circuitBreakerThreshold = envInt(
    'TRADERS_COMPANY_CIRCUIT_BREAKER_THRESHOLD',
    3,
    1,
    20,
  )
  let adaptiveDelayMs = requestDelayMs
  let successSinceRateLimit = 0
  let consecutiveSourceFailures = 0
  let circuitOpenReason: string | null = null

  try {
    await ensureTradersCompanyDataSchema()
    const universe = await loadUniverse()
    const counts: SyncCounts = {
      total: universe.length,
      processed: 0,
      success: 0,
      skipped: 0,
      failed: 0,
    }
    const errors: string[] = []
    const runId = await startRun(universe.length)
    console.log(
      `[traders-company] start run=${runId} tickers=${universe.length}`
      + ` delay=${requestDelayMs}ms db=${dbPath}`,
    )

    for (const row of universe) {
      if (stopState.requested) break
      const ticker = normalizeJpTicker(row.ticker)
      if (!ticker) {
        counts.processed += 1
        counts.skipped += 1
        continue
      }

      let completedAttempt = true
      try {
        const fetched = await fetchCompanyPage(ticker)
        if (fetched.rateLimitEvents > 0) {
          adaptiveDelayMs = Math.min(
            maximumDelayMs,
            Math.max(adaptiveDelayMs + 1_000, Math.ceil(adaptiveDelayMs * 1.5)),
          )
          successSinceRateLimit = 0
          console.warn(
            `[traders-company] throttled delay=${adaptiveDelayMs}ms`
            + ` after ${fetched.rateLimitEvents} rate-limit event(s)`,
          )
        } else {
          successSinceRateLimit += 1
          if (successSinceRateLimit >= 100 && adaptiveDelayMs > requestDelayMs) {
            adaptiveDelayMs = Math.max(requestDelayMs, adaptiveDelayMs - 500)
            successSinceRateLimit = 0
          }
        }
        if (await recordSuccess(ticker, row.name, fetched)) {
          counts.success += 1
        } else {
          counts.skipped += 1
        }
        consecutiveSourceFailures = 0
      } catch (error) {
        if (error instanceof SyncInterruptedError) {
          completedAttempt = false
          break
        }
        const status = error instanceof HttpStatusError ? error.status : null
        if (status === 404) {
          await recordUnavailable(ticker, status, 'page_not_found')
          counts.skipped += 1
          consecutiveSourceFailures = 0
        } else {
          const message = error instanceof Error ? error.message : String(error)
          await recordError(ticker, status, message)
          counts.failed += 1
          errors.push(`${ticker}: ${message}`)
          if (isSourceFailure(status)) {
            consecutiveSourceFailures += 1
            if (status === 429 || status === 401 || status === 403) {
              circuitOpenReason = `HTTP ${status}`
            } else if (consecutiveSourceFailures >= circuitBreakerThreshold) {
              circuitOpenReason = `${consecutiveSourceFailures} consecutive source failures`
            }
          } else {
            consecutiveSourceFailures = 0
          }
        }
      } finally {
        if (completedAttempt) counts.processed += 1
      }

      await updateRun(runId, counts, errors)
      if (counts.processed % progressEvery === 0 || counts.processed === counts.total) {
        console.log(
          `[traders-company] ${counts.processed}/${counts.total}`
          + ` ok=${counts.success} skipped=${counts.skipped} failed=${counts.failed}`,
        )
      }
      if (circuitOpenReason) {
        console.warn(
          `[traders-company] circuit open: ${circuitOpenReason};`
          + ' remaining tickers will resume on the next run',
        )
        break
      }
      if (!stopState.requested && counts.processed < counts.total) {
        try {
          await interruptibleSleep(adaptiveDelayMs)
        } catch (error) {
          if (!(error instanceof SyncInterruptedError)) throw error
          break
        }
      }
    }

    const finalStatus = stopState.requested
      ? 'interrupted'
      : counts.failed > 0 || circuitOpenReason
        ? 'partial'
        : 'success'
    await updateRun(runId, counts, errors, finalStatus, nowSec())
    console.log(
      `[traders-company] done status=${finalStatus}`
      + ` processed=${counts.processed}/${counts.total}`
      + ` ok=${counts.success} skipped=${counts.skipped} failed=${counts.failed}`,
    )
  } finally {
    releaseLock()
  }
}

function isSourceFailure(status: number | null): boolean {
  return status == null || status === 401 || status === 403 || status === 429 || status >= 500
}

main().catch((error) => {
  console.error('[traders-company] fatal:', error)
  process.exitCode = 1
})
