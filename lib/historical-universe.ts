export type HistoricalUniverseMembershipInput = {
  asOf: string
  currentActive: boolean
  historicalRecordExists?: boolean
  firstTradeDate: string | null
  lastTradeDate: string | null
  ledgerThrough: string | null
  fallbackFirstTradeDate?: string | null
  fallbackLastTradeDate?: string | null
}

export function isHistoricalUniverseMemberAt({
  asOf,
  currentActive,
  historicalRecordExists,
  firstTradeDate,
  lastTradeDate,
  ledgerThrough,
  fallbackFirstTradeDate = null,
  fallbackLastTradeDate = null,
}: HistoricalUniverseMembershipInput): boolean {
  const hasHistoricalRecord = historicalRecordExists
    ?? Boolean(firstTradeDate || lastTradeDate)
  if (hasHistoricalRecord) {
    if (!firstTradeDate || !lastTradeDate || !ledgerThrough) return false
    if (asOf > ledgerThrough) return currentActive
    return firstTradeDate <= asOf && asOf <= lastTradeDate
  }

  if (!fallbackFirstTradeDate || !fallbackLastTradeDate) return false
  if (asOf < fallbackFirstTradeDate) return false
  if (asOf <= fallbackLastTradeDate) return true
  return Boolean(ledgerThrough && asOf > ledgerThrough && currentActive)
}

/**
 * SQL predicate matching isHistoricalUniverseMemberAt. Arguments are trusted
 * query expressions supplied by this repository, never request values. The
 * fallback expression must prove that the ticker has data on the evaluated
 * date; current active membership alone is not sufficient evidence.
 */
export function historicalUniverseMembershipSql(
  dateExpression: string,
  historicalAlias = 'hu',
  currentAlias = 'tu',
  fallbackEvidenceExpression = '0 = 1',
): string {
  return `(
    (
      ${historicalAlias}.ticker IS NOT NULL
      AND (
        (
          ${dateExpression} <= ${historicalAlias}.latest_ohlcv_date
          AND ${dateExpression} BETWEEN ${historicalAlias}.first_trade_date AND ${historicalAlias}.last_trade_date
        )
        OR (
          ${historicalAlias}.latest_ohlcv_date IS NOT NULL
          AND ${dateExpression} > ${historicalAlias}.latest_ohlcv_date
          AND COALESCE(${currentAlias}.active, 0) = 1
        )
      )
    )
    OR (
      ${historicalAlias}.ticker IS NULL
      AND (${fallbackEvidenceExpression})
    )
  )`
}
