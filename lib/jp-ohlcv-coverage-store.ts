import type { Client, Transaction } from '@libsql/client'
import {
  assertJpOhlcvCoverageProjection,
  type JpOhlcvCoverageProjection,
} from '@/lib/jp-ohlcv-coverage-ledger'
import {
  assertJpOhlcvIngestionReceipt,
  type JpOhlcvIngestionReceipt,
} from '@/lib/jp-ohlcv-ingestion-receipt'
import { stableSha256 } from '@/lib/jp-ohlcv-data-quality'

export const JP_OHLCV_COVERAGE_SCOPE = 'JP_OHLCV_ADJUSTED_V1'

export type JpOhlcvCoverageHead = {
  scope: typeof JP_OHLCV_COVERAGE_SCOPE
  sourceRunId: number
  projectionSha256: string
  projection: JpOhlcvCoverageProjection
  receiptSha256: string
  receipt: JpOhlcvIngestionReceipt
  bindingSha256: string
}

function transitionBinding(input: {
  sourceRunId: number
  projectionSha256: string
  receiptSha256: string
}): string {
  return stableSha256({
    version: 1,
    scope: JP_OHLCV_COVERAGE_SCOPE,
    sourceRunId: input.sourceRunId,
    projectionSha256: input.projectionSha256,
    receiptSha256: input.receiptSha256,
  })
}

