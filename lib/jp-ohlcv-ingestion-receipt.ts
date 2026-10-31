import {
  JP_OHLCV_PRICE_BASIS,
  buildJpOhlcvBackfillPlan,
  jpOhlcvApprovedRepairKeysSha256,
  normalizeJpOhlcvTicker,
  sameJpOhlcvValue,
  sortJpOhlcvRows,
  stableSha256,
  type JpOfficialOhlcvValue,
  type JpOhlcvRuntimeRepairScope,
  type JpOhlcvValue,
} from '@/lib/jp-ohlcv-data-quality'

export type JpOhlcvIngestionReceipt = {
  version: 1
  targetDate: string
  priceBasis: typeof JP_OHLCV_PRICE_BASIS
  status: 'APPROVED_KEYS_SATISFIED' | 'RESIDUAL_MISSING' | 'HOLD'
  dataQualityStatus: 'NO_CONFLICTS' | 'UNRESOLVED_CONFLICTS_HOLD'
  approvalPlanSha256: string
  approvedRepairKeysSha256: string
  officialSha256: string
  beforeSha256: string
  afterSha256: string
  officialRows: number
  beforeRows: number
  afterRows: number
  approvedRows: number
  insertedKeys: string[]
  alreadySatisfiedKeys: string[]
  remainingMissingKeys: string[]
  invalidKeys: string[]
  preservedConflictKeys: string[]
  reasons: string[]
  receiptSha256: string
}

function rowKey(row: Pick<JpOhlcvValue, 'ticker' | 'date'>): string {
  return `${normalizeJpOhlcvTicker(row.ticker)}:${row.date}`
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function projectValue(row: JpOhlcvValue): JpOhlcvValue {
  return {
    ticker: normalizeJpOhlcvTicker(row.ticker),
    date: row.date,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
  }
}

function projectOfficial(row: JpOfficialOhlcvValue): JpOfficialOhlcvValue {
  return { ...projectValue(row), adjustmentFactor: row.adjustmentFactor }
}

function sortedValues<T extends JpOhlcvValue>(rows: readonly T[]): JpOhlcvValue[] {
  return sortJpOhlcvRows(rows.map(projectValue))
}

function sortedOfficial(rows: readonly JpOfficialOhlcvValue[]): JpOfficialOhlcvValue[] {
  return sortJpOhlcvRows(rows.map(projectOfficial))
}

function duplicateKeys(rows: readonly JpOhlcvValue[]): string[] {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const row of rows) {
    const key = rowKey(row)
    if (seen.has(key)) duplicates.add(key)
    seen.add(key)
  }
  return [...duplicates].sort(compareText)
}

