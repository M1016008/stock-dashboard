import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createClient } from '@libsql/client'
import { db, ensureReady, execGet } from '@/lib/db/client'
import { marketDataRuns } from '@/lib/db/schema'
import { acquireExclusiveUpdateLock } from '@/lib/server/update-lock'
import { waitForMemoryHeadroom, withMemoryGuardEnv } from '@/lib/system/memory-guard'
import { US_ADJUSTED_PRICE_BASIS } from '@/lib/us-adjusted-ohlcv'
import { and, eq } from 'drizzle-orm'

const usAnalyticsDbPath = path.resolve(
  process.env.US_ANALYTICS_DB_PATH?.trim()
  || '/Volumes/OWC Express 1M2 80G/stockboard-data/us/stockboard-us.db',
)
const adjustedShadowDbPath = path.resolve(
  process.env.US_ADJUSTED_FOUNDATION_SHADOW_PATH?.trim()
  || `${usAnalyticsDbPath}.${US_ADJUSTED_PRICE_BASIS}.building`,
)
const foundationProcessLockPath = `${adjustedShadowDbPath}.process-lock`

type FoundationProcessLock = {
  release: () => void
}

function processCommand(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    process.kill(pid, 0)
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
    }).trim()
  } catch {
    return null
  }
}

function acquireFoundationProcessLock(): FoundationProcessLock {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(
        foundationProcessLockPath,
        JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
        { flag: 'wx', mode: 0o600 },
      )
      let released = false
      return {
        release: () => {
          if (released) return
          released = true
          try {
            const current = JSON.parse(fs.readFileSync(foundationProcessLockPath, 'utf8')) as { pid?: unknown }
            if (Number(current.pid) === process.pid) fs.unlinkSync(foundationProcessLockPath)
          } catch {
            // A later owner may already have replaced a stale lock.
          }
        },
      }
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String(error.code) : ''
      if (code !== 'EEXIST') throw error
      let ownerPid = 0
      try {
        const current = JSON.parse(fs.readFileSync(foundationProcessLockPath, 'utf8')) as { pid?: unknown }
        ownerPid = Number(current.pid ?? 0)
      } catch {
        ownerPid = 0
      }
      const command = processCommand(ownerPid)
      if (command?.includes('ensure-us-adjusted-foundation')) {
        throw new Error(`US adjusted foundation process is already active (pid=${ownerPid})`)
      }
      fs.rmSync(foundationProcessLockPath, { force: true })
    }
  }
  throw new Error('Unable to acquire the US adjusted foundation process lock')
}

function heavyMlIsActive(): boolean {
  try {
    const output = execFileSync('pgrep', ['-fl', [
      'run-us-ml-job',
      'batch-forward-extrema',
      'batch-ml-features',
      'batch-ml-physics-features',
    ].join('|')], { encoding: 'utf8' })
    return output
      .split('\n')
      .filter(Boolean)
      .some((line) => !line.includes('ensure-us-adjusted-foundation'))
  } catch {
    return false
  }
}

function sourceSnapshotProcessIsActive(): boolean {
  try {
    const output = execFileSync('pgrep', ['-fl', 'build-us-snapshots'], { encoding: 'utf8' })
    return output.split('\n').filter(Boolean).length > 0
  } catch {
    return false
  }
}

async function runNpm(script: string, env: Record<string, string>): Promise<void> {
  await waitForMemoryHeadroom({ label: `npm run ${script}` })
  await new Promise<void>((resolve, reject) => {
    const child = spawn('npm', ['run', script], {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: withMemoryGuardEnv({
        ...process.env,
        US_ANALYTICS_DB_PATH: usAnalyticsDbPath,
        ...env,
        USE_LOCAL_DB: '1',
      }),
    })
    child.on('close', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`npm run ${script} failed: code=${code}, signal=${signal ?? 'none'}`))
    })
    child.on('error', reject)
  })
}

async function sourceSnapshotBasisIsCurrent(): Promise<boolean> {
  const row = await execGet<{ payloadJson: string }>(
    `SELECT payload_json AS payloadJson
     FROM market_data_runs
     WHERE market = 'US'
       AND job_type = 'us_snapshot_price_basis'
       AND status = 'success'
     ORDER BY finished_at DESC
     LIMIT 1`,
  )
  if (!row) return false
  try {
    const payload = JSON.parse(row.payloadJson) as { priceBasis?: unknown }
    return payload.priceBasis === US_ADJUSTED_PRICE_BASIS
  } catch {
    return false
  }
}

