// Tiingo EODから米国株OHLCVを取得し、market_ohlcv_dailyへ保存する。

import { db, ensureReady, execAll, execGet } from '@/lib/db/client'
import { marketDataRuns, marketOhlcvDaily } from '@/lib/db/schema'
import { expectedLatestUsTradingDate } from '@/lib/server/us-data-freshness'
import {
  loadUsActiveInvestableTickers,
  loadUsDailyCoverageSla,
  loadUsSourceAvailability,
  upsertUsSourceAvailability,
} from '@/lib/server/us-source-availability-store'
import { fetchTiingoDailyPrices, isTiingoRateLimitError } from '@/lib/tiingo'
import {
  formatUsDailyCoverageSla,
  httpStatusOf,
  isProviderTickerNotFoundError,
  planUsSourceAvailabilityRun,
  resolveUsPermanentPromotionLimits,
  summarizeUsOhlcvOutcomes,
  usOhlcvRunStatus,
  US_SOURCE_TIINGO,
  type UsDailyCoverageSla,
  type UsOhlcvTickerOutcome,
  type UsSourceAvailabilityPlan,
  type UsSourceObservation,
} from '@/lib/us-source-availability'
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
const FORCE_FULL_REFRESH = process.env.US_OHLCV_FORCE_FULL_REFRESH === '1'
const TARGET_END_DATE = process.env.US_TARGET_END_DATE?.trim() || null
const TICKERS = process.env.TICKERS?.split(',').map((value) => value.trim().toUpperCase()).filter(Boolean)
const FAILED_RETRY_ROUNDS = Math.max(0, Number(process.env.US_OHLCV_FAILED_RETRY_ROUNDS ?? 2))
const FAILED_RETRY_BASE_MS = Math.max(250, Number(process.env.US_OHLCV_FAILED_RETRY_BASE_MS ?? 2_000))
// Coverage SLA / availability classification target. The daily orchestrator always passes
// US_TARGET_END_DATE; manual runs fall back to the expected latest US trading date.
const SLA_TARGET_DATE = TARGET_END_DATE ?? expectedLatestUsTradingDate()
// US_SOURCE_PERMANENT_PROMOTION_MAX_SYMBOLS / US_SOURCE_PERMANENT_PROMOTION_MAX_UNIVERSE_PCT
const PROMOTION_LIMITS = resolveUsPermanentPromotionLimits()

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function conciseError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .split('\n')[0]
    .replace(/params:.*/i, 'params:<redacted>')
    .slice(0, 300)
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

function containsSplit(rows: Awaited<ReturnType<typeof fetchTiingoDailyPrices>>): boolean {
  return rows.some((row) => (
    row.splitFactor != null
    && Number.isFinite(row.splitFactor)
    && Math.abs(row.splitFactor - 1) > 1e-8
  ))
}

type FetchResult = {
  /** A provider request was made. false means stored bars already reach the request end. */
  requested: boolean
  rows: number
  latestDate: string | null
}

const NOT_REQUESTED: FetchResult = { requested: false, rows: 0, latestDate: null }

async function fetchAndStore(
  ticker: string,
  startDate: string,
  endDate: string | undefined,
): Promise<FetchResult> {
  let rows = await fetchTiingoDailyPrices(ticker, startDate, endDate)
  if (RATE_LIMIT_MS > 0) await sleep(RATE_LIMIT_MS)
  // HTTP 200 empty: not coverage and not success.
  if (rows.length === 0) return { requested: true, rows: 0, latestDate: null }

  if (startDate > HISTORY_FROM && containsSplit(rows)) {
    console.log(`${ticker}: split detected; refreshing adjusted full history`)
    rows = await fetchTiingoDailyPrices(ticker, HISTORY_FROM, endDate)
    if (RATE_LIMIT_MS > 0) await sleep(RATE_LIMIT_MS)
  }

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
  const latestDate = rows.reduce((latest, row) => (row.date > latest ? row.date : latest), rows[0].date)
  return { requested: true, rows: rows.length, latestDate }
}

