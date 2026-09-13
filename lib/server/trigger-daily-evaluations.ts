import { randomUUID } from 'node:crypto'
import type { Transaction } from '@libsql/client'
import { client, ensureReady, execAll, execGet, execRun } from '@/lib/db/client'
import {
  SavedTriggerNotFoundError,
  getSavedTriggerDefinitionForHistory,
  listSavedTriggerDefinitions,
} from '@/lib/server/saved-trigger-definitions'
import {
  TriggerEvaluationDefinitionChangedError,
  evaluateSavedTriggerDefinition,
  type TriggerEvaluationDefinitionIdentity,
} from '@/lib/server/trigger-evaluations'
import type { SavedTriggerDefinition, SavedTriggerViewConfig } from '@/lib/trigger-definition'
import type { TriggerEvaluationRunResponse } from '@/lib/trigger-evaluation'
import {
  TRIGGER_DAILY_EVALUATION_SOURCE,
  type TriggerDailyEvaluationResult,
  type TriggerEvaluationBatchItem,
  type TriggerEvaluationBatchItemStatus,
  type TriggerEvaluationBatchStatus,
  type TriggerEvaluationBatchSummary,
} from '@/lib/trigger-daily-evaluation'

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const DEFAULT_STALE_BATCH_SECONDS = 6 * 60 * 60

type BatchRow = {
  id: string
  source: typeof TRIGGER_DAILY_EVALUATION_SOURCE
  requested_as_of: string
  resolved_as_of: string
  started_at: number
  completed_at: number | null
  status: TriggerEvaluationBatchStatus
  owner_token: string | null
  heartbeat_at: number
  definition_count: number
  attempted_count: number
  completed_count: number
  reused_count: number
  failed_count: number
  skipped_count: number
  evaluation_count: number
  lifecycle_event_count: number
  duration_ms: number
  error_category: string | null
}

type BatchItemRow = {
  batch_id: string
  definition_id: string
  evaluation_version: number
  evaluation_config_signature: string
  engine_version: number
  score_version: number
  evaluation_id: string | null
  status: TriggerEvaluationBatchItemStatus
  lifecycle_event_count: number
  duration_ms: number
  error_category: string | null
}

type DefinitionIdentitySnapshot = TriggerEvaluationDefinitionIdentity & { id: string }

type DefinitionSnapshot = DefinitionIdentitySnapshot & {
  id: string
  name: string
  timeframe: SavedTriggerDefinition['evaluationConfig']['timeframe']
  viewConfig: SavedTriggerViewConfig
}

export class TriggerDailyEvaluationInProgressError extends Error {
  constructor(readonly resolvedAsOf: string) {
    super(`Trigger日次評価は${resolvedAsOf}について既に実行中です。`)
    this.name = 'TriggerDailyEvaluationInProgressError'
  }
}

export interface TriggerDailyEvaluationDependencies {
  now?: () => number
  resolveDataDate?: (requestedAsOf?: string) => Promise<string | null>
  listDefinitions?: () => Promise<SavedTriggerDefinition[]>
  getDefinitionForHistory?: typeof getSavedTriggerDefinitionForHistory
  evaluateDefinition?: (
    definitionId: string,
    requestedAsOf: string,
    expectedIdentity: TriggerEvaluationDefinitionIdentity,
  ) => Promise<TriggerEvaluationRunResponse>
  beforeDefinition?: (snapshot: DefinitionIdentitySnapshot, index: number) => Promise<void> | void
}

export interface RunDailyTriggerEvaluationsInput {
  requestedAsOf?: string
  resolvedAsOf?: string
  dryRun?: boolean
}

function nowSeconds(now: () => number): number {
  return Math.floor(now() / 1000)
}

