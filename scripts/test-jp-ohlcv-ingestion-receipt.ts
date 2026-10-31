import assert from 'node:assert/strict'
import {
  assertJpOhlcvIngestionReceipt,
  buildJpOhlcvIngestionReceipt,
} from '@/lib/jp-ohlcv-ingestion-receipt'
import {
  buildJpOhlcvBackfillPlan,
  buildJpOhlcvMissingOnlyRepairScope,
  buildJpOhlcvRuntimeRepairScope,
  stableSha256,
  type JpOfficialOhlcvValue,
  type JpOhlcvValue,
} from '@/lib/jp-ohlcv-data-quality'

const targetDate = '2026-07-17'
const conflictTickers = ['1447', '2164']
const official: JpOfficialOhlcvValue[] = Array.from({ length: 4_218 }, (_, index) => {
  const ticker = String(1_000 + index).padStart(4, '0')
  const close = 100 + index
  return {
    ticker,
    date: targetDate,
    open: close - 1,
    high: close + 1,
    low: close - 2,
    close,
    volume: 10_000 + index,
    adjustmentFactor: 1,
  }
})
const officialByTicker = new Map(official.map((row) => [row.ticker, row]))
const exact = (row: JpOfficialOhlcvValue): JpOhlcvValue => {
  const { adjustmentFactor: _factor, ...value } = row
  return value
}
const exact149 = official.filter((row) => !conflictTickers.includes(row.ticker)).slice(0, 149).map(exact)
const conflicts = conflictTickers.map((ticker) => {
  const row = officialByTicker.get(ticker)!
  return { ...exact(row), close: row.close - 0.5 }
})
const initial151 = [...exact149, ...conflicts].sort((left, right) => left.ticker.localeCompare(right.ticker))
const approvalPlan = buildJpOhlcvBackfillPlan({
  date: targetDate,
  officialRows: official,
  existingRows: initial151,
})
const approvalScope = buildJpOhlcvMissingOnlyRepairScope({
  plan: approvalPlan,
  approvedConflictTickers: conflictTickers,
})
assert.equal(approvalScope.status, 'READY')
assert.equal(approvalScope.missingRows.length, 4_067)

const sixSatisfied = approvalScope.missingRows.slice(0, 6).map(exact)
const current157 = [...initial151, ...sixSatisfied].sort((left, right) => left.ticker.localeCompare(right.ticker))
const runtimeScope = buildJpOhlcvRuntimeRepairScope({
  approvalScope,
  officialRows: official,
  existingRows: current157,
})
assert.equal(runtimeScope.status, 'READY')
assert.equal(runtimeScope.missingRows.length, 4_061)
assert.equal(runtimeScope.alreadySatisfiedRows.length, 6)
const expectedApproval = {
  approvalPlanSha256: runtimeScope.approvalPlanSha256,
  approvedRepairKeysSha256: runtimeScope.approvedRepairKeysSha256,
}
type ReceiptInput = Parameters<typeof buildJpOhlcvIngestionReceipt>[0]
const buildReceipt = (input: Omit<ReceiptInput, 'expectedApproval'>) => (
  buildJpOhlcvIngestionReceipt({ ...input, expectedApproval })
)

const residual = runtimeScope.missingRows.map(exact)
const complete = buildReceipt({
  approvedScope: runtimeScope,
  officialRows: [...official].reverse(),
  beforeRows: [...current157].reverse(),
  afterRows: [...residual, ...current157].reverse(),
})
assert.equal(complete.status, 'APPROVED_KEYS_SATISFIED')
assert.equal(complete.dataQualityStatus, 'UNRESOLVED_CONFLICTS_HOLD')
assert.equal(complete.officialRows, 4_218)
assert.equal(complete.beforeRows, 157)
assert.equal(complete.afterRows, 4_218)
assert.equal(complete.approvedRows, 4_067)
assert.equal(complete.insertedKeys.length, 4_061)
assert.equal(complete.alreadySatisfiedKeys.length, 6)
assert.equal(complete.remainingMissingKeys.length, 0)
assert.deepEqual(complete.preservedConflictKeys, [`1447:${targetDate}`, `2164:${targetDate}`])
assert.equal(complete.reasons.length, 0)
assert.doesNotThrow(() => assertJpOhlcvIngestionReceipt(complete))

const reordered = buildReceipt({
  approvedScope: runtimeScope,
  officialRows: official,
  beforeRows: current157,
  afterRows: [...current157, ...residual],
})
assert.equal(reordered.receiptSha256, complete.receiptSha256)
const rowsWithUnrelatedMetadata = current157.map((row) => ({ ...row, updatedAt: 123 }))
const projected = buildReceipt({
  approvedScope: runtimeScope,
  officialRows: official,
  beforeRows: rowsWithUnrelatedMetadata,
  afterRows: [...rowsWithUnrelatedMetadata, ...residual],
})
assert.equal(projected.receiptSha256, complete.receiptSha256)

