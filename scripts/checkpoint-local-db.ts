// scripts/checkpoint-local-db.ts
//
// Large local SQLite databases can accumulate huge WAL files when the dev
// server stays open. This script refuses to run while another process has the
// DB/WAL/SHM files open, then performs a safe WAL checkpoint and a lightweight
// quick_check. It never VACUUMs and never deletes DB files.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

type Sizes = {
  dbBytes: number
  walBytes: number
  shmBytes: number
}

function resolveDbPath(): string {
  const configured = process.env.STOCKBOARD_DB_PATH || process.env.LOCAL_DB_PATH
  return configured ? path.resolve(configured) : path.join(process.cwd(), 'data', 'stockboard.db')
}

function sizeOf(filePath: string): number {
  try {
    return fs.statSync(filePath).size
  } catch {
    return 0
  }
}

function sizes(dbPath: string): Sizes {
  return {
    dbBytes: sizeOf(dbPath),
    walBytes: sizeOf(`${dbPath}-wal`),
    shmBytes: sizeOf(`${dbPath}-shm`),
  }
}

function formatGiB(bytes: number): string {
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`
}

function listOpenHandles(dbPath: string): string {
  const targets = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].filter((target) => fs.existsSync(target))
  if (targets.length === 0) return ''
  const result = spawnSync('lsof', ['-nP', ...targets], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 8,
  })
  if (result.status === 1 && !result.stdout.trim()) return ''
  return [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
}

function runSqlite(dbPath: string): string {
  const sqliteBin = process.env.SQLITE3_BIN || '/usr/bin/sqlite3'
  const checkMode = process.env.DB_MAINT_CHECK_MODE ?? 'smoke'
  const checkSql = checkMode === 'quick'
    ? ['PRAGMA quick_check;']
    : [
        'PRAGMA schema_version;',
        'PRAGMA page_count;',
        'PRAGMA freelist_count;',
        'PRAGMA wal_checkpoint(PASSIVE);',
      ]
  const sql = [
    'PRAGMA busy_timeout=60000;',
    'PRAGMA wal_checkpoint(TRUNCATE);',
    ...checkSql,
  ].join(' ')
  const result = spawnSync(sqliteBin, [dbPath, sql], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 8,
  })
  if (result.status !== 0) {
    throw new Error(`sqlite3 failed (${result.status}): ${result.stderr || result.stdout}`)
  }
  return result.stdout.trim()
}

async function main() {
  const dbPath = resolveDbPath()
  if (!fs.existsSync(dbPath)) {
    throw new Error(`DB not found: ${dbPath}`)
  }

  const before = sizes(dbPath)
  const openHandles = listOpenHandles(dbPath)
  if (openHandles && process.env.DB_MAINT_ALLOW_ACTIVE !== '1') {
    console.error('[checkpoint-local-db] active DB handles detected; aborting without changes')
    console.error(openHandles)
    process.exitCode = 2
    return
  }

  const sqliteOutput = runSqlite(dbPath)
  const after = sizes(dbPath)

  console.log(JSON.stringify({
    dbPath,
    before: {
      db: formatGiB(before.dbBytes),
      wal: formatGiB(before.walBytes),
      shm: formatGiB(before.shmBytes),
    },
    after: {
      db: formatGiB(after.dbBytes),
      wal: formatGiB(after.walBytes),
      shm: formatGiB(after.shmBytes),
    },
    sqliteOutput,
  }, null, 2))
}

main().catch((error) => {
  console.error('[checkpoint-local-db] failed:', error)
  process.exitCode = 1
})
