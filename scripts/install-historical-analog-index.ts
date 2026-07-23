// Builds the stage and quantized MA-neighborhood indexes used by full-history analog search.
// It never deletes rows, VACUUMs, or replaces a database file.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

type TargetName = 'jp' | 'us'

const INDEX_NAME = 'ml_feature_vectors_v2_feature_stage_date_ticker_idx'
const BUCKET_INDEX_NAME = 'ml_feature_vectors_v2_analog_bucket_idx'
const SQLITE_BIN = process.env.SQLITE3_BIN || '/usr/bin/sqlite3'

function targetPath(name: TargetName): string {
  if (name === 'us') {
    return path.resolve(process.env.US_ANALYTICS_DB_PATH || '/Volumes/OWC Express 1M2 80G/stockboard-data/us/stockboard-us.db')
  }
  return path.resolve(process.env.STOCKBOARD_DB_PATH || process.env.LOCAL_DB_PATH || path.join(process.cwd(), 'data', 'stockboard.db'))
}

function targets(): Array<{ name: TargetName; dbPath: string }> {
  const names = (process.env.DB_SIMILARITY_TARGETS || 'jp,us')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter((value): value is TargetName => value === 'jp' || value === 'us')
  return [...new Set(names)].map((name) => ({ name, dbPath: targetPath(name) }))
}

function formatGiB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`
}

function assertNoOpenHandles(dbPath: string): void {
  const files = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].filter((file) => fs.existsSync(file))
  const result = spawnSync('lsof', ['-nP', ...files], { encoding: 'utf8' })
  if (result.stdout.trim()) {
    throw new Error(`DB is open; stop readers/writers before creating the similarity index: ${dbPath}`)
  }
}

function runSqlite(dbPath: string, sql: string): string {
  const result = spawnSync(SQLITE_BIN, [dbPath, sql], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `sqlite3 exited ${result.status}`)
  return result.stdout.trim()
}

function main(): void {
  const results = targets().map((target) => {
    if (!fs.existsSync(target.dbPath)) throw new Error(`${target.name} DB not found: ${target.dbPath}`)
    assertNoOpenHandles(target.dbPath)
    const before = fs.statSync(target.dbPath).size
    runSqlite(target.dbPath, `
      PRAGMA busy_timeout=60000;
      PRAGMA temp_store=FILE;
      PRAGMA cache_size=-131072;
      PRAGMA mmap_size=0;
      PRAGMA cache_spill=ON;
      PRAGMA threads=2;
      CREATE INDEX IF NOT EXISTS ${INDEX_NAME}
        ON ml_feature_vectors_v2(feature_set, stage_code, date, ticker);
      CREATE INDEX IF NOT EXISTS ${BUCKET_INDEX_NAME}
        ON ml_feature_vectors_v2(
          feature_set,
          stage_code,
          CAST(ROUND(json_extract(vector_json, '$[11]') * 5) AS INTEGER),
          CAST(ROUND(json_extract(vector_json, '$[15]') * 5) AS INTEGER),
          CAST(ROUND(json_extract(vector_json, '$[25]') * 5) AS INTEGER),
          CAST(ROUND(json_extract(vector_json, '$[26]') * 5) AS INTEGER),
          date,
          ticker
        );
      ANALYZE ${INDEX_NAME};
      ANALYZE ${BUCKET_INDEX_NAME};
    `)
    const verified = runSqlite(
      target.dbPath,
      `SELECT group_concat(name, ',') FROM sqlite_master WHERE type='index' AND name IN ('${INDEX_NAME}', '${BUCKET_INDEX_NAME}');`,
    )
    const after = fs.statSync(target.dbPath).size
    return {
      target: target.name,
      dbPath: target.dbPath,
      index: verified,
      before: formatGiB(before),
      after: formatGiB(after),
      added: formatGiB(Math.max(0, after - before)),
    }
  })
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2))
}

try {
  main()
} catch (error) {
  console.error('[historical-analog-index] failed:', error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
