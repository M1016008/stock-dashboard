import { createRequire } from 'node:module'
import {
  buildJpOhlcvRuntimeRepairScope,
  summarizeJpOhlcvRuntimeScopeHold,
  stableSha256,
  type JpOfficialOhlcvValue,
  type JpOhlcvMissingOnlyRepairScope,
  type JpOhlcvRuntimeRepairScope,
  type JpOhlcvValue,
} from '@/lib/jp-ohlcv-data-quality'

type ReadOnlyDatabase = {
  prepare(sql: string): {
    get(...args: unknown[]): Record<string, unknown> | undefined
    all(...args: unknown[]): Record<string, unknown>[]
  }
  close(): void
}

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (file: string, options: { readOnly: boolean }) => ReadOnlyDatabase
}

export const JP_OHLCV_RUNTIME_SNAPSHOT_TTL_MS = 15 * 60_000

export type JpOhlcvSourceWatermark = {
  latestRunId: number
  latestPublishableRunId: number
  runningCount: number
  latestStatus: string | null
  latestStartedAt: number | null
  latestFinishedAt: number | null
}

export type JpOhlcvServingWatermark = {
  dailySnapshots: { rows: number; latestDate: string | null; latestComputedAt: number | null }
  screening: { rows: number; latestAsOf: string | null; latestCalculatedAt: number | null }
  dashboard: { rows: number; latestDate: string | null; latestComputedAt: number | null }
}

export type JpOhlcvOfficialSourceProof = {
  requestedAt: string
  completedAt: string
  providerRows: number
  acceptedRows: number
  rejectedRows: number
  contentSha256: string
}

export type JpOhlcvRuntimeSnapshot = {
  version: 1
  capturedAt: string
  expiresAt: string
  configurationSha256: string
  officialSha256: string
  approvedRepairKeysSha256: string
  officialRows: number
  officialSourceProof: JpOhlcvOfficialSourceProof
  officialSourceProofSha256: string
  runtimeScope: JpOhlcvRuntimeRepairScope
  sourceWatermark: JpOhlcvSourceWatermark
  sourceWatermarkSha256: string
  servingWatermark: JpOhlcvServingWatermark
  servingWatermarkSha256: string
  snapshotSha256: string
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function textOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

function rowsForDate(database: ReadOnlyDatabase, date: string): JpOhlcvValue[] {
  return database.prepare(`
    SELECT ticker, date, open, high, low, close, volume
    FROM ohlcv_daily
    WHERE date = ?
    ORDER BY ticker
  `).all(date).map((row) => ({
    ticker: String(row.ticker),
    date: String(row.date),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume),
  }))
}

function sourceWatermark(database: ReadOnlyDatabase): JpOhlcvSourceWatermark {
  const row = database.prepare(`
    WITH relevant AS (
      SELECT id, status, started_at, finished_at
      FROM batch_runs
      WHERE job_type = 'ohlcv_fetch:jquants'
    ), latest AS (
      SELECT id, status, started_at, finished_at
      FROM relevant
      ORDER BY id DESC
      LIMIT 1
    )
    SELECT
      COALESCE((SELECT id FROM latest), 0) AS latestRunId,
      COALESCE((SELECT MAX(id) FROM relevant WHERE status IN ('success', 'partial')), 0) AS latestPublishableRunId,
      (SELECT COUNT(*) FROM relevant WHERE status = 'running') AS runningCount,
      (SELECT status FROM latest) AS latestStatus,
      (SELECT started_at FROM latest) AS latestStartedAt,
      (SELECT finished_at FROM latest) AS latestFinishedAt
  `).get() ?? {}
  return {
    latestRunId: Number(row.latestRunId ?? 0),
    latestPublishableRunId: Number(row.latestPublishableRunId ?? 0),
    runningCount: Number(row.runningCount ?? 0),
    latestStatus: textOrNull(row.latestStatus),
    latestStartedAt: numberOrNull(row.latestStartedAt),
    latestFinishedAt: numberOrNull(row.latestFinishedAt),
  }
}

function aggregate(database: ReadOnlyDatabase, sql: string): Record<string, unknown> {
  return database.prepare(sql).get() ?? {}
}

function servingWatermark(database: ReadOnlyDatabase): JpOhlcvServingWatermark {
  let snapshots: Record<string, unknown>
  let screening: Record<string, unknown>
  let dashboard: Record<string, unknown>
  try {
    snapshots = aggregate(database, `
      SELECT COUNT(*) AS rows, MAX(date) AS latestDate, MAX(computed_at) AS latestComputedAt
      FROM daily_snapshots
    `)
    screening = aggregate(database, `
      SELECT COUNT(*) AS rows, MAX(as_of) AS latestAsOf, MAX(calculated_at) AS latestCalculatedAt
      FROM stock_screening_serving_dates
    `)
    dashboard = aggregate(database, `
      SELECT COUNT(*) AS rows, MAX(date) AS latestDate, MAX(computed_at) AS latestComputedAt
      FROM dashboard_cache
    `)
  } catch {
    throw new Error('repair_runtime_snapshot_serving_watermark_unavailable')
  }
  return {
    dailySnapshots: {
      rows: Number(snapshots.rows ?? 0),
      latestDate: textOrNull(snapshots.latestDate),
      latestComputedAt: numberOrNull(snapshots.latestComputedAt),
    },
    screening: {
      rows: Number(screening.rows ?? 0),
      latestAsOf: textOrNull(screening.latestAsOf),
      latestCalculatedAt: numberOrNull(screening.latestCalculatedAt),
    },
    dashboard: {
      rows: Number(dashboard.rows ?? 0),
      latestDate: textOrNull(dashboard.latestDate),
      latestComputedAt: numberOrNull(dashboard.latestComputedAt),
    },
  }
}