export async function initializeJpOhlcvCoverageStore(client: Client): Promise<void> {
  await client.execute('PRAGMA foreign_keys=ON')
  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS jp_ohlcv_ingestion_receipts (
      source_run_id INTEGER PRIMARY KEY,
      target_date TEXT NOT NULL,
      projection_sha256 TEXT NOT NULL UNIQUE,
      receipt_sha256 TEXT NOT NULL UNIQUE,
      binding_sha256 TEXT NOT NULL UNIQUE,
      receipt_json TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS jp_ohlcv_coverage_heads (
      scope TEXT PRIMARY KEY,
      source_run_id INTEGER NOT NULL UNIQUE,
      projection_sha256 TEXT NOT NULL UNIQUE,
      projection_json TEXT NOT NULL,
      receipt_sha256 TEXT NOT NULL UNIQUE,
      binding_sha256 TEXT NOT NULL UNIQUE,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY (receipt_sha256) REFERENCES jp_ohlcv_ingestion_receipts(receipt_sha256)
    );
    CREATE TRIGGER IF NOT EXISTS jp_ohlcv_ingestion_receipts_no_update
      BEFORE UPDATE ON jp_ohlcv_ingestion_receipts
      BEGIN SELECT RAISE(ABORT, 'jp_ohlcv_ingestion_receipt_immutable'); END;
    CREATE TRIGGER IF NOT EXISTS jp_ohlcv_ingestion_receipts_no_delete
      BEFORE DELETE ON jp_ohlcv_ingestion_receipts
      BEGIN SELECT RAISE(ABORT, 'jp_ohlcv_ingestion_receipt_immutable'); END;
  `)
  const columns = await client.execute('PRAGMA table_info(jp_ohlcv_ingestion_receipts)')
  const columnNames = new Set(columns.rows.map((row) => String(row.name)))
  for (const required of ['source_run_id', 'projection_sha256', 'receipt_sha256', 'binding_sha256', 'receipt_json']) {
    if (!columnNames.has(required)) throw new Error(`jp_ohlcv_coverage_store_schema_invalid:${required}`)
  }
  const headColumns = await client.execute('PRAGMA table_info(jp_ohlcv_coverage_heads)')
  const headColumnNames = new Set(headColumns.rows.map((row) => String(row.name)))
  for (const required of ['scope', 'source_run_id', 'projection_sha256', 'projection_json', 'receipt_sha256', 'binding_sha256']) {
    if (!headColumnNames.has(required)) throw new Error(`jp_ohlcv_coverage_store_schema_invalid:${required}`)
  }
  const triggers = await client.execute(
    `SELECT name, sql FROM sqlite_master WHERE type = 'trigger'
     AND name IN ('jp_ohlcv_ingestion_receipts_no_update', 'jp_ohlcv_ingestion_receipts_no_delete')`,
  )
  const triggerSql = new Map(triggers.rows.map((row) => [String(row.name), String(row.sql).toUpperCase()]))
  if (!triggerSql.get('jp_ohlcv_ingestion_receipts_no_update')?.includes('BEFORE UPDATE')
    || !triggerSql.get('jp_ohlcv_ingestion_receipts_no_update')?.includes("RAISE(ABORT, 'JP_OHLCV_INGESTION_RECEIPT_IMMUTABLE')")
    || !triggerSql.get('jp_ohlcv_ingestion_receipts_no_delete')?.includes('BEFORE DELETE')
    || !triggerSql.get('jp_ohlcv_ingestion_receipts_no_delete')?.includes("RAISE(ABORT, 'JP_OHLCV_INGESTION_RECEIPT_IMMUTABLE')")) {
    throw new Error('jp_ohlcv_coverage_store_schema_invalid:immutable_triggers')
  }
  const headForeignKeys = await client.execute('PRAGMA foreign_key_list(jp_ohlcv_coverage_heads)')
  if (!headForeignKeys.rows.some((row) => row.table === 'jp_ohlcv_ingestion_receipts'
    && row.from === 'receipt_sha256' && row.to === 'receipt_sha256')) {
    throw new Error('jp_ohlcv_coverage_store_schema_invalid:receipt_foreign_key')
  }
  const foreignKeys = await client.execute('PRAGMA foreign_keys')
  if (Number(foreignKeys.rows[0]?.foreign_keys) !== 1) {
    throw new Error('jp_ohlcv_coverage_store_schema_invalid:foreign_keys')
  }
}

export async function loadJpOhlcvCoverageHead(
  executor: Pick<Client, 'execute'>,
): Promise<JpOhlcvCoverageHead | null> {
  const result = await executor.execute({
    sql: `SELECT h.scope, h.source_run_id, h.projection_sha256, h.projection_json,
                 h.receipt_sha256, h.binding_sha256, r.target_date AS receipt_target_date,
                 r.receipt_json,
                 r.projection_sha256 AS receipt_projection_sha256,
                 r.binding_sha256 AS receipt_binding_sha256
          FROM jp_ohlcv_coverage_heads h
          LEFT JOIN jp_ohlcv_ingestion_receipts r
            ON r.source_run_id = h.source_run_id AND r.receipt_sha256 = h.receipt_sha256
          WHERE h.scope = ?`,
    args: [JP_OHLCV_COVERAGE_SCOPE],
  })
  const row = result.rows[0]
  if (!row) {
    const receipts = await executor.execute('SELECT COUNT(*) AS count FROM jp_ohlcv_ingestion_receipts')
    if (Number(receipts.rows[0]?.count) !== 0) throw new Error('jp_ohlcv_coverage_head_missing_with_receipts')
    return null
  }
  if (row.receipt_json === null || row.receipt_json === undefined) {
    throw new Error('jp_ohlcv_coverage_head_receipt_missing')
  }
  const projection = JSON.parse(String(row.projection_json)) as JpOhlcvCoverageProjection
  const receipt = JSON.parse(String(row.receipt_json)) as JpOhlcvIngestionReceipt
  assertJpOhlcvCoverageProjection(projection)
  assertJpOhlcvIngestionReceipt(receipt)
  const sourceRunId = Number(row.source_run_id)
  const projectionSha256 = String(row.projection_sha256)
  const receiptSha256 = String(row.receipt_sha256)
  const bindingSha256 = String(row.binding_sha256)
  const expectedBinding = transitionBinding({ sourceRunId, projectionSha256, receiptSha256 })
  if (row.scope !== JP_OHLCV_COVERAGE_SCOPE
    || !Number.isSafeInteger(sourceRunId)
    || sourceRunId !== projection.sourceRunId
    || projectionSha256 !== projection.projectionSha256
    || receiptSha256 !== receipt.receiptSha256
    || row.receipt_target_date !== projection.targetDate
    || receipt.targetDate !== projection.targetDate
    || receipt.officialSha256 !== projection.officialSha256
    || row.receipt_projection_sha256 !== projectionSha256
    || row.receipt_binding_sha256 !== bindingSha256
    || bindingSha256 !== expectedBinding) {
    throw new Error('jp_ohlcv_coverage_head_identity_invalid')
  }
  return {
    scope: JP_OHLCV_COVERAGE_SCOPE,
    sourceRunId,
    projectionSha256,
    projection,
    receiptSha256,
    receipt,
    bindingSha256,
  }
}

export type JpOhlcvCoverageTransitionInput = {
  sourceRunId: number
  expectedPreviousProjectionSha256: string | null
  projection: JpOhlcvCoverageProjection
  receipt: JpOhlcvIngestionReceipt
}

function assertTransitionContract(input: JpOhlcvCoverageTransitionInput): void {
  assertJpOhlcvCoverageProjection(input.projection)
  assertJpOhlcvIngestionReceipt(input.receipt)
  if (!Number.isSafeInteger(input.sourceRunId)
    || input.sourceRunId <= 0
    || input.projection.sourceRunId !== input.sourceRunId
    || input.projection.previousProjectionSha256 !== input.expectedPreviousProjectionSha256
    || input.projection.targetDate !== input.receipt.targetDate
    || input.projection.officialSha256 !== input.receipt.officialSha256
    || input.projection.publicationStatus === 'EVIDENCE_HOLD'
    || input.receipt.status === 'HOLD'
    || (input.projection.publicationStatus === 'PUBLISHABLE'
      && (input.receipt.status !== 'APPROVED_KEYS_SATISFIED'
        || input.receipt.dataQualityStatus !== 'NO_CONFLICTS'
        || input.receipt.remainingMissingKeys.length > 0))
    || (input.receipt.dataQualityStatus === 'UNRESOLVED_CONFLICTS_HOLD'
      && input.projection.openConflicts === 0)
    || (input.receipt.remainingMissingKeys.length > 0 && input.projection.openMissing === 0)) {
    throw new Error('jp_ohlcv_coverage_transition_contract_invalid')
  }
}

export async function persistJpOhlcvCoverageTransitionInTransaction(
  transaction: Transaction,
  input: JpOhlcvCoverageTransitionInput,
): Promise<JpOhlcvCoverageHead> {
  assertTransitionContract(input)
  const foreignKeys = await transaction.execute('PRAGMA foreign_keys')
  if (Number(foreignKeys.rows[0]?.foreign_keys) !== 1) {
    throw new Error('jp_ohlcv_coverage_foreign_keys_disabled')
  }
  const bindingSha256 = transitionBinding({
    sourceRunId: input.sourceRunId,
    projectionSha256: input.projection.projectionSha256,
    receiptSha256: input.receipt.receiptSha256,
  })
  const current = await transaction.execute({
    sql: 'SELECT projection_sha256, source_run_id FROM jp_ohlcv_coverage_heads WHERE scope = ?',
    args: [JP_OHLCV_COVERAGE_SCOPE],
  })
  const currentRow = current.rows[0]
  const actualPrevious = currentRow ? String(currentRow.projection_sha256) : null
  if (currentRow
    && Number(currentRow.source_run_id) === input.sourceRunId
    && actualPrevious === input.projection.projectionSha256) {
    const replay = await transaction.execute({
      sql: `SELECT receipt_sha256, binding_sha256 FROM jp_ohlcv_ingestion_receipts
            WHERE source_run_id = ? AND projection_sha256 = ?`,
      args: [input.sourceRunId, input.projection.projectionSha256],
    })
    if (replay.rows[0]?.receipt_sha256 === input.receipt.receiptSha256
      && replay.rows[0]?.binding_sha256 === bindingSha256) {
      return {
        scope: JP_OHLCV_COVERAGE_SCOPE,
        sourceRunId: input.sourceRunId,
        projectionSha256: input.projection.projectionSha256,
        projection: input.projection,
        receiptSha256: input.receipt.receiptSha256,
        receipt: input.receipt,
        bindingSha256,
      }
    }
    throw new Error('jp_ohlcv_coverage_replay_identity_mismatch')
  }
  if (actualPrevious !== input.expectedPreviousProjectionSha256) {
    throw new Error('jp_ohlcv_coverage_head_compare_and_swap_failed')
  }
  if (currentRow && Number(currentRow.source_run_id) >= input.sourceRunId) {
    throw new Error('jp_ohlcv_coverage_source_run_not_monotonic')
  }

  await transaction.execute({
    sql: `INSERT INTO jp_ohlcv_ingestion_receipts
          (source_run_id, target_date, projection_sha256, receipt_sha256, binding_sha256, receipt_json)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [
      input.sourceRunId,
      input.receipt.targetDate,
      input.projection.projectionSha256,
      input.receipt.receiptSha256,
      bindingSha256,
      JSON.stringify(input.receipt),
    ],
  })
  if (currentRow) {
    const updated = await transaction.execute({
      sql: `UPDATE jp_ohlcv_coverage_heads
            SET source_run_id = ?, projection_sha256 = ?, projection_json = ?,
                receipt_sha256 = ?, binding_sha256 = ?, updated_at = unixepoch()
            WHERE scope = ? AND projection_sha256 = ?`,
      args: [
        input.sourceRunId,
        input.projection.projectionSha256,
        JSON.stringify(input.projection),
        input.receipt.receiptSha256,
        bindingSha256,
        JP_OHLCV_COVERAGE_SCOPE,
        input.expectedPreviousProjectionSha256!,
      ],
    })
    if (updated.rowsAffected !== 1) throw new Error('jp_ohlcv_coverage_head_compare_and_swap_failed')
  } else {
    await transaction.execute({
      sql: `INSERT INTO jp_ohlcv_coverage_heads
            (scope, source_run_id, projection_sha256, projection_json, receipt_sha256, binding_sha256)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [
        JP_OHLCV_COVERAGE_SCOPE,
        input.sourceRunId,
        input.projection.projectionSha256,
        JSON.stringify(input.projection),
        input.receipt.receiptSha256,
        bindingSha256,
      ],
    })
  }
  const committed = await transaction.execute({
    sql: `SELECT h.projection_sha256, h.receipt_sha256, h.binding_sha256,
                 r.receipt_json FROM jp_ohlcv_coverage_heads h
          JOIN jp_ohlcv_ingestion_receipts r
            ON r.source_run_id = h.source_run_id AND r.receipt_sha256 = h.receipt_sha256
          WHERE h.scope = ?`,
    args: [JP_OHLCV_COVERAGE_SCOPE],
  })
  if (committed.rows[0]?.projection_sha256 !== input.projection.projectionSha256
    || committed.rows[0]?.receipt_sha256 !== input.receipt.receiptSha256
    || committed.rows[0]?.binding_sha256 !== bindingSha256) {
    throw new Error('jp_ohlcv_coverage_transition_commit_not_observed')
  }
  return {
    scope: JP_OHLCV_COVERAGE_SCOPE,
    sourceRunId: input.sourceRunId,
    projectionSha256: input.projection.projectionSha256,
    projection: input.projection,
    receiptSha256: input.receipt.receiptSha256,
    receipt: input.receipt,
    bindingSha256,
  }
}

export async function persistJpOhlcvCoverageTransition(
  client: Client,
  input: JpOhlcvCoverageTransitionInput,
): Promise<JpOhlcvCoverageHead> {
  assertTransitionContract(input)

  await client.execute('PRAGMA foreign_keys=ON')
  const transaction = await client.transaction('write')
  try {
    const head = await persistJpOhlcvCoverageTransitionInTransaction(transaction, input)
    await transaction.commit()
    return head
  } catch (error) {
    try { await transaction.rollback() } catch { /* preserve the original failure */ }
    throw error
  }
}