function assertDate(value: string, label: string): void {
  const parsed = new Date(`${value}T00:00:00Z`)
  if (!DATE_PATTERN.test(value) || Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label}_must_use_yyyy_mm_dd`)
  }
}

function isoDateTime(epochSeconds: number | null): string | null {
  return epochSeconds == null ? null : new Date(Number(epochSeconds) * 1000).toISOString()
}

function batchSummary(row: BatchRow): TriggerEvaluationBatchSummary {
  return {
    id: row.id,
    source: row.source,
    requestedAsOf: row.requested_as_of,
    resolvedAsOf: row.resolved_as_of,
    startedAt: isoDateTime(row.started_at)!,
    completedAt: isoDateTime(row.completed_at),
    status: row.status,
    definitionCount: Number(row.definition_count),
    attemptedCount: Number(row.attempted_count),
    completedCount: Number(row.completed_count),
    reusedCount: Number(row.reused_count),
    failedCount: Number(row.failed_count),
    skippedCount: Number(row.skipped_count),
    evaluationCount: Number(row.evaluation_count),
    lifecycleEventCount: Number(row.lifecycle_event_count),
    durationMs: Number(row.duration_ms),
    errorCategory: row.error_category,
  }
}

function batchItem(row: BatchItemRow): TriggerEvaluationBatchItem {
  return {
    batchId: row.batch_id,
    definitionId: row.definition_id,
    evaluationVersion: Number(row.evaluation_version),
    evaluationConfigSignature: row.evaluation_config_signature,
    engineVersion: Number(row.engine_version),
    scoreVersion: Number(row.score_version),
    evaluationId: row.evaluation_id,
    status: row.status,
    lifecycleEventCount: Number(row.lifecycle_event_count),
    durationMs: Number(row.duration_ms),
    errorCategory: row.error_category,
  }
}

function snapshot(definition: SavedTriggerDefinition): DefinitionSnapshot {
  return {
    id: definition.id,
    name: definition.name,
    timeframe: definition.evaluationConfig.timeframe,
    viewConfig: definition.viewConfig,
    evaluationVersion: definition.evaluationVersion,
    evaluationConfigSignature: definition.evaluationSignature,
    engineVersion: definition.engineVersion,
    scoreVersion: definition.scoreVersion,
  }
}

function identityMatches(definition: SavedTriggerDefinition, expected: DefinitionIdentitySnapshot): boolean {
  return definition.archivedAt == null
    && definition.evaluationVersion === expected.evaluationVersion
    && definition.evaluationSignature === expected.evaluationConfigSignature
    && definition.engineVersion === expected.engineVersion
    && definition.scoreVersion === expected.scoreVersion
}

async function resolveDataDate(requestedAsOf?: string): Promise<string | null> {
  if (requestedAsOf) {
    assertDate(requestedAsOf, 'requested_as_of')
    const row = await execGet<{ date: string | null }>(
      'SELECT MAX(date) AS date FROM ohlcv_daily WHERE date <= ?',
      [requestedAsOf],
    )
    return row?.date ?? null
  }
  const row = await execGet<{ date: string | null }>('SELECT MAX(date) AS date FROM ohlcv_daily')
  return row?.date ?? null
}

async function assertUpstreamDataReady(resolvedAsOf: string): Promise<void> {
  const row = await execGet<{ snapshot_date: string | null; monthly_ma_date: string | null }>(`
    SELECT
      (SELECT MAX(date) FROM daily_snapshots WHERE date <= ?) AS snapshot_date,
      (SELECT MAX(date) FROM monthly_ma_monitor_daily WHERE date <= ?) AS monthly_ma_date
  `, [resolvedAsOf, resolvedAsOf])
  if (row?.snapshot_date !== resolvedAsOf) {
    throw new Error('trigger_daily_snapshot_not_ready')
  }
  if (row?.monthly_ma_date !== resolvedAsOf) {
    throw new Error('trigger_daily_monthly_ma_not_ready')
  }
}

async function txBatch(tx: Transaction, id: string): Promise<BatchRow | undefined> {
  const result = await tx.execute({ sql: 'SELECT * FROM trigger_evaluation_batches WHERE id=?', args: [id] })
  return result.rows[0] ? ({ ...result.rows[0] } as unknown as BatchRow) : undefined
}

async function txBatchByDate(tx: Transaction, resolvedAsOf: string): Promise<BatchRow | undefined> {
  const result = await tx.execute({
    sql: 'SELECT * FROM trigger_evaluation_batches WHERE source=? AND resolved_as_of=?',
    args: [TRIGGER_DAILY_EVALUATION_SOURCE, resolvedAsOf],
  })
  return result.rows[0] ? ({ ...result.rows[0] } as unknown as BatchRow) : undefined
}

async function insertBatchItems(
  tx: Transaction,
  batchId: string,
  definitions: DefinitionSnapshot[],
): Promise<void> {
  for (const definition of definitions) {
    await tx.execute({
      sql: `INSERT OR IGNORE INTO trigger_evaluation_batch_items (
        batch_id, definition_id, definition_name, view_config_json,
        evaluation_version, evaluation_config_signature, engine_version, score_version, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')`,
      args: [batchId, definition.id, definition.name, JSON.stringify(definition.viewConfig),
        definition.evaluationVersion,
        definition.evaluationConfigSignature, definition.engineVersion, definition.scoreVersion],
    })
  }
}