async function storeTicker(target: Target): Promise<FetchResult> {
  const desiredStartDate = laterDate(HISTORY_FROM, target.startDate)
  const today = new Date().toISOString().slice(0, 10)
  const requestedEndDate = TARGET_END_DATE && TARGET_END_DATE < today ? TARGET_END_DATE : today
  const finalEndDate = target.endDate && target.endDate < requestedEndDate
    ? target.endDate
    : requestedEndDate
  if (desiredStartDate > today) return NOT_REQUESTED

  if (FORCE_FULL_REFRESH) {
    return fetchAndStore(target.ticker, desiredStartDate, finalEndDate)
  }

  if (BACKFILL_EARLY && target.firstDate && desiredStartDate < target.firstDate) {
    const earlyEndDate = previousDate(target.firstDate)
    if (desiredStartDate <= earlyEndDate) {
      return fetchAndStore(target.ticker, desiredStartDate, earlyEndDate)
    }
  }

  const startDate = nextStartDate(target.lastDate, target.startDate)
  if (startDate > finalEndDate) return NOT_REQUESTED
  return fetchAndStore(target.ticker, startDate, finalEndDate)
}

function observationFor(target: Target, result: FetchResult): UsSourceObservation {
  if (!result.requested) return { kind: 'STORED', latestDataDate: target.lastDate }
  if (result.rows === 0 || !result.latestDate) return { kind: 'EMPTY' }
  return { kind: 'DATA', latestDataDate: laterDate(result.latestDate, target.lastDate) }
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
      slaTargetDate: SLA_TARGET_DATE,
      limit: LIMIT || null,
      tickers: TICKERS ?? null,
      forceFullRefresh: FORCE_FULL_REFRESH,
    }),
  }).returning({ id: marketDataRuns.id })

  const targets = await loadTargets()
  const activeInvestable = await loadUsActiveInvestableTickers()
  let nextIndex = 0
  let rowsInserted = 0
  let quotaExhausted = false
  let quotaRetryAfterSeconds: number | null = null
  // One final outcome per ticker; retries overwrite earlier outcomes.
  const outcomes = new Map<string, UsOhlcvTickerOutcome>()
  const errorsByTicker = new Map<string, string>()
  const failedTargets: Target[] = []
  const unavailableTickers: string[] = []
  let availabilityPlan: UsSourceAvailabilityPlan | null = null
  let coverageSla: UsDailyCoverageSla | null = null
  let progressSave = Promise.resolve()

  function record(target: Target, observation: UsSourceObservation) {
    outcomes.set(target.ticker, { observation, inScope: activeInvestable.has(target.ticker) })
  }

  function accounting(final: boolean) {
    const acc = summarizeUsOhlcvOutcomes(targets.length, outcomes.values(), SLA_TARGET_DATE)
    // Mid-run, unprocessed targets are only "deferred" once the quota stops the workers.
    return { ...acc, deferred: final || quotaExhausted ? acc.deferred : 0 }
  }

  function runPayload(final: boolean) {
    const processed = accounting(final)
    return {
      historyFrom: HISTORY_FROM,
      targetEndDate: TARGET_END_DATE,
      slaTargetDate: SLA_TARGET_DATE,
      limit: LIMIT || null,
      tickers: TICKERS ?? null,
      forceFullRefresh: FORCE_FULL_REFRESH,
      unavailable: processed.providerNotFound,
      deferred: processed.deferred,
      quotaExhausted,
      quotaRetryAfterSeconds,
      unavailableTickers: unavailableTickers.slice(0, 50),
      failedTickers: [...errorsByTicker.keys()].slice(0, 50),
      failedRetryRounds: FAILED_RETRY_ROUNDS,
      pendingEmpty: processed.emptyResponses,
      providerNotFound: processed.providerNotFound,
      pendingTargetMissing: availabilityPlan?.counts.pendingTargetMissing ?? null,
      temporaryNotFound: availabilityPlan?.counts.temporaryNotFound ?? null,
      newlyPermanent: availabilityPlan?.newlyPermanent.length ?? 0,
      newlyPermanentTickers: availabilityPlan?.newlyPermanent.slice(0, 50) ?? [],
      revertedFromPermanent: availabilityPlan?.revertedFromPermanent.length ?? 0,
      revertedFromPermanentTickers: availabilityPlan?.revertedFromPermanent.slice(0, 50) ?? [],
      promotionGuardTriggered: availabilityPlan?.promotionGuardTriggered ?? false,
      promotionGuard: availabilityPlan?.promotionGuard ?? null,
      processed,
      coverageSla,
    }
  }

  async function persistAvailability(allowPromotion: boolean): Promise<UsSourceAvailabilityPlan> {
    const plan = planUsSourceAvailabilityRun({
      market: MARKET,
      source: US_SOURCE_TIINGO,
      runId: run.id,
      targetDate: SLA_TARGET_DATE,
      activeUniverse: activeInvestable.size,
      limits: PROMOTION_LIMITS,
      updatedAt: Math.floor(Date.now() / 1000),
      existing: await loadUsSourceAvailability(US_SOURCE_TIINGO),
      observations: [...outcomes]
        .filter(([, outcome]) => outcome.inScope)
        .map(([ticker, outcome]) => ({ ticker, observation: outcome.observation })),
      allowPromotion,
    })
    await upsertUsSourceAvailability(plan.rows)
    return plan
  }

  async function saveProgress() {
    const processed = accounting(false)
    await db.update(marketDataRuns).set({
      status: 'running',
      totalTickers: targets.length,
      succeeded: processed.succeeded,
      failed: processed.transientFailed,
      rowsInserted,
      errorSummary: JSON.stringify([...errorsByTicker.values()].slice(0, 20)),
      payloadJson: JSON.stringify(runPayload(false)),
    }).where(eq(marketDataRuns.id, run.id))
  }

  function queueProgressSave() {
    progressSave = progressSave.then(saveProgress).catch((error) => {
      console.error(`progress save failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  async function markInterrupted(signal: NodeJS.Signals) {
    await progressSave
    try {
      // Record observed evidence, but an interrupted run never promotes anything.
      availabilityPlan = await persistAvailability(false)
    } catch (error) {
      console.error(`availability save failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    const processed = accounting(false)
    await db.update(marketDataRuns).set({
      status: 'interrupted',
      finishedAt: new Date(),
      totalTickers: targets.length,
      succeeded: processed.succeeded,
      failed: processed.transientFailed,
      rowsInserted,
      errorSummary: JSON.stringify([`${signal}: interrupted`, ...errorsByTicker.values()].slice(0, 20)),
      payloadJson: JSON.stringify(runPayload(false)),
    }).where(eq(marketDataRuns.id, run.id))
  }

  process.once('SIGINT', () => {
    markInterrupted('SIGINT').finally(() => process.exit(130))
  })
  process.once('SIGTERM', () => {
    markInterrupted('SIGTERM').finally(() => process.exit(143))
  })

  console.log(
    `US OHLCV fetch start: targets=${targets.length}, concurrency=${CONCURRENCY}, `
    + `slaTargetDate=${SLA_TARGET_DATE}, activeInvestable=${activeInvestable.size}`,
  )
  queueProgressSave()
  async function worker(workerId: number) {
    while (true) {
      if (quotaExhausted) return
      const target = targets[nextIndex++]
      if (!target) return
      try {
        const result = await storeTicker(target)
        rowsInserted += result.rows
        record(target, observationFor(target, result))
        const processed = outcomes.size
        if (processed % 50 === 0 || processed === targets.length) {
          const acc = accounting(false)
          console.log(
            `[${processed}/${targets.length}] rows=${rowsInserted}, failed=${acc.transientFailed}, `
            + `empty=${acc.emptyResponses}, notFound=${acc.providerNotFound}`,
          )
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
        } else if (isProviderTickerNotFoundError(error)) {
          record(target, { kind: 'NOT_FOUND', httpStatus: httpStatusOf(error) ?? 404 })
          unavailableTickers.push(target.ticker)
          console.warn(`worker=${workerId} ${target.ticker}: provider reports ticker not found; recorded as terminal evidence`)
        } else {
          record(target, { kind: 'TRANSIENT', httpStatus: httpStatusOf(error) })
          const msg = `${target.ticker}: ${conciseError(error)}`
          errorsByTicker.set(target.ticker, msg)
          failedTargets.push(target)
          console.error(`worker=${workerId} ${msg}`)
        }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, (_, i) => worker(i + 1)))
  await progressSave
  let retryTargets = failedTargets
  for (let round = 1; round <= FAILED_RETRY_ROUNDS && retryTargets.length > 0 && !quotaExhausted; round += 1) {
    const backoffMs = FAILED_RETRY_BASE_MS * (2 ** (round - 1))
    console.log(`US OHLCV failed retry round ${round}/${FAILED_RETRY_ROUNDS}: targets=${retryTargets.length}`)
    await sleep(backoffMs)
    const remaining: Target[] = []
    for (const target of retryTargets) {
      try {
        const result = await storeTicker(target)
        rowsInserted += result.rows
        record(target, observationFor(target, result))
        errorsByTicker.delete(target.ticker)
        console.log(`${target.ticker}: recovered on failed retry round ${round}`)
      } catch (error) {
        if (isTiingoRateLimitError(error)) {
          quotaExhausted = true
          quotaRetryAfterSeconds = error.retryAfterSeconds
          remaining.push(target)
          console.warn(`Tiingo quota reached while retrying ${target.ticker}; retry queue deferred`)
          break
        }
        if (isProviderTickerNotFoundError(error)) {
          record(target, { kind: 'NOT_FOUND', httpStatus: httpStatusOf(error) ?? 404 })
          unavailableTickers.push(target.ticker)
          errorsByTicker.delete(target.ticker)
          console.warn(`${target.ticker}: provider reports ticker not found during retry; recorded as terminal evidence`)
          continue
        }
        record(target, { kind: 'TRANSIENT', httpStatus: httpStatusOf(error) })
        const msg = `${target.ticker}: ${conciseError(error)}`
        errorsByTicker.set(target.ticker, msg)
        remaining.push(target)
        console.error(`retry=${round} ${msg}`)
      }
    }
    retryTargets = remaining
    queueProgressSave()
    await progressSave
  }

  availabilityPlan = await persistAvailability(true)
  try {
    coverageSla = await loadUsDailyCoverageSla(SLA_TARGET_DATE)
  } catch (error) {
    console.error(`coverage SLA query failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  const processed = accounting(true)
  const succeeded = processed.succeeded
  const failed = processed.transientFailed
  const deferred = processed.deferred
  const status = usOhlcvRunStatus({
    succeeded,
    failed,
    deferred,
    pendingEmpty: processed.emptyResponses,
    pendingTargetMissing: availabilityPlan.counts.pendingTargetMissing,
    temporaryNotFound: availabilityPlan.counts.temporaryNotFound,
    promotionGuardTriggered: availabilityPlan.promotionGuardTriggered,
  })
  await db.update(marketDataRuns).set({
    status,
    finishedAt: new Date(),
    totalTickers: targets.length,
    succeeded,
    failed,
    rowsInserted,
    errorSummary: JSON.stringify([...errorsByTicker.values()].slice(0, 20)),
    payloadJson: JSON.stringify(runPayload(true)),
  }).where(eq(marketDataRuns.id, run.id))
  const latest = await execGet<{ date: string | null }>(
    `SELECT MAX(date) AS date FROM market_ohlcv_daily WHERE market = ?`,
    [MARKET],
  )
  console.log(
    `US OHLCV complete: status=${status}, succeeded=${succeeded}, failed=${failed}, `
    + `pendingEmpty=${processed.emptyResponses}, pendingTargetMissing=${availabilityPlan.counts.pendingTargetMissing}, `
    + `providerNotFound=${processed.providerNotFound}, temporaryNotFound=${availabilityPlan.counts.temporaryNotFound}, `
    + `newlyPermanent=${availabilityPlan.newlyPermanent.length}, revertedFromPermanent=${availabilityPlan.revertedFromPermanent.length}, `
    + `promotionGuardTriggered=${availabilityPlan.promotionGuardTriggered}, deferred=${deferred}, `
    + `rows=${rowsInserted}, latest=${latest?.date ?? '-'}`,
  )
  if (coverageSla) {
    console.log(`US OHLCV coverage SLA ${SLA_TARGET_DATE}: ${formatUsDailyCoverageSla(coverageSla)}`)
  }
  if (availabilityPlan.promotionGuardTriggered) {
    const guard = availabilityPlan.promotionGuard
    console.warn(
      `US OHLCV permanent promotion guard triggered: eligible=${guard.eligible}, `
      + `maxSymbols=${guard.maxSymbols}, maxUniverse=${guard.maxUniversePercent}% of ${guard.activeUniverse}; `
      + 'no ticker was promoted this run and evidence was kept for review',
    )
  }
  if (failed > 0 || deferred > 0) {
    throw new Error(
      `US OHLCV incomplete after targeted retries: failed=${failed}, deferred=${deferred}; `
      + 'the update orchestrator will retry only tickers that are still missing the target date',
    )
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
