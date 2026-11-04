import { createHash } from 'node:crypto'
// @ts-expect-error Node 24 ships node:sqlite; the repository pins older Node type declarations.
import { DatabaseSync } from 'node:sqlite'
import {
  jpOhlcvKey,
  sameJpOhlcvRow,
  type JpOhlcvComparableRow,
} from '@/lib/jp-ohlcv-repair-policy'

export type JpOhlcvOfficialRow = JpOhlcvComparableRow & { adjustmentFactor: number }

export type JpOhlcvRepairPlan = {
  version: 1
  targetDate: string
  priceBasis: 'jquants-adjusted-ohlcv-v1'
  providerContentSha256: string
  officialRowsSha256: string
  officialRowCount: number
  approvedMissingKeys: string[]
  baselineRowsSha256: string
  preservedConflictKeys: string[]
  approvalSha256: string
}

export type JpOhlcvRepairResult = {
  approved: number
  alreadySatisfied: number
  inserted: number
  conflictsPreserved: number
  approvalSha256: string
  receiptId: number
}

export type JpOhlcvRepairMlCoverage = {
  expected: number
  actual: number
  missing: number
  extra: number
}

export function inspectJpOhlcvRepairMlCoverage(input: {
  db: DatabaseSync
  table: 'ml_feature_vectors' | 'ml_feature_vectors_v2'
  affectedTickers: readonly string[]
  startDate: string
  endDate: string
  computedAtEpoch: number
  minHistoryDays: number
  featureSet?: string
}): JpOhlcvRepairMlCoverage {
  if (input.table === 'ml_feature_vectors_v2' && !input.featureSet) {
    throw new Error('physics ML coverage requires a feature set')
  }
  const totals: JpOhlcvRepairMlCoverage = { expected: 0, actual: 0, missing: 0, extra: 0 }
  for (let offset = 0; offset < input.affectedTickers.length; offset += 300) {
    const chunk = input.affectedTickers.slice(offset, offset + 300)
    const placeholders = chunk.map(() => '?').join(',')
    const row = input.db.prepare(`
      WITH prior AS (
        SELECT ticker,COUNT(*) AS history_count FROM ohlcv_daily
        WHERE date < ? AND ticker IN (${placeholders})
        GROUP BY ticker
      ), scoped AS (
        SELECT current.ticker,current.date,
          COALESCE(prior.history_count,0)
            + ROW_NUMBER() OVER (PARTITION BY current.ticker ORDER BY current.date) AS history_count
        FROM ohlcv_daily current
        LEFT JOIN prior ON prior.ticker=current.ticker
        WHERE current.date BETWEEN ? AND ? AND current.ticker IN (${placeholders})
      ), expected AS (
        SELECT ticker,date FROM scoped WHERE history_count >= ?
      ), actual AS (
        SELECT ticker,date FROM ${input.table}
        WHERE date BETWEEN ? AND ? AND computed_at>=?
          ${input.featureSet ? 'AND feature_set=?' : ''}
          AND ticker IN (${placeholders})
      )
      SELECT
        (SELECT COUNT(*) FROM expected) AS expected,
        (SELECT COUNT(*) FROM actual) AS actual,
        (SELECT COUNT(*) FROM (SELECT ticker,date FROM expected EXCEPT SELECT ticker,date FROM actual)) AS missing,
        (SELECT COUNT(*) FROM (SELECT ticker,date FROM actual EXCEPT SELECT ticker,date FROM expected)) AS extra
    `).get(
      input.startDate,
      ...chunk,
      input.startDate,
      input.endDate,
      ...chunk,
      input.minHistoryDays,
      input.startDate,
      input.endDate,
      input.computedAtEpoch,
      ...(input.featureSet ? [input.featureSet] : []),
      ...chunk,
    ) as JpOhlcvRepairMlCoverage
    totals.expected += Number(row.expected)
    totals.actual += Number(row.actual)
    totals.missing += Number(row.missing)
    totals.extra += Number(row.extra)
  }
  return totals
}