async function claimBatch(input: {
  requestedAsOf: string
  resolvedAsOf: string
  definitions: DefinitionSnapshot[]
  ownerToken: string
  now: () => number
}): Promise<{ row: BatchRow; reused: boolean }> {
  await ensureReady()
  const startedAt = nowSeconds(input.now)
  const staleSeconds = Math.max(60, Number(process.env.TRIGGER_DAILY_BATCH_STALE_SECONDS) || DEFAULT_STALE_BATCH_SECONDS)
  const batchId = randomUUID()
  const tx = await client.transaction('write')
  try {
    await tx.execute({
      sql: `INSERT OR IGNORE INTO trigger_evaluation_batches (
        id, source, requested_as_of, resolved_as_of, started_at, status,
        owner_token, heartbeat_at, definition_count, created_at
      ) VALUES (?, ?, ?, ?, ?, 'RUNNING', ?, ?, ?, ?)`,
      args: [batchId, TRIGGER_DAILY_EVALUATION_SOURCE, input.requestedAsOf,
        input.resolvedAsOf, startedAt, input.ownerToken, startedAt,
        input.definitions.length, startedAt],
    })
    let row = await txBatchByDate(tx, input.resolvedAsOf)
    if (!row) throw new Error('trigger_daily_batch_claim_failed')

    if (row.id === batchId) {
      await insertBatchItems(tx, row.id, input.definitions)
      await tx.commit()
      return { row, reused: false }
    }
    if (row.status === 'COMPLETED' || row.status === 'COMPLETED_WITH_ERRORS') {
      await tx.commit()
      return { row, reused: true }
    }

    const reclaimable = row.status === 'FAILED'
      || (row.status === 'RUNNING' && Number(row.heartbeat_at) <= startedAt - staleSeconds)
    if (!reclaimable) {
      await tx.commit()
      throw new TriggerDailyEvaluationInProgressError(input.resolvedAsOf)
    }
    await tx.execute({
      sql: `UPDATE trigger_evaluation_batches SET
        started_at=?, completed_at=NULL, status='RUNNING', owner_token=?, heartbeat_at=?,
        attempted_count=0, completed_count=0, reused_count=0, failed_count=0,
        skipped_count=0, evaluation_count=0, lifecycle_event_count=0,
        duration_ms=0, error_category=NULL
        WHERE id=? AND (status='FAILED' OR (status='RUNNING' AND heartbeat_at <= ?))`,
      args: [startedAt, input.ownerToken, startedAt, row.id, startedAt - staleSeconds],
    })
    row = await txBatch(tx, row.id)
    if (!row || row.owner_token !== input.ownerToken) {
      await tx.commit()
      throw new TriggerDailyEvaluationInProgressError(input.resolvedAsOf)
    }
    const itemCount = await tx.execute({
      sql: 'SELECT COUNT(*) AS count FROM trigger_evaluation_batch_items WHERE batch_id=?',
      args: [row.id],
    })
    if (Number(itemCount.rows[0]?.count ?? 0) === 0) {
      await insertBatchItems(tx, row.id, input.definitions)
      await tx.execute({
        sql: 'UPDATE trigger_evaluation_batches SET definition_count=? WHERE id=?',
        args: [input.definitions.length, row.id],
      })
    }
    await tx.commit()
    return { row, reused: false }
  } catch (error) {
    await tx.rollback().catch(() => undefined)
    throw error
  } finally {
    tx.close()
  }
}

