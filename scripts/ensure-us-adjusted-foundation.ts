import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createClient } from '@libsql/client'
import { db, ensureReady, execGet } from '@/lib/db/client'
import { marketDataRuns } from '@/lib/db/schema'
import {
  acquireUsStockboardUpdateLock,
  acquireUpdateLock,
  EXCLUSIVE_UPDATE_JOB_TYPES,
  type UpdateLockHandle,
} from '@/lib/server/update-lock'
import { waitForMemoryHeadroom, withMemoryGuardEnv } from '@/lib/system/memory-guard'
import { resolveConfiguredStoragePath } from '@/lib/storage-paths'
import { MA_SEQUENCE_VERSION } from '@/lib/ml/ma-sequence'
import { ML_PHYSICS_FEATURE_SET } from '@/lib/backtest/ml-physics'
import { US_ADJUSTED_PRICE_BASIS } from '@/lib/us-adjusted-ohlcv'
import { and, eq } from 'drizzle-orm'

const usAnalyticsDbPath = resolveConfiguredStoragePath(path.resolve(
  process.env.US_ANALYTICS_DB_PATH?.trim()
  || '/Volumes/OWC Express 1M2 80G/stockboard-data/us/stockboard-us.db',
))
const adjustedShadowDbPath = path.resolve(
  process.env.US_ADJUSTED_FOUNDATION_SHADOW_PATH?.trim()
  || `${usAnalyticsDbPath}.${US_ADJUSTED_PRICE_BASIS}.building`,
)
const usAnalogDbPath = path.resolve(
  process.env.ANALOG_US_DB_PATH?.trim()
  || path.join(path.dirname(usAnalyticsDbPath), `analog-sequence-us-v${MA_SEQUENCE_VERSION}.db`),
)
const adjustedAnalogShadowDbPath = path.resolve(
  process.env.US_ADJUSTED_FOUNDATION_ANALOG_SHADOW_PATH?.trim()
  || `${usAnalogDbPath}.${US_ADJUSTED_PRICE_BASIS}.building`,
)
const foundationProcessLockPath = `${adjustedShadowDbPath}.process-lock`
const SOURCE_SNAPSHOT_LOCK_JOB = 'us_adjusted_source_snapshots'
const SOURCE_SNAPSHOT_CONFLICTS = EXCLUSIVE_UPDATE_JOB_TYPES.filter(
  (jobType) => jobType !== 'us_adjusted_foundation',
)

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
    const output = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], {
      encoding: 'utf8',
      timeout: 5_000,
    })
    const rows = output
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
        return match
          ? { pid: Number(match[1]), parentPid: Number(match[2]), command: match[3] }
          : null
      })
      .filter((row): row is { pid: number; parentPid: number; command: string } => row != null)
    const byPid = new Map(rows.map((row) => [row.pid, row]))
    const currentFamilyPids = new Set<number>()
    let currentFamilyMember = byPid.get(process.pid)
    while (currentFamilyMember && !currentFamilyPids.has(currentFamilyMember.pid)) {
      currentFamilyPids.add(currentFamilyMember.pid)
      currentFamilyMember = byPid.get(currentFamilyMember.parentPid)
    }
    const candidates = rows.filter((row) => (
      !currentFamilyPids.has(row.pid)
      && /scripts\/(?:run-us-ml-job|run-us-ml-weekly-efficient|batch-forward-extrema|batch-ml-features|batch-ml-physics-features)\.(?:ts|js)\b/.test(row.command)
    ))

    return candidates.some((candidate) => {
      const familyCommands: string[] = []
      let current: typeof candidate | undefined = candidate
      const visited = new Set<number>()
      while (current && !visited.has(current.pid)) {
        visited.add(current.pid)
        familyCommands.push(current.command)
        current = byPid.get(current.parentPid)
      }
      const family = familyCommands.join('\n')
      if (/scripts\/(?:run-us-ml-job|run-us-ml-weekly-efficient|ensure-us-adjusted-foundation)\.(?:ts|js)\b/.test(family)) {
        return true
      }
      if (/scripts\/run-ml-learning\.(?:ts|js)\b/.test(family)) return false

      try {
        const files = execFileSync('lsof', ['-p', String(candidate.pid), '-Fn'], {
          encoding: 'utf8',
          timeout: 5_000,
        })
        return files
          .split('\n')
          .filter((line) => line.startsWith('n'))
          .map((line) => line.slice(1))
          .some((file) => (
            file === usAnalyticsDbPath
            || file.startsWith(`${usAnalyticsDbPath}-`)
            || file === adjustedShadowDbPath
            || file.startsWith(`${adjustedShadowDbPath}-`)
          ))
      } catch {
        // Unknown manually-started heavy workers stay conservative.
        return true
      }
    })
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
    latestAdjustedRebuildFinishedAt: number | null
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
       ) AS latestPriceFinishedAt,
       (
         SELECT MAX(finished_at)
         FROM market_data_runs
         WHERE market = 'US'
           AND job_type = 'snapshot_compute'
           AND status = 'success'
           AND finished_at IS NOT NULL
           AND json_extract(payload_json, '$.rebuild') = 1
           AND json_extract(payload_json, '$.priceBasis') = '${US_ADJUSTED_PRICE_BASIS}'
       ) AS latestAdjustedRebuildFinishedAt
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
    || row.latestAdjustedRebuildFinishedAt == null
    || row.latestAdjustedRebuildFinishedAt > row.finishedAt
  ) {
    return false
  }
  try {
    const payload = JSON.parse(row.payloadJson) as {
      rebuild?: unknown
      priceBasis?: unknown
      stage?: unknown
    }
    return payload.priceBasis === US_ADJUSTED_PRICE_BASIS
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
  const [priceBasis, derivedBasis, derivedDate, analogBasis, analogDate, priceDate] = await Promise.all([
    analyticsMetadataValue(usAnalyticsDbPath, 'ohlcv_price_basis'),
    analyticsMetadataValue(usAnalyticsDbPath, 'derived_price_basis'),
    analyticsMetadataValue(usAnalyticsDbPath, 'derived_price_date'),
    analyticsMetadataValue(usAnalyticsDbPath, 'analog_index_price_basis'),
    analyticsMetadataValue(usAnalyticsDbPath, 'analog_index_price_date'),
    analyticsMaxPriceDate(usAnalyticsDbPath),
  ])
  if (!priceDate) return false
  return (
    priceBasis === US_ADJUSTED_PRICE_BASIS
    && derivedBasis === US_ADJUSTED_PRICE_BASIS
    && derivedDate === priceDate
    && analogBasis === US_ADJUSTED_PRICE_BASIS
    && analogDate === priceDate
    && await analogGenerationIsCurrent(usAnalogDbPath, priceDate)
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

async function analogMetadataValue(dbPath: string, key: string): Promise<string | null> {
  if (!fs.existsSync(dbPath)) return null
  const client = createClient({ url: `file:${dbPath}` })
  try {
    const row = await client.execute({
      sql: `SELECT value FROM analog_sequence_meta WHERE key = ?`,
      args: [key],
    })
    const value = row.rows[0]?.value
    return value == null ? null : String(value)
  } catch {
    return null
  } finally {
    client.close()
  }
}

async function analogGenerationIsCurrent(dbPath: string, sourceDate: string): Promise<boolean> {
  const [version, completed, indexDate, priceCompleted, priceDate, chunkCompleted, chunkDate] = await Promise.all([
    analogMetadataValue(dbPath, 'version'),
    analogMetadataValue(dbPath, 'completed'),
    analogMetadataValue(dbPath, 'source_date'),
    analogMetadataValue(dbPath, 'price_completed'),
    analogMetadataValue(dbPath, 'price_source_date'),
    analogMetadataValue(dbPath, 'price_chunks_completed'),
    analogMetadataValue(dbPath, 'price_chunks_source_date'),
  ])
  return Number(version) === MA_SEQUENCE_VERSION
    && completed === '1'
    && indexDate === sourceDate
    && priceCompleted === '1'
    && priceDate === sourceDate
    && chunkCompleted === '1'
    && chunkDate === sourceDate
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

async function resumableAdjustedShadowExists(): Promise<boolean> {
  if (!fs.existsSync(adjustedShadowDbPath)) return false
  const [basis, shadowDate, source] = await Promise.all([
    analyticsMetadataValue(adjustedShadowDbPath, 'ohlcv_price_basis'),
    analyticsMaxPriceDate(adjustedShadowDbPath),
    execGet<{ date: string | null }>(
      `SELECT MAX(date) AS date FROM market_ohlcv_daily WHERE market = 'US'`,
    ),
  ])
  return basis === US_ADJUSTED_PRICE_BASIS
    && shadowDate != null
    && shadowDate === source?.date
}

async function seedAdjustedAnalyticsShadow(): Promise<boolean> {
  if (fs.existsSync(adjustedShadowDbPath)) return false
  const [basis, analyticsDate, source] = await Promise.all([
    analyticsMetadataValue(usAnalyticsDbPath, 'ohlcv_price_basis'),
    analyticsMaxPriceDate(usAnalyticsDbPath),
    execGet<{ date: string | null }>(
      `SELECT MAX(date) AS date FROM market_ohlcv_daily WHERE market = 'US'`,
    ),
  ])
  if (
    basis !== US_ADJUSTED_PRICE_BASIS
    || analyticsDate == null
    || analyticsDate !== source?.date
  ) return false

  await checkpointDb(usAnalyticsDbPath)
  cloneFile(usAnalyticsDbPath, adjustedShadowDbPath)
  fs.chmodSync(adjustedShadowDbPath, 0o600)
  console.log(`US adjusted foundation: seeded shadow from current adjusted analytics baseline (${analyticsDate})`)
  return true
}

async function adjustedForwardExtremaBaselineExists(dbPath: string): Promise<boolean> {
  if (!fs.existsSync(dbPath)) return false
  const client = createClient({ url: `file:${dbPath}` })
  try {
    const row = await client.execute(`
      SELECT
        EXISTS(SELECT 1 FROM forward_extrema WHERE horizon_days = 5 LIMIT 1)
        + EXISTS(SELECT 1 FROM forward_extrema WHERE horizon_days = 10 LIMIT 1)
        + EXISTS(SELECT 1 FROM forward_extrema WHERE horizon_days = 20 LIMIT 1)
        + EXISTS(SELECT 1 FROM forward_extrema WHERE horizon_days = 40 LIMIT 1)
        + EXISTS(SELECT 1 FROM forward_extrema WHERE horizon_days = 60 LIMIT 1)
        + EXISTS(SELECT 1 FROM forward_extrema WHERE horizon_days = 90 LIMIT 1)
        + EXISTS(SELECT 1 FROM forward_extrema WHERE horizon_days = 200 LIMIT 1)
        AS horizonCount
    `)
    return Number(row.rows[0]?.horizonCount ?? 0) === 7
  } finally {
    client.close()
  }
}

async function reusableAdjustedDerivedBaselineExists(dbPath: string): Promise<boolean> {
  if (!fs.existsSync(dbPath)) return false
  const client = createClient({ url: `file:${dbPath}` })
  try {
    const row = await client.execute(`
      SELECT
        EXISTS(SELECT 1 FROM physical_momentum_metrics WHERE market = 'US' LIMIT 1)
        + EXISTS(SELECT 1 FROM forward_returns LIMIT 1)
        + EXISTS(SELECT 1 FROM forward_extrema LIMIT 1)
        + EXISTS(SELECT 1 FROM ml_feature_vectors LIMIT 1)
        + EXISTS(SELECT 1 FROM ml_training_labels LIMIT 1)
        AS baselineCount
    `)
    return Number(row.rows[0]?.baselineCount ?? 0) === 5
  } finally {
    client.close()
  }
}

async function reusablePhysicsLabelBaselineExists(dbPath: string): Promise<boolean> {
  if (!fs.existsSync(dbPath)) return false
  const client = createClient({ url: `file:${dbPath}` })
  try {
    const featureStartResult = await client.execute({
      sql: `
        SELECT date
        FROM ml_feature_vectors_v2 INDEXED BY ml_feature_vectors_v2_date_idx
        WHERE feature_set = ?
        ORDER BY date ASC
        LIMIT 1
      `,
      args: [ML_PHYSICS_FEATURE_SET],
    })
    const featureStart = featureStartResult.rows[0]?.date
    if (featureStart == null) return false
    const row = await client.execute({
      sql: `
        SELECT COUNT(DISTINCT horizon_days) AS horizonCount
        FROM ml_short_labels INDEXED BY ml_short_labels_date_idx
        WHERE date = ?
          AND horizon_days IN (5, 10, 20, 40, 60, 90, 200)
      `,
      args: [String(featureStart)],
    })
    return Number(row.rows[0]?.horizonCount ?? 0) === 7
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('no such table')) return false
    throw error
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

function cloneFile(source: string, target: string): void {
  if (process.platform === 'darwin') {
    // Node/libuv can report ENOSYS for APFS clone flags on removable volumes,
    // while macOS clonefile(2) remains available through cp -c.
    execFileSync('/bin/cp', ['-c', source, target], { stdio: 'inherit' })
    return
  }
  fs.copyFileSync(source, target, fs.constants.COPYFILE_FICLONE_FORCE)
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
  cloneFile(usAnalyticsDbPath, backupPath)
  moveIfPresent(`${usAnalyticsDbPath}-wal`, `${backupPath}-wal`)
  moveIfPresent(`${usAnalyticsDbPath}-shm`, `${backupPath}-shm`)
  moveIfPresent(`${adjustedShadowDbPath}-wal`, `${backupPath}.promoted-shadow-wal`)
  moveIfPresent(`${adjustedShadowDbPath}-shm`, `${backupPath}.promoted-shadow-shm`)
  fs.renameSync(adjustedShadowDbPath, usAnalyticsDbPath)
  return backupPath
}

async function seedAdjustedAnalogShadow(): Promise<void> {
  if (fs.existsSync(adjustedAnalogShadowDbPath) || !fs.existsSync(usAnalogDbPath)) return
  await checkpointDb(usAnalogDbPath)
  cloneFile(usAnalogDbPath, adjustedAnalogShadowDbPath)
  fs.chmodSync(adjustedAnalogShadowDbPath, 0o600)
}

async function promoteAdjustedAnalogShadow(): Promise<string> {
  if (!fs.existsSync(adjustedAnalogShadowDbPath)) {
    throw new Error(`US adjusted analog shadow DB not found: ${adjustedAnalogShadowDbPath}`)
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = `${usAnalogDbPath}.pre-${US_ADJUSTED_PRICE_BASIS}-${timestamp}`
  await checkpointDb(usAnalogDbPath)
  await checkpointDb(adjustedAnalogShadowDbPath)
  if (fs.existsSync(usAnalogDbPath)) {
    cloneFile(usAnalogDbPath, backupPath)
  }
  moveIfPresent(`${usAnalogDbPath}-wal`, `${backupPath}-wal`)
  moveIfPresent(`${usAnalogDbPath}-shm`, `${backupPath}-shm`)
  moveIfPresent(`${adjustedAnalogShadowDbPath}-wal`, `${backupPath}.promoted-shadow-wal`)
  moveIfPresent(`${adjustedAnalogShadowDbPath}-shm`, `${backupPath}.promoted-shadow-shm`)
  fs.renameSync(adjustedAnalogShadowDbPath, usAnalogDbPath)
  return backupPath
}

async function buildAdjustedShadow(onStage: (stage: FoundationStage) => Promise<void>): Promise<void> {
  await seedAdjustedAnalyticsShadow()
  if (await resumableAdjustedShadowExists()) {
    console.log(`US adjusted foundation: resuming validated shadow generation ${adjustedShadowDbPath}`)
  } else {
    await onStage('analytics_copy')
    await runNpm('batch:us-analytics-db', {
      US_ANALYTICS_DB_PATH: adjustedShadowDbPath,
      US_ANALYTICS_REBUILD_PRICE_BASIS: '1',
      US_ANALYTICS_NATIVE_CHUNK: process.env.US_FOUNDATION_ANALYTICS_CHUNK ?? '100',
    })
  }
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
    const [extremaBaselineExists, derivedBaselineExists, physicsLabelBaselineExists] = await Promise.all([
      adjustedForwardExtremaBaselineExists(adjustedShadowDbPath),
      reusableAdjustedDerivedBaselineExists(adjustedShadowDbPath),
      reusablePhysicsLabelBaselineExists(adjustedShadowDbPath),
    ])
    const extremaRecalcDays = extremaBaselineExists
      ? (process.env.US_FOUNDATION_EXTREMA_RECALC_DAYS ?? '201')
      : '0'
    const derivedRecentDays = derivedBaselineExists
      ? (process.env.US_FOUNDATION_DERIVED_RECENT_DAYS ?? '420')
      : '0'
    const physicsLabelRecentDays = physicsLabelBaselineExists ? derivedRecentDays : '0'
    if (extremaBaselineExists) {
      console.log(`US adjusted foundation: reusing the full forward-extrema baseline; recalculating ${extremaRecalcDays} recent bars`)
    }
    if (derivedBaselineExists) {
      console.log(`US adjusted foundation: reusing the adjusted derived baseline; recalculating ${derivedRecentDays} recent bars`)
    }
    if (!physicsLabelBaselineExists) {
      console.log('US adjusted foundation: full-history physics labels are missing; building the one-time baseline')
    }
    await onStage('features_models')
    await runNpm('batch:us-ml-full-history', {
      US_ANALYTICS_DB_PATH: adjustedShadowDbPath,
      US_ML_FULL_START_DATE: '1900-01-01',
      US_ML_WEEKLY_RECENT_DAYS: derivedRecentDays,
      US_PMS_RECENT_DAYS: derivedRecentDays,
      US_PMS_WEEKLY_RECENT_DAYS: derivedRecentDays,
      US_PMS_NORMALIZE_RECENT_DAYS: derivedBaselineExists
        ? (process.env.US_FOUNDATION_PMS_NORMALIZE_RECENT_DAYS ?? '30')
        : derivedRecentDays,
      US_ML_WEEKLY_EXTREMA_RECALC_DAYS: extremaRecalcDays,
      FORWARD_EXTREMA_INCREMENTAL_UPSERT: extremaBaselineExists ? '1' : '0',
      US_ML_FEATURE_RECENT_DAYS: derivedRecentDays,
      ML_FEATURE_INCREMENTAL_UPSERT: derivedBaselineExists ? '1' : '0',
      ML_FEATURE_WRITE_LABELS: derivedBaselineExists ? '0' : '1',
      ML_FEATURE_WRITE_RL_STATES: derivedBaselineExists ? '0' : '1',
      US_ML_LABEL_RECENT_DAYS: derivedRecentDays,
      ML_LABEL_INCREMENTAL_UPSERT: derivedBaselineExists ? '1' : '0',
      ML_LABEL_CHANGED_ONLY: derivedBaselineExists ? '1' : '0',
      US_ML_CONTEXT_RECENT_DAYS: derivedRecentDays,
      US_ML_PHYSICS_RECENT_DAYS: derivedRecentDays,
      ML_PHYSICS_INCREMENTAL_UPSERT: derivedBaselineExists ? '1' : '0',
      US_ML_SHORT_LABEL_RECENT_DAYS: physicsLabelRecentDays,
      US_ML_RL_RECENT_DAYS: physicsLabelRecentDays,
      US_ML_STATUS_RECENT_DAYS: physicsLabelRecentDays,
      FORWARD_EXTREMA_RESUME: '1',
      FORWARD_EXTREMA_WRITE_BATCH_TICKERS:
        process.env.US_FOUNDATION_EXTREMA_WRITE_BATCH_TICKERS ?? '100',
      ML_FEATURE_HEALTH_STRICT: '1',
      ML_ACCURACY_STRICT: '1',
      US_ML_SKIP_FORWARD_RETURNS: derivedBaselineExists ? '1' : '0',
      US_ML_SKIP_FORWARD_EXTREMA: process.env.US_FOUNDATION_SKIP_FORWARD_EXTREMA ?? '0',
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
  const currentAnalogIsCurrent = await analogGenerationIsCurrent(usAnalogDbPath, priceDate)
  if (
    analogBasis !== US_ADJUSTED_PRICE_BASIS
    || analogPriceDate !== priceDate
    || !currentAnalogIsCurrent
  ) {
    await onStage('analog_index')
    if (!await analogGenerationIsCurrent(adjustedAnalogShadowDbPath, priceDate)) {
      await seedAdjustedAnalogShadow()
      await runNpm('batch:analog-index:us-full', {
        US_ANALYTICS_DB_PATH: adjustedShadowDbPath,
        ANALOG_US_DB_PATH: adjustedAnalogShadowDbPath,
      })
    }
    if (!await analogGenerationIsCurrent(adjustedAnalogShadowDbPath, priceDate)) {
      throw new Error('US adjusted analog shadow did not complete for the current source date')
    }
    const analogBackupPath = await promoteAdjustedAnalogShadow()
    console.log(`US adjusted analog index promoted; previous generation retained: ${analogBackupPath}`)
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
  let updateLockForSignal: UpdateLockHandle | null = null
  let signalExitStarted = false
  const releaseOnSignal = (signal: NodeJS.Signals) => {
    if (signalExitStarted) return
    signalExitStarted = true
    void updateLockForSignal?.release()
      .catch(() => undefined)
      .finally(() => {
        processLock.release()
        process.exit(signal === 'SIGINT' ? 130 : 143)
      })
  }
  process.once('SIGINT', releaseOnSignal)
  process.once('SIGTERM', releaseOnSignal)
  const lock = await acquireUsStockboardUpdateLock(
    'us_adjusted_foundation',
    72 * 60 * 60,
  )
  if (!lock) {
    processLock.release()
    throw new Error('US adjusted foundation is already active')
  }
  updateLockForSignal = lock
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
        let sourceSnapshotLock: UpdateLockHandle | null = null
        try {
          sourceSnapshotLock = await acquireUpdateLock(
            SOURCE_SNAPSHOT_LOCK_JOB,
            72 * 60 * 60,
            SOURCE_SNAPSHOT_CONFLICTS,
          )
          if (!sourceSnapshotLock) {
            throw new Error(
              'US adjusted foundation deferred: a shared source DB update is active',
            )
          }
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
        } finally {
          await sourceSnapshotLock?.release().catch(() => undefined)
        }
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
    updateLockForSignal = null
    process.removeListener('SIGINT', releaseOnSignal)
    process.removeListener('SIGTERM', releaseOnSignal)
    processLock.release()
  }
}

main().catch((error) => {
  console.error('US adjusted foundation failed:', error)
  process.exit(1)
})
