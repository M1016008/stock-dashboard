import { ensureReady, execAll, execBatch } from '@/lib/db/client'
import {
  buildCalendarStageBatchBackfillStatements,
  buildCalendarStageBatchClassificationStatement,
  buildCalendarStageBackfillStatements,
  buildCalendarStageClassificationStatement,
  CALENDAR_STAGE_VERSION,
  type SnapshotBackfillMarket,
} from '@/lib/snapshots/calendar-backfill-sql'
import {
  acquireExclusiveUpdateLock,
  type UpdateLockHandle,
} from '@/lib/server/update-lock'

const market = String(process.env.STAGE_SNAPSHOT_BACKFILL_MARKET ?? process.argv[2] ?? 'JP').toUpperCase() as SnapshotBackfillMarket
if (market !== 'JP' && market !== 'US') throw new Error(`unsupported market: ${market}`)

const force = process.env.STAGE_SNAPSHOT_BACKFILL_FORCE === '1'
const stagesOnly = process.env.STAGE_SNAPSHOT_BACKFILL_STAGES_ONLY === '1'
const dryRun = process.env.STAGE_SNAPSHOT_BACKFILL_DRY_RUN === '1'
const progressEvery = Math.max(1, Number(process.env.STAGE_SNAPSHOT_BACKFILL_PROGRESS_EVERY ?? 25))
const pauseMs = Math.max(0, Number(process.env.STAGE_SNAPSHOT_BACKFILL_PAUSE_MS ?? 20))
const batchSize = Math.max(1, Math.min(100, Number(process.env.STAGE_SNAPSHOT_BACKFILL_BATCH_SIZE ?? 25)))
const lockPollSeconds = Math.max(5, Number(process.env.STAGE_SNAPSHOT_BACKFILL_LOCK_POLL_SECONDS ?? 15))
const lockWaitHours = Math.max(1, Number(process.env.STAGE_SNAPSHOT_BACKFILL_LOCK_WAIT_HOURS ?? 24))
const requestedTickers = process.env.TICKERS?.split(',').map((value) => value.trim().toUpperCase()).filter(Boolean)
const jobType = `stage_${CALENDAR_STAGE_VERSION}_${market.toLowerCase()}`
const lockJobType = market === 'US' ? 'calendar_stage_backfill_us' : 'calendar_stage_backfill_jp'

type Target = { ticker: string; sourceDate: string }

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function loadTargets(): Promise<Target[]> {
  if (requestedTickers?.length) {
    const placeholders = requestedTickers.map(() => '?').join(', ')
    return market === 'US'
      ? execAll<Target>(
        `SELECT snapshots.ticker,
           (SELECT MAX(prices.date) FROM market_ohlcv_daily AS prices
            WHERE prices.market = 'US' AND prices.ticker = snapshots.ticker) AS sourceDate
         FROM (
           SELECT DISTINCT ticker FROM market_daily_snapshots
           WHERE market = 'US' AND ticker IN (${placeholders})
         ) AS snapshots
         ORDER BY snapshots.ticker`,
        requestedTickers,
      )
      : execAll<Target>(
        `SELECT snapshots.ticker,
           (SELECT MAX(prices.date) FROM ohlcv_daily AS prices
            WHERE prices.ticker = snapshots.ticker) AS sourceDate
         FROM (
           SELECT DISTINCT ticker FROM daily_snapshots WHERE ticker IN (${placeholders})
         ) AS snapshots
         ORDER BY snapshots.ticker`,
        requestedTickers,
      )
  }

  return market === 'US'
    ? execAll<Target>(
      `SELECT snapshots.ticker,
         (SELECT MAX(prices.date) FROM market_ohlcv_daily AS prices
          WHERE prices.market = 'US' AND prices.ticker = snapshots.ticker) AS sourceDate
       FROM (
         SELECT DISTINCT ticker FROM market_daily_snapshots WHERE market = 'US'
       ) AS snapshots
       ORDER BY snapshots.ticker`,
    )
    : execAll<Target>(
      `SELECT snapshots.ticker,
         (SELECT MAX(prices.date) FROM ohlcv_daily AS prices
          WHERE prices.ticker = snapshots.ticker) AS sourceDate
       FROM (SELECT DISTINCT ticker FROM daily_snapshots) AS snapshots
       ORDER BY snapshots.ticker`,
    )
}