async function loadBatchItems(batchId: string): Promise<TriggerEvaluationBatchItem[]> {
  const rows = await execAll<BatchItemRow>(
    'SELECT * FROM trigger_evaluation_batch_items WHERE batch_id=? ORDER BY definition_id',
    [batchId],
  )
  return rows.map(batchItem)
}

async function loadBatch(batchId: string): Promise<TriggerEvaluationBatchSummary> {
  const row = await execGet<BatchRow>('SELECT * FROM trigger_evaluation_batches WHERE id=?', [batchId])
  if (!row) throw new Error('trigger_daily_batch_not_found')
  return batchSummary(row)
}

async function updateItem(input: {
  batchId: string
  definitionId: string
  evaluationId?: string | null
  status: TriggerEvaluationBatchItemStatus
  lifecycleEventCount?: number
  durationMs: number
  errorCategory?: string | null
}): Promise<void> {
  await execRun(`UPDATE trigger_evaluation_batch_items SET
    evaluation_id=?, status=?, lifecycle_event_count=?, duration_ms=?,
    error_category=?, updated_at=unixepoch()
    WHERE batch_id=? AND definition_id=?`, [
    input.evaluationId ?? null,
    input.status,
    input.lifecycleEventCount ?? 0,
    input.durationMs,
    input.errorCategory ?? null,
    input.batchId,
    input.definitionId,
  ])
}

function operationalErrorCategory(error: unknown): string {
  if (error instanceof TriggerEvaluationDefinitionChangedError) return 'definition_changed'
  if (error instanceof SavedTriggerNotFoundError) return 'definition_not_found'
  const message = error instanceof Error ? error.message : String(error)
  if (/timeout/i.test(message)) return 'timeout'
  if (/SQLITE_BUSY|database is locked/i.test(message)) return 'database_busy'
  return 'evaluation_failed'
}

async function definitionState(
  expected: DefinitionIdentitySnapshot,
  getDefinition: typeof getSavedTriggerDefinitionForHistory,
): Promise<{ state: 'ACTIVE' | 'ARCHIVED' | 'CHANGED'; definition: SavedTriggerDefinition }> {
  const current = await getDefinition(expected.id)
  if (current.archivedAt != null) return { state: 'ARCHIVED', definition: current }
  return {
    state: identityMatches(current, expected) ? 'ACTIVE' : 'CHANGED',
    definition: current,
  }
}

async function completeBatch(batchId: string, ownerToken: string, startedAt: number): Promise<void> {
  const counts = await execGet<{
    definition_count: number
    attempted_count: number
    completed_count: number
    reused_count: number
    failed_count: number
    skipped_count: number
    evaluation_count: number
    lifecycle_event_count: number
  }>(`SELECT
      COUNT(*) AS definition_count,
      SUM(CASE WHEN status IN ('COMPLETED','REUSED','FAILED') THEN 1 ELSE 0 END) AS attempted_count,
      SUM(CASE WHEN status='COMPLETED' THEN 1 ELSE 0 END) AS completed_count,
      SUM(CASE WHEN status='REUSED' THEN 1 ELSE 0 END) AS reused_count,
      SUM(CASE WHEN status='FAILED' THEN 1 ELSE 0 END) AS failed_count,
      SUM(CASE WHEN status LIKE 'SKIPPED_%' THEN 1 ELSE 0 END) AS skipped_count,
      SUM(CASE WHEN status IN ('COMPLETED','REUSED') THEN 1 ELSE 0 END) AS evaluation_count,
      COALESCE(SUM(lifecycle_event_count), 0) AS lifecycle_event_count
    FROM trigger_evaluation_batch_items WHERE batch_id=?`, [batchId])
  const failedCount = Number(counts?.failed_count ?? 0)
  const status: TriggerEvaluationBatchStatus = failedCount > 0 ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED'
  await execRun(`UPDATE trigger_evaluation_batches SET
    completed_at=unixepoch(), status=?, owner_token=NULL, heartbeat_at=unixepoch(),
    definition_count=?, attempted_count=?, completed_count=?, reused_count=?,
    failed_count=?, skipped_count=?, evaluation_count=?, lifecycle_event_count=?,
    duration_ms=?, error_category=?
    WHERE id=? AND owner_token=? AND status='RUNNING'`, [
    status,
    Number(counts?.definition_count ?? 0),
    Number(counts?.attempted_count ?? 0),
    Number(counts?.completed_count ?? 0),
    Number(counts?.reused_count ?? 0),
    failedCount,
    Number(counts?.skipped_count ?? 0),
    Number(counts?.evaluation_count ?? 0),
    Number(counts?.lifecycle_event_count ?? 0),
    performance.now() - startedAt,
    failedCount > 0 ? 'definition_errors' : null,
    batchId,
    ownerToken,
  ])
}

