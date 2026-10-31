import type { Client, Transaction } from '@libsql/client'
import {
  buildJpOhlcvBackfillPlan,
  buildJpOhlcvMissingOnlyRepairScope,
  buildJpOhlcvRuntimeRepairScope,
  normalizeJpOhlcvTicker,
  type JpOfficialOhlcvValue,
  type JpOhlcvValue,
} from '@/lib/jp-ohlcv-data-quality'
import {
  assertJpOhlcvWriteAllowedByIssue,
  reconcileJpOhlcvCoverageLedger,
  type JpOhlcvPriorIssueObservation,
} from '@/lib/jp-ohlcv-coverage-ledger'
import { buildJpOhlcvIngestionReceipt } from '@/lib/jp-ohlcv-ingestion-receipt'
import {
  loadJpOhlcvCoverageHead,
  persistJpOhlcvCoverageTransitionInTransaction,
} from '@/lib/jp-ohlcv-coverage-store'

function rowFromSql(row: Record<string, unknown>): JpOhlcvValue {
  return {
    ticker: normalizeJpOhlcvTicker(String(row.ticker)),
    date: String(row.date),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume),
  }
}

async function rowsForDate(transaction: Transaction, date: string): Promise<JpOhlcvValue[]> {
  const result = await transaction.execute({
    sql: `SELECT ticker, date, open, high, low, close, volume
          FROM ohlcv_daily WHERE date = ? ORDER BY ticker`,
    args: [date],
  })
  return result.rows.map((row) => rowFromSql(row as Record<string, unknown>))
}

async function observePriorIssues(
  transaction: Transaction,
  targetDate: string,
  issues: Array<{ date: string; ticker: string; status: string }>,
): Promise<JpOhlcvPriorIssueObservation[]> {
  const openOld = issues.filter((issue) => issue.status === 'OPEN' && issue.date !== targetDate)
  const rowsByKey = new Map<string, JpOhlcvValue>()
  for (const date of [...new Set(openOld.map((issue) => issue.date))]) {
    for (const row of await rowsForDate(transaction, date)) rowsByKey.set(`${row.ticker}:${row.date}`, row)
  }
  return openOld.map((issue) => ({
    date: issue.date,
    ticker: issue.ticker,
    existing: rowsByKey.get(`${issue.ticker}:${issue.date}`) ?? null,
  }))
}

function conflictKey(ticker: string, date: string): string {
  return `${date}:${normalizeJpOhlcvTicker(ticker)}:VALUE_CONFLICT`
}

async function insertMissingRows(
  transaction: Transaction,
  rows: readonly JpOfficialOhlcvValue[],
): Promise<void> {
  const chunkSize = 200
  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const chunk = rows.slice(offset, offset + chunkSize)
    const placeholders = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ')
    await transaction.execute({
      sql: `INSERT INTO ohlcv_daily (ticker, date, open, high, low, close, volume)
            VALUES ${placeholders}`,
      args: chunk.flatMap((row) => [row.ticker, row.date, row.open, row.high, row.low, row.close, row.volume]),
    })
  }
}

