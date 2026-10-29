import { createHash } from 'node:crypto'

export const JP_OHLCV_PRICE_BASIS = 'jquants-adjusted-ohlcv-v1'
export const JP_OHLCV_MIN_DAILY_COVERAGE_RATIO = 0.9

export type JpOhlcvValue = {
  ticker: string
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export type JpOfficialOhlcvValue = JpOhlcvValue & {
  adjustmentFactor: number
}

export type JpOhlcvConflict = {
  ticker: string
  date: string
  reason:
    | 'OFFICIAL_DUPLICATE_CONFLICT'
    | 'EXISTING_DUPLICATE_CONFLICT'
    | 'OFFICIAL_VALUE_INVALID'
    | 'EXISTING_VALUE_INVALID'
    | 'EXISTING_VALUE_CONFLICT'
    | 'EXISTING_WITHOUT_OFFICIAL'
  validationReason?: string
  existing?: JpOhlcvValue
  official?: JpOfficialOhlcvValue
}

export type JpOhlcvBackfillPlan = {
  version: 1
  date: string
  priceBasis: typeof JP_OHLCV_PRICE_BASIS
  status: 'READY' | 'HOLD'
  officialRows: number
  existingRows: number
  matchingRows: number
  missingRows: JpOfficialOhlcvValue[]
  conflicts: JpOhlcvConflict[]
  rollbackDeleteKeys: Array<{ ticker: string; date: string }>
  officialSha256: string
  existingSha256: string
  planSha256: string
}

export type JpOhlcvMissingOnlyRepairScope = {
  version: 1
  date: string
  status: 'READY' | 'HOLD'
  conflictDisposition: 'PRESERVE_EXISTING_HOLD'
  officialSha256: string
  planSha256: string
  missingRows: JpOfficialOhlcvValue[]
  missingRowsSha256: string
  preservedConflicts: JpOhlcvConflict[]
  preservedConflictsSha256: string
  reasons: string[]
}

export type JpOhlcvRuntimeRepairScope = JpOhlcvMissingOnlyRepairScope & {
  runtimeKind: 'BOUNDED_APPROVED_KEY_REVALIDATION'
  approvalPlanSha256: string
  approvedMissingRowsSha256: string
  approvedRepairKeysSha256: string
  alreadySatisfiedRows: JpOfficialOhlcvValue[]
  alreadySatisfiedRowsSha256: string
  runtimeExistingSha256: string
}

export type JpOhlcvRuntimeHoldSummary = {
  holdClass: 'SOURCE_REVISED' | 'PRICE_CONFLICT' | 'UNAPPROVED_DRIFT' | 'INVALID_APPROVAL' | 'UNKNOWN'
  reasonCount: number
  reasonCounts: Record<string, number>
  samples: Array<{
    reason: string
    key: string | null
    existing?: JpOhlcvValue
    official?: JpOfficialOhlcvValue
  }>
}

export type JpDailyCoverageEvaluation = {
  status: 'PASS' | 'HOLD'
  providerRows: number
  storedRows: number
  referenceRows: number[]
  expectedRows: number
  minimumRows: number
  ratio: number
  reasons: string[]
}

export type JpOhlcvConflictLineageAssessment = {
  classification: 'RETROACTIVE_ADJUSTED_SERIES_REVISION' | 'UNRESOLVED_VALUE_CONFLICT'
  disposition: 'PRESERVE_EXISTING_HOLD'
  volumeMatches: boolean
  laterCorporateActionObserved: boolean
  priceRevisionConsistent: boolean
  requiresFullHistoryRebase: boolean
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, canonicalize(child)]))
}

export function stableSha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex')
}

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0
}

function normalizeTicker(ticker: string): string {
  return ticker.trim().toUpperCase().replace(/\.T$/, '')
}

function normalizeValue<T extends JpOhlcvValue>(row: T): T {
  return { ...row, ticker: normalizeTicker(row.ticker) }
}