const partial = buildReceipt({
  approvedScope: runtimeScope,
  officialRows: official,
  beforeRows: current157,
  afterRows: [...current157, ...residual.slice(0, 4_000)],
})
assert.equal(partial.status, 'RESIDUAL_MISSING')
assert.equal(partial.insertedKeys.length, 4_000)
assert.equal(partial.remainingMissingKeys.length, 61)
assert.doesNotThrow(() => assertJpOhlcvIngestionReceipt(partial))

const changedConflict = current157.map((row) => row.ticker === '1447' ? { ...row, close: row.close + 1 } : row)
const conflictMutation = buildReceipt({
  approvedScope: runtimeScope,
  officialRows: official,
  beforeRows: current157,
  afterRows: [...changedConflict, ...residual],
})
assert.equal(conflictMutation.status, 'HOLD')
assert.ok(conflictMutation.reasons.includes(`existing_row_changed:1447:${targetDate}`))
assert.ok(conflictMutation.reasons.includes('after_conflict_set_mismatch'))
assert.doesNotThrow(() => assertJpOhlcvIngestionReceipt(conflictMutation))

const changedExact = current157.map((row, index) => index === 0 ? { ...row, close: row.close + 1 } : row)
const exactMutation = buildReceipt({
  approvedScope: runtimeScope,
  officialRows: official,
  beforeRows: current157,
  afterRows: [...changedExact, ...residual],
})
assert.equal(exactMutation.status, 'HOLD')
assert.ok(exactMutation.reasons.some((reason) => reason.startsWith('existing_row_changed:')))

const insertedWrongValue = residual.map((row) => row.ticker === residual[0].ticker
  ? { ...row, close: row.close + 1 }
  : row)
const mismatch = buildReceipt({
  approvedScope: runtimeScope,
  officialRows: official,
  beforeRows: current157,
  afterRows: [...current157, ...insertedWrongValue],
})
assert.equal(mismatch.status, 'HOLD')
assert.ok(mismatch.reasons.includes(`inserted_value_mismatch:${residual[0].ticker}:${targetDate}`))
assert.deepEqual(mismatch.invalidKeys, [`${residual[0].ticker}:${targetDate}`])
assert.doesNotThrow(() => assertJpOhlcvIngestionReceipt(mismatch))

const deleted = buildReceipt({
  approvedScope: runtimeScope,
  officialRows: official,
  beforeRows: current157,
  afterRows: [...current157.slice(1), ...residual],
})
assert.equal(deleted.status, 'HOLD')
assert.ok(deleted.reasons.some((reason) => reason.startsWith('existing_row_deleted:')))

const unknownRow: JpOhlcvValue = {
  ticker: '9999', date: targetDate, open: 1, high: 1, low: 1, close: 1, volume: 1,
}
const unknown = buildReceipt({
  approvedScope: runtimeScope,
  officialRows: official,
  beforeRows: current157,
  afterRows: [...current157, ...residual, unknownRow],
})
assert.equal(unknown.status, 'HOLD')
assert.ok(unknown.reasons.includes(`after_row_without_official:9999:${targetDate}`))

const baselineRow = current157.find((row) => !runtimeScope.alreadySatisfiedRows.some((approved) => (
  approved.ticker === row.ticker
)) && !conflictTickers.includes(row.ticker))!
const withoutBaselineRow = current157.filter((row) => row.ticker !== baselineRow.ticker)
const unapprovedInsertion = buildReceipt({
  approvedScope: runtimeScope,
  officialRows: official,
  beforeRows: withoutBaselineRow,
  afterRows: [...withoutBaselineRow, baselineRow, ...residual],
})
assert.equal(unapprovedInsertion.status, 'HOLD')
assert.ok(unapprovedInsertion.reasons.includes(`unapproved_inserted_key:${baselineRow.ticker}:${targetDate}`))

const duplicate = buildReceipt({
  approvedScope: runtimeScope,
  officialRows: official,
  beforeRows: current157,
  afterRows: [...current157, ...residual, residual[0]],
})
assert.equal(duplicate.status, 'HOLD')
assert.ok(duplicate.reasons.includes(`after_duplicate_key:${residual[0].ticker}:${targetDate}`))
assert.doesNotThrow(() => assertJpOhlcvIngestionReceipt(duplicate))

const emptyScope = {
  ...runtimeScope,
  status: 'HOLD' as const,
  officialSha256: '',
  missingRows: [],
  missingRowsSha256: '',
  alreadySatisfiedRows: [],
  alreadySatisfiedRowsSha256: '',
  approvedMissingRowsSha256: '',
  approvedRepairKeysSha256: '',
}
const empty = buildReceipt({
  approvedScope: emptyScope,
  officialRows: [],
  beforeRows: [],
  afterRows: [],
})
assert.equal(empty.status, 'HOLD')
assert.ok(empty.reasons.includes('official_rows_empty'))
assert.ok(empty.reasons.includes('approved_rows_empty'))
assert.throws(() => assertJpOhlcvIngestionReceipt(empty), /identity_invalid/)

