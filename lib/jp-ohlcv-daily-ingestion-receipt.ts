import {
  JP_OHLCV_PRICE_BASIS,
  buildJpOhlcvBackfillPlan,
  normalizeJpOhlcvTicker,
  sameJpOhlcvValue,
  sortJpOhlcvRows,
  stableSha256,
  type JpOfficialOhlcvValue,
  type JpOhlcvValue,
} from '@/lib/jp-ohlcv-data-quality'

export type JpOhlcvDailyIngestionReceipt = {
  version: 1
  receiptKind: 'DAILY_INGESTION'
  sourceRunId: number
  targetDate: string
  priceBasis: typeof JP_OHLCV_PRICE_BASIS
  missingCoverage: 'COMPLETE' | 'INCOMPLETE'
  dataQualityConflict: 'CLEAN' | 'KNOWN_CONFLICTS' | 'NEW_CONFLICTS'
  sourcePublication: 'PUBLISHABLE' | 'PARTIAL_HOLD' | 'HOLD'
  officialSha256: string
  beforeSha256: string
  afterSha256: string
  officialRows: number
  beforeRows: number
  afterRows: number
  insertedKeys: string[]
  alreadySatisfiedKeys: string[]
  remainingMissingKeys: string[]
  knownConflictKeys: string[]
  newConflictKeys: string[]
  reasons: string[]
  receiptSha256: string
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function rowKey(row: Pick<JpOhlcvValue, 'ticker' | 'date'>): string {
  return `${normalizeJpOhlcvTicker(row.ticker)}:${row.date}`
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

function sortedValues(rows: readonly JpOhlcvValue[]): JpOhlcvValue[] {
  return sortJpOhlcvRows(rows.map(projectValue))
}

function duplicates(rows: readonly JpOhlcvValue[]): string[] {
  const seen = new Set<string>()
  const duplicate = new Set<string>()
  for (const row of rows) {
    const key = rowKey(row)
    if (seen.has(key)) duplicate.add(key)
    seen.add(key)
  }
  return [...duplicate].sort(compareText)
}

export function buildJpOhlcvDailyIngestionReceipt(input: {
  sourceRunId: number
  targetDate: string
  officialRows: readonly JpOfficialOhlcvValue[]
  beforeRows: readonly JpOhlcvValue[]
  afterRows: readonly JpOhlcvValue[]
  approvedKnownConflictKeys: ReadonlySet<string>
  observedOpenConflictKeys?: ReadonlySet<string>
  observedOpenMissingKeys?: ReadonlySet<string>
}): JpOhlcvDailyIngestionReceipt {
  const official = sortJpOhlcvRows(input.officialRows)
  const before = sortedValues(input.beforeRows)
  const after = sortedValues(input.afterRows)
  const beforePlan = buildJpOhlcvBackfillPlan({
    date: input.targetDate,
    officialRows: official,
    existingRows: before,
  })
  const afterPlan = buildJpOhlcvBackfillPlan({
    date: input.targetDate,
    officialRows: official,
    existingRows: after,
  })
  const reasons = new Set<string>()
  if (!Number.isSafeInteger(input.sourceRunId) || input.sourceRunId <= 0) reasons.add('source_run_id_invalid')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.targetDate)) reasons.add('target_date_invalid')
  if (official.length === 0) reasons.add('official_rows_empty')
  if (official.some((row) => row.date !== input.targetDate)) reasons.add('official_target_date_mismatch')
  for (const key of duplicates(official)) reasons.add(`official_duplicate_key:${key}`)
  for (const key of duplicates(before)) reasons.add(`before_duplicate_key:${key}`)
  for (const key of duplicates(after)) reasons.add(`after_duplicate_key:${key}`)

  const officialByKey = new Map(official.map((row) => [rowKey(row), row]))
  const beforeByKey = new Map(before.map((row) => [rowKey(row), row]))
  const afterByKey = new Map(after.map((row) => [rowKey(row), row]))
  const insertedKeys: string[] = []
  const alreadySatisfiedKeys: string[] = []
  const remainingMissingKeys: string[] = []

  for (const [key, row] of beforeByKey) {
    const current = afterByKey.get(key)
    if (!current) reasons.add(`existing_row_deleted:${key}`)
    else if (!sameJpOhlcvValue(row, current)) reasons.add(`existing_row_changed:${key}`)
  }
  for (const [key, row] of afterByKey) {
    const officialRow = officialByKey.get(key)
    if (!officialRow) reasons.add(`after_row_without_official:${key}`)
    else if (!beforeByKey.has(key)) {
      if (sameJpOhlcvValue(row, officialRow)) insertedKeys.push(key)
      else reasons.add(`inserted_value_mismatch:${key}`)
    }
  }
  for (const [key, row] of officialByKey) {
    const previous = beforeByKey.get(key)
    const current = afterByKey.get(key)
    if (!current) remainingMissingKeys.push(key)
    else if (previous && sameJpOhlcvValue(previous, row) && sameJpOhlcvValue(current, row)) {
      alreadySatisfiedKeys.push(key)
    }
  }

  const knownConflictKeys = new Set<string>(input.observedOpenConflictKeys ?? [])
  const newConflictKeys: string[] = []
  for (const conflict of afterPlan.conflicts) {
    const key = `${normalizeJpOhlcvTicker(conflict.ticker)}:${conflict.date}`
    if (conflict.reason !== 'EXISTING_VALUE_CONFLICT') {
      reasons.add(`invalid_official_row:${key}:${conflict.reason}`)
      newConflictKeys.push(key)
    } else if (input.approvedKnownConflictKeys.has(key)) {
      knownConflictKeys.add(key)
    } else {
      reasons.add(`new_value_conflict:${key}`)
      newConflictKeys.push(key)
    }
  }
  for (const conflict of beforePlan.conflicts) {
    const key = `${normalizeJpOhlcvTicker(conflict.ticker)}:${conflict.date}`
    if (conflict.reason === 'EXISTING_VALUE_CONFLICT' && !input.approvedKnownConflictKeys.has(key)) {
      reasons.add(`unapproved_before_conflict:${key}`)
    }
  }

  const orderedReasons = [...reasons].sort(compareText)
  const orderedMissing = [...new Set([
    ...remainingMissingKeys,
    ...(input.observedOpenMissingKeys ?? []),
  ])].sort(compareText)
  const orderedKnownConflicts = [...knownConflictKeys].sort(compareText)
  const orderedNewConflicts = [...new Set(newConflictKeys)].sort(compareText)
  const missingCoverage = orderedMissing.length === 0 ? 'COMPLETE' as const : 'INCOMPLETE' as const
  const dataQualityConflict = orderedNewConflicts.length > 0
    ? 'NEW_CONFLICTS' as const
    : orderedKnownConflicts.length > 0 ? 'KNOWN_CONFLICTS' as const : 'CLEAN' as const
  const sourcePublication = orderedReasons.length > 0 || dataQualityConflict === 'NEW_CONFLICTS'
    ? 'HOLD' as const
    : missingCoverage === 'COMPLETE' && dataQualityConflict === 'CLEAN'
      ? 'PUBLISHABLE' as const
      : 'PARTIAL_HOLD' as const
  const body = {
    version: 1 as const,
    receiptKind: 'DAILY_INGESTION' as const,
    sourceRunId: input.sourceRunId,
    targetDate: input.targetDate,
    priceBasis: JP_OHLCV_PRICE_BASIS as typeof JP_OHLCV_PRICE_BASIS,
    missingCoverage,
    dataQualityConflict,
    sourcePublication,
    officialSha256: beforePlan.officialSha256,
    beforeSha256: beforePlan.existingSha256,
    afterSha256: afterPlan.existingSha256,
    officialRows: official.length,
    beforeRows: before.length,
    afterRows: after.length,
    insertedKeys: [...new Set(insertedKeys)].sort(compareText),
    alreadySatisfiedKeys: [...new Set(alreadySatisfiedKeys)].sort(compareText),
    remainingMissingKeys: orderedMissing,
    knownConflictKeys: orderedKnownConflicts,
    newConflictKeys: orderedNewConflicts,
    reasons: orderedReasons,
  }
  return { ...body, receiptSha256: stableSha256(body) }
}