export function validateJpOhlcvValue(row: JpOhlcvValue): string[] {
  const errors: string[] = []
  if (!/^[0-9A-Z]{4,5}$/.test(normalizeTicker(row.ticker))) errors.push('ticker_invalid')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date)) errors.push('date_invalid')
  if (![row.open, row.high, row.low, row.close].every(finitePositive)) errors.push('price_invalid')
  if (finitePositive(row.high) && row.high < Math.max(row.open, row.low, row.close)) errors.push('high_invalid')
  if (finitePositive(row.low) && row.low > Math.min(row.open, row.high, row.close)) errors.push('low_invalid')
  if (!Number.isSafeInteger(row.volume) || row.volume < 0) errors.push('volume_invalid')
  return errors
}

export function sameJpOhlcvValue(left: JpOhlcvValue, right: JpOhlcvValue): boolean {
  const closeEnough = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-8, Math.abs(a) * 1e-10)
  return left.ticker === right.ticker
    && left.date === right.date
    && closeEnough(left.open, right.open)
    && closeEnough(left.high, right.high)
    && closeEnough(left.low, right.low)
    && closeEnough(left.close, right.close)
    && left.volume === right.volume
}

function sorted<T extends JpOhlcvValue>(rows: readonly T[]): T[] {
  return rows.map(normalizeValue).sort((left, right) => (
    left.ticker.localeCompare(right.ticker) || left.date.localeCompare(right.date)
  ))
}

function uniqueRows<T extends JpOhlcvValue>(
  rows: readonly T[],
  duplicateReason: JpOhlcvConflict['reason'],
): { rows: Map<string, T>; conflicts: JpOhlcvConflict[] } {
  const byKey = new Map<string, T>()
  const conflicts: JpOhlcvConflict[] = []
  for (const value of sorted(rows)) {
    const key = `${value.ticker}:${value.date}`
    const previous = byKey.get(key)
    if (!previous) {
      byKey.set(key, value)
      continue
    }
    if (!sameJpOhlcvValue(previous, value)) {
      conflicts.push({
        ticker: value.ticker,
        date: value.date,
        reason: duplicateReason,
        ...(duplicateReason === 'OFFICIAL_DUPLICATE_CONFLICT'
          ? { official: value as unknown as JpOfficialOhlcvValue }
          : { existing: value }),
      })
    }
  }
  return { rows: byKey, conflicts }
}

export function buildJpOhlcvBackfillPlan(input: {
  date: string
  officialRows: readonly JpOfficialOhlcvValue[]
  existingRows: readonly JpOhlcvValue[]
}): JpOhlcvBackfillPlan {
  const invalidOfficial = input.officialRows.flatMap((row) => {
    const errors = validateJpOhlcvValue(row)
    if (!Number.isFinite(row.adjustmentFactor) || row.adjustmentFactor <= 0) errors.push('adjustment_factor_invalid')
    if (row.date !== input.date) errors.push('target_date_mismatch')
    return errors.map((reason) => ({
      ticker: normalizeTicker(row.ticker),
      date: row.date,
      reason: 'OFFICIAL_VALUE_INVALID' as const,
      official: { ...normalizeValue(row), adjustmentFactor: row.adjustmentFactor },
      validationReason: reason,
    }))
  })
  const invalidExisting = input.existingRows.flatMap((row) => validateJpOhlcvValue(row).map((reason) => ({
    ticker: normalizeTicker(row.ticker),
    date: row.date,
    reason: 'EXISTING_VALUE_INVALID' as const,
    existing: normalizeValue(row),
    validationReason: reason,
  })))
  const official = uniqueRows(input.officialRows, 'OFFICIAL_DUPLICATE_CONFLICT')
  const existing = uniqueRows(input.existingRows, 'EXISTING_DUPLICATE_CONFLICT')
  const conflicts: JpOhlcvConflict[] = [
    ...official.conflicts,
    ...existing.conflicts,
    ...invalidOfficial,
    ...invalidExisting,
  ]
  const missingRows: JpOfficialOhlcvValue[] = []
  let matchingRows = 0

  for (const [key, officialRow] of official.rows) {
    const existingRow = existing.rows.get(key)
    if (!existingRow) {
      missingRows.push(officialRow)
    } else if (sameJpOhlcvValue(existingRow, officialRow)) {
      matchingRows += 1
    } else {
      conflicts.push({
        ticker: officialRow.ticker,
        date: officialRow.date,
        reason: 'EXISTING_VALUE_CONFLICT',
        existing: existingRow,
        official: officialRow,
      })
    }
  }
  for (const [key, existingRow] of existing.rows) {
    if (!official.rows.has(key)) {
      conflicts.push({
        ticker: existingRow.ticker,
        date: existingRow.date,
        reason: 'EXISTING_WITHOUT_OFFICIAL',
        existing: existingRow,
      })
    }
  }

  const officialRows = sorted([...official.rows.values()])
  const existingRows = sorted([...existing.rows.values()])
  const body = {
    version: 1 as const,
    date: input.date,
    priceBasis: JP_OHLCV_PRICE_BASIS as typeof JP_OHLCV_PRICE_BASIS,
    status: conflicts.length === 0 ? 'READY' as const : 'HOLD' as const,
    officialRows: officialRows.length,
    existingRows: existingRows.length,
    matchingRows,
    missingRows: sorted(missingRows),
    conflicts: conflicts.sort((left, right) => left.ticker.localeCompare(right.ticker) || left.reason.localeCompare(right.reason)),
    rollbackDeleteKeys: sorted(missingRows).map(({ ticker, date }) => ({ ticker, date })),
    officialSha256: stableSha256(officialRows),
    existingSha256: stableSha256(existingRows),
  }
  return { ...body, planSha256: stableSha256(body) }
}

