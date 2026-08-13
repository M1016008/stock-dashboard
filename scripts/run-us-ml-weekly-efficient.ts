import { spawn } from 'node:child_process'
import { createClient } from '@libsql/client'
import fs from 'node:fs'
import path from 'node:path'
import { ML_PIPELINE_GENERATION_VERSION, ML_PIPELINE_NAME } from '@/lib/ml/pipeline-generation'
import { MA_SEQUENCE_VERSION } from '@/lib/ml/ma-sequence'
import { waitForMemoryHeadroom, withMemoryGuardEnv } from '@/lib/system/memory-guard'
import { US_ADJUSTED_PRICE_BASIS } from '@/lib/us-adjusted-ohlcv'

const usAnalyticsDbPath = process.env.US_ANALYTICS_DB_PATH?.trim()
  || '/Volumes/こうし/stockboard-data/us/stockboard-us.db'
const sourceDbPath = process.env.STOCKBOARD_DB_PATH?.trim()
  || process.env.LOCAL_DB_PATH?.trim()
  || 'data/stockboard.db'
const usAnalogDbPath = process.env.ANALOG_US_DB_PATH?.trim()
  || path.join(path.dirname(usAnalyticsDbPath), `analog-sequence-us-v${MA_SEQUENCE_VERSION}.db`)

function nonNegativeInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback
}

function isPromotedBackupPrimary(fileName: string, prefix: string): boolean {
  return (
    fileName.startsWith(prefix)
    && !fileName.endsWith('-wal')
    && !fileName.endsWith('-shm')
    && !fileName.endsWith('.promoted-shadow-wal')
    && !fileName.endsWith('.promoted-shadow-shm')
  )
}

function pruneBackupFamily(basePath: string, keep: number): { files: number; bytes: number } {
  const directory = path.dirname(basePath)
  const prefix = `${path.basename(basePath)}.pre-${US_ADJUSTED_PRICE_BASIS}-`
  const primaries = fs.readdirSync(directory)
    .filter((fileName) => isPromotedBackupPrimary(fileName, prefix))
    .map((fileName) => path.join(directory, fileName))
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs)

  let files = 0
  let bytes = 0
  for (const primary of primaries.slice(keep)) {
    for (const candidate of [
      primary,
      `${primary}-wal`,
      `${primary}-shm`,
      `${primary}.promoted-shadow-wal`,
      `${primary}.promoted-shadow-shm`,
    ]) {
      if (!fs.existsSync(candidate)) continue
      bytes += fs.statSync(candidate).size
      fs.unlinkSync(candidate)
      files += 1
    }
  }
  return { files, bytes }
}

function pruneValidatedPromotedBackups(): void {
  const keep = nonNegativeInteger(process.env.US_PROMOTED_BACKUP_RETENTION, 0)
  const analytics = pruneBackupFamily(usAnalyticsDbPath, keep)
  const analog = pruneBackupFamily(usAnalogDbPath, keep)
  const files = analytics.files + analog.files
  const bytes = analytics.bytes + analog.bytes
  console.log(`US promoted backup prune: keep=${keep}, files=${files}, bytes=${bytes}`)
}

async function metadataValue(key: string): Promise<string | null> {
  const client = createClient({ url: `file:${usAnalyticsDbPath}` })
  try {
    const table = await client.execute(
      `SELECT 1
       FROM sqlite_master
       WHERE type = 'table' AND name = 'us_analytics_metadata'
       LIMIT 1`,
    )
    if (table.rows.length === 0) return null
    const row = await client.execute({
      sql: 'SELECT value FROM us_analytics_metadata WHERE key = ?',
      args: [key],
    })
    const value = row.rows[0]?.value
    return value == null ? null : String(value)
  } finally {
    client.close()
  }
}

async function analyticsMaxPriceDate(): Promise<string | null> {
  const client = createClient({ url: `file:${usAnalyticsDbPath}` })
  try {
    const row = await client.execute('SELECT MAX(date) AS value FROM ohlcv_daily')
    const value = row.rows[0]?.value
    return value == null ? null : String(value)
  } finally {
    client.close()
  }
}