export async function applyJpOhlcvIngestionBoundary(client: Client, input: {
  sourceRunId: number
  targetDate: string
  officialRows: readonly JpOfficialOhlcvValue[]
  bootstrapPreservedConflictTickers?: readonly string[]
}): Promise<{
  inserted: number
  alreadySatisfied: number
  openMissing: number
  openConflicts: number
  publicationStatus: 'PUBLISHABLE' | 'PARTIAL_HOLD'
  projectionSha256: string
  receiptSha256: string
}> {
  await client.execute('PRAGMA foreign_keys=ON')
  const transaction = await client.transaction('write')
  try {
    const head = await loadJpOhlcvCoverageHead(transaction)
    const before = await rowsForDate(transaction, input.targetDate)
    const observations = await observePriorIssues(
      transaction,
      input.targetDate,
      head?.projection.issues ?? [],
    )
    const plan = buildJpOhlcvBackfillPlan({
      date: input.targetDate,
      officialRows: input.officialRows,
      existingRows: before,
    })
    const previousConflictKeys = new Set(
      (head?.projection.issues ?? [])
        .filter((issue) => issue.kind === 'VALUE_CONFLICT' && issue.status === 'OPEN')
        .map((issue) => conflictKey(issue.ticker, issue.date)),
    )
    const bootstrap = new Set((input.bootstrapPreservedConflictTickers ?? []).map(normalizeJpOhlcvTicker))
    if (head && bootstrap.size > 0) throw new Error('jp_ohlcv_bootstrap_conflicts_after_head')
    const conflictTickers: string[] = []
    for (const conflict of plan.conflicts) {
      if (conflict.reason !== 'EXISTING_VALUE_CONFLICT') {
        throw new Error(`jp_ohlcv_ingestion_input_invalid:${conflict.reason}`)
      }
      const protectedByHead = previousConflictKeys.has(conflictKey(conflict.ticker, conflict.date))
      const protectedByBootstrap = !head && bootstrap.has(normalizeJpOhlcvTicker(conflict.ticker))
      if (!protectedByHead && !protectedByBootstrap) {
        throw new Error(`jp_ohlcv_new_value_conflict:${conflict.ticker}:${conflict.date}`)
      }
      conflictTickers.push(conflict.ticker)
    }
    if (!head && [...bootstrap].some((ticker) => !conflictTickers.includes(ticker))) {
      throw new Error('jp_ohlcv_bootstrap_conflict_not_observed')
    }

    const preProjection = reconcileJpOhlcvCoverageLedger({
      sourceRunId: input.sourceRunId,
      targetDate: input.targetDate,
      officialRows: input.officialRows,
      existingRows: before,
      previousProjection: head?.projection ?? null,
      expectedPreviousProjectionSha256: head?.projectionSha256 ?? null,
      priorIssueObservations: observations,
    })
    if (preProjection.publicationStatus === 'EVIDENCE_HOLD') {
      throw new Error(`jp_ohlcv_ingestion_evidence_hold:${preProjection.reasons.join(',')}`)
    }
    const issuesByKey = new Map(preProjection.issues.map((issue) => [
      `${issue.date}:${issue.ticker}:${issue.kind}`,
      issue,
    ]))
    for (const row of plan.missingRows) {
      const issue = issuesByKey.get(`${row.date}:${row.ticker}:MISSING`)
      if (!issue) throw new Error(`jp_ohlcv_missing_issue_absent:${row.ticker}:${row.date}`)
      const { adjustmentFactor: _factor, ...incoming } = row
      assertJpOhlcvWriteAllowedByIssue({ issue, current: null, incoming })
    }

    await insertMissingRows(transaction, plan.missingRows)
    const after = await rowsForDate(transaction, input.targetDate)
    const approvalScope = buildJpOhlcvMissingOnlyRepairScope({
      plan,
      approvedConflictTickers: conflictTickers,
    })
    if (approvalScope.status !== 'READY') throw new Error('jp_ohlcv_ingestion_scope_hold')
    const runtimeScope = buildJpOhlcvRuntimeRepairScope({
      approvalScope,
      officialRows: input.officialRows,
      existingRows: before,
    })
    if (runtimeScope.status !== 'READY') throw new Error('jp_ohlcv_ingestion_runtime_scope_hold')
    const receipt = buildJpOhlcvIngestionReceipt({
      expectedApproval: {
        approvalPlanSha256: runtimeScope.approvalPlanSha256,
        approvedRepairKeysSha256: runtimeScope.approvedRepairKeysSha256,
      },
      approvedScope: runtimeScope,
      officialRows: input.officialRows,
      beforeRows: before,
      afterRows: after,
    })
    const projection = reconcileJpOhlcvCoverageLedger({
      sourceRunId: input.sourceRunId,
      targetDate: input.targetDate,
      officialRows: input.officialRows,
      existingRows: after,
      previousProjection: head?.projection ?? null,
      expectedPreviousProjectionSha256: head?.projectionSha256 ?? null,
      priorIssueObservations: observations,
    })
    if (projection.publicationStatus === 'EVIDENCE_HOLD' || receipt.status === 'HOLD') {
      throw new Error(`jp_ohlcv_ingestion_postwrite_hold:${projection.reasons.join(',')}:${receipt.reasons.join(',')}`)
    }
    const persisted = await persistJpOhlcvCoverageTransitionInTransaction(transaction, {
      sourceRunId: input.sourceRunId,
      expectedPreviousProjectionSha256: head?.projectionSha256 ?? null,
      projection,
      receipt,
    })
    await transaction.commit()
    return {
      inserted: receipt.insertedKeys.length,
      alreadySatisfied: receipt.alreadySatisfiedKeys.length,
      openMissing: projection.openMissing,
      openConflicts: projection.openConflicts,
      publicationStatus: projection.publicationStatus as 'PUBLISHABLE' | 'PARTIAL_HOLD',
      projectionSha256: persisted.projectionSha256,
      receiptSha256: persisted.receiptSha256,
    }
  } catch (error) {
    try { await transaction.rollback() } catch { /* preserve original failure */ }
    throw error
  }
}