export function buildJpOhlcvMissingOnlyRepairScope(input: {
  plan: JpOhlcvBackfillPlan
  approvedConflictTickers: readonly string[]
}): JpOhlcvMissingOnlyRepairScope {
  const approved = [...new Set(input.approvedConflictTickers.map(normalizeTicker))].sort()
  const conflicts = [...input.plan.conflicts].sort((left, right) => (
    left.ticker.localeCompare(right.ticker) || left.reason.localeCompare(right.reason)
  ))
  const conflictTickers = [...new Set(conflicts.map((conflict) => normalizeTicker(conflict.ticker)))].sort()
  const reasons: string[] = []
  if (input.plan.missingRows.length === 0) reasons.push('missing_rows_empty')
  if (conflicts.some((conflict) => conflict.reason !== 'EXISTING_VALUE_CONFLICT')) {
    reasons.push('unsupported_conflict_kind')
  }
  if (JSON.stringify(conflictTickers) !== JSON.stringify(approved)) {
    reasons.push('approved_conflict_set_mismatch')
  }
  if (conflicts.some((conflict) => !conflict.existing || !conflict.official)) {
    reasons.push('conflict_evidence_incomplete')
  }
  const missingRows = sorted(input.plan.missingRows)
  return {
    version: 1,
    date: input.plan.date,
    status: reasons.length === 0 ? 'READY' : 'HOLD',
    conflictDisposition: 'PRESERVE_EXISTING_HOLD',
    officialSha256: input.plan.officialSha256,
    planSha256: input.plan.planSha256,
    missingRows,
    missingRowsSha256: stableSha256(missingRows),
    preservedConflicts: conflicts,
    preservedConflictsSha256: stableSha256(conflicts),
    reasons,
  }
}

function rowKey(row: Pick<JpOhlcvValue, 'ticker' | 'date'>): string {
  return `${normalizeTicker(row.ticker)}:${row.date}`
}

export function jpOhlcvApprovedRepairKeysSha256(rows: readonly JpOhlcvValue[]): string {
  return stableSha256([...new Set(rows.map(rowKey))].sort())
}

/**
 * Revalidates an immutable missing-key approval against a later database
 * snapshot. Normal updaters may satisfy an approved key only when the stored
 * value exactly matches the sealed official value. Every other drift is a
 * fail-closed condition.
 */
