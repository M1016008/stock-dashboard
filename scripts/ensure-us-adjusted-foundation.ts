import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClient } from '@libsql/client'
import { db, ensureReady, execGet } from '@/lib/db/client'
import { marketDataRuns } from '@/lib/db/schema'
import { acquireExclusiveUpdateLock } from '@/lib/server/update-lock'
import { waitForMemoryHeadroom, withMemoryGuardEnv } from '@/lib/system/memory-guard'
import { US_ADJUSTED_PRICE_BASIS } from '@/lib/us-adjusted-ohlcv'

const usAnalyticsDbPath = path.resolve(
  process.env.US_ANALYTICS_DB_PATH?.trim()
  || '/Volumes/OWC Express 1M2 80G/stockboard-data/us/stockboard-us.db',
)
const adjustedShadowDbPath = path.resolve(
  process.env.US_ADJUSTED_FOUNDATION_SHADOW_PATH?.trim()
  || `${usAnalyticsDbPath}.${US_ADJUSTED_PRICE_BASIS}.building`,
)
const uid = typeof process.getuid === 'function' ? process.getuid() : Number(process.env.UID)
const launchAgentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents')
const services = [
  'com.stockboard.web-health',
  'com.stockboard.web',
  'com.stockboard.analog-search',
] as const

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

async function runNpm(script: string, env: Record<string, string>): Promise<void> {
  await waitForMemoryHeadroom({ label: `npm run ${script}` })
  await new Promise<void>((resolve, reject) => {
    const child = spawn('npm', ['run', script], {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: withMemoryGuardEnv({
        ...process.env,
        ...env,
        USE_LOCAL_DB: '1',
        US_ANALYTICS_DB_PATH: usAnalyticsDbPath,
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

function runLaunchctl(args: string[], allowFailure = false): void {
  try {
    execFileSync('launchctl', args, { stdio: allowFailure ? 'ignore' : 'inherit' })
  } catch (error) {
    if (!allowFailure) throw error
  }
}

function servicePlist(label: string): string {
  return path.join(launchAgentsDir, `${label}.plist`)
}

function stopServingServices(): void {
  for (const label of services) {
    runLaunchctl(['bootout', `gui/${uid}`, servicePlist(label)], true)
  }
}

function startServingServices(): void {
  for (const label of [...services].reverse()) {
    const plist = servicePlist(label)
    if (!fs.existsSync(plist)) continue
    runLaunchctl(['bootstrap', `gui/${uid}`, plist])
  }
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
  let currentMoved = false
  stopServingServices()
  try {
    await checkpointDb(usAnalyticsDbPath)
    await checkpointDb(adjustedShadowDbPath)
    moveIfPresent(`${usAnalyticsDbPath}-wal`, `${backupPath}-wal`)
    moveIfPresent(`${usAnalyticsDbPath}-shm`, `${backupPath}-shm`)
    fs.renameSync(usAnalyticsDbPath, backupPath)
    currentMoved = true
    fs.renameSync(adjustedShadowDbPath, usAnalyticsDbPath)
    moveIfPresent(`${adjustedShadowDbPath}-wal`, `${usAnalyticsDbPath}-wal`)
    moveIfPresent(`${adjustedShadowDbPath}-shm`, `${usAnalyticsDbPath}-shm`)
    currentMoved = false
    return backupPath
  } catch (error) {
    if (currentMoved && !fs.existsSync(usAnalyticsDbPath) && fs.existsSync(backupPath)) {
      fs.renameSync(backupPath, usAnalyticsDbPath)
      moveIfPresent(`${backupPath}-wal`, `${usAnalyticsDbPath}-wal`)
      moveIfPresent(`${backupPath}-shm`, `${usAnalyticsDbPath}-shm`)
    }
    throw error
  } finally {
    startServingServices()
  }
}

async function buildAdjustedShadow(): Promise<void> {
  await runNpm('batch:us-analytics-db', {
    US_ANALYTICS_DB_PATH: adjustedShadowDbPath,
    US_ANALYTICS_REBUILD_PRICE_BASIS: '1',
    US_ANALYTICS_NATIVE_CHUNK: process.env.US_FOUNDATION_ANALYTICS_CHUNK ?? '100',
  })
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
    await runNpm('batch:analog-index:us-full', {
      US_ANALYTICS_DB_PATH: adjustedShadowDbPath,
    })
    await writeAnalyticsMetadata(adjustedShadowDbPath, 'analog_index_price_basis', US_ADJUSTED_PRICE_BASIS)
    await writeAnalyticsMetadata(adjustedShadowDbPath, 'analog_index_price_date', priceDate)
  }
  await runNpm('batch:us-analytics-validate', {
    US_ANALYTICS_DB_PATH: adjustedShadowDbPath,
    US_ANALYTICS_REQUIRE_DERIVED_BASIS: '1',
  })
}

async function main(): Promise<void> {
  await ensureReady()
  const [sourceCurrent, analyticsCurrent] = await Promise.all([
    sourceSnapshotBasisIsCurrent(),
    analyticsPriceBasisIsCurrent(),
  ])
  if (sourceCurrent && analyticsCurrent) {
    console.log(`US adjusted foundation is current: ${US_ADJUSTED_PRICE_BASIS}`)
    return
  }
  if (heavyMlIsActive()) {
    throw new Error('US adjusted foundation deferred: a heavy US ML process is active')
  }

  const lock = await acquireExclusiveUpdateLock('us_adjusted_foundation', 2 * 60 * 60)
  if (!lock) throw new Error('US adjusted foundation is already active')
  const heartbeat = setInterval(() => {
    lock.heartbeat().catch((error) => {
      console.warn(`US adjusted foundation heartbeat failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }, 5 * 60 * 1_000)
  try {
    if (!sourceCurrent) {
      console.log(`Rebuilding US source snapshots with ${US_ADJUSTED_PRICE_BASIS}`)
      await runNpm('batch:us-snapshots', {
        US_SNAPSHOT_REBUILD: '1',
        US_SNAPSHOT_CONCURRENCY: process.env.US_FOUNDATION_SNAPSHOT_CONCURRENCY ?? '2',
      })
      await recordSourceSnapshotBasis()
      await lock.heartbeat()
    }

    if (!analyticsCurrent) {
      console.log(`Building isolated US adjusted analytics generation: ${adjustedShadowDbPath}`)
      await buildAdjustedShadow()
      await lock.heartbeat()
      const backupPath = await promoteAdjustedShadow()
      console.log(`US adjusted analytics promoted; previous generation retained: ${backupPath}`)
      await lock.heartbeat()
    }
  } finally {
    clearInterval(heartbeat)
    await lock.release()
  }
}

main().catch((error) => {
  console.error('US adjusted foundation failed:', error)
  process.exit(1)
})
