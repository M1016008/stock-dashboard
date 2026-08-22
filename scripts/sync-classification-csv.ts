// Import the latest classification CSV only when its content changes.
// The source may live on a removable SSD, so an unavailable or actively
// changing file is a normal no-op and will be retried by the next launchd run.

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createClient } from '@libsql/client'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  classificationValidationOptionsFromEnv,
  readClassificationSource,
  validateClassificationSource,
} from '@/lib/classification-source'

type SyncState = {
  schemaVersion: 4
  sourcePath: string
  databasePath: string
  sha256: string
  sourceSize: number
  sourceMtimeMs: number
  sourceRecordCount: number
  shikihoProfileCount: number
  majorCategoryCount: number
  subIndustryCount: number
  recoveredMissingSubIndustryCount: number
  syncedAt: string
}

const DEFAULT_SOURCE_PATH = '/Volumes/OWC Express 1M2 80G/会社四季報CSV/会社四季報_最新.csv'
const sourcePath = path.resolve(process.env.CLASSIFICATION_FILE?.trim() || DEFAULT_SOURCE_PATH)
const databasePath = path.resolve(
  process.env.STOCKBOARD_DB_PATH?.trim()
    || process.env.LOCAL_DB_PATH?.trim()
    || path.join(process.cwd(), 'data', 'stockboard.db'),
)
const supportDir = path.join(os.homedir(), 'Library', 'Application Support', 'StockBoard')
const statePath = path.resolve(
  process.env.CLASSIFICATION_SYNC_STATE_PATH?.trim()
    || path.join(supportDir, 'classification-sync-state.json'),
)
const lockPath = `${statePath}.lock`
const stableAgeSeconds = Math.max(
  30,
  Number(process.env.CLASSIFICATION_MIN_STABLE_AGE_SECONDS ?? '120') || 120,
)
const forceSync = process.env.CLASSIFICATION_FORCE_SYNC === '1'
const maxRecordDropPercent = Math.min(
  25,
  Math.max(0, Number(process.env.CLASSIFICATION_MAX_RECORD_DROP_PERCENT ?? '5') || 5),
)

function sha256(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function readState(): SyncState | null {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8')) as SyncState
  } catch {
    return null
  }
}

function writeState(state: SyncState): void {
  const temporaryPath = `${statePath}.${process.pid}.tmp`
  fs.writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  fs.renameSync(temporaryPath, statePath)
}

function acquireLock(): number | null {
  try {
    return fs.openSync(lockPath, 'wx')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const ageMs = Date.now() - fs.statSync(lockPath).mtimeMs
    if (ageMs > 6 * 60 * 60 * 1000) {
      fs.unlinkSync(lockPath)
      return fs.openSync(lockPath, 'wx')
    }
    return null
  }
}

async function databaseImportCounts(): Promise<{ classifications: number; profiles: number }> {
  if (!fs.existsSync(databasePath)) return { classifications: 0, profiles: 0 }
  const database = createClient({ url: `file:${databasePath}` })
  try {
    const classificationResult = await database.execute('SELECT COUNT(*) AS count FROM stock_classification')
    let profiles = 0
    try {
      const profileResult = await database.execute('SELECT COUNT(*) AS count FROM stock_shikiho_profiles')
      profiles = Number(profileResult.rows[0]?.count ?? 0)
    } catch {
      // The next import creates the profile table through ensureSchema().
    }
    return {
      classifications: Number(classificationResult.rows[0]?.count ?? 0),
      profiles,
    }
  } catch {
    return { classifications: 0, profiles: 0 }
  } finally {
    database.close()
  }
}