export function buildJpOhlcvRuntimeRepairScope(input: {
  approvalScope: JpOhlcvMissingOnlyRepairScope
  officialRows: readonly JpOfficialOhlcvValue[]
  existingRows: readonly JpOhlcvValue[]
}): JpOhlcvRuntimeRepairScope {
  const approval = input.approvalScope
  const runtimePlan = buildJpOhlcvBackfillPlan({
    date: approval.date,
    officialRows: input.officialRows,
    existingRows: input.existingRows,
  })
  const reasons = new Set<string>()
  if (approval.status !== 'READY') reasons.add('approval_scope_not_ready')
  if (runtimePlan.officialSha256 !== approval.officialSha256) reasons.add('official_source_hash_changed')

  const approvedRows = new Map(approval.missingRows.map((row) => [rowKey(row), normalizeValue(row)]))
  const officialRows = new Map(sorted(input.officialRows).map((row) => [rowKey(row), row]))
  const existingRows = new Map(sorted(input.existingRows).map((row) => [rowKey(row), row]))
  const residualMissingRows: JpOfficialOhlcvValue[] = []
  const alreadySatisfiedRows: JpOfficialOhlcvValue[] = []

  for (const [key, approvedRow] of approvedRows) {
    const official = officialRows.get(key)
    if (!official || !sameJpOhlcvValue(official, approvedRow)) {
      reasons.add(`approved_key_official_value_changed:${key}`)
      continue
    }
    const existing = existingRows.get(key)
    if (!existing) residualMissingRows.push(official)
    else if (sameJpOhlcvValue(existing, official)) alreadySatisfiedRows.push(official)
    else reasons.add(`approved_key_existing_value_conflict:${key}`)
  }

  for (const missing of runtimePlan.missingRows) {
    if (!approvedRows.has(rowKey(missing))) reasons.add(`unapproved_missing_key:${rowKey(missing)}`)
  }
  const runtimeConflictKeys = new Set(runtimePlan.conflicts.map(rowKey))
  for (const conflict of runtimePlan.conflicts) {
    const key = rowKey(conflict)
    if (approvedRows.has(key)) continue
    const approvedConflict = approval.preservedConflicts.find((entry) => rowKey(entry) === key)
    if (!approvedConflict || stableSha256(conflict) !== stableSha256(approvedConflict)) {
      reasons.add(`unapproved_or_changed_conflict:${key}`)
    }
  }
  for (const conflict of approval.preservedConflicts) {
    if (!runtimeConflictKeys.has(rowKey(conflict))) {
      reasons.add(`preserved_conflict_state_changed:${rowKey(conflict)}`)
    }
  }
  for (const key of existingRows.keys()) {
    if (!officialRows.has(key) && ![...reasons].some((reason) => reason.endsWith(`:${key}`))) {
      reasons.add(`existing_key_without_official:${key}`)
    }
  }

  const missingRows = sorted(residualMissingRows)
  const satisfiedRows = sorted(alreadySatisfiedRows)
  return {
    version: 1,
    date: approval.date,
    status: reasons.size === 0 ? 'READY' : 'HOLD',
    conflictDisposition: approval.conflictDisposition,
    officialSha256: approval.officialSha256,
    planSha256: runtimePlan.planSha256,
    missingRows,
    missingRowsSha256: stableSha256(missingRows),
    preservedConflicts: runtimePlan.conflicts,
    preservedConflictsSha256: stableSha256(runtimePlan.conflicts),
    reasons: [...reasons].sort(),
    runtimeKind: 'BOUNDED_APPROVED_KEY_REVALIDATION',
    approvalPlanSha256: approval.planSha256,
    approvedMissingRowsSha256: approval.missingRowsSha256,
    approvedRepairKeysSha256: jpOhlcvApprovedRepairKeysSha256(approval.missingRows),
    alreadySatisfiedRows: satisfiedRows,
    alreadySatisfiedRowsSha256: stableSha256(satisfiedRows),
    runtimeExistingSha256: runtimePlan.existingSha256,
  }
}