export function completeJpOhlcvRepairDerived(input: {
  db: DatabaseSync
  receiptId: number
  approvalSha256: string
  publicationEvidenceSha256?: string
}): void {
  const { db, receiptId, approvalSha256, publicationEvidenceSha256 } = input
  db.exec('BEGIN IMMEDIATE')
  try {
    const receipt = db.prepare(`
      SELECT status,error_summary AS errorSummary
      FROM batch_runs WHERE id=? AND job_type='ohlcv_fetch:jquants'
    `).get(receiptId) as { status: string; errorSummary: string | null } | undefined
    if (!receipt) throw new Error('sealed repair receipt is missing')
    const evidence = JSON.parse(receipt.errorSummary ?? '{}') as {
      approvalSha256?: string
      phase?: string
      publicationEvidenceSha256?: string
    }
    if (evidence.approvalSha256 !== approvalSha256) {
      throw new Error('repair receipt approval hash mismatch')
    }
    if (receipt.status === 'success' && evidence.phase === 'derived_complete') {
      if (publicationEvidenceSha256
          && evidence.publicationEvidenceSha256 !== publicationEvidenceSha256) {
        throw new Error('repair receipt publication evidence hash mismatch')
      }
      db.exec('COMMIT')
      return
    }
    if (receipt.status !== 'partial' || evidence.phase !== 'derived_pending') {
      throw new Error(`repair receipt is not derived_pending: ${receipt.status}:${evidence.phase ?? 'unknown'}`)
    }
    const promoted = db.prepare(`
      UPDATE batch_runs
      SET status='success', finished_at=unixepoch(), error_summary=?
      WHERE id=? AND status='partial' AND error_summary=?
    `).run(
      JSON.stringify({
        approvalSha256,
        phase: 'derived_complete',
        ...(publicationEvidenceSha256 ? { publicationEvidenceSha256 } : {}),
      }),
      receiptId,
      receipt.errorSummary,
    )
    if (promoted.changes !== 1) throw new Error('repair receipt promotion lost its compare-and-set')
    db.exec('COMMIT')
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* preserve the original failure */ }
    throw error
  }
}

type Classification = {
  matching: JpOhlcvOfficialRow[]
  missing: JpOhlcvOfficialRow[]
  conflicts: Array<{ existing: JpOhlcvComparableRow; official: JpOhlcvOfficialRow }>
  existing: JpOhlcvComparableRow[]
}

type ApplyOptions = {
  db: DatabaseSync
  plan: JpOhlcvRepairPlan
  officialRows: JpOhlcvOfficialRow[]
  testOnlyAfterSourceInsert?: () => void
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, stable(child)]))
}

export function jpOhlcvValueSha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')
}

function sortedRows<T extends JpOhlcvComparableRow>(rows: readonly T[]): T[] {
  return [...rows].sort((left, right) => (
    left.ticker.localeCompare(right.ticker) || left.date.localeCompare(right.date)
  ))
}

function readTargetRows(db: DatabaseSync, targetDate: string): JpOhlcvComparableRow[] {
  return db.prepare(`
    SELECT ticker,date,open,high,low,close,volume
    FROM ohlcv_daily WHERE date=? ORDER BY ticker
  `).all(targetDate) as JpOhlcvComparableRow[]
}

function validateOfficialRows(targetDate: string, rows: readonly JpOhlcvOfficialRow[]): void {
  const keys = new Set<string>()
  for (const row of rows) {
    if (row.date !== targetDate) throw new Error(`official row date mismatch: ${jpOhlcvKey(row)}`)
    const key = jpOhlcvKey(row)
    if (keys.has(key)) throw new Error(`duplicate official row: ${key}`)
    keys.add(key)
  }
}

function classify(
  db: DatabaseSync,
  targetDate: string,
  officialRows: readonly JpOhlcvOfficialRow[],
): Classification {
  const existingRows = readTargetRows(db, targetDate)
  const existingByKey = new Map(existingRows.map((row) => [jpOhlcvKey(row), row]))
  const matching: JpOhlcvOfficialRow[] = []
  const missing: JpOhlcvOfficialRow[] = []
  const conflicts: Classification['conflicts'] = []
  for (const official of sortedRows(officialRows)) {
    const existing = existingByKey.get(jpOhlcvKey(official))
    if (!existing) missing.push(official)
    else if (sameJpOhlcvRow(existing, official)) matching.push(official)
    else conflicts.push({ existing, official })
  }
  return { matching, missing, conflicts, existing: existingRows }
}

function planBody(plan: JpOhlcvRepairPlan): Omit<JpOhlcvRepairPlan, 'approvalSha256'> {
  const { approvalSha256: _approvalSha256, ...body } = plan
  return body
}