const revisedOfficial = official.map((row, index) => index === 0 ? { ...row, close: row.close + 1 } : row)
const sourceMismatch = buildReceipt({
  approvedScope: runtimeScope,
  officialRows: revisedOfficial,
  beforeRows: current157,
  afterRows: [...current157, ...residual],
})
assert.equal(sourceMismatch.status, 'HOLD')
assert.ok(sourceMismatch.reasons.includes('official_source_hash_mismatch'))
assert.doesNotThrow(() => assertJpOhlcvIngestionReceipt(sourceMismatch))

const duplicateOfficial = buildReceipt({
  approvedScope: runtimeScope,
  officialRows: [...official, official[0]],
  beforeRows: current157,
  afterRows: [...current157, ...residual],
})
assert.equal(duplicateOfficial.status, 'HOLD')
assert.ok(duplicateOfficial.reasons.includes(`official_duplicate_key:${official[0].ticker}:${targetDate}`))
assert.doesNotThrow(() => assertJpOhlcvIngestionReceipt(duplicateOfficial))

const approvalMismatch = buildJpOhlcvIngestionReceipt({
  expectedApproval: { ...expectedApproval, approvalPlanSha256: 'f'.repeat(64) },
  approvedScope: runtimeScope,
  officialRows: official,
  beforeRows: current157,
  afterRows: [...current157, ...residual],
})
assert.equal(approvalMismatch.status, 'HOLD')
assert.ok(approvalMismatch.reasons.includes('approval_plan_hash_mismatch'))
assert.doesNotThrow(() => assertJpOhlcvIngestionReceipt(approvalMismatch))

const overlappingRow = runtimeScope.missingRows[0]
const overlappingScope = {
  ...runtimeScope,
  alreadySatisfiedRows: [...runtimeScope.alreadySatisfiedRows, overlappingRow],
}
overlappingScope.alreadySatisfiedRowsSha256 = stableSha256(overlappingScope.alreadySatisfiedRows)
overlappingScope.approvedMissingRowsSha256 = stableSha256([
  ...overlappingScope.missingRows,
  ...overlappingScope.alreadySatisfiedRows,
].sort((left, right) => left.ticker.localeCompare(right.ticker) || left.date.localeCompare(right.date)))
const overlap = buildJpOhlcvIngestionReceipt({
  expectedApproval,
  approvedScope: overlappingScope,
  officialRows: official,
  beforeRows: current157,
  afterRows: [...current157, ...residual],
})
assert.equal(overlap.status, 'HOLD')
assert.ok(overlap.reasons.includes('approved_scope_overlapping_key'))
assert.doesNotThrow(() => assertJpOhlcvIngestionReceipt(overlap))

const duplicateScope = { ...runtimeScope, missingRows: [...runtimeScope.missingRows, overlappingRow] }
duplicateScope.missingRowsSha256 = stableSha256(duplicateScope.missingRows)
duplicateScope.approvedMissingRowsSha256 = stableSha256([
  ...duplicateScope.missingRows,
  ...duplicateScope.alreadySatisfiedRows,
].sort((left, right) => left.ticker.localeCompare(right.ticker) || left.date.localeCompare(right.date)))
const duplicatedApproval = buildJpOhlcvIngestionReceipt({
  expectedApproval,
  approvedScope: duplicateScope,
  officialRows: official,
  beforeRows: current157,
  afterRows: [...current157, ...residual],
})
assert.equal(duplicatedApproval.status, 'HOLD')
assert.ok(duplicatedApproval.reasons.includes('approved_scope_duplicate_key'))
assert.doesNotThrow(() => assertJpOhlcvIngestionReceipt(duplicatedApproval))

const reseal = (patch: Partial<typeof complete>) => {
  const candidate = { ...complete, ...patch }
  const { receiptSha256: _old, ...body } = candidate
  return { ...body, receiptSha256: stableSha256(body) }
}
assert.throws(
  () => assertJpOhlcvIngestionReceipt({ ...complete, insertedKeys: null } as unknown as typeof complete),
  /shape_invalid/,
)
assert.throws(
  () => assertJpOhlcvIngestionReceipt(reseal({ insertedKeys: [...complete.insertedKeys, complete.insertedKeys[0]] })),
  /key_partition_invalid/,
)
assert.throws(
  () => assertJpOhlcvIngestionReceipt(reseal({
    insertedKeys: complete.insertedKeys.slice(1),
    invalidKeys: [complete.insertedKeys[0]],
  })),
  /invalid_keys_without_reason/,
)
assert.throws(
  () => assertJpOhlcvIngestionReceipt(reseal({ approvedRows: complete.approvedRows + 1 })),
  /approved_count_mismatch/,
)
assert.throws(
  () => assertJpOhlcvIngestionReceipt(reseal({ status: 'RESIDUAL_MISSING' })),
  /status_mismatch/,
)
assert.throws(
  () => assertJpOhlcvIngestionReceipt(reseal({ dataQualityStatus: 'NO_CONFLICTS' })),
  /data_quality_status_mismatch/,
)

const tampered = { ...complete, insertedKeys: complete.insertedKeys.slice(1) }
assert.throws(() => assertJpOhlcvIngestionReceipt(tampered), /hash_mismatch/)

console.log('JP OHLCV ingestion receipt tests: PASS')