async function main(): Promise<void> {
  fs.mkdirSync(path.dirname(statePath), { recursive: true })
  const lockFd = acquireLock()
  if (lockFd == null) {
    console.log('Classification sync is already running; skipping this check.')
    return
  }

  const extension = path.extname(sourcePath) || '.csv'
  const snapshotPath = path.join(path.dirname(statePath), `classification-source-${process.pid}${extension}`)
  try {
    fs.writeFileSync(lockFd, `${process.pid}\n`, 'utf8')
    if (!fs.existsSync(sourcePath)) {
      console.log(`Classification source is unavailable; retrying next run: ${sourcePath}`)
      return
    }

    const before = fs.statSync(sourcePath)
    const ageSeconds = (Date.now() - before.mtimeMs) / 1000
    if (ageSeconds < stableAgeSeconds) {
      console.log(
        `Classification source is still settling (${Math.max(0, Math.floor(ageSeconds))}s old); retrying next run.`,
      )
      return
    }

    const sourceSha256 = sha256(sourcePath)
    const previous = readState()
    const databaseCounts = await databaseImportCounts()
    if (
      !forceSync
      && previous?.schemaVersion === 4
      && previous.sourcePath === sourcePath
      && previous.databasePath === databasePath
      && previous.sha256 === sourceSha256
      && databaseCounts.classifications === previous.sourceRecordCount
      && databaseCounts.profiles === previous.shikihoProfileCount
    ) {
      console.log(`Classification source unchanged since ${previous.syncedAt}; no import needed.`)
      return
    }

    fs.copyFileSync(sourcePath, snapshotPath)
    const snapshotSha256 = sha256(snapshotPath)
    const after = fs.statSync(sourcePath)
    if (
      snapshotSha256 !== sourceSha256
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
    ) {
      console.log('Classification source changed during validation; retrying next run.')
      return
    }

    const source = await readClassificationSource(snapshotPath)
    validateClassificationSource(source, classificationValidationOptionsFromEnv())
    if (previous && previous.sourceRecordCount > 0) {
      const minimumRelativeCount = Math.floor(
        previous.sourceRecordCount * (1 - maxRecordDropPercent / 100),
      )
      if (source.records.length < minimumRelativeCount) {
        throw new Error(
          `Classification source shrank too much: ${source.records.length} records, `
          + `previous=${previous.sourceRecordCount}, allowedDrop=${maxRecordDropPercent}%`,
        )
      }
    }

    console.log(
      `Classification update detected: records=${source.records.length}, `
      + `shikihoProfiles=${source.profiles.length}, `
      + `majorCategories=${source.majorCategoryCount}, subIndustries=${source.subIndustryCount}, `
      + `recoveredMissingSubIndustries=${source.recoveredMissingSubIndustries.length}, `
      + `size=${before.size}, modified=${new Date(before.mtimeMs).toISOString()}`,
    )
    const result = spawnSync('npm', ['run', 'import:classification'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        USE_LOCAL_DB: '1',
        CLASSIFICATION_FILE: snapshotPath,
      },
      stdio: 'inherit',
    })
    if (result.status !== 0) {
      throw new Error(
        `Classification import failed: code=${result.status ?? 'none'}, signal=${result.signal ?? 'none'}`,
      )
    }

    const importedDatabaseCounts = await databaseImportCounts()
    if (importedDatabaseCounts.classifications !== source.records.length) {
      throw new Error(
        `Classification DB verification failed: rows=${importedDatabaseCounts.classifications}, `
        + `source=${source.records.length}`,
      )
    }
    if (importedDatabaseCounts.profiles !== source.profiles.length) {
      throw new Error(
        `Shikiho profile DB verification failed: rows=${importedDatabaseCounts.profiles}, `
        + `source=${source.profiles.length}`,
      )
    }
    const state: SyncState = {
      schemaVersion: 4,
      sourcePath,
      databasePath,
      sha256: sourceSha256,
      sourceSize: before.size,
      sourceMtimeMs: before.mtimeMs,
      sourceRecordCount: source.records.length,
      shikihoProfileCount: source.profiles.length,
      majorCategoryCount: source.majorCategoryCount,
      subIndustryCount: source.subIndustryCount,
      recoveredMissingSubIndustryCount: source.recoveredMissingSubIndustries.length,
      syncedAt: new Date().toISOString(),
    }
    writeState(state)
    console.log(`Classification sync complete: ${state.syncedAt}`)
  } finally {
    try {
      fs.closeSync(lockFd)
    } catch {
      // The descriptor may already be closed after an interrupted run.
    }
    fs.rmSync(lockPath, { force: true })
    fs.rmSync(snapshotPath, { force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
