export type LargeHolderDailySnapshotStatus = {
  state: {
    marketDate: string
    priceEvidenceDate: string
    priceBatchComplete: boolean
  }
  snapshotPriceDate: string | null
  status: 'CURRENT' | 'STALE'
  certificationStatus: 'VALIDATED' | 'VALIDATED_WITH_QUARANTINE' | null
  currentGeneratedAt: string | null
}

export type LargeHolderDailyAction =
  | 'ALREADY_CURRENT'
  | 'WAITING_FOR_PRICE_EVIDENCE'
  | 'REFRESH'
  | 'VALIDATION_FAILED'

export type LargeHolderDailyPlan = {
  action: LargeHolderDailyAction
  reason: string
  marketDate: string
  priceEvidenceDate: string
  previousSnapshotDate: string | null
}

const DATE = /^\d{4}-\d{2}-\d{2}$/

function validDate(value: string): boolean {
  return DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
}

export function planLargeHolderDailyCurrent(
  status: LargeHolderDailySnapshotStatus,
): LargeHolderDailyPlan {
  const marketDate = status.state.marketDate
  const priceEvidenceDate = status.state.priceEvidenceDate
  const previousSnapshotDate = status.snapshotPriceDate
  const base = { marketDate, priceEvidenceDate, previousSnapshotDate }

  if (!validDate(marketDate)) {
    return { ...base, action: 'VALIDATION_FAILED', reason: 'MARKET_DATE_INVALID' }
  }
  if (previousSnapshotDate && !validDate(previousSnapshotDate)) {
    return { ...base, action: 'VALIDATION_FAILED', reason: 'SNAPSHOT_DATE_INVALID' }
  }
  if (previousSnapshotDate && previousSnapshotDate > marketDate) {
    return { ...base, action: 'VALIDATION_FAILED', reason: 'SNAPSHOT_AHEAD_OF_MARKET' }
  }
  if (previousSnapshotDate === marketDate && status.status === 'CURRENT') {
    return { ...base, action: 'ALREADY_CURRENT', reason: 'CERTIFIED_SNAPSHOT_CURRENT' }
  }
  if (previousSnapshotDate === marketDate) {
    return { ...base, action: 'VALIDATION_FAILED', reason: 'SAME_DATE_NOT_CURRENT' }
  }
  if (!status.state.priceBatchComplete || priceEvidenceDate !== marketDate) {
    return { ...base, action: 'WAITING_FOR_PRICE_EVIDENCE', reason: 'PRICE_EVIDENCE_NOT_READY' }
  }
  return { ...base, action: 'REFRESH', reason: previousSnapshotDate
    ? 'MARKET_DATE_ADVANCED'
    : 'NO_CERTIFIED_SNAPSHOT' }
}

export type LargeHolderDailyFailure =
  | 'ALREADY_RUNNING'
  | 'WAITING_FOR_PRICE_EVIDENCE'
  | 'SOURCE_NOT_READY'
  | 'FAILED_TRANSIENT'
  | 'VALIDATION_FAILED'
  | 'FAILED'

export function classifyLargeHolderDailyFailure(message: string): LargeHolderDailyFailure {
  if (/large_holder_update_lock_busy/i.test(message)) return 'ALREADY_RUNNING'
  if (/price_update_incomplete|official_price_evidence_not_current/i.test(message)) {
    return 'WAITING_FOR_PRICE_EVIDENCE'
  }
  if (/EDINET_API_KEY is not configured|source_not_ready/i.test(message)) return 'SOURCE_NOT_READY'
  if (/large_holder_status_timeout|ETIMEDOUT|EHOSTUNREACH|ECONNRESET|ENETUNREACH|fetch failed|HTTP 429|HTTP 5\d\d|request failed after/i.test(message)) {
    return 'FAILED_TRANSIENT'
  }
  if (/certification_gate_failed|validation_failed|materialized_snapshot_validation_failed|source_changed_during_materialization|unresolved_source_document|revision_chain_unresolved/i.test(message)) {
    return 'VALIDATION_FAILED'
  }
  return 'FAILED'
}