async function completedSnapshotRebuildCanRecoverBasis(): Promise<boolean> {
  const row = await execGet<{
    totalTickers: number
    succeeded: number
    failed: number
    payloadJson: string
    finishedAt: number | null
    latestPriceFinishedAt: number | null
  }>(
    `SELECT
       total_tickers AS totalTickers,
       succeeded,
       failed,
       payload_json AS payloadJson,
       finished_at AS finishedAt,
       (
         SELECT MAX(finished_at)
         FROM market_data_runs
         WHERE market = 'US' AND job_type = 'tiingo_ohlcv' AND status = 'success'
       ) AS latestPriceFinishedAt
     FROM market_data_runs
     WHERE market = 'US'
       AND job_type = 'snapshot_compute'
       AND status = 'success'
       AND finished_at IS NOT NULL
     ORDER BY finished_at DESC
     LIMIT 1`,
  )
  if (
    !row
    || row.totalTickers <= 0
    || row.succeeded !== row.totalTickers
    || row.failed !== 0
    || row.finishedAt == null
    || (row.latestPriceFinishedAt != null && row.finishedAt < row.latestPriceFinishedAt)
  ) {
    return false
  }
  try {
    const payload = JSON.parse(row.payloadJson) as {
      rebuild?: unknown
      priceBasis?: unknown
      stage?: unknown
    }
    return payload.rebuild === true
      && (payload.priceBasis == null || payload.priceBasis === US_ADJUSTED_PRICE_BASIS)
      && (payload.stage == null || payload.stage === 'complete')
  } catch {
    return false
  }
}

async function resumableSnapshotTicker(): Promise<string | null> {
  const row = await execGet<{ payloadJson: string }>(
    `SELECT payload_json AS payloadJson
     FROM market_data_runs
     WHERE market = 'US'
       AND job_type = 'snapshot_compute'
       AND status IN ('running', 'failed', 'partial')
       AND started_at >= unixepoch('now', '-7 days')
     ORDER BY started_at DESC
     LIMIT 1`,
  )
  if (!row) return null
  try {
    const payload = JSON.parse(row.payloadJson) as {
      rebuild?: unknown
      priceBasis?: unknown
      lastCompletedTicker?: unknown
    }
    if (
      payload.rebuild !== true
      || payload.priceBasis !== US_ADJUSTED_PRICE_BASIS
      || typeof payload.lastCompletedTicker !== 'string'
      || !payload.lastCompletedTicker.trim()
    ) {
      return null
    }
    return payload.lastCompletedTicker.trim().toUpperCase()
  } catch {
    return null
  }
}

async function analyticsPriceBasisIsCurrent(): Promise<boolean> {
  const [priceBasis, derivedBasis, analogBasis] = await Promise.all([
    analyticsMetadataValue(usAnalyticsDbPath, 'ohlcv_price_basis'),
    analyticsMetadataValue(usAnalyticsDbPath, 'derived_price_basis'),
    analyticsMetadataValue(usAnalyticsDbPath, 'analog_index_price_basis'),
  ])
  return (
    priceBasis === US_ADJUSTED_PRICE_BASIS
    && derivedBasis === US_ADJUSTED_PRICE_BASIS
    && analogBasis === US_ADJUSTED_PRICE_BASIS
  )
}

async function analyticsMetadataValue(dbPath: string, key: string): Promise<string | null> {
  if (!fs.existsSync(dbPath)) return null
  const client = createClient({ url: `file:${dbPath}` })
  try {
    const table = await client.execute(
      `SELECT 1 AS present
       FROM sqlite_master
       WHERE type = 'table' AND name = 'us_analytics_metadata'
       LIMIT 1`,
    )
    if (table.rows.length === 0) return null
    const row = await client.execute({
      sql: `SELECT value FROM us_analytics_metadata WHERE key = ?`,
      args: [key],
    })
    const value = row.rows[0]?.value
    return value == null ? null : String(value)
  } finally {
    client.close()
  }
}

async function writeAnalyticsMetadata(dbPath: string, key: string, value: string): Promise<void> {
  const client = createClient({ url: `file:${dbPath}` })
  try {
    await client.execute({
      sql: `
        INSERT INTO us_analytics_metadata (key, value, updated_at)
        VALUES (?, ?, unixepoch())
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()
      `,
      args: [key, value],
    })
  } finally {
    client.close()
  }
}