export function assertJpOhlcvDailyIngestionReceipt(receipt: JpOhlcvDailyIngestionReceipt): void {
  if (!receipt || receipt.receiptKind !== 'DAILY_INGESTION'
    || !Array.isArray(receipt.insertedKeys)
    || !Array.isArray(receipt.alreadySatisfiedKeys)
    || !Array.isArray(receipt.remainingMissingKeys)
    || !Array.isArray(receipt.knownConflictKeys)
    || !Array.isArray(receipt.newConflictKeys)
    || !Array.isArray(receipt.reasons)) {
    throw new Error('jp_ohlcv_daily_ingestion_receipt_shape_invalid')
  }
  const { receiptSha256, ...body } = receipt
  if (stableSha256(body) !== receiptSha256) throw new Error('jp_ohlcv_daily_ingestion_receipt_hash_mismatch')
  const lists = [
    receipt.insertedKeys,
    receipt.alreadySatisfiedKeys,
    receipt.remainingMissingKeys,
    receipt.knownConflictKeys,
    receipt.newConflictKeys,
  ]
  const keyPattern = /^[0-9A-Z]{4,5}:\d{4}-\d{2}-\d{2}$/
  if (lists.some((keys) => JSON.stringify(keys) !== JSON.stringify([...new Set(keys)].sort(compareText)))
    || lists.flat().some((key) => !keyPattern.test(key))
    || [receipt.insertedKeys, receipt.alreadySatisfiedKeys]
      .flat().some((key) => !key.endsWith(`:${receipt.targetDate}`))) {
    throw new Error('jp_ohlcv_daily_ingestion_receipt_key_invalid')
  }
  const targetMissingCount = receipt.remainingMissingKeys
    .filter((key) => key.endsWith(`:${receipt.targetDate}`)).length
  const rowPartitions = [
    receipt.insertedKeys,
    receipt.alreadySatisfiedKeys,
    receipt.remainingMissingKeys.filter((key) => key.endsWith(`:${receipt.targetDate}`)),
  ].flat()
  const targetConflictCount = [...receipt.knownConflictKeys, ...receipt.newConflictKeys]
    .filter((key) => key.endsWith(`:${receipt.targetDate}`)).length
  if (new Set(rowPartitions).size !== rowPartitions.length
    || receipt.insertedKeys.length + receipt.alreadySatisfiedKeys.length
      + targetMissingCount + targetConflictCount !== receipt.officialRows) {
    throw new Error('jp_ohlcv_daily_ingestion_receipt_partition_invalid')
  }
  if (receipt.version !== 1
    || receipt.priceBasis !== JP_OHLCV_PRICE_BASIS
    || !Number.isSafeInteger(receipt.sourceRunId)
    || receipt.sourceRunId <= 0
    || ![receipt.officialSha256, receipt.beforeSha256, receipt.afterSha256, receipt.receiptSha256]
      .every((hash) => /^[a-f0-9]{64}$/.test(hash))) {
    throw new Error('jp_ohlcv_daily_ingestion_receipt_identity_invalid')
  }
  const expectedMissing = receipt.remainingMissingKeys.length === 0 ? 'COMPLETE' : 'INCOMPLETE'
  const expectedConflict = receipt.newConflictKeys.length > 0
    ? 'NEW_CONFLICTS'
    : receipt.knownConflictKeys.length > 0 ? 'KNOWN_CONFLICTS' : 'CLEAN'
  const expectedPublication = receipt.reasons.length > 0 || expectedConflict === 'NEW_CONFLICTS'
    ? 'HOLD'
    : expectedMissing === 'COMPLETE' && expectedConflict === 'CLEAN' ? 'PUBLISHABLE' : 'PARTIAL_HOLD'
  if (receipt.missingCoverage !== expectedMissing
    || receipt.dataQualityConflict !== expectedConflict
    || receipt.sourcePublication !== expectedPublication) {
    throw new Error('jp_ohlcv_daily_ingestion_receipt_status_invalid')
  }
}