export function buildJpOhlcvIngestionReceipt(input: {
  expectedApproval: {
    approvalPlanSha256: string
    approvedRepairKeysSha256: string
  }
  approvedScope: JpOhlcvRuntimeRepairScope
  officialRows: readonly JpOfficialOhlcvValue[]
  beforeRows: readonly JpOhlcvValue[]
  afterRows: readonly JpOhlcvValue[]
}): JpOhlcvIngestionReceipt {
  const scope = input.approvedScope
  const official = sortedOfficial(input.officialRows)
  const before = sortedValues(input.beforeRows)
  const after = sortedValues(input.afterRows)
  const reasons = new Set<string>()
  for (const key of duplicateKeys(official)) reasons.add(`official_duplicate_key:${key}`)
  for (const key of duplicateKeys(before)) reasons.add(`before_duplicate_key:${key}`)
  for (const key of duplicateKeys(after)) reasons.add(`after_duplicate_key:${key}`)
  if (official.length === 0) reasons.add('official_rows_empty')
  if (scope.version !== 1 || scope.runtimeKind !== 'BOUNDED_APPROVED_KEY_REVALIDATION') {
    reasons.add('approved_runtime_scope_contract_invalid')
  }
  if (scope.status !== 'READY') reasons.add('approved_runtime_scope_not_ready')
  if (scope.conflictDisposition !== 'PRESERVE_EXISTING_HOLD') {
    reasons.add('approved_conflict_disposition_invalid')
  }
  if (scope.date !== official[0]?.date || official.some((row) => row.date !== scope.date)) {
    reasons.add('official_target_date_mismatch')
  }
  if (!/^[a-f0-9]{64}$/.test(scope.approvalPlanSha256)
    || !/^[a-f0-9]{64}$/.test(scope.planSha256)) reasons.add('approval_plan_hash_invalid')
  if (scope.approvalPlanSha256 !== input.expectedApproval.approvalPlanSha256) {
    reasons.add('approval_plan_hash_mismatch')
  }
  if (scope.approvedRepairKeysSha256 !== input.expectedApproval.approvedRepairKeysSha256) {
    reasons.add('approved_repair_keys_approval_mismatch')
  }
  if (scope.approvedRepairKeysSha256 !== jpOhlcvApprovedRepairKeysSha256([
    ...scope.missingRows,
    ...scope.alreadySatisfiedRows,
  ])) {
    reasons.add('approved_repair_keys_hash_mismatch')
  }
  if (scope.missingRowsSha256 !== stableSha256(sortedOfficial(scope.missingRows))) {
    reasons.add('approved_missing_rows_hash_mismatch')
  }
  if (scope.alreadySatisfiedRowsSha256 !== stableSha256(sortedOfficial(scope.alreadySatisfiedRows))) {
    reasons.add('approved_already_satisfied_rows_hash_mismatch')
  }
  const missingScopeKeys = scope.missingRows.map(rowKey)
  const satisfiedScopeKeys = scope.alreadySatisfiedRows.map(rowKey)
  const missingScopeKeySet = new Set(missingScopeKeys)
  const duplicateApprovedKeys = new Set([
    ...duplicateKeys(scope.missingRows),
    ...duplicateKeys(scope.alreadySatisfiedRows),
  ])
  const overlappingApprovedKeys = new Set(
    satisfiedScopeKeys.filter((key) => missingScopeKeySet.has(key)),
  )
  const invalidApprovedScopeKeys = new Set([...duplicateApprovedKeys, ...overlappingApprovedKeys])
  if (duplicateApprovedKeys.size > 0) {
    reasons.add('approved_scope_duplicate_key')
  }
  if (overlappingApprovedKeys.size > 0) {
    reasons.add('approved_scope_overlapping_key')
  }
  const allApprovedRows = sortedOfficial([...scope.missingRows, ...scope.alreadySatisfiedRows])
  if (scope.approvedMissingRowsSha256 !== stableSha256(allApprovedRows)) {
    reasons.add('approved_original_missing_rows_hash_mismatch')
  }
  if (allApprovedRows.length === 0) reasons.add('approved_rows_empty')
  if (scope.preservedConflictsSha256 !== stableSha256(scope.preservedConflicts)) {
    reasons.add('approved_preserved_conflicts_hash_mismatch')
  }
  const beforePlan = buildJpOhlcvBackfillPlan({ date: scope.date, officialRows: official, existingRows: before })
  const afterPlan = buildJpOhlcvBackfillPlan({ date: scope.date, officialRows: official, existingRows: after })
  if (scope.officialSha256 !== beforePlan.officialSha256) reasons.add('official_source_hash_mismatch')
  if (scope.runtimeExistingSha256 !== beforePlan.existingSha256) reasons.add('before_rows_hash_mismatch')
  if (stableSha256(beforePlan.conflicts) !== scope.preservedConflictsSha256) {
    reasons.add('before_conflict_set_mismatch')
  }
  if (stableSha256(afterPlan.conflicts) !== scope.preservedConflictsSha256) {
    reasons.add('after_conflict_set_mismatch')
  }

  const beforeByKey = new Map(before.map((row) => [rowKey(row), row]))
  const afterByKey = new Map(after.map((row) => [rowKey(row), row]))
  const officialByKey = new Map(official.map((row) => [rowKey(row), row]))
  for (const [key, row] of beforeByKey) {
    const current = afterByKey.get(key)
    if (!current) reasons.add(`existing_row_deleted:${key}`)
    else if (!sameJpOhlcvValue(row, current)) reasons.add(`existing_row_changed:${key}`)
  }
  for (const key of afterByKey.keys()) {
    if (!officialByKey.has(key)) reasons.add(`after_row_without_official:${key}`)
  }

  const approvedMissingByKey = new Map(sortedOfficial(scope.missingRows).map((row) => [rowKey(row), row]))
  const approvedSatisfiedByKey = new Map(
    sortedOfficial(scope.alreadySatisfiedRows).map((row) => [rowKey(row), row]),
  )
  for (const key of afterByKey.keys()) {
    if (!beforeByKey.has(key) && !approvedMissingByKey.has(key)) {
      reasons.add(`unapproved_inserted_key:${key}`)
    }
  }
  const insertedKeys: string[] = []
  const alreadySatisfiedKeys: string[] = []
  const remainingMissingKeys: string[] = []
  const invalidKeys = new Set<string>()
  for (const [key, officialRow] of approvedMissingByKey) {
    if (invalidApprovedScopeKeys.has(key)) {
      invalidKeys.add(key)
      continue
    }
    const previous = beforeByKey.get(key)
    const current = afterByKey.get(key)
    if (previous) {
      reasons.add(`approved_missing_key_present_before:${key}`)
      invalidKeys.add(key)
    } else if (!current) {
      remainingMissingKeys.push(key)
    } else if (sameJpOhlcvValue(current, officialRow)) {
      insertedKeys.push(key)
    } else {
      reasons.add(`inserted_value_mismatch:${key}`)
      invalidKeys.add(key)
    }
  }
  for (const [key, officialRow] of approvedSatisfiedByKey) {
    if (invalidApprovedScopeKeys.has(key)) {
      invalidKeys.add(key)
      continue
    }
    const previous = beforeByKey.get(key)
    const current = afterByKey.get(key)
    const beforeValid = Boolean(previous && sameJpOhlcvValue(previous, officialRow))
    const afterValid = Boolean(current && sameJpOhlcvValue(current, officialRow))
    if (!beforeValid) {
      reasons.add(`approved_satisfied_key_invalid_before:${key}`)
      invalidKeys.add(key)
    }
    if (!afterValid) {
      reasons.add(`approved_satisfied_key_invalid_after:${key}`)
      invalidKeys.add(key)
    }
    if (beforeValid && afterValid) {
      alreadySatisfiedKeys.push(key)
    }
  }

  const preservedConflictKeys = scope.preservedConflicts.map(rowKey).sort(compareText)
  const orderedReasons = [...reasons].sort(compareText)
  const body = {
    version: 1 as const,
    targetDate: scope.date,
    priceBasis: JP_OHLCV_PRICE_BASIS as typeof JP_OHLCV_PRICE_BASIS,
    status: orderedReasons.length > 0
      ? 'HOLD' as const
      : remainingMissingKeys.length > 0
        ? 'RESIDUAL_MISSING' as const
        : 'APPROVED_KEYS_SATISFIED' as const,
    dataQualityStatus: preservedConflictKeys.length > 0
      ? 'UNRESOLVED_CONFLICTS_HOLD' as const
      : 'NO_CONFLICTS' as const,
    approvalPlanSha256: scope.approvalPlanSha256,
    approvedRepairKeysSha256: scope.approvedRepairKeysSha256,
    officialSha256: beforePlan.officialSha256,
    beforeSha256: beforePlan.existingSha256,
    afterSha256: afterPlan.existingSha256,
    officialRows: official.length,
    beforeRows: before.length,
    afterRows: after.length,
    approvedRows: new Set([...approvedMissingByKey.keys(), ...approvedSatisfiedByKey.keys()]).size,
    insertedKeys: insertedKeys.sort(compareText),
    alreadySatisfiedKeys: alreadySatisfiedKeys.sort(compareText),
    remainingMissingKeys: remainingMissingKeys.sort(compareText),
    invalidKeys: [...invalidKeys].sort(compareText),
    preservedConflictKeys,
    reasons: orderedReasons,
  }
  return { ...body, receiptSha256: stableSha256(body) }
}