function buildCompleteStatement(target: Target): { sql: string; args: [string, string, string] } {
  return {
    sql: `INSERT INTO compute_state(job_type, ticker, last_processed_date, updated_at)
      VALUES (?, ?, ?, unixepoch())
      ON CONFLICT(job_type, ticker) DO UPDATE SET
        last_processed_date = excluded.last_processed_date,
        updated_at = unixepoch()`,
    args: [jobType, target.ticker, target.sourceDate],
  }
}

async function waitForUpdateLock(): Promise<UpdateLockHandle> {
  const startedAt = Date.now()
  let lastLogAt = 0
  for (;;) {
    const lock = await acquireExclusiveUpdateLock(lockJobType, 2 * 60 * 60)
    if (lock) return lock

    const elapsedMs = Date.now() - startedAt
    if (elapsedMs >= lockWaitHours * 60 * 60 * 1000) {
      throw new Error(`timed out waiting for ${market} update lock after ${lockWaitHours} hour(s)`)
    }
    if (lastLogAt === 0 || Date.now() - lastLogAt >= 60_000) {
      lastLogAt = Date.now()
      console.log(`calendar stage backfill waiting for the ${market} writer lock`)
    }
    await sleep(lockPollSeconds * 1000)
  }
}

async function main(): Promise<void> {
  await ensureReady()
  const [targets, completedRows] = await Promise.all([
    loadTargets(),
    execAll<{ ticker: string; sourceDate: string | null }>(
      `SELECT ticker, last_processed_date AS sourceDate
       FROM compute_state WHERE job_type = ?`,
      [jobType],
    ),
  ])
  const completedByTicker = new Map(completedRows.map((row) => [row.ticker, row.sourceDate]))
  const pending = force
    ? targets
    : targets.filter((target) => completedByTicker.get(target.ticker) !== target.sourceDate)

  console.log(
    `calendar stage backfill: market=${market} version=${CALENDAR_STAGE_VERSION} `
      + `targets=${targets.length} pending=${pending.length} dryRun=${dryRun ? 'yes' : 'no'}`
      + ` stagesOnly=${stagesOnly ? 'yes' : 'no'} batchSize=${batchSize}`,
  )
  if (dryRun || pending.length === 0) return

  const updateLock = await waitForUpdateLock()
  try {
    let succeeded = 0
    let attempted = 0
    const errors: string[] = []
    const startedAt = Date.now()
    for (let offset = 0; offset < pending.length; offset += batchSize) {
      const batch = pending.slice(offset, offset + batchSize)
      const tickers = batch.map((target) => target.ticker)
      try {
        const calculations = batch.length === 1
          ? (stagesOnly
              ? [buildCalendarStageClassificationStatement(market, tickers[0])]
              : buildCalendarStageBackfillStatements(market, tickers[0]))
          : (stagesOnly
              ? [buildCalendarStageBatchClassificationStatement(market, tickers)]
              : buildCalendarStageBatchBackfillStatements(market, tickers))
        await execBatch([
          ...calculations,
          ...batch.map(buildCompleteStatement),
        ])
        succeeded += batch.length
      } catch (error) {
        errors.push(`${tickers.join(',')}: ${error instanceof Error ? error.message : String(error)}`)
      }
      attempted += batch.length

      if (attempted % progressEvery < batch.length || offset + batch.length === pending.length) {
        await updateLock?.heartbeat()
        const elapsedSec = Math.round((Date.now() - startedAt) / 1000)
        console.log(
          `calendar stage backfill progress: ${attempted}/${pending.length} `
            + `succeeded=${succeeded} failed=${errors.length} elapsed=${elapsedSec}s`,
        )
      }
      if (pauseMs > 0) await sleep(pauseMs)
    }

    if (errors.length > 0) {
      throw new Error(`calendar stage backfill failed for ${errors.length} ticker(s): ${errors.slice(0, 10).join('; ')}`)
    }
  } finally {
    await updateLock?.release()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