export function summarizeJpOhlcvRuntimeScopeHold(
  scope: JpOhlcvRuntimeRepairScope,
  sampleLimit = 12,
): JpOhlcvRuntimeHoldSummary {
  const reasonCounts: Record<string, number> = {}
  for (const reason of scope.reasons) {
    const category = reason.split(':', 1)[0]
    reasonCounts[category] = (reasonCounts[category] ?? 0) + 1
  }
  const categories = new Set(Object.keys(reasonCounts))
  const holdClass: JpOhlcvRuntimeHoldSummary['holdClass'] =
    categories.has('official_source_hash_changed') || categories.has('approved_key_official_value_changed')
      ? 'SOURCE_REVISED'
      : categories.has('approved_key_existing_value_conflict') || categories.has('preserved_conflict_state_changed')
        ? 'PRICE_CONFLICT'
        : categories.has('unapproved_missing_key') || categories.has('unapproved_or_changed_conflict')
            || categories.has('existing_key_without_official')
          ? 'UNAPPROVED_DRIFT'
          : categories.has('approval_scope_not_ready')
            ? 'INVALID_APPROVAL'
            : 'UNKNOWN'
  const conflicts = new Map(scope.preservedConflicts.map((conflict) => [rowKey(conflict), conflict]))
  const samples = scope.reasons.slice(0, sampleLimit).map((reason) => {
    const [, ticker, date] = reason.split(':')
    const key = ticker && date ? `${ticker}:${date}` : null
    const conflict = key ? conflicts.get(key) : undefined
    return {
      reason: reason.split(':', 1)[0],
      key,
      ...(conflict?.existing ? { existing: conflict.existing } : {}),
      ...(conflict?.official ? { official: conflict.official } : {}),
    }
  })
  return { holdClass, reasonCount: scope.reasons.length, reasonCounts, samples }
}

function median(values: readonly number[]): number {
  const ordered = values.filter((value) => Number.isSafeInteger(value) && value > 0).sort((a, b) => a - b)
  if (ordered.length === 0) return 0
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2 === 0 ? Math.round((ordered[middle - 1] + ordered[middle]) / 2) : ordered[middle]
}

export function evaluateJpDailyCoverage(input: {
  providerRows: number
  storedRows: number
  referenceRows: readonly number[]
  minimumRatio?: number
}): JpDailyCoverageEvaluation {
  const expectedRows = median(input.referenceRows)
  const ratioThreshold = input.minimumRatio ?? JP_OHLCV_MIN_DAILY_COVERAGE_RATIO
  const minimumRows = expectedRows > 0 ? Math.ceil(expectedRows * ratioThreshold) : 1
  const ratio = expectedRows > 0 ? input.providerRows / expectedRows : 0
  const reasons: string[] = []
  if (expectedRows === 0) reasons.push('coverage_reference_missing')
  if (input.providerRows < minimumRows) reasons.push('provider_row_count_below_baseline')
  if (input.storedRows !== input.providerRows) reasons.push('stored_provider_count_mismatch')
  return {
    status: reasons.length === 0 ? 'PASS' : 'HOLD',
    providerRows: input.providerRows,
    storedRows: input.storedRows,
    referenceRows: [...input.referenceRows],
    expectedRows,
    minimumRows,
    ratio,
    reasons,
  }
}

export function findJpHistoricalCoverageGaps(input: {
  tradingDates: readonly string[]
  rowsByDate: ReadonlyMap<string, number>
  referenceRows: readonly number[]
  minimumRatio?: number
}): Array<{ date: string; actualRows: number; expectedRows: number; minimumRows: number }> {
  const expectedRows = median(input.referenceRows)
  const minimumRows = expectedRows > 0
    ? Math.ceil(expectedRows * (input.minimumRatio ?? JP_OHLCV_MIN_DAILY_COVERAGE_RATIO))
    : 1
  return input.tradingDates
    .map((date) => ({ date, actualRows: input.rowsByDate.get(date) ?? 0, expectedRows, minimumRows }))
    .filter((row) => row.actualRows < row.minimumRows)
}

