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

function sameValue(left: JpOhlcvValue, right: JpOhlcvValue): boolean {
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
    if (!sameValue(previous, value)) {
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
    } else if (sameValue(existingRow, officialRow)) {
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