async function failBatch(batchId: string, ownerToken: string, startedAt: number, error: unknown): Promise<void> {
  await execRun(`UPDATE trigger_evaluation_batches SET
    completed_at=unixepoch(), status='FAILED', owner_token=NULL, heartbeat_at=unixepoch(),
    duration_ms=?, error_category=?
    WHERE id=? AND owner_token=? AND status='RUNNING'`, [
    performance.now() - startedAt,
    operationalErrorCategory(error),
    batchId,
    ownerToken,
  ])
}

export async function runDailyTriggerEvaluations(
  input: RunDailyTriggerEvaluationsInput = {},
  dependencies: TriggerDailyEvaluationDependencies = {},
): Promise<TriggerDailyEvaluationResult> {
  const startedAt = performance.now()
  const now = dependencies.now ?? Date.now
  if (input.requestedAsOf) assertDate(input.requestedAsOf, 'requested_as_of')
  if (input.resolvedAsOf) assertDate(input.resolvedAsOf, 'resolved_as_of')
  const resolvedAsOf = input.resolvedAsOf
    ?? await (dependencies.resolveDataDate ?? resolveDataDate)(input.requestedAsOf)
  if (!resolvedAsOf) throw new Error('trigger_daily_data_date_unavailable')
  assertDate(resolvedAsOf, 'resolved_as_of')
  const requestedAsOf = input.requestedAsOf ?? resolvedAsOf
  if (resolvedAsOf > requestedAsOf) throw new Error('resolved_as_of_after_requested_as_of')
  // Tests may inject a synthetic resolver. Production/manual runs validate the
  // same Stage and monthly-MA dates that the post-OHLCV pipeline guarantees.
  if (!dependencies.resolveDataDate) await assertUpstreamDataReady(resolvedAsOf)

  const definitions = await (dependencies.listDefinitions ?? listSavedTriggerDefinitions)()
  const snapshots = definitions.map(snapshot)
  if (input.dryRun) {
    return {
      dryRun: true,
      reusedBatch: false,
      requestedAsOf,
      resolvedAsOf,
      batch: null,
      items: snapshots.map((item) => ({
        batchId: '', definitionId: item.id, evaluationVersion: item.evaluationVersion,
        evaluationConfigSignature: item.evaluationConfigSignature,
        engineVersion: item.engineVersion, scoreVersion: item.scoreVersion,
        evaluationId: null,
        status: 'PENDING',
        lifecycleEventCount: 0,
        durationMs: 0, errorCategory: null,
      })),
    }
  }

  const ownerToken = randomUUID()
  let batchId: string | null = null
  try {
    const claimed = await claimBatch({ requestedAsOf, resolvedAsOf, definitions: snapshots, ownerToken, now })
    batchId = claimed.row.id
    if (claimed.reused) {
      return {
        dryRun: false,
        reusedBatch: true,
        requestedAsOf: claimed.row.requested_as_of,
        resolvedAsOf: claimed.row.resolved_as_of,
        batch: batchSummary(claimed.row),
        items: await loadBatchItems(claimed.row.id),
      }
    }

    const storedItems = await loadBatchItems(batchId)
    const getDefinition = dependencies.getDefinitionForHistory ?? getSavedTriggerDefinitionForHistory
    const evaluate = dependencies.evaluateDefinition ?? ((definitionId, asOf, expectedIdentity) => (
      evaluateSavedTriggerDefinition(definitionId, asOf, { expectedDefinitionIdentity: expectedIdentity })
    ))
    for (const [index, item] of storedItems.entries()) {
      const expected: DefinitionIdentitySnapshot = {
        id: item.definitionId,
        evaluationVersion: item.evaluationVersion,
        evaluationConfigSignature: item.evaluationConfigSignature,
        engineVersion: item.engineVersion,
        scoreVersion: item.scoreVersion,
      }
      const itemStartedAt = performance.now()
      try {
        await dependencies.beforeDefinition?.(expected, index)
        const { state } = await definitionState(expected, getDefinition)
        if (state !== 'ACTIVE') {
          await updateItem({
            batchId, definitionId: item.definitionId,
            status: state === 'ARCHIVED' ? 'SKIPPED_ARCHIVED' : 'SKIPPED_CHANGED',
            durationMs: performance.now() - itemStartedAt,
            errorCategory: state === 'ARCHIVED' ? 'definition_archived' : 'definition_changed',
          })
          await execRun(
            `UPDATE trigger_evaluation_batches SET heartbeat_at=unixepoch()
             WHERE id=? AND owner_token=? AND status='RUNNING'`,
            [batchId, ownerToken],
          )
          continue
        }
        const result = await evaluate(item.definitionId, requestedAsOf, expected)
        if (result.evaluation.resolvedAsOf !== resolvedAsOf
          || result.evaluation.evaluationVersion !== expected.evaluationVersion
          || result.evaluation.evaluationConfigSignature !== expected.evaluationConfigSignature
          || result.evaluation.engineVersion !== expected.engineVersion
          || result.evaluation.scoreVersion !== expected.scoreVersion) {
          throw new TriggerEvaluationDefinitionChangedError()
        }
        await updateItem({
          batchId,
          definitionId: item.definitionId,
          evaluationId: result.evaluation.id,
          status: result.reused ? 'REUSED' : 'COMPLETED',
          lifecycleEventCount: result.lifecycle.eventCount,
          durationMs: performance.now() - itemStartedAt,
        })
      } catch (error) {
        let state: 'ACTIVE' | 'ARCHIVED' | 'CHANGED' = 'ACTIVE'
        if (error instanceof SavedTriggerNotFoundError || error instanceof TriggerEvaluationDefinitionChangedError) {
          state = await definitionState(expected, getDefinition).then((result) => result.state).catch(() => 'CHANGED')
        }
        await updateItem({
          batchId,
          definitionId: item.definitionId,
          status: state === 'ARCHIVED' ? 'SKIPPED_ARCHIVED'
            : state === 'CHANGED' ? 'SKIPPED_CHANGED' : 'FAILED',
          durationMs: performance.now() - itemStartedAt,
          errorCategory: state === 'ARCHIVED' ? 'definition_archived'
            : state === 'CHANGED' ? 'definition_changed' : operationalErrorCategory(error),
        })
      }
      await execRun(
        `UPDATE trigger_evaluation_batches SET heartbeat_at=unixepoch()
         WHERE id=? AND owner_token=? AND status='RUNNING'`,
        [batchId, ownerToken],
      )
    }
    await completeBatch(batchId, ownerToken, startedAt)
    return {
      dryRun: false,
      reusedBatch: false,
      requestedAsOf,
      resolvedAsOf,
      batch: await loadBatch(batchId),
      items: await loadBatchItems(batchId),
    }
  } catch (error) {
    if (batchId) await failBatch(batchId, ownerToken, startedAt, error).catch(() => undefined)
    throw error
  }
}