async function analyticsMaxPriceDate(dbPath: string): Promise<string | null> {
  if (!fs.existsSync(dbPath)) return null
  const client = createClient({ url: `file:${dbPath}` })
  try {
    const row = await client.execute('SELECT MAX(date) AS value FROM ohlcv_daily')
    const value = row.rows[0]?.value
    return value == null ? null : String(value)
  } finally {
    client.close()
  }
}

async function recordSourceSnapshotBasis(): Promise<void> {
  const now = new Date()
  await db.insert(marketDataRuns).values({
    market: 'US',
    jobType: 'us_snapshot_price_basis',
    status: 'success',
    startedAt: now,
    finishedAt: now,
    payloadJson: JSON.stringify({ priceBasis: US_ADJUSTED_PRICE_BASIS }),
  })
}

type FoundationStage =
  | 'starting'
  | 'source_snapshots'
  | 'analytics_copy'
  | 'features_models'
  | 'analog_index'
  | 'validation'
  | 'promoting'
  | 'complete'
  | 'failed'

async function updateFoundationRun(
  runId: number,
  stage: FoundationStage,
  details: Record<string, unknown> = {},
): Promise<void> {
  await db.update(marketDataRuns).set({
    payloadJson: JSON.stringify({
      stage,
      priceBasis: US_ADJUSTED_PRICE_BASIS,
      heartbeatAt: new Date().toISOString(),
      ...details,
    }),
  }).where(eq(marketDataRuns.id, runId))
}

async function checkpointDb(dbPath: string): Promise<void> {
  if (!fs.existsSync(dbPath)) return
  const client = createClient({ url: `file:${dbPath}` })
  try {
    await client.execute('PRAGMA wal_checkpoint(TRUNCATE)')
  } finally {
    client.close()
  }
}

function moveIfPresent(from: string, to: string): void {
  if (fs.existsSync(from)) fs.renameSync(from, to)
}