export function captureJpOhlcvRuntimeSnapshot(input: {
  databasePath: string
  configurationSha256: string
  approvalScope: JpOhlcvMissingOnlyRepairScope
  officialRows: readonly JpOfficialOhlcvValue[]
  officialSourceProof: JpOhlcvOfficialSourceProof
  now?: Date
}): JpOhlcvRuntimeSnapshot {
  const now = input.now ?? new Date()
  const database = new DatabaseSync(input.databasePath, { readOnly: true })
  try {
    const runtimeScope = buildJpOhlcvRuntimeRepairScope({
      approvalScope: input.approvalScope,
      officialRows: input.officialRows,
      existingRows: rowsForDate(database, input.approvalScope.date),
    })
    const source = sourceWatermark(database)
    const serving = servingWatermark(database)
    const body = {
      version: 1 as const,
      capturedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + JP_OHLCV_RUNTIME_SNAPSHOT_TTL_MS).toISOString(),
      configurationSha256: input.configurationSha256,
      officialSha256: input.approvalScope.officialSha256,
      approvedRepairKeysSha256: runtimeScope.approvedRepairKeysSha256,
      officialRows: input.officialRows.length,
      officialSourceProof: input.officialSourceProof,
      officialSourceProofSha256: stableSha256(input.officialSourceProof),
      runtimeScope,
      sourceWatermark: source,
      sourceWatermarkSha256: stableSha256(source),
      servingWatermark: serving,
      servingWatermarkSha256: stableSha256(serving),
    }
    return { ...body, snapshotSha256: stableSha256(body) }
  } finally {
    database.close()
  }
}

export function assertJpOhlcvRuntimeSnapshot(input: {
  snapshot: JpOhlcvRuntimeSnapshot
  expectedSha256?: string
  now?: Date
  stage?: string
}): void {
  const snapshot = input.snapshot
  const { snapshotSha256: _stored, ...body } = snapshot
  if (snapshot.version !== 1 || stableSha256(body) !== snapshot.snapshotSha256) {
    throw new Error('repair_runtime_snapshot_hash_mismatch')
  }
  if (input.expectedSha256 && input.expectedSha256 !== snapshot.snapshotSha256) {
    throw new Error('repair_runtime_snapshot_approval_hash_mismatch')
  }
  const now = (input.now ?? new Date()).getTime()
  const captured = Date.parse(snapshot.capturedAt)
  const expires = Date.parse(snapshot.expiresAt)
  if (!Number.isFinite(captured) || !Number.isFinite(expires)
    || expires - captured !== JP_OHLCV_RUNTIME_SNAPSHOT_TTL_MS
    || now < captured) {
    throw new Error(`repair_runtime_snapshot_invalid:${input.stage ?? 'unspecified'}`)
  }
  if (now > expires) {
    throw new Error(`repair_runtime_snapshot_expired:${input.stage ?? 'unspecified'}`)
  }
  if (snapshot.runtimeScope.status !== 'READY') {
    throw new Error(`repair_runtime_snapshot_scope_hold:${JSON.stringify(summarizeJpOhlcvRuntimeScopeHold(snapshot.runtimeScope))}`)
  }
  const proofRequested = Date.parse(snapshot.officialSourceProof.requestedAt)
  const proofCompleted = Date.parse(snapshot.officialSourceProof.completedAt)
  if (!Number.isFinite(proofRequested) || !Number.isFinite(proofCompleted)
    || proofRequested > proofCompleted || proofCompleted > captured
    || captured - proofCompleted > JP_OHLCV_RUNTIME_SNAPSHOT_TTL_MS
    || snapshot.officialSourceProof.providerRows !== snapshot.officialRows
    || snapshot.officialSourceProof.acceptedRows !== snapshot.officialRows
    || snapshot.officialSourceProof.rejectedRows !== 0
    || !/^[a-f0-9]{64}$/.test(snapshot.officialSourceProof.contentSha256)
    || snapshot.officialSourceProofSha256 !== stableSha256(snapshot.officialSourceProof)) {
    throw new Error('repair_runtime_snapshot_official_source_proof_invalid')
  }
  if (snapshot.sourceWatermark.latestRunId <= 0
    || snapshot.sourceWatermark.latestPublishableRunId !== snapshot.sourceWatermark.latestRunId
    || snapshot.sourceWatermark.runningCount !== 0
    || !['success', 'partial'].includes(snapshot.sourceWatermark.latestStatus ?? '')) {
    throw new Error('repair_runtime_snapshot_source_generation_not_publishable')
  }
}

export function assertJpOhlcvRuntimeSnapshotUnchanged(input: {
  sealed: JpOhlcvRuntimeSnapshot
  current: JpOhlcvRuntimeSnapshot
  stage?: string
}): void {
  assertJpOhlcvRuntimeSnapshot({ snapshot: input.sealed, stage: input.stage })
  assertJpOhlcvRuntimeSnapshot({ snapshot: input.current, stage: input.stage })
  if (input.sealed.configurationSha256 !== input.current.configurationSha256
    || input.sealed.officialSha256 !== input.current.officialSha256
    || input.sealed.officialSourceProofSha256 !== input.current.officialSourceProofSha256
    || input.sealed.approvedRepairKeysSha256 !== input.current.approvedRepairKeysSha256
    || input.sealed.runtimeScope.runtimeExistingSha256 !== input.current.runtimeScope.runtimeExistingSha256
    || input.sealed.sourceWatermarkSha256 !== input.current.sourceWatermarkSha256
    || input.sealed.servingWatermarkSha256 !== input.current.servingWatermarkSha256) {
    throw new Error('repair_runtime_snapshot_changed_after_writer_hold')
  }
}