export function assessJpOhlcvConflictLineage(input: {
  existing: JpOhlcvValue
  currentOfficial: JpOfficialOhlcvValue
  laterAdjustmentFactors: readonly number[]
}): JpOhlcvConflictLineageAssessment {
  const volumeMatches = input.existing.volume === input.currentOfficial.volume
  const laterCorporateActionObserved = input.laterAdjustmentFactors.some((factor) => (
    Number.isFinite(factor) && factor > 0 && Math.abs(factor - 1) > Number.EPSILON
  ))
  const ratios = (['open', 'high', 'low', 'close'] as const).map((key) => (
    input.existing[key] / input.currentOfficial[key]
  ))
  const priceRevisionConsistent = ratios.every((ratio) => Number.isFinite(ratio))
    && Math.max(...ratios) - Math.min(...ratios) <= 1e-8
    && input.laterAdjustmentFactors.some((factor) => Math.abs(ratios[0] - factor) <= 1e-8)
  const classification = volumeMatches && laterCorporateActionObserved && priceRevisionConsistent
    ? 'RETROACTIVE_ADJUSTED_SERIES_REVISION'
    : 'UNRESOLVED_VALUE_CONFLICT'
  return {
    classification,
    disposition: 'PRESERVE_EXISTING_HOLD',
    volumeMatches,
    laterCorporateActionObserved,
    priceRevisionConsistent,
    requiresFullHistoryRebase: classification === 'RETROACTIVE_ADJUSTED_SERIES_REVISION',
  }
}

export function historicalCoverageDates(
  tradingDates: readonly string[],
  targetDate: string,
): string[] {
  const dates = [...tradingDates]
  if (dates.at(-1) === targetDate) dates.pop()
  return dates
}

export type JpFetchFailureCategory = 'AUTH' | 'RATE_LIMIT' | 'HTTP_CLIENT' | 'HTTP_SERVER' | 'NETWORK' | 'INVALID_RESPONSE' | 'UNKNOWN'

export function classifyJpFetchFailure(error: unknown): { category: JpFetchFailureCategory; httpStatus: number | null; retryable: boolean } {
  if (error && typeof error === 'object') {
    const candidate = error as { category?: unknown; httpStatus?: unknown; retryable?: unknown }
    const categories: readonly JpFetchFailureCategory[] = [
      'AUTH', 'RATE_LIMIT', 'HTTP_CLIENT', 'HTTP_SERVER', 'NETWORK', 'INVALID_RESPONSE', 'UNKNOWN',
    ]
    if (
      typeof candidate.category === 'string'
      && categories.includes(candidate.category as JpFetchFailureCategory)
      && (candidate.httpStatus === null || Number.isInteger(candidate.httpStatus))
      && typeof candidate.retryable === 'boolean'
    ) {
      return {
        category: candidate.category as JpFetchFailureCategory,
        httpStatus: candidate.httpStatus as number | null,
        retryable: candidate.retryable,
      }
    }
  }
  const message = error instanceof Error ? error.message : String(error)
  const statusMatch = message.match(/(?:HTTP\s+|status[=: ]+|failed(?:\s+with)?[=: ]+|失敗[=: ]+)\s*(\d{3})(?!\d)/i)
  const httpStatus = statusMatch ? Number(statusMatch[1]) : null
  if (httpStatus === 401 || httpStatus === 403) return { category: 'AUTH', httpStatus, retryable: false }
  if (httpStatus === 429) return { category: 'RATE_LIMIT', httpStatus, retryable: true }
  if (httpStatus != null && httpStatus >= 500) return { category: 'HTTP_SERVER', httpStatus, retryable: true }
  if (httpStatus != null && httpStatus >= 400) return { category: 'HTTP_CLIENT', httpStatus, retryable: false }
  if (/fetch failed|ECONN|ENET|ETIMEDOUT|network|socket/i.test(message)) return { category: 'NETWORK', httpStatus: null, retryable: true }
  if (/invalid\s+(?:JSON|response|payload|schema)|malformed\s+(?:response|payload)/i.test(message)) {
    return { category: 'INVALID_RESPONSE', httpStatus: null, retryable: false }
  }
  return { category: 'UNKNOWN', httpStatus, retryable: false }
}