async function promoteAdjustedShadow(): Promise<string> {
  if (!fs.existsSync(adjustedShadowDbPath)) {
    throw new Error(`US adjusted shadow DB not found: ${adjustedShadowDbPath}`)
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = `${usAnalyticsDbPath}.pre-${US_ADJUSTED_PRICE_BASIS}-${timestamp}`
  await checkpointDb(usAnalyticsDbPath)
  await checkpointDb(adjustedShadowDbPath)

  // APFS clones retain a rollback generation without copying hundreds of GB.
  // Replacing the main file is atomic, so readers keep serving the old inode
  // until the generation-aware client reconnects on its next request.
  fs.copyFileSync(
    usAnalyticsDbPath,
    backupPath,
    fs.constants.COPYFILE_FICLONE_FORCE,
  )
  moveIfPresent(`${usAnalyticsDbPath}-wal`, `${backupPath}-wal`)
  moveIfPresent(`${usAnalyticsDbPath}-shm`, `${backupPath}-shm`)
  moveIfPresent(`${adjustedShadowDbPath}-wal`, `${backupPath}.promoted-shadow-wal`)
  moveIfPresent(`${adjustedShadowDbPath}-shm`, `${backupPath}.promoted-shadow-shm`)
  fs.renameSync(adjustedShadowDbPath, usAnalyticsDbPath)
  return backupPath
}

async function buildAdjustedShadow(onStage: (stage: FoundationStage) => Promise<void>): Promise<void> {
  await onStage('analytics_copy')
  await runNpm('batch:us-analytics-db', {
    US_ANALYTICS_DB_PATH: adjustedShadowDbPath,
    US_ANALYTICS_REBUILD_PRICE_BASIS: '1',
    US_ANALYTICS_NATIVE_CHUNK: process.env.US_FOUNDATION_ANALYTICS_CHUNK ?? '100',
  })
  await onStage('validation')
  await runNpm('batch:us-analytics-validate', {
    US_ANALYTICS_DB_PATH: adjustedShadowDbPath,
  })

  const priceDate = await analyticsMaxPriceDate(adjustedShadowDbPath)
  if (!priceDate) throw new Error('US adjusted shadow DB has no OHLCV date')
  const [derivedBasis, derivedPriceDate] = await Promise.all([
    analyticsMetadataValue(adjustedShadowDbPath, 'derived_price_basis'),
    analyticsMetadataValue(adjustedShadowDbPath, 'derived_price_date'),
  ])
  if (derivedBasis !== US_ADJUSTED_PRICE_BASIS || derivedPriceDate !== priceDate) {
    await onStage('features_models')
    await runNpm('batch:us-ml-full-history', {
      US_ANALYTICS_DB_PATH: adjustedShadowDbPath,
      US_ML_FULL_START_DATE: '1900-01-01',
      US_ML_WEEKLY_RECENT_DAYS: '0',
      US_PMS_WEEKLY_RECENT_DAYS: '0',
      US_ML_WEEKLY_EXTREMA_RECALC_DAYS: '0',
      US_ML_FEATURE_RECENT_DAYS: '0',
      US_ML_LABEL_RECENT_DAYS: '0',
      US_ML_CONTEXT_RECENT_DAYS: '0',
      US_ML_PHYSICS_RECENT_DAYS: '0',
      US_ML_SHORT_LABEL_RECENT_DAYS: '0',
      US_ML_RL_RECENT_DAYS: '0',
      US_ML_STATUS_RECENT_DAYS: '0',
      FORWARD_EXTREMA_RESUME: '1',
      ML_FEATURE_HEALTH_STRICT: '1',
      ML_ACCURACY_STRICT: '1',
      US_ML_SKIP_FORWARD_RETURNS: '0',
      US_ML_SKIP_FORWARD_EXTREMA: '0',
      US_ML_SKIP_ML_FEATURES: '0',
      US_ML_SKIP_ML_LABELS: '0',
      US_ML_SKIP_ML_TRAIN: '0',
      US_ML_SKIP_CONTEXT_FEATURES: '0',
      US_ML_SKIP_PHYSICS_FEATURES: '0',
      US_ML_SKIP_PHYSICS_TRAIN: '0',
      US_ML_SKIP_PHYSICS_CANDIDATES: '0',
      US_ML_SKIP_INSIGHTS: '0',
      US_ML_SKIP_SHORT_LABELS: '0',
    })
    await writeAnalyticsMetadata(adjustedShadowDbPath, 'derived_price_basis', US_ADJUSTED_PRICE_BASIS)
    await writeAnalyticsMetadata(adjustedShadowDbPath, 'derived_price_date', priceDate)
  }

  const [analogBasis, analogPriceDate] = await Promise.all([
    analyticsMetadataValue(adjustedShadowDbPath, 'analog_index_price_basis'),
    analyticsMetadataValue(adjustedShadowDbPath, 'analog_index_price_date'),
  ])
  if (analogBasis !== US_ADJUSTED_PRICE_BASIS || analogPriceDate !== priceDate) {
    await onStage('analog_index')
    await runNpm('batch:analog-index:us-full', {
      US_ANALYTICS_DB_PATH: adjustedShadowDbPath,
    })
    await writeAnalyticsMetadata(adjustedShadowDbPath, 'analog_index_price_basis', US_ADJUSTED_PRICE_BASIS)
    await writeAnalyticsMetadata(adjustedShadowDbPath, 'analog_index_price_date', priceDate)
  }
  await onStage('validation')
  await runNpm('batch:us-analytics-validate', {
    US_ANALYTICS_DB_PATH: adjustedShadowDbPath,
    US_ANALYTICS_REQUIRE_DERIVED_BASIS: '1',
  })
}

async function main(): Promise<void> {
  await ensureReady()
  let [sourceCurrent, analyticsCurrent] = await Promise.all([
    sourceSnapshotBasisIsCurrent(),
    analyticsPriceBasisIsCurrent(),
  ])
  if (!sourceCurrent && await completedSnapshotRebuildCanRecoverBasis()) {
    await recordSourceSnapshotBasis()
    sourceCurrent = true
    console.log(`Recovered completed US snapshot basis marker: ${US_ADJUSTED_PRICE_BASIS}`)
  }
  if (sourceCurrent && analyticsCurrent) {
    console.log(`US adjusted foundation is current: ${US_ADJUSTED_PRICE_BASIS}`)
    return
  }
  if (heavyMlIsActive()) {
    throw new Error('US adjusted foundation deferred: a heavy US ML process is active')
  }
  if (sourceSnapshotProcessIsActive()) {
    throw new Error('US adjusted foundation deferred: a US snapshot process is already active')
  }

  const processLock = acquireFoundationProcessLock()
  const releaseOnSignal = (signal: NodeJS.Signals) => {
    processLock.release()
    process.exit(signal === 'SIGINT' ? 130 : 143)
  }
  process.once('SIGINT', releaseOnSignal)
  process.once('SIGTERM', releaseOnSignal)
  const lock = await acquireExclusiveUpdateLock('us_adjusted_foundation', 72 * 60 * 60)
  if (!lock) {
    processLock.release()
    throw new Error('US adjusted foundation is already active')
  }
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let statusWriteQueue: Promise<void> = Promise.resolve()
  const enqueueStatusWrite = (operation: () => Promise<void>): Promise<void> => {
    const current = statusWriteQueue
      .catch(() => undefined)
      .then(operation)
    statusWriteQueue = current
    return current
  }
  try {
    const recoveredAt = new Date()
    await db.update(marketDataRuns).set({
      status: 'failed',
      finishedAt: recoveredAt,
      failed: 1,
      errorSummary: 'Superseded after the previous foundation owner exited',
    }).where(and(
      eq(marketDataRuns.market, 'US'),
      eq(marketDataRuns.jobType, 'us_adjusted_foundation'),
      eq(marketDataRuns.status, 'running'),
    ))
    const [foundationRun] = await db.insert(marketDataRuns).values({
      market: 'US',
      jobType: 'us_adjusted_foundation',
      status: 'running',
      payloadJson: JSON.stringify({
        stage: 'starting',
        priceBasis: US_ADJUSTED_PRICE_BASIS,
        heartbeatAt: new Date().toISOString(),
      }),
    }).returning({ id: marketDataRuns.id })
    let currentStage: FoundationStage = 'starting'
    const setStage = async (
      stage: FoundationStage,
      details: Record<string, unknown> = {},
    ): Promise<void> => {
      currentStage = stage
      await enqueueStatusWrite(
        () => updateFoundationRun(foundationRun.id, stage, details),
      )
    }
    heartbeat = setInterval(() => {
      void enqueueStatusWrite(async () => {
        await lock.heartbeat()
        await updateFoundationRun(foundationRun.id, currentStage, { heartbeatOnly: true })
      }).catch((error) => {
        console.warn(`US adjusted foundation heartbeat failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }, 60 * 1_000)
    try {
      if (!sourceCurrent) {
        await setStage('source_snapshots')
        const resumeTicker = process.env.US_SNAPSHOT_TICKER_START?.trim().toUpperCase()
          || await resumableSnapshotTicker()
        console.log(`Rebuilding US source snapshots with ${US_ADJUSTED_PRICE_BASIS}`)
        await runNpm('batch:us-snapshots', {
          US_SNAPSHOT_REBUILD: '1',
          US_SNAPSHOT_CONCURRENCY: process.env.US_FOUNDATION_SNAPSHOT_CONCURRENCY ?? '2',
          ...(resumeTicker ? { US_SNAPSHOT_TICKER_START: resumeTicker } : {}),
        })
        await recordSourceSnapshotBasis()
        await enqueueStatusWrite(() => lock.heartbeat())
      }

      if (!analyticsCurrent) {
        await setStage('analytics_copy', {
          shadowPath: path.basename(adjustedShadowDbPath),
        })
        console.log(`Building isolated US adjusted analytics generation: ${adjustedShadowDbPath}`)
        await buildAdjustedShadow(setStage)
        await enqueueStatusWrite(() => lock.heartbeat())
        await setStage('promoting')
        const backupPath = await promoteAdjustedShadow()
        console.log(`US adjusted analytics promoted; previous generation retained: ${backupPath}`)
        await enqueueStatusWrite(() => lock.heartbeat())
      }
      await setStage('complete')
      await enqueueStatusWrite(async () => {
        await db.update(marketDataRuns).set({
          status: 'success',
          finishedAt: new Date(),
        }).where(eq(marketDataRuns.id, foundationRun.id))
      })
    } catch (error) {
      await setStage('failed', {
        error: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined)
      await enqueueStatusWrite(async () => {
        await db.update(marketDataRuns).set({
          status: 'failed',
          finishedAt: new Date(),
          failed: 1,
          errorSummary: error instanceof Error ? error.message : String(error),
        }).where(eq(marketDataRuns.id, foundationRun.id))
      }).catch(() => undefined)
      throw error
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat)
    await statusWriteQueue.catch(() => undefined)
    await lock.release()
    process.removeListener('SIGINT', releaseOnSignal)
    process.removeListener('SIGTERM', releaseOnSignal)
    processLock.release()
  }
}

main().catch((error) => {
  console.error('US adjusted foundation failed:', error)
  process.exit(1)
})