export function assertJpOhlcvIngestionReceipt(receipt: JpOhlcvIngestionReceipt): void {
  if (!receipt || !Array.isArray(receipt.insertedKeys) || !Array.isArray(receipt.alreadySatisfiedKeys)
    || !Array.isArray(receipt.remainingMissingKeys) || !Array.isArray(receipt.invalidKeys)
    || !Array.isArray(receipt.preservedConflictKeys) || !Array.isArray(receipt.reasons)) {
    throw new Error('jp_ohlcv_ingestion_receipt_shape_invalid')
  }
  const { receiptSha256, ...body } = receipt
  if (stableSha256(body) !== receiptSha256) throw new Error('jp_ohlcv_ingestion_receipt_hash_mismatch')
  if (receipt.version !== 1 || receipt.priceBasis !== JP_OHLCV_PRICE_BASIS) {
    throw new Error('jp_ohlcv_ingestion_receipt_contract_mismatch')
  }
  const keyLists = [
    receipt.insertedKeys,
    receipt.alreadySatisfiedKeys,
    receipt.remainingMissingKeys,
    receipt.invalidKeys,
  ]
  const allKeys = keyLists.flat()
  const keyPattern = /^[0-9A-Z]{4,5}:\d{4}-\d{2}-\d{2}$/
  if (keyLists.some((keys) => JSON.stringify(keys) !== JSON.stringify([...new Set(keys)].sort(compareText)))
    || new Set(allKeys).size !== allKeys.length
    || [...allKeys, ...receipt.preservedConflictKeys].some((key) => (
      !keyPattern.test(key) || !key.endsWith(`:${receipt.targetDate}`)
    ))) {
    throw new Error('jp_ohlcv_ingestion_receipt_key_partition_invalid')
  }
  const hashes = [
    receipt.approvalPlanSha256,
    receipt.approvedRepairKeysSha256,
    receipt.officialSha256,
    receipt.beforeSha256,
    receipt.afterSha256,
    receipt.receiptSha256,
  ]
  if (hashes.some((hash) => !/^[a-f0-9]{64}$/.test(hash))) {
    throw new Error('jp_ohlcv_ingestion_receipt_identity_invalid')
  }
  if (receipt.invalidKeys.length > 0 && receipt.reasons.length === 0) {
    throw new Error('jp_ohlcv_ingestion_receipt_invalid_keys_without_reason')
  }
  if (receipt.approvedRows !== receipt.insertedKeys.length
    + receipt.alreadySatisfiedKeys.length + receipt.remainingMissingKeys.length + receipt.invalidKeys.length) {
    throw new Error('jp_ohlcv_ingestion_receipt_approved_count_mismatch')
  }
  const expectedStatus = receipt.reasons.length > 0
    ? 'HOLD'
    : receipt.remainingMissingKeys.length > 0
      ? 'RESIDUAL_MISSING'
      : 'APPROVED_KEYS_SATISFIED'
  if (receipt.status !== expectedStatus) throw new Error('jp_ohlcv_ingestion_receipt_status_mismatch')
  const expectedDataQuality = receipt.preservedConflictKeys.length > 0
    ? 'UNRESOLVED_CONFLICTS_HOLD'
    : 'NO_CONFLICTS'
  if (receipt.dataQualityStatus !== expectedDataQuality) {
    throw new Error('jp_ohlcv_ingestion_receipt_data_quality_status_mismatch')
  }
}
