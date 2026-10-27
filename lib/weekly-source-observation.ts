import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import type {
  WeeklyOptimizationMarket,
  WeeklySourceObservation,
} from '@/lib/weekly-optimization-run-contract'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sqliteJsonRow<T extends Record<string, unknown>>(dbPath: string, sql: string): T {
  try {
    if (!fs.existsSync(dbPath)) throw new Error('database file does not exist')
    const output = execFileSync(
      'sqlite3',
      ['-readonly', '-json', '-cmd', '.timeout 5000', dbPath, sql],
      { encoding: 'utf8', timeout: 10_000 },
    ).trim()
    const rows = JSON.parse(output || '[]') as T[]
    if (!rows[0]) throw new Error('query returned no row')
    return rows[0]
  } catch (error) {
    throw new Error(`weekly optimization source lineage query failed for ${dbPath}: ${errorMessage(error)}`)
  }
}

export function readWeeklySourceObservation(
  market: WeeklyOptimizationMarket,
  sourceDbPath: string,
  priceBasis: string,
): WeeklySourceObservation {
  const row = market === 'JP'
    ? sqliteJsonRow<Record<string, unknown>>(sourceDbPath, `
        WITH relevant AS (
          SELECT id, status, started_at, finished_at
          FROM batch_runs
          WHERE job_type = 'ohlcv_fetch:jquants'
        ), latest AS (
          SELECT * FROM relevant ORDER BY id DESC LIMIT 1
        )
        SELECT
          COALESCE((SELECT id FROM latest), 0) AS latestRunId,
          COALESCE((SELECT MAX(id) FROM relevant WHERE status IN ('success', 'partial')), 0) AS latestPublishableRunId,
          COALESCE((SELECT status FROM latest), 'missing') AS latestRunStatus,
          (SELECT COUNT(*) FROM relevant WHERE status = 'running') AS runningCount,
          (SELECT started_at FROM latest) AS startedAt,
          (SELECT finished_at FROM latest) AS finishedAt,
          COALESCE((SELECT MAX(date) FROM ohlcv_daily), '') AS priceDate,
          (SELECT finished_at FROM latest) AS maxImportedAt,
          COALESCE((
            SELECT GROUP_CONCAT(value, '|') FROM (
              SELECT job_type || ':' || COALESCE(owner, '') AS value
              FROM update_locks
              WHERE status = 'running' AND lease_expires_at > unixepoch()
              ORDER BY job_type, owner
            )
          ), '') AS activeWriterLocks
      `)
    : sqliteJsonRow<Record<string, unknown>>(sourceDbPath, `
        WITH relevant AS (
          SELECT id, status, started_at, finished_at
          FROM market_data_runs
          WHERE market = 'US' AND job_type = 'tiingo_ohlcv'
        ), latest AS (
          SELECT * FROM relevant ORDER BY id DESC LIMIT 1
        ), universe_relevant AS (
          SELECT id, status, finished_at
          FROM market_data_runs
          WHERE market = 'US' AND job_type = 'tiingo_universe'
        ), universe_latest AS (
          SELECT * FROM universe_relevant ORDER BY id DESC LIMIT 1
        )
        SELECT
          COALESCE((SELECT id FROM latest), 0) AS latestRunId,
          COALESCE((SELECT MAX(id) FROM relevant WHERE status IN ('success', 'partial')), 0) AS latestPublishableRunId,
          COALESCE((SELECT status FROM latest), 'missing') AS latestRunStatus,
          (SELECT COUNT(*) FROM relevant WHERE status = 'running') AS runningCount,
          (SELECT started_at FROM latest) AS startedAt,
          (SELECT finished_at FROM latest) AS finishedAt,
          COALESCE((SELECT MAX(date) FROM market_ohlcv_daily WHERE market = 'US'), '') AS priceDate,
          (SELECT MAX(imported_at) FROM market_ohlcv_daily WHERE market = 'US') AS maxImportedAt,
          COALESCE((
            SELECT GROUP_CONCAT(value, '|') FROM (
              SELECT job_type || ':' || COALESCE(owner, '') AS value
              FROM update_locks
              WHERE status = 'running' AND lease_expires_at > unixepoch()
              ORDER BY job_type, owner
            )
          ), '') AS activeWriterLocks,
          COALESCE((SELECT id FROM universe_latest), 0) AS universeLatestRunId,
          COALESCE((SELECT MAX(id) FROM universe_relevant WHERE status IN ('success', 'partial')), 0)
            AS universeLatestPublishableRunId,
          COALESCE((SELECT status FROM universe_latest), 'missing') AS universeLatestRunStatus,
          (SELECT COUNT(*) FROM universe_relevant WHERE status = 'running') AS universeRunningCount,
          (SELECT finished_at FROM universe_latest) AS universeFinishedAt,
          (SELECT MAX(updated_at) FROM market_universe WHERE market = 'US') AS universeMaxUpdatedAt,
          (SELECT COUNT(*) FROM market_universe WHERE market = 'US' AND active = 1) AS universeActiveCount
      `)
  const numberOrNull = (value: unknown): number | null => value == null ? null : Number(value)
  return {
    latestRunId: Number(row.latestRunId ?? 0),
    latestPublishableRunId: Number(row.latestPublishableRunId ?? 0),
    latestRunStatus: String(row.latestRunStatus ?? 'missing'),
    runningCount: Number(row.runningCount ?? 0),
    startedAt: numberOrNull(row.startedAt),
    finishedAt: numberOrNull(row.finishedAt),
    priceDate: String(row.priceDate ?? ''),
    maxImportedAt: numberOrNull(row.maxImportedAt),
    priceBasis,
    activeWriterLocks: String(row.activeWriterLocks ?? '').split('|').filter(Boolean),
    universeGeneration: market === 'US'
      ? {
          latestRunId: Number(row.universeLatestRunId ?? 0),
          latestPublishableRunId: Number(row.universeLatestPublishableRunId ?? 0),
          latestRunStatus: String(row.universeLatestRunStatus ?? 'missing'),
          runningCount: Number(row.universeRunningCount ?? 0),
          finishedAt: numberOrNull(row.universeFinishedAt),
          maxUpdatedAt: numberOrNull(row.universeMaxUpdatedAt),
          activeCount: Number(row.universeActiveCount ?? 0),
        }
      : null,
  }
}