async function analogMetadataValue(key: string): Promise<string | null> {
  if (!fs.existsSync(usAnalogDbPath)) return null
  const client = createClient({ url: `file:${usAnalogDbPath}` })
  try {
    const row = await client.execute({
      sql: 'SELECT value FROM analog_sequence_meta WHERE key = ?',
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

async function analogGenerationIsCurrent(sourceDate: string): Promise<boolean> {
  const [version, completed, indexDate, priceCompleted, priceDate, chunkCompleted, chunkDate] = await Promise.all([
    analogMetadataValue('version'),
    analogMetadataValue('completed'),
    analogMetadataValue('source_date'),
    analogMetadataValue('price_completed'),
    analogMetadataValue('price_source_date'),
    analogMetadataValue('price_chunks_completed'),
    analogMetadataValue('price_chunks_source_date'),
  ])
  return Number(version) === MA_SEQUENCE_VERSION
    && completed === '1'
    && indexDate === sourceDate
    && priceCompleted === '1'
    && priceDate === sourceDate
    && chunkCompleted === '1'
    && chunkDate === sourceDate
}

async function adjustedFoundationIsCurrent(): Promise<boolean> {
  const [priceBasis, derivedBasis, derivedDate, analogBasis, analogDate, priceDate] = await Promise.all([
    metadataValue('ohlcv_price_basis'),
    metadataValue('derived_price_basis'),
    metadataValue('derived_price_date'),
    metadataValue('analog_index_price_basis'),
    metadataValue('analog_index_price_date'),
    analyticsMaxPriceDate(),
  ])
  if (!priceDate) return false
  return (
    priceBasis === US_ADJUSTED_PRICE_BASIS
    && derivedBasis === US_ADJUSTED_PRICE_BASIS
    && derivedDate === priceDate
    && analogBasis === US_ADJUSTED_PRICE_BASIS
    && analogDate === priceDate
    && await analogGenerationIsCurrent(priceDate)
  )
}

async function auditedFullHistoryBaselineExists(): Promise<boolean> {
  const client = createClient({ url: `file:${usAnalyticsDbPath}` })
  try {
    const table = await client.execute(
      `SELECT 1
       FROM sqlite_master
       WHERE type = 'table' AND name = 'ml_pipeline_generations'
       LIMIT 1`,
    )
    if (table.rows.length === 0) return false
    const result = await client.execute({
      sql: `
        SELECT generation_version, status, payload_json
        FROM ml_pipeline_generations
        WHERE market = 'US' AND pipeline = ?
        LIMIT 1
      `,
      args: [ML_PIPELINE_NAME],
    })
    const row = result.rows[0]
    if (
      !row
      || String(row.status) !== 'complete'
      || String(row.generation_version) !== ML_PIPELINE_GENERATION_VERSION
    ) return false
    try {
      const payload = JSON.parse(String(row.payload_json ?? '{}')) as Record<string, unknown>
      const baseline = payload.baseline && typeof payload.baseline === 'object'
        ? payload.baseline as Record<string, unknown>
        : payload
      return baseline.fullHistoryModelReady === true
    } catch {
      return false
    }
  } finally {
    client.close()
  }
}

async function runNpm(
  script: string,
  overrides: Record<string, string> = {},
  databaseRole: 'source' | 'us-analytics' = 'us-analytics',
): Promise<void> {
  await waitForMemoryHeadroom({ label: `US weekly ${script}` })
  await new Promise<void>((resolve, reject) => {
    const child = spawn('npm', ['run', script], {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: withMemoryGuardEnv({
        ...process.env,
        USE_LOCAL_DB: '1',
        STOCKBOARD_DB_ROLE: databaseRole,
        STOCKBOARD_DB_PATH: databaseRole === 'source' ? sourceDbPath : usAnalyticsDbPath,
        US_ANALYTICS_DB_PATH: usAnalyticsDbPath,
        ...overrides,
      }),
    })
    child.on('error', reject)
    child.on('close', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`npm run ${script} failed: code=${code}, signal=${signal ?? 'none'}`))
    })
  })
}

async function main(): Promise<void> {
  const [foundationWasCurrent, auditedBaselineExists] = await Promise.all([
    adjustedFoundationIsCurrent(),
    auditedFullHistoryBaselineExists(),
  ])
  await runNpm('batch:us-adjusted-foundation', {}, 'source')
  await runNpm('batch:us-analytics-validate')

  if (foundationWasCurrent && auditedBaselineExists) {
    await runNpm('batch:us-ml-weekly-replay')
  } else if (foundationWasCurrent) {
    console.log('US weekly: audited full-history baseline proof is missing; running one full-history baseline')
    await runNpm('batch:us-ml-full-history')
  } else {
    console.log(
      'US weekly: full-history ML already completed inside the newly promoted adjusted generation; '
      + 'skipping duplicate live-DB training for this run',
    )
  }

  await runNpm('batch:ml-model-deterioration', {
    ML_MODEL_DETERIORATION_STRICT: '1',
  })
  await runNpm('batch:us-ml-health', {
    US_ML_HEALTH_WRITE: '1',
  })
  await runNpm('batch:ml-accuracy-health', {
    ML_ACCURACY_STRICT: '1',
  })
  pruneValidatedPromotedBackups()
  await runNpm('db:maintenance', { DB_MAINT_TARGETS: 'us' })
}

main().catch((error) => {
  console.error('US weekly efficient update failed:', error)
  process.exit(1)
})