export function createJpOhlcvRepairPlan(input: {
  db: DatabaseSync
  targetDate: string
  priceBasis: 'jquants-adjusted-ohlcv-v1'
  providerContentSha256: string
  officialRows: JpOhlcvOfficialRow[]
  preservedConflictKeys: string[]
}): JpOhlcvRepairPlan {
  validateOfficialRows(input.targetDate, input.officialRows)
  const classification = classify(input.db, input.targetDate, input.officialRows)
  const officialKeys = new Set(input.officialRows.map(jpOhlcvKey))
  const unexpectedExisting = classification.existing.filter((row) => !officialKeys.has(jpOhlcvKey(row)))
  if (unexpectedExisting.length > 0) {
    throw new Error(`existing rows absent from official envelope: ${unexpectedExisting.map(jpOhlcvKey).join(',')}`)
  }
  const conflictKeys = classification.conflicts.map(({ official }) => jpOhlcvKey(official)).sort()
  const expectedConflicts = [...input.preservedConflictKeys].sort()
  if (JSON.stringify(conflictKeys) !== JSON.stringify(expectedConflicts)) {
    throw new Error(`unexpected conflict set: ${conflictKeys.join(',')}`)
  }
  const body: Omit<JpOhlcvRepairPlan, 'approvalSha256'> = {
    version: 1,
    targetDate: input.targetDate,
    priceBasis: input.priceBasis,
    providerContentSha256: input.providerContentSha256,
    officialRowsSha256: jpOhlcvValueSha256(sortedRows(input.officialRows)),
    officialRowCount: input.officialRows.length,
    approvedMissingKeys: classification.missing.map(jpOhlcvKey).sort(),
    baselineRowsSha256: jpOhlcvValueSha256(sortedRows(classification.existing)),
    preservedConflictKeys: expectedConflicts,
  }
  return { ...body, approvalSha256: jpOhlcvValueSha256(body) }
}

function assertExecutionState(
  db: DatabaseSync,
  plan: JpOhlcvRepairPlan,
  officialRows: JpOhlcvOfficialRow[],
): { residual: JpOhlcvOfficialRow[]; alreadySatisfied: number; conflicts: number } {
  if (jpOhlcvValueSha256(planBody(plan)) !== plan.approvalSha256) {
    throw new Error('repair plan approval hash mismatch')
  }
  validateOfficialRows(plan.targetDate, officialRows)
  if (officialRows.length !== plan.officialRowCount) {
    throw new Error(`official row count changed: ${officialRows.length}`)
  }
  if (jpOhlcvValueSha256(sortedRows(officialRows)) !== plan.officialRowsSha256) {
    throw new Error('official row identity changed')
  }
  const classification = classify(db, plan.targetDate, officialRows)
  const conflictKeys = classification.conflicts.map(({ official }) => jpOhlcvKey(official)).sort()
  if (JSON.stringify(conflictKeys) !== JSON.stringify(plan.preservedConflictKeys)) {
    throw new Error(`unapproved conflict set: ${conflictKeys.join(',')}`)
  }

  const approved = new Set(plan.approvedMissingKeys)
  const currentBaselineRows = classification.existing.filter((row) => !approved.has(jpOhlcvKey(row)))
  if (jpOhlcvValueSha256(sortedRows(currentBaselineRows)) !== plan.baselineRowsSha256) {
    throw new Error('baseline target-date rows changed')
  }
  const residualKeys = classification.missing.map(jpOhlcvKey).sort()
  const unapprovedMissing = residualKeys.filter((key) => !approved.has(key))
  if (unapprovedMissing.length > 0) throw new Error(`unapproved missing rows: ${unapprovedMissing.join(',')}`)
  const alreadySatisfied = plan.approvedMissingKeys.length - residualKeys.length
  return { residual: classification.missing, alreadySatisfied, conflicts: classification.conflicts.length }
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
}

function reconcileRepairCoverage(db: DatabaseSync, plan: JpOhlcvRepairPlan): void {
  if (!tableExists(db, 'jquants_daily_coverage')
      || !tableExists(db, 'jquants_daily_coverage_issues')) {
    throw new Error('persistent JP OHLCV coverage tables are required')
  }
  db.prepare(`
    INSERT INTO jquants_daily_coverage(date,expected_rows,imported_at)
    VALUES(?,?,unixepoch())
    ON CONFLICT(date) DO UPDATE SET
      expected_rows=excluded.expected_rows, imported_at=excluded.imported_at
  `).run(plan.targetDate, plan.officialRowCount)
  db.prepare(`
    UPDATE jquants_daily_coverage_issues
    SET status='resolved', resolved_at=unixepoch()
    WHERE date=? AND kind='FETCH_FAILED' AND status='open'
  `).run(plan.targetDate)
  const resolveMissing = db.prepare(`
    UPDATE jquants_daily_coverage_issues
    SET status='resolved', resolved_at=unixepoch()
    WHERE date=? AND ticker=? AND kind='MISSING' AND status='open'
  `)
  for (const key of plan.approvedMissingKeys) {
    const [ticker, date] = key.split(':')
    if (!ticker || date !== plan.targetDate) throw new Error(`invalid approved missing key: ${key}`)
    resolveMissing.run(date, ticker)
  }
  const upsert = db.prepare(`
    INSERT INTO jquants_daily_coverage_issues(
      date,ticker,kind,status,detail,observed_at,resolved_at
    ) VALUES(?,?,'PROTECTED_CONFLICT','open',?,unixepoch(),NULL)
    ON CONFLICT(date,ticker,kind) DO UPDATE SET
      status='open', detail=excluded.detail, observed_at=excluded.observed_at, resolved_at=NULL
  `)
  for (const key of plan.preservedConflictKeys) {
    const [ticker, date] = key.split(':')
    if (!ticker || date !== plan.targetDate) throw new Error(`invalid preserved conflict key: ${key}`)
    upsert.run(date, ticker, 'existing row preserved; separate adjudication required')
  }
}

export function applyJpOhlcvRepairTransaction(options: ApplyOptions): JpOhlcvRepairResult {
  const { db, plan, officialRows } = options
  db.exec('BEGIN IMMEDIATE')
  try {
    if (!tableExists(db, 'batch_runs')) throw new Error('batch_runs receipt table is required')
    const execution = assertExecutionState(db, plan, officialRows)
    const jobType = 'ohlcv_fetch:jquants'
    if (execution.residual.length === 0) {
      const existingReceipt = db.prepare(`
        SELECT id,status FROM batch_runs
        WHERE job_type=? AND status IN ('partial','success') AND error_summary LIKE ?
        ORDER BY id DESC LIMIT 1
      `).get(jobType, `%${plan.approvalSha256}%`) as { id: number; status: string } | undefined
      if (existingReceipt) {
        reconcileRepairCoverage(db, plan)
        db.exec('COMMIT')
        return {
          approved: plan.approvedMissingKeys.length,
          alreadySatisfied: execution.alreadySatisfied,
          inserted: 0,
          conflictsPreserved: execution.conflicts,
          approvalSha256: plan.approvalSha256,
          receiptId: existingReceipt.id,
        }
      }
      throw new Error('approved rows exist without the sealed repair receipt')
    }
    if (execution.residual.length !== plan.approvedMissingKeys.length) {
      throw new Error('partial external insertion detected; re-approval is required')
    }
    const insert = db.prepare(`
      INSERT INTO ohlcv_daily(ticker,date,open,high,low,close,volume)
      VALUES(?,?,?,?,?,?,?)
    `)
    for (const row of execution.residual) {
      insert.run(row.ticker, row.date, row.open, row.high, row.low, row.close, row.volume)
    }
    options.testOnlyAfterSourceInsert?.()

    const verification = assertExecutionState(db, plan, officialRows)
    if (verification.residual.length !== 0) throw new Error('repair verification still has missing rows')
    reconcileRepairCoverage(db, plan)
    const receipt = db.prepare(`
      INSERT INTO batch_runs(
        job_type,started_at,finished_at,status,total_tickers,succeeded,failed,rows_inserted,error_summary
      ) VALUES(?,unixepoch(),unixepoch(),'partial',?,?,0,?,?)
    `).run(
      jobType,
      officialRows.length,
      officialRows.length,
      execution.residual.length,
      JSON.stringify({
        approvalSha256: plan.approvalSha256,
        phase: 'derived_pending',
        alreadySatisfied: execution.alreadySatisfied,
        conflictsPreserved: execution.conflicts,
      }),
    )
    db.exec('COMMIT')
    return {
      approved: plan.approvedMissingKeys.length,
      alreadySatisfied: execution.alreadySatisfied,
      inserted: execution.residual.length,
      conflictsPreserved: execution.conflicts,
      approvalSha256: plan.approvalSha256,
      receiptId: Number(receipt.lastInsertRowid),
    }
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* preserve the original failure */ }
    throw error
  }
}
